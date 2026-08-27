import { createHash } from 'node:crypto';

import type { AppConfig, EmbeddingAdapter } from '../core/types.js';
import {
  validateApiBaseUrl,
  validateHttpApiKey,
  validateHttpHeaders,
} from './models.js';
import {
  createNetworkPolicy,
  isLoopbackHostname,
  type OutboundNetworkPolicy,
} from '../privacy/network-policy.js';

const DEFAULT_DIMENSIONS = 256;
const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';
const DEFAULT_OLLAMA_TIMEOUT_MS = 30_000;
const MAX_OLLAMA_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_COMPATIBLE_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_COMPATIBLE_BATCH = 64;
const MAX_COMPATIBLE_INPUT_CHARACTERS = 32_000;
const MAX_COMPATIBLE_TOTAL_CHARACTERS = 256_000;
const QWEN_PROJECT_RETRIEVAL_INSTRUCTION =
  'Retrieve project facts, commitments, blockers, deadlines, preferences, and decisions relevant to the query.';

export interface HashEmbeddingOptions {
  id?: string;
  dimensions?: number;
}

/**
 * A credential-free embedding intended as a deterministic offline fallback.
 *
 * This is feature hashing, not a learned semantic model. Word, word-bigram, and
 * character-trigram features make it useful for lexical/hybrid retrieval while
 * keeping its output stable across processes and platforms.
 */
export class DeterministicHashEmbeddingAdapter implements EmbeddingAdapter {
  readonly id: string;
  readonly dimensions: number;

  constructor(options: HashEmbeddingOptions = {}) {
    this.id = options.id ?? 'builtin-hash-v1';
    this.dimensions = positiveInteger(options.dimensions ?? DEFAULT_DIMENSIONS, 'dimensions');
  }

  async embed(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    throwIfAborted(signal);
    const vectors: number[][] = [];
    for (const text of texts) {
      throwIfAborted(signal);
      if (typeof text !== 'string') throw new TypeError('Embedding input must contain only strings');
      vectors.push(hashEmbedding(text, this.dimensions));
    }
    return vectors;
  }
}

/** Shorter alias for callers that do not need to distinguish the implementation version. */
export { DeterministicHashEmbeddingAdapter as HashEmbeddingAdapter };

export interface OllamaEmbeddingOptions {
  model: string;
  baseUrl?: string;
  id?: string;
  dimensions?: number;
  timeoutMs?: number;
  headers?: Record<string, string>;
  serviceDigest?: string;
  networkPolicy?: OutboundNetworkPolicy;
}

/** Adapter for Ollama's batched `POST /api/embed` endpoint. */
export class OllamaEmbeddingAdapter implements EmbeddingAdapter {
  readonly id: string;
  readonly dimensions?: number;
  readonly #model: string;
  readonly #endpoint: string;
  readonly #tagsEndpoint: string;
  readonly #timeoutMs: number;
  readonly #headers: Record<string, string>;
  readonly #networkPolicy: OutboundNetworkPolicy;
  readonly #serviceDigest: string | undefined;

  constructor(options: OllamaEmbeddingOptions) {
    if (!options.model.trim()) throw new Error('Ollama embedding model must not be empty');
    this.#model = options.model;
    if (options.serviceDigest !== undefined && !/^[a-f0-9]{64}$/u.test(options.serviceDigest)) {
      throw new Error('Ollama embedding serviceDigest must be a bare lowercase SHA-256 digest');
    }
    this.#serviceDigest = options.serviceDigest;
    this.id = options.id ?? (options.serviceDigest ? `${options.model}@sha256:${options.serviceDigest}` : options.model);
    if (options.dimensions !== undefined) {
      this.dimensions = positiveInteger(options.dimensions, 'dimensions');
    }
    this.#endpoint = ollamaEmbedEndpoint(options.baseUrl ?? DEFAULT_OLLAMA_URL);
    this.#tagsEndpoint = ollamaTagsEndpoint(options.baseUrl ?? DEFAULT_OLLAMA_URL);
    this.#timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_OLLAMA_TIMEOUT_MS, 'timeoutMs');
    this.#headers = validateHttpHeaders(options.headers, 'Ollama embedding', ['content-type']);
    this.#networkPolicy = options.networkPolicy ?? createNetworkPolicy();
    this.#networkPolicy.assertAllowed(this.#endpoint, `embedding adapter ${this.id}`);
    this.#networkPolicy.assertAllowed(this.#tagsEndpoint, `embedding adapter ${this.id} identity`);
  }

