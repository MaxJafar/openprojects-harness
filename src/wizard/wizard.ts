import { resolve } from 'node:path';

import { validateMlxLmBaseUrl } from '../adapters/models.js';
import type { AppConfig } from '../core/types.js';
import { isLoopbackHostname } from '../privacy/network-policy.js';
import { buildWizardPlan, normalizeHttpBaseUrl, validateEnvironmentName, writeWizardConfig } from './config.js';
import {
  detectHardware,
  formatMemoryGiB,
  modelFitsHardware,
  recommendLocalModel,
  recommendMlxModel,
  usesCore4gProfile,
} from './hardware.js';
import type {
  HardwareInfo,
  InputPrompt,
  ModelBackend,
  RunWizardOptions,
  WizardAnswers,
  WizardDefaults,
  WizardIO,
  WizardPaths,
  WizardProfile,
  WizardResult,
} from './types.js';

const DEFAULT_PATHS: WizardPaths = {
  config: 'openprojects.local.yaml',
  database: './data/openprojects.db',
  controlToken: './data/control.token',
  controlSocket: './data/control.sock',
  mlxModel: './models/mlx-model',
  llamaModel: './models/model.gguf',
  whisperCommand: 'whisper-cli',
  whisperModel: './models/ggml-small.bin',
  ffmpegCommand: 'ffmpeg',
};

