import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createEmbeddingAdapter,
  DeterministicHashEmbeddingAdapter,
  OllamaEmbeddingAdapter,
  OpenAICompatibleEmbeddingAdapter,
} from '../src/adapters/embeddings.js';
import {
  FreeTokenAdapter,
  LlamaCppAdapter,
  MAX_MODEL_RESPONSE_BYTES,
  MlxLmAdapter,
  ModelHttpError,
  ModelTransportError,
  OpenAICompatibleAdapter,
  validateApiBaseUrl,
  validateFreeTokenBaseUrl,
  validateLlamaCppBaseUrl,
  validateMlxLmBaseUrl,
} from '../src/adapters/models.js';
import {
  DisabledTranscriptionAdapter,
  TranscriptionDisabledError,
  TranscriptionTimeoutError,
  WhisperCppTranscriptionAdapter,
} from '../src/adapters/transcription.js';
import { createNetworkPolicy } from '../src/privacy/network-policy.js';
import type {
  ModelAdapter,
  ModelRequest,
  ModelResponse,
  ModelRouteConfig,
  ModelTask,
} from '../src/core/types.js';
import {
  calculateUsageCostUsd,
  estimateRequestTokens,
  modelRouteStatsIdentity,
  ModelAccountingError,
  ModelBudgetExceededError,
  ModelRouter,
  type ModelRouterStorage,
} from '../src/runtime/model-router.js';
import type { ModelRouteStats } from '../src/storage/sqlite.js';

const openServers = new Set<Server>();
const cleanupPaths = new Set<string>();

afterEach(async () => {
  for (const server of openServers) await closeServer(server);
  openServers.clear();
  for (const path of cleanupPaths) await rm(path, { recursive: true, force: true });
  cleanupPaths.clear();
});

describe('local embedding adapters', () => {
  it('produces normalized deterministic vectors across calls and instances', async () => {
    const first = new DeterministicHashEmbeddingAdapter({ dimensions: 64 });
    const second = new DeterministicHashEmbeddingAdapter({ dimensions: 64 });
    const texts = ['Project Atlas deadline', 'Credentials blocker'];

    const firstPass = await first.embed(texts);
    const secondPass = await first.embed(texts);
    const otherInstance = await second.embed(texts);

    expect(firstPass).toEqual(secondPass);
    expect(firstPass).toEqual(otherInstance);
    expect(first.dataBoundary).toBe('local');
    expect(firstPass[0]).toHaveLength(64);
    expect(firstPass[0]).not.toEqual(firstPass[1]);
    for (const vector of firstPass) {
      const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
      expect(norm).toBeCloseTo(1, 12);
    }
  });

  it('uses Ollama /api/embed and rejects configured or internally inconsistent dimensions', async () => {
    const responses = [
      { embeddings: [[1, 0]] },
      { embeddings: [[1, 0], [1, 0, 0]] },
    ];
    const observed: Array<{ url: string; body: unknown }> = [];
    const baseUrl = await startJsonServer(async (url, body) => {
      observed.push({ url, body });
      return responses.shift() ?? { embeddings: [] };
    });

    const configured = new OllamaEmbeddingAdapter({
      model: 'nomic-embed-text',
      baseUrl,
      dimensions: 3,
    });
    await expect(configured.embed(['one'])).rejects.toThrow(
      'Ollama embedding has 2 dimensions; expected 3',
    );

    const inferred = new OllamaEmbeddingAdapter({
      model: 'nomic-embed-text',
      baseUrl,
    });
    await expect(inferred.embed(['one', 'two'])).rejects.toThrow(
      'Ollama returned embeddings with inconsistent dimensions',
    );
    expect(configured.dataBoundary).toBe('local');
    expect(inferred.dataBoundary).toBe('local');

    expect(observed).toEqual([
      {
        url: '/api/embed',
        body: { model: 'nomic-embed-text', input: ['one'], dimensions: 3, truncate: false },
      },
      {
        url: '/api/embed',
        body: { model: 'nomic-embed-text', input: ['one', 'two'], truncate: false },
      },
    ]);
  });

  it('rechecks the pinned Ollama digest before every embedding request', async () => {
    const expectedDigest = 'a'.repeat(64);
    let observedDigest = expectedDigest;
    let tagRequests = 0;
    const baseUrl = await startJsonServer(async (url) => {
      if (url === '/api/tags') {
        tagRequests += 1;
        return { models: [{ model: 'bge-m3:latest', digest: observedDigest }] };
      }
      return { model: 'bge-m3:latest', embeddings: [[1, 0]] };
    });
    const adapter = new OllamaEmbeddingAdapter({
      model: 'bge-m3:latest',
      baseUrl,
      serviceDigest: expectedDigest,
      dimensions: 2,
    });

    await expect(adapter.embed(['first'])).resolves.toEqual([[1, 0]]);
    observedDigest = 'b'.repeat(64);
    await expect(adapter.embed(['second'])).rejects.toThrow(
      'does not match the configured digest',
    );
    expect(tagRequests).toBe(2);
  });

  it('uses the compatible embeddings wire format, bearer auth, indexed order, and local normalization', async () => {
    const observed: Array<{
      url: string;
      body: unknown;
      authorization: string | undefined;
    }> = [];
    const baseUrl = await startJsonServer(async (url, body, request) => {
      observed.push({
        url,
        body,
        authorization: request.headers.authorization,
      });
      return {
        model: 'text-embedding-test',
        data: [
          { index: 1, embedding: [0, 2, 0] },
          { index: 0, embedding: [3, 4, 0] },
        ],
      };
    });
    const adapter = new OpenAICompatibleEmbeddingAdapter({
      model: 'text-embedding-test',
      baseUrl: `${baseUrl}/v1/`,
      generation: 'test-generation-v1',
      apiKey: 'embedding-test-key',
      dimensions: 3,
    });

    await expect(adapter.embed(['first', 'second'])).resolves.toEqual([
      [0.6, 0.8, 0],
      [0, 1, 0],
    ]);
    expect(observed).toEqual([{
      url: '/v1/embeddings',
      body: {
        model: 'text-embedding-test',
        input: ['first', 'second'],
        dimensions: 3,
        encoding_format: 'float',
      },
      authorization: 'Bearer embedding-test-key',
    }]);
    expect(adapter.id).toContain('test-generation-v1');
    expect(adapter.id).not.toContain(baseUrl);
    expect(adapter.dataBoundary).toBe('local');
  });

  it('rejects compatible embedding index, dimension, and model identity drift', async () => {
    const responses = [
      {
        model: 'text-embedding-test',
        data: [
          { index: 0, embedding: [1, 0] },
          { index: 0, embedding: [0, 1] },
        ],
      },
      {
        model: 'text-embedding-test',
        data: [{ index: 0, embedding: [1] }],
      },
      {
        model: 'different-model',
        data: [{ index: 0, embedding: [1, 0] }],
      },
    ];
    const baseUrl = await startJsonServer(async () => responses.shift() ?? { data: [] });
    const adapter = new OpenAICompatibleEmbeddingAdapter({
      model: 'text-embedding-test',
      baseUrl: `${baseUrl}/v1`,
      generation: 'test-generation-v1',
      dimensions: 2,
    });

    await expect(adapter.embed(['one', 'two'])).rejects.toThrow('repeats index 0');
    await expect(adapter.embed(['one'])).rejects.toThrow('must contain 2 finite numbers');
    await expect(adapter.embed(['one'])).rejects.toThrow('does not match text-embedding-test');
  });

  it('requires explicit disclosure and environment-backed credentials for external embeddings', () => {
    const base = {
      provider: 'openai-compatible' as const,
      model: 'text-embedding-test',
      baseUrl: 'https://embeddings.example.test/v1',
      generation: 'test-generation-v1',
      dimensions: 3,
      timeoutMs: 3_000,
    };
    const externalPolicy = createNetworkPolicy({ localOnly: false, allowedOrigins: [] });
    const external = createEmbeddingAdapter({
      ...base,
      apiKeyEnv: 'EMBEDDING_TEST_KEY',
      externalData: 'allow',
    }, externalPolicy, { EMBEDDING_TEST_KEY: 'secret' });
    const remoteOllama = new OllamaEmbeddingAdapter({
      model: 'bge-m3:latest',
      baseUrl: 'https://ollama.example.test',
      networkPolicy: externalPolicy,
    });
    expect(external.dataBoundary).toBe('external');
    expect(remoteOllama.dataBoundary).toBe('external');

    expect(() => createEmbeddingAdapter({
      ...base,
      apiKeyEnv: 'EMBEDDING_TEST_KEY',
      externalData: 'deny',
    }, undefined, { EMBEDDING_TEST_KEY: 'secret' })).toThrow(
      'External embeddings require embeddings.externalData: allow',
    );
    expect(() => createEmbeddingAdapter({
      ...base,
      externalData: 'allow',
    }, undefined, {})).toThrow('External embeddings require apiKeyEnv');
    expect(() => createEmbeddingAdapter({
      ...base,
      apiKeyEnv: 'EMBEDDING_TEST_KEY',
      externalData: 'allow',
    }, undefined, {})).toThrow(
      'Embedding credential environment variable EMBEDDING_TEST_KEY is not configured',
    );
    expect(() => createEmbeddingAdapter({
      provider: 'openai-compatible',
      model: 'text-embedding-test',
      baseUrl: 'https://embeddings.example.test/v1',
      apiKeyEnv: 'EMBEDDING_TEST_KEY',
      externalData: 'allow',
      dimensions: 3,
      timeoutMs: 3_000,
    }, undefined, { EMBEDDING_TEST_KEY: 'secret' })).toThrow(
      'require an immutable generation identifier',
    );
    expect(() => createEmbeddingAdapter({
      provider: 'builtin',
      model: 'builtin-hash-v1',
      baseUrl: 'http://127.0.0.1:9999',
      dimensions: 256,
      timeoutMs: 3_000,
    })).toThrow('Builtin embeddings do not accept');
    expect(() => createEmbeddingAdapter({
      provider: 'ollama',
      model: 'bge-m3:latest',
      externalData: 'deny',
      dimensions: 1_024,
      timeoutMs: 3_000,
    })).toThrow('Ollama embeddings do not accept externalData');
    expect(() => createEmbeddingAdapter({
      provider: 'ollama',
      model: 'bge-m3:latest',
      dimensions: 1_024,
      timeoutMs: 3_000,
    })).toThrow('require a reviewed serviceDigest');
  });

  it('rejects control-bearing credentials and protected or malformed custom headers', () => {
    expect(() => new OpenAICompatibleEmbeddingAdapter({
      model: 'text-embedding-test',
      baseUrl: 'http://127.0.0.1:8080/v1',
      generation: 'test-generation-v1',
      apiKey: 'unsafe\nkey',
      dimensions: 2,
    })).toThrow('API key must be 1-4096 visible ASCII');
    expect(() => new OpenAICompatibleEmbeddingAdapter({
      model: 'text-embedding-test',
      baseUrl: 'http://127.0.0.1:8080/v1',
      generation: 'test-generation-v1',
      dimensions: 2,
      headers: { Authorization: 'Bearer attacker-controlled' },
    })).toThrow('must not override authorization');
    expect(() => new OllamaEmbeddingAdapter({
      model: 'bge-m3:latest',
      headers: { 'x-trace': 'unsafe\r\nvalue' },
    })).toThrow('must be non-empty control-free ASCII');
  });
});