  async embed(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    throwIfAborted(signal);
    if (texts.some((text) => typeof text !== 'string')) {
      throw new TypeError('Embedding input must contain only strings');
    }
    if (texts.length === 0) return [];

    const timeoutSignal = AbortSignal.timeout(this.#timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    await this.verifyIdentity(requestSignal);
    this.#networkPolicy.assertAllowed(this.#endpoint, `embedding adapter ${this.id}`);
    const response = await fetch(this.#endpoint, {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/json', ...this.#headers },
      body: JSON.stringify({
        model: this.#model,
        input: texts,
        ...(this.dimensions !== undefined ? { dimensions: this.dimensions } : {}),
        truncate: false,
      }),
      signal: requestSignal,
    });
    const rawBody = await readBoundedResponse(response, MAX_OLLAMA_RESPONSE_BYTES, 'Ollama');
    const body = parseJson(rawBody);
    if (!response.ok) {
      throw new OllamaEmbeddingError(
        response.status,
        responseError(body) ?? `Ollama embedding request failed with HTTP ${response.status}`,
      );
    }
    if (!isRecord(body) || !Array.isArray(body.embeddings)) {
      throw new Error('Ollama response does not contain an embeddings array');
    }
    if (typeof body.model === 'string' && body.model !== this.#model) {
      throw new Error(`Ollama embedding response model ${body.model} does not match ${this.#model}`);
    }
    if (body.embeddings.length !== texts.length) {
      throw new Error(
        `Ollama returned ${body.embeddings.length} embeddings for ${texts.length} inputs`,
      );
    }

    let responseDimensions: number | undefined;
    return body.embeddings.map((value, index) => {
      if (!Array.isArray(value) || value.some((item) => typeof item !== 'number' || !Number.isFinite(item))) {
        throw new Error(`Ollama embedding ${index} is not a finite numeric vector`);
      }
      const vector = value as number[];
      if (vector.length === 0) throw new Error(`Ollama embedding ${index} is empty`);
      responseDimensions ??= vector.length;
      if (vector.length !== responseDimensions) {
        throw new Error('Ollama returned embeddings with inconsistent dimensions');
      }
      if (this.dimensions !== undefined && vector.length !== this.dimensions) {
        throw new Error(
          `Ollama embedding has ${vector.length} dimensions; expected ${this.dimensions}`,
        );
      }
      const norm = Math.sqrt(vector.reduce((sum, item) => sum + item * item, 0));
      if (!Number.isFinite(norm) || norm === 0 || Math.abs(norm - 1) > 0.02) {
        throw new Error(`Ollama embedding ${index} is not unit-normalized`);
      }
      return [...vector];
    });
  }

