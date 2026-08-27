import { constants as fsConstants } from 'node:fs';
import { access, lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { OpenProjectsApp } from './app.js';
import { loadControlAuthenticator } from './auth/control-auth.js';
import type { AppConfig, JsonObject, ModelResponse } from './core/types.js';
import { isLoopbackHostname } from './privacy/network-policy.js';
import {
  probeUnixSocketPath,
} from './server-endpoint.js';
import {
  executablePathCandidates,
  executableSearchDirectories,
  isShellFreeExecutablePath,
} from './runtime/executable-path.js';

export type DoctorCheckStatus = 'pass' | 'warn' | 'fail' | 'skip';

export interface DoctorCheck {
  id: string;
  label: string;
  status: DoctorCheckStatus;
  detail: string;
  durationMs: number;
}

export interface DoctorReport {
  schema: 'openprojects.doctor.v1';
  generatedAt: string;
  probe: boolean;
  overall: 'ready' | 'degraded' | 'not_ready';
  posture: {
    sealedLocal: boolean;
    localOnly: boolean;
    allowlistedOriginCount: number;
    telegramExternalTransport: boolean;
  };
  checks: DoctorCheck[];
}

export interface DoctorOptions {
  probe?: boolean;
  timeoutMs?: number;
  /** The configured database path when the composition app uses :memory:. */
  databasePath?: string;
  now?: () => Date;
}

interface ProbeResult {
  status: Exclude<DoctorCheckStatus, 'fail'>;
  detail: string;
}

/**
 * Builds a secret-safe readiness report. Probes are bounded and read-only:
 * they never start a run, invoke a tool, create the configured database, pull
 * a model, transcribe audio, or alter service state.
 */
export async function runDoctor(app: OpenProjectsApp, options: DoctorOptions = {}): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const probe = options.probe === true;
  const timeoutMs = boundedTimeout(options.timeoutMs ?? 10_000);
  const configuredSecrets = collectConfiguredSecrets(app.config);
  const sealedLocal = app.networkPolicy.localOnly
    && app.networkPolicy.allowedOrigins.length === 0
    && app.config.telegram?.enabled !== true;

  checks.push(check(
    'composition',
    'Configuration and composition',
    'pass',
    `${app.kernel.listPlugins().length} plugins, ${app.kernel.listTools().length} tools, ${app.skills.length} skills`,
  ));
  checks.push(privacyCheck(app, sealedLocal));
  checks.push(await serverCheck(app.config));
  checks.push(controlAuthCheck(app.config));
  checks.push(policyCheck(app.config));
  checks.push(check(
    'vision',
    'Vision ingestion',
    'skip',
    'Not implemented; a vision-capable model alone does not enable image or document ingestion',
  ));

  if (probe) {
    checks.push(await measured('model', 'Model response', () => probeModel(app, timeoutMs), configuredSecrets));
    checks.push(await measured('embeddings', 'Embedding response', () => probeEmbeddings(app, timeoutMs), configuredSecrets));
    checks.push(await measured(
      'storage',
      'Storage path',
      () => probeStorage(options.databasePath ?? app.config.storage.database),
      configuredSecrets,
    ));
    checks.push(await measured(
      'transcription',
      'Transcription prerequisites',
      () => probeTranscription(app.config),
      configuredSecrets,
    ));
  } else {
    checks.push(check('model', 'Model response', 'skip', 'Use --probe to make one bounded inference request'));
    checks.push(check('embeddings', 'Embedding response', 'skip', 'Use --probe to make one bounded embedding request'));
    checks.push(check('storage', 'Storage path', 'skip', 'Use --probe to inspect the configured path without creating it'));
    checks.push(check(
      'transcription',
      'Transcription prerequisites',
      'skip',
      app.config.transcription?.provider === 'whisper-cpp'
        ? 'Use --probe to verify the configured executable and model paths'
        : 'Local transcription is disabled',
    ));
  }

  const overall = checks.some((item) => item.status === 'fail')
    ? 'not_ready'
    : checks.some((item) => item.status === 'warn')
      ? 'degraded'
      : 'ready';
  return {
    schema: 'openprojects.doctor.v1',
    generatedAt: (options.now?.() ?? new Date()).toISOString(),
    probe,
    overall,
    posture: {
      sealedLocal,
      localOnly: app.networkPolicy.localOnly,
      allowlistedOriginCount: app.networkPolicy.allowedOrigins.length,
      telegramExternalTransport: app.config.telegram?.enabled === true,
    },
    checks,
  };
}

