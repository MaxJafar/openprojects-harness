import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

import YAML from 'yaml';

import { createUnixSocketFetch } from '../api/unix-fetch.js';
import {
  CORE_4G_LIMITS,
  CORE_4G_MAX_RETRIEVED_CONTEXT_CHARACTERS,
  CORE_4G_RESOURCE_PROFILE,
  loadConfig,
} from '../config.js';
import type { AppConfig } from '../core/types.js';
import { deterministicEvalConfig } from './runner.js';
import { OPENPROJECTS_VERSION } from '../version.js';

const execFileAsync = promisify(execFile);
const MIB = 1024 * 1024;
const STARTUP_OPERATION_TIMEOUT_MS = 10_000;
const RUN_OPERATION_TIMEOUT_MS = 10_000;
const SHUTDOWN_OPERATION_TIMEOUT_MS = 5_000;
const IDLE_SETTLE_MS = 500;
const POST_RUN_SETTLE_MS = 500;
const RSS_SAMPLE_COUNT = 5;
const RSS_SAMPLE_INTERVAL_MS = 100;
const MAX_CAPTURED_OUTPUT_BYTES = 64 * 1024;
const EXPECTED_SIGNAL_EXIT_CODE = 143;

export const HARNESS_FOOTPRINT_REPORT_SCHEMA = 'openprojects.harness-footprint-eval-report.v1' as const;
export const HARNESS_FOOTPRINT_CONTRACT_VERSION = 'openprojects.harness-footprint-gate.v1' as const;

export const HARNESS_FOOTPRINT_4GB_BUDGETS = Object.freeze({
  startupMs: 1_000,
  idleRssBytes: 192 * MIB,
  lifecyclePeakRssBytes: 256 * MIB,
  rssGrowthBytes: 32 * MIB,
  runLatencyMs: 250,
  liveDatabaseBytes: 2 * MIB,
  finalDatabaseBytes: 1 * MIB,
  shutdownMs: 1_000,
});

export interface HarnessFootprintDatabaseSnapshot {
  mainBytes: number;
  walBytes: number;
  shmBytes: number;
  totalBytes: number;
}

export interface HarnessFootprintObservation {
  host: {
    platform: NodeJS.Platform;
    architecture: string;
    nodeVersion: string;
  };
  startupMs: number;
  startupRssBytes: number;
  idleRssSamplesBytes: number[];
  idleRssBytes: number;
  postRunRssBytes: number;
  settledPostRunRssBytes: number;
  sampledPeakRssBytes: number;
  lifecyclePeakRssBytes: number;
  runLatencyMs: number;
  shutdownMs: number;
  database: {
    beforeRun: HarnessFootprintDatabaseSnapshot;
    afterRun: HarnessFootprintDatabaseSnapshot;
    final: HarnessFootprintDatabaseSnapshot;
    integrity: string;
    runRows: number;
    eventRows: number;
  };
  health: {
    status: string;
    modelProvider: string;
    model: string;
    embeddings: string;
    transcription: string;
  };
  run: {
    httpStatus: number;
    status: string;
    eventCount: number;
    toolCalls: number;
  };
  shutdown: {
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    ownerLockRemoved: boolean;
    socketRemoved: boolean;
    walRemoved: boolean;
    shmRemoved: boolean;
    stderrEmpty: boolean;
  };
  isolation: {
    freshTemporaryDirectory: boolean;
    durableSqlite: true;
    unixSocketOnly: true;
    socketProtectedWhileRunning: boolean;
    ownerLockProtectedWhileRunning: boolean;
    model: 'mock/project-ops-v1';
    embeddings: 'builtin-hash-v1';
    transcription: 'disabled';
    telegram: 'disabled';
    integrations: 'removed';
    routing: 'removed';
    dotenvLoaded: false;
    processEnvironmentOverridesApplied: false;
    resourceProfile: typeof CORE_4G_RESOURCE_PROFILE;
    internetDescriptorsBeforeRun: number;
    internetDescriptorsAfterRun: number;
    temporaryDirectoryRemoved: boolean;
  };
  bindings: {
    sourceConfigSha256: string;
    effectiveConfigSha256: string;
  };
}

export interface HarnessFootprintAssertion {
  id: string;
  passed: boolean;
  actual: number | string | boolean;
  limit?: number;
  detail: string;
}

