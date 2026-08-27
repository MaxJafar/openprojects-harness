import { constants } from 'node:fs';
import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  open,
  rename,
  unlink,
} from 'node:fs/promises';
import { dirname, isAbsolute, parse, resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

import YAML from 'yaml';

import {
  validateLlamaCppBaseUrl,
  validateLlamaCppModelAlias,
  validateMlxLmBaseUrl,
} from '../adapters/models.js';
import {
  CORE_4G_LIMITS,
  CORE_4G_MAX_RETRIEVED_CONTEXT_CHARACTERS,
  CORE_4G_RESOURCE_PROFILE,
  validateResourceProfile,
} from '../config.js';
import {
  loadControlClientCredential,
  selectControlClientPrincipal,
} from '../auth/control-auth.js';
import type { AppConfig, ModelRouteConfig } from '../core/types.js';
import { isLoopbackHostname } from '../privacy/network-policy.js';
import { resolveUnixSocketPath } from '../server-endpoint.js';
import { filesystemPathKey } from '../runtime/filesystem-path.js';
import { OPENPROJECTS_VERSION } from '../version.js';
import { usesCore4gProfile } from './hardware.js';
import type {
  HardwareInfo,
  ModelRecommendation,
  WizardAnswers,
  WizardPlan,
  WizardWriteResult,
} from './types.js';

const ALL_TASKS = [
  'supervisor',
  'project_analysis',
  'memory_curator',
  'summarization',
  'notification',
] as const;

export interface BuildWizardPlanOptions {
  cwd?: string;
  hardware: HardwareInfo;
  recommendation: ModelRecommendation;
  core4g?: boolean;
}

export interface WriteWizardConfigOptions {
  force?: boolean;
  now?: () => Date;
}

export function buildWizardPlan(
  answers: WizardAnswers,
  options: BuildWizardPlanOptions,
): WizardPlan {
  validateAnswers(answers);
  const core4g = options.core4g === true || usesCore4gProfile(options.hardware);
  const baseUrl = normalizeHttpBaseUrl(answers.baseUrl, 'model base URL');
  const modelUrl = new URL(baseUrl);
  const remoteModel = !isLoopbackHostname(modelUrl.hostname);
  if (!core4g && answers.profile === 'private-local' && remoteModel) {
    throw new Error('The private-local profile requires a loopback model endpoint');
  }
  if (!core4g && answers.backend !== 'openai-compatible' && remoteModel) {
    throw new Error(`${answers.backend} is a local runtime and requires a loopback endpoint`);
  }
  if (answers.backend === 'mlx-lm') {
    if (options.hardware.acceleration !== 'apple-silicon') {
      throw new Error('The MLX-LM wizard backend requires macOS on Apple Silicon');
    }
    validateMlxLmBaseUrl(baseUrl);
  }
  if (answers.backend === 'llama-cpp') {
    validateLlamaCppBaseUrl(baseUrl);
    validateLlamaCppModelAlias(answers.model.trim());
    if (!core4g && !answers.apiKeyEnv) {
      throw new Error('The llama.cpp backend requires an apiKeyEnv for its dedicated loopback key');
    }
  }
  if (!core4g && remoteModel && !answers.apiKeyEnv) {
    throw new Error('A remote OpenAI-compatible endpoint requires an apiKeyEnv name');
  }
  if (!core4g && remoteModel && modelUrl.protocol !== 'https:') {
    throw new Error('A remote OpenAI-compatible endpoint must use HTTPS');
  }
  if (!core4g && answers.profile === 'private-local' && answers.telegramEnabled) {
    throw new Error('Telegram cannot be enabled in the sealed private-local profile');
  }
  if (!core4g && answers.telegramEnabled && answers.controlSocketPath) {
    throw new Error(
      'Telegram webhook ingress cannot share the private Unix control socket; use loopback TCP behind a reviewed TLS reverse proxy',
    );
  }
  if (options.hardware.platform === 'win32' && answers.controlSocketPath) {
    throw new Error('Windows installations must use authenticated loopback TCP; Unix control sockets are unavailable');
  }

  const allowedOrigins: string[] = [];
  if (!core4g && remoteModel) allowedOrigins.push(modelUrl.origin);
  if (!core4g && answers.telegramEnabled) allowedOrigins.push('https://api.telegram.org');

  const route: ModelRouteConfig = {
    id: routeIdFor(answers.backend),
    provider: providerFor(answers.backend),
    model: answers.model.trim(),
    generation: 'wizard-v1',
    tasks: answers.backend === 'llama-cpp' ? ['project_analysis'] : [...ALL_TASKS],
    baseUrl,
    ...(answers.apiKeyEnv ? { apiKeyEnv: validateEnvironmentName(answers.apiKeyEnv) } : {}),
    local: !remoteModel,
    enabled: true,
    quality: remoteModel ? 0.85 : 0.75,
    inputCostPerMillion: remoteModel ? 100 : 0,
    outputCostPerMillion: remoteModel ? 100 : 0,
    contextWindow: answers.contextWindow,
  };
  const constrainedMlx = answers.backend === 'mlx-lm' && answers.contextWindow <= 8_192;
  const sealed = core4g || answers.profile === 'private-local';
  const config: AppConfig = {
    version: 1,
    agent: {
      id: core4g ? 'project-ops-core-4g' : sealed ? 'project-ops-private' : 'project-ops-hybrid',
      version: OPENPROJECTS_VERSION,
      name: core4g
        ? 'OpenProjects Core 4 GB Harness'
        : sealed ? 'OpenProjects Private Ops Agent' : 'OpenProjects Hybrid Ops Agent',
      skills: core4g ? [] : ['project-operations'],
      tools: core4g
        ? ['project_list', 'project_get', 'project_risk_report', 'memory_search']
        : [
            'project_list',
            'project_get',
            'project_risk_report',
            'oracle_search',
            'oracle_sources',
            'task_list',
            'task_create',
            'draft_followup',
            'send_followup',
            'memory_search',
            'memory_remember',
            'delegate_agent',
          ],
      budgets: core4g
        ? {
            maxSteps: CORE_4G_LIMITS.maxSteps,
            maxToolCalls: CORE_4G_LIMITS.maxToolCalls,
            maxWallTimeMs: CORE_4G_LIMITS.maxWallTimeMs,
            maxInputTokens: CORE_4G_LIMITS.maxInputTokens,
            reservedOutputTokens: CORE_4G_LIMITS.maxOutputTokens,
          }
        : {
            maxSteps: 8,
            maxToolCalls: 16,
            maxWallTimeMs: 120_000,
            maxInputTokens: constrainedMlx ? 4_000 : 24_000,
            reservedOutputTokens: constrainedMlx ? 1_024 : 4_096,
          },
    },
    policy: {
      read: 'allow',
      draft: 'allow',
      memory_write: core4g ? 'deny' : 'allow',
      internal_write: 'ask',
      external_write: sealed ? 'deny' : 'ask',
      destructive: 'deny',
    },
    ...(core4g
      ? {
          resources: {
            profile: CORE_4G_RESOURCE_PROFILE,
            maxRetrievedContextCharacters: CORE_4G_MAX_RETRIEVED_CONTEXT_CHARACTERS,
          },
        }
      : {}),
    server: {
      host: '127.0.0.1',
      port: 4310,
      ...(answers.controlSocketPath
        ? { socketPath: validatePathText(answers.controlSocketPath, 'control socket path') }
        : {}),
      auth: {
        principals: [{
          id: 'local-admin',
          tokenFile: validatePathText(answers.controlTokenPath, 'control token path'),
          capabilities: ['admin'],
        }],
      },
    },
    storage: { database: validatePathText(answers.databasePath, 'database path') },
    privacy: {
      localOnly: true,
      allowedOrigins: [...new Set(allowedOrigins)],
    },
    telegram: {
      enabled: core4g ? false : answers.telegramEnabled,
      apiBaseUrl: 'https://api.telegram.org',
    },
    model: core4g
      ? { provider: 'mock', model: 'core-harness-fixture-v1' }
      : {
          provider: route.provider,
          model: route.model,
          baseUrl,
        },
    routing: {
      dailyBudgetUsd: !core4g && remoteModel ? 2 : 0,
      explorationRate: 0,
      externalInference: !core4g && remoteModel ? 'allow' : 'deny',
      preferLocal: true,
      allowRemoteFallback: false,
      routes: core4g ? [] : [route],
    },
    memory: core4g
      ? { retrievalLimit: CORE_4G_LIMITS.maxMemoryRetrieval, maxContextCharacters: 512 }
      : {
          retrievalLimit: constrainedMlx ? 3 : 6,
          maxContextCharacters: constrainedMlx ? 1_000 : 8_000,
        },
    learning: {
      enabled: !core4g,
      groupObservation: !core4g && answers.telegramEnabled,
      minimumSalience: 0.55,
      feedbackLearningRate: 0.2,
      retentionDays: sealed ? 90 : 180,
    },
    embeddings: core4g
      ? { provider: 'builtin', model: 'builtin-hash-v1', dimensions: 256, timeoutMs: 3_000 }
      : embeddingConfigFor(answers),
    transcription: !core4g && answers.transcriptionEnabled
      ? {
          provider: 'whisper-cpp',
          command: validatePathText(answers.whisperCommand, 'whisper.cpp command'),
          modelPath: validatePathText(answers.whisperModelPath, 'whisper.cpp model path'),
          ffmpegCommand: validatePathText(answers.ffmpegCommand, 'FFmpeg command'),
          timeoutMs: 180_000,
          maxBytes: 25_000_000,
          maxDurationSeconds: 1_200,
        }
      : {
          provider: 'disabled',
          command: validatePathText(answers.whisperCommand, 'whisper.cpp command'),
          modelPath: validatePathText(answers.whisperModelPath, 'whisper.cpp model path'),
          ffmpegCommand: validatePathText(answers.ffmpegCommand, 'FFmpeg command'),
          timeoutMs: 180_000,
          maxBytes: 25_000_000,
          maxDurationSeconds: 1_200,
        },
    notifications: {
      enabled: !core4g && answers.telegramEnabled,
      intervalMs: 60_000,
      lookaheadHours: 48,
    },
    subagents: {
      maxCallsPerRun: core4g ? 0 : constrainedMlx ? 2 : 4,
      maxParallel: core4g || constrainedMlx ? 1 : 2,
      maxDepth: core4g ? 0 : 1,
    },
  };

  validateWizardConfig(config);
  const yaml = serializeWizardConfig(config);
  const parsed = validateWizardYaml(yaml);
  if (JSON.stringify(parsed) !== JSON.stringify(config)) {
    throw new Error('Generated configuration did not survive YAML round-trip validation');
  }

  const cwd = options.cwd ?? process.cwd();
  const configPath = resolve(cwd, validatePathText(answers.configPath, 'config path'));
  const warnings = warningsFor(answers, remoteModel, core4g, options.hardware, options.recommendation);
  const protectionAction = fileProtectionAction(options.hardware.platform);
  return {
    profile: core4g ? 'private-local' : answers.profile,
    backend: answers.backend,
    configPath,
    config,
    yaml,
    hardware: options.hardware,
    recommendation: options.recommendation,
    warnings,
    nextSteps: nextStepsFor(answers, configPath, core4g, options.hardware.platform),
    manualActions: core4g
      ? [
          'Treat this plan as core harness readiness only; it does not qualify a model runtime.',
          'Attach only a separately memory- and capability-qualified loopback model runtime, then replace the deterministic fixture model in reviewed configuration.',
          protectionAction,
        ]
      : [
        'Download or provision the selected model outside this wizard.',
        'Start and secure the selected inference service outside this wizard.',
        ...(answers.backend === 'mlx-lm'
          ? [
            `Pre-stage and verify the exact MLX model snapshot at ${answers.mlxModelPath}; do not permit runtime downloads.`,
            'Before production use, create a qualification manifest whose servedModelId is the exact canonical MLX /v1/models local path and whose artifact hashes are contained in that staged snapshot, then run qualify --manifest.',
            'Replace the example python3 command with the reviewed hash-pinned MLX-LM v0.31.3 environment; do not deploy from a floating package install.',
            'Run MLX-LM under a dedicated launchd service/account boundary; its official server provides only basic security checks.',
          ]
        : []),
      protectionAction,
      ...(answers.transcriptionEnabled
        ? ['Install reviewed whisper.cpp, FFmpeg, and transcription model artifacts outside this wizard.']
        : []),
      ],
  };
}

export function serializeWizardConfig(config: AppConfig): string {
  validateWizardConfig(config);
  return YAML.stringify(config, { indent: 2, lineWidth: 0 });
}

export function validateWizardYaml(source: string): AppConfig {
  let parsed: unknown;
  try {
    parsed = YAML.parse(source);
  } catch (error) {
    throw new Error(`Generated YAML is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  return validateWizardConfig(parsed);
}

/** Validates the stricter full shape emitted by this wizard, including secret hygiene. */
export function validateWizardConfig(value: unknown): AppConfig {
  if (!isRecord(value)) throw new Error('Generated config must be an object');
  assertNoInlineSecrets(value);
  if (value.version !== 1) throw new Error('Generated config version must be 1');
  for (const key of [
    'agent',
    'policy',
    'server',
    'storage',
    'model',
    'memory',
    'privacy',
    'telegram',
    'routing',
    'learning',
    'embeddings',
    'transcription',
    'notifications',
    'subagents',
  ]) {
    if (!isRecord(value[key])) throw new Error(`Generated config.${key} must be an object`);
  }
  const model = value.model as Record<string, unknown>;
  const modelProvider = requireText(model.provider, 'model.provider');
  requireText(model.model, 'model.model');
  if (modelProvider === 'mock') {
    if (model.baseUrl !== undefined) {
      throw new Error('Wizard-generated mock models must not configure model.baseUrl');
    }
  } else {
    normalizeHttpBaseUrl(requireText(model.baseUrl, 'model.baseUrl'), 'model.baseUrl');
  }

  const server = value.server as Record<string, unknown>;
  if (!isRecord(server.auth)) throw new Error('Wizard-generated config.server.auth must be an object');
  if (!Array.isArray(server.auth.principals) || server.auth.principals.length !== 1) {
    throw new Error('Wizard-generated control auth must contain exactly one principal');
  }
  const controlPrincipal = server.auth.principals[0];
  if (!isRecord(controlPrincipal)) throw new Error('Wizard-generated control principal must be an object');
  requireText(controlPrincipal.tokenFile, 'server.auth.principals[0].tokenFile');
  if (controlPrincipal.id !== 'local-admin') {
    throw new Error('Wizard-generated control principal must be local-admin');
  }
  if (!Array.isArray(controlPrincipal.capabilities) || controlPrincipal.capabilities.length !== 1
    || controlPrincipal.capabilities[0] !== 'admin') {
    throw new Error('Wizard-generated control principal must have the admin capability');
  }
  if (server.socketPath !== undefined) requireText(server.socketPath, 'server.socketPath');

  const privacy = value.privacy as Record<string, unknown>;
  if (privacy.localOnly !== true) {
    throw new Error('Wizard-generated configs must retain deny-by-default network policy');
  }
  if (!Array.isArray(privacy.allowedOrigins)) {
    throw new Error('privacy.allowedOrigins must be an array');
  }
  for (const origin of privacy.allowedOrigins) validateOrigin(requireText(origin, 'allowed origin'));

  const routes = (value.routing as Record<string, unknown>).routes;
  const core4g = isRecord(value.resources)
    && value.resources.profile === CORE_4G_RESOURCE_PROFILE;
  if (!Array.isArray(routes) || routes.length !== (core4g ? 0 : 1)) {
    throw new Error(
      core4g
        ? 'Wizard-generated core-4g config must not enable a model route'
        : 'Wizard-generated config must contain exactly one model route',
    );
  }
  if (!core4g) {
    if (!isRecord(routes[0])) throw new Error('Wizard-generated model route must be an object');
    const apiKeyEnv = routes[0].apiKeyEnv;
    if (apiKeyEnv !== undefined) validateEnvironmentName(requireText(apiKeyEnv, 'route.apiKeyEnv'));
  }
  const config = value as unknown as AppConfig;
  validateResourceProfile(config);
  return config;
}

/**
 * Publishes a complete file atomically (0600 on POSIX). Without force,
 * hard-link publication is atomic and fails if the destination already
 * exists. With force, an existing regular file is copied to a backup first.
 * Windows callers must separately verify owner-only NTFS ACL inheritance.
 */
export async function writeWizardConfig(
  plan: WizardPlan,
  options: WriteWizardConfigOptions = {},
): Promise<WizardWriteResult> {
  const validated = validateWizardYaml(plan.yaml);
  const destination = resolve(plan.configPath);
  const parent = dirname(destination);
  await assertNoSymlinkDirectoryComponents(parent, 'config directory');
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await assertNoSymlinkDirectoryComponents(parent, 'config directory');
  const existingDestination = await lstat(destination).catch((error: unknown) => {
    if (isErrno(error, 'ENOENT')) return undefined;
    throw error;
  });
  if (existingDestination?.isSymbolicLink()) {
    throw new Error(`Refusing to ${options.force ? 'force-overwrite' : 'write through'} symbolic link ${destination}`);
  }
  if (existingDestination && !existingDestination.isFile()) {
    throw new Error(`Refusing to ${options.force ? 'force-overwrite' : 'overwrite'} non-file ${destination}`);
  }
  if (existingDestination && !options.force) {
    throw new Error(`Config already exists at ${destination}; pass --force to replace it`);
  }

  const auth = validated.server.auth;
  if (!auth) throw new Error('Wizard configuration is missing server.auth');
  const selectedPrincipal = selectControlClientPrincipal(auth);
  const controlTokenPath = resolveConfiguredArtifact(
    selectedPrincipal.tokenFile,
    parent,
    'control token path',
  );
  const controlSocketPath = validated.server.socketPath
    ? resolveConfiguredArtifact(validated.server.socketPath, parent, 'control socket path')
    : undefined;
  const database = validated.storage.database;
  if (database === ':memory:') throw new Error('Wizard installations require durable SQLite storage');
  const databasePath = resolveConfiguredArtifact(database, parent, 'database path');
  const databaseDirectory = dirname(databasePath);
  const protectedArtifacts = [destination, databasePath, controlTokenPath, ...(controlSocketPath ? [controlSocketPath] : [])];
  if (new Set(protectedArtifacts.map((path) => filesystemPathKey(path))).size !== protectedArtifacts.length) {
    throw new Error('Control socket, token, configuration, and database paths must be distinct');
  }
  await ensureProtectedDirectory(databaseDirectory, 'database directory');
  const existingDatabase = await lstat(databasePath).catch((error: unknown) => {
    if (isErrno(error, 'ENOENT')) return undefined;
    throw error;
  });
  if (existingDatabase && (
    existingDatabase.isSymbolicLink()
    || !existingDatabase.isFile()
    || existingDatabase.nlink !== 1
  )) {
    throw new Error('Database path must be a single-link regular non-symlink file when it already exists');
  }
  if (existingDatabase && process.platform !== 'win32' && (existingDatabase.mode & 0o777) !== 0o600) {
    throw new Error('Existing database permissions must be owner-only read/write (0600)');
  }
  await ensureProtectedDirectory(dirname(controlTokenPath), 'control token directory');
  if (controlSocketPath) {
    await ensureProtectedDirectory(dirname(controlSocketPath), 'control socket directory');
    resolveUnixSocketPath(controlSocketPath);
  }
  const controlToken = await ensureControlToken(controlTokenPath);
  const controlTokenCreated = controlToken.created;

  const temporary = `${destination}.tmp-${randomUUID()}`;
  let backupPath: string | undefined;
  let configPublished = false;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(plan.yaml, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (options.force) {
      if (existingDestination) {
        backupPath = await createProtectedBackup(destination, options.now ?? (() => new Date()));
      }
      await rename(temporary, destination);
      configPublished = true;
    } else {
      try {
        await link(temporary, destination);
      } catch (error) {
        if (isErrno(error, 'EEXIST')) {
          throw new Error(`Config already exists at ${destination}; pass --force to replace it`);
        }
        throw error;
      }
      configPublished = true;
      await unlink(temporary);
    }
    await enforcePosixMode(destination, 0o600);
    await syncDirectory(parent);
    return {
      path: destination,
      ...(backupPath ? { backupPath } : {}),
      controlTokenPath,
      controlTokenCreated,
      ...(controlSocketPath ? { controlSocketPath } : {}),
      databaseDirectory,
    };
  } catch (error) {
    await unlink(temporary).catch((cleanupError: unknown) => {
      if (!isErrno(cleanupError, 'ENOENT')) throw cleanupError;
    });
    if (controlToken.identity && !configPublished) {
      await unlinkIfIdentity(controlTokenPath, controlToken.identity);
    }
    throw error;
  }
}

export function validateEnvironmentName(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Z_][A-Z0-9_]*$/.test(normalized)) {
    throw new Error('API key environment variable must match [A-Z_][A-Z0-9_]*');
  }
  return normalized;
}

export function normalizeHttpBaseUrl(value: string, label = 'URL'): string {
  const text = requireText(value.trim(), label);
  if (containsUnsafeTerminalText(text)) throw new Error(`${label} contains forbidden control characters`);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`${label} must be a valid absolute URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${label} must use http or https`);
  }
  if (url.username || url.password) throw new Error(`${label} must not contain credentials`);
  if (url.search || url.hash) throw new Error(`${label} must not contain a query or fragment`);
  return url.toString().replace(/\/$/, '');
}

function embeddingConfigFor(answers: WizardAnswers): NonNullable<AppConfig['embeddings']> {
  void answers;
  return {
    provider: 'builtin',
    model: 'builtin-hash-v1',
    dimensions: 256,
    timeoutMs: 3_000,
  };
}

function warningsFor(
  answers: WizardAnswers,
  remoteModel: boolean,
  core4g: boolean,
  hardware: HardwareInfo,
  recommendation: ModelRecommendation,
): string[] {
  const warnings = [
    hardware.platform === 'win32'
      ? 'The wizard writes the configuration/control token and creates the data directory, but Node chmod cannot verify owner-only NTFS ACLs; ACL verification remains a required operator gate. It does not download models or start services.'
      : 'The wizard writes the protected configuration/control token and creates the data directory. It does not download models or start services.',
    'Application URL policy is defense in depth; enforce deny-by-default egress on the host or container.',
  ];
  if (core4g) {
    if (recommendation.minimumMemoryGiB > hardware.memoryGiB) {
      warnings.push(
        `The detected ${hardware.memoryGiB.toFixed(1)} GiB machine is below the bundled ${recommendation.model} candidate's ${recommendation.minimumMemoryGiB} GiB minimum; no live model runtime is configured or represented as eligible.`,
      );
    } else {
      warnings.push(
        `core-4g-v1 was selected explicitly; the compatible ${recommendation.model} candidate remains disabled and unqualified by this harness-only plan.`,
      );
    }
    warnings.push(
      'core-4g-v1 qualifies only the bounded OpenProjects harness. Model-runtime memory and capability require a separate target-hardware qualification.',
    );
    warnings.push('Telegram, notifications, transcription, learning, subagents, and configured integrations are disabled in this profile.');
    return warnings;
  }
  if (remoteModel) {
    warnings.push('The selected model endpoint leaves this machine; this is not an air-gapped deployment.');
    warnings.push('Route prices use conservative placeholders; replace them with audited provider prices before relying on the daily budget.');
  }
  warnings.push('The lightweight default uses in-process 256-dimensional embeddings. Promote a local semantic model such as BGE-M3 only after pinning its digest and passing the semantic qualification gate.');
  if (answers.backend === 'mlx-lm') {
    warnings.push('MLX-LM is text/tool-only here; vision requires a separately qualified MLX-VLM service and ingestion adapter.');
    warnings.push('Structured tool calls depend on the exact model, tokenizer, chat template, and MLX-LM version; the deep qualification probe must pass before use.');
    warnings.push('The official MLX-LM HTTP server is a local development endpoint with basic security, not a production network boundary.');
  }
  if (answers.backend === 'llama-cpp') {
    warnings.push('llama.cpp remains a separately supervised inference worker; OpenProjects retains all tool, policy, and approval authority.');
    warnings.push('This wizard backend emits one qualification-only project_analysis route. It does not qualify or configure a supervisor route.');
    warnings.push('Keep one exact local model, one slot, CPU-only offload, offline mode, and the built-in UI, agent, MCP, tools, model router, and download surfaces disabled.');
  }
  if (answers.telegramEnabled) {
    warnings.push('Telegram is external SaaS: messages and attachments cross the corporate machine boundary.');
    warnings.push('Telegram secrets must be supplied through TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET, never this file.');
    warnings.push('Telegram webhook ingress requires a reviewed TLS reverse proxy to the loopback service; expose only POST /webhooks/telegram, never /api/*.');
  }
  return warnings;
}