export function renderDoctorReport(report: DoctorReport): string {
  const heading = report.overall === 'ready'
    ? 'READY'
    : report.overall === 'degraded'
      ? 'DEGRADED'
      : 'NOT READY';
  const lines = [
    `OpenProjects doctor: ${heading}${report.probe ? ' (bounded probes enabled)' : ''}`,
    `Privacy posture: ${report.posture.sealedLocal ? 'SEALED LOCAL' : 'HYBRID / REVIEW REQUIRED'}`,
  ];
  for (const item of report.checks) {
    lines.push(`${statusLabel(item.status)} ${item.label}: ${item.detail}${item.durationMs ? ` (${item.durationMs}ms)` : ''}`);
  }
  if (!report.probe) lines.push('Run again with --probe to contact configured local services and inspect local prerequisites.');
  return `${lines.join('\n')}\n`;
}

function privacyCheck(app: OpenProjectsApp, sealedLocal: boolean): DoctorCheck {
  if (sealedLocal) {
    return check('privacy', 'Privacy boundary', 'pass', 'Local-only, zero allowlisted origins, Telegram disabled');
  }
  if (!app.networkPolicy.localOnly) {
    return check('privacy', 'Privacy boundary', 'warn', 'localOnly is disabled; host egress controls require independent review');
  }
  const telegram = app.config.telegram?.enabled === true ? '; Telegram is an external transport' : '';
  return check(
    'privacy',
    'Privacy boundary',
    'warn',
    `${app.networkPolicy.allowedOrigins.length} explicitly allowlisted origin(s)${telegram}`,
  );
}

async function serverCheck(config: AppConfig): Promise<DoctorCheck> {
  if (config.server.socketPath) {
    try {
      const result = await probeUnixSocketPath(config.server.socketPath);
      if (result.status === 'live') {
        return check(
          'server-bind',
          'Server bind',
          'pass',
          'Protected Unix control socket is accepting connections',
        );
      }
      if (result.status === 'unresponsive') {
        return check(
          'server-bind',
          'Server bind',
          'fail',
          'Protected Unix control socket is not accepting connections; follow explicit verified stale-socket recovery and do not delete it automatically',
        );
      }
      return check(
        'server-bind',
        'Server bind',
        'pass',
        'Protected Unix control socket is configured and its path is ready',
      );
    } catch (error) {
      return check(
        'server-bind',
        'Server bind',
        'fail',
        safeDetail(error instanceof Error ? error.message : String(error)),
      );
    }
  }
  if (isLoopbackHostname(config.server.host)) {
    return check('server-bind', 'Server bind', 'pass', `${config.server.host}:${config.server.port} is loopback-only`);
  }
  return check(
    'server-bind',
    'Server bind',
    'fail',
    `${safeDetail(config.server.host)} is not loopback; the control-plane service refuses non-loopback binds`,
  );
}

function controlAuthCheck(config: AppConfig): DoctorCheck {
  if (!config.server.auth) {
    return check(
      'control-auth',
      'Control authentication',
      'warn',
      'Not configured; this legacy mode relies entirely on the loopback and host-account boundary',
    );
  }
  try {
    const authenticator = loadControlAuthenticator(config.server.auth);
    const subject = authenticator.principalId
      ? `operator ${safeDetail(authenticator.principalId)}`
      : `${authenticator.principalIds.length} independent principals`;
    return process.platform === 'win32'
      ? check(
          'control-auth',
          'Control authentication',
          'warn',
          `Bearer credentials are readable for ${subject}, but owner-only NTFS ACLs cannot be verified through Node; review Get-Acl or icacls evidence`,
        )
      : check(
          'control-auth',
          'Control authentication',
          'pass',
          `Protected Bearer credentials are readable for ${subject}`,
        );
  } catch (error) {
    return check(
      'control-auth',
      'Control authentication',
      'fail',
      safeDetail(error instanceof Error ? error.message : String(error)),
    );
  }
}

function policyCheck(config: AppConfig): DoctorCheck {
  if (config.policy.destructive === 'deny' && config.policy.external_write !== 'allow') {
    return check(
      'policy',
      'Consequential-action policy',
      'pass',
      `external_write=${config.policy.external_write}; destructive=deny`,
    );
  }
  return check(
    'policy',
    'Consequential-action policy',
    'warn',
    `external_write=${config.policy.external_write}; destructive=${config.policy.destructive}`,
  );
}