describe('MLX-LM local model adapter', () => {
  it('uses the externally pinned default model and accepts a strict structured tool call', async () => {
    const observed: Array<{ url: string; body: unknown }> = [];
    const baseUrl = await startJsonServer(async (url, body) => {
      observed.push({ url, body });
      return {
        model: 'default_model',
        choices: [{
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'mlx-call-1',
              type: 'function',
              function: { name: 'readiness_probe', arguments: '{"value":"READY"}' },
            }],
          },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
      };
    });
    const adapter = new MlxLmAdapter({ baseUrl: `${baseUrl}/v1` });
    const response = await adapter.complete({
      ...modelRequest('supervisor'),
      model: 'mlx-community/Qwen3-1.7B-4bit',
      tools: [{
        name: 'readiness_probe',
        description: 'Return the supplied readiness value.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['value'],
          properties: { value: { type: 'string' } },
        },
      }],
    });

    expect(response).toMatchObject({
      model: 'default_model',
      rawFinishReason: 'tool_calls',
      message: {
        content: null,
        toolCalls: [{
          id: 'mlx-call-1',
          name: 'readiness_probe',
          arguments: '{"value":"READY"}',
        }],
      },
      usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 },
    });
    expect(observed).toHaveLength(1);
    expect(observed[0]?.url).toBe('/v1/chat/completions');
    expect(observed[0]?.body).toMatchObject({
      messages: [{ role: 'user' }],
      max_tokens: 128,
      stream: false,
      tools: [{ type: 'function', function: { name: 'readiness_probe' } }],
    });
    expect(observed[0]?.body).not.toHaveProperty('model');
    expect(observed[0]?.body).not.toHaveProperty('tool_choice');
    expect(observed[0]?.body).not.toHaveProperty('parallel_tool_calls');
  });

  it('fails closed for non-loopback or non-standard endpoints', () => {
    expect(() => validateMlxLmBaseUrl('https://127.0.0.1:8080/v1')).toThrow('loopback HTTP');
    expect(() => validateMlxLmBaseUrl('http://192.0.2.1:8080/v1')).toThrow('loopback host');
    expect(() => validateMlxLmBaseUrl('http://127.0.0.1:8080/api/v1')).toThrow('path must be /v1');
    expect(validateMlxLmBaseUrl('http://[::1]:8080/v1/')).toBe('http://[::1]:8080/v1');
  });

  it('rejects a response that does not identify the omitted-request default_model alias', async () => {
    const responses = [
      {
        model: '/tmp/request-selected-model',
        choices: [{ message: { role: 'assistant', content: 'wrong model' }, finish_reason: 'stop' }],
      },
      {
        choices: [{ message: { role: 'assistant', content: 'missing identity' }, finish_reason: 'stop' }],
      },
    ];
    const baseUrl = await startJsonServer(async () => responses.shift());
    const adapter = new MlxLmAdapter({ baseUrl: `${baseUrl}/v1` });

    await expect(adapter.complete(modelRequest('summarization'))).rejects.toThrow(
      'received a different model identifier',
    );
    await expect(adapter.complete(modelRequest('summarization'))).rejects.toThrow('received no model identifier');
  });

  it('rejects parser loss, malformed arguments, and unoffered tools instead of treating them as text', async () => {
    const responses = [
      {
        choices: [{ message: { role: 'assistant', content: null }, finish_reason: 'tool_calls' }],
      },
      {
        choices: [{
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'malformed-args', type: 'function', function: { name: 'readiness_probe', arguments: '{broken' } }],
          },
          finish_reason: 'tool_calls',
        }],
      },
      {
        choices: [{
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'unoffered-call', type: 'function', function: { name: 'not_offered', arguments: '{}' } }],
          },
          finish_reason: 'tool_calls',
        }],
      },
    ];
    const baseUrl = await startJsonServer(async () => responses.shift());
    const adapter = new MlxLmAdapter({ baseUrl: `${baseUrl}/v1` });
    const request: ModelRequest = {
      ...modelRequest('supervisor'),
      tools: [{
        name: 'readiness_probe',
        description: 'Probe',
        inputSchema: { type: 'object' },
      }],
    };

    await expect(adapter.complete(request)).rejects.toThrow('without a structured tool call');
    await expect(adapter.complete(request)).rejects.toThrow('arguments are not valid JSON');
    await expect(adapter.complete(request)).rejects.toThrow('unoffered tool not_offered');
  });

  it('rejects unsafe MLX routes before making a request', () => {
    const storage = new TestRouterStorage();
    expect(() => new ModelRouter({
      routes: [modelRoute('mlx-remote', {
        provider: 'mlx-lm',
        model: 'reviewed-label',
        baseUrl: 'http://127.0.0.1:8080/v1',
        local: false,
      })],
      storage,
      dailyBudgetUsd: 0,
    })).toThrow('must declare local: true');
    expect(() => new ModelRouter({
      routes: [modelRoute('mlx-keyed', {
        provider: 'mlx-lm',
        model: 'reviewed-label',
        baseUrl: 'http://127.0.0.1:8080/v1',
        local: true,
        apiKeyEnv: 'MLX_API_KEY',
      })],
      storage,
      dailyBudgetUsd: 0,
    })).toThrow('must not configure an API key');
    expect(() => new ModelRouter({
      routes: [modelRoute('../unsafe route', { provider: 'mock' })],
      storage,
      dailyBudgetUsd: 0,
    })).toThrow('1-128 safe ASCII identifier');
  });

  it('selects the MLX adapter through the router provider boundary', async () => {
    const observed: unknown[] = [];
    const baseUrl = await startJsonServer(async (_url, body) => {
      observed.push(body);
      return {
        model: 'default_model',
        choices: [{ message: { role: 'assistant', content: 'summary' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 8, completion_tokens: 1, total_tokens: 9 },
      };
    });
    const router = new ModelRouter({
      routes: [modelRoute('mlx-local', {
        provider: 'mlx-lm',
        model: 'reviewed-mlx-snapshot',
        baseUrl: `${baseUrl}/v1`,
        local: true,
        inputCostPerMillion: 0,
        outputCostPerMillion: 0,
      })],
      storage: new TestRouterStorage(),
      dailyBudgetUsd: 0,
      explorationRate: 0,
    });

    const response = await router.complete(modelRequest('summarization'));

    expect(response.route).toMatchObject({
      routeId: 'mlx-local',
      provider: 'mlx-lm',
      model: 'reviewed-mlx-snapshot',
      local: true,
    });
    expect(response.model).toBe('default_model');
    expect(observed[0]).not.toHaveProperty('model');
  });
});

