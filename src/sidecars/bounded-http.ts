import type { SidecarRequestEvidence } from './types.js';

const MAX_TOKEN_BYTES = 8_192;
const MIN_TOKEN_BYTES = 8;
const MAX_RETRY_DELAY_MS = 2_000;
const MAX_ATTEMPTS = 3;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

export interface BoundedProviderHttpOptions {
  readonly origin: string;
  readonly authorizationHeader: string;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  readonly fetch?: typeof globalThis.fetch;
  readonly delay?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  /** Applied to every decoded JSON string before provider normalization. */
  readonly responseStringRedactor?: (value: string) => string;
}

export interface SidecarProviderCredential {
  authorizationHeader(): string;
  redactResponseString(value: string): string;
  assertAbsent(value: string, context: string): void;
  assertJsonAbsent(value: string, context: string): void;
}

export interface ProviderJsonRequest {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  /** Optional redacted path template used only in qualification evidence. */
  readonly evidencePath?: string;
  readonly operation: SidecarRequestEvidence['operation'];
  readonly body?: unknown;
  readonly signal?: AbortSignal;
}

export class SidecarHttpError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'SidecarHttpError';
  }
}

class ProviderCredentialReflectionError extends Error {
  constructor() {
    super('Provider response reflected the configured credential');
    this.name = 'ProviderCredentialReflectionError';
  }
}

class ProviderCredentialPersistenceError extends Error {
  constructor(context: string) {
    super(`Provider credential overlaps ${context}; use separate identifiers and credentials`);
    this.name = 'ProviderCredentialPersistenceError';
  }
}

/** Exact-origin, bounded, retry-limited provider HTTP client for read operations only. */
export class BoundedProviderHttp {
  readonly origin: string;
  readonly #authorizationHeader: string;
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;
  readonly #fetch: typeof globalThis.fetch;
  readonly #delay: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly #responseStringRedactor: (value: string) => string;
  readonly #requests: SidecarRequestEvidence[] = [];