async function probeModel(app: OpenProjectsApp, timeoutMs: number): Promise<string | ProbeResult> {
  if (app.config.model.provider === 'mock') {
    return {
      status: 'warn',
      detail: 'Deterministic fixture adapter is available, but no deployable model is configured',
    };
  }
  const response = await app.kernel.model(app.config.model.provider).complete({
    runId: 'doctor-readiness-probe',
    provider: app.config.model.provider,
    model: app.config.model.model,
    task: 'supervisor',
    messages: [
      { role: 'system', content: 'This is a readiness probe. Reply with the single word READY. Do not call tools.' },
      { role: 'user', content: 'READY' },
    ],
    tools: [],
    maxOutputTokens: 8,
    signal: AbortSignal.timeout(timeoutMs),
  });
  validateModelProbe(response);
  const routed = response.route ? ` via route ${response.route.routeId}` : '';
  return `Valid assistant response from ${safeDetail(response.model ?? app.config.model.model)}${routed}`;
}

function validateModelProbe(response: ModelResponse): void {
  if (response.message.toolCalls?.length) {
    throw new Error('Model attempted a tool call even though the readiness request supplied no tools');
  }
  if (!response.message.content?.trim()) throw new Error('Model returned an empty assistant response');
}

async function probeEmbeddings(app: OpenProjectsApp, timeoutMs: number): Promise<string | ProbeResult> {
  const vectors = await app.embedding.embed(['OpenProjects private appliance readiness'], AbortSignal.timeout(timeoutMs));
  const vector = vectors[0];
  if (!vector || vectors.length !== 1 || vector.length === 0) throw new Error('Embedding provider returned no vector');
  if (vector.some((value) => !Number.isFinite(value))) throw new Error('Embedding provider returned a non-finite value');
  const detail = `${safeDetail(app.embedding.id)} returned ${vector.length} finite dimensions`;
  return app.config.embeddings?.provider === 'builtin'
    ? { status: 'warn', detail: `${detail}; built-in feature hashing is not a learned semantic embedding model` }
    : detail;
}

async function probeStorage(path: string): Promise<string | ProbeResult> {
  if (path === ':memory:') {
    return { status: 'warn', detail: 'In-memory SQLite is available but is not durable' };
  }
  const info = await lstat(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  if (info?.isSymbolicLink()) throw new Error('Configured database path is a symbolic link');
  if (info) {
    if (!info.isFile()) throw new Error('Configured database path exists but is not a regular file');
    await access(path, fsConstants.R_OK | fsConstants.W_OK);
    requirePrivateMode(info.mode, 'Database file', 0o600);
    await inspectStorageDirectory(dirname(path));
    inspectOpenProjectsDatabase(path);
    return process.platform === 'win32'
      ? {
          status: 'warn',
          detail: 'Existing OpenProjects SQLite file passed read-only integrity/schema checks, but NTFS ACL isolation requires separate verification',
        }
      : 'Existing OpenProjects SQLite file passed read-only integrity/schema checks and has protected permissions';
  }
  const parent = dirname(path);
  await inspectStorageDirectory(parent);
  await access(parent, fsConstants.W_OK | fsConstants.X_OK);
  return process.platform === 'win32'
    ? {
        status: 'warn',
        detail: 'Database does not exist yet and its parent is writable, but NTFS ACL isolation requires separate verification (no file was created)',
      }
    : 'Database does not exist yet; its parent directory is writable (no file was created)';
}

async function inspectStorageDirectory(path: string): Promise<void> {
  const parentInfo = await lstat(path);
  if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) {
    throw new Error('Database parent must be a regular non-symlink directory');
  }
  requirePrivateMode(parentInfo.mode, 'Database parent', 0o700);
}

function requirePrivateMode(mode: number, label: string, expected: number): void {
  if (process.platform !== 'win32' && (mode & 0o777) !== expected) {
    throw new Error(`${label} permissions must be ${expected.toString(8)}`);
  }
}

function inspectOpenProjectsDatabase(path: string): void {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const integrity = database.prepare('PRAGMA quick_check').get() as Record<string, unknown> | undefined;
    if (!integrity || !Object.values(integrity).includes('ok')) throw new Error('SQLite quick_check did not return ok');
    const rows = database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('runs', 'events', 'approvals')",
    ).all() as Array<Record<string, unknown>>;
    const names = new Set(rows.map((row) => row.name).filter((name): name is string => typeof name === 'string'));
    for (const required of ['runs', 'events', 'approvals']) {
      if (!names.has(required)) throw new Error(`OpenProjects schema is missing table ${required}`);
    }
  } finally {
    database.close();
  }
}