function nextStepsFor(
  answers: WizardAnswers,
  configPath: string,
  core4g: boolean,
  platform: NodeJS.Platform,
): string[] {
  const quote = (value: string): string => shellQuote(value, platform);
  const quotedConfig = quote(configPath);
  const projectCli = 'npx --no-install openprojects';
  const steps: string[] = [];
  if (core4g) {
    steps.push(`${projectCli} doctor --probe --config ${quotedConfig}`);
    steps.push(`Start the bounded core harness: ${projectCli} serve --config ${quotedConfig}`);
    steps.push(`In another terminal, attach mission control: ${projectCli} tui --config ${quotedConfig}`);
    return steps;
  }
  if (answers.backend === 'ollama') {
    steps.push(`ollama pull ${quote(answers.model)}`);
    steps.push(platform === 'win32'
      ? "$env:OLLAMA_NO_CLOUD='1'; ollama serve"
      : 'OLLAMA_NO_CLOUD=1 ollama serve');
  } else if (answers.backend === 'llama-cpp') {
    const endpoint = new URL(normalizeHttpBaseUrl(answers.baseUrl, 'model base URL'));
    const runtimePath = resolve(dirname(configPath), `bin/llama-server${platform === 'win32' ? '.exe' : ''}`);
    const modelPath = resolve(dirname(configPath), answers.llamaModelPath ?? 'models/model.gguf');
    const keyFile = resolve(dirname(configPath), 'llama-server.keys');
    const runtimeCommand = platform === 'win32'
      ? `& ${quote(runtimePath)}`
      : quote(runtimePath);
    steps.push(
      `Install the reviewed hash-pinned llama-server binary at ${quote(runtimePath)}; the wizard never downloads it.`,
    );
    steps.push(
      platform === 'win32'
        ? `Install one random 16-256 character key at ${quote(keyFile)}, restrict its NTFS ACL to the service identity, and expose the same value to OpenProjects as ${validateEnvironmentName(answers.apiKeyEnv!)}.`
        : `Install one random 16-256 character key at ${quote(keyFile)} with mode 0600; expose the same value to OpenProjects as ${validateEnvironmentName(answers.apiKeyEnv!)}.`,
    );
    steps.push(
      [
        runtimeCommand,
        '--model', quote(modelPath),
        '--alias', quote(validateLlamaCppModelAlias(answers.model.trim())),
        '--offline',
        '--host', quote(endpoint.hostname.replace(/^\[|\]$/gu, '')),
        '--port', quote(endpoint.port || '80'),
        '--api-key-file', quote(keyFile),
        '--no-ui', '--no-ui-mcp-proxy', '--no-agent', '--no-slots', '--no-mmproj',
        '--parallel', '1', '--no-cont-batching',
        '--ctx-size', String(answers.contextWindow),
        '--batch-size', '256', '--ubatch-size', '64',
        '--cache-type-k', 'f16', '--cache-type-v', 'f16',
        '--device', 'none', '--gpu-layers', '0',
        '--cache-ram', '64', '--ctx-checkpoints', '2', '--no-cache-idle-slots',
        '--reasoning', 'off', '--n-predict', '512',
        '--load-mode', 'mmap', '--fit', 'off',
        '--threads-http', '1', '--timeout', '60', '--sse-ping-interval', '-1',
      ].join(' '),
    );
  } else if (answers.backend === 'mlx-lm') {
    const databasePath = resolve(dirname(configPath), answers.databasePath);
    const hfHubCache = resolve(dirname(databasePath), 'cache/huggingface/hub');
    steps.push(`install -d -m 0700 ${quote(hfHubCache)}`);
    steps.push(
      `HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 HF_HUB_CACHE=${quote(hfHubCache)} PYTHONNOUSERSITE=1 ${quote('python3')} -I -m mlx_lm server --model ${quote(answers.mlxModelPath ?? './models/mlx-model')} --host 127.0.0.1 --port 8080 --decode-concurrency 1 --prompt-concurrency 1 --prompt-cache-size 1 --prompt-cache-bytes 268435456 --allowed-origins ${quote('http://127.0.0.1')}`,
    );
  } else {
    steps.push(`Verify the existing OpenAI-compatible endpoint at ${answers.baseUrl}.`);
    if (answers.apiKeyEnv) {
      steps.push(`Set ${validateEnvironmentName(answers.apiKeyEnv)} in the service environment without writing it to YAML.`);
    }
  }
  if (answers.telegramEnabled) {
    steps.push(
      'Configure a TLS reverse proxy to forward only POST /webhooks/telegram to http://127.0.0.1:4310; keep /api/* loopback-only.',
    );
  }
  steps.push(`${projectCli} doctor --probe --config ${quotedConfig}`);
  if (answers.backend === 'llama-cpp') {
    const qualificationManifest = resolve(dirname(configPath), 'appliance-qualification.llama-cpp.json');
    const deploymentManifest = resolve(dirname(configPath), 'local-4gb-deployment.llama-cpp.json');
    steps.push(
      `Create and review ${quote(qualificationManifest)} and ${quote(deploymentManifest)} from the checked-in llama.cpp templates; replace every runtime hash and PID placeholder.`,
    );
    steps.push(
      `${projectCli} eval-local-4gb --config ${quotedConfig} --qualification-manifest ${quote(qualificationManifest)} --deployment-manifest ${quote(deploymentManifest)}`,
    );
    steps.push('Promote only the project_analysis lane after that gate passes; this candidate configuration does not authorize a supervisor route.');
    return steps;
  }
  if (answers.backend === 'mlx-lm') {
    const manifestPath = resolve(dirname(configPath), 'appliance-qualification.json');
    steps.push(
      `Create and review the exact MLX snapshot manifest at ${quote(manifestPath)}; replace every fail-closed hash placeholder.`,
    );
    steps.push(
      `${projectCli} qualify --config ${quotedConfig} --manifest ${quote(manifestPath)}`,
    );
  }
  steps.push(`Start the sole runtime owner: ${projectCli} serve --config ${quotedConfig}`);
  steps.push(`In another terminal, attach mission control: ${projectCli} tui --config ${quotedConfig}`);
  return steps;
}

