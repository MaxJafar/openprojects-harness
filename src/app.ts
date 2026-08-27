import {
  FreeTokenAdapter,
  LlamaCppAdapter,
  MlxLmAdapter,
  OpenAICompatibleAdapter,
  ProjectOpsFixtureModel,
  validateApiBaseUrl,
  validateFreeTokenBaseUrl,
  validateLlamaCppBaseUrl,
  validateMlxLmBaseUrl,
} from './adapters/models.js';
import { createEmbeddingAdapter } from './adapters/embeddings.js';
import { createTranscriptionAdapter } from './adapters/transcription.js';
import { loadConfig, validateResourceProfile } from './config.js';
import { HarnessKernel, type HarnessPlugin } from './core/kernel.js';
import type { AppConfig, EmbeddingAdapter, RunOutcome, SkillDefinition, TranscriptionAdapter } from './core/types.js';
import {
  memoryPlugin,
  modelPlugin,
  policyPlugin,
  projectsPlugin,
  promptPlugin,
  seedDemoWorkspace,
  storagePlugin,
  telemetryPlugin,
} from './plugins/builtin.js';
import { AgentRuntime } from './runtime/agent.js';
import { PROJECT_ANALYST_AGENT, ProjectAnalystLane } from './runtime/project-analyst.js';
import { RunAdmissionGovernor } from './runtime/run-admission.js';
import { createModelRouter, ModelRouter } from './runtime/model-router.js';
import { acquireRuntimeOwnerLock } from './runtime/owner-lock.js';
import { delegateAgentTool, SubagentCoordinator } from './runtime/subagents.js';
import { MemoryEngine } from './learning/memory-engine.js';
import { CorporateOracle } from './oracle/corporate-oracle.js';
import { corporateOraclePlugin } from './oracle/plugin.js';
import {
  createNetworkPolicy,
  isLoopbackHostname,
  type OutboundNetworkPolicy,
} from './privacy/network-policy.js';
import { loadSkills } from './skills/loader.js';
import { SqliteStorage } from './storage/sqlite.js';
import type {
  ConfiguredIntegrationSummary,
  IntegrationMode,
  PreparedIntegrations,
} from './integrations/configured.js';

export interface CreateAppOptions {
  configPath?: string;
  config?: AppConfig;
  skills?: SkillDefinition[];
  databasePath?: string;
  seedDemo?: boolean;
  mode?: 'full' | 'project-analyst';
  /** Live owns connector transports; offline registers inert reviewed contracts only. */
  integrationMode?: IntegrationMode;
  /** Reviewed local extensions mounted before composition is validated. */
  plugins?: readonly HarnessPlugin[];
}

export interface OpenProjectsApp {
  config: AppConfig;
  kernel: HarnessKernel;
  storage: SqliteStorage;
  runtime: AgentRuntime;
  projectAnalyst: ProjectAnalystLane;
  subagents: SubagentCoordinator;
  embedding: EmbeddingAdapter;
  memoryEngine: MemoryEngine;
  oracle: CorporateOracle;
  transcriber: TranscriptionAdapter;
  networkPolicy: OutboundNetworkPolicy;
  integrations: readonly ConfiguredIntegrationSummary[];
  modelRouter?: ModelRouter;
  skills: SkillDefinition[];
  recover(): Promise<RunOutcome[]>;
  close(): Promise<void>;
}

