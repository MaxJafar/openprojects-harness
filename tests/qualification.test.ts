import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, chmod, link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import YAML from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';

import { formatEmbeddingQuery } from '../src/adapters/embeddings.js';
import type { AppConfig } from '../src/core/types.js';
import {
  loadQualificationManifest,
  renderApplianceQualification,
  runApplianceQualification,
  validateMlxVlmBaseUrl,
  type ApplianceQualificationManifest,
} from '../src/qualification/index.js';

const servers = new Set<Server>();
const temporaryPaths = new Set<string>();

afterEach(async () => {
  for (const server of servers) await closeServer(server);
  servers.clear();
  for (const path of temporaryPaths) await rm(path, { recursive: true, force: true });
  temporaryPaths.clear();
});

describe('private appliance qualification', () => {
  it('reports feature hashing but refuses to qualify it as semantic embeddings', async () => {
    const report = await runApplianceQualification(baseConfig(), {
      now: () => new Date('2026-08-25T12:00:00.000Z'),
      requiredCapabilities: ['embeddings'],
    });

    expect(report).toMatchObject({
      schema: 'openprojects.appliance-qualification-report.v1',
      generatedAt: '2026-08-25T12:00:00.000Z',
      overall: 'partial',
      nonMutatingIntent: true,
      persistentHarnessStateWritesAttempted: false,
      downloadsAttempted: false,
      requiredCapabilities: ['embeddings'],
    });
    expect(target(report, 'embeddings')).toMatchObject({
      configured: true,
      reachable: true,
      identityQualified: true,
      stage: 'reachable',
      provider: 'builtin',
      capabilityQualified: false,
      qualified: false,
    });
    expect(target(report, 'transcription')).toMatchObject({ configured: false, required: false });
    expect(renderApplianceQualification(report)).toContain('no persistent harness-state writes or pull/install requests issued');
  });

  it('rejects finite normalized vectors that do not demonstrate semantic ranking', async () => {
    const digest = 'c'.repeat(64);
    const baseUrl = await startJsonServer(async (request) => {
      if (request.url === '/api/tags') {
        return { models: [{ model: 'qwen3-embedding:0.6b', digest }] };
      }
      if (request.url === '/api/embed') {
        return {
          model: 'qwen3-embedding:0.6b',
          embeddings: Array.from({ length: 12 }, () => [1, 0, 0, 0, 0, 0, 0, 0]),
        };
      }
      return { error: 'unexpected' };
    });
    const config = baseConfig();
    config.embeddings = {
      provider: 'ollama',
      model: 'qwen3-embedding:0.6b',
      baseUrl,
      serviceDigest: digest,
      dimensions: 8,
      timeoutMs: 2_000,
    };
    const report = await runApplianceQualification(config, {
      requiredCapabilities: ['embeddings'],
      manifest: {
        schema: 'openprojects.appliance-qualification.v1',
        requiredCapabilities: ['embeddings'],
        requirePins: true,
        pins: { embeddings: { provider: 'ollama', model: 'qwen3-embedding:0.6b', serviceDigest: digest } },
      },
      timeoutMs: 2_000,
    });

    expect(report.overall).toBe('not_qualified');
    expect(target(report, 'embeddings')).toMatchObject({
      reachable: false,
      capabilityQualified: false,
      qualified: false,
    });
    expect(target(report, 'embeddings')?.detail).toContain('Semantic embedding ranking margin is too small');
  });

  it('rejects distinct normalized vectors when their ordering carries no semantic ranking signal', async () => {
    const digest = 'd'.repeat(64);
    const baseUrl = await startJsonServer(async (request) => {
      if (request.url === '/api/tags') {
        return { models: [{ model: 'qwen3-embedding:0.6b', digest }] };
      }
      if (request.url === '/api/embed') {
        return {
          model: 'qwen3-embedding:0.6b',
          embeddings: Array.from({ length: 12 }, (_, row) => (
            Array.from({ length: 16 }, (_, column) => row === column ? 1 : 0)
          )),
        };
      }
      return { error: 'unexpected' };
    });
    const config = baseConfig();
    config.embeddings = {
      provider: 'ollama',
      model: 'qwen3-embedding:0.6b',
      baseUrl,
      serviceDigest: digest,
      dimensions: 16,
      timeoutMs: 2_000,
    };

    const report = await runApplianceQualification(config, {
      requiredCapabilities: ['embeddings'],
      manifest: embeddingManifest(digest),
      timeoutMs: 2_000,
    });

    expect(report.overall).toBe('not_qualified');
    expect(target(report, 'embeddings')).toMatchObject({
      reachable: false,
      capabilityQualified: false,
      qualified: false,
    });
    expect(target(report, 'embeddings')?.detail).toContain('minimum 0.000, mean 0.000');
  });

  it('instructs only Qwen retrieval queries while leaving positive and negative documents raw', async () => {
    const digest = 'e'.repeat(64);
    let inputs: string[] = [];
    const baseUrl = await startJsonServer(async (request, body) => {
      if (request.url === '/api/tags') {
        return { models: [{ model: 'qwen3-embedding:0.6b', digest }] };
      }
      if (request.url === '/api/embed' && isRecord(body) && Array.isArray(body.input)) {
        inputs = body.input.filter((value): value is string => typeof value === 'string');
        return semanticEmbeddingResponse(8);
      }
      return { error: 'unexpected' };
    });
    const config = baseConfig();
    config.embeddings = {
      provider: 'ollama',
      model: 'qwen3-embedding:0.6b',
      baseUrl,
      serviceDigest: digest,
      dimensions: 8,
      timeoutMs: 2_000,
    };

    const report = await runApplianceQualification(config, {
      requiredCapabilities: ['embeddings'],
      manifest: embeddingManifest(digest),
      timeoutMs: 2_000,
    });

    expect(report.overall).toBe('qualified');
    expect(inputs).toHaveLength(12);
    expect(inputs[0]).toBe(formatEmbeddingQuery(
      'qwen3-embedding:0.6b',
      'Which issue is blocking the production credentials for Atlas?',
    ));
    expect(inputs[1]).toBe('Security approval is blocking production API credentials.');
    expect(inputs[2]).toBe('The customer demo remains scheduled for Friday.');
    expect(inputs.filter((_, index) => index % 3 === 0)).toSatisfy(
      (queries: string[]) => queries.every((query) => query.startsWith('Instruct: ') && query.includes('\nQuery:')),
    );
    expect(inputs.filter((_, index) => index % 3 !== 0)).toSatisfy(
      (documents: string[]) => documents.every((document) => !document.startsWith('Instruct: ')),
    );
  });

  it('CLI leaves the configured SQLite path untouched and exits nonzero unless the selected lane qualifies', async () => {
    const root = await temporaryDirectory();
    const database = join(root, 'missing-state', 'harness.sqlite');
    const configPath = join(root, 'openprojects.yaml');
    const config = baseConfig();
    config.storage.database = database;
    await writeFile(configPath, YAML.stringify(config));

    const failed = await runQualificationCli([
      'qualify', '--config', configPath, '--require', 'embeddings', '--json', '--timeout-ms', '2000',
    ]);
    expect(failed.code).toBe(1);
    expect(JSON.parse(failed.stdout)).toMatchObject({ overall: 'partial' });
    await expect(access(database)).rejects.toThrow();

    const embeddingDigest = 'a'.repeat(64);
    const baseUrl = await startJsonServer(async (request) => {
      if (request.url === '/api/tags') {
        return { models: [{ model: 'qwen3-embedding:0.6b', digest: embeddingDigest }] };
      }
      if (request.url === '/api/embed') return semanticEmbeddingResponse(8);
      return { error: 'unexpected' };
    });
    config.embeddings = {
      provider: 'ollama',
      model: 'qwen3-embedding:0.6b',
      baseUrl,
      dimensions: 8,
      timeoutMs: 2_000,
      serviceDigest: embeddingDigest,
    };
    await writeFile(configPath, YAML.stringify(config));
    const manifestPath = join(root, 'qualification.json');
    await writeFile(manifestPath, JSON.stringify({
      schema: 'openprojects.appliance-qualification.v1',
      requiredCapabilities: ['embeddings'],
      requirePins: true,
      pins: {
        embeddings: {
          provider: 'ollama',
          model: 'qwen3-embedding:0.6b',
          serviceDigest: embeddingDigest,
        },
      },
    }));

    const passed = await runQualificationCli([
      'qualify', '--config', configPath, '--manifest', manifestPath, '--json', '--timeout-ms', '2000',
    ]);
    expect(passed.code, passed.stderr).toBe(0);
    expect(JSON.parse(passed.stdout)).toMatchObject({ overall: 'qualified' });
    await expect(access(database)).rejects.toThrow();
  });

  it('ships conservative launchd assets with immutable trust paths and supported MLX invocation', async () => {
    const [harness, mlx, qualify] = await Promise.all([
      readFile(join(process.cwd(), 'deploy/launchd/com.openprojects.harness.plist.example'), 'utf8'),
      readFile(join(process.cwd(), 'deploy/launchd/com.openprojects.mlx-lm.plist.example'), 'utf8'),
      readFile(join(process.cwd(), 'deploy/launchd/com.openprojects.qualify.plist.example'), 'utf8'),
    ]);
    expect(harness).not.toContain('<key>KeepAlive</key>');
    expect(harness).toContain('/Library/OpenProjects/etc/openprojects.local.yaml');
    expect(qualify).toContain('/Library/OpenProjects/etc/appliance-qualification.json');
    expect(mlx).toContain('<string>mlx_lm</string>\n    <string>server</string>');
    expect(mlx).not.toContain('mlx_lm.server');
    expect(mlx).toContain('/Library/OpenProjects/models/Qwen3-1.7B-4bit');
    expect(mlx).toContain('<string>--prompt-cache-bytes</string>');
    expect(mlx).toContain('<key>HF_HUB_CACHE</key>\n    <string>/Library/Application Support/OpenProjects/cache/huggingface/hub</string>');
    expect(`${harness}${mlx}${qualify}`).not.toContain('/Library/Application Support/OpenProjects/models');
  });

  it('directly qualifies MLX text/tool and separate VLM lanes plus Ollama embeddings', async () => {
    const root = await temporaryDirectory();
    const textSnapshot = join(root, 'text-snapshot');
    const visionSnapshot = join(root, 'vision-snapshot');
    const [textArtifacts, visionArtifacts] = await Promise.all([
      createMlxSnapshot(textSnapshot, 'mlx text', false),
      createMlxSnapshot(visionSnapshot, 'mlx vision', true),
    ]);
    const requests: Array<{ lane: 'text' | 'shared'; path: string; body: unknown }> = [];
    const textBaseUrl = await startJsonServer(async (request, body) => {
      requests.push({ lane: 'text', path: request.url ?? '', body });
      if (request.url === '/health') return { status: 'ok' };
      if (request.url === '/v1/models') return { data: [{ id: textSnapshot }] };
      if (request.url === '/v1/chat/completions' && isRecord(body)) {
        const messages = Array.isArray(body.messages) ? body.messages : [];
        const first = isRecord(messages[0]) ? messages[0] : {};
        const last = isRecord(messages.at(-1)) ? messages.at(-1) as Record<string, unknown> : {};
        if (last.role === 'tool') {
          return { model: 'default_model', choices: [{ message: { role: 'assistant', content: 'Tool result accepted.' } }] };
        }
        if (!Array.isArray(body.tools) || body.tools.length === 0) {
          return { model: 'default_model', choices: [{ message: { role: 'assistant', content: 'Ready.' } }] };
        }
        const content = typeof first.content === 'string' ? first.content : '';
        const nonce = content.match(/OP_[a-f0-9]{16}/u)?.[0] ?? 'missing';
        return {
          model: 'default_model',
          choices: [{
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{
                id: 'call_qualification',
                type: 'function',
                function: { name: 'qualification_echo', arguments: JSON.stringify({ value: nonce }) },
              }],
            },
          }],
        };
      }
      return { error: 'unexpected text route' };
    });
    const baseUrl = await startJsonServer(async (request, body) => {
      requests.push({ lane: 'shared', path: request.url ?? '', body });
      if (request.url === '/health') return { status: 'healthy', loaded_model: visionSnapshot };
      if (request.url === '/v1/models') return { data: [{ id: visionSnapshot }] };
      if (request.url === '/api/tags') {
        return { models: [{ model: 'qwen3-embedding:0.6b', digest: 'b'.repeat(64) }] };
      }
      if (request.url === '/api/embed') {
        return semanticEmbeddingResponse(3);
      }
      if (request.url === '/v1/chat/completions' && isRecord(body)) {
        const messages = Array.isArray(body.messages) ? body.messages : [];
        const first = isRecord(messages[0]) ? messages[0] : {};
        const last = isRecord(messages.at(-1)) ? messages.at(-1) as Record<string, unknown> : {};
        if (Array.isArray(first.content)) {
          const imagePart = isRecord(first.content[1]) && isRecord(first.content[1].image_url)
            ? first.content[1].image_url.url
            : undefined;
          const observedColor = typeof imagePart === 'string' && imagePart.includes('AAAAJ0lEQ') ? 'RED' : 'BLUE';
          return {
            model: visionSnapshot,
            choices: [{ message: { role: 'assistant', content: observedColor } }],
          };
        }
        const model = typeof body.model === 'string' ? body.model : 'default_model';
        if (last.role === 'tool') {
          return { model, choices: [{ message: { role: 'assistant', content: 'Tool result accepted.' } }] };
        }
        if (!Array.isArray(body.tools) || body.tools.length === 0) {
          return { model, choices: [{ message: { role: 'assistant', content: 'Ready.' } }] };
        }
        const content = typeof first.content === 'string' ? first.content : '';
        const nonce = content.match(/OP_[a-f0-9]{16}/u)?.[0] ?? 'missing';
        return {
          model,
          choices: [{
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{
                id: 'call_qualification',
                type: 'function',
                function: { name: 'qualification_echo', arguments: JSON.stringify({ value: nonce }) },
              }],
            },
          }],
        };
      }
      return { error: 'unexpected route' };
    });
    const config = baseConfig();
    config.model = {
      provider: 'mlx-lm',
      model: 'mlx-community/Qwen3-1.7B-4bit',
      baseUrl: `${textBaseUrl}/v1`,
    };
    config.embeddings = {
      provider: 'ollama',
      model: 'qwen3-embedding:0.6b',
      baseUrl,
      dimensions: 3,
      timeoutMs: 2_000,
      serviceDigest: 'b'.repeat(64),
    };
    const manifest: ApplianceQualificationManifest = {
      schema: 'openprojects.appliance-qualification.v1',
      requiredCapabilities: ['text', 'vision', 'embeddings'],
      requirePins: true,
      visionService: {
        provider: 'mlx-vlm',
        model: 'mlx-community/Qwen3.5-2B-Vision-4bit',
        baseUrl: `${baseUrl}/v1`,
      },
      pins: {
        model: {
          provider: 'mlx-lm',
          model: 'mlx-community/Qwen3-1.7B-4bit',
          servedModelId: textSnapshot,
          artifacts: textArtifacts,
          maxContextTokens: 8_192,
          maxConcurrency: 1,
        },
        vision: {
          provider: 'mlx-vlm',
          model: 'mlx-community/Qwen3.5-2B-Vision-4bit',
          servedModelId: visionSnapshot,
          artifacts: visionArtifacts,
          maxContextTokens: 8_192,
          maxConcurrency: 1,
        },
        embeddings: {
          provider: 'ollama',
          model: 'qwen3-embedding:0.6b',
          serviceDigest: 'b'.repeat(64),
        },
      },
    };

    const report = await runApplianceQualification(config, { manifest, timeoutMs: 2_000, random: () => 0.3 });

    expect(report.overall, JSON.stringify(report, null, 2)).toBe('qualified');
    for (const id of ['model', 'vision', 'embeddings']) {
      expect(target(report, id)).toMatchObject({
        configured: true,
        reachable: true,
        capabilityQualified: true,
        identityQualified: true,
        qualified: true,
      });
    }
    const visionRequest = requests.find(({ lane, path, body }) => (
      lane === 'shared'
      && path === '/v1/chat/completions'
      && isRecord(body)
      && Array.isArray(body.messages)
      && isRecord(body.messages[0])
      && Array.isArray(body.messages[0].content)
    ));
    const visionRequests = requests.filter(({ lane, path }) => lane === 'shared' && path === '/v1/chat/completions');
    expect(visionRequests).toHaveLength(3);
    expect(JSON.stringify(visionRequests[0]?.body)).toContain('AAAAJ0lEQ');
    expect(JSON.stringify(visionRequest?.body)).toContain('data:image/png;base64,');
    expect(visionRequest?.body).toMatchObject({ model: visionSnapshot });
    expect(JSON.stringify(visionRequest?.body)).not.toContain('http://');
    expect(new Set(visionRequests.map(({ body }) => JSON.stringify(body))).size).toBe(2);
    expect(JSON.stringify(visionRequests.map(({ body }) => body))).not.toMatch(/Reply with only (?:BLUE|RED)/u);
    const textBodies = requests
      .filter(({ lane, path, body }) => lane === 'text' && path === '/v1/chat/completions' && isRecord(body))
      .map(({ body }) => body as Record<string, unknown>)
      .filter((body) => {
        const messages = Array.isArray(body.messages) ? body.messages : [];
        const first = isRecord(messages[0]) ? messages[0] : {};
        return !Array.isArray(first.content);
      });
    expect(textBodies).toHaveLength(3);
    expect(textBodies.some((body) => 'model' in body)).toBe(false);
    const finalMessages = Array.isArray(textBodies[2]?.messages) ? textBodies[2].messages : [];
    expect(finalMessages).toHaveLength(3);
    expect(finalMessages.at(-1)).toMatchObject({ role: 'tool', name: 'qualification_echo' });
    expect(report.caveats.join(' ')).toContain('product image ingestion is not implemented');
  });

  it('accepts only an exact loopback HTTP /v1 root for MLX-VLM', () => {
    expect(validateMlxVlmBaseUrl('http://127.0.0.1:8080/v1/')).toBe('http://127.0.0.1:8080/v1');
    expect(validateMlxVlmBaseUrl('http://[::1]:8080/v1')).toBe('http://[::1]:8080/v1');
    for (const invalid of [
      'https://127.0.0.1:8080/v1',
      'http://192.168.1.10:8080/v1',
      'http://127.0.0.1:8080',
      'http://127.0.0.1:8080/v1/models',
      'http://user:secret@127.0.0.1:8080/v1',
      'http://127.0.0.1:8080/v1?model=other',
    ]) {
      expect(() => validateMlxVlmBaseUrl(invalid), invalid).toThrow();
    }
  });

  it('stops MLX-VLM discovery unless health names the exact loaded snapshot', async () => {
    const root = await temporaryDirectory();
    const snapshot = join(root, 'vision-snapshot');
    const artifacts = await createMlxSnapshot(snapshot, 'health-identity', true);
    let inventoryCalls = 0;
    const baseUrl = await startJsonServer(async (request) => {
      if (request.url === '/health') return { status: 'healthy', loaded_model: `${snapshot}-other` };
      if (request.url === '/v1/models') inventoryCalls += 1;
      return { data: [{ id: snapshot }] };
    });
    const manifest = visionManifest(baseUrl, snapshot, artifacts);

    const report = await runApplianceQualification(baseConfig(), { manifest, timeoutMs: 2_000 });

    expect(inventoryCalls).toBe(0);
    expect(target(report, 'vision')).toMatchObject({ reachable: false, qualified: false });
    expect(target(report, 'vision')?.detail).toContain('status healthy and the exact canonical loaded_model');
  });

  it('rejects duplicate JSON keys across health, inventory, and capability responses', async () => {
    const root = await temporaryDirectory();
    const snapshot = join(root, 'vision-snapshot');
    const artifacts = await createMlxSnapshot(snapshot, 'duplicate-service-json', true);
    const encodedSnapshot = JSON.stringify(snapshot);
    const validHealth = `{"status":"healthy","loaded_model":${encodedSnapshot}}`;
    const validModels = `{"data":[{"id":${encodedSnapshot}}]}`;
    const scenarios = [
      {
        name: 'health status',
        path: '/health',
        raw: `{"status":"ok","status":"healthy","loaded_model":${encodedSnapshot}}`,
      },
      {
        name: 'health loaded_model',
        path: '/health',
        raw: `{"status":"healthy","loaded_model":${encodedSnapshot},"loaded_model":"/other"}`,
      },
      {
        name: 'inventory data',
        path: '/v1/models',
        raw: `{"data":[{"id":${encodedSnapshot}}],"data":[{"id":"/other"}]}`,
      },
      {
        name: 'inventory id',
        path: '/v1/models',
        raw: `{"data":[{"id":${encodedSnapshot},"id":"/other"}]}`,
      },
      {
        name: 'capability model',
        path: '/v1/chat/completions',
        raw: `{"model":${encodedSnapshot},"model":"/other","choices":[]}`,
      },
    ] as const;

    for (const scenario of scenarios) {
      const request: typeof fetch = async (input) => {
        const url = String(input);
        const raw = url.endsWith(scenario.path)
          ? scenario.raw
          : url.endsWith('/health')
            ? validHealth
            : url.endsWith('/v1/models')
              ? validModels
              : `{"model":${encodedSnapshot},"choices":[{"message":{"role":"assistant","content":"BLUE"}}]}`;
        return new Response(raw, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      };
      const report = await runApplianceQualification(baseConfig(), {
        manifest: visionManifest('http://127.0.0.1:8080', snapshot, artifacts),
        fetch: request,
        timeoutMs: 2_000,
      });
      expect(target(report, 'vision'), scenario.name).toMatchObject({ qualified: false });
      expect(target(report, 'vision')?.detail, scenario.name).toContain('invalid or duplicate JSON keys');
    }
  });

  it('makes zero vision requests when a declared credential environment variable is missing', async () => {
    const root = await temporaryDirectory();
    const snapshot = join(root, 'vision-snapshot');
    const artifacts = await createMlxSnapshot(snapshot, 'missing-credential', true);
    let requests = 0;
    const baseUrl = await startJsonServer(async () => {
      requests += 1;
      return {};
    });
    const variable = 'OPENPROJECTS_QUALIFICATION_MISSING_VISION_KEY';
    const previous = process.env[variable];
    delete process.env[variable];
    try {
      const manifest = visionManifest(baseUrl, snapshot, artifacts);
      manifest.visionService!.apiKeyEnv = variable;
      const report = await runApplianceQualification(baseConfig(), { manifest, timeoutMs: 2_000 });
      expect(requests).toBe(0);
      expect(target(report, 'vision')).toMatchObject({ configured: true, reachable: false, qualified: false });
      expect(target(report, 'vision')?.detail).toContain(variable);
    } finally {
      if (previous === undefined) delete process.env[variable];
      else process.env[variable] = previous;
    }
  });

  it('requires singleton inventory and exact completion identity for MLX-VLM', async () => {
    const root = await temporaryDirectory();
    const snapshot = join(root, 'vision-snapshot');
    const artifacts = await createMlxSnapshot(snapshot, 'exact-identity', true);
    let chatCalls = 0;
    const multiBaseUrl = await startJsonServer(async (request) => {
      if (request.url === '/health') return { status: 'healthy', loaded_model: snapshot };
      if (request.url === '/v1/models') return { data: [{ id: snapshot }, { id: `${snapshot}-other` }] };
      chatCalls += 1;
      return {};
    });

    const multi = await runApplianceQualification(baseConfig(), {
      manifest: visionManifest(multiBaseUrl, snapshot, artifacts),
      timeoutMs: 2_000,
    });
    expect(chatCalls).toBe(0);
    expect(target(multi, 'vision')?.detail).toContain('/models must list exactly one');

    const wrongResponseBaseUrl = await startJsonServer(async (request, body) => {
      if (request.url === '/health') return { status: 'healthy', loaded_model: snapshot };
      if (request.url === '/v1/models') return { data: [{ id: snapshot }] };
      chatCalls += 1;
      const color = JSON.stringify(body).includes('AAAAJ0lEQ') ? 'RED' : 'BLUE';
      return {
        model: `${snapshot}-alias`,
        choices: [{ message: { role: 'assistant', content: color } }],
      };
    });
    const wrongResponse = await runApplianceQualification(baseConfig(), {
      manifest: visionManifest(wrongResponseBaseUrl, snapshot, artifacts),
      timeoutMs: 2_000,
    });
    expect(target(wrongResponse, 'vision')).toMatchObject({ reachable: true, qualified: false });
    expect(target(wrongResponse, 'vision')?.detail).toContain('exact pinned /models identity');
  });

  it('reports hash-bound MLX-VLM runtime evidence and rejects later tampering', async () => {
    const root = await temporaryDirectory();
    const snapshot = join(root, 'vision-snapshot');
    const artifacts = await createMlxSnapshot(snapshot, 'runtime-evidence', true);
    const runtimePath = join(root, 'mlx-vlm.runtime.lock');
    const runtimeContents = 'mlx-vlm==0.1.18\nmlx==0.29.1\n';
    await writeFile(runtimePath, runtimeContents);
    const baseUrl = await startJsonServer(async (request, body) => {
      if (request.url === '/health') return { status: 'healthy', loaded_model: snapshot };
      if (request.url === '/v1/models') return { data: [{ id: snapshot }] };
      const color = JSON.stringify(body).includes('AAAAJ0lEQ') ? 'RED' : 'BLUE';
      return { model: snapshot, choices: [{ message: { role: 'assistant', content: color } }] };
    });
    const manifest = visionManifest(baseUrl, snapshot, artifacts, {
      implementation: 'mlx-vlm',
      version: '0.1.18',
      artifacts: [{ path: runtimePath, sha256: sha256(runtimeContents) }],
    });

    const qualified = await runApplianceQualification(baseConfig(), { manifest, timeoutMs: 2_000 });
    expect(target(qualified, 'vision')).toMatchObject({
      qualified: true,
      identity: {
        runtimeEvidence: {
          implementation: 'mlx-vlm',
          version: '0.1.18',
          artifacts: [{ path: runtimePath, sha256: sha256(runtimeContents) }],
        },
      },
    });

    await writeFile(runtimePath, 'mlx-vlm==tampered\n');
    const tampered = await runApplianceQualification(baseConfig(), { manifest, timeoutMs: 2_000 });
    expect(target(tampered, 'vision')).toMatchObject({ reachable: true, identityQualified: false, qualified: false });
    expect(target(tampered, 'vision')?.pin.detail).toContain('runtime artifact SHA-256 mismatch');
  });

  it('refuses the same artifact inode in both model and runtime evidence', async () => {
    const root = await temporaryDirectory();
    const modelPath = join(root, 'model-evidence.bin');
    const runtimePath = join(root, 'runtime-evidence.bin');
    await writeFile(modelPath, 'shared artifact identity');
    await link(modelPath, runtimePath);
    const baseUrl = await startJsonServer(async (request) => (
      request.url === '/v1/models'
        ? { data: [{ id: 'artifact-alias-model' }] }
        : { error: 'inference must not run for aliased evidence' }
    ));
    const config = baseConfig();
    config.model = { provider: 'local-openai', model: 'artifact-alias-model', baseUrl: `${baseUrl}/v1` };
    const digest = sha256('shared artifact identity');
    const report = await runApplianceQualification(config, {
      requiredCapabilities: ['text'],
      manifest: artifactRoleManifest(modelPath, runtimePath, digest),
      timeoutMs: 2_000,
    });

    expect(target(report, 'model')).toMatchObject({ reachable: true, identityQualified: false, qualified: false });
    expect(target(report, 'model')?.detail).toContain('duplicates a model artifact file identity');
  });

  it.runIf(process.platform === 'darwin')(
    'refuses case-only macOS aliases across model and runtime evidence roles',
    async () => {
      const root = await temporaryDirectory();
      const modelPath = join(root, 'Evidence.bin');
      const runtimeAlias = join(root, 'eVIDENCE.BIN');
      await writeFile(modelPath, 'case alias evidence');
      const baseUrl = await startJsonServer(async (request) => (
        request.url === '/v1/models'
          ? { data: [{ id: 'artifact-alias-model' }] }
          : { error: 'inference must not run for aliased evidence' }
      ));
      const config = baseConfig();
      config.model = { provider: 'local-openai', model: 'artifact-alias-model', baseUrl: `${baseUrl}/v1` };
      const report = await runApplianceQualification(config, {
        requiredCapabilities: ['text'],
        manifest: artifactRoleManifest(modelPath, runtimeAlias, sha256('case alias evidence')),
        timeoutMs: 2_000,
      });

      expect(target(report, 'model')).toMatchObject({ reachable: true, identityQualified: false, qualified: false });
      expect(target(report, 'model')?.detail).toContain('duplicates a model artifact path');
    },
  );

  it('refuses MLX identity when the manifest pins only an arbitrary subset of the snapshot', async () => {
    const root = await temporaryDirectory();
    const snapshot = join(root, 'text-snapshot');
    const artifacts = await createMlxSnapshot(snapshot, 'subset', false);
    let chatRequests = 0;
    const baseUrl = await startJsonServer(async (request) => {
      if (request.url === '/health') return { status: 'ok' };
      if (request.url === '/v1/models') return { data: [{ id: snapshot }] };
      chatRequests += 1;
      return { model: 'default_model', choices: [{ message: { content: 'Ready.' } }] };
    });
    const config = baseConfig();
    config.model = { provider: 'mlx-lm', model: 'operator-label', baseUrl: `${baseUrl}/v1` };
    const manifest: ApplianceQualificationManifest = {
      schema: 'openprojects.appliance-qualification.v1',
      requiredCapabilities: ['text'],
      requirePins: true,
      pins: {
        model: {
          provider: 'mlx-lm',
          model: 'operator-label',
          servedModelId: snapshot,
          artifacts: [artifacts.find((artifact) => artifact.path.endsWith('model.safetensors'))!],
        },
      },
    };

    const report = await runApplianceQualification(config, { manifest, timeoutMs: 2_000 });

    expect(chatRequests).toBe(0);
    expect(target(report, 'model')).toMatchObject({ reachable: true, identityQualified: false, qualified: false });
    expect(target(report, 'model')?.detail).toContain('exact SHA-256 inventory');
  });

  it('requires an isolated singleton MLX-LM model inventory for omitted-model inference', async () => {
    const root = await temporaryDirectory();
    const snapshot = join(root, 'text-snapshot');
    const artifacts = await createMlxSnapshot(snapshot, 'singleton', false);
    let chatRequests = 0;
    const baseUrl = await startJsonServer(async (request) => {
      if (request.url === '/health') return { status: 'ok' };
      if (request.url === '/v1/models') return { data: [{ id: snapshot }, { id: join(root, 'other') }] };
      chatRequests += 1;
      return {};
    });
    const config = baseConfig();
    config.model = { provider: 'mlx-lm', model: 'operator-label', baseUrl: `${baseUrl}/v1` };
    const manifest: ApplianceQualificationManifest = {
      schema: 'openprojects.appliance-qualification.v1',
      requiredCapabilities: ['text'],
      requirePins: true,
      pins: {
        model: { provider: 'mlx-lm', model: 'operator-label', servedModelId: snapshot, artifacts },
      },
    };

    const report = await runApplianceQualification(config, { manifest, timeoutMs: 2_000 });

    expect(chatRequests).toBe(0);
    expect(target(report, 'model')?.detail).toContain('/models must list exactly one');
    expect(target(report, 'model')).toMatchObject({ reachable: false, identityQualified: false, qualified: false });
  });

  it('rejects an MLX tool call whose finish reason would fail the production adapter', async () => {
    const root = await temporaryDirectory();
    const snapshot = join(root, 'text-snapshot');
    const artifacts = await createMlxSnapshot(snapshot, 'finish-reason', false);
    const baseUrl = await startJsonServer(async (request, body) => {
      if (request.url === '/health') return { status: 'ok' };
      if (request.url === '/v1/models') return { data: [{ id: snapshot }] };
      if (!isRecord(body)) return {};
      const messages = Array.isArray(body.messages) ? body.messages : [];
      if (Array.isArray(body.tools) && body.tools.length === 0) {
        return { model: 'default_model', choices: [{ finish_reason: 'stop', message: { content: 'Ready.' } }] };
      }
      const first = isRecord(messages[0]) ? messages[0] : {};
      const nonce = typeof first.content === 'string' ? first.content.match(/OP_[a-f0-9]{16}/u)?.[0] : undefined;
      return {
        model: 'default_model',
        choices: [{
          finish_reason: 'stop',
          message: {
            content: null,
            tool_calls: [{
              id: 'call_wrong_finish',
              type: 'function',
              function: { name: 'qualification_echo', arguments: JSON.stringify({ value: nonce }) },
            }],
          },
        }],
      };
    });
    const config = baseConfig();
    config.model = { provider: 'mlx-lm', model: 'operator-label', baseUrl: `${baseUrl}/v1` };
    const manifest: ApplianceQualificationManifest = {
      schema: 'openprojects.appliance-qualification.v1',
      requiredCapabilities: ['text'],
      requirePins: true,
      pins: {
        model: { provider: 'mlx-lm', model: 'operator-label', servedModelId: snapshot, artifacts },
      },
    };

    const report = await runApplianceQualification(config, { manifest, timeoutMs: 2_000 });

    expect(target(report, 'model')).toMatchObject({ reachable: true, capabilityQualified: false, qualified: false });
    expect(target(report, 'model')?.detail).toContain('requires finish_reason tool_calls');
  });

  it('qualifies a pinned singleton FreeToken alias through the strict text/tool contract', async () => {
    const root = await temporaryDirectory();
    const artifact = join(root, 'qwen36-moe.ftw');
    const runtimeArtifact = join(root, 'freetoken-runtime.whl');
    const artifactContents = 'fixture FreeToken model evidence';
    const runtimeContents = 'fixture FreeToken runtime evidence';
    await Promise.all([
      writeFile(artifact, artifactContents),
      writeFile(runtimeArtifact, runtimeContents),
    ]);
    const alias = 'openprojects-qwen36-moe';
    const runtimeVersion = '0.1.2+fixture';
    let healthVersion = runtimeVersion;
    const observedBodies: Record<string, unknown>[] = [];
    const baseUrl = await startJsonServer(async (request, body) => {
      if (request.url === '/health') {
        return {
          status: 'ok',
          model: alias,
          instance_id: 'fixture-instance',
          maintenance: 'serving',
          version: healthVersion,
        };
      }
      if (request.url === '/v1/models') return { data: [{ id: alias }] };
      if (!isRecord(body)) return { error: 'missing body' };
      observedBodies.push(body);
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const last = isRecord(messages.at(-1)) ? messages.at(-1) as Record<string, unknown> : {};
      if (last.role === 'tool') {
        return {
          model: alias,
          choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Tool accepted.' } }],
        };
      }
      if (Array.isArray(body.tools) && body.tools.length === 0) {
        return {
          model: alias,
          choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Ready.' } }],
        };
      }
      const first = isRecord(messages[0]) ? messages[0] : {};
      const nonce = typeof first.content === 'string'
        ? first.content.match(/OP_[a-f0-9]{16}/u)?.[0]
        : undefined;
      return {
        model: alias,
        choices: [{
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'call_freetoken_qualification',
              type: 'function',
              function: { name: 'qualification_echo', arguments: JSON.stringify({ value: nonce }) },
            }],
          },
        }],
      };
    });
    const config = baseConfig();
    config.model = { provider: 'freetoken', model: alias, baseUrl: `${baseUrl}/v1` };
    const manifest: ApplianceQualificationManifest = {
      schema: 'openprojects.appliance-qualification.v1',
      requiredCapabilities: ['text'],
      requirePins: true,
      pins: {
        model: {
          provider: 'freetoken',
          model: alias,
          artifacts: [{ path: artifact, sha256: sha256(artifactContents) }],
          maxContextTokens: 8_192,
          maxConcurrency: 1,
          runtime: {
            implementation: 'freetoken',
            version: runtimeVersion,
            artifacts: [{ path: runtimeArtifact, sha256: sha256(runtimeContents) }],
          },
        },
      },
    };

    const report = await runApplianceQualification(config, { manifest, timeoutMs: 2_000 });

    expect(report.overall).toBe('qualified');
    expect(target(report, 'model')).toMatchObject({
      provider: 'freetoken',
      model: alias,
      reachable: true,
      capabilityQualified: true,
      identityQualified: true,
      qualified: true,
      identity: { observedModel: alias, runtime: `FreeToken@${runtimeVersion}` },
    });
    expect(observedBodies).toHaveLength(3);
    expect(observedBodies.every((body) => body.model === alias)).toBe(true);
    expect(observedBodies.every((body) => body.parallel_tool_calls === false)).toBe(true);

    healthVersion = '0.1.2+drifted-build';
    const drifted = await runApplianceQualification(config, { manifest, timeoutMs: 2_000 });
    expect(target(drifted, 'model')).toMatchObject({ reachable: false, qualified: false });
    expect(target(drifted, 'model')?.detail).toContain('does not match the pinned runtime version');
    expect(observedBodies).toHaveLength(3);
  });

  it('rejects non-serving health and a multi-model FreeToken inventory before inference', async () => {
    let chatRequests = 0;
    let modelRequests = 0;
    let mode: 'loading' | 'multi' = 'loading';
    const alias = 'openprojects-qwen36-moe';
    const baseUrl = await startJsonServer(async (request) => {
      if (request.url === '/health') {
        if (mode === 'loading') {
          return {
            status: 'loading',
            model: alias,
            instance_id: 'fixture-instance',
            phase: 'weights',
            progress: { done_bytes: 1, total_bytes: 2 },
          };
        }
        return {
          status: 'ok',
          model: alias,
          instance_id: 'fixture-instance',
          maintenance: 'serving',
          version: '0.1.2+fixture',
        };
      }
      if (request.url === '/v1/models') {
        modelRequests += 1;
        return { data: [{ id: alias }, { id: 'unreviewed-second-model' }] };
      }
      chatRequests += 1;
      return {};
    });
    const config = baseConfig();
    config.model = { provider: 'freetoken', model: alias, baseUrl: `${baseUrl}/v1` };

    const loading = await runApplianceQualification(config, {
      requiredCapabilities: ['text'],
      timeoutMs: 2_000,
    });

    expect(chatRequests).toBe(0);
    expect(modelRequests).toBe(0);
    expect(target(loading, 'model')).toMatchObject({ reachable: false, qualified: false });
    expect(target(loading, 'model')?.detail).toContain('status ok');

    mode = 'multi';
    const report = await runApplianceQualification(config, {
      requiredCapabilities: ['text'],
      timeoutMs: 2_000,
    });

    expect(chatRequests).toBe(0);
    expect(modelRequests).toBe(1);
    expect(target(report, 'model')).toMatchObject({ reachable: false, qualified: false });
    expect(target(report, 'model')?.detail).toContain('FreeToken /models must list exactly one');
  });

  it('refuses a constant-output text model as a vision-qualified endpoint', async () => {
    const root = await temporaryDirectory();
    const snapshot = join(root, 'vision-snapshot');
    const artifacts = await createMlxSnapshot(snapshot, 'constant-output', true);
    let visionRequests = 0;
    const baseUrl = await startJsonServer(async (request) => {
      if (request.url === '/health') return { status: 'healthy', loaded_model: snapshot };
      if (request.url === '/v1/models') return { data: [{ id: snapshot }] };
      visionRequests += 1;
      return { model: snapshot, choices: [{ message: { role: 'assistant', content: 'BLUE' } }] };
    });
    const manifest: ApplianceQualificationManifest = {
      schema: 'openprojects.appliance-qualification.v1',
      requiredCapabilities: ['vision'],
      requirePins: true,
      visionService: { provider: 'mlx-vlm', model: 'vision-label', baseUrl: `${baseUrl}/v1` },
      pins: {
        vision: { provider: 'mlx-vlm', model: 'vision-label', servedModelId: snapshot, artifacts },
      },
    };

    const report = await runApplianceQualification(baseConfig(), { manifest, timeoutMs: 2_000, random: () => 0 });

    expect(visionRequests).toBe(3);
    expect(target(report, 'vision')).toMatchObject({
      reachable: true,
      capabilityQualified: false,
      identityQualified: false,
      qualified: false,
    });
    expect(target(report, 'vision')?.detail).toContain('both bounded local PNG fixtures');
  });

  it('refuses strict alternating color answers for every randomized three-request pattern', async () => {
    const root = await temporaryDirectory();
    const snapshot = join(root, 'vision-snapshot');
    const artifacts = await createMlxSnapshot(snapshot, 'alternating-output', true);
    let responseIndex = 0;
    let firstAnswer: 'BLUE' | 'RED' = 'BLUE';
    const baseUrl = await startJsonServer(async (request) => {
      if (request.url === '/health') return { status: 'healthy', loaded_model: snapshot };
      if (request.url === '/v1/models') {
        responseIndex = 0;
        return { data: [{ id: snapshot }] };
      }
      const answer = responseIndex % 2 === 0
        ? firstAnswer
        : firstAnswer === 'BLUE' ? 'RED' : 'BLUE';
      responseIndex += 1;
      return { model: snapshot, choices: [{ message: { role: 'assistant', content: answer } }] };
    });
    const manifest: ApplianceQualificationManifest = {
      schema: 'openprojects.appliance-qualification.v1',
      requiredCapabilities: ['vision'],
      requirePins: true,
      visionService: { provider: 'mlx-vlm', model: 'vision-label', baseUrl: `${baseUrl}/v1` },
      pins: {
        vision: { provider: 'mlx-vlm', model: 'vision-label', servedModelId: snapshot, artifacts },
      },
    };

    for (const initial of ['BLUE', 'RED'] as const) {
      firstAnswer = initial;
      for (const randomValue of [0.1, 0.3, 0.6, 0.9]) {
        const report = await runApplianceQualification(baseConfig(), {
          manifest,
          timeoutMs: 2_000,
          random: () => randomValue,
        });
        expect(target(report, 'vision'), `${initial}/${randomValue}`).toMatchObject({
          reachable: true,
          capabilityQualified: false,
          qualified: false,
        });
      }
    }
  });

  it('preserves reachable status but rejects inference that omits the listed model identity', async () => {
    const baseUrl = await startJsonServer(async (request) => {
      if (request.url === '/v1/models') return { data: [{ id: 'local-model' }] };
      return { choices: [{ message: { role: 'assistant', content: 'text without response identity' } }] };
    });
    const config = baseConfig();
    config.model = { provider: 'local-openai', model: 'local-model', baseUrl: `${baseUrl}/v1` };

    const report = await runApplianceQualification(config, {
      requiredCapabilities: ['text'],
      timeoutMs: 2_000,
    });

    expect(report.overall).toBe('partial');
    expect(target(report, 'model')).toMatchObject({
      configured: true,
      reachable: true,
      capabilityQualified: false,
      qualified: false,
      stage: 'reachable',
    });
    expect(target(report, 'model')?.detail).toContain('Inference returned model (missing)');
  });

  it('reports capability success separately from a strong artifact-pin mismatch', async () => {
    const root = await temporaryDirectory();
    const artifact = join(root, 'model.safetensors');
    await writeFile(artifact, 'actual artifact bytes');
    const baseUrl = await toolServer('pinned-model');
    const config = baseConfig();
    config.model = { provider: 'local-openai', model: 'pinned-model', baseUrl: `${baseUrl}/v1` };
    const manifest: ApplianceQualificationManifest = {
      schema: 'openprojects.appliance-qualification.v1',
      requiredCapabilities: ['text'],
      requirePins: true,
      pins: {
        model: {
          provider: 'local-openai',
          model: 'pinned-model',
          artifacts: [{ path: artifact, sha256: '0'.repeat(64) }],
        },
      },
    };

    const report = await runApplianceQualification(config, { manifest, timeoutMs: 2_000 });

    expect(report.overall).toBe('partial');
    expect(target(report, 'model')).toMatchObject({
      reachable: true,
      capabilityQualified: true,
      identityQualified: false,
      qualified: false,
      stage: 'capability_qualified',
      pin: { required: true, declared: true, matched: false },
    });
  });

  it.runIf(process.platform !== 'win32')(
    'qualifies whisper.cpp only after a known-audio transcript and reports exact hashes',
    async () => {
      const root = await temporaryDirectory();
      const whisper = join(root, 'whisper-cli');
      const ffmpeg = join(root, 'ffmpeg');
      const model = join(root, 'ggml-small.bin');
      const audio = join(root, 'known-audio.input');
      await Promise.all([
        writeFile(whisper, [
          '#!/bin/sh',
          'if [ "$1" = "--help" ]; then echo "whisper-cli fixture 1.0"; exit 0; fi',
          'while [ "$#" -gt 0 ]; do',
          '  if [ "$1" = "-of" ]; then shift; printf "%s\\n" "OpenProjects known phrase" > "$1.txt"; exit 0; fi',
          '  shift',
          'done',
          'exit 2',
          '',
        ].join('\n'), { mode: 0o700 }),
        writeFile(ffmpeg, [
          '#!/bin/sh',
          'if [ "$1" = "-version" ]; then echo "ffmpeg fixture 1.0"; exit 0; fi',
          'for output do :; done',
          'printf "fixture wav" > "$output"',
          '',
        ].join('\n'), { mode: 0o700 }),
        writeFile(model, 'whisper model fixture'),
        writeFile(audio, 'known audio fixture'),
      ]);
      await Promise.all([chmod(whisper, 0o700), chmod(ffmpeg, 0o700)]);
      const modelHash = sha256('whisper model fixture');
      const config = baseConfig();
      config.transcription = {
        provider: 'whisper-cpp',
        command: whisper,
        ffmpegCommand: ffmpeg,
        modelPath: model,
        timeoutMs: 5_000,
        maxBytes: 1_000_000,
        maxDurationSeconds: 60,
      };
      const manifest: ApplianceQualificationManifest = {
        schema: 'openprojects.appliance-qualification.v1',
        requiredCapabilities: ['transcription'],
        requirePins: true,
        pins: {
          transcription: {
            provider: 'whisper-cpp',
            model,
            artifacts: [{ path: model, sha256: modelHash }],
          },
        },
        transcriptionProbe: { inputPath: audio, expectedText: 'known phrase' },
      };

      const report = await runApplianceQualification(config, { manifest, timeoutMs: 5_000 });

      expect(report.overall).toBe('qualified');
      expect(target(report, 'transcription')).toMatchObject({
        configured: true,
        reachable: true,
        capabilityQualified: true,
        identityQualified: true,
        qualified: true,
      });
      expect(target(report, 'transcription')?.identity.artifacts).toContainEqual({
        path: model,
        bytes: Buffer.byteLength('whisper model fixture'),
        sha256: modelHash,
      });
    },
  );

  it('loads a strict JSON manifest, resolves local evidence paths, and rejects symlinks', async () => {
    const root = await temporaryDirectory();
    const path = join(root, 'qualification.json');
    await writeFile(path, JSON.stringify({
      schema: 'openprojects.appliance-qualification.v1',
      requiredCapabilities: ['transcription'],
      requirePins: true,
      transcriptionProbe: { inputPath: './known.wav', expectedText: 'known' },
    }));
    const loaded = await loadQualificationManifest(path);
    expect(loaded.transcriptionProbe?.inputPath).toBe(join(root, 'known.wav'));

    await writeFile(path, JSON.stringify({
      schema: 'openprojects.appliance-qualification.v1',
      requiredCapabilities: [],
      requirePins: false,
      unsupported: true,
    }));
    await expect(loadQualificationManifest(path)).rejects.toThrow('unsupported keys');

    await writeFile(path, '{"schema":"openprojects.appliance-qualification.v1","requiredCapabilities":[],"requirePins":false,"pins":{"model":{"provider":"a","provider":"b","model":"m"}}}');
    await expect(loadQualificationManifest(path)).rejects.toThrow('duplicate JSON keys');

    await writeFile(path, JSON.stringify({
      schema: 'openprojects.appliance-qualification.v1',
      requiredCapabilities: [],
      requirePins: false,
      pins: {
        ['__proto__']: { provider: 'local', model: 'unsafe' },
      },
    }));
    await expect(loadQualificationManifest(path)).rejects.toThrow('not a supported target');
  });

  it.skipIf(process.platform === 'win32')('rejects symbolic-link qualification manifest paths', async () => {
    const root = await temporaryDirectory();
    const path = join(root, 'qualification.json');
    const link = join(root, 'manifest-link.json');
    await writeFile(path, JSON.stringify({
      schema: 'openprojects.appliance-qualification.v1',
      requiredCapabilities: [],
      requirePins: false,
    }));
    await symlink(path, link);

    await expect(loadQualificationManifest(link)).rejects.toThrow('regular non-symlink');
  });

  it('redacts a configured provider credential echoed by a failed service', async () => {
    const secret = 'qualification-secret-987654321';
    const baseUrl = await startJsonServer(async () => ({ error: { message: secret } }), 500);
    const config = baseConfig();
    config.model = {
      provider: 'local-openai',
      model: 'secret-model',
      baseUrl: `${baseUrl}/v1`,
      apiKey: secret,
    };

    const report = await runApplianceQualification(config, {
      requiredCapabilities: ['text'],
      timeoutMs: 2_000,
    });
    expect(JSON.stringify(report)).not.toContain(secret);
    expect(JSON.stringify(report)).toContain('[REDACTED]');
  });

  it('redacts short configured credentials without corrupting unrelated report text', async () => {
    const secret = 'q7';
    const baseUrl = await startJsonServer(async () => ({ error: { message: `denied ${secret}` } }), 500);
    const config = baseConfig();
    config.model = { provider: 'local-openai', model: 'short-secret-model', baseUrl: `${baseUrl}/v1`, apiKey: secret };

    const report = await runApplianceQualification(config, { requiredCapabilities: ['text'], timeoutMs: 2_000 });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(secret);
    expect(serialized).toContain('[REDACTED]');
    expect(report.schema).toBe('openprojects.appliance-qualification-report.v1');
  });

  it('bounds an oversized Ollama embedding response before parsing vectors', async () => {
    const config = baseConfig();
    config.embeddings = {
      provider: 'ollama',
      model: 'bounded-embedding',
      baseUrl: 'http://127.0.0.1:11434',
      dimensions: 3,
      timeoutMs: 2_000,
    };
    const request: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith('/api/tags')) {
        return new Response(JSON.stringify({ models: [{ model: 'bounded-embedding', digest: 'sha256:bounded' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{"padding":"oversized"}', {
        status: 200,
        headers: { 'content-type': 'application/json', 'content-length': String(1024 * 1024 + 1) },
      });
    };

    const report = await runApplianceQualification(config, {
      requiredCapabilities: ['embeddings'],
      timeoutMs: 2_000,
      fetch: request,
    });

    expect(target(report, 'embeddings')).toMatchObject({ reachable: true, capabilityQualified: false, qualified: false });
    expect(target(report, 'embeddings')?.detail).toContain('response exceeds 1048576 bytes');
  });

  it('refuses non-loopback and hybrid posture without contacting the configured endpoint', async () => {
    let contacted = false;
    const request: typeof fetch = async () => {
      contacted = true;
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const config = baseConfig();
    config.model = {
      provider: 'hosted',
      model: 'remote-model',
      baseUrl: 'https://models.example.test/v1',
      apiKey: 'remote-secret',
    };
    config.privacy = { localOnly: false, allowedOrigins: ['https://models.example.test'] };
    config.telegram = { enabled: true, apiBaseUrl: 'https://api.telegram.org' };

    const report = await runApplianceQualification(config, {
      requiredCapabilities: ['text'],
      timeoutMs: 2_000,
      fetch: request,
    });

    expect(contacted).toBe(false);
    expect(report.overall).toBe('not_qualified');
    expect(report.posture).toMatchObject({
      sealedLocal: false,
      localOnly: false,
      zeroAllowedOrigins: false,
      telegramDisabled: false,
      allInferenceLoopback: false,
    });
    expect(target(report, 'model')?.detail).toContain('refuses non-loopback');
  });

  it('refuses MLX-LM configurations the production adapter/router cannot instantiate', async () => {
    let contacted = false;
    const request: typeof fetch = async () => {
      contacted = true;
      return new Response('{}', { status: 200 });
    };
    const invalidPath = baseConfig();
    invalidPath.model = { provider: 'mlx-lm', model: 'label', baseUrl: 'http://127.0.0.1:8080/prefixed/v1' };
    const invalidPathReport = await runApplianceQualification(invalidPath, {
      requiredCapabilities: ['text'], timeoutMs: 2_000, fetch: request,
    });
    expect(target(invalidPathReport, 'model')?.detail).toContain('path must be /v1');

    const routeBase = {
      id: 'mlx-route',
      provider: 'mlx-lm',
      model: 'label',
      tasks: ['supervisor'] as const,
      baseUrl: 'http://127.0.0.1:8080/v1',
      enabled: true,
      quality: 0.5,
      inputCostPerMillion: 0,
      outputCostPerMillion: 0,
      contextWindow: 8_192,
    };
    const nonLocal = baseConfig();
    nonLocal.routing = {
      dailyBudgetUsd: 0,
      explorationRate: 0,
      routes: [{ ...routeBase, tasks: [...routeBase.tasks], local: false }],
    };
    const nonLocalReport = await runApplianceQualification(nonLocal, {
      requiredCapabilities: ['text'], timeoutMs: 2_000, fetch: request,
    });
    expect(target(nonLocalReport, 'route:mlx-route')?.detail).toContain('requires local: true');
    expect(nonLocalReport.posture).toMatchObject({ sealedLocal: false, allEnabledRoutesDeclaredLocal: false });

    const credentialed = baseConfig();
    credentialed.routing = {
      dailyBudgetUsd: 0,
      explorationRate: 0,
      routes: [{ ...routeBase, tasks: [...routeBase.tasks], local: true, apiKeyEnv: 'QUALIFICATION_UNUSED_KEY' }],
    };
    const credentialedReport = await runApplianceQualification(credentialed, {
      requiredCapabilities: ['text'], timeoutMs: 2_000, fetch: request,
    });
    expect(target(credentialedReport, 'route:mlx-route')?.detail).toContain('forbids API keys');
    expect(contacted).toBe(false);
  });

  it('shares one total timeout across identity, multiple artifacts, and inference calls', async () => {
    const root = await temporaryDirectory();
    const firstArtifact = join(root, 'first.bin');
    const secondArtifact = join(root, 'second.bin');
    await Promise.all([
      writeFile(firstArtifact, 'first'),
      writeFile(secondArtifact, 'second'),
    ]);
    const baseUrl = await startJsonServer(async (request, body) => {
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, request.url === '/v1/models' ? 120 : 100));
      if (request.url === '/v1/models') return { data: [{ id: 'deadline-model' }] };
      if (!isRecord(body) || !Array.isArray(body.tools) || body.tools.length === 0) {
        return { model: 'deadline-model', choices: [{ message: { role: 'assistant', content: 'Ready.' } }] };
      }
      return { error: 'tool response should be bounded by the shared deadline' };
    });
    const config = baseConfig();
    config.model = { provider: 'local-openai', model: 'deadline-model', baseUrl: `${baseUrl}/v1` };
    const manifest: ApplianceQualificationManifest = {
      schema: 'openprojects.appliance-qualification.v1',
      requiredCapabilities: ['text'],
      requirePins: true,
      pins: {
        model: {
          provider: 'local-openai',
          model: 'deadline-model',
          artifacts: [
            { path: firstArtifact, sha256: sha256('first') },
            { path: secondArtifact, sha256: sha256('second') },
          ],
        },
      },
    };
    const startedAt = performance.now();

    const report = await runApplianceQualification(config, {
      manifest,
      timeoutMs: 250,
    });
    const elapsedMs = performance.now() - startedAt;

    expect(report.overall).not.toBe('qualified');
    expect(elapsedMs).toBeLessThan(500);
    expect(target(report, 'model')).toMatchObject({ configured: true, reachable: true, qualified: false });
  });
});