export interface HarnessFootprintEvalReport {
  schema: typeof HARNESS_FOOTPRINT_REPORT_SCHEMA;
  generatedAt: string;
  overall: 'passed' | 'failed' | 'diagnostic';
  tier: 'core-4gb';
  evaluatorBuild: {
    openProjectsVersion: typeof OPENPROJECTS_VERSION;
    contractVersion: typeof HARNESS_FOOTPRINT_CONTRACT_VERSION;
    contractSha256: string;
  };
  budgets: typeof HARNESS_FOOTPRINT_4GB_BUDGETS;
  measurements: HarnessFootprintObservation | null;
  assertions: HarnessFootprintAssertion[];
  gate: {
    functionalPass: boolean;
    promotionEligible: boolean;
  };
  testSeamsUsed: {
    probe: boolean;
    clock: boolean;
    environment: boolean;
    any: boolean;
  };
  posture: {
    certificationScope: 'harness-process-only';
    targetFourGiBHostCertified: false;
    standaloneEvaluator: true;
    freshTemporaryDurableState: true;
    productionStateOpened: false;
    downloadsAttempted: false;
    externalModelRequestsAttempted: false;
    externalRequestsAttempted: false;
    promotionsAttempted: false;
  };
  error?: string;
  caveats: string[];
}

export interface HarnessFootprintProbeContext {
  configPath: string;
  environment: NodeJS.ProcessEnv;
}

export type HarnessFootprintProbe = (
  context: HarnessFootprintProbeContext,
) => Promise<HarnessFootprintObservation>;

export interface HarnessFootprintEvalOptions {
  configPath?: string;
  /** Deterministic unit-test seam. Any use makes the report non-promotable. */
  probe?: HarnessFootprintProbe;
  /** Deterministic unit-test seam. Any use makes the report non-promotable. */
  now?: () => Date;
  /** Deterministic unit-test seam. Any use makes the report non-promotable. */
  environment?: NodeJS.ProcessEnv;
}

/**
 * Measures one complete, disposable mock/demo serve lifecycle. The production
 * path always launches the already-built CLI as a separate process; injected
 * measurements are diagnostics only and can never satisfy the promotion gate.
 */
export async function runHarnessFootprintEval(
  options: HarnessFootprintEvalOptions = {},
): Promise<HarnessFootprintEvalReport> {
  const testSeamsUsed = {
    probe: options.probe !== undefined,
    clock: options.now !== undefined,
    environment: options.environment !== undefined,
    any: options.probe !== undefined || options.now !== undefined || options.environment !== undefined,
  };
  const configPath = resolve(options.configPath ?? 'openprojects.config.yaml');
  const environment = options.environment ?? process.env;
  let measurements: HarnessFootprintObservation | null = null;
  let error: string | undefined;

  try {
    measurements = await (options.probe ?? runLiveHarnessFootprintProbe)({
      configPath,
      environment,
    });
  } catch (cause) {
    error = message(cause);
  }

  const assertions = measurements
    ? evaluateObservation(measurements)
    : [{
        id: 'lifecycle_completed',
        passed: false,
        actual: false,
        detail: error ?? 'The disposable harness lifecycle did not complete',
      } satisfies HarnessFootprintAssertion];
  const functionalPass = measurements !== null && assertions.every((assertion) => assertion.passed);
  const promotionEligible = functionalPass && !testSeamsUsed.any;

  return {
    schema: HARNESS_FOOTPRINT_REPORT_SCHEMA,
    generatedAt: (options.now?.() ?? new Date()).toISOString(),
    overall: functionalPass ? (testSeamsUsed.any ? 'diagnostic' : 'passed') : 'failed',
    tier: 'core-4gb',
    evaluatorBuild: {
      openProjectsVersion: OPENPROJECTS_VERSION,
      contractVersion: HARNESS_FOOTPRINT_CONTRACT_VERSION,
      contractSha256: footprintContractSha256(),
    },
    budgets: HARNESS_FOOTPRINT_4GB_BUDGETS,
    measurements,
    assertions,
    gate: { functionalPass, promotionEligible },
    testSeamsUsed,
    posture: {
      certificationScope: 'harness-process-only',
      targetFourGiBHostCertified: false,
      standaloneEvaluator: true,
      freshTemporaryDurableState: true,
      productionStateOpened: false,
      downloadsAttempted: false,
      externalModelRequestsAttempted: false,
      externalRequestsAttempted: false,
      promotionsAttempted: false,
    },
    ...(error ? { error } : {}),
    caveats: [
      'This gate measures only the core-4g-v1 OpenProjects harness process; it excludes model-runtime memory and does not certify combined local inference.',
      'The canonical run performs deterministic in-process mock completions; no model-service endpoint is contacted.',
      'A passing result on this host is evidence of harness headroom only. Total-system 4 GiB support still requires this live gate plus separate model-runtime qualification on the real target host.',
      'The live lane writes only to a fresh owner-only temporary directory and removes it after SQLite, the owner lock, and the Unix socket close.',
      'The child configuration removes routes and integrations, disables Telegram and transcription, uses builtin embeddings, and exposes no TCP control listener.',
      'RSS is host- and OS-specific. Enforce this profile on the intended 4 GB-tier host class under representative background load.',
      'Any injected probe, clock, or environment is recorded as a test seam and makes the report ineligible for promotion.',
    ],
  };
}