describe('llama.cpp local model adapter', () => {
  const apiKey = 'test-local-key-0123456789';
  const alias = 'granite-4.0-350m-q8@sha256-9595dafb';

  it('pins the request and response model alias, authenticates, and forbids parallel tools', async () => {
    const observed: Array<{
      url: string;
      body: unknown;
      authorization: string | undefined;
    }> = [];
    const baseUrl = await startJsonServer(async (url, body, request) => {
      observed.push({
        url,
        body,
        authorization: request.headers.authorization,
      });
      return {
        model: alias,
        choices: [{
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'llama-call-1',
              type: 'function',
              function: { name: 'readiness_probe', arguments: '{"value":"READY"}' },
            }],
          },
          finish_reason: 'tool_calls',
        }],
      };
    });
    const adapter = new LlamaCppAdapter({
      baseUrl: `${baseUrl}/v1`,
      apiKey,
      modelAlias: alias,
    });

    const response = await adapter.complete({
      ...modelRequest('project_analysis'),
      model: 'request-controlled-model-must-not-win',
      tools: [{
        name: 'readiness_probe',
        description: 'Probe',
        inputSchema: { type: 'object' },
      }],
    });

    expect(response.model).toBe(alias);
    expect(observed).toEqual([{
      url: '/v1/chat/completions',
      authorization: `Bearer ${apiKey}`,
      body: expect.objectContaining({
        model: alias,
        tool_choice: 'auto',
        parallel_tool_calls: false,
        stream: false,
      }),
    }]);
  });

  it('fails closed on unsafe endpoints, weak identity, missing auth, or response alias drift', async () => {
    expect(() => validateLlamaCppBaseUrl('https://127.0.0.1:8080/v1')).toThrow('loopback HTTP');
    expect(() => validateLlamaCppBaseUrl('http://192.0.2.1:8080/v1')).toThrow('loopback host');
    expect(() => validateLlamaCppBaseUrl('http://127.0.0.1:8080/')).toThrow('path must be /v1');
    expect(() => new LlamaCppAdapter({
      baseUrl: 'http://127.0.0.1:8080/v1',
      apiKey: 'short',
      modelAlias: alias,
    })).toThrow('16-256 visible ASCII');
    expect(() => new LlamaCppAdapter({
      baseUrl: 'http://127.0.0.1:8080/v1',
      apiKey,
      modelAlias: '../download-another-model',
    })).toThrow('safe identifier');

    const baseUrl = await startJsonServer(async () => ({
      model: 'different-alias',
      choices: [{ message: { role: 'assistant', content: 'drifted' }, finish_reason: 'stop' }],
    }));
    const adapter = new LlamaCppAdapter({
      baseUrl: `${baseUrl}/v1`,
      apiKey,
      modelAlias: alias,
    });
    await expect(adapter.complete(modelRequest('summarization'))).rejects.toThrow(
      'received a different model identifier',
    );
  });

  it('routes only an authenticated local llama.cpp deployment', async () => {
    const storage = new TestRouterStorage();
    expect(() => new ModelRouter({
      routes: [modelRoute('llama-remote', {
        provider: 'llama.cpp',
        model: alias,
        baseUrl: 'http://127.0.0.1:8080/v1',
        local: false,
        apiKey,
      })],
      storage,
      dailyBudgetUsd: 0,
    })).toThrow('must declare local: true');
    expect(() => new ModelRouter({
      routes: [modelRoute('llama-unauthenticated', {
        provider: 'llama.cpp',
        model: alias,
        baseUrl: 'http://127.0.0.1:8080/v1',
        local: true,
      })],
      storage,
      dailyBudgetUsd: 0,
    })).toThrow('requires a dedicated API key');
  });
});