export async function createApp(options: CreateAppOptions = {}): Promise<OpenProjectsApp> {
  const loaded = options.config ?? loadConfig(options.configPath);
  const configured: AppConfig = options.databasePath
    ? { ...loaded, storage: { database: options.databasePath } }
    : loaded;
  const config: AppConfig = {
    ...configured,
    privacy: configured.privacy ?? { localOnly: true, allowedOrigins: [] },
    telegram: configured.telegram ?? { enabled: false, apiBaseUrl: 'https://api.telegram.org' },
  };
  validateResourceProfile(config);
  const networkPolicy = createNetworkPolicy(config.privacy);
  validateOutboundConfiguration(config, networkPolicy);
  let integrations: PreparedIntegrations = { manifests: [], plugins: [], summaries: [] };
  if (config.integrations) {
    const { prepareConfiguredIntegrations } = await import('./integrations/configured.js');
    integrations = await prepareConfiguredIntegrations(config, networkPolicy, {
      mode: options.integrationMode ?? 'live',
    });
  }
  const skills = options.skills ?? (config.agent.skills.length > 0 ? loadSkills() : []);
  const ownerLock = acquireRuntimeOwnerLock(config.storage.database);
  let storage: SqliteStorage;
  try {
    storage = new SqliteStorage(config.storage.database);
  } catch (error) {
    ownerLock.release();
    throw error;
  }
  const kernel = new HarnessKernel();

  try {
    if (options.seedDemo === true) seedDemoWorkspace(storage);
    const adapter = createModelAdapter(config, storage, networkPolicy);
    const embeddingConfig = config.embeddings ?? {
      provider: 'builtin' as const,
      model: 'builtin-hash-v1',
      dimensions: 256,
      timeoutMs: 3_000,
    };
    const transcriptionConfig = config.transcription ?? {
      provider: 'disabled' as const,
      command: 'whisper-cli',
      ffmpegCommand: 'ffmpeg',
      timeoutMs: 180_000,
      maxBytes: 25_000_000,
      maxDurationSeconds: 1_200,
    };
    const embedding = createEmbeddingAdapter(embeddingConfig, networkPolicy);
    const transcriber = createTranscriptionAdapter(transcriptionConfig);
    const memoryEngine = new MemoryEngine({
      storage,
      embedding,
      minimumSalience: config.learning?.minimumSalience ?? 0.55,
      feedbackLearningRate: config.learning?.feedbackLearningRate ?? 0.2,
      retentionDays: config.learning?.retentionDays ?? 180,
    });
    const oracle = new CorporateOracle(storage, embedding);
    const runAdmission = new RunAdmissionGovernor(config.resources?.profile === 'core-4g-v1' ? 1 : undefined);
    const projectAnalyst = new ProjectAnalystLane(config, kernel, storage, memoryEngine, runAdmission);
    const subagents = new SubagentCoordinator(config, kernel, storage, undefined, projectAnalyst);
    await kernel.mount(storagePlugin(storage));
    await kernel.mount(modelPlugin(adapter));
    await kernel.mount({
      id: 'subagents',
      requires: ['storage'],
      setup(context) {
        context.registerTool(delegateAgentTool(subagents));
      },
    });
    await kernel.mount(policyPlugin(
      { ...config.agent, system: config.agent.system ?? '' },
      config.policy,
      [PROJECT_ANALYST_AGENT],
    ));
    await kernel.mount(promptPlugin({ ...config.agent, system: config.agent.system ?? '' }, skills));
    await kernel.mount(memoryPlugin(memoryEngine));
    await kernel.mount(corporateOraclePlugin(oracle));
    await kernel.mount(projectsPlugin());
    await kernel.mount(telemetryPlugin());
    for (const plugin of integrations.plugins) await kernel.mount(plugin);
    for (const plugin of options.plugins ?? []) await kernel.mount(plugin);
    validateComposition(config, skills, kernel, options.mode ?? 'full');
    const runtime = new AgentRuntime(config, kernel, storage, skills, memoryEngine, {}, runAdmission);
    let closed = false;
    return {
      config,
      kernel,
      storage,
      runtime,
      projectAnalyst,
      subagents,
      embedding,
      memoryEngine,
      oracle,
      transcriber,
      networkPolicy,
      integrations: integrations.summaries,
      ...(adapter instanceof ModelRouter ? { modelRouter: adapter } : {}),
      skills,
      async recover() {
        return [
          ...await projectAnalyst.recover(),
          ...await runtime.recover(),
        ];
      },
      async close() {
        if (closed) return;
        closed = true;
        const failures: unknown[] = [];
        try {
          await kernel.dispose();
        } catch (error) {
          failures.push(error);
        }
        try {
          storage.close();
        } catch (error) {
          failures.push(error);
        }
        try {
          ownerLock.release();
        } catch (error) {
          failures.push(error);
        }
        if (failures.length) throw new AggregateError(failures, 'OpenProjects shutdown did not complete cleanly');
      },
    };
  } catch (error) {
    const failures: unknown[] = [error];
    try {
      await kernel.dispose();
    } catch (disposeError) {
      failures.push(disposeError);
    }
    try {
      storage.close();
    } catch (storageError) {
      failures.push(storageError);
    }
    try {
      ownerLock.release();
    } catch (lockError) {
      failures.push(lockError);
    }
    if (failures.length === 1) throw error;
    throw new AggregateError(failures, 'OpenProjects startup failed and cleanup was incomplete');
  }
}