export function evaluateHarnessFootprintObservation(
  observation: HarnessFootprintObservation,
): HarnessFootprintAssertion[] {
  return evaluateObservation(observation);
}

async function runLiveHarnessFootprintProbe(
  context: HarnessFootprintProbeContext,
): Promise<HarnessFootprintObservation> {
  if (process.platform !== 'darwin') {
    throw new Error('The live 4 GB harness-footprint gate currently requires macOS /usr/bin/time and /bin/ps');
  }
  const cliEntry = resolve(process.argv[1] ?? '');
  if (extname(cliEntry) !== '.js') {
    throw new Error('The live harness-footprint gate must run from the built CLI; use npm run build, then npm run eval:harness-footprint');
  }

  // Keep the Darwin Unix-domain socket below its short sockaddr path limit.
  const root = await mkdtemp('/private/tmp/openprojects-hf-');
  await chmod(root, 0o700);
  const stateDirectory = join(root, 'state');
  await mkdir(stateDirectory, { mode: 0o700 });
  const databasePath = join(stateDirectory, 'openprojects.db');
  const socketPath = join(root, 'c.sock');
  const configPath = join(root, 'openprojects.footprint.yaml');
  const timePath = join(root, 'time.txt');
  const ownerLockPath = `${databasePath}.owner.lock`;
  let wrapper: ChildProcess | undefined;
  let nodePid: number | undefined;
  let wrapperExit: Promise<ProcessExit> | undefined;
  let cleanupComplete = false;
  const output = captureProcessOutput();

  try {
    const sourceBytes = await readFile(context.configPath);
    const source = loadConfig(context.configPath, {
      loadEnv: false,
      applyProcessEnvOverrides: false,
      sourceText: sourceBytes.toString('utf8'),
    });
    const config = isolatedFootprintConfig(source, databasePath, socketPath);
    const configText = YAML.stringify(config);
    await writeFile(configPath, configText, { encoding: 'utf8', mode: 0o600, flag: 'wx' });

    const startedAt = performance.now();
    wrapper = spawn('/usr/bin/time', [
      '-l',
      '-o',
      timePath,
      process.execPath,
      cliEntry,
      'serve',
      '--config',
      configPath,
      '--demo',
    ], {
      cwd: root,
      env: sanitizedEnvironment(context.environment),
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    output.attach(wrapper);
    wrapperExit = processExit(wrapper);
    nodePid = await waitForDirectChild(wrapper, STARTUP_OPERATION_TIMEOUT_MS);
    const controlFetch = createUnixSocketFetch({
      socketPath,
      headerTimeoutMs: STARTUP_OPERATION_TIMEOUT_MS,
    });
    const health = await waitForHealth(controlFetch, wrapper, startedAt);
    const startupMs = performance.now() - startedAt;
    const socketProtectedWhileRunning = await isProtectedSocket(socketPath);
    const ownerLockProtectedWhileRunning = await isProtectedRegularFile(ownerLockPath);
    const startupRssBytes = await residentSetBytes(nodePid);
    const sampledRss: number[] = [startupRssBytes];

    await delay(IDLE_SETTLE_MS);
    const idleRssSamplesBytes: number[] = [];
    for (let index = 0; index < RSS_SAMPLE_COUNT; index += 1) {
      const rss = await residentSetBytes(nodePid);
      idleRssSamplesBytes.push(rss);
      sampledRss.push(rss);
      if (index + 1 < RSS_SAMPLE_COUNT) await delay(RSS_SAMPLE_INTERVAL_MS);
    }
    const idleRssBytes = Math.max(...idleRssSamplesBytes);
    const beforeRun = await databaseFootprint(databasePath);
    const internetDescriptorsBeforeRun = (await internetDescriptors(nodePid)).length;

    const runStartedAt = performance.now();
    const runResponse = await fetchWithTimeout(
      controlFetch,
      'http://localhost/api/runs',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          message: 'Why is Atlas late and what should we do next?',
          workspaceId: 'local',
          actorId: 'footprint-evaluator',
          projectId: 'project-atlas',
        }),
      },
      RUN_OPERATION_TIMEOUT_MS,
    );
    const runPayload = await runResponse.json() as unknown;
    const runLatencyMs = performance.now() - runStartedAt;
    const run = parseRunResult(runResponse.status, runPayload);
    const postRunRssBytes = await residentSetBytes(nodePid);
    sampledRss.push(postRunRssBytes);
    const afterRun = await databaseFootprint(databasePath);
    const internetDescriptorsAfterRun = (await internetDescriptors(nodePid)).length;

    await delay(POST_RUN_SETTLE_MS);
    const settledPostRunRssBytes = await residentSetBytes(nodePid);
    sampledRss.push(settledPostRunRssBytes);
    const shutdownStartedAt = performance.now();
    process.kill(nodePid, 'SIGTERM');
    const exit = await promiseWithTimeout(wrapperExit, SHUTDOWN_OPERATION_TIMEOUT_MS, 'Harness shutdown timed out');
    const shutdownMs = performance.now() - shutdownStartedAt;
    const timeOutput = await readFile(timePath, 'utf8');
    const lifecyclePeakRssBytes = parseDarwinMaximumRss(timeOutput);
    const final = await databaseFootprint(databasePath);
    const ownerLockRemoved = !await pathExists(ownerLockPath);
    const socketRemoved = !await pathExists(socketPath);
    const walRemoved = !await pathExists(`${databasePath}-wal`);
    const shmRemoved = !await pathExists(`${databasePath}-shm`);
    const database = await inspectDatabase(databasePath);
    const stderr = output.stderr();

    await rm(root, { recursive: true, force: false });
    cleanupComplete = !await pathExists(root);

    return {
      host: {
        platform: process.platform,
        architecture: process.arch,
        nodeVersion: process.version,
      },
      startupMs,
      startupRssBytes,
      idleRssSamplesBytes,
      idleRssBytes,
      postRunRssBytes,
      settledPostRunRssBytes,
      sampledPeakRssBytes: Math.max(...sampledRss),
      lifecyclePeakRssBytes,
      runLatencyMs,
      shutdownMs,
      database: {
        beforeRun,
        afterRun,
        final,
        ...database,
      },
      health,
      run,
      shutdown: {
        exitCode: exit.code,
        signal: exit.signal,
        ownerLockRemoved,
        socketRemoved,
        walRemoved,
        shmRemoved,
        stderrEmpty: stderr.length === 0,
      },
      isolation: {
        freshTemporaryDirectory: true,
        durableSqlite: true,
        unixSocketOnly: true,
        socketProtectedWhileRunning,
        ownerLockProtectedWhileRunning,
        model: 'mock/project-ops-v1',
        embeddings: 'builtin-hash-v1',
        transcription: 'disabled',
        telegram: 'disabled',
        integrations: 'removed',
        routing: 'removed',
        dotenvLoaded: false,
        processEnvironmentOverridesApplied: false,
        resourceProfile: CORE_4G_RESOURCE_PROFILE,
        internetDescriptorsBeforeRun,
        internetDescriptorsAfterRun,
        temporaryDirectoryRemoved: cleanupComplete,
      },
      bindings: {
        sourceConfigSha256: sha256(sourceBytes),
        effectiveConfigSha256: sha256(Buffer.from(configText, 'utf8')),
      },
    };
  } catch (error) {
    await terminateProcess(wrapper, wrapperExit, nodePid);
    const childStderr = output.stderr().toString('utf8').trim();
    const childStdout = output.stdout().toString('utf8').trim();
    const diagnostics = [
      childStderr ? `child stderr: ${childStderr}` : '',
      childStdout ? `child stdout: ${childStdout}` : '',
    ].filter(Boolean).join('; ');
    throw new Error(`${message(error)}${diagnostics ? ` (${diagnostics})` : ''}`);
  } finally {
    if (!cleanupComplete && await pathExists(root)) {
      await rm(root, { recursive: true, force: true });
    }
  }
}