describe('FreeToken local model adapter', () => {
  const alias = 'openprojects-qwen36-moe';

  it('pins one served-model alias and enforces strict sequential tool calls', async () => {
    const observed: Array<{ url: string; body: unknown; authorization: string | undefined }> = [];
    const baseUrl = await startJsonServer(async (url, body, request) => {
      observed.push({ url, body, authorization: request.headers.authorization });
      return {
        model: alias,
        choices: [{
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'freetoken-call-1',
              type: 'function',
              function: { name: 'readiness_probe', arguments: '{"value":"READY"}' },
            }],
          },
          finish_reason: 'tool_calls',
        }],
      };
    });
    const adapter = new FreeTokenAdapter({ baseUrl: `${baseUrl}/v1`, modelAlias: alias });

    const response = await adapter.complete({
      ...modelRequest('project_analysis'),
      model: 'Qwen/request-controlled-checkpoint',
      tools: [{
        name: 'readiness_probe',
        description: 'Probe',
        inputSchema: { type: 'object' },
      }],
    });

    expect(response.model).toBe(alias);
    expect(observed).toEqual([{
      url: '/v1/chat/completions',
      authorization: undefined,
      body: expect.objectContaining({
        model: alias,
        tool_choice: 'auto',
        parallel_tool_calls: false,
        stream: false,
      }),
    }]);
  });

  it('rejects remote/keyed routes, checkpoint-shaped aliases, and response identity drift', async () => {
    expect(() => validateFreeTokenBaseUrl('https://127.0.0.1:1919/v1')).toThrow('loopback HTTP');
    expect(() => validateFreeTokenBaseUrl('http://192.0.2.1:1919/v1')).toThrow('loopback host');
    expect(() => new FreeTokenAdapter({
      baseUrl: 'http://127.0.0.1:1919/v1',
      modelAlias: 'Qwen/Qwen3.6-35B-A3B',
    })).toThrow('safe identifier');

    const storage = new TestRouterStorage();
    expect(() => new ModelRouter({
      routes: [modelRoute('freetoken-remote', {
        provider: 'freetoken',
        model: alias,
        baseUrl: 'http://127.0.0.1:1919/v1',
        local: false,
      })],
      storage,
      dailyBudgetUsd: 0,
    })).toThrow('must declare local: true');
    expect(() => new ModelRouter({
      routes: [modelRoute('freetoken-keyed', {
        provider: 'freetoken',
        model: alias,
        baseUrl: 'http://127.0.0.1:1919/v1',
        local: true,
        apiKeyEnv: 'FREETOKEN_API_KEY',
      })],
      storage,
      dailyBudgetUsd: 0,
    })).toThrow('must not configure an API key');

    const baseUrl = await startJsonServer(async () => ({
      model: 'different-alias',
      choices: [{ message: { role: 'assistant', content: 'drifted' }, finish_reason: 'stop' }],
    }));
    const adapter = new FreeTokenAdapter({ baseUrl: `${baseUrl}/v1`, modelAlias: alias });
    await expect(adapter.complete(modelRequest('summarization'))).rejects.toThrow(
      'received a different model identifier',
    );
  });
});

