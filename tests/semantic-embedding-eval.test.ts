import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import YAML from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';

import type { AppConfig } from '../src/core/types.js';
import {
  runSemanticEmbeddingEval,
  SEMANTIC_EMBEDDING_CORPUS,
} from '../src/eval/semantic-embeddings.js';

const DIMENSIONS = 64;
const MODEL = 'bge-m3:latest';
const DIGEST = 'a'.repeat(64);
const servers = new Set<Server>();
const temporaryPaths = new Set<string>();

afterEach(async () => {
  for (const server of servers) await closeServer(server);
  servers.clear();
  for (const path of temporaryPaths) await rm(path, { recursive: true, force: true });
  temporaryPaths.clear();
});

describe('live semantic embedding evaluation', () => {
  it('passes deterministic multilingual retrieval without touching routes, SQLite, or source files', async () => {
    const requestedPaths: string[] = [];
    const baseUrl = await startEmbeddingServer((inputs) => goodVectors(inputs), requestedPaths);
    const fixture = await writeFixture(baseUrl);
    const configBefore = await readFile(fixture.configPath);
    const manifestBefore = await readFile(fixture.manifestPath);

    const report = await runSemanticEmbeddingEval({
      configPath: fixture.configPath,
      manifestPath: fixture.manifestPath,
      batches: 3,
      timeoutMs: 20_000,
      now: () => new Date('2026-08-25T14:00:00.000Z'),
    });

    expect(report).toMatchObject({
      schema: 'openprojects.semantic-embedding-eval-report.v1',
      generatedAt: '2026-08-25T14:00:00.000Z',
      preflight: { qualified: true, overall: 'qualified' },
      candidate: {
        provider: 'ollama',
        model: MODEL,
        adapterId: `${MODEL}@sha256:${DIGEST}`,
        configuredDimensions: DIMENSIONS,
      },
      identity: {
        observedModel: MODEL,
        observedServiceDigest: DIGEST,
        exactModel: true,
        exactServiceDigest: true,
        exactDimensions: true,
      },
      requestedBatches: 3,
      successfulBatches: 3,
      errorCount: 0,
      passed: true,
      metrics: { recallAt1: 1, recallAt3: 1, meanReciprocalRank: 1 },
      statuses: {
        semanticEmbeddings: 'passed',
        projectAnalysis: 'not_evaluated',
        supervisor: 'not_evaluated',
        vision: 'not_evaluated',
      },
      posture: {
        persistentHarnessStateWritesAttempted: false,
        downloadsAttempted: false,
        promotionsAttempted: false,
        modelRoutesMutated: false,
        textModelRequestsAttempted: false,
      },
    });
    expect(report.queries).toHaveLength(12);
    expect(report.queries.every((query) => query.ranks.every((rank) => rank === 1))).toBe(true);
    expect(report.minimumRepeatedInputCosine).toBeGreaterThanOrEqual(0.999);
    expect(report.minimumDriftCosine).toBeGreaterThanOrEqual(0.999);
    expect(requestedPaths.filter((path) => path === '/api/embed')).toHaveLength(4);
    expect(requestedPaths.some((path) => path.startsWith('/v1'))).toBe(false);
    expect(await readFile(fixture.configPath)).toEqual(configBefore);
    expect(await readFile(fixture.manifestPath)).toEqual(manifestBefore);
    await expect(readFile(fixture.databasePath)).rejects.toThrow();
  });

  it('fails closed for distinct normalized vectors with semantically permuted rankings', async () => {
    const baseUrl = await startEmbeddingServer((inputs) => wrongDistinctVectors(inputs));
    const fixture = await writeFixture(baseUrl);

    const report = await runSemanticEmbeddingEval({
      configPath: fixture.configPath,
      manifestPath: fixture.manifestPath,
      batches: 2,
      timeoutMs: 20_000,
    });

    expect(report.preflight.qualified).toBe(true);
    expect(report.passed).toBe(false);
    expect(report.metrics.recallAt1).toBeLessThan(0.8);
    expect(report.statuses.semanticEmbeddings).toBe('failed');
    expect(report.errorCount).toBe(0);
    expect(report.batches.every((batch) => batch.observedDimensions === DIMENSIONS)).toBe(true);
  });

  it('fails closed when otherwise-correct sequential vectors drift', async () => {
    let evaluationBatch = 0;
    const baseUrl = await startEmbeddingServer((inputs) => {
      const vectors = goodVectors(inputs);
      if (inputs.length !== 12 && evaluationBatch++ > 0) {
        return vectors.map((vector, index) => index === 0 ? rotate(vector) : vector);
      }
      return vectors;
    });
    const fixture = await writeFixture(baseUrl);

    const report = await runSemanticEmbeddingEval({
      configPath: fixture.configPath,
      manifestPath: fixture.manifestPath,
      batches: 2,
      timeoutMs: 20_000,
    });

    expect(report.preflight.qualified).toBe(true);
    expect(report.passed).toBe(false);
    expect(report.errorCount).toBe(0);
    expect(report.minimumDriftCosine).toBeLessThan(0.999);
    expect(report.batches[1]).toMatchObject({ passed: false });
  });

  it('rejects an unpinned candidate before making a live request', async () => {
    const requestedPaths: string[] = [];
    const baseUrl = await startEmbeddingServer((inputs) => goodVectors(inputs), requestedPaths);
    const fixture = await writeFixture(baseUrl, false);

    await expect(runSemanticEmbeddingEval({
      configPath: fixture.configPath,
      manifestPath: fixture.manifestPath,
      batches: 2,
    })).rejects.toThrow('requires strong manifest pins');
    expect(requestedPaths).toEqual([]);
  });
});