function isolatedFootprintConfig(
  source: AppConfig,
  databasePath: string,
  socketPath: string,
): AppConfig {
  const deterministic = deterministicEvalConfig(source);
  const { integrations: _integrations, routing: _routing, ...isolated } = deterministic;
  return {
    ...isolated,
    agent: {
      ...isolated.agent,
      skills: [],
      tools: ['project_list', 'project_get', 'project_risk_report', 'memory_search'],
      budgets: {
        maxSteps: CORE_4G_LIMITS.maxSteps,
        maxToolCalls: CORE_4G_LIMITS.maxToolCalls,
        maxWallTimeMs: CORE_4G_LIMITS.maxWallTimeMs,
        maxInputTokens: CORE_4G_LIMITS.maxInputTokens,
        reservedOutputTokens: CORE_4G_LIMITS.maxOutputTokens,
      },
    },
    policy: {
      ...isolated.policy,
      memory_write: 'deny',
      external_write: 'deny',
      destructive: 'deny',
    },
    resources: {
      profile: CORE_4G_RESOURCE_PROFILE,
      maxRetrievedContextCharacters: CORE_4G_MAX_RETRIEVED_CONTEXT_CHARACTERS,
    },
    server: { host: '127.0.0.1', port: 4310, socketPath },
    storage: { database: databasePath },
    model: { provider: 'mock', model: 'project-ops-v1' },
    privacy: { localOnly: true, allowedOrigins: [] },
    telegram: { enabled: false, apiBaseUrl: 'http://127.0.0.1' },
    embeddings: {
      provider: 'builtin',
      model: 'builtin-hash-v1',
      dimensions: 256,
      timeoutMs: 3_000,
    },
    transcription: {
      provider: 'disabled',
      command: 'whisper-cli',
      ffmpegCommand: 'ffmpeg',
      timeoutMs: 180_000,
      maxBytes: 25_000_000,
      maxDurationSeconds: 1_200,
    },
    notifications: {
      enabled: false,
      intervalMs: isolated.notifications?.intervalMs ?? 60_000,
      lookaheadHours: isolated.notifications?.lookaheadHours ?? 48,
    },
    memory: {
      retrievalLimit: CORE_4G_LIMITS.maxMemoryRetrieval,
      maxContextCharacters: 512,
    },
    learning: {
      enabled: false,
      groupObservation: false,
      minimumSalience: isolated.learning?.minimumSalience ?? 0.55,
      feedbackLearningRate: isolated.learning?.feedbackLearningRate ?? 0.2,
      retentionDays: isolated.learning?.retentionDays ?? 90,
    },
    subagents: {
      maxCallsPerRun: 0,
      maxParallel: 1,
      maxDepth: 0,
    },
  };
}