/** Collect answers only; this function never reads or writes the filesystem. */
export async function collectWizardAnswers(
  io: WizardIO,
  hardware: HardwareInfo,
  defaults: WizardDefaults = {},
): Promise<WizardAnswers> {
  const core4g = defaults.core4g === true || usesCore4gProfile(hardware);
  const defaultBackend = defaults.backend
    ?? (hardware.acceleration === 'apple-silicon' ? 'mlx-lm' : 'ollama');
  const recommendation = recommendationFor(defaultBackend, hardware);
  const paths = { ...DEFAULT_PATHS, ...defaults.paths };
  io.write('OpenProjects private installation wizard');
  io.write(
    `Detected ${hardware.cpuModel}, ${hardware.logicalCpuCount} logical CPU(s), `
      + `${formatMemoryGiB(hardware)} memory (${hardware.acceleration}).`,
  );
  if (modelFitsHardware(recommendation, hardware)) {
    io.write(
      `Recommended local model: ${recommendation.model} (${recommendation.parameterClass}). `
        + recommendation.rationale,
    );
  } else {
    io.write(
      `No bundled local model is eligible for ${formatMemoryGiB(hardware)}: `
        + `${recommendation.model} requires at least ${recommendation.minimumMemoryGiB} GiB. `
        + 'The wizard will generate a bounded core harness; model qualification remains separate.',
    );
  }

  const profile = core4g
    ? 'private-local'
    : await selectOne<WizardProfile>(io, {
        id: 'profile',
        message: 'Choose a deployment profile',
        defaultValue: defaults.profile ?? 'private-local',
        choices: [
          {
            value: 'private-local',
            label: 'Private local',
            description: 'Loopback inference, no Telegram, and external writes denied.',
            recommended: true,
          },
          {
            value: 'hybrid',
            label: 'Hybrid',
            description: 'Explicit external model or Telegram origins may leave the machine.',
          },
        ],
      });

  const backend = core4g
    ? defaultBackend
    : await selectOne<ModelBackend>(io, {
        id: 'backend',
        message: 'Choose the OpenAI-compatible model runtime',
        defaultValue: defaultBackend,
        choices: [
          ...(hardware.acceleration === 'apple-silicon'
            ? [{
                value: 'mlx-lm',
                label: 'MLX-LM',
                description: 'Apple-Silicon-native text/tool inference through a separately supervised local server.',
                recommended: modelFitsHardware(recommendMlxModel(hardware), hardware),
              }]
            : []),
          {
            value: 'ollama',
            label: 'Ollama',
            description: 'Simple local runtime with local embeddings.',
            recommended: hardware.acceleration !== 'apple-silicon'
              && modelFitsHardware(recommendLocalModel(hardware), hardware),
          },
          {
            value: 'llama-cpp',
            label: 'llama.cpp',
            description: 'Pinned GGUF model served by llama-server.',
          },
          {
            value: 'openai-compatible',
            label: 'Existing endpoint',
            description: 'A reviewed local, corporate, or hosted OpenAI-compatible service.',
          },
        ],
      });
  if (core4g) {
    io.write('core-4g-v1 is selected automatically; live model runtime questions are skipped.');
  }

  const selectedRecommendation = recommendationFor(backend, hardware);
  if (selectedRecommendation.model !== recommendation.model) {
    if (modelFitsHardware(selectedRecommendation, hardware)) {
      io.write(
        `Recommended local model: ${selectedRecommendation.model} (${selectedRecommendation.parameterClass}). `
          + selectedRecommendation.rationale,
      );
    } else {
      io.write(
        `Candidate ${selectedRecommendation.model} requires at least `
          + `${selectedRecommendation.minimumMemoryGiB} GiB and will not be enabled by the core plan.`,
      );
    }
  }

  const defaultBaseUrl = backend === 'ollama'
    ? 'http://127.0.0.1:11434/v1'
    : backend === 'llama-cpp' || backend === 'mlx-lm'
      ? 'http://127.0.0.1:8080/v1'
      : profile === 'private-local'
        ? 'http://127.0.0.1:8080/v1'
        : 'https://api.openai.com/v1';
  const baseUrl = core4g ? defaultBaseUrl : await askValidated(io, {
    id: 'model-base-url',
    message: 'Model API base URL',
    defaultValue: defaultBaseUrl,
    hint: profile === 'private-local'
      ? 'Private local accepts only loopback endpoints (localhost, 127.0.0.0/8, or ::1).'
      : 'A non-loopback origin is explicitly allowlisted and leaves this machine.',
  }, (value) => {
    const normalized = normalizeHttpBaseUrl(value, 'model base URL');
    if (backend === 'mlx-lm') return validateMlxLmBaseUrl(normalized);
    const local = isLoopbackHostname(new URL(normalized).hostname);
    if (profile === 'private-local' && !local) {
      throw new Error('Private local requires a loopback model endpoint');
    }
    if (backend !== 'openai-compatible' && !local) {
      throw new Error(`${backend} is a local runtime and requires a loopback endpoint`);
    }
    return normalized;
  });
  const model = core4g ? selectedRecommendation.model : await askValidated(io, {
    id: 'model',
    message: 'Model name exposed by the endpoint',
    defaultValue: selectedRecommendation.model,
  }, nonEmptyText('model'));
  const contextWindow = core4g ? selectedRecommendation.contextWindow : Number(await askValidated(io, {
    id: 'context-window',
    message: 'Context window advertised by this exact served model',
    defaultValue: String(selectedRecommendation.contextWindow),
    hint: 'This is an explicit routing limit, not a hardware guess; verify the selected quantization/runtime.',
  }, boundedInteger('context window', 2_048, 1_000_000)));

  let apiKeyEnv: string | undefined;
  if (!core4g && backend === 'openai-compatible') {
    const remote = !isLoopback(baseUrl);
    if (remote) {
      io.write('Remote model routes require an API key environment variable; the key itself is never requested.');
    }
    const authenticated = remote || await io.confirm({
      id: 'model-auth',
      message: 'Does this local endpoint require a bearer token?',
      defaultValue: false,
    });
    if (authenticated) {
      apiKeyEnv = await askValidated(io, {
        id: 'api-key-env',
        message: 'Environment variable containing the API key (never the key itself)',
        defaultValue: 'OPENPROJECTS_MODEL_API_KEY',
      }, validateEnvironmentName);
    }
  }

  let llamaModelPath: string | undefined;
  if (backend === 'llama-cpp') {
    llamaModelPath = core4g
      ? paths.llamaModel
      : await askValidated(io, {
          id: 'llama-model-path',
          message: 'GGUF model path for the manual llama-server command',
          defaultValue: paths.llamaModel,
        }, safePath('llama.cpp model path'));
  }

  let mlxModelPath: string | undefined;
  if (backend === 'mlx-lm') {
    mlxModelPath = core4g
      ? paths.mlxModel
      : await askValidated(io, {
          id: 'mlx-model-path',
          message: 'Pre-staged local MLX model directory',
          defaultValue: paths.mlxModel,
          hint: 'The service must load this reviewed local snapshot; OpenProjects will not download a model.',
        }, safePath('MLX model path'));
  }

  const configPath = await askValidated(io, {
    id: 'config-path',
    message: 'Configuration output path',
    defaultValue: paths.config,
  }, safePath('config path'));
  const databasePath = await askValidated(io, {
    id: 'database-path',
    message: 'SQLite database path stored in configuration',
    defaultValue: paths.database,
  }, safePath('database path'));
  const controlTokenPath = await askValidated(io, {
    id: 'control-token-path',
    message: 'Local control-token file path stored in configuration',
    defaultValue: paths.controlToken,
    hint: hardware.platform === 'win32'
      ? 'The token is generated only after final confirmation; restrict and verify its inherited NTFS ACL before service use.'
      : 'The token is generated only after final confirmation and written with mode 0600.',
  }, safePath('control token path'));
  let telegramEnabled = false;
  if (core4g) {
    io.write('Telegram remains disabled in core-4g-v1 to preserve the bounded local harness.');
  } else if (profile === 'hybrid') {
    io.write(
      'Privacy boundary: Telegram is external SaaS. Group messages and attachments cross the machine boundary.',
    );
    telegramEnabled = await io.confirm({
      id: 'telegram',
      message: 'Enable the external Telegram transport?',
      defaultValue: false,
    });
    if (telegramEnabled) {
      io.write(
        'Tokens are not requested or written. Supply TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET at runtime.',
      );
    }
  } else {
    io.write('Telegram remains disabled in the sealed private-local profile.');
  }

  // Telegram needs a separately reviewed HTTP ingress. Until the product has
  // a dedicated webhook listener, use a loopback TCP listener behind a proxy
  // that exposes only the webhook route; the private profile stays on UDS.
  const controlSocketPath = hardware.platform === 'win32' || telegramEnabled
    ? undefined
    : paths.controlSocket;
  if (controlSocketPath) {
    io.write(`The private control plane will use the protected Unix socket ${controlSocketPath}.`);
  } else if (telegramEnabled) {
    io.write(
      'Telegram requires loopback TCP plus a reviewed TLS reverse proxy that exposes only POST /webhooks/telegram; /api/* must remain private.',
    );
  }

  const transcriptionEnabled = core4g
    ? false
    : await io.confirm({
        id: 'transcription',
        message: 'Configure local whisper.cpp transcription paths?',
        defaultValue: false,
      });
  if (core4g) io.write('Transcription remains disabled in core-4g-v1.');
  const whisperCommand = transcriptionEnabled
    ? await askValidated(io, {
        id: 'whisper-command',
        message: 'whisper.cpp command path',
        defaultValue: paths.whisperCommand,
      }, safePath('whisper.cpp command'))
    : paths.whisperCommand;
  const whisperModelPath = transcriptionEnabled
    ? await askValidated(io, {
        id: 'whisper-model-path',
        message: 'Whisper model path',
        defaultValue: paths.whisperModel,
      }, safePath('Whisper model path'))
    : paths.whisperModel;
  const ffmpegCommand = transcriptionEnabled
    ? await askValidated(io, {
        id: 'ffmpeg-command',
        message: 'FFmpeg command path',
        defaultValue: paths.ffmpegCommand,
      }, safePath('FFmpeg command'))
    : paths.ffmpegCommand;

  return {
    profile,
    backend,
    configPath,
    databasePath,
    controlTokenPath,
    ...(controlSocketPath ? { controlSocketPath } : {}),
    model,
    baseUrl,
    contextWindow,
    ...(apiKeyEnv ? { apiKeyEnv } : {}),
    ...(mlxModelPath ? { mlxModelPath } : {}),
    ...(llamaModelPath ? { llamaModelPath } : {}),
    telegramEnabled,
    transcriptionEnabled,
    whisperCommand,
    whisperModelPath,
    ffmpegCommand,
  };
}