  constructor(options: BoundedProviderHttpOptions) {
    this.origin = exactHttpsOrigin(options.origin);
    validateAuthorization(options.authorizationHeader);
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1_000 || options.timeoutMs > 30_000) {
      throw new Error('Sidecar provider timeout must be between 1000 and 30000 milliseconds');
    }
    if (
      !Number.isSafeInteger(options.maxResponseBytes)
      || options.maxResponseBytes < 1_024
      || options.maxResponseBytes > 2_097_152
    ) {
      throw new Error('Sidecar provider response limit must be between 1024 and 2097152 bytes');
    }
    this.#authorizationHeader = options.authorizationHeader;
    this.#timeoutMs = options.timeoutMs;
    this.#maxResponseBytes = options.maxResponseBytes;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#delay = options.delay ?? abortableDelay;
    this.#responseStringRedactor = options.responseStringRedactor ?? ((value) => value);
  }

  evidence(): readonly SidecarRequestEvidence[] {
    return Object.freeze(this.#requests.map((request) => Object.freeze({ ...request })));
  }

  async json(request: ProviderJsonRequest): Promise<unknown> {
    const url = reviewedUrl(this.origin, request.path);
    if (request.method === 'GET' && request.body !== undefined) {
      throw new Error('Sidecar provider GET requests cannot contain a body');
    }
    if (request.method === 'POST' && request.body === undefined) {
      throw new Error('Sidecar provider POST query requires a structural JSON body');
    }
    const evidence = Object.freeze({
      method: request.method,
      origin: this.origin,
      path: request.evidencePath ?? `${url.pathname}${url.search}`,
      operation: request.operation,
    });
    const serializedBody = request.body === undefined ? undefined : JSON.stringify(request.body);

    const deadline = Date.now() + this.#timeoutMs;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new SidecarHttpError('PROVIDER_TIMEOUT', 'Provider read exceeded its deadline');
      const timeoutSignal = AbortSignal.timeout(remaining);
      const signal = request.signal
        ? AbortSignal.any([request.signal, timeoutSignal])
        : timeoutSignal;
      let response: Response;
      try {
        this.#requests.push(evidence);
        response = await this.#fetch(url, {
          method: request.method,
          headers: {
            accept: 'application/json',
            authorization: this.#authorizationHeader,
            ...(request.body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(serializedBody === undefined ? {} : { body: serializedBody }),
          redirect: 'error',
          credentials: 'omit',
          cache: 'no-store',
          referrerPolicy: 'no-referrer',
          signal,
        });
      } catch (error) {
        if (request.signal?.aborted) throw new SidecarHttpError('PROVIDER_ABORTED', 'Provider read was cancelled');
        if (attempt === MAX_ATTEMPTS) {
          throw new SidecarHttpError('PROVIDER_TRANSPORT', 'Provider read failed after bounded retries');
        }
        await this.#delay(retryDelay(undefined, attempt, deadline), request.signal ?? timeoutSignal);
        continue;
      }
      if (response.url && new URL(response.url).origin !== this.origin) {
        throw new SidecarHttpError('PROVIDER_ORIGIN_DRIFT', 'Provider response escaped the reviewed origin');
      }
      if (RETRYABLE_STATUS.has(response.status) && attempt < MAX_ATTEMPTS) {
        await discardBounded(response, this.#maxResponseBytes);
        if (request.signal?.aborted) {
          throw new SidecarHttpError('PROVIDER_ABORTED', 'Provider read was cancelled');
        }
        if (timeoutSignal.aborted) {
          throw new SidecarHttpError('PROVIDER_TIMEOUT', 'Provider read exceeded its deadline');
        }
        await this.#delay(
          retryDelay(response.headers.get('retry-after'), attempt, deadline),
          request.signal ?? timeoutSignal,
        );
        continue;
      }
      const text = await readMappedBody(
        response,
        this.#maxResponseBytes,
        request.signal,
        timeoutSignal,
      );
      if (!response.ok) {
        throw new SidecarHttpError(
          response.status === 401 || response.status === 403 ? 'PROVIDER_AUTH' : 'PROVIDER_RESPONSE',
          `Provider read returned HTTP ${response.status}`,
          response.status,
        );
      }
      const contentType = response.headers.get('content-type')?.toLocaleLowerCase() ?? '';
      if (!contentType.startsWith('application/json')) {
        throw new SidecarHttpError('PROVIDER_CONTENT_TYPE', 'Provider read returned a non-JSON response');
      }
      try {
        return JSON.parse(text, (_key, value: unknown) => (
          typeof value === 'string' ? this.#responseStringRedactor(value) : value
        )) as unknown;
      } catch (error) {
        if (error instanceof ProviderCredentialReflectionError) {
          throw new SidecarHttpError(
            'PROVIDER_CREDENTIAL_REFLECTION',
            'Provider response reflected the configured credential and was rejected',
          );
        }
        throw new SidecarHttpError('PROVIDER_JSON', 'Provider read returned invalid JSON');
      }
    }
    throw new SidecarHttpError('PROVIDER_TRANSPORT', 'Provider read failed');
  }
}

export function providerAuthorization(
  tokenEnv: string,
  environment: Readonly<Record<string, string | undefined>>,
  scheme: 'bearer' | 'raw',
): string {
  return providerCredential(tokenEnv, environment, scheme).authorizationHeader();
}

/**
 * Keep the opaque provider secret inside closures while supplying the exact
 * response scrubber used before any decoded provider string can be normalized.
 */
export function providerCredential(
  tokenEnv: string,
  environment: Readonly<Record<string, string | undefined>>,
  scheme: 'bearer' | 'raw',
): SidecarProviderCredential {
  const token = environment[tokenEnv];
  if (!token) throw new Error(`Provider credential environment variable ${tokenEnv} is not set`);
  if (
    Buffer.byteLength(token, 'utf8') < MIN_TOKEN_BYTES
    ||
    Buffer.byteLength(token, 'utf8') > MAX_TOKEN_BYTES
    || token.trim() !== token
    || /[\u0000-\u0020\u007f]/u.test(token)
  ) {
    throw new Error(`Provider credential environment variable ${tokenEnv} has an invalid value`);
  }
  const authorization = scheme === 'bearer' ? `Bearer ${token}` : token;
  const redact = (value: string): string => (
    value.includes(token) ? redactCredentialReflection(value, token) : value
  );
  const assertAbsent = (value: string, context: string): void => {
    if (value.includes(token)) throw new ProviderCredentialPersistenceError(context);
  };
  return Object.freeze({
    authorizationHeader: () => authorization,
    redactResponseString: redact,
    assertAbsent,
    assertJsonAbsent(value: string, context: string) {
      assertAbsent(value, context);
      try {
        JSON.parse(value, (_key, decoded: unknown) => {
          if (typeof decoded === 'string') assertAbsent(decoded, context);
          return decoded;
        });
      } catch (error) {
        if (error instanceof ProviderCredentialPersistenceError) throw error;
        throw new Error(`${context} could not be checked as structural JSON`);
      }
    },
  });
}