describe('cost-aware model routing', () => {
  it('filters routes by task before considering quality', async () => {
    const storage = new TestRouterStorage();
    const supervisor = new RecordingModelAdapter('supervisor');
    const notification = new RecordingModelAdapter('notification');
    const router = routerWith({
      storage,
      routes: [
        modelRoute('supervisor', {
          tasks: ['supervisor'],
          quality: 1,
        }),
        modelRoute('notification', {
          tasks: ['notification'],
          quality: 0.25,
        }),
      ],
      adapters: [supervisor, notification],
    });

    const response = await router.complete(modelRequest('notification'));

    expect(response.route?.routeId).toBe('notification');
    expect(supervisor.requests).toHaveLength(0);
    expect(notification.requests).toHaveLength(1);
    expect(notification.requests[0]).toMatchObject({
      provider: 'notification-provider',
      model: 'notification-model',
      task: 'notification',
    });
  });

  it('selects the cheapest otherwise adequate route and records actual-cost telemetry', async () => {
    const storage = new TestRouterStorage();
    const cheap = new RecordingModelAdapter('cheap');
    const expensive = new RecordingModelAdapter('expensive');
    const router = routerWith({
      storage,
      routes: [
        modelRoute('cheap', {
          quality: 0.6,
          inputCostPerMillion: 1,
          outputCostPerMillion: 2,
        }),
        modelRoute('expensive', {
          quality: 0.65,
          inputCostPerMillion: 100,
          outputCostPerMillion: 200,
        }),
      ],
      adapters: [cheap, expensive],
    });

    const response = await router.complete(modelRequest('summarization'));

    expect(response.route).toMatchObject({
      routeId: 'cheap',
      provider: 'cheap-provider',
      model: 'cheap-model',
      task: 'summarization',
    });
    expect(cheap.requests).toHaveLength(1);
    expect(expensive.requests).toHaveLength(0);
    expect(storage.calls).toHaveLength(1);
    expect(storage.calls[0]).toMatchObject({
      runId: 'run-local-ai',
      success: true,
      costUsd: 0.00002,
      selection: { routeId: 'cheap', task: 'summarization' },
    });
  });

  it('treats an empty OpenAI-compatible usage object as absent and charges its conservative estimate', async () => {
    const baseUrl = await startJsonServer(async () => ({
      choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: {},
    }));
    const storage = new TestRouterStorage();
    const route = modelRoute('partial-usage', {
      inputCostPerMillion: 3,
      outputCostPerMillion: 7,
    });
    const adapter = new OpenAICompatibleAdapter({ id: route.id, baseUrl });
    const router = routerWith({ storage, routes: [route], adapters: [adapter] });

    const response = await router.complete(modelRequest('summarization'));

    expect(response.usage).toBeUndefined();
    expect(response.route?.estimatedCostUsd).toBeGreaterThan(0);
    expect(storage.calls).toHaveLength(1);
    expect(storage.calls[0]?.costUsd).toBe(response.route?.estimatedCostUsd);
  });

  it('rejects a declared oversized model response before materializing its body', async () => {
    const baseUrl = await startRawServer((_request, outgoing) => {
      outgoing.writeHead(200, {
        'content-type': 'application/json',
        'content-length': String(MAX_MODEL_RESPONSE_BYTES + 1),
      });
      outgoing.end();
    });
    const adapter = new OpenAICompatibleAdapter({ baseUrl });

    await expect(adapter.complete(modelRequest('summarization'))).rejects.toThrow(
      `${MAX_MODEL_RESPONSE_BYTES}-byte limit`,
    );
  });

  it('stops a chunked model response once its decoded JSON exceeds the bound', async () => {
    const baseUrl = await startRawServer((_request, outgoing) => {
      outgoing.writeHead(200, { 'content-type': 'application/json' });
      outgoing.end(JSON.stringify({
        choices: [{
          message: { role: 'assistant', content: 'x'.repeat(MAX_MODEL_RESPONSE_BYTES) },
          finish_reason: 'stop',
        }],
      }));
    });
    const adapter = new OpenAICompatibleAdapter({ baseUrl });

    await expect(adapter.complete(modelRequest('summarization'))).rejects.toThrow(
      `${MAX_MODEL_RESPONSE_BYTES}-byte limit`,
    );
  });

  it('marks only adapter transport failures as explicitly retryable', async () => {
    const adapter = new OpenAICompatibleAdapter({ baseUrl: 'http://127.0.0.1:1/v1' });
    const error = await adapter.complete(modelRequest('summarization')).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ModelTransportError);
    expect(error).toMatchObject({ retryable: true, message: 'Model transport failed' });
  });

  it('surfaces provider redirects as non-retryable HTTP failures', async () => {
    const baseUrl = await startRawServer((_request, outgoing) => {
      outgoing.writeHead(307, { location: 'https://different-boundary.example.test/v1' });
      outgoing.end();
    });
    const adapter = new OpenAICompatibleAdapter({ baseUrl });
    const error = await adapter.complete(modelRequest('summarization')).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ModelHttpError);
    expect(error).toMatchObject({ status: 307, retryable: false });
  });

  it('rejects role drift, non-function tool calls, and incomplete text finish reasons', async () => {
    const responses = [
      {
        choices: [{ message: { role: 'user', content: 'role drift' }, finish_reason: 'stop' }],
      },
      {
        choices: [{
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'wrong-type',
              type: 'computer',
              function: { name: 'readiness_probe', arguments: '{}' },
            }],
          },
          finish_reason: 'tool_calls',
        }],
      },
      {
        choices: [{ message: { role: 'assistant', content: 'partial' }, finish_reason: 'length' }],
      },
      {
        choices: [{ message: { role: 'assistant', content: 'filtered' }, finish_reason: 'content_filter' }],
      },
    ];
    const baseUrl = await startJsonServer(async () => responses.shift());
    const adapter = new OpenAICompatibleAdapter({ baseUrl });
    const request: ModelRequest = {
      ...modelRequest('summarization'),
      tools: [{
        name: 'readiness_probe',
        description: 'Probe',
        inputSchema: { type: 'object' },
      }],
    };

    await expect(adapter.complete(request)).rejects.toThrow('message.role must be assistant');
    await expect(adapter.complete(request)).rejects.toThrow('tool call type must be function');
    await expect(adapter.complete(request)).rejects.toThrow('incomplete text with finish_reason length');
    await expect(adapter.complete(request)).rejects.toThrow(
      'incomplete text with finish_reason content_filter',
    );
  });

  it('fails closed when paid response accounting fails while keeping free local work available', async () => {
    const paidStorage = new TestRouterStorage();
    paidStorage.recordError = new Error('simulated ledger write failure');
    const paidRoute = modelRoute('paid-ledger-required');
    const paid = new RecordingModelAdapter(paidRoute.id);
    const paidRouter = routerWith({
      storage: paidStorage,
      routes: [paidRoute],
      adapters: [paid],
    });

    await expect(paidRouter.complete(modelRequest('summarization'))).rejects.toBeInstanceOf(
      ModelAccountingError,
    );
    await expect(paidRouter.complete(modelRequest('summarization'))).rejects.toBeInstanceOf(
      ModelAccountingError,
    );
    expect(paid.requests).toHaveLength(1);

    const freeStorage = new TestRouterStorage();
    freeStorage.recordError = new Error('simulated telemetry write failure');
    const freeRoute = modelRoute('free-local-ledger-optional', {
      local: true,
      inputCostPerMillion: 0,
      outputCostPerMillion: 0,
    });
    const free = new RecordingModelAdapter(freeRoute.id);
    const freeRouter = routerWith({
      storage: freeStorage,
      routes: [freeRoute],
      adapters: [free],
    });

    await expect(freeRouter.complete(modelRequest('summarization'))).resolves.toMatchObject({
      route: { routeId: freeRoute.id, estimatedCostUsd: 0 },
    });
  });

  it('uses learned route reward to change an otherwise quality-led choice', async () => {
    const routes = [
      modelRoute('baseline', {
        tasks: ['memory_curator'],
        quality: 0.55,
        local: true,
        inputCostPerMillion: 0,
        outputCostPerMillion: 0,
      }),
      modelRoute('rewarded', {
        tasks: ['memory_curator'],
        quality: 0.45,
        local: true,
        inputCostPerMillion: 0,
        outputCostPerMillion: 0,
      }),
    ];
    const baseline = new RecordingModelAdapter('baseline');
    const rewarded = new RecordingModelAdapter('rewarded');
    const neutralStorage = new TestRouterStorage();
    const neutral = routerWith({
      storage: neutralStorage,
      routes,
      adapters: [baseline, rewarded],
    });
    expect((await neutral.complete(modelRequest('memory_curator'))).route?.routeId).toBe('baseline');

    const learnedStorage = new TestRouterStorage();
    learnedStorage.stats = [
      routeStats(modelRouteStatsIdentity(routes[0]!), 'memory_curator', { rewardSum: -10, rewardCount: 10 }),
      routeStats(modelRouteStatsIdentity(routes[1]!), 'memory_curator', { rewardSum: 10, rewardCount: 10 }),
    ];
    const learned = routerWith({
      storage: learnedStorage,
      routes,
      adapters: [baseline, rewarded],
    });

    expect((await learned.complete(modelRequest('memory_curator'))).route?.routeId).toBe('rewarded');
  });

  it('resets adaptive telemetry when a route generation changes', async () => {
    const prior = modelRoute('mutable-alias', { generation: 'provider-generation-v1' });
    const current = modelRoute('mutable-alias', { generation: 'provider-generation-v2' });
    const storage = new TestRouterStorage();
    storage.stats = [routeStats(
      modelRouteStatsIdentity(prior),
      'summarization',
      { rewardSum: 10, rewardCount: 10 },
    )];
    const adapter = new RecordingModelAdapter(current.id);
    const router = routerWith({ storage, routes: [current], adapters: [adapter] });

    const response = await router.complete(modelRequest('summarization'));

    expect(response.route?.routeId).toBe('mutable-alias');
    expect(storage.calls[0]?.selection.routeId).toBe('mutable-alias');
    expect(storage.calls[0]?.statsRouteId).toBe(modelRouteStatsIdentity(current));
    expect(storage.calls[0]?.statsRouteId).not.toBe(modelRouteStatsIdentity(prior));
  });

  it('denies paid work at the daily cap while continuing through a zero-cost local route', async () => {
    const storage = new TestRouterStorage();
    storage.spendUsd = 1;
    const paidRoute = modelRoute('paid', {
      quality: 1,
      inputCostPerMillion: 20,
      outputCostPerMillion: 40,
    });
    const paid = new RecordingModelAdapter('paid');
    const paidOnly = routerWith({
      storage,
      routes: [paidRoute],
      adapters: [paid],
      dailyBudgetUsd: 1,
    });

    await expect(paidOnly.complete(modelRequest('summarization'))).rejects.toBeInstanceOf(
      ModelBudgetExceededError,
    );
    expect(paid.requests).toHaveLength(0);

    const freeRoute = modelRoute('free-local', {
      quality: 0.3,
      local: true,
      inputCostPerMillion: 0,
      outputCostPerMillion: 0,
    });
    const free = new RecordingModelAdapter('free-local');
    const withLocalFallback = routerWith({
      storage,
      routes: [paidRoute, freeRoute],
      adapters: [paid, free],
      dailyBudgetUsd: 1,
    });

    expect((await withLocalFallback.complete(modelRequest('summarization'))).route).toMatchObject({
      routeId: 'free-local',
      local: true,
      estimatedCostUsd: 0,
    });
    expect(paid.requests).toHaveLength(0);
    expect(free.requests).toHaveLength(1);
  });

  it('falls back after a route failure and records both attempts', async () => {
    const storage = new TestRouterStorage();
    const primary = new RecordingModelAdapter('primary', async () => {
      throw new ModelHttpError(503, 'primary unavailable');
    });
    const fallback = new RecordingModelAdapter('fallback');
    const router = routerWith({
      storage,
      routes: [
        modelRoute('primary', {
          quality: 1,
          local: true,
          inputCostPerMillion: 0,
          outputCostPerMillion: 0,
        }),
        modelRoute('fallback', {
          quality: 0.3,
          local: true,
          inputCostPerMillion: 0,
          outputCostPerMillion: 0,
        }),
      ],
      adapters: [primary, fallback],
    });

    const response = await router.complete(modelRequest('summarization'));

    expect(response.route).toMatchObject({
      routeId: 'fallback',
      fallbackFrom: 'primary',
    });
    expect(storage.calls.map((call) => ({
      routeId: call.selection.routeId,
      success: call.success,
      costUsd: call.costUsd,
    }))).toEqual([
      { routeId: 'primary', success: false, costUsd: 0 },
      { routeId: 'fallback', success: true, costUsd: 0 },
    ]);
  });

  it('charges a failed paid attempt before deciding whether a paid fallback still fits the budget', async () => {
    const storage = new TestRouterStorage();
    const primaryRoute = modelRoute('paid-primary', { quality: 1 });
    const fallbackRoute = modelRoute('paid-fallback', { quality: 0.3 });
    const request = modelRequest('summarization');
    const primaryEstimate = calculateUsageCostUsd(
      primaryRoute,
      estimateRequestTokens(request),
      request.maxOutputTokens,
    );
    const fallbackEstimate = calculateUsageCostUsd(
      fallbackRoute,
      estimateRequestTokens(request),
      request.maxOutputTokens,
    );
    const primary = new RecordingModelAdapter(primaryRoute.id, async () => {
      throw new ModelHttpError(503, 'provider failed after accepting the request');
    });
    const fallback = new RecordingModelAdapter(fallbackRoute.id);
    const router = routerWith({
      storage,
      routes: [primaryRoute, fallbackRoute],
      adapters: [primary, fallback],
      dailyBudgetUsd: primaryEstimate + fallbackEstimate / 2,
    });

    await expect(router.complete(request)).rejects.toBeInstanceOf(ModelBudgetExceededError);

    expect(primary.requests).toHaveLength(1);
    expect(fallback.requests).toHaveLength(0);
    expect(storage.calls).toEqual([
      expect.objectContaining({
        success: false,
        costUsd: primaryEstimate,
        selection: expect.objectContaining({ routeId: primaryRoute.id }),
      }),
    ]);
    expect(storage.spendUsd).toBe(primaryEstimate);
  });

  it('prefers a local route and never falls through to cloud unless explicitly enabled', async () => {
    const localRoute = modelRoute('local-first', {
      local: true,
      quality: 0.3,
      inputCostPerMillion: 0,
      outputCostPerMillion: 0,
    });
    const cloudRoute = modelRoute('cloud-high-quality', {
      local: false,
      quality: 1,
      inputCostPerMillion: 0,
      outputCostPerMillion: 0,
      unmetered: true,
    });
    const local = new RecordingModelAdapter(localRoute.id);
    const cloud = new RecordingModelAdapter(cloudRoute.id);
    const localFirst = routerWith({
      storage: new TestRouterStorage(),
      routes: [cloudRoute, localRoute],
      adapters: [cloud, local],
    });

    expect((await localFirst.complete(modelRequest('summarization'))).route?.routeId).toBe(
      localRoute.id,
    );
    expect(local.requests).toHaveLength(1);
    expect(cloud.requests).toEqual([]);

    const unavailableLocal = new RecordingModelAdapter(localRoute.id, async () => {
      throw new ModelHttpError(503, 'local model offline');
    });
    const closedBoundary = routerWith({
      storage: new TestRouterStorage(),
      routes: [cloudRoute, localRoute],
      adapters: [cloud, unavailableLocal],
    });
    await expect(closedBoundary.complete(modelRequest('summarization'))).rejects.toMatchObject({
      failures: [{ routeId: localRoute.id }],
    });
    expect(cloud.requests).toEqual([]);
  });

  it('uses an external fallback only after an explicit opt-in and a retryable local failure', async () => {
    const localRoute = modelRoute('local-retryable', {
      local: true,
      quality: 0.9,
      inputCostPerMillion: 0,
      outputCostPerMillion: 0,
    });
    const cloudRoute = modelRoute('cloud-fallback', {
      local: false,
      quality: 0.3,
      inputCostPerMillion: 0,
      outputCostPerMillion: 0,
      unmetered: true,
    });
    const local = new RecordingModelAdapter(localRoute.id, async () => {
      throw new ModelHttpError(503, 'retry later');
    });
    const cloud = new RecordingModelAdapter(cloudRoute.id);
    const router = routerWith({
      storage: new TestRouterStorage(),
      routes: [localRoute, cloudRoute],
      adapters: [local, cloud],
      allowRemoteFallback: true,
    });

    expect((await router.complete(modelRequest('summarization'))).route).toMatchObject({
      routeId: cloudRoute.id,
      fallbackFrom: localRoute.id,
      local: false,
    });
    expect(local.requests).toHaveLength(1);
    expect(cloud.requests).toHaveLength(1);
  });

  it('does not disclose a request to fallback when a local adapter throws an ordinary TypeError', async () => {
    const localRoute = modelRoute('local-programming-error', {
      local: true,
      quality: 0.9,
      inputCostPerMillion: 0,
      outputCostPerMillion: 0,
    });
    const cloudRoute = modelRoute('cloud-must-not-run', {
      local: false,
      quality: 0.3,
      inputCostPerMillion: 0,
      outputCostPerMillion: 0,
      unmetered: true,
    });
    const local = new RecordingModelAdapter(localRoute.id, async () => {
      throw new TypeError('local adapter programming error');
    });
    const cloud = new RecordingModelAdapter(cloudRoute.id);
    const router = routerWith({
      storage: new TestRouterStorage(),
      routes: [localRoute, cloudRoute],
      adapters: [local, cloud],
      allowRemoteFallback: true,
    });

    await expect(router.complete(modelRequest('summarization'))).rejects.toMatchObject({
      failures: [{ routeId: localRoute.id }],
    });
    expect(cloud.requests).toEqual([]);
  });

  it('keeps exploration on the selected disclosure boundary', async () => {
    const preferred = modelRoute('local-preferred', {
      local: true,
      quality: 0.8,
      inputCostPerMillion: 0,
      outputCostPerMillion: 0,
    });
    const alternate = modelRoute('local-alternate', {
      local: true,
      quality: 0.3,
      inputCostPerMillion: 0,
      outputCostPerMillion: 0,
    });
    const cloud = modelRoute('cloud-never-explored', {
      local: false,
      quality: 1,
      inputCostPerMillion: 0,
      outputCostPerMillion: 0,
      unmetered: true,
    });
    const preferredAdapter = new RecordingModelAdapter(preferred.id);
    const alternateAdapter = new RecordingModelAdapter(alternate.id);
    const cloudAdapter = new RecordingModelAdapter(cloud.id);
    const router = routerWith({
      storage: new TestRouterStorage(),
      routes: [cloud, preferred, alternate],
      adapters: [cloudAdapter, preferredAdapter, alternateAdapter],
      explorationRate: 1,
      random: () => 0,
    });

    const response = await router.complete(modelRequest('summarization'));
    expect(response.route).toMatchObject({ routeId: alternate.id, local: true });
    expect(response.route?.reason).toContain('exploration');
    expect(preferredAdapter.requests).toEqual([]);
    expect(alternateAdapter.requests).toHaveLength(1);
    expect(cloudAdapter.requests).toEqual([]);
  });

  it('validates compatible API transport, credentials, and route boundary declarations', () => {
    expect(() => validateApiBaseUrl('http://models.example.test/v1')).toThrow(
      'must use HTTPS outside loopback',
    );
    expect(() => validateApiBaseUrl('https://user:secret@models.example.test/v1')).toThrow(
      'must not contain credentials, a query, or a fragment',
    );
    expect(() => new OpenAICompatibleAdapter({
      baseUrl: 'http://127.0.0.1:8080/v1',
      apiKey: 'unsafe\nkey',
    })).toThrow('API key must be 1-4096 visible ASCII');
    expect(() => new OpenAICompatibleAdapter({
      baseUrl: 'http://127.0.0.1:8080/v1',
      headers: { Authorization: 'Bearer custom-value' },
    })).toThrow('must not override authorization');
    expect(() => new OpenAICompatibleAdapter({
      baseUrl: 'http://127.0.0.1:8080/v1',
      headers: { 'Content-Type': 'text/plain' },
    })).toThrow('must not override content-type');
    expect(() => new OpenAICompatibleAdapter({
      baseUrl: 'http://127.0.0.1:8080/v1',
      headers: { 'x-trace': 'unsafe\r\nvalue' },
    })).toThrow('must be non-empty control-free ASCII');
    expect(() => new ModelRouter({
      routes: [modelRoute('mislabeled', {
        baseUrl: 'https://models.example.test/v1',
        local: true,
        apiKeyEnv: 'MODEL_TEST_KEY',
      })],
      storage: new TestRouterStorage(),
      dailyBudgetUsd: 0,
    })).toThrow('local=true does not match its baseUrl boundary');
    expect(() => new ModelRouter({
      routes: [modelRoute('inline-secret', {
        baseUrl: 'https://models.example.test/v1',
        local: false,
        apiKey: 'inline-secret',
      })],
      storage: new TestRouterStorage(),
      dailyBudgetUsd: 0,
    })).toThrow('must use apiKeyEnv instead of an inline external API key');
    expect(() => new ModelRouter({
      routes: [modelRoute('missing-secret-env', {
        baseUrl: 'https://models.example.test/v1',
        local: false,
      })],
      storage: new TestRouterStorage(),
      dailyBudgetUsd: 0,
    })).toThrow('requires apiKeyEnv outside loopback');
    expect(() => new ModelRouter({
      routes: [modelRoute('external-denied-by-default', {
        baseUrl: 'https://models.example.test/v1',
        local: false,
        apiKeyEnv: 'MODEL_TEST_KEY',
      })],
      storage: new TestRouterStorage(),
      dailyBudgetUsd: 0,
    })).toThrow('requires externalInference: allow');
    expect(() => new ModelRouter({
      routes: [modelRoute('external-zero-price', {
        baseUrl: 'https://models.example.test/v1',
        local: false,
        apiKeyEnv: 'MODEL_TEST_KEY',
        inputCostPerMillion: 0,
        outputCostPerMillion: 0,
      })],
      storage: new TestRouterStorage(),
      dailyBudgetUsd: 0,
      externalInference: 'allow',
    })).toThrow('requires reviewed prices or unmetered: true');
    expect(() => new ModelRouter({
      routes: [modelRoute('external-reviewed-unmetered', {
        baseUrl: 'https://models.example.test/v1',
        local: false,
        apiKeyEnv: 'MODEL_TEST_KEY',
        inputCostPerMillion: 0,
        outputCostPerMillion: 0,
        unmetered: true,
      })],
      storage: new TestRouterStorage(),
      dailyBudgetUsd: 0,
      externalInference: 'allow',
    })).not.toThrow();
    const missingGeneration = modelRoute('external-missing-generation', {
      baseUrl: 'https://models.example.test/v1',
      local: false,
      apiKeyEnv: 'MODEL_TEST_KEY',
    });
    delete missingGeneration.generation;
    expect(() => new ModelRouter({
      routes: [missingGeneration],
      storage: new TestRouterStorage(),
      dailyBudgetUsd: 10,
      externalInference: 'allow',
    })).toThrow('requires an immutable generation identifier');
  });
});