/** Deterministic, non-interactive defaults for CI plans and headless review. */
export function createDefaultWizardAnswers(
  hardware: HardwareInfo,
  defaults: WizardDefaults = {},
): WizardAnswers {
  const paths = { ...DEFAULT_PATHS, ...defaults.paths };
  const profile = defaults.core4g === true || usesCore4gProfile(hardware)
    ? 'private-local'
    : defaults.profile ?? 'private-local';
  const backend = defaults.backend
    ?? (hardware.acceleration === 'apple-silicon' ? 'mlx-lm' : 'ollama');
  const recommendation = recommendationFor(backend, hardware);
  const baseUrl = backend === 'ollama'
    ? 'http://127.0.0.1:11434/v1'
    : 'http://127.0.0.1:8080/v1';
  return {
    profile,
    backend,
    configPath: paths.config,
    databasePath: paths.database,
    controlTokenPath: paths.controlToken,
    ...(hardware.platform === 'win32' ? {} : { controlSocketPath: paths.controlSocket }),
    model: recommendation.model,
    baseUrl,
    contextWindow: recommendation.contextWindow,
    ...(backend === 'mlx-lm' ? { mlxModelPath: paths.mlxModel } : {}),
    ...(backend === 'llama-cpp' ? { llamaModelPath: paths.llamaModel } : {}),
    telegramEnabled: false,
    transcriptionEnabled: false,
    whisperCommand: paths.whisperCommand,
    whisperModelPath: paths.whisperModel,
    ffmpegCommand: paths.ffmpegCommand,
  };
}