function target(
  report: Awaited<ReturnType<typeof runApplianceQualification>>,
  id: string,
) {
  return report.targets.find((item) => item.id === id);
}

function baseConfig(): AppConfig {
  return {
    version: 1,
    agent: {
      id: 'qualification-test',
      version: '1.0.0',
      name: 'Qualification test',
      skills: [],
      tools: [],
      budgets: {
        maxSteps: 2,
        maxToolCalls: 2,
        maxWallTimeMs: 10_000,
        maxInputTokens: 2_000,
        reservedOutputTokens: 100,
      },
    },
    policy: {
      read: 'allow',
      draft: 'allow',
      memory_write: 'allow',
      internal_write: 'ask',
      external_write: 'deny',
      destructive: 'deny',
    },
    server: { host: '127.0.0.1', port: 4310 },
    storage: { database: ':memory:' },
    model: { provider: 'mock', model: 'fixture' },
    memory: { retrievalLimit: 4, maxContextCharacters: 4_000 },
    privacy: { localOnly: true, allowedOrigins: [] },
    embeddings: {
      provider: 'builtin',
      model: 'builtin-hash-v1',
      dimensions: 32,
      timeoutMs: 2_000,
    },
    transcription: {
      provider: 'disabled',
      command: 'whisper-cli',
      ffmpegCommand: 'ffmpeg',
      timeoutMs: 5_000,
      maxBytes: 1_000_000,
      maxDurationSeconds: 60,
    },
  };
}