  private async verifyIdentity(signal: AbortSignal): Promise<void> {
    if (!this.#serviceDigest) return;
    this.#networkPolicy.assertAllowed(this.#tagsEndpoint, `embedding adapter ${this.id} identity`);
    const response = await fetch(this.#tagsEndpoint, {
      method: 'GET',
      redirect: 'error',
      headers: { accept: 'application/json', ...this.#headers },
      signal,
    });
    const body = parseJson(await readBoundedResponse(response, MAX_OLLAMA_RESPONSE_BYTES, 'Ollama'));
    if (!response.ok) throw new OllamaEmbeddingError(response.status, `Ollama model identity request failed with HTTP ${response.status}`);
    const models = isRecord(body) && Array.isArray(body.models) ? body.models : [];
    const model = models.find((item) => isRecord(item)
      && (item.model === this.#model || item.name === this.#model));
    if (!isRecord(model) || model.digest !== this.#serviceDigest) {
      throw new Error(`Ollama embedding model ${this.#model} does not match the configured digest`);
    }
  }
}

export class OllamaEmbeddingError extends Error {
  readonly retryable: boolean;

  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'OllamaEmbeddingError';
    this.retryable = status === 408 || status === 409 || status === 429 || status >= 500;
  }
}

export interface OpenAICompatibleEmbeddingOptions {
  model: string;
  baseUrl: string;
  /** Operator-managed immutable generation; change it whenever provider weights can change. */
  generation: string;
  apiKey?: string;
  id?: string;
  dimensions: number;
  timeoutMs?: number;
  headers?: Record<string, string>;
  networkPolicy?: OutboundNetworkPolicy;
}

/** Dependency-free adapter for the standard `POST /embeddings` wire format. */
export class OpenAICompatibleEmbeddingAdapter implements EmbeddingAdapter {
  readonly id: string;
  readonly dimensions: number;
  readonly #model: string;
  readonly #endpoint: string;
  readonly #apiKey: string | undefined;
  readonly #timeoutMs: number;
  readonly #headers: Record<string, string>;
  readonly #external: boolean;
  readonly #networkPolicy: OutboundNetworkPolicy;

  constructor(options: OpenAICompatibleEmbeddingOptions) {
    if (!options.model.trim()) throw new Error('Compatible embedding model must not be empty');
    const baseUrl = validateApiBaseUrl(options.baseUrl, 'OpenAI-compatible embedding');
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/u.test(options.generation)) {
      throw new Error('Compatible embedding generation must be a 1-128 character safe identifier');
    }
    this.#model = options.model;
    this.#endpoint = compatibleEmbeddingEndpoint(baseUrl);
    this.#external = !isLoopbackHostname(new URL(this.#endpoint).hostname);
    if (this.#external && !options.apiKey) {
      throw new Error('OpenAI-compatible embedding API key is required outside loopback');
    }
    this.#apiKey = options.apiKey === undefined
      ? undefined
      : validateHttpApiKey(options.apiKey, 'OpenAI-compatible embedding');
    this.dimensions = positiveInteger(options.dimensions, 'dimensions');
    this.#timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_OLLAMA_TIMEOUT_MS, 'timeoutMs');
    this.#headers = validateHttpHeaders(options.headers, 'OpenAI-compatible embedding', [
      'authorization',
      'content-type',
    ]);
    this.#networkPolicy = options.networkPolicy ?? createNetworkPolicy();
    this.#networkPolicy.assertAllowed(this.#endpoint, `embedding adapter ${options.id ?? options.model}`);
    const endpointDigest = createHash('sha256').update(this.#endpoint).digest('hex').slice(0, 16);
    this.id = options.id
      ?? `openai-compatible:${endpointDigest}:${this.#model}:${options.generation}:d${this.dimensions}`;
  }