function evaluateObservation(observation: HarnessFootprintObservation): HarnessFootprintAssertion[] {
  const budget = HARNESS_FOOTPRINT_4GB_BUDGETS;
  const rssGrowthBytes = Math.max(0, observation.lifecyclePeakRssBytes - observation.idleRssBytes);
  return [
    maximum('startup_ms', observation.startupMs, budget.startupMs, 'Ready health response'),
    maximum('idle_rss_bytes', observation.idleRssBytes, budget.idleRssBytes, 'Maximum settled idle RSS sample'),
    maximum(
      'lifecycle_peak_rss_bytes',
      observation.lifecyclePeakRssBytes,
      budget.lifecyclePeakRssBytes,
      'Kernel-reported lifecycle maximum RSS',
    ),
    maximum('rss_growth_bytes', rssGrowthBytes, budget.rssGrowthBytes, 'Lifecycle peak growth above settled idle RSS'),
    maximum('run_latency_ms', observation.runLatencyMs, budget.runLatencyMs, 'Canonical Atlas mock run'),
    maximum(
      'live_database_bytes',
      observation.database.afterRun.totalBytes,
      budget.liveDatabaseBytes,
      'Live SQLite main, WAL, and SHM footprint after the run',
    ),
    maximum(
      'final_database_bytes',
      observation.database.final.totalBytes,
      budget.finalDatabaseBytes,
      'Checkpointed SQLite footprint after shutdown',
    ),
    maximum('shutdown_ms', observation.shutdownMs, budget.shutdownMs, 'SIGTERM through child exit'),
    exact('health_identity',
      observation.health.status === 'ok'
        && observation.health.modelProvider === 'mock'
        && observation.health.model === 'project-ops-v1'
        && observation.health.embeddings === 'builtin-hash-v1'
        && observation.health.transcription === 'disabled',
      'Health must expose only the deterministic mock/builtin/disabled runtime'),
    exact(
      'core_resource_profile',
      observation.isolation.resourceProfile === CORE_4G_RESOURCE_PROFILE,
      `The disposable child must use ${CORE_4G_RESOURCE_PROFILE}`,
    ),
    exact('representative_run',
      observation.run.httpStatus === 201
        && observation.run.status === 'succeeded'
        && observation.run.eventCount > 0
        && observation.run.toolCalls === 1
        && observation.database.runRows === 1
        && observation.database.eventRows === observation.run.eventCount,
      'The canonical Atlas risk run must succeed with one read-only tool call and matching durable rows'),
    exact('sqlite_integrity', observation.database.integrity === 'ok', 'SQLite quick_check must return ok'),
    exact('protected_runtime_artifacts',
      observation.isolation.socketProtectedWhileRunning
        && observation.isolation.ownerLockProtectedWhileRunning,
      'The live Unix socket and owner lock must be owner-only'),
    exact('no_internet_descriptors',
      observation.isolation.internetDescriptorsBeforeRun === 0
        && observation.isolation.internetDescriptorsAfterRun === 0,
      'The child process must have no TCP or UDP descriptors before or after the run'),
    exact('clean_shutdown',
      observation.shutdown.exitCode === EXPECTED_SIGNAL_EXIT_CODE
        && observation.shutdown.signal === null
        && observation.shutdown.ownerLockRemoved
        && observation.shutdown.socketRemoved
        && observation.shutdown.walRemoved
        && observation.shutdown.shmRemoved
        && observation.shutdown.stderrEmpty,
      'Graceful shutdown must remove the lock, socket, WAL, and SHM without stderr'),
    exact('temporary_state_removed',
      observation.isolation.temporaryDirectoryRemoved,
      'The fresh temporary state directory must be removed after inspection'),
  ];
}