function createModelAdapter(
  config: AppConfig,
  storage: SqliteStorage,
  networkPolicy: OutboundNetworkPolicy,
) {
  if (config.routing?.routes.length) {
    return createModelRouter(config.routing, storage, { id: config.model.provider, networkPolicy });
  }
  if (config.model.provider === 'mock') return new ProjectOpsFixtureModel();
  if (config.model.provider === 'mlx-lm') {
    if (config.model.apiKey) throw new Error('MLX-LM does not accept an API key; protect its loopback process boundary');
    if (!config.model.baseUrl) throw new Error('model.baseUrl is required for provider mlx-lm');
    return new MlxLmAdapter({
      id: config.model.provider,
      baseUrl: config.model.baseUrl,
      networkPolicy,
    });
  }
  if (config.model.provider === 'llama.cpp') {
    if (!config.model.apiKey) {
      throw new Error('model.apiKey is required for provider llama.cpp');
    }
    if (!config.model.baseUrl) throw new Error('model.baseUrl is required for provider llama.cpp');
    return new LlamaCppAdapter({
      id: config.model.provider,
      baseUrl: config.model.baseUrl,
      apiKey: config.model.apiKey,
      modelAlias: config.model.model,
      networkPolicy,
    });
  }
  if (config.model.provider === 'freetoken') {
    if (config.model.apiKey) {
      throw new Error('FreeToken does not accept an API key; protect its loopback process boundary');
    }
    if (!config.model.baseUrl) throw new Error('model.baseUrl is required for provider freetoken');
    return new FreeTokenAdapter({
      id: config.model.provider,
      baseUrl: config.model.baseUrl,
      modelAlias: config.model.model,
      networkPolicy,
    });
  }
  if (!config.model.apiKey && !isLoopbackUrl(config.model.baseUrl)) {
    throw new Error(
      `OPENPROJECTS_MODEL_API_KEY is required for provider ${config.model.provider}. ` +
        'Use model.provider: mock for the credential-free demo.',
    );
  }
  if (!config.model.baseUrl) {
    throw new Error(`model.baseUrl is required for provider ${config.model.provider}`);
  }
  return new OpenAICompatibleAdapter({
    id: config.model.provider,
    baseUrl: config.model.baseUrl,
    ...(config.model.apiKey ? { apiKey: config.model.apiKey } : {}),
    networkPolicy,
  });
}

function validateOutboundConfiguration(
  config: AppConfig,
  networkPolicy: OutboundNetworkPolicy,
): void {
  if (config.routing?.routes.length) {
    for (const route of config.routing.routes.filter((item) => item.enabled && item.provider !== 'mock')) {
      if (!route.baseUrl) {
        throw new Error(`Model route ${route.id} requires an OpenAI-compatible baseUrl`);
      }
      if (route.provider === 'mlx-lm') {
        if (!route.local) throw new Error(`MLX-LM route ${route.id} must declare local: true`);
        if (route.apiKey || route.apiKeyEnv) {
          throw new Error(`MLX-LM route ${route.id} must not configure an API key`);
        }
        validateMlxLmBaseUrl(route.baseUrl);
      }
      if (route.provider === 'llama.cpp') {
        if (!route.local) throw new Error(`llama.cpp route ${route.id} must declare local: true`);
        if (!route.apiKey && !route.apiKeyEnv) {
          throw new Error(`llama.cpp route ${route.id} requires a dedicated API key`);
        }
        validateLlamaCppBaseUrl(route.baseUrl);
      }
      if (route.provider === 'freetoken') {
        if (!route.local) throw new Error(`FreeToken route ${route.id} must declare local: true`);
        if (route.apiKey || route.apiKeyEnv) {
          throw new Error(`FreeToken route ${route.id} must not configure an API key`);
        }
        validateFreeTokenBaseUrl(route.baseUrl);
      }
      if (!['mlx-lm', 'llama.cpp', 'freetoken'].includes(route.provider)) {
        const normalized = validateApiBaseUrl(route.baseUrl, `Model route ${route.id}`);
        const loopback = isLoopbackUrl(normalized);
        if (route.local !== loopback) {
          throw new Error(
            `Model route ${route.id} local=${String(route.local)} does not match its baseUrl boundary`,
          );
        }
        if (!loopback) {
          if (config.routing.externalInference !== 'allow') {
            throw new Error(
              `Model route ${route.id} requires routing.externalInference: allow`,
            );
          }
          if (route.apiKey) {
            throw new Error(
              `Model route ${route.id} must use apiKeyEnv instead of an inline external API key`,
            );
          }
          if (!route.apiKeyEnv) {
            throw new Error(`Model route ${route.id} requires apiKeyEnv outside loopback`);
          }
          requireCredentialEnvironment(route.apiKeyEnv, `Model route ${route.id}`);
        }
      }
      networkPolicy.assertAllowed(route.baseUrl, `model route ${route.id}`);
    }
  } else if (config.model.provider !== 'mock') {
    if (!config.model.baseUrl) {
      throw new Error(`model.baseUrl is required for provider ${config.model.provider}`);
    }
    if (config.model.provider === 'mlx-lm') {
      if (config.model.apiKey) throw new Error('MLX-LM must not configure an API key');
      validateMlxLmBaseUrl(config.model.baseUrl);
    }
    if (config.model.provider === 'llama.cpp') {
      if (!config.model.apiKey) throw new Error('llama.cpp must configure a dedicated API key');
      validateLlamaCppBaseUrl(config.model.baseUrl);
    }
    if (config.model.provider === 'freetoken') {
      if (config.model.apiKey) throw new Error('FreeToken must not configure an API key');
      validateFreeTokenBaseUrl(config.model.baseUrl);
    }
    if (!isLoopbackUrl(config.model.baseUrl)
      && !['mlx-lm', 'llama.cpp', 'freetoken'].includes(config.model.provider)) {
      throw new Error(
        'External model providers must use routing.routes with externalInference: allow and apiKeyEnv',
      );
    }
    networkPolicy.assertAllowed(config.model.baseUrl, `model provider ${config.model.provider}`);
  }

  if (config.embeddings?.provider === 'ollama') {
    const baseUrl = config.embeddings.baseUrl ?? 'http://127.0.0.1:11434';
    if (!isLoopbackUrl(baseUrl)) {
      throw new Error('Ollama embeddings are local-only; use provider openai-compatible for external embeddings');
    }
    networkPolicy.assertAllowed(
      baseUrl,
      `embedding provider ${config.embeddings.model}`,
    );
  }
  if (config.embeddings?.provider === 'openai-compatible') {
    if (!config.embeddings.baseUrl) {
      throw new Error('OpenAI-compatible embeddings require baseUrl');
    }
    const baseUrl = validateApiBaseUrl(
      config.embeddings.baseUrl,
      'OpenAI-compatible embedding',
    );
    if (!isLoopbackUrl(baseUrl)) {
      if (config.embeddings.externalData !== 'allow') {
        throw new Error('External embeddings require embeddings.externalData: allow');
      }
      if (!config.embeddings.apiKeyEnv) {
        throw new Error('External embeddings require apiKeyEnv');
      }
      requireCredentialEnvironment(
        config.embeddings.apiKeyEnv,
        'External embedding provider',
      );
    }
    networkPolicy.assertAllowed(baseUrl, `embedding provider ${config.embeddings.model}`);
  }

  if (config.telegram?.enabled === true) {
    networkPolicy.assertAllowed(
      process.env.TELEGRAM_API_BASE_URL ?? config.telegram.apiBaseUrl,
      'Telegram API',
    );
  }
}