async function toolServer(model: string): Promise<string> {
  return startJsonServer(async (request, body) => {
    if (request.url === '/v1/models') return { data: [{ id: model }] };
    if (!isRecord(body)) return { error: 'missing body' };
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const last = isRecord(messages.at(-1)) ? messages.at(-1) as Record<string, unknown> : {};
    if (last.role === 'tool') {
      return { model, choices: [{ message: { role: 'assistant', content: 'Tool result accepted.' } }] };
    }
    if (!Array.isArray(body.tools) || body.tools.length === 0) {
      return { model, choices: [{ message: { role: 'assistant', content: 'Ready.' } }] };
    }
    const first = isRecord(messages[0]) ? messages[0] : {};
    const content = typeof first.content === 'string' ? first.content : '';
    const nonce = content.match(/OP_[a-f0-9]{16}/u)?.[0] ?? 'missing';
    return {
      model,
      choices: [{
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_qualification',
            type: 'function',
            function: { name: 'qualification_echo', arguments: JSON.stringify({ value: nonce }) },
          }],
        },
      }],
    };
  });
}

async function startJsonServer(
  handler: (request: IncomingMessage, body: unknown) => Promise<unknown>,
  status = 200,
): Promise<string> {
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    let body: unknown;
    try {
      body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown : undefined;
    } catch {
      body = undefined;
    }
    const result = await handler(request, body);
    response.statusCode = status;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(result));
  });
  servers.add(server);
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolvePromise());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind TCP');
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    server.close((error) => error ? reject(error) : resolvePromise());
  });
}

