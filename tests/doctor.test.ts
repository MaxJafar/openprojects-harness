import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createApp, type OpenProjectsApp } from '../src/app.js';
import type { AppConfig } from '../src/core/types.js';
import { renderDoctorReport, runDoctor } from '../src/doctor.js';

const apps = new Set<OpenProjectsApp>();
const DOCTOR_EMBEDDING_DIGEST = 'a'.repeat(64);
const servers = new Set<Server>();
const temporaryPaths = new Set<string>();

afterEach(async () => {
  for (const app of apps) await app.close();
  apps.clear();
  for (const server of servers) await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  servers.clear();
  for (const path of temporaryPaths) await rm(path, { recursive: true, force: true });
  temporaryPaths.clear();
});

describe('private appliance doctor', () => {
  it('reports sealed composition and flags legacy loopback-only control access without probing services', async () => {
    const app = await testApp(baseConfig());
    const report = await runDoctor(app, { now: () => new Date('2026-08-25T12:00:00.000Z') });

    expect(report).toMatchObject({
      schema: 'openprojects.doctor.v1',
      generatedAt: '2026-08-25T12:00:00.000Z',
      probe: false,
      overall: 'degraded',
      posture: {
        sealedLocal: true,
        localOnly: true,
        allowlistedOriginCount: 0,
        telegramExternalTransport: false,
      },
    });
    expect(report.checks.filter((item) => item.status === 'skip').map((item) => item.id)).toEqual([
      'vision',
      'model',
      'embeddings',
      'storage',
      'transcription',
    ]);
    expect(status(report, 'control-auth')).toBe('warn');
    expect(renderDoctorReport(report)).toContain('Privacy posture: SEALED LOCAL');
  });

  it('marks fixture inference, feature hashing, and memory-only storage as development warnings', async () => {
    const app = await testApp(baseConfig());
    const report = await runDoctor(app, { probe: true, databasePath: ':memory:' });

    expect(report.overall).toBe('degraded');
    expect(status(report, 'model')).toBe('warn');
    expect(status(report, 'embeddings')).toBe('warn');
    expect(status(report, 'storage')).toBe('warn');
    expect(status(report, 'transcription')).toBe('skip');
  });

  it('probes a local OpenAI-compatible model, Ollama embeddings, durable storage, and Whisper prerequisites', async () => {
    const root = await temporaryDirectory();
    const whisper = join(root, 'whisper-cli');
    const ffmpeg = join(root, 'ffmpeg');
    const whisperModel = join(root, 'ggml-small.bin');
    const controlToken = join(root, 'control.token');
    await Promise.all([
      writeFile(whisper, '#!/bin/sh\nexit 0\n', { mode: 0o700 }),
      writeFile(ffmpeg, '#!/bin/sh\nexit 0\n', { mode: 0o700 }),
      writeFile(whisperModel, 'fixture'),
      writeFile(controlToken, '0123456789abcdefghijklmnopqrstuvwxyzABCDEF\n', { mode: 0o600 }),
    ]);
    await Promise.all([chmod(whisper, 0o700), chmod(ffmpeg, 0o700), chmod(controlToken, 0o600)]);
    const baseUrl = await startModelServer();
    const config = baseConfig();
    config.model = { provider: 'local-openai', model: 'qwen-local', baseUrl: `${baseUrl}/v1` };
    config.embeddings = {
      provider: 'ollama',
      model: 'qwen3-embedding:0.6b',
      baseUrl,
      serviceDigest: DOCTOR_EMBEDDING_DIGEST,
      dimensions: 3,
      timeoutMs: 2_000,
    };
    config.transcription = {
      provider: 'whisper-cpp',
      command: whisper,
      ffmpegCommand: ffmpeg,
      modelPath: whisperModel,
      timeoutMs: 5_000,
      maxBytes: 1_000_000,
      maxDurationSeconds: 60,
    };
    config.server.auth = { tokenFile: controlToken, operatorId: 'doctor-operator' };
    const app = await testApp(config);
    const report = await runDoctor(app, {
      probe: true,
      timeoutMs: 2_000,
      databasePath: join(root, 'openprojects.db'),
    });

    expect(report.overall).toBe('ready');
    for (const id of ['model', 'embeddings', 'storage', 'transcription']) {
      expect(status(report, id)).toBe('pass');
    }
    expect(report.checks.find((item) => item.id === 'embeddings')?.detail).toContain('3 finite dimensions');
  });

  it('fails an unsafe bind and redacts an exact configured provider secret even when echoed without a label', async () => {
    const providerSecret = 'opaqueCredentialValue987654321';
    const baseUrl = await startModelServer({ echoSecret: providerSecret });
    const config = baseConfig();
    config.server.host = '0.0.0.0';
    config.model = {
      provider: 'local-openai',
      model: 'broken-local',
      baseUrl: `${baseUrl}/v1`,
      apiKey: providerSecret,
    };
    const app = await testApp(config);
    const report = await runDoctor(app, { probe: true, databasePath: ':memory:' });
    const serialized = JSON.stringify(report);

    expect(report.overall).toBe('not_ready');
    expect(status(report, 'server-bind')).toBe('fail');
    expect(status(report, 'model')).toBe('fail');
    expect(serialized).not.toContain(providerSecret);
    expect(serialized).toContain('[REDACTED]');
  });

  it('fails readiness for a missing protected control credential', async () => {
    const config = baseConfig();
    config.server.auth = {
      tokenFile: '/definitely/missing/openprojects-control.token',
      operatorId: 'doctor-operator',
    };
    const app = await testApp(config);
    const report = await runDoctor(app);

    expect(report.overall).toBe('not_ready');
    expect(status(report, 'control-auth')).toBe('fail');
    expect(JSON.stringify(report)).not.toContain('Bearer ');
  });

  it.runIf(process.platform !== 'win32' && process.geteuid !== undefined)(
    'validates a protected Unix endpoint and multiple least-privilege principals',
    async () => {
      const root = await mkdtemp('/tmp/openprojects-doctor-');
      temporaryPaths.add(root);
      await chmod(root, 0o700);
      const reader = join(root, 'reader.token');
      const admin = join(root, 'admin.token');
      await Promise.all([
        writeFile(reader, 'doctor-reader-token-1234567890abcdef\n', { mode: 0o600 }),
        writeFile(admin, 'doctor-admin-token-1234567890abcdefg\n', { mode: 0o600 }),
      ]);
      const config = baseConfig();
      config.server.socketPath = join(root, 'control.sock');
      config.server.auth = {
        principals: [
          { id: 'auditor', tokenFile: reader, capabilities: ['read'], workspaces: ['local'] },
          { id: 'administrator', tokenFile: admin, capabilities: ['admin'] },
        ],
      };
      const controlServer = createServer((_request, response) => response.end('ok'));
      await new Promise<void>((resolve, reject) => {
        controlServer.once('error', reject);
        controlServer.listen(config.server.socketPath, () => {
          controlServer.off('error', reject);
          resolve();
        });
      });
      await chmod(config.server.socketPath, 0o600);
      servers.add(controlServer);
      const report = await runDoctor(await testApp(config));
      expect(status(report, 'server-bind')).toBe('pass');
      expect(report.checks.find((item) => item.id === 'server-bind')?.detail)
        .toContain('accepting connections');
      expect(status(report, 'control-auth')).toBe('pass');
      expect(report.checks.find((item) => item.id === 'control-auth')?.detail)
        .toContain('2 independent principals');
    },
  );

  it('rejects a protected but non-SQLite storage file without mutating it', async () => {
    const root = await temporaryDirectory();
    const database = join(root, 'openprojects.db');
    await writeFile(database, 'not a SQLite database', { mode: 0o600 });
    await chmod(database, 0o600);
    const app = await testApp(baseConfig());
    const report = await runDoctor(app, { probe: true, databasePath: database });

    expect(report.overall).toBe('not_ready');
    expect(status(report, 'storage')).toBe('fail');
  });

  it.skipIf(process.platform === 'win32')('accepts reviewed PATH symlinks whose final transcription executables are regular and protected', async () => {
    const root = await temporaryDirectory();
    const bin = join(root, 'bin');
    const whisperTarget = join(root, 'whisper-cli.real');
    const ffmpegTarget = join(root, 'ffmpeg.real');
    const whisperLink = join(bin, 'whisper-cli');
    const ffmpegLink = join(bin, 'ffmpeg');
    const whisperModel = join(root, 'ggml-small.bin');
    await mkdir(bin, { mode: 0o700 });
    await Promise.all([
      writeFile(whisperTarget, '#!/bin/sh\nexit 0\n', { mode: 0o700 }),
      writeFile(ffmpegTarget, '#!/bin/sh\nexit 0\n', { mode: 0o700 }),
      writeFile(whisperModel, 'fixture'),
    ]);
    await Promise.all([
      symlink(whisperTarget, whisperLink),
      symlink(ffmpegTarget, ffmpegLink),
    ]);
    const originalPath = process.env.PATH;
    process.env.PATH = bin;
    const config = baseConfig();
    config.transcription = {
      provider: 'whisper-cpp',
      command: 'whisper-cli',
      ffmpegCommand: 'ffmpeg',
      modelPath: whisperModel,
      timeoutMs: 5_000,
      maxBytes: 1_000_000,
      maxDurationSeconds: 60,
    };
    const app = await testApp(config);
    try {
      const report = await runDoctor(app, { probe: true, databasePath: ':memory:' });
      expect(status(report, 'transcription')).toBe('pass');
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
  });
});

async function testApp(config: AppConfig): Promise<OpenProjectsApp> {
  const app = await createApp({ config, databasePath: ':memory:', skills: [], seedDemo: false });
  apps.add(app);
  return app;
}

function status(report: Awaited<ReturnType<typeof runDoctor>>, id: string): string | undefined {
  return report.checks.find((item) => item.id === id)?.status;
}

function baseConfig(): AppConfig {
  return {
    version: 1,
    agent: {
      id: 'doctor-test',
      version: '1.0.0',
      name: 'Doctor test agent',
      system: 'Test only.',
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
      external_write: 'ask',
      destructive: 'deny',
    },
    server: { host: '127.0.0.1', port: 4310 },
    storage: { database: ':memory:' },
    model: { provider: 'mock', model: 'project-ops-v1' },
    privacy: { localOnly: true, allowedOrigins: [] },
    telegram: { enabled: false, apiBaseUrl: 'https://api.telegram.org' },
    embeddings: {
      provider: 'builtin',
      model: 'builtin-hash-v1',
      dimensions: 64,
      timeoutMs: 1_000,
    },
    transcription: {
      provider: 'disabled',
      command: 'whisper-cli',
      ffmpegCommand: 'ffmpeg',
      timeoutMs: 5_000,
      maxBytes: 1_000_000,
      maxDurationSeconds: 60,
    },
    memory: { retrievalLimit: 4, maxContextCharacters: 4_000 },
  };
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'openprojects-doctor-'));
  temporaryPaths.add(path);
  return path;
}

async function startModelServer(options: { echoSecret?: string } = {}): Promise<string> {
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
    response.setHeader('content-type', 'application/json');
    if (options.echoSecret && request.url === '/v1/chat/completions') {
      response.statusCode = 500;
      response.end(JSON.stringify({ error: { message: `invalid credential ${options.echoSecret} provider unavailable` } }));
      return;
    }
    response.statusCode = 200;
    if (request.url === '/v1/chat/completions') {
      response.end(JSON.stringify({
        model: 'qwen-local',
        choices: [{ message: { role: 'assistant', content: 'READY' }, finish_reason: 'stop' }],
      }));
      return;
    }
    if (request.url === '/api/embed') {
      response.end(JSON.stringify({
        model: 'qwen3-embedding:0.6b',
        embeddings: [[0.2672612419, 0.5345224838, 0.8017837257]],
      }));
      return;
    }
    if (request.url === '/api/tags') {
      response.end(JSON.stringify({
        models: [{ model: 'qwen3-embedding:0.6b', digest: DOCTOR_EMBEDDING_DIGEST }],
      }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: 'not found' }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  servers.add(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP test server');
  return `http://127.0.0.1:${address.port}`;
}