describe('local whisper.cpp transcription', () => {
  it('fails closed when transcription is disabled', async () => {
    const adapter = new DisabledTranscriptionAdapter();
    await expect(adapter.transcribe('/does/not/matter.wav')).rejects.toBeInstanceOf(
      TranscriptionDisabledError,
    );
  });

  it('passes metacharacter paths as inert arguments and removes its temporary workspace', async () => {
    const fixture = await transcriptionFixture();
    const markerName = `openprojects-shell-${randomUUID()}`;
    const markerPath = resolve(markerName);
    cleanupPaths.add(markerPath);
    const inputPath = join(fixture.root, `audio;touch ${markerName};#.wav`);
    const ffmpegLog = join(fixture.root, 'ffmpeg-args.json');
    const whisperLog = join(fixture.root, 'whisper-args.json');
    await writeFile(inputPath, 'not real audio');
    const ffmpegScript = await executableScript(
      fixture.root,
      'fake-ffmpeg.cjs',
      fakeFfmpegSource(ffmpegLog),
    );
    const whisperScript = await executableScript(
      fixture.root,
      'fake-whisper.cjs',
      successfulWhisperSource(whisperLog),
    );
    const adapter = new WhisperCppTranscriptionAdapter({
      command: process.execPath,
      commandArgs: [whisperScript],
      ffmpegCommand: process.execPath,
      ffmpegCommandArgs: [ffmpegScript],
      modelPath: fixture.modelPath,
      language: 'en',
      // Two real sibling Node fixtures can be scheduler-delayed by the full
      // parallel suite; the dedicated hanging-process case below owns timeout
      // enforcement coverage.
      timeoutMs: 5_000,
      maxBytes: 1_024,
    });

    const result = await adapter.transcribe(inputPath);
    const ffmpegArgs = JSON.parse(await readFile(ffmpegLog, 'utf8')) as string[];
    const whisperArgs = JSON.parse(await readFile(whisperLog, 'utf8')) as string[];
    const outputPrefix = argumentAfter(whisperArgs, '-of');
    const workDirectory = dirname(outputPrefix);
    cleanupPaths.add(workDirectory);

    expect(result).toMatchObject({
      text: 'safe local transcript',
      language: 'en',
      model: await realpath(fixture.modelPath),
    });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(argumentAfter(ffmpegArgs, '-i')).toBe(await realpath(inputPath));
    expect(argumentAfter(whisperArgs, '-l')).toBe('en');
    expect(existsSync(markerPath)).toBe(false);
    expect(existsSync(workDirectory)).toBe(false);
  });

  it('terminates a hanging whisper process at the deadline and still removes temporary files', async () => {
    const fixture = await transcriptionFixture();
    const inputPath = join(fixture.root, 'audio.wav');
    const whisperLog = join(fixture.root, 'hanging-whisper-args.json');
    await writeFile(inputPath, 'not real audio');
    const ffmpegScript = await executableScript(
      fixture.root,
      'fake-ffmpeg.cjs',
      fakeFfmpegSource(join(fixture.root, 'timeout-ffmpeg-args.json')),
    );
    const whisperScript = await executableScript(
      fixture.root,
      'hanging-whisper.cjs',
      hangingWhisperSource(whisperLog),
    );
    const adapter = new WhisperCppTranscriptionAdapter({
      command: process.execPath,
      commandArgs: [whisperScript],
      ffmpegCommand: process.execPath,
      ffmpegCommandArgs: [ffmpegScript],
      modelPath: fixture.modelPath,
      // Leave enough startup headroom when Vitest runs every file in parallel;
      // the timeout must exercise the hanging whisper process, not Node startup.
      timeoutMs: 2_500,
      maxBytes: 1_024,
    });
    const startedAt = Date.now();

    await expect(adapter.transcribe(inputPath)).rejects.toBeInstanceOf(TranscriptionTimeoutError);
    expect(Date.now() - startedAt).toBeLessThan(4_500);
    const whisperArgs = JSON.parse(await readFile(whisperLog, 'utf8')) as string[];
    const workDirectory = dirname(argumentAfter(whisperArgs, '-of'));
    cleanupPaths.add(workDirectory);
    expect(existsSync(workDirectory)).toBe(false);
  });
});