/**
 * Runs the guided flow. Dry-run returns a complete plan without filesystem
 * mutation. A real write always requires an explicit final confirmation.
 */
export async function runInstallationWizard(options: RunWizardOptions): Promise<WizardResult> {
  const hardware = options.hardware ?? detectHardware();
  if (!options.io && !options.acceptDefaults) {
    throw new Error('Interactive wizard operation requires a WizardIO implementation');
  }
  if (!options.io && !options.dryRun) {
    throw new Error('Headless defaults may only be used with dryRun; writing requires explicit confirmation');
  }
  const answers = options.acceptDefaults
    ? createDefaultWizardAnswers(hardware, options)
    : await collectWizardAnswers(options.io!, hardware, options);
  const plan = buildWizardPlan(answers, {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    hardware,
    recommendation: recommendationFor(answers.backend, hardware),
    core4g: options.core4g === true,
  });
  if (options.io) renderPlan(options.io, plan, options.dryRun === true);
  if (options.dryRun) return { status: 'planned', plan };

  const confirmed = await options.io!.confirm({
    id: 'write-config',
    message: options.force
      ? `Write configuration to ${plan.configPath} and back up any existing regular file?`
      : `Write new configuration to ${plan.configPath}? Existing files will not be overwritten.`,
    defaultValue: false,
  });
  if (!confirmed) return { status: 'cancelled', plan };
  const write = await writeWizardConfig(plan, {
    force: options.force === true,
    ...(options.now ? { now: options.now } : {}),
  });
  options.io!.write(hardware.platform === 'win32'
    ? `Configuration written: ${write.path}. Verify its NTFS ACL before service use.`
    : `Configuration written with mode 0600: ${write.path}`);
  options.io!.write(hardware.platform === 'win32'
    ? `${write.controlTokenCreated ? 'Control token created' : 'Existing control token retained'}; NTFS ACL verification required: ${write.controlTokenPath}`
    : `${write.controlTokenCreated ? 'Control token created' : 'Existing control token retained'} with protected permissions: ${write.controlTokenPath}`);
  if (write.backupPath) options.io!.write(`Previous configuration backup: ${write.backupPath}`);
  return { status: 'written', plan, write };
}

function recommendationFor(backend: ModelBackend, hardware: HardwareInfo) {
  return backend === 'mlx-lm' ? recommendMlxModel(hardware) : recommendLocalModel(hardware);
}

export function renderPlan(io: WizardIO, plan: WizardResult['plan'], dryRun: boolean): void {
  for (const line of renderPlanLines(plan, dryRun)) io.write(line);
}

