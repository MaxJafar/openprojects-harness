import { chmod, link, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadConfig, validateResourceProfile } from '../src/config.js';
import { createApp } from '../src/app.js';
import {
  buildWizardPlan,
  collectWizardAnswers,
  createDefaultWizardAnswers,
  detectHardware,
  recommendLocalModel,
  recommendMlxModel,
  renderPlanLines,
  runInstallationWizard,
  validateWizardYaml,
  writeWizardConfig,
  type ConfirmPrompt,
  type HardwareInfo,
  type InputPrompt,
  type SelectPrompt,
  type WizardAnswers,
  type WizardIO,
} from '../src/wizard/index.js';

const cleanupPaths = new Set<string>();

afterEach(async () => {
  for (const path of cleanupPaths) await rm(path, { recursive: true, force: true });
  cleanupPaths.clear();
});

describe('installation wizard hardware planning', () => {
  it('keeps the checked-in core 4 GB example loadable and capability-reduced', () => {
    const config = loadConfig('examples/openprojects.core-4g.yaml', {
      loadEnv: false,
      applyProcessEnvOverrides: false,
    });

    expect(config.resources).toEqual({
      profile: 'core-4g-v1',
      maxRetrievedContextCharacters: 1_024,
    });
    expect(config.agent.tools).toHaveLength(4);
    expect(config.routing?.routes).toEqual([]);
    expect(config.integrations).toBeUndefined();
    expect(config.learning?.enabled).toBe(false);
    expect(config.transcription?.provider).toBe('disabled');
  });

  it('detects hardware through an injectable probe and recommends a conservative local model', () => {
    const hardware = detectHardware({
      platform: () => 'darwin',
      architecture: () => 'arm64',
      logicalCpus: () => Array.from({ length: 8 }, () => ({ model: 'Apple M3' })),
      totalMemoryBytes: () => 8 * 1024 ** 3,
    });

    expect(hardware).toMatchObject({
      platform: 'darwin',
      architecture: 'arm64',
      logicalCpuCount: 8,
      cpuModel: 'Apple M3',
      memoryGiB: 8,
      acceleration: 'apple-silicon',
    });
    expect(recommendLocalModel(hardware)).toMatchObject({
      model: 'qwen3.5:2b',
      parameterClass: '2B Q4',
      minimumMemoryGiB: 6,
    });
    expect(recommendLocalModel({ ...hardware, memoryGiB: 32 }).model).toBe('qwen3.5:9b');
    expect(recommendMlxModel(hardware)).toMatchObject({
      model: 'mlx-community/Qwen3-1.7B-4bit',
      contextWindow: 8_192,
    });
    expect(recommendMlxModel({ ...hardware, memoryGiB: 16 }).model)
      .toBe('mlx-community/Qwen3-4B-Instruct-2507-4bit');
  });

  it('generates a bounded core harness on a 4 GiB machine without claiming a live model is eligible', async () => {
    const hardware = lowMemoryHardware();
    const boundaryHardware = {
      ...hardware,
      memoryBytes: 4.5 * 1024 ** 3,
      memoryGiB: 4.5,
    };
    const boundaryPlan = buildWizardPlan(createDefaultWizardAnswers(boundaryHardware), {
      hardware: boundaryHardware,
      recommendation: recommendMlxModel(boundaryHardware),
    });
    expect(boundaryPlan.config.resources?.profile).toBe('core-4g-v1');
    const result = await runInstallationWizard({
      acceptDefaults: true,
      dryRun: true,
      hardware,
    });

    expect(result.status).toBe('planned');
    expect(result.plan.recommendation.minimumMemoryGiB).toBeGreaterThan(hardware.memoryGiB);
    expect(result.plan.config).toMatchObject({
      resources: {
        profile: 'core-4g-v1',
        maxRetrievedContextCharacters: 1_024,
      },
      agent: {
        skills: [],
        tools: ['project_list', 'project_get', 'project_risk_report', 'memory_search'],
        budgets: {
          maxSteps: 3,
          maxToolCalls: 4,
          maxWallTimeMs: 45_000,
          maxInputTokens: 2_048,
          reservedOutputTokens: 512,
        },
      },
      privacy: { localOnly: true, allowedOrigins: [] },
      telegram: { enabled: false },
      model: { provider: 'mock', model: 'core-harness-fixture-v1' },
      routing: { dailyBudgetUsd: 0, explorationRate: 0, routes: [] },
      memory: { retrievalLimit: 2, maxContextCharacters: 512 },
      learning: { enabled: false, groupObservation: false },
      embeddings: { provider: 'builtin', model: 'builtin-hash-v1', dimensions: 256 },
      transcription: { provider: 'disabled' },
      notifications: { enabled: false },
      subagents: { maxCallsPerRun: 0, maxParallel: 1, maxDepth: 0 },
    });
    expect(result.plan.config.integrations).toBeUndefined();
    expect(result.plan.yaml).not.toContain('mlx-community/');
    expect(result.plan.nextSteps.join('\n')).not.toMatch(/mlx_lm server|ollama pull|openprojects qualify/u);
    expect(result.plan.warnings.join('\n')).toContain('no live model runtime is configured');
    expect(result.plan.manualActions.join('\n')).toContain('core harness readiness only');
    const lines = renderPlanLines(result.plan, true).join('\n');
    expect(lines).toContain('no live runtime provisioned; deterministic core harness fixture only');
    expect(lines).toContain('Resources: core-4g-v1');
    expect(lines).not.toContain('Model endpoint: undefined');
    expect(() => validateWizardYaml(result.plan.yaml)).not.toThrow();
    expect(loadConfig('/tmp/openprojects-core-4g.yaml', {
      sourceText: result.plan.yaml,
      loadEnv: false,
      applyProcessEnvOverrides: false,
    }).resources).toEqual({
      profile: 'core-4g-v1',
      maxRetrievedContextCharacters: 1_024,
    });
    const configuredIntegration = `${result.plan.yaml}\nintegrations:\n  externalDataPolicy: deny\n  manifests:\n    - /tmp/reviewed-integration.yaml\n`;
    expect(() => loadConfig('/tmp/openprojects-core-4g.yaml', {
      sourceText: configuredIntegration,
      loadEnv: false,
      applyProcessEnvOverrides: false,
    })).toThrow('does not permit configured integrations');

    await expect(createApp({
      config: {
        ...result.plan.config,
        model: {
          provider: 'openai-compatible',
          model: 'unqualified-live-model',
          baseUrl: 'http://127.0.0.1:8080/v1',
        },
      },
      databasePath: ':memory:',
    })).rejects.toThrow('live model routes require a separate resource gate');

    const app = await createApp({
      config: result.plan.config,
      databasePath: ':memory:',
      seedDemo: false,
    });
    await app.close();
  });

  it('skips runtime and optional-feature questions in the interactive 4 GiB flow', async () => {
    const io = new ScriptedIO({});
    const answers = await collectWizardAnswers(io, lowMemoryHardware());

    expect(answers).toMatchObject({
      profile: 'private-local',
      backend: 'mlx-lm',
      telegramEnabled: false,
      transcriptionEnabled: false,
    });
    expect(io.selectPrompts).not.toContain('profile');
    expect(io.selectPrompts).not.toContain('backend');
    expect(io.inputPrompts).not.toEqual(expect.arrayContaining([
      'model-base-url',
      'model',
      'context-window',
      'mlx-model-path',
    ]));
    expect(io.confirmPrompts).not.toEqual(expect.arrayContaining(['telegram', 'transcription']));
    expect(io.output.join('\n')).toContain('No bundled local model is eligible');
    expect(io.output.join('\n')).toContain('live model runtime questions are skipped');
    expect(io.output.join('\n')).not.toContain('Recommended local model:');
  });

  it('enforces core-4g disabled-feature invariants for programmatic createApp configs', async () => {
    const plan = buildWizardPlan(
      createDefaultWizardAnswers(lowMemoryHardware()),
      {
        hardware: lowMemoryHardware(),
        recommendation: recommendMlxModel(lowMemoryHardware()),
      },
    );
    const mutations: Array<(config: typeof plan.config) => void> = [
      (config) => { config.integrations = { externalDataPolicy: 'deny', manifests: ['/tmp/reviewed.yaml'] }; },
      (config) => { config.telegram!.enabled = true; },
      (config) => { config.learning!.enabled = true; },
      (config) => { config.learning!.groupObservation = true; },
      (config) => { config.notifications!.enabled = true; },
      (config) => { config.transcription!.provider = 'whisper-cpp'; },
      (config) => { config.subagents!.maxCallsPerRun = 1; },
      (config) => { config.privacy!.allowedOrigins = ['https://models.example.test']; },
      (config) => {
        config.embeddings = {
          provider: 'ollama',
          model: 'embedding-model',
          dimensions: 256,
          timeoutMs: 3_000,
        };
      },
    ];

    for (const mutate of mutations) {
      const invalid = structuredClone(plan.config);
      mutate(invalid);
      expect(() => validateResourceProfile(invalid)).toThrow(/core-4g-v1/u);
      await expect(createApp({ config: invalid, databasePath: ':memory:', seedDemo: false }))
        .rejects.toThrow(/core-4g-v1/u);
    }
  });

  it('provides a deterministic headless defaults dry-run with no filesystem mutation', async () => {
    const directory = await temporaryDirectory();
    const configPath = join(directory, 'sealed.yaml');

    const result = await runInstallationWizard({
      acceptDefaults: true,
      dryRun: true,
      cwd: directory,
      hardware: fixtureHardware(),
      paths: { config: 'sealed.yaml', database: './state/openprojects.db' },
    });

    expect(result.status).toBe('planned');
    expect(result.plan).toMatchObject({
      profile: 'private-local',
      backend: 'mlx-lm',
      configPath,
      config: {
        server: {
          socketPath: './data/control.sock',
          auth: {
            principals: [{ id: 'local-admin', capabilities: ['admin'] }],
          },
        },
        privacy: { localOnly: true, allowedOrigins: [] },
        telegram: { enabled: false },
        policy: { external_write: 'deny' },
      },
    });
    expect(result.plan.yaml).toContain('provider: mlx-lm');
    expect(result.plan.yaml).toContain('model: mlx-community/Qwen3-4B-Instruct-2507-4bit');
    expect(result.plan.nextSteps.join('\n')).toContain("--model './models/mlx-model'");
    expect(result.plan.nextSteps.join('\n')).not.toContain('mlx-community/');
    expect(result.plan.nextSteps.join('\n')).toContain('openprojects qualify --config');
    expect(result.plan.nextSteps.join('\n')).toContain('--manifest');
    expect(result.plan.nextSteps.join('\n')).toContain('replace every fail-closed hash placeholder');
    expect(result.plan.manualActions.join('\n')).toContain('outside this wizard');
    expect(result.plan.manualActions.join('\n')).toContain('servedModelId is the exact canonical MLX /v1/models local path');
    await expect(lstat(configPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(() => validateWizardYaml(result.plan.yaml)).not.toThrow();
    expect(result.plan.yaml).not.toMatch(/\u001b\[/);
    await expect(lstat(join(directory, 'data', 'control.token'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('emits a Windows-native TCP and PowerShell plan without claiming chmod proves NTFS isolation', async () => {
    const hardware: HardwareInfo = {
      platform: 'win32',
      architecture: 'x64',
      logicalCpuCount: 4,
      cpuModel: 'Windows fixture CPU',
      memoryBytes: 8 * 1024 ** 3,
      memoryGiB: 8,
      acceleration: 'cpu',
    };
    const result = await runInstallationWizard({
      acceptDefaults: true,
      dryRun: true,
      hardware,
      backend: 'ollama',
      paths: { config: "operator's config.yaml" },
    });

    expect(result.plan.config.server.socketPath).toBeUndefined();
    expect(result.plan.nextSteps).toContain("$env:OLLAMA_NO_CLOUD='1'; ollama serve");
    expect(result.plan.nextSteps.join('\n')).toContain("operator''s config.yaml'");
    expect(result.plan.warnings.join('\n')).toContain('cannot verify owner-only NTFS ACLs');
    expect(result.plan.manualActions.join('\n')).toContain('Get-Acl or icacls');
    expect(renderPlanLines(result.plan, true).join('\n')).toContain('NTFS ACL verification required');

    const llamaPlan = buildWizardPlan({
      ...baseAnswers(),
      backend: 'llama-cpp',
      configPath: resolve('Program Files', 'OpenProjects', 'openprojects.yaml'),
      model: 'granite-4.0-350m-q8@9595dafb',
      baseUrl: 'http://127.0.0.1:18080/v1',
      apiKeyEnv: 'OPENPROJECTS_LLAMA_API_KEY',
      llamaModelPath: './models/granite-4.0-350m-Q8_0.gguf',
      contextWindow: 3_072,
    }, {
      hardware,
      recommendation: recommendLocalModel(hardware),
    });
    const windowsLaunch = llamaPlan.nextSteps.find((step) => step.includes('--model'));
    expect(windowsLaunch).toMatch(/^& '.*llama-server\.exe' --model /u);

    expect(() => buildWizardPlan({
      ...createDefaultWizardAnswers(hardware),
      controlSocketPath: '.\\data\\control.sock',
    }, {
      hardware,
      recommendation: recommendLocalModel(hardware),
    })).toThrow('Unix control sockets are unavailable');
  });

  it('allows operators to force core-4g-v1 on a larger machine', async () => {
    const result = await runInstallationWizard({
      acceptDefaults: true,
      dryRun: true,
      core4g: true,
      hardware: fixtureHardware(),
    });

    expect(result.plan.config.resources).toEqual({
      profile: 'core-4g-v1',
      maxRetrievedContextCharacters: 1_024,
    });
    expect(result.plan.config.model).toEqual({
      provider: 'mock',
      model: 'core-harness-fixture-v1',
    });
    expect(result.plan.config.routing?.routes).toEqual([]);
    expect(result.plan.warnings.join('\n')).toContain('selected explicitly');
    expect(result.plan.warnings.join('\n')).not.toContain('machine is below');
  });

  it('keeps the M3 8 GB MLX plan inside its route budget and on one worker', () => {
    const hardware = { ...fixtureHardware(), memoryBytes: 8 * 1024 ** 3, memoryGiB: 8 };
    const recommendation = recommendMlxModel(hardware);
    const plan = buildWizardPlan({
      ...baseAnswers(),
      backend: 'mlx-lm',
      model: recommendation.model,
      baseUrl: 'http://127.0.0.1:8080/v1',
      contextWindow: recommendation.contextWindow,
      mlxModelPath: './models/qwen3-1.7b-reviewed-snapshot',
    }, { hardware, recommendation });

    const route = plan.config.routing?.routes[0];
    const budgets = plan.config.agent.budgets;
    expect(recommendation).toMatchObject({
      model: 'mlx-community/Qwen3-1.7B-4bit',
      contextWindow: 8_192,
    });
    expect(route?.contextWindow).toBe(8_192);
    expect(budgets).toMatchObject({
      maxInputTokens: 4_000,
      reservedOutputTokens: 1_024,
    });
    expect(budgets.maxInputTokens + budgets.reservedOutputTokens)
      .toBeLessThanOrEqual(route?.contextWindow ?? 0);
    expect(plan.config.memory).toEqual({
      retrievalLimit: 3,
      maxContextCharacters: 1_000,
    });
    expect(plan.config.subagents).toEqual({
      maxCallsPerRun: 2,
      maxParallel: 1,
      maxDepth: 1,
    });
    const launch = plan.nextSteps.find((step) => step.includes('-m mlx_lm server')) ?? '';
    expect(launch).toContain('--decode-concurrency 1 --prompt-concurrency 1');
  });

  it('requires explicit interaction before a headless plan can write', async () => {
    await expect(runInstallationWizard({
      acceptDefaults: true,
      hardware: fixtureHardware(),
    })).rejects.toThrow('Headless defaults may only be used with dryRun');
  });
});

describe('installation wizard privacy boundaries', () => {
  it('rejects a remote endpoint and Telegram in the sealed private-local profile', () => {
    expect(() => buildWizardPlan({
      ...baseAnswers(),
      baseUrl: 'https://models.example.test/v1',
    }, planOptions())).toThrow('private-local profile requires a loopback model endpoint');

    expect(() => buildWizardPlan({
      ...baseAnswers(),
      telegramEnabled: true,
    }, planOptions())).toThrow('Telegram cannot be enabled');
  });

  it('allowlists explicit hybrid origins, writes only an API-key env name, and warns about Telegram', () => {
    const plan = buildWizardPlan({
      ...baseAnswers(),
      profile: 'hybrid',
      backend: 'openai-compatible',
      baseUrl: 'https://models.corp.example:8443/v1',
      model: 'reviewed-corporate-model',
      apiKeyEnv: 'CORPORATE_LLM_API_KEY',
      telegramEnabled: true,
    }, planOptions());

    expect(plan.config.privacy).toEqual({
      localOnly: true,
      allowedOrigins: [
        'https://models.corp.example:8443',
        'https://api.telegram.org',
      ],
    });
    expect(plan.config.routing?.routes[0]).toMatchObject({
      apiKeyEnv: 'CORPORATE_LLM_API_KEY',
      local: false,
    });
    expect(plan.yaml).toContain('apiKeyEnv: CORPORATE_LLM_API_KEY');
    expect(plan.yaml).not.toMatch(/^\s*apiKey:/m);
    expect(plan.warnings.join('\n')).toContain('Telegram is external SaaS');
    expect(plan.warnings.join('\n')).toContain('not an air-gapped deployment');
    expect(plan.warnings.join('\n')).toContain('TLS reverse proxy');
    expect(plan.nextSteps.join('\n')).toContain('forward only POST /webhooks/telegram');

    expect(() => buildWizardPlan({
      ...baseAnswers(),
      profile: 'hybrid',
      telegramEnabled: true,
      controlSocketPath: './data/control.sock',
    }, planOptions())).toThrow('cannot share the private Unix control socket');
  });

  it('rejects credentials in URLs and invalid environment variable names', () => {
    expect(() => buildWizardPlan({
      ...baseAnswers(),
      profile: 'hybrid',
      backend: 'openai-compatible',
      baseUrl: 'https://user:secret@models.example.test/v1',
    }, planOptions())).toThrow('must not contain credentials');
    expect(() => buildWizardPlan({
      ...baseAnswers(),
      profile: 'hybrid',
      backend: 'openai-compatible',
      baseUrl: 'https://models.example.test/v1',
      apiKeyEnv: 'actual-secret-value',
    }, planOptions())).toThrow('must match [A-Z_][A-Z0-9_]*');
    expect(() => buildWizardPlan({
      ...baseAnswers(),
      profile: 'hybrid',
      baseUrl: 'https://ollama.example.test/v1',
    }, planOptions())).toThrow('ollama is a local runtime and requires a loopback endpoint');
  });

  it('rejects a filesystem root even through headless path overrides', () => {
    expect(() => buildWizardPlan({
      ...baseAnswers(),
      configPath: '/',
    }, planOptions())).toThrow('config path must not target a filesystem root');
  });

  it('builds a text/tool-only MLX plan around a pinned local snapshot without request-time downloads', () => {
    const recommendation = recommendMlxModel(fixtureHardware());
    const plan = buildWizardPlan({
      ...baseAnswers(),
      backend: 'mlx-lm',
      model: recommendation.model,
      baseUrl: 'http://127.0.0.1:8080/v1',
      contextWindow: recommendation.contextWindow,
      mlxModelPath: './models/qwen3-4b-reviewed-snapshot',
    }, {
      hardware: fixtureHardware(),
      recommendation,
    });

    expect(plan.config.model).toEqual({
      provider: 'mlx-lm',
      model: 'mlx-community/Qwen3-4B-Instruct-2507-4bit',
      baseUrl: 'http://127.0.0.1:8080/v1',
    });
    expect(plan.config.routing?.routes[0]).toMatchObject({
      id: 'local-mlx-lm',
      provider: 'mlx-lm',
      local: true,
      inputCostPerMillion: 0,
      outputCostPerMillion: 0,
    });
    const cacheStep = plan.nextSteps.find((step) => step.startsWith('install -d -m 0700')) ?? '';
    const launch = plan.nextSteps.find((step) => step.includes('-m mlx_lm server')) ?? '';
    expect(cacheStep).toContain('cache/huggingface/hub');
    expect(launch).toContain('HF_HUB_OFFLINE=1');
    expect(launch).toContain('TRANSFORMERS_OFFLINE=1');
    expect(launch).toContain('HF_HUB_CACHE=');
    expect(launch).toContain("'python3' -I -m mlx_lm server");
    expect(launch).toContain("--model './models/qwen3-4b-reviewed-snapshot'");
    expect(launch).toContain('--host 127.0.0.1 --port 8080 --decode-concurrency 1 --prompt-concurrency 1 --prompt-cache-size 1 --prompt-cache-bytes 268435456');
    expect(launch).not.toContain('mlx-community/');
    expect(launch).not.toContain('--trust-remote-code');
    expect(plan.warnings.join('\n')).toContain('text/tool-only');
    expect(plan.warnings.join('\n')).toContain('basic security');
    expect(plan.config.embeddings?.provider).toBe('builtin');
    expect(plan.config.agent.budgets).toMatchObject({
      maxInputTokens: 24_000,
      reservedOutputTokens: 4_096,
    });
    expect(plan.config.memory).toEqual({
      retrievalLimit: 6,
      maxContextCharacters: 8_000,
    });
    expect(plan.config.subagents).toEqual({
      maxCallsPerRun: 4,
      maxParallel: 2,
      maxDepth: 1,
    });
  });

  it('rejects MLX on non-Apple hardware and non-official endpoint shapes', () => {
    const answers: WizardAnswers = {
      ...baseAnswers(),
      backend: 'mlx-lm',
      model: 'reviewed-model',
      baseUrl: 'http://127.0.0.1:8080/v1',
      mlxModelPath: './models/reviewed',
    };
    expect(() => buildWizardPlan(answers, {
      hardware: { ...fixtureHardware(), platform: 'linux', architecture: 'x64', acceleration: 'cpu' },
      recommendation: recommendLocalModel(fixtureHardware()),
    })).toThrow('requires macOS on Apple Silicon');
    expect(() => buildWizardPlan({ ...answers, baseUrl: 'https://127.0.0.1:8080/v1' }, planOptions()))
      .toThrow('loopback HTTP');
    expect(() => buildWizardPlan({ ...answers, baseUrl: 'http://127.0.0.1:8080/api/v1' }, planOptions()))
      .toThrow('path must be /v1');
  });

  it('rejects terminal-control and bidi text in operator-supplied paths and model names', () => {
    expect(() => buildWizardPlan({
      ...baseAnswers(),
      configPath: './safe\u001b]52;c;payload\u0007.yaml',
    }, planOptions())).toThrow('config path contains forbidden control characters');
    expect(() => buildWizardPlan({
      ...baseAnswers(),
      model: 'qwen\u202emodel',
    }, planOptions())).toThrow('model contains forbidden control characters');
  });

  it('collects hybrid choices through injected IO and retries invalid non-secret input', async () => {
    const io = new ScriptedIO({
      selections: {
        profile: ['hybrid'],
        backend: ['openai-compatible'],
      },
      inputs: {
        'model-base-url': ['https://models.corp.example/v1'],
        model: ['corp-model'],
        'api-key-env': ['not-a-valid-name', 'CORP_MODEL_API_KEY'],
        'config-path': ['./corp.yaml'],
        'database-path': ['./data/corp.db'],
      },
      confirmations: {
        telegram: [true],
        transcription: [false],
      },
    });

    const answers = await collectWizardAnswers(io, fixtureHardware());

    expect(answers).toMatchObject({
      profile: 'hybrid',
      backend: 'openai-compatible',
      apiKeyEnv: 'CORP_MODEL_API_KEY',
      telegramEnabled: true,
      transcriptionEnabled: false,
    });
    expect(answers.controlSocketPath).toBeUndefined();
    expect(io.output.join('\n')).toContain('Telegram is external SaaS');
    expect(io.output.join('\n')).toContain('reviewed TLS reverse proxy');
    expect(io.output.join('\n')).toContain('Invalid value:');
    expect(io.output.join('\n')).not.toMatch(/\u001b\[/);
  });

  it('retries an invalid menu selection instead of aborting the wizard', async () => {
    const io = new ScriptedIO({
      selections: { profile: ['not-a-profile', 'private-local'], backend: ['ollama'] },
      confirmations: { transcription: [false] },
    });
    const answers = await collectWizardAnswers(io, fixtureHardware());
    expect(answers.profile).toBe('private-local');
    expect(io.output.join('\n')).toContain('Invalid selection for profile');
  });

  it('requires an environment-variable credential reference for every remote model route', () => {
    expect(() => buildWizardPlan({
      ...baseAnswers(),
      profile: 'hybrid',
      backend: 'openai-compatible',
      baseUrl: 'https://models.example.test/v1',
    }, planOptions())).toThrow('requires an apiKeyEnv name');
  });

  it('requires encrypted transport for a remote model endpoint', () => {
    expect(() => buildWizardPlan({
      ...baseAnswers(),
      profile: 'hybrid',
      backend: 'openai-compatible',
      baseUrl: 'http://models.example.test/v1',
      apiKeyEnv: 'CORPORATE_MODEL_API_KEY',
    }, planOptions())).toThrow('remote OpenAI-compatible endpoint must use HTTPS');
  });

  it('composes runtime routes for the same IPv4 and IPv6 loopback range accepted by privacy policy', async () => {
    for (const baseUrl of ['http://127.0.0.2:11434/v1', 'http://[::1]:11434/v1']) {
      const plan = buildWizardPlan({ ...baseAnswers(), baseUrl }, planOptions());
      const app = await createApp({ config: plan.config, databasePath: ':memory:', seedDemo: false });
      await app.close();
    }
  });

  it('keeps model routing independent from the lightweight embedding default', () => {
    const plan = buildWizardPlan({
      ...baseAnswers(),
      baseUrl: 'http://127.0.0.1:8080/corporate/ollama/v1',
    }, planOptions());
    expect(plan.config.model.baseUrl).toBe('http://127.0.0.1:8080/corporate/ollama/v1');
    expect(plan.config.embeddings).toEqual({
      provider: 'builtin',
      model: 'builtin-hash-v1',
      dimensions: 256,
      timeoutMs: 3_000,
    });
  });

  it('renders an authenticated one-slot offline llama.cpp boundary with a pinned alias', () => {
    const plan = buildWizardPlan({
      ...baseAnswers(),
      backend: 'llama-cpp',
      model: 'granite-4.0-350m-q8@9595dafb',
      baseUrl: 'http://127.0.0.1:18080/v1',
      apiKeyEnv: 'OPENPROJECTS_LLAMA_API_KEY',
      llamaModelPath: './models/granite-4.0-350m-Q8_0.gguf',
      contextWindow: 3_072,
    }, planOptions());

    expect(plan.config.model).toMatchObject({
      provider: 'llama.cpp',
      model: 'granite-4.0-350m-q8@9595dafb',
      baseUrl: 'http://127.0.0.1:18080/v1',
    });
    expect(plan.config.routing?.routes[0]).toMatchObject({
      provider: 'llama.cpp',
      apiKeyEnv: 'OPENPROJECTS_LLAMA_API_KEY',
      tasks: ['project_analysis'],
      local: true,
    });
    const steps = plan.nextSteps.join('\n');
    const launch = plan.nextSteps.find((step) => step.includes('--model'));
    expect(launch?.trim().split(/\s+/u)).toHaveLength(53);
    expect(launch).toMatch(/^'\/.*\/bin\/llama-server' --model /u);
    expect(steps).toContain(resolve(process.cwd(), 'bin/llama-server'));
    expect(steps).toContain(resolve(process.cwd(), 'models/granite-4.0-350m-Q8_0.gguf'));
    expect(steps).toContain('--offline');
    expect(steps).toContain('--api-key-file');
    expect(steps).toContain('--parallel 1');
    expect(steps).toContain('--no-cont-batching');
    expect(steps).toContain('--no-agent');
    expect(steps).toContain('--no-ui-mcp-proxy');
    expect(steps).toContain('--device none');
    expect(steps).toContain('--gpu-layers 0');
    expect(steps).toContain('--cache-ram 64');
    expect(steps).toContain('eval-local-4gb');
    expect(steps).toContain('does not authorize a supervisor route');
    expect(steps).not.toContain('Start the sole runtime owner');
    expect(steps).not.toContain('--hf-repo');
  });

  it('rejects an unauthenticated or request-switchable llama.cpp wizard route', () => {
    const candidate = {
      ...baseAnswers(),
      backend: 'llama-cpp' as const,
      model: 'granite-4.0-350m-q8@9595dafb',
      baseUrl: 'http://127.0.0.1:18080/v1',
      llamaModelPath: './models/granite-4.0-350m-Q8_0.gguf',
      contextWindow: 3_072,
    };
    expect(() => buildWizardPlan(candidate, planOptions())).toThrow('requires an apiKeyEnv');
    expect(() => buildWizardPlan({
      ...candidate,
      model: '../request-selected-model',
      apiKeyEnv: 'OPENPROJECTS_LLAMA_API_KEY',
    }, planOptions())).toThrow('safe identifier');
    expect(() => buildWizardPlan({
      ...candidate,
      apiKeyEnv: 'OPENPROJECTS_LLAMA_API_KEY',
      contextWindow: 4_096,
    }, planOptions())).toThrow('no larger than 3072');
    expect(() => buildWizardPlan({
      ...candidate,
      apiKeyEnv: 'OPENPROJECTS_LLAMA_API_KEY',
      baseUrl: 'http://127.0.0.1/v1',
    }, planOptions())).toThrow('explicit loopback port');
  });

  it('uses the lightweight embedding default and includes privacy and storage guidance', async () => {
    const result = await runInstallationWizard({
      acceptDefaults: true,
      dryRun: true,
      hardware: fixtureHardware(),
      backend: 'ollama',
    });
    const lines = renderPlanLines(result.plan, true).join('\n');
    expect(lines).toContain('Dry-run plan');
    expect(lines).toContain("ollama pull 'qwen3.5:4b'");
    expect(lines).not.toContain("ollama pull 'bge-m3:latest'");
    expect(lines).toContain('in-process 256-dimensional embeddings');
    expect(lines).toContain('npx --no-install openprojects doctor --probe --config');
    expect(lines).toContain('npx --no-install openprojects serve --config');
    expect(lines).toContain('npx --no-install openprojects tui --config');
    expect(lines).toContain('database parent directory with mode 0700');
  });
});

describe('installation wizard config publication', () => {
  it.runIf(process.platform === 'darwin')(
    'refuses case-only aliases between protected artifacts on macOS',
    async () => {
      const directory = await temporaryDirectory();
      const destination = join(directory, 'OpenProjects.yaml');
      const plan = buildWizardPlan({
        ...baseAnswers(),
        configPath: destination,
        databasePath: join(directory, 'state.db'),
        controlTokenPath: join(directory, 'oPENpROJECTS.YAML'),
      }, planOptions());

      await expect(writeWizardConfig(plan)).rejects.toThrow(
        'Control socket, token, configuration, and database paths must be distinct',
      );
      await expect(lstat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it('writes schema-valid YAML with mode 0600 and refuses implicit overwrite', async () => {
    const directory = await temporaryDirectory();
    const plan = buildWizardPlan({
      ...baseAnswers(),
      configPath: join(directory, 'openprojects.yaml'),
      databasePath: join(directory, 'openprojects.db'),
    }, planOptions());

    const written = await writeWizardConfig(plan);
    expect(written).toMatchObject({
      path: join(directory, 'openprojects.yaml'),
      controlTokenPath: join(directory, 'data', 'control.token'),
      controlTokenCreated: true,
      databaseDirectory: directory,
    });
    if (process.platform !== 'win32') {
      expect((await lstat(written.path)).mode & 0o777).toBe(0o600);
      expect((await lstat(written.controlTokenPath)).mode & 0o777).toBe(0o600);
      expect((await lstat(join(directory, 'data'))).mode & 0o777).toBe(0o700);
    }
    expect((await readFile(written.controlTokenPath, 'utf8')).trim()).toMatch(/^[A-Za-z0-9_-]{32,512}$/u);
    expect(plan.yaml).not.toContain((await readFile(written.controlTokenPath, 'utf8')).trim());
    const loaded = loadConfig(written.path);
    expect(loaded.model).toMatchObject({ provider: 'ollama', model: 'qwen3.5:4b' });
    expect(loaded.privacy).toEqual({ localOnly: true, allowedOrigins: [] });
    expect(loaded.server.auth).toEqual({
      principals: [{
        id: 'local-admin',
        tokenFile: written.controlTokenPath,
        capabilities: ['admin'],
      }],
    });

    const original = await readFile(written.path, 'utf8');
    await expect(writeWizardConfig(plan)).rejects.toThrow('pass --force to replace it');
    expect(await readFile(written.path, 'utf8')).toBe(original);
  });

  it.runIf(process.platform !== 'win32' && process.geteuid !== undefined)(
    'publishes a loadable protected Unix-socket installation plan',
    async () => {
      const socketTestRoot = process.platform === 'darwin' ? '/private/tmp' : tmpdir();
      const directory = await mkdtemp(join(socketTestRoot, 'opw-sock-'));
      cleanupPaths.add(directory);
      const socketPath = join(directory, 'data', 'control.sock');
      const plan = buildWizardPlan({
        ...baseAnswers(),
        configPath: join(directory, 'openprojects.yaml'),
        databasePath: join(directory, 'data', 'openprojects.db'),
        controlTokenPath: join(directory, 'data', 'control.token'),
        controlSocketPath: socketPath,
      }, planOptions());
      const written = await writeWizardConfig(plan);
      expect(written.controlSocketPath).toBe(socketPath);
      expect(loadConfig(written.path).server.socketPath).toBe(socketPath);
      await expect(lstat(socketPath)).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it('backs up an existing regular file before an explicit atomic force replacement', async () => {
    const directory = await temporaryDirectory();
    const destination = join(directory, 'openprojects.yaml');
    const first = buildWizardPlan({
      ...baseAnswers(),
      configPath: destination,
      databasePath: join(directory, 'first.db'),
    }, planOptions());
    await writeWizardConfig(first);
    const originalToken = await readFile(join(directory, 'data', 'control.token'), 'utf8');
    await chmod(destination, 0o644);
    const second = buildWizardPlan({
      ...baseAnswers(),
      configPath: destination,
      databasePath: join(directory, 'second.db'),
      model: 'qwen3.5:9b',
    }, planOptions());

    const written = await writeWizardConfig(second, {
      force: true,
      now: () => new Date('2026-08-25T12:34:56.000Z'),
    });

    expect(written.backupPath).toBe(`${destination}.bak-2026-08-25T12-34-56-000Z`);
    expect(await readFile(written.backupPath!, 'utf8')).toBe(first.yaml);
    if (process.platform !== 'win32') expect((await lstat(written.backupPath!)).mode & 0o777).toBe(0o600);
    expect(await readFile(destination, 'utf8')).toBe(second.yaml);
    if (process.platform !== 'win32') expect((await lstat(destination)).mode & 0o777).toBe(0o600);
    expect(written.controlTokenCreated).toBe(false);
    expect(await readFile(written.controlTokenPath, 'utf8')).toBe(originalToken);
  });

  it.skipIf(process.platform === 'win32')('does not follow or overwrite a symlink when force is requested', async () => {
    const directory = await temporaryDirectory();
    const target = join(directory, 'target.yaml');
    const destination = join(directory, 'openprojects.yaml');
    await writeFile(target, 'do not replace\n', 'utf8');
    await symlink(target, destination);
    const plan = buildWizardPlan({
      ...baseAnswers(),
      configPath: destination,
      databasePath: join(directory, 'state.db'),
    }, planOptions());

    await expect(writeWizardConfig(plan, { force: true })).rejects.toThrow(
      'Refusing to force-overwrite symbolic link',
    );
    expect(await readFile(target, 'utf8')).toBe('do not replace\n');
    expect((await lstat(destination)).isSymbolicLink()).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('refuses an unprotected existing control token before publishing configuration', async () => {
    const directory = await temporaryDirectory();
    const data = join(directory, 'data');
    const token = join(data, 'control.token');
    const destination = join(directory, 'openprojects.yaml');
    await mkdir(data, { mode: 0o700 });
    await writeFile(token, 'weak-and-world-readable-token-value-1234567890', { mode: 0o644 });
    await chmod(token, 0o644);
    const plan = buildWizardPlan({
      ...baseAnswers(),
      configPath: destination,
      databasePath: join(data, 'openprojects.db'),
      controlTokenPath: token,
    }, planOptions());

    await expect(writeWizardConfig(plan)).rejects.toThrow('permissions must be owner-only');
    await expect(lstat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await lstat(token)).mode & 0o777).toBe(0o644);
  });

  it.skipIf(process.platform === 'win32')('rejects an intermediate symbolic-link component in reviewed artifact paths', async () => {
    const directory = await temporaryDirectory();
    const realData = join(directory, 'real-data');
    const linkedData = join(directory, 'linked-data');
    await mkdir(realData, { mode: 0o700 });
    await symlink(realData, linkedData, 'dir');
    const plan = buildWizardPlan({
      ...baseAnswers(),
      configPath: join(directory, 'openprojects.yaml'),
      databasePath: join(linkedData, 'openprojects.db'),
      controlTokenPath: join(linkedData, 'control.token'),
    }, planOptions());

    await expect(writeWizardConfig(plan)).rejects.toThrow('symbolic-link path component');
    await expect(lstat(join(directory, 'openprojects.yaml'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.skipIf(process.platform === 'win32')('rejects an existing database symlink before publishing configuration', async () => {
    const directory = await temporaryDirectory();
    const data = join(directory, 'data');
    const target = join(data, 'target.db');
    const database = join(data, 'openprojects.db');
    await mkdir(data, { mode: 0o700 });
    await writeFile(target, 'not sqlite', { mode: 0o600 });
    await symlink(target, database);
    const plan = buildWizardPlan({
      ...baseAnswers(),
      configPath: join(directory, 'openprojects.yaml'),
      databasePath: database,
      controlTokenPath: join(data, 'control.token'),
    }, planOptions());

    await expect(writeWizardConfig(plan)).rejects.toThrow('single-link regular non-symlink file');
    await expect(lstat(join(directory, 'openprojects.yaml'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects an existing hard-linked database before publishing configuration', async () => {
    const directory = await temporaryDirectory();
    const data = join(directory, 'data');
    const target = join(data, 'target.db');
    const database = join(data, 'openprojects.db');
    await mkdir(data, { mode: 0o700 });
    await writeFile(target, 'not sqlite', { mode: 0o600 });
    await link(target, database);
    const plan = buildWizardPlan({
      ...baseAnswers(),
      configPath: join(directory, 'openprojects.yaml'),
      databasePath: database,
      controlTokenPath: join(data, 'control.token'),
    }, planOptions());

    await expect(writeWizardConfig(plan)).rejects.toThrow('single-link regular non-symlink file');
    await expect(lstat(join(directory, 'openprojects.yaml'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.skipIf(process.platform === 'win32')('rejects an existing owner-only directory that is not mode 0700', async () => {
    const directory = await temporaryDirectory();
    const data = join(directory, 'data');
    await mkdir(data, { mode: 0o500 });
    await chmod(data, 0o500);
    const plan = buildWizardPlan({
      ...baseAnswers(),
      configPath: join(directory, 'openprojects.yaml'),
      databasePath: join(data, 'openprojects.db'),
      controlTokenPath: join(data, 'control.token'),
    }, planOptions());

    await expect(writeWizardConfig(plan)).rejects.toThrow('permissions must be owner-only (0700)');
    await chmod(data, 0o700);
  });
});

function fixtureHardware(): HardwareInfo {
  return {
    platform: 'darwin',
    architecture: 'arm64',
    logicalCpuCount: 8,
    cpuModel: 'Apple M3',
    memoryBytes: 16 * 1024 ** 3,
    memoryGiB: 16,
    acceleration: 'apple-silicon',
  };
}

function lowMemoryHardware(): HardwareInfo {
  return {
    ...fixtureHardware(),
    memoryBytes: 4 * 1024 ** 3,
    memoryGiB: 4,
  };
}

function baseAnswers(): WizardAnswers {
  return {
    profile: 'private-local',
    backend: 'ollama',
    configPath: './openprojects.config.yaml',
    databasePath: './data/openprojects.db',
    controlTokenPath: './data/control.token',
    model: 'qwen3.5:4b',
    baseUrl: 'http://127.0.0.1:11434/v1',
    contextWindow: 16_384,
    telegramEnabled: false,
    transcriptionEnabled: false,
    whisperCommand: 'whisper-cli',
    whisperModelPath: './models/ggml-small.bin',
    ffmpegCommand: 'ffmpeg',
  };
}

function planOptions() {
  return {
    hardware: fixtureHardware(),
    recommendation: recommendLocalModel(fixtureHardware()),
  };
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(await realpath(tmpdir()), 'openprojects-wizard-'));
  cleanupPaths.add(path);
  return path;
}

interface ScriptedValues {
  selections?: Record<string, string[]>;
  inputs?: Record<string, string[]>;
  confirmations?: Record<string, boolean[]>;
}

class ScriptedIO implements WizardIO {
  readonly output: string[] = [];
  readonly selectPrompts: string[] = [];
  readonly inputPrompts: string[] = [];
  readonly confirmPrompts: string[] = [];

  constructor(private readonly values: ScriptedValues) {}

  async select(prompt: SelectPrompt): Promise<string> {
    this.selectPrompts.push(prompt.id);
    return take(this.values.selections, prompt.id) ?? prompt.defaultValue;
  }

  async input(prompt: InputPrompt): Promise<string> {
    this.inputPrompts.push(prompt.id);
    return take(this.values.inputs, prompt.id) ?? prompt.defaultValue ?? '';
  }

  async confirm(prompt: ConfirmPrompt): Promise<boolean> {
    this.confirmPrompts.push(prompt.id);
    return take(this.values.confirmations, prompt.id) ?? prompt.defaultValue;
  }

  write(message: string): void {
    this.output.push(message);
  }
}

function take<T>(source: Record<string, T[]> | undefined, key: string): T | undefined {
  return source?.[key]?.shift();
}