function redactCredentialReflection(value: string, token: string): string {
  const redacted = value.split(token).join('[REDACTED:PROVIDER_CREDENTIAL]');
  if (redacted.includes(token)) throw new ProviderCredentialReflectionError();
  return redacted;
}

function exactHttpsOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Sidecar provider origin is invalid');
  }
  if (
    value !== url.origin
    || url.protocol !== 'https:'
    || url.username
    || url.password
    || url.pathname !== '/'
    || url.search
    || url.hash
  ) {
    throw new Error('Sidecar provider origin must be an exact HTTPS origin');
  }
  return url.origin;
}

function reviewedUrl(origin: string, path: string): URL {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('#')) {
    throw new Error('Sidecar provider path must be an absolute path on the reviewed origin');
  }
  const url = new URL(path, origin);
  if (url.origin !== origin || url.username || url.password) {
    throw new Error('Sidecar provider path escaped the reviewed origin');
  }
  return url;
}

function validateAuthorization(value: string): void {
  if (
    !value
    || Buffer.byteLength(value, 'utf8') > MAX_TOKEN_BYTES + 7
    || /[\r\n\u0000]/u.test(value)
  ) {
    throw new Error('Sidecar provider authorization header is invalid');
  }
}

async function readBoundedBody(response: Response, limit: number): Promise<string> {
  const declared = response.headers.get('content-length');
  if (declared && Number(declared) > limit) {
    await response.body?.cancel();
    throw new SidecarHttpError('PROVIDER_RESPONSE_TOO_LARGE', 'Provider response exceeds the reviewed byte limit');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > limit) {
        await reader.cancel();
        throw new SidecarHttpError('PROVIDER_RESPONSE_TOO_LARGE', 'Provider response exceeds the reviewed byte limit');
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), bytes).toString('utf8');
}

async function readMappedBody(
  response: Response,
  limit: number,
  callerSignal: AbortSignal | undefined,
  timeoutSignal: AbortSignal,
): Promise<string> {
  try {
    return await readBoundedBody(response, limit);
  } catch (error) {
    if (error instanceof SidecarHttpError) throw error;
    if (callerSignal?.aborted) {
      throw new SidecarHttpError('PROVIDER_ABORTED', 'Provider read was cancelled');
    }
    if (timeoutSignal.aborted || errorName(error) === 'TimeoutError') {
      throw new SidecarHttpError('PROVIDER_TIMEOUT', 'Provider read exceeded its deadline');
    }
    throw new SidecarHttpError('PROVIDER_TRANSPORT', 'Provider response body could not be read');
  }
}

async function discardBounded(response: Response, limit: number): Promise<void> {
  try {
    await readBoundedBody(response, limit);
  } catch {
    await response.body?.cancel().catch(() => undefined);
  }
}

function retryDelay(value: string | null | undefined, attempt: number, deadline: number): number {
  let requested = 0;
  if (value) {
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) requested = seconds * 1_000;
    else {
      const date = Date.parse(value);
      if (Number.isFinite(date)) requested = Math.max(0, date - Date.now());
    }
  }
  const fallback = 100 * (2 ** (attempt - 1));
  return Math.max(0, Math.min(requested || fallback, MAX_RETRY_DELAY_MS, deadline - Date.now()));
}

async function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (milliseconds <= 0) return;
  await new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}

function errorName(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('name' in error)) return undefined;
  return typeof error.name === 'string' ? error.name : undefined;
}