async function probeTranscription(config: AppConfig): Promise<string | ProbeResult> {
  const transcription = config.transcription;
  if (!transcription || transcription.provider === 'disabled') {
    return { status: 'skip', detail: 'Local transcription is disabled' };
  }
  const command = await findExecutable(transcription.command);
  const ffmpeg = await findExecutable(transcription.ffmpegCommand);
  if (!transcription.modelPath) throw new Error('transcription.modelPath is not configured');
  const model = await lstat(transcription.modelPath);
  if (model.isSymbolicLink() || !model.isFile()) throw new Error('Whisper model path is not a regular non-symlink file');
  await access(transcription.modelPath, fsConstants.R_OK);
  return `whisper.cpp, ffmpeg, and the local model are readable (${safeBasename(command)}, ${safeBasename(ffmpeg)})`;
}

async function findExecutable(command: string): Promise<string> {
  if (isAbsolute(command) || command.includes('/') || command.includes('\\')) {
    return requireExecutable(command);
  }
  for (const directory of executableSearchDirectories()) {
    for (const candidate of executablePathCandidates(directory, command)) {
      try {
        return await requireExecutable(candidate);
      } catch {
        // Continue searching PATH without exposing individual host paths.
      }
    }
  }
  throw new Error(`Executable ${JSON.stringify(safeDetail(command))} was not found on PATH`);
}

async function requireExecutable(path: string): Promise<string> {
  if (!isShellFreeExecutablePath(path)) {
    throw new Error('Windows shell-free execution accepts only native .exe or .com executable paths');
  }
  const resolved = await realpath(path);
  const info = await lstat(resolved);
  if (!info.isFile()) throw new Error('Executable target is not a regular file');
  if (process.platform !== 'win32' && (info.mode & 0o022) !== 0) {
    throw new Error('Executable target is writable by the group or other users');
  }
  await access(resolved, fsConstants.X_OK);
  return resolved;
}

async function measured(
  id: string,
  label: string,
  operation: () => Promise<string | ProbeResult>,
  secrets: readonly string[] = [],
): Promise<DoctorCheck> {
  const startedAt = Date.now();
  try {
    const result = await operation();
    return typeof result === 'string'
      ? check(id, label, 'pass', result, Date.now() - startedAt)
      : check(id, label, result.status, result.detail, Date.now() - startedAt);
  } catch (error) {
    return check(
      id,
      label,
      'fail',
      safeDetail(error instanceof Error ? error.message : String(error), secrets),
      Date.now() - startedAt,
    );
  }
}

function check(
  id: string,
  label: string,
  status: DoctorCheckStatus,
  detail: string,
  durationMs = 0,
): DoctorCheck {
  return { id, label, status, detail: safeDetail(detail), durationMs };
}

function statusLabel(status: DoctorCheckStatus): string {
  switch (status) {
    case 'pass': return '[PASS]';
    case 'warn': return '[WARN]';
    case 'fail': return '[FAIL]';
    case 'skip': return '[SKIP]';
  }
}

function safeDetail(value: string, secrets: readonly string[] = []): string {
  let redacted = value;
  for (const secret of [...new Set(secrets)].filter((item) => item.length >= 4).sort((a, b) => b.length - a.length)) {
    redacted = redacted.split(secret).join('[REDACTED]');
  }
  return redacted
    .replace(/\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\)|P[^\u001b]*(?:\u001b\\))/gu, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, '')
    .replace(/\bBearer\s+\S+/giu, 'Bearer [REDACTED]')
    .replace(/\b(?:sk|api)[-_][A-Za-z0-9._-]{8,}\b/gu, '[REDACTED]')
    .replace(/\b(api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/giu, '$1=[REDACTED]')
    .replace(/(https?:\/\/)[^/@\s]+@/giu, '$1[REDACTED]@')
    .slice(0, 500);
}

function collectConfiguredSecrets(config: AppConfig): string[] {
  const values = [
    config.model.apiKey,
    ...((config.routing?.routes ?? []).flatMap((route) => [
      route.apiKey,
      route.apiKeyEnv ? process.env[route.apiKeyEnv] : undefined,
    ])),
  ];
  return values.filter((value): value is string => typeof value === 'string' && value.length > 0);
}

function safeBasename(path: string): string {
  return path.split(/[\\/]/u).at(-1) ?? 'executable';
}

function boundedTimeout(value: number): number {
  if (!Number.isFinite(value)) return 10_000;
  return Math.max(250, Math.min(60_000, Math.floor(value)));
}

export function doctorReportJson(report: DoctorReport): JsonObject {
  return report as unknown as JsonObject;
}
