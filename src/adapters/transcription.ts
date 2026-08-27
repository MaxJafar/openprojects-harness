import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  AppConfig,
  TranscriptionAdapter,
  TranscriptionResult,
} from '../core/types.js';
import { isShellFreeExecutablePath } from '../runtime/executable-path.js';

const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;
const MAX_CAPTURE_BYTES = 1024 * 1024;
const PROCESS_KILL_GRACE_MS = 500;

export class TranscriptionDisabledError extends Error {
  constructor(message = 'Audio transcription is disabled') {
    super(message);
    this.name = 'TranscriptionDisabledError';
  }
}

export class TranscriptionTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Audio transcription exceeded its ${timeoutMs} ms timeout`);
    this.name = 'TranscriptionTimeoutError';
  }
}

export class TranscriptionProcessError extends Error {
  constructor(
    readonly command: string,
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    const detail = stderr.trim();
    super(
      `${command} exited ${exitCode === null ? 'without an exit code' : `with code ${exitCode}`}`
        + (detail ? `: ${detail}` : ''),
    );
    this.name = 'TranscriptionProcessError';
  }
}

/** Explicit no-op adapter so disabled transcription fails closed. */
export class DisabledTranscriptionAdapter implements TranscriptionAdapter {
  readonly id = 'disabled';

  async transcribe(_inputPath: string, _signal?: AbortSignal): Promise<TranscriptionResult> {
    throw new TranscriptionDisabledError();
  }
}

export interface WhisperCppTranscriptionOptions {
  id?: string;
  command: string;
  modelPath: string;
  ffmpegCommand?: string;
  language?: string;
  timeoutMs?: number;
  maxBytes?: number;
  /** Fixed shell-free arguments placed before adapter-owned arguments. */
  commandArgs?: readonly string[];
  /** Fixed shell-free arguments placed before adapter-owned FFmpeg arguments. */
  ffmpegCommandArgs?: readonly string[];
}

/**
 * Local whisper.cpp adapter.
 *
 * Both programs are executed directly with fixed argument arrays and
 * `shell: false`; user-controlled paths are never interpolated into a command.
 */
export class WhisperCppTranscriptionAdapter implements TranscriptionAdapter {
  readonly id: string;
  readonly #command: string;
  readonly #modelPath: string;
  readonly #ffmpegCommand: string;
  readonly #language: string | undefined;
  readonly #timeoutMs: number;
  readonly #maxBytes: number;
  readonly #commandArgs: readonly string[];
  readonly #ffmpegCommandArgs: readonly string[];

  constructor(options: WhisperCppTranscriptionOptions) {
    this.#command = executable(options.command, 'whisper.cpp command');
    this.#ffmpegCommand = executable(options.ffmpegCommand ?? 'ffmpeg', 'ffmpeg command');
    this.#modelPath = nonEmpty(options.modelPath, 'whisper.cpp model path');
    this.#language = options.language === undefined
      ? undefined
      : nonEmpty(options.language, 'transcription language');
    this.#timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 'timeoutMs');
    this.#maxBytes = positiveInteger(options.maxBytes ?? DEFAULT_MAX_BYTES, 'maxBytes');
    this.#commandArgs = fixedArguments(options.commandArgs, 'whisper.cpp commandArgs');
    this.#ffmpegCommandArgs = fixedArguments(options.ffmpegCommandArgs, 'ffmpeg commandArgs');
    this.id = options.id ?? 'whisper-cpp';
  }

  async transcribe(inputPath: string, signal?: AbortSignal): Promise<TranscriptionResult> {
    throwIfAborted(signal);
    const startedAt = Date.now();
    const input = await checkedRegularFile(inputPath, 'Audio input');
    const inputInfo = await stat(input);
    if (inputInfo.size > this.#maxBytes) {
      throw new Error(`Audio input is ${inputInfo.size} bytes; maximum is ${this.#maxBytes}`);
    }
    const model = await checkedRegularFile(this.#modelPath, 'whisper.cpp model');
    const workDirectory = await mkdtemp(join(tmpdir(), 'openprojects-whisper-'));
    const wavPath = join(workDirectory, 'input.wav');
    const outputPrefix = join(workDirectory, 'transcript');
    const operation = operationSignal(signal, this.#timeoutMs);

    try {
      const maximumWavBytes = Math.min(
        2_000_000_000,
        Math.max(this.#maxBytes, this.#maxBytes * 32),
      );
      await runProcess(
        this.#ffmpegCommand,
        [
          ...this.#ffmpegCommandArgs,
          '-nostdin',
          '-hide_banner',
          '-loglevel',
          'error',
          '-y',
          '-i',
          input,
          '-vn',
          '-ac',
          '1',
          '-ar',
          '16000',
          '-c:a',
          'pcm_s16le',
          '-fs',
          String(maximumWavBytes),
          wavPath,
        ],
        operation.signal,
      );

      const whisperArgs = [
        '-m',
        model,
        '-f',
        wavPath,
        '-otxt',
        '-of',
        outputPrefix,
        '-nt',
      ];
      if (this.#language !== undefined) whisperArgs.push('-l', this.#language);
      const result = await runProcess(
        this.#command,
        [...this.#commandArgs, ...whisperArgs],
        operation.signal,
      );
      const text = (await readTranscript(`${outputPrefix}.txt`, result.stdout)).trim();
      if (!text) throw new Error('whisper.cpp produced an empty transcript');

      return {
        text,
        ...(this.#language ? { language: this.#language } : {}),
        durationMs: Date.now() - startedAt,
        model,
      };
    } finally {
      operation.dispose();
      await rm(workDirectory, { recursive: true, force: true });
    }
  }
}

export function createTranscriptionAdapter(
  config: NonNullable<AppConfig['transcription']>,
): TranscriptionAdapter {
  if (config.provider === 'disabled') return new DisabledTranscriptionAdapter();
  if (!config.modelPath) {
    throw new Error('transcription.modelPath is required when provider is whisper-cpp');
  }
  return new WhisperCppTranscriptionAdapter({
    command: config.command,
    modelPath: config.modelPath,
    ffmpegCommand: config.ffmpegCommand,
    timeoutMs: config.timeoutMs,
    maxBytes: config.maxBytes,
    ...(config.language ? { language: config.language } : {}),
  });
}

interface ProcessResult {
  stdout: string;
  stderr: string;
}

function runProcess(command: string, args: string[], signal: AbortSignal): Promise<ProcessResult> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(command, args, {
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      child.stdin.end();
    } catch (error) {
      reject(error);
      return;
    }

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let terminalError: unknown;
    let killTimer: NodeJS.Timeout | undefined;

    const terminate = (error: unknown): void => {
      terminalError ??= error;
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        killTimer ??= setTimeout(() => child.kill('SIGKILL'), PROCESS_KILL_GRACE_MS);
        killTimer.unref();
      }
    };
    const append = (target: Buffer[], value: Buffer | string, stream: 'stdout' | 'stderr'): void => {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      const nextSize = (stream === 'stdout' ? stdoutBytes : stderrBytes) + chunk.length;
      if (nextSize > MAX_CAPTURE_BYTES) {
        terminate(new Error(`${command} ${stream} exceeded ${MAX_CAPTURE_BYTES} bytes`));
        return;
      }
      target.push(chunk);
      if (stream === 'stdout') stdoutBytes = nextSize;
      else stderrBytes = nextSize;
    };
    const abort = (): void => terminate(abortReason(signal));

    child.stdout.on('data', (value: Buffer | string) => append(stdout, value, 'stdout'));
    child.stderr.on('data', (value: Buffer | string) => append(stderr, value, 'stderr'));
    signal.addEventListener('abort', abort, { once: true });
    child.once('error', (error) => {
      terminalError ??= error;
    });
    child.once('close', (code) => {
      signal.removeEventListener('abort', abort);
      if (killTimer !== undefined) clearTimeout(killTimer);
      const output = {
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      };
      if (terminalError !== undefined) {
        reject(terminalError);
      } else if (code !== 0) {
        reject(new TranscriptionProcessError(command, code, output.stderr));
      } else {
        resolve(output);
      }
    });
  });
}

function operationSignal(
  external: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new TranscriptionTimeoutError(timeoutMs)),
    timeoutMs,
  );
  timer.unref();
  const externalAbort = (): void => controller.abort(abortReason(external as AbortSignal));
  external?.addEventListener('abort', externalAbort, { once: true });
  if (external?.aborted) externalAbort();
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      external?.removeEventListener('abort', externalAbort);
    },
  };
}

async function checkedRegularFile(path: string, label: string): Promise<string> {
  const resolved = await realpath(nonEmpty(path, label));
  const details = await stat(resolved);
  if (!details.isFile()) throw new Error(`${label} is not a regular file: ${resolved}`);
  return resolved;
}

async function readTranscript(path: string, stdout: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (isErrno(error, 'ENOENT') && stdout.trim()) return stdout;
    throw error;
  }
}

function executable(value: string, label: string): string {
  const command = nonEmpty(value, label);
  if (!isShellFreeExecutablePath(command)) {
    throw new Error(`${label} requires a native .exe or .com path on Windows`);
  }
  return command;
}

function nonEmpty(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} must not be empty`);
  if (trimmed.includes('\0')) throw new Error(`${label} must not contain NUL bytes`);
  return trimmed;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function fixedArguments(values: readonly string[] | undefined, label: string): readonly string[] {
  if (values === undefined) return [];
  if (values.length > 16) throw new Error(`${label} must contain at most 16 entries`);
  return Object.freeze(values.map((value, index) => nonEmpty(value, `${label}[${index}]`)));
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error('Operation aborted');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}