function requireCredentialEnvironment(name: string, label: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${label} requires a non-empty ${name} environment credential`);
  }
  if (value.length > 4_096 || !/^[\x21-\x7e]+$/u.test(value)) {
    throw new Error(`${label} environment credential must contain only visible ASCII characters`);
  }
  return value;
}

function isLoopbackUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    return isLoopbackHostname(new URL(value).hostname);
  } catch {
    return false;
  }
}

function validateComposition(
  config: AppConfig,
  skills: SkillDefinition[],
  kernel: HarnessKernel,
  mode: NonNullable<CreateAppOptions['mode']>,
): void {
  if (mode === 'full') {
    const missingSkills = config.agent.skills.filter((id) => !skills.some((skill) => skill.id === id));
    if (missingSkills.length) throw new Error(`Agent references missing skills: ${missingSkills.join(', ')}`);
    const missingTools = config.agent.tools.filter((name) => !kernel.tool(name));
    if (missingTools.length) throw new Error(`Agent references missing tools: ${missingTools.join(', ')}`);
    for (const skill of skills.filter((item) => config.agent.skills.includes(item.id))) {
      const outsideGrant = skill.tools.filter((tool) => !config.agent.tools.includes(tool));
      if (outsideGrant.length) {
        throw new Error(`Skill ${skill.id} requests tools outside the agent grant: ${outsideGrant.join(', ')}`);
      }
    }
  }
  const missingSpecialistTools = PROJECT_ANALYST_AGENT.tools.filter((name) => !kernel.tool(name));
  if (missingSpecialistTools.length) {
    throw new Error(`Project analyst references missing tools: ${missingSpecialistTools.join(', ')}`);
  }
  for (const name of PROJECT_ANALYST_AGENT.tools) {
    const tool = kernel.tool(name)!;
    if (tool.effect !== 'read' || tool.idempotency !== 'read') {
      throw new Error(`Project analyst tool ${name} must be read-only and replay-safe`);
    }
  }
  const requiredTask = mode === 'project-analyst' ? 'project_analysis' : 'supervisor';
  const minimumQuality = mode === 'project-analyst' ? 0.55 : 0.65;
  if (config.routing?.routes.length && !config.routing.routes.some(
    (route) => route.enabled && route.tasks.includes(requiredTask) && route.quality >= minimumQuality,
  )) {
    throw new Error(`At least one enabled model route with ${requiredTask} quality >= ${minimumQuality} is required`);
  }
}