function maximum(
  id: string,
  actual: number,
  limit: number,
  label: string,
): HarnessFootprintAssertion {
  return {
    id,
    passed: Number.isFinite(actual) && actual >= 0 && actual <= limit,
    actual,
    limit,
    detail: `${label}: ${actual} <= ${limit}`,
  };
}

function exact(id: string, passed: boolean, detail: string): HarnessFootprintAssertion {
  return { id, passed, actual: passed, detail };
}

function sanitizedEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment = { ...source };
  for (const key of Object.keys(environment)) {
    if (key.startsWith('OPENPROJECTS_')) delete environment[key];
  }
  delete environment.NODE_OPTIONS;
  delete environment.NODE_PATH;
  delete environment.NODE_V8_COVERAGE;
  delete environment.HTTP_PROXY;
  delete environment.HTTPS_PROXY;
  delete environment.ALL_PROXY;
  delete environment.http_proxy;
  delete environment.https_proxy;
  delete environment.all_proxy;
  environment.LC_ALL = 'C';
  environment.LANG = 'C';
  return environment;
}

interface CapturedOutput {
  attach(child: ChildProcess): void;
  stdout(): Buffer;
  stderr(): Buffer;
}

function captureProcessOutput(): CapturedOutput {
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  const append = (chunks: Buffer[], current: number, value: Buffer): number => {
    if (current >= MAX_CAPTURED_OUTPUT_BYTES) return current;
    const retained = value.subarray(0, MAX_CAPTURED_OUTPUT_BYTES - current);
    chunks.push(retained);
    return current + retained.byteLength;
  };
  return {
    attach(child) {
      child.stdout?.on('data', (value: Buffer) => {
        stdoutBytes = append(stdoutChunks, stdoutBytes, Buffer.from(value));
      });
      child.stderr?.on('data', (value: Buffer) => {
        stderrBytes = append(stderrChunks, stderrBytes, Buffer.from(value));
      });
    },
    stdout: () => Buffer.concat(stdoutChunks, stdoutBytes),
    stderr: () => Buffer.concat(stderrChunks, stderrBytes),
  };
}

interface ProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

function processExit(child: ChildProcess): Promise<ProcessExit> {
  return new Promise<ProcessExit>((resolvePromise, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolvePromise({ code, signal }));
  });
}

async function waitForDirectChild(child: ChildProcess, timeoutMs: number): Promise<number> {
  if (!child.pid) throw new Error('The resource-measurement wrapper did not start');
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error('The harness process exited before its PID could be measured');
    }
    try {
      const pids = await directChildPids(child.pid);
      if (pids.length === 1) return pids[0]!;
      if (pids.length > 1) throw new Error('The resource-measurement wrapper launched more than one child');
    } catch (error) {
      if (message(error).includes('more than one child')) throw error;
    }
    await delay(10);
  }
  throw new Error('Timed out waiting for the harness child PID');
}