function validateAnswers(answers: WizardAnswers): void {
  if (answers.profile !== 'private-local' && answers.profile !== 'hybrid') {
    throw new Error('Unknown deployment profile');
  }
  if (!['mlx-lm', 'ollama', 'llama-cpp', 'openai-compatible'].includes(answers.backend)) {
    throw new Error('Unknown model backend');
  }
  const model = requireText(answers.model.trim(), 'model');
  if (containsUnsafeTerminalText(model)) throw new Error('model contains forbidden control characters');
  if (!Number.isSafeInteger(answers.contextWindow) || answers.contextWindow < 2_048 || answers.contextWindow > 1_000_000) {
    throw new Error('context window must be an integer between 2048 and 1000000');
  }
  validatePathText(answers.configPath, 'config path');
  validatePathText(answers.databasePath, 'database path');
  if (answers.databasePath === ':memory:') throw new Error('Wizard installations require durable SQLite storage');
  validatePathText(answers.controlTokenPath, 'control token path');
  if (answers.controlSocketPath) validatePathText(answers.controlSocketPath, 'control socket path');
  if (answers.apiKeyEnv) validateEnvironmentName(answers.apiKeyEnv);
  if (answers.backend === 'llama-cpp') {
    validatePathText(answers.llamaModelPath ?? '', 'llama.cpp model path');
    const endpoint = new URL(normalizeHttpBaseUrl(answers.baseUrl, 'model base URL'));
    if (!endpoint.port) throw new Error('The llama.cpp lightweight candidate requires an explicit loopback port');
    if (answers.contextWindow > 3_072) {
      throw new Error('The llama.cpp lightweight candidate context window must be no larger than 3072 tokens');
    }
  }
  if (answers.backend === 'mlx-lm') {
    validatePathText(answers.mlxModelPath ?? '', 'MLX model path');
  }
}