export function renderPlanLines(plan: WizardResult['plan'], dryRun: boolean): string[] {
  const core4g = plan.config.resources?.profile === 'core-4g-v1';
  return [
    dryRun ? 'Dry-run plan (no files will be written)' : 'Installation plan',
    `Profile: ${plan.profile}`,
    `Hardware: ${formatMemoryGiB(plan.hardware)}, ${plan.hardware.acceleration}, ${plan.hardware.logicalCpuCount} logical CPU(s)`,
    core4g
      ? 'Model: no live runtime provisioned; deterministic core harness fixture only'
      : `Model: ${plan.config.model.provider}/${plan.config.model.model} (${plan.config.routing?.routes[0]?.contextWindow ?? 'unknown'} token context)`,
    ...(plan.config.model.baseUrl ? [`Model endpoint: ${plan.config.model.baseUrl}`] : []),
    ...(core4g
      ? [`Resources: core-4g-v1; retrieved-memory aggregate ${plan.config.resources!.maxRetrievedContextCharacters} characters`]
      : []),
    `Network: localOnly=true; allowed origins: ${plan.config.privacy?.allowedOrigins.join(', ') || 'none'}`,
    `Telegram: ${plan.config.telegram?.enabled === true ? 'enabled external transport' : 'disabled'}`,
    `Transcription: ${plan.config.transcription?.provider ?? 'disabled'}`,
    `Policy: external writes ${plan.config.policy.external_write}; destructive actions ${plan.config.policy.destructive}`,
    `Storage: ${plan.config.storage.database}`,
    `Control endpoint: ${plan.config.server.socketPath ?? `${plan.config.server.host}:${plan.config.server.port}`}`,
    `Control authentication: ${controlPrincipalSummary(plan.config)} (generated only after confirmation)`,
    plan.hardware.platform === 'win32'
      ? `Config: ${plan.configPath} (NTFS ACL verification required)`
      : `Config: ${plan.configPath} (mode 0600)`,
    core4g
      ? 'Vision: disabled and unqualified in the bounded core harness.'
      : 'Vision: model capability may exist, but image/document ingestion is not implemented yet.',
    ...plan.warnings.map((warning) => `Warning: ${warning}`),
    ...plan.manualActions.map((action) => `Manual action: ${action}`),
    ...plan.nextSteps.map((step, index) => `Next ${index + 1}: ${step}`),
  ];
}

function controlPrincipalSummary(config: AppConfig): string {
  const auth = config.server.auth;
  if (!auth) return 'disabled';
  if (Array.isArray(auth.principals)) {
    const principal = auth.principals[0];
    return `${principal?.id ?? 'unknown'}; token file ${principal?.tokenFile ?? 'none'}`;
  }
  return `${auth.operatorId}; token file ${auth.tokenFile}`;
}

async function selectOne<T extends string>(
  io: WizardIO,
  prompt: Parameters<WizardIO['select']>[0],
): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const value = await io.select(prompt);
    if (prompt.choices.some((choice) => choice.value === value)) return value as T;
    io.write(`Invalid selection for ${prompt.id}: ${value}`);
  }
  throw new Error(`Too many invalid selections for ${prompt.id}`);
}

async function askValidated(
  io: WizardIO,
  prompt: InputPrompt,
  validate: (value: string) => string,
): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const value = await io.input(prompt);
    try {
      return validate(value);
    } catch (error) {
      io.write(`Invalid value: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`Too many invalid responses for ${prompt.id}`);
}

function nonEmptyText(label: string): (value: string) => string {
  return (value) => {
    const normalized = value.trim();
    if (!normalized) throw new Error(`${label} must not be empty`);
    if (/[\u0000-\u001f\u007f-\u009f]|\p{Cf}/u.test(normalized)) {
      throw new Error(`${label} contains forbidden control characters`);
    }
    return normalized;
  };
}

function safePath(label: string): (value: string) => string {
  return (value) => {
    const normalized = nonEmptyText(label)(value);
    if (normalized === '/' || resolve(normalized) === '/') {
      throw new Error(`${label} must not target the filesystem root`);
    }
    return normalized;
  };
}

function boundedInteger(label: string, minimum: number, maximum: number): (value: string) => string {
  return (value) => {
    const normalized = value.trim();
    if (!/^\d+$/u.test(normalized)) throw new Error(`${label} must be an integer`);
    const parsed = Number(normalized);
    if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
      throw new Error(`${label} must be between ${minimum} and ${maximum}`);
    }
    return String(parsed);
  };
}

function isLoopback(baseUrl: string): boolean {
  return isLoopbackHostname(new URL(baseUrl).hostname);
}