type RouteCall = Parameters<ModelRouterStorage['recordModelRouteCall']>[0];

class TestRouterStorage implements ModelRouterStorage {
  readonly calls: RouteCall[] = [];
  stats: ModelRouteStats[] = [];
  spendUsd = 0;
  recordError: Error | undefined;

  modelRouteStats(
    task: ModelTask,
    _runId?: string,
    statsRouteIds?: readonly string[],
  ): ModelRouteStats[] {
    const allowed = statsRouteIds ? new Set(statsRouteIds) : undefined;
    return this.stats.filter((stats) => stats.task === task && (!allowed || allowed.has(stats.routeId)));
  }

  recordModelRouteCall(input: RouteCall): void {
    if (this.recordError) throw this.recordError;
    this.calls.push(input);
    this.spendUsd += input.costUsd;
  }

  modelSpendSince(_since: string): number {
    return this.spendUsd;
  }
}

class RecordingModelAdapter implements ModelAdapter {
  readonly requests: ModelRequest[] = [];

  constructor(
    readonly id: string,
    readonly handler: (request: ModelRequest) => Promise<ModelResponse> = async () => ({
      message: { role: 'assistant', content: 'ok' },
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    }),
  ) {}

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    return this.handler(request);
  }
}

function routerWith(options: {
  storage: TestRouterStorage;
  routes: ModelRouteConfig[];
  adapters: ModelAdapter[];
  dailyBudgetUsd?: number;
  explorationRate?: number;
  preferLocal?: boolean;
  allowRemoteFallback?: boolean;
  externalInference?: 'deny' | 'allow';
  random?: () => number;
}): ModelRouter {
  return new ModelRouter({
    routes: options.routes,
    storage: options.storage,
    dailyBudgetUsd: options.dailyBudgetUsd ?? 10,
    explorationRate: options.explorationRate ?? 0,
    preferLocal: options.preferLocal ?? true,
    allowRemoteFallback: options.allowRemoteFallback ?? false,
    externalInference: options.externalInference
      ?? (options.routes.some((route) => route.enabled && !route.local) ? 'allow' : 'deny'),
    ...(options.random ? { random: options.random } : {}),
    adapters: new Map(options.adapters.map((adapter) => [adapter.id, adapter])),
  });
}