function providerFor(backend: WizardAnswers['backend']): string {
  if (backend === 'llama-cpp') return 'llama.cpp';
  return backend === 'ollama' ? 'ollama' : backend;
}

function routeIdFor(backend: WizardAnswers['backend']): string {
  if (backend === 'mlx-lm') return 'local-mlx-lm';
  if (backend === 'ollama') return 'local-ollama';
  if (backend === 'llama-cpp') return 'local-llama-cpp';
  return 'existing-openai-compatible';
}

function validateOrigin(value: string): void {
  const url = new URL(normalizeHttpBaseUrl(value, 'allowed origin'));
  if (url.pathname !== '/') throw new Error('Allowed origins must not contain a path');
}

function validatePathText(value: string, label: string): string {
  const normalized = requireText(value.trim(), label);
  if (containsUnsafeTerminalText(normalized)) throw new Error(`${label} contains forbidden control characters`);
  const absolute = resolve(normalized);
  if (absolute === parse(absolute).root) throw new Error(`${label} must not target a filesystem root`);
  return normalized;
}

function assertNoInlineSecrets(value: unknown, path = 'config'): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoInlineSecrets(item, `${path}[${index}]`));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (/^(apiKey|token|secret|password)$/i.test(key)) {
      throw new Error(`${path}.${key} must not contain an inline secret`);
    }
    assertNoInlineSecrets(child, `${path}.${key}`);
  }
}