function goodVectors(inputs: string[]): number[][] {
  if (inputs.length === 12) return qualificationVectors();
  return inputs.map((input) => {
    const documentIndex = SEMANTIC_EMBEDDING_CORPUS.documents.findIndex((document) => document.text === input);
    if (documentIndex >= 0) return oneHot(documentIndex);
    const query = SEMANTIC_EMBEDDING_CORPUS.queries.find((item) => input.includes(item.text));
    if (!query) throw new Error(`Unexpected embedding input: ${input}`);
    const expected = SEMANTIC_EMBEDDING_CORPUS.documents.findIndex(
      (document) => document.id === query.expectedDocumentId,
    );
    return oneHot(expected);
  });
}

function wrongDistinctVectors(inputs: string[]): number[][] {
  if (inputs.length === 12) return qualificationVectors();
  let queryOrdinal = 0;
  return inputs.map((input) => {
    const documentIndex = SEMANTIC_EMBEDDING_CORPUS.documents.findIndex((document) => document.text === input);
    if (documentIndex >= 0) return oneHot(documentIndex);
    const query = SEMANTIC_EMBEDDING_CORPUS.queries.find((item) => input.includes(item.text));
    if (!query) throw new Error(`Unexpected embedding input: ${input}`);
    const expected = SEMANTIC_EMBEDDING_CORPUS.documents.findIndex(
      (document) => document.id === query.expectedDocumentId,
    );
    const wrong = (expected + 1) % SEMANTIC_EMBEDDING_CORPUS.documents.length;
    const unique = 16 + (queryOrdinal++ % 32);
    return normalizedMix(wrong, unique);
  });
}

function qualificationVectors(): number[][] {
  return Array.from({ length: 4 }, (_, index) => [
    oneHot(32 + index),
    oneHot(32 + index),
    oneHot(40 + index),
  ]).flat();
}

function oneHot(index: number): number[] {
  return Array.from({ length: DIMENSIONS }, (_, column) => column === index ? 1 : 0);
}

function normalizedMix(primary: number, unique: number): number[] {
  const norm = Math.sqrt(1 + 0.01 ** 2);
  return Array.from({ length: DIMENSIONS }, (_, column) => (
    column === primary ? 1 / norm : column === unique ? 0.01 / norm : 0
  ));
}

function rotate(vector: number[]): number[] {
  return vector.map((_, index) => vector[(index + 1) % vector.length]!);
}

async function writeFixture(baseUrl: string, requirePins = true): Promise<{
  configPath: string;
  manifestPath: string;
  databasePath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'openprojects-semantic-eval-'));
  temporaryPaths.add(root);
  const configPath = join(root, 'openprojects.yaml');
  const manifestPath = join(root, 'qualification.json');
  const databasePath = join(root, 'state', 'harness.sqlite');
  const config = baseConfig(baseUrl, databasePath);
  await writeFile(configPath, YAML.stringify(config));
  await writeFile(manifestPath, JSON.stringify({
    schema: 'openprojects.appliance-qualification.v1',
    requiredCapabilities: ['embeddings'],
    requirePins,
    pins: {
      embeddings: {
        provider: 'ollama',
        model: MODEL,
        serviceDigest: DIGEST,
      },
    },
  }));
  return { configPath, manifestPath, databasePath };
}

function baseConfig(baseUrl: string, databasePath: string): AppConfig {
  return {
    version: 1,
    agent: {
      id: 'semantic-eval-test',
      version: '1.0.0',
      name: 'Semantic eval test',
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
    storage: { database: databasePath },
    model: { provider: 'mock', model: 'fixture' },
    routing: {
      dailyBudgetUsd: 0,
      explorationRate: 0,
      routes: [{
        id: 'untouched-supervisor',
        provider: 'openai-compatible',
        model: 'must-not-be-called',
        baseUrl: `${baseUrl}/v1`,
        enabled: true,
        local: true,
        tasks: ['supervisor'],
        quality: 0.9,
        inputCostPerMillion: 0,
        outputCostPerMillion: 0,
        contextWindow: 8_192,
      }],
    },
    memory: { retrievalLimit: 4, maxContextCharacters: 4_000 },
    privacy: { localOnly: true, allowedOrigins: [] },
    telegram: { enabled: false, apiBaseUrl: 'https://api.telegram.org' },
    embeddings: {
      provider: 'ollama',
      model: MODEL,
      baseUrl,
      serviceDigest: DIGEST,
      dimensions: DIMENSIONS,
      timeoutMs: 5_000,
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

async function startEmbeddingServer(
  vectors: (inputs: string[]) => number[][],
  requestedPaths: string[] = [],
): Promise<string> {
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    requestedPaths.push(request.url ?? '');
    const body = await readJson(request);
    if (request.url === '/api/tags') {
      json(response, { models: [{ model: MODEL, digest: DIGEST }] });
      return;
    }
    if (request.url === '/api/embed' && isRecord(body) && Array.isArray(body.input)) {
      const inputs = body.input.filter((item): item is string => typeof item === 'string');
      json(response, { model: MODEL, embeddings: vectors(inputs) });
      return;
    }
    json(response, { error: 'unexpected request' }, 500);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  servers.add(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind a TCP port');
  return `http://127.0.0.1:${address.port}`;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function json(response: ServerResponse, value: unknown, status = 200): void {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(value));
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