  async embed(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    throwIfAborted(signal);
    if (texts.some((text) => typeof text !== 'string')) {
      throw new TypeError('Embedding input must contain only strings');
    }
    if (texts.length === 0) return [];
    if (texts.length > MAX_COMPATIBLE_BATCH) {
      throw new Error(`Compatible embedding batch exceeds ${MAX_COMPATIBLE_BATCH} inputs`);
    }
    let totalCharacters = 0;
    for (const text of texts) {
      if (!text.length || text.length > MAX_COMPATIBLE_INPUT_CHARACTERS) {
        throw new Error(
          `Compatible embedding input must contain 1-${MAX_COMPATIBLE_INPUT_CHARACTERS} characters`,
        );
      }
      totalCharacters += text.length;
    }
    if (totalCharacters > MAX_COMPATIBLE_TOTAL_CHARACTERS) {
      throw new Error(
        `Compatible embedding batch exceeds ${MAX_COMPATIBLE_TOTAL_CHARACTERS} characters`,
      );
    }

    const timeoutSignal = AbortSignal.timeout(this.#timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    this.#networkPolicy.assertAllowed(this.#endpoint, `embedding adapter ${this.id}`);
    const response = await fetch(this.#endpoint, {
      method: 'POST',
      redirect: 'error',
      headers: {
        ...(this.#apiKey ? { authorization: `Bearer ${this.#apiKey}` } : {}),
        'content-type': 'application/json',
        ...this.#headers,
      },
      body: JSON.stringify({
        model: this.#model,
        input: texts,
        dimensions: this.dimensions,
        encoding_format: 'float',
      }),
      signal: requestSignal,
    });
    const body = parseJson(await readBoundedResponse(
      response,
      MAX_COMPATIBLE_RESPONSE_BYTES,
      'OpenAI-compatible embedding',
    ));
    if (!response.ok) {
      throw new OpenAICompatibleEmbeddingError(
        response.status,
        this.#external
          ? `External embedding request failed with HTTP ${response.status}`
          : responseError(body) ?? `Embedding request failed with HTTP ${response.status}`,
      );
    }
    if (!isRecord(body) || !Array.isArray(body.data)) {
      throw new Error('Compatible embedding response does not contain a data array');
    }
    if (typeof body.model === 'string' && body.model !== this.#model) {
      throw new Error(`Compatible embedding response model ${body.model} does not match ${this.#model}`);
    }
    if (body.data.length !== texts.length) {
      throw new Error(
        `Compatible endpoint returned ${body.data.length} embeddings for ${texts.length} inputs`,
      );
    }

    const ordered: Array<number[] | undefined> = Array.from({ length: texts.length });
    for (const item of body.data) {
      if (!isRecord(item) || !Number.isSafeInteger(item.index)
        || (item.index as number) < 0 || (item.index as number) >= texts.length
        || !Array.isArray(item.embedding)) {
        throw new Error('Compatible embedding response contains a malformed indexed vector');
      }
      const index = item.index as number;
      if (ordered[index]) throw new Error(`Compatible embedding response repeats index ${index}`);
      if (item.embedding.length !== this.dimensions
        || item.embedding.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
        throw new Error(
          `Compatible embedding ${index} must contain ${this.dimensions} finite numbers`,
        );
      }
      const vector = item.embedding as number[];
      const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
      if (!Number.isFinite(norm) || norm === 0) {
        throw new Error(`Compatible embedding ${index} is a zero or invalid vector`);
      }
      ordered[index] = vector.map((value) => value / norm);
    }
    if (ordered.some((vector) => vector === undefined)) {
      throw new Error('Compatible embedding response omits one or more indices');
    }
    return ordered as number[][];
  }
}

export class OpenAICompatibleEmbeddingError extends Error {
  readonly retryable: boolean;

  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'OpenAICompatibleEmbeddingError';
    this.retryable = status === 408 || status === 409 || status === 429 || status >= 500;
  }
}

export function createEmbeddingAdapter(
  config: NonNullable<AppConfig['embeddings']>,
  networkPolicy?: OutboundNetworkPolicy,
  environment: NodeJS.ProcessEnv = process.env,
): EmbeddingAdapter {
  if (config.provider === 'builtin') {
    if (config.baseUrl || config.apiKeyEnv || config.externalData || config.serviceDigest || config.generation) {
      throw new Error('Builtin embeddings do not accept endpoint, credential, disclosure, digest, or generation fields');
    }
    return new DeterministicHashEmbeddingAdapter({ id: config.model, dimensions: config.dimensions });
  }
  if (config.provider === 'ollama') {
    if (config.apiKeyEnv) throw new Error('Ollama embeddings do not accept apiKeyEnv');
    if (config.externalData) throw new Error('Ollama embeddings do not accept externalData');
    if (config.generation) throw new Error('Ollama embeddings use serviceDigest instead of generation');
    if (!config.serviceDigest) {
      throw new Error('Ollama embeddings require a reviewed serviceDigest to keep vector identity immutable');
    }
    return new OllamaEmbeddingAdapter({
      model: config.model,
      dimensions: config.dimensions,
      timeoutMs: config.timeoutMs,
      serviceDigest: config.serviceDigest,
      ...(networkPolicy ? { networkPolicy } : {}),
      ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    });
  }
  if (!config.baseUrl) throw new Error('OpenAI-compatible embeddings require baseUrl');
  if (config.serviceDigest) {
    throw new Error('OpenAI-compatible embeddings do not accept Ollama serviceDigest');
  }
  if (!config.generation) {
    throw new Error('OpenAI-compatible embeddings require an immutable generation identifier');
  }
  const baseUrl = validateApiBaseUrl(config.baseUrl, 'OpenAI-compatible embedding');
  const external = !isLoopbackHostname(new URL(baseUrl).hostname);
  if (external && config.externalData !== 'allow') {
    throw new Error('External embeddings require embeddings.externalData: allow');
  }
  if (config.apiKeyEnv && !/^[A-Z_][A-Z0-9_]*$/u.test(config.apiKeyEnv)) {
    throw new Error('Embedding apiKeyEnv must match [A-Z_][A-Z0-9_]*');
  }
  const apiKey = config.apiKeyEnv ? environment[config.apiKeyEnv] : undefined;
  if (external && !config.apiKeyEnv) {
    throw new Error('External embeddings require apiKeyEnv');
  }
  if (config.apiKeyEnv && !apiKey) {
    throw new Error(`Embedding credential environment variable ${config.apiKeyEnv} is not configured`);
  }
  return new OpenAICompatibleEmbeddingAdapter({
    model: config.model,
    baseUrl,
    generation: config.generation,
    dimensions: config.dimensions,
    timeoutMs: config.timeoutMs,
    ...(apiKey ? { apiKey } : {}),
    ...(networkPolicy ? { networkPolicy } : {}),
  });
}