function modelRoute(
  id: string,
  overrides: Partial<Omit<ModelRouteConfig, 'id'>> = {},
): ModelRouteConfig {
  return {
    id,
    provider: `${id}-provider`,
    model: `${id}-model`,
    generation: 'test-generation-v1',
    tasks: ['summarization'],
    local: false,
    enabled: true,
    quality: 0.5,
    inputCostPerMillion: 1,
    outputCostPerMillion: 2,
    contextWindow: 8_192,
    ...overrides,
  };
}

function modelRequest(task: ModelTask): ModelRequest {
  return {
    runId: 'run-local-ai',
    provider: 'router',
    model: 'auto',
    task,
    messages: [{ role: 'user', content: 'Summarize this project update.' }],
    tools: [],
    maxOutputTokens: 128,
    signal: new AbortController().signal,
  };
}

function routeStats(
  routeId: string,
  task: ModelTask,
  overrides: Partial<ModelRouteStats> = {},
): ModelRouteStats {
  return {
    routeId,
    task,
    attempts: 10,
    successes: 10,
    rewardSum: 0,
    rewardCount: 0,
    costUsd: 0,
    latencyMs: 1_000,
    updatedAt: '2026-08-25T00:00:00.000Z',
    ...overrides,
  };
}

async function startJsonServer(
  response: (url: string, body: unknown, request: IncomingMessage) => Promise<unknown>,
): Promise<string> {
  const server = createServer(async (request, outgoing) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const rawBody = Buffer.concat(chunks).toString('utf8');
      const body = rawBody ? JSON.parse(rawBody) as unknown : undefined;
      const value = await response(request.url ?? '/', body, request);
      outgoing.writeHead(200, { 'content-type': 'application/json' });
      outgoing.end(JSON.stringify(value));
    } catch (error) {
      outgoing.writeHead(500, { 'content-type': 'application/json' });
      outgoing.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    const error = (cause: Error): void => rejectListen(cause);
    server.once('error', error);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', error);
      resolveListen();
    });
  });
  openServers.add(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test HTTP server has no TCP address');
  return `http://127.0.0.1:${address.port}`;
}

async function startRawServer(
  response: (request: IncomingMessage, outgoing: ServerResponse) => void,
): Promise<string> {
  const server = createServer(response);
  await new Promise<void>((resolveListen, rejectListen) => {
    const error = (cause: Error): void => rejectListen(cause);
    server.once('error', error);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', error);
      resolveListen();
    });
  });
  openServers.add(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test HTTP server has no TCP address');
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
  });
}

async function transcriptionFixture(): Promise<{ root: string; modelPath: string }> {
  const root = await mkdtemp(join(tmpdir(), 'openprojects-local-ai-test-'));
  cleanupPaths.add(root);
  const modelPath = join(root, 'model.bin');
  await writeFile(modelPath, 'fake model');
  return { root, modelPath };
}

async function executableScript(root: string, name: string, source: string): Promise<string> {
  const path = join(root, name);
  await writeFile(path, source, 'utf8');
  await chmod(path, 0o700);
  return path;
}

function fakeFfmpegSource(logPath: string): string {
  return `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(logPath)}, JSON.stringify(args));
const inputIndex = args.indexOf('-i');
if (inputIndex < 0 || !args[inputIndex + 1] || !args.at(-1)) process.exit(2);
fs.copyFileSync(args[inputIndex + 1], args.at(-1));
`;
}

function successfulWhisperSource(logPath: string): string {
  return `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(logPath)}, JSON.stringify(args));
const outputIndex = args.indexOf('-of');
if (outputIndex < 0 || !args[outputIndex + 1]) process.exit(2);
fs.writeFileSync(args[outputIndex + 1] + '.txt', 'safe local transcript\\n');
`;
}

function hangingWhisperSource(logPath: string): string {
  return `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(logPath)}, JSON.stringify(process.argv.slice(2)));
setInterval(() => {}, 1000);
`;
}

function argumentAfter(args: string[], flag: string): string {
  const index = args.indexOf(flag);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value) throw new Error(`Missing ${flag} argument in ${JSON.stringify(args)}`);
  return value;
}