/** Exact numeric PPID matching for deterministic tests and Darwin PID discovery. */
export function parseDirectChildPids(output: string, parentPid: number): number[] {
  if (!Number.isSafeInteger(parentPid) || parentPid <= 0) return [];
  const pids = new Set<number>();
  for (const line of output.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s*$/u);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    if (Number.isSafeInteger(pid) && pid > 0 && ppid === parentPid) pids.add(pid);
  }
  return [...pids].sort((left, right) => left - right);
}

async function directChildPids(parentPid: number): Promise<number[]> {
  const { stdout } = await execFileAsync('/bin/ps', ['-axo', 'pid=,ppid='], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  return parseDirectChildPids(stdout, parentPid);
}

async function waitForHealth(
  controlFetch: typeof fetch,
  child: ChildProcess,
  startedAt: number,
): Promise<HarnessFootprintObservation['health']> {
  const deadline = startedAt + STARTUP_OPERATION_TIMEOUT_MS;
  let lastError = 'service unavailable';
  while (performance.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`The harness exited before health became ready: ${lastError}`);
    }
    try {
      const response = await fetchWithTimeout(
        controlFetch,
        'http://localhost/health',
        undefined,
        500,
      );
      const payload = await response.json() as unknown;
      if (response.status === 200) return parseHealth(payload);
      lastError = `health returned HTTP ${response.status}`;
    } catch (error) {
      lastError = message(error);
    }
    await delay(10);
  }
  throw new Error(`Harness startup timed out: ${lastError}`);
}

async function fetchWithTimeout(
  fetchImplementation: typeof fetch,
  input: string,
  init: RequestInit | undefined,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('request timed out')), timeoutMs);
  try {
    return await fetchImplementation(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function parseHealth(value: unknown): HarnessFootprintObservation['health'] {
  const root = record(value, 'health response');
  const model = record(root.model, 'health model');
  return {
    status: text(root.status, 'health status'),
    modelProvider: text(model.provider, 'health model provider'),
    model: text(model.model, 'health model name'),
    embeddings: text(root.embeddings, 'health embeddings'),
    transcription: text(root.transcription, 'health transcription'),
  };
}

function parseRunResult(httpStatus: number, value: unknown): HarnessFootprintObservation['run'] {
  const root = record(value, 'run response');
  const run = record(root.run, 'run record');
  if (!Array.isArray(root.events)) throw new Error('Run response events must be an array');
  return {
    httpStatus,
    status: text(run.status, 'run status'),
    eventCount: root.events.length,
    toolCalls: finiteInteger(run.toolCalls, 'run toolCalls'),
  };
}

async function residentSetBytes(pid: number): Promise<number> {
  const { stdout } = await execFileAsync('/bin/ps', ['-o', 'rss=', '-p', String(pid)], {
    encoding: 'utf8',
  });
  const kib = Number(stdout.trim());
  if (!Number.isSafeInteger(kib) || kib <= 0) throw new Error('Could not read a positive harness RSS value');
  return kib * 1024;
}

async function internetDescriptors(pid: number): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('/usr/sbin/lsof', ['-nP', '-a', '-p', String(pid), '-i'], {
      encoding: 'utf8',
      maxBuffer: 256 * 1024,
    });
    return stdout.trim().split('\n').slice(1).filter(Boolean);
  } catch (error) {
    const output = typeof (error as { stdout?: unknown }).stdout === 'string'
      ? (error as { stdout: string }).stdout.trim()
      : '';
    if (!output) return [];
    return output.split('\n').slice(1).filter(Boolean);
  }
}

async function databaseFootprint(databasePath: string): Promise<HarnessFootprintDatabaseSnapshot> {
  const mainBytes = await fileBytes(databasePath);
  const walBytes = await fileBytes(`${databasePath}-wal`);
  const shmBytes = await fileBytes(`${databasePath}-shm`);
  return {
    mainBytes,
    walBytes,
    shmBytes,
    totalBytes: mainBytes + walBytes + shmBytes,
  };
}