export function formatEmbeddingQuery(model: string, query: string): string {
  return model.toLowerCase().includes('qwen3-embedding')
    ? `Instruct: ${QWEN_PROJECT_RETRIEVAL_INSTRUCTION}\nQuery:${query}`
    : query;
}

function hashEmbedding(text: string, dimensions: number): number[] {
  const vector = Array.from({ length: dimensions }, () => 0);
  // Locale-independent case folding keeps the same input stable on hosts with
  // different locale settings (notably for Latin I in Turkish locales).
  const normalized = text.normalize('NFKC').toLowerCase();
  const words = normalized.match(/[\p{L}\p{N}]+/gu) ?? [];
  const features: Array<readonly [string, number]> = [];

  for (const [index, word] of words.entries()) {
    features.push([`w:${word}`, 1]);
    const characters = ['^', ...Array.from(word).slice(0, 128), '$'];
    if (characters.length < 3) features.push([`c:${characters.join('')}`, 0.35]);
    for (let offset = 0; offset + 2 < characters.length; offset += 1) {
      features.push([`c:${characters.slice(offset, offset + 3).join('')}`, 0.35]);
    }
    const next = words[index + 1];
    if (next !== undefined) features.push([`b:${word}\u001f${next}`, 0.75]);
  }
  if (features.length === 0 && normalized.length > 0) features.push([`r:${normalized}`, 1]);

  for (const [feature, weight] of features) {
    const digest = createHash('sha256').update(feature).digest();
    const bucket = digest.readUInt32LE(0) % dimensions;
    const sign = (digest[4] ?? 0) & 1 ? -1 : 1;
    vector[bucket] = (vector[bucket] ?? 0) + sign * weight;
  }

  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return norm === 0 ? vector : vector.map((value) => value / norm);
}

function ollamaEmbedEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (!trimmed) throw new Error('Ollama base URL must not be empty');
  if (trimmed.endsWith('/api/embed')) return trimmed;
  if (trimmed.endsWith('/api')) return `${trimmed}/embed`;
  return `${trimmed}/api/embed`;
}

function ollamaTagsEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (!trimmed) throw new Error('Ollama base URL must not be empty');
  if (trimmed.endsWith('/api/embed')) return `${trimmed.slice(0, -'/embed'.length)}/tags`;
  if (trimmed.endsWith('/api')) return `${trimmed}/tags`;
  return `${trimmed}/api/tags`;
}

function compatibleEmbeddingEndpoint(baseUrl: string): string {
  return baseUrl.endsWith('/embeddings') ? baseUrl : `${baseUrl}/embeddings`;
}

async function readBoundedResponse(
  response: Response,
  maxBytes: number,
  provider: string,
): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`${provider} response exceeds ${maxBytes} bytes`);
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function parseJson(value: string): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function responseError(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.error === 'string') return value.error;
  if (isRecord(value.error) && typeof value.error.message === 'string') return value.error.message;
  return typeof value.message === 'string' ? value.message : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error('Operation aborted');
  error.name = 'AbortError';
  throw error;
}