function resolveConfiguredArtifact(value: string, configDirectory: string, label: string): string {
  const safe = validatePathText(value, label);
  return isAbsolute(safe) ? safe : resolve(configDirectory, safe);
}

async function ensureProtectedDirectory(path: string, label: string): Promise<void> {
  await assertNoSymlinkDirectoryComponents(path, label);
  const before = await lstat(path).catch((error: unknown) => {
    if (isErrno(error, 'ENOENT')) return undefined;
    throw error;
  });
  if (!before) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    await enforcePosixMode(path, 0o700);
  }
  await assertNoSymlinkDirectoryComponents(path, label);
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`${label} must be a real directory, not a symbolic link or special file`);
  }
  if (process.platform !== 'win32' && (info.mode & 0o777) !== 0o700) {
    throw new Error(`${label} permissions must be owner-only (0700)`);
  }
}

async function assertNoSymlinkDirectoryComponents(path: string, label: string): Promise<void> {
  const absolute = resolve(path);
  const parsed = parse(absolute);
  const components = absolute.slice(parsed.root.length).split(/[\\/]+/u).filter(Boolean);
  let current = parsed.root;
  for (const component of components) {
    current = resolve(current, component);
    const info = await lstat(current).catch((error: unknown) => {
      if (isErrno(error, 'ENOENT')) return undefined;
      throw error;
    });
    if (!info) return;
    if (info.isSymbolicLink()) throw new Error(`${label} contains a symbolic-link path component`);
    if (!info.isDirectory()) throw new Error(`${label} contains a non-directory path component`);
  }
}

