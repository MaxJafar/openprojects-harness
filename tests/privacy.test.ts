import { afterEach, describe, expect, it, vi } from 'vitest';

import { OllamaEmbeddingAdapter } from '../src/adapters/embeddings.js';
import { OpenAICompatibleAdapter } from '../src/adapters/models.js';
import { createApp, type OpenProjectsApp } from '../src/app.js';
import type { AppConfig } from '../src/core/types.js';
import {
  createNetworkPolicy,
  NetworkPolicy,
  OutboundNetworkBlockedError,
} from '../src/privacy/network-policy.js';
import { TelegramAdapter } from '../src/telegram.js';

const openApps = new Set<OpenProjectsApp>();

afterEach(async () => {
  for (const app of openApps) await app.close();
  openApps.clear();
  vi.unstubAllGlobals();
});

describe('private outbound network policy', () => {
  it('allows loopback but denies public and RFC1918/LAN addresses by default', () => {
    const policy = createNetworkPolicy();

    expect(() => policy.assertAllowed('http://127.0.0.1:11434/api/embed', 'test')).not.toThrow();
    expect(() => policy.assertAllowed('http://127.23.45.67:8080/v1', 'test')).not.toThrow();
    expect(() => policy.assertAllowed('http://localhost:4310', 'test')).not.toThrow();
    expect(() => policy.assertAllowed('http://[::1]:8080/v1', 'test')).not.toThrow();
    expect(() => policy.assertAllowed('https://api.example.com/v1', 'test')).toThrow(
      OutboundNetworkBlockedError,
    );
    expect(() => policy.assertAllowed('http://10.20.30.40:11434', 'test')).toThrow(
      OutboundNetworkBlockedError,
    );
  });

  it('uses an exact-origin allowlist without suffix, scheme, or port expansion', () => {
    const policy = new NetworkPolicy({
      localOnly: true,
      allowedOrigins: ['https://llm.corp.example:8443'],
    });

    expect(() => policy.assertAllowed('https://llm.corp.example:8443/v1/chat/completions', 'test')).not.toThrow();
    expect(() => policy.assertAllowed('https://llm.corp.example/v1', 'test')).toThrow(OutboundNetworkBlockedError);
    expect(() => policy.assertAllowed('http://llm.corp.example:8443/v1', 'test')).toThrow(OutboundNetworkBlockedError);
    expect(() => policy.assertAllowed('https://evil.llm.corp.example:8443/v1', 'test')).toThrow(OutboundNetworkBlockedError);
  });

  it('rejects userinfo, non-HTTP URLs, and non-origin allowlist entries', () => {
    const policy = createNetworkPolicy({ localOnly: false, allowedOrigins: [] });

    expect(() => policy.assertAllowed('https://user:secret@example.com/v1', 'test')).toThrow('must not contain credentials');
    expect(() => policy.assertAllowed('file:///tmp/model', 'test')).toThrow('must use http or https');
    expect(() => new NetworkPolicy({
      localOnly: true,
      allowedOrigins: ['https://llm.corp.example/v1'],
    })).toThrow('must be an origin without a path');
  });

  it('blocks a remote model even when its route is mislabeled local', async () => {
    const config = baseConfig();
    config.routing = {
      dailyBudgetUsd: 0,
      explorationRate: 0,
      routes: [{
        id: 'fake-local',
        provider: 'openai-compatible',
        model: 'corporate-model',
        generation: 'corporate-model-2026-08',
        tasks: ['supervisor'],
        baseUrl: 'https://models.example.com/v1',
        apiKey: 'test-only-key',
        local: true,
        enabled: true,
        quality: 0.8,
        inputCostPerMillion: 0,
        outputCostPerMillion: 0,
        contextWindow: 8_192,
      }],
    };

    await expect(createApp({ config, skills: [], seedDemo: false })).rejects.toThrow(
      'Model route fake-local local=true does not match its baseUrl boundary',
    );
  });

  it('blocks remote embedding and Telegram endpoints before a request can run', async () => {
    const embeddingConfig = baseConfig();
    embeddingConfig.embeddings = {
      provider: 'ollama',
      model: 'nomic-embed-text',
      baseUrl: 'http://10.20.30.40:11434',
      dimensions: 768,
      timeoutMs: 30_000,
    };
    await expect(createApp({ config: embeddingConfig, skills: [], seedDemo: false })).rejects.toThrow(
      'Ollama embeddings are local-only; use provider openai-compatible for external embeddings',
    );

    const telegramConfig = baseConfig();
    telegramConfig.telegram = { enabled: true, apiBaseUrl: 'https://api.telegram.org' };
    await expect(createApp({ config: telegramConfig, skills: [], seedDemo: false })).rejects.toThrow(
      'Blocked outbound Telegram API request to https://api.telegram.org',
    );
  });

  it('accepts an explicitly allowlisted corporate model origin', async () => {
    const config = baseConfig();
    config.privacy = {
      localOnly: true,
      allowedOrigins: ['https://llm.corp.example:8443'],
    };
    config.routing = {
      externalInference: 'allow',
      preferLocal: true,
      allowRemoteFallback: false,
      dailyBudgetUsd: 0,
      explorationRate: 0,
      routes: [{
        id: 'corporate-model',
        provider: 'openai-compatible',
        model: 'corporate-model',
        generation: 'corporate-model-2026-08',
        tasks: ['supervisor'],
        baseUrl: 'https://llm.corp.example:8443/v1',
        apiKeyEnv: 'OPENPROJECTS_TEST_CORPORATE_API_KEY',
        local: false,
        enabled: true,
        quality: 0.8,
        inputCostPerMillion: 1,
        outputCostPerMillion: 1,
        contextWindow: 8_192,
      }],
    };

    const originalKey = process.env.OPENPROJECTS_TEST_CORPORATE_API_KEY;
    process.env.OPENPROJECTS_TEST_CORPORATE_API_KEY = 'test-only-key';
    try {
      const app = await createApp({ config, skills: [], seedDemo: false });
      openApps.add(app);
      expect(app.networkPolicy.localOnly).toBe(true);
      expect(app.networkPolicy.allowedOrigins).toEqual(['https://llm.corp.example:8443']);
    } finally {
      restoreEnvironment('OPENPROJECTS_TEST_CORPORATE_API_KEY', originalKey);
    }
  });

  it('fails fast when an enabled external provider credential is missing or unsafe', async () => {
    const keyName = 'OPENPROJECTS_TEST_EXTERNAL_CREDENTIAL';
    const originalKey = process.env[keyName];
    const modelConfig = baseConfig();
    modelConfig.privacy = {
      localOnly: true,
      allowedOrigins: ['https://llm.example.test'],
    };
    modelConfig.routing = {
      externalInference: 'allow',
      dailyBudgetUsd: 1,
      explorationRate: 0,
      routes: [{
        id: 'external-credential-test',
        provider: 'openai-compatible',
        model: 'reviewed-model',
        generation: 'reviewed-model-2026-08',
        tasks: ['supervisor'],
        baseUrl: 'https://llm.example.test/v1',
        apiKeyEnv: keyName,
        local: false,
        enabled: true,
        quality: 0.8,
        inputCostPerMillion: 1,
        outputCostPerMillion: 1,
        contextWindow: 8_192,
      }],
    };

    try {
      delete process.env[keyName];
      await expect(createApp({ config: modelConfig, skills: [], seedDemo: false })).rejects.toThrow(
        `requires a non-empty ${keyName} environment credential`,
      );
      process.env[keyName] = '';
      await expect(createApp({ config: modelConfig, skills: [], seedDemo: false })).rejects.toThrow(
        `requires a non-empty ${keyName} environment credential`,
      );
      process.env[keyName] = 'unsafe\ncredential';
      await expect(createApp({ config: modelConfig, skills: [], seedDemo: false })).rejects.toThrow(
        'environment credential must contain only visible ASCII characters',
      );

      const embeddingConfig = baseConfig();
      embeddingConfig.privacy = {
        localOnly: true,
        allowedOrigins: ['https://embeddings.example.test'],
      };
      embeddingConfig.embeddings = {
        provider: 'openai-compatible',
        model: 'reviewed-embedding',
        baseUrl: 'https://embeddings.example.test/v1',
        generation: 'reviewed-generation-v1',
        apiKeyEnv: keyName,
        externalData: 'allow',
        dimensions: 256,
        timeoutMs: 3_000,
      };
      delete process.env[keyName];
      await expect(createApp({ config: embeddingConfig, skills: [], seedDemo: false })).rejects.toThrow(
        `requires a non-empty ${keyName} environment credential`,
      );
      process.env[keyName] = 'unsafe\rcredential';
      await expect(createApp({ config: embeddingConfig, skills: [], seedDemo: false })).rejects.toThrow(
        'environment credential must contain only visible ASCII characters',
      );
    } finally {
      restoreEnvironment(keyName, originalKey);
    }
  });

  it('disables redirects at each harness-owned HTTP transport', async () => {
    const requests: Array<{ url: string; redirect: RequestRedirect | undefined }> = [];
    vi.stubGlobal('fetch', async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      requests.push({ url, redirect: init?.redirect });
      if (url.includes('/chat/completions')) {
        return jsonResponse({
          choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        });
      }
      if (url.includes('/api/embed')) return jsonResponse({ embeddings: [[1, 0]] });
      return jsonResponse({ ok: true, result: {} });
    });

    const model = new OpenAICompatibleAdapter({ baseUrl: 'http://127.0.0.1:11434/v1' });
    await model.complete({
      runId: 'privacy-redirect-test',
      provider: 'local',
      model: 'local-model',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      maxOutputTokens: 32,
      signal: new AbortController().signal,
    });
    const embedding = new OllamaEmbeddingAdapter({
      model: 'local-embedding',
      baseUrl: 'http://127.0.0.1:11434',
      dimensions: 2,
    });
    await embedding.embed(['hello']);

    const originalToken = process.env.TELEGRAM_BOT_TOKEN;
    const originalSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
    const originalApiBaseUrl = process.env.TELEGRAM_API_BASE_URL;
    process.env.TELEGRAM_BOT_TOKEN = '123456:test-token';
    process.env.TELEGRAM_WEBHOOK_SECRET = 'test-secret';
    delete process.env.TELEGRAM_API_BASE_URL;
    try {
      const config = baseConfig();
      config.privacy = { localOnly: true, allowedOrigins: ['https://api.telegram.org'] };
      config.telegram = { enabled: true, apiBaseUrl: 'https://api.telegram.org' };
      const app = await createApp({ config, skills: [], seedDemo: false });
      openApps.add(app);
      await new TelegramAdapter(app).sendNotification('123', 'test');
    } finally {
      restoreEnvironment('TELEGRAM_BOT_TOKEN', originalToken);
      restoreEnvironment('TELEGRAM_WEBHOOK_SECRET', originalSecret);
      restoreEnvironment('TELEGRAM_API_BASE_URL', originalApiBaseUrl);
    }

    expect(requests).toHaveLength(3);
    expect(requests).toEqual([
      expect.objectContaining({ url: expect.stringContaining('/chat/completions'), redirect: 'manual' }),
      expect.objectContaining({ url: expect.stringContaining('/api/embed'), redirect: 'error' }),
      expect.objectContaining({ url: expect.stringContaining('/bot123456:test-token/'), redirect: 'error' }),
    ]);
  });

  it('does not contact an embedding service when memory retrieval is configured off', async () => {
    const requests: string[] = [];
    vi.stubGlobal('fetch', async (input: string | URL | Request): Promise<Response> => {
      requests.push(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
      throw new Error('embedding transport must remain unused');
    });
    const config = baseConfig();
    config.agent.tools = ['project_risk_report'];
    config.memory = { retrievalLimit: 0, maxContextCharacters: 8_000 };
    config.embeddings = {
      provider: 'ollama',
      model: 'bge-m3:latest',
      baseUrl: 'http://127.0.0.1:11434',
      serviceDigest: 'a'.repeat(64),
      dimensions: 1_024,
      timeoutMs: 3_000,
    };
    const app = await createApp({ config, skills: [], seedDemo: true });
    openApps.add(app);

    const outcome = await app.runtime.start({
      message: 'Assess Atlas risk.',
      workspaceId: 'local',
      actorId: 'alice',
      projectId: 'project-atlas',
    });

    expect(outcome.run.status).toBe('succeeded');
    expect(requests).toEqual([]);
    expect(outcome.events.find((event) => event.type === 'memory.retrieved')?.data)
      .toMatchObject({ algorithm: 'disabled', memories: [] });
  });
});

function baseConfig(): AppConfig {
  return {
    version: 1,
    agent: {
      id: 'privacy-test',
      version: '1.0.0',
      name: 'Privacy Test Agent',
      system: 'Test only.',
      skills: [],
      tools: [],
      budgets: {
        maxSteps: 2,
        maxToolCalls: 2,
        maxWallTimeMs: 30_000,
        maxInputTokens: 4_000,
        reservedOutputTokens: 512,
      },
    },
    policy: {
      read: 'allow',
      draft: 'allow',
      memory_write: 'allow',
      internal_write: 'ask',
      external_write: 'ask',
      destructive: 'deny',
    },
    server: { host: '127.0.0.1', port: 4310 },
    storage: { database: ':memory:' },
    model: { provider: 'mock', model: 'privacy-fixture' },
    privacy: { localOnly: true, allowedOrigins: [] },
    telegram: { enabled: false, apiBaseUrl: 'https://api.telegram.org' },
    memory: { retrievalLimit: 4, maxContextCharacters: 4_000 },
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