async function temporaryDirectory(): Promise<string> {
  const created = await mkdtemp(join(tmpdir(), 'openprojects-qualification-'));
  const root = await realpath(created);
  temporaryPaths.add(root);
  return root;
}

async function createMlxSnapshot(
  path: string,
  label: string,
  vision: boolean,
): Promise<Array<{ path: string; sha256: string }>> {
  await mkdir(path);
  const files: Record<string, string> = {
    'config.json': JSON.stringify({ model_type: vision ? 'qwen_vl' : 'qwen' }),
    'tokenizer_config.json': JSON.stringify({ chat_template: `${label} template` }),
    'tokenizer.json': JSON.stringify({ version: '1.0', model: {} }),
    'model.safetensors': `${label} weights`,
    ...(vision ? { 'processor_config.json': JSON.stringify({ processor_class: 'FixtureProcessor' }) } : {}),
  };
  await Promise.all(Object.entries(files).map(([name, contents]) => writeFile(join(path, name), contents)));
  return Object.entries(files).map(([name, contents]) => ({
    path: join(path, name),
    sha256: sha256(contents),
  }));
}

async function runQualificationCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [
      '--import',
      'tsx',
      join(process.cwd(), 'src/cli.ts'),
      ...args,
    ], {
      cwd: process.cwd(),
      env: { ...process.env, OPENPROJECTS_ENV_FILE: join(process.cwd(), '.qualification-test-no-env') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('qualification CLI subprocess timed out'));
    }, 10_000);
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolvePromise({
        code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function semanticEmbeddingResponse(dimensions: number): { model: string; embeddings: number[][] } {
  const query = Array.from({ length: dimensions }, (_, index) => index === 0 ? 1 : 0);
  const positive = [...query];
  const negative = Array.from({ length: dimensions }, (_, index) => index === Math.min(1, dimensions - 1) ? 1 : 0);
  return {
    model: 'qwen3-embedding:0.6b',
    embeddings: Array.from({ length: 4 }, () => [query, positive, negative]).flat(),
  };
}

function embeddingManifest(serviceDigest: string): ApplianceQualificationManifest {
  return {
    schema: 'openprojects.appliance-qualification.v1',
    requiredCapabilities: ['embeddings'],
    requirePins: true,
    pins: {
      embeddings: {
        provider: 'ollama',
        model: 'qwen3-embedding:0.6b',
        serviceDigest,
      },
    },
  };
}

function visionManifest(
  baseUrl: string,
  servedModelId: string,
  artifacts: Array<{ path: string; sha256: string }>,
  runtime?: {
    implementation: string;
    version: string;
    artifacts: Array<{ path: string; sha256: string }>;
  },
): ApplianceQualificationManifest {
  return {
    schema: 'openprojects.appliance-qualification.v1',
    requiredCapabilities: ['vision'],
    requirePins: true,
    visionService: { provider: 'mlx-vlm', model: 'vision-label', baseUrl: `${baseUrl}/v1` },
    pins: {
      vision: {
        provider: 'mlx-vlm',
        model: 'vision-label',
        servedModelId,
        artifacts,
        ...(runtime ? { runtime } : {}),
      },
    },
  };
}

function artifactRoleManifest(
  modelPath: string,
  runtimePath: string,
  digest: string,
): ApplianceQualificationManifest {
  return {
    schema: 'openprojects.appliance-qualification.v1',
    requiredCapabilities: ['text'],
    requirePins: true,
    pins: {
      model: {
        provider: 'local-openai',
        model: 'artifact-alias-model',
        artifacts: [{ path: modelPath, sha256: digest }],
        runtime: {
          implementation: 'test-runtime',
          version: '1.0.0',
          artifacts: [{ path: runtimePath, sha256: digest }],
        },
      },
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