interface FileIdentity {
  device: bigint;
  inode: bigint;
}

interface ControlTokenState {
  created: boolean;
  identity?: FileIdentity;
}

async function ensureControlToken(path: string): Promise<ControlTokenState> {
  const existing = await lstat(path).catch((error: unknown) => {
    if (isErrno(error, 'ENOENT')) return undefined;
    throw error;
  });
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new Error('Control token path must be a regular non-symlink file');
    }
    loadControlClientCredential({ tokenFile: path });
    return { created: false };
  }

  let createdIdentity: FileIdentity | undefined;
  try {
    const handle = await open(path, 'wx', 0o600);
    try {
      const created = await handle.stat({ bigint: true });
      createdIdentity = { device: created.dev, inode: created.ino };
      await handle.writeFile(`${randomBytes(32).toString('base64url')}\n`, 'ascii');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await enforcePosixMode(path, 0o600);
    await syncDirectory(dirname(path));
    loadControlClientCredential({ tokenFile: path });
    return { created: true, identity: createdIdentity };
  } catch (error) {
    if (createdIdentity) await unlinkIfIdentity(path, createdIdentity).catch(() => undefined);
    if (isErrno(error, 'EEXIST')) {
      loadControlClientCredential({ tokenFile: path });
      return { created: false };
    }
    throw error;
  }
}