async function inspectDatabase(databasePath: string): Promise<{
  integrity: string;
  runRows: number;
  eventRows: number;
}> {
  const { DatabaseSync } = await import('node:sqlite');
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const integrity = database.prepare('PRAGMA quick_check').get() as Record<string, unknown> | undefined;
    const runs = database.prepare('SELECT COUNT(*) AS count FROM runs').get() as Record<string, unknown> | undefined;
    const events = database.prepare('SELECT COUNT(*) AS count FROM events').get() as Record<string, unknown> | undefined;
    return {
      integrity: text(integrity?.quick_check, 'SQLite quick_check'),
      runRows: finiteInteger(runs?.count, 'SQLite run count'),
      eventRows: finiteInteger(events?.count, 'SQLite event count'),
    };
  } finally {
    database.close();
  }
}

async function fileBytes(path: string): Promise<number> {
  try {
    const stats = await lstat(path);
    if (!stats.isFile()) throw new Error('SQLite artifact is not a regular file');
    return stats.size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
}

async function isProtectedSocket(path: string): Promise<boolean> {
  try {
    const stats = await lstat(path);
    return stats.isSocket() && (stats.mode & 0o777) === 0o600;
  } catch {
    return false;
  }
}

async function isProtectedRegularFile(path: string): Promise<boolean> {
  try {
    const stats = await lstat(path);
    return stats.isFile() && !stats.isSymbolicLink() && stats.nlink === 1 && (stats.mode & 0o777) === 0o600;
  } catch {
    return false;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function parseDarwinMaximumRss(output: string): number {
  const match = output.match(/^\s*(\d+)\s+maximum resident set size\s*$/mu);
  const bytes = Number(match?.[1]);
  if (!Number.isSafeInteger(bytes) || bytes <= 0) {
    throw new Error('Could not parse the macOS lifecycle maximum RSS');
  }
  return bytes;
}

async function terminateProcess(
  wrapper: ChildProcess | undefined,
  exit: Promise<ProcessExit> | undefined,
  nodePid: number | undefined,
): Promise<void> {
  if (!wrapper) return;
  if (nodePid === undefined && wrapper.pid !== undefined) {
    const descendants = await directChildPids(wrapper.pid).catch(() => []);
    if (descendants.length === 1) nodePid = descendants[0];
  }
  if (nodePid !== undefined && processAlive(nodePid)) {
    try {
      process.kill(nodePid, 'SIGTERM');
    } catch {
      // The child may exit between the liveness check and the signal.
    }
  } else if (wrapper.pid !== undefined) {
    signalOwnedProcessGroup(wrapper.pid, 'SIGTERM');
  }
  if (exit) {
    try {
      await promiseWithTimeout(exit, 1_000, 'cleanup timeout');
      return;
    } catch {
      // Escalate only for the fresh child process owned by this evaluator.
    }
  }
  if (wrapper.pid !== undefined) {
    signalOwnedProcessGroup(wrapper.pid, 'SIGTERM');
  }
  if (exit) {
    try {
      await promiseWithTimeout(exit, 500, 'cleanup TERM timeout');
      return;
    } catch {
      // Escalate only within the private process group created for this probe.
    }
  }
  if (wrapper.pid !== undefined) {
    signalOwnedProcessGroup(wrapper.pid, 'SIGKILL');
  }
  if (nodePid !== undefined && processAlive(nodePid)) {
    try {
      process.kill(nodePid, 'SIGKILL');
    } catch {
      // The child may already be gone.
    }
  }
  try {
    wrapper.kill('SIGKILL');
  } catch {
    // The wrapper may already be gone.
  }
  if (exit) {
    try {
      await promiseWithTimeout(exit, 1_000, 'cleanup KILL timeout');
    } catch {
      // Cleanup is bounded even if inherited pipes fail to report close.
    }
  }
}

function signalOwnedProcessGroup(processGroupId: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-processGroupId, signal);
  } catch {
    // The private group may have already exited.
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function promiseWithTimeout<T>(promise: Promise<T>, timeoutMs: number, detail: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(detail)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function footprintContractSha256(): string {
  return sha256(Buffer.from(JSON.stringify({
    contractVersion: HARNESS_FOOTPRINT_CONTRACT_VERSION,
    reportSchema: HARNESS_FOOTPRINT_REPORT_SCHEMA,
    tier: 'core-4gb',
    budgets: HARNESS_FOOTPRINT_4GB_BUDGETS,
    lifecycle: 'core-4g-v1-fresh-temp-durable-sqlite-mock-demo-serve-one-risk-run-clean-sigterm',
    controlTransport: 'owner-only-unix-socket',
    rss: 'ps-current-plus-darwin-time-lifecycle-maximum',
    testSeamsDisqualifyPromotion: true,
  }), 'utf8'));
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function finiteInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