async function unlinkIfIdentity(path: string, identity: FileIdentity): Promise<void> {
  const current = await lstat(path, { bigint: true }).catch((error: unknown) => {
    if (isErrno(error, 'ENOENT')) return undefined;
    throw error;
  });
  if (!current || current.dev !== identity.device || current.ino !== identity.inode) return;
  await unlink(path);
}

async function createProtectedBackup(path: string, now: () => Date): Promise<string> {
  const stamp = now().toISOString().replace(/[:.]/g, '-');
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const suffix = attempt === 0 ? '' : `-${attempt}`;
    const backup = `${path}.bak-${stamp}${suffix}`;
    try {
      await copyFile(path, backup, constants.COPYFILE_EXCL);
      await enforcePosixMode(backup, 0o600);
      return backup;
    } catch (error) {
      if (isErrno(error, 'EEXIST')) continue;
      throw error;
    }
  }
  throw new Error(`Unable to create a unique backup for ${path}`);
}

async function syncDirectory(path: string): Promise<void> {
  // Windows has no portable directory-fsync contract in Node. Every published
  // file is individually synced before this point; do not turn a successful
  // durable file write into EPERM by trying to open the directory as a file.
  if (process.platform === 'win32') return;
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } catch (error) {
    // Some filesystems do not support directory fsync. The file itself was synced.
    if (!isErrno(error, 'EINVAL') && !isErrno(error, 'ENOTSUP')) throw error;
  } finally {
    await handle.close();
  }
}

async function enforcePosixMode(path: string, mode: number): Promise<void> {
  if (process.platform !== 'win32') await chmod(path, mode);
}

function shellQuote(value: string, platform: NodeJS.Platform): string {
  return platform === 'win32'
    ? `'${value.replace(/'/g, "''")}'`
    : `'${value.replace(/'/g, `'"'"'`)}'`;
}

function fileProtectionAction(platform: NodeJS.Platform): string {
  return platform === 'win32'
    ? 'Restrict the configuration, control token, database, WAL/SHM, and backups to the service identity with NTFS ACLs, then verify them with Get-Acl or icacls; Node chmod cannot prove owner-only Windows access.'
    : 'Protect the database and backup files with mode 0600; setup creates the database parent directory with mode 0700.';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} must not be empty`);
  return value;
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

function containsUnsafeTerminalText(value: string): boolean {
  return /[\u0000-\u001f\u007f-\u009f]|\p{Cf}/u.test(value);
}
