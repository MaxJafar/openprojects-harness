import {
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
} from 'node:http';

const DEFAULT_MAX_REQUEST_BODY_BYTES = 5_000_000;
const DEFAULT_MAX_REQUEST_HEADER_BYTES = 64 * 1024;
const DEFAULT_MAX_REQUEST_HEADERS = 100;
const DEFAULT_MAX_RESPONSE_HEADER_BYTES = 64 * 1024;
const DEFAULT_MAX_RESPONSE_HEADERS = 100;
const DEFAULT_HEADER_TIMEOUT_MS = 10_000;

const FORBIDDEN_REQUEST_HEADERS = new Set([
  'connection',
  'content-length',
  'expect',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export type UnixTransportErrorCode =
  | 'ABORTED'
  | 'ACCESS_DENIED'
  | 'BAD_RESPONSE'
  | 'BODY_TOO_LARGE'
  | 'CONNECTION_RESET'
  | 'INVALID_REQUEST'
  | 'REDIRECT_REFUSED'
  | 'SOCKET_ERROR'
  | 'TIMEOUT'
  | 'UNAVAILABLE';

/** A deliberately sanitized transport failure. It never includes the socket path. */
export class UnixTransportError extends Error {
  constructor(
    readonly code: UnixTransportErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'UnixTransportError';
  }
}

export interface UnixSocketFetchOptions {
  /** Absolute path to a Unix-domain socket prepared by the service endpoint helper. */
  socketPath: string;
  /** The sole URL origin accepted by the returned fetch function. */
  virtualOrigin?: string | URL;
  maxRequestBodyBytes?: number;
  maxRequestHeaderBytes?: number;
  maxRequestHeaders?: number;
  maxResponseHeaderBytes?: number;
  maxResponseHeaders?: number;
  /** Time allowed to receive response headers. The timer does not limit an SSE body. */
  headerTimeoutMs?: number;
}

interface NormalizedOptions {
  socketPath: string;
  virtualOrigin: string;
  maxRequestBodyBytes: number;
  maxRequestHeaderBytes: number;
  maxRequestHeaders: number;
  maxResponseHeaderBytes: number;
  maxResponseHeaders: number;
  headerTimeoutMs: number;
}

/**
 * Builds a fetch-compatible Node transport that sends requests through one Unix socket.
 *
 * The implementation intentionally supports only HTTP semantics needed by the local
 * control API: same-origin absolute URLs, JSON request bodies, and streaming response
 * bodies. It does not resolve DNS, use a proxy, or follow redirects.
 */
export function createUnixSocketFetch(options: UnixSocketFetchOptions): typeof globalThis.fetch {
  const normalized = normalizeOptions(options);
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let request: Request;
    try {
      request = new Request(input, init);
    } catch {
      throw new UnixTransportError('INVALID_REQUEST', 'The local control request is invalid');
    }
    validateRequestUrl(request.url, normalized.virtualOrigin);
    validateRequestMethod(request.method);
    const headers = validateRequestHeaders(request.headers, normalized);
    const body = await readRequestBody(request, normalized.maxRequestBodyBytes);
    validateRequestJson(headers, body);
    // Node's HTTP/1.1 server rejects a missing Host header. Derive it only from the
    // pinned virtual origin; caller-supplied Host is forbidden above.
    headers.host = new URL(normalized.virtualOrigin).host;
    if (body.byteLength > 0) headers['content-length'] = String(body.byteLength);
    return dispatchRequest(normalized, request, headers, body);
  }) as typeof globalThis.fetch;
}

function normalizeOptions(options: UnixSocketFetchOptions): NormalizedOptions {
  if (process.platform === 'win32') {
    throw new UnixTransportError('INVALID_REQUEST', 'Unix-socket transport is unavailable on this platform');
  }
  if (!options.socketPath.startsWith('/') || options.socketPath.includes('\0')) {
    throw new UnixTransportError('INVALID_REQUEST', 'The Unix socket path must be absolute');
  }
  const virtualOrigin = normalizeVirtualOrigin(options.virtualOrigin ?? 'http://localhost');
  return {
    socketPath: options.socketPath,
    virtualOrigin,
    maxRequestBodyBytes: boundedInteger(
      options.maxRequestBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES,
      'maxRequestBodyBytes',
      1,
      100_000_000,
    ),
    maxRequestHeaderBytes: boundedInteger(
      options.maxRequestHeaderBytes ?? DEFAULT_MAX_REQUEST_HEADER_BYTES,
      'maxRequestHeaderBytes',
      1_024,
      1_000_000,
    ),
    maxRequestHeaders: boundedInteger(
      options.maxRequestHeaders ?? DEFAULT_MAX_REQUEST_HEADERS,
      'maxRequestHeaders',
      1,
      1_000,
    ),
    maxResponseHeaderBytes: boundedInteger(
      options.maxResponseHeaderBytes ?? DEFAULT_MAX_RESPONSE_HEADER_BYTES,
      'maxResponseHeaderBytes',
      1_024,
      1_000_000,
    ),
    maxResponseHeaders: boundedInteger(
      options.maxResponseHeaders ?? DEFAULT_MAX_RESPONSE_HEADERS,
      'maxResponseHeaders',
      1,
      1_000,
    ),
    headerTimeoutMs: boundedInteger(
      options.headerTimeoutMs ?? DEFAULT_HEADER_TIMEOUT_MS,
      'headerTimeoutMs',
      100,
      120_000,
    ),
  };
}

function normalizeVirtualOrigin(value: string | URL): string {
  let url: URL;
  try {
    url = value instanceof URL ? new URL(value.toString()) : new URL(value);
  } catch {
    throw new UnixTransportError('INVALID_REQUEST', 'The virtual control origin is invalid');
  }
  if (url.protocol !== 'http:') {
    throw new UnixTransportError('INVALID_REQUEST', 'The virtual control origin must use http');
  }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new UnixTransportError('INVALID_REQUEST', 'The virtual control origin must be a credential-free origin');
  }
  return url.origin;
}

function validateRequestUrl(value: string, expectedOrigin: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new UnixTransportError('INVALID_REQUEST', 'The local control request URL is invalid');
  }
  if (url.origin !== expectedOrigin || url.protocol !== 'http:') {
    throw new UnixTransportError('INVALID_REQUEST', 'The local control request escaped its virtual origin');
  }
  if (url.username || url.password || url.hash) {
    throw new UnixTransportError('INVALID_REQUEST', 'The local control request URL contains forbidden components');
  }
}

function validateRequestMethod(method: string): void {
  if (!['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT'].includes(method)) {
    throw new UnixTransportError('INVALID_REQUEST', 'The local control request method is not allowed');
  }
}

function validateRequestHeaders(
  source: Headers,
  options: NormalizedOptions,
): Record<string, string> {
  const headers: Record<string, string> = {};
  let count = 0;
  let bytes = 0;
  source.forEach((value, name) => {
    count += 1;
    bytes += Buffer.byteLength(name) + Buffer.byteLength(value) + 4;
    if (count > options.maxRequestHeaders || bytes > options.maxRequestHeaderBytes) {
      throw new UnixTransportError('INVALID_REQUEST', 'The local control request has too many headers');
    }
    if (FORBIDDEN_REQUEST_HEADERS.has(name.toLowerCase())) {
      throw new UnixTransportError('INVALID_REQUEST', `The local control request header ${name} is forbidden`);
    }
    headers[name] = value;
  });
  return headers;
}

async function readRequestBody(request: Request, maximumBytes: number): Promise<Buffer> {
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  const abort = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  request.signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      if (request.signal.aborted) throw abortedError();
      const result = await reader.read();
      if (result.done) break;
      const chunk = Buffer.from(result.value);
      bytes += chunk.byteLength;
      if (bytes > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new UnixTransportError('BODY_TOO_LARGE', 'The local control request body exceeds its limit');
      }
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof UnixTransportError) throw error;
    if (request.signal.aborted) throw abortedError();
    throw new UnixTransportError('INVALID_REQUEST', 'The local control request body could not be read');
  } finally {
    request.signal.removeEventListener('abort', abort);
    reader.releaseLock();
  }
  return Buffer.concat(chunks, bytes);
}

function validateRequestJson(headers: Record<string, string>, body: Buffer): void {
  if (body.byteLength === 0) return;
  const value = headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
  if (value !== 'application/json' && !value?.endsWith('+json')) {
    throw new UnixTransportError('INVALID_REQUEST', 'The local control request body must use a JSON content type');
  }
  try {
    JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    throw new UnixTransportError('INVALID_REQUEST', 'The local control request body must contain valid JSON');
  }
}

function dispatchRequest(
  options: NormalizedOptions,
  request: Request,
  headers: Record<string, string>,
  body: Buffer,
): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    let response: IncomingMessage | undefined;
    let responseDelivered = false;
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    let outgoing: ClientRequest | undefined;

    const fail = (error: unknown): void => {
      if (responseDelivered) return;
      if (timer) clearTimeout(timer);
      request.signal.removeEventListener('abort', abort);
      reject(mapTransportError(error, { aborted: request.signal.aborted, timedOut }));
    };
    const abort = (): void => {
      const error = abortedError();
      response?.destroy(error);
      outgoing?.destroy(error);
      fail(error);
    };
    try {
      const url = new URL(request.url);
      outgoing = httpRequest({
        socketPath: options.socketPath,
        path: url.pathname + url.search,
        method: request.method,
        headers,
        maxHeaderSize: options.maxResponseHeaderBytes,
        setHost: false,
      });
    } catch (error) {
      fail(error);
      return;
    }
    outgoing.maxHeadersCount = options.maxResponseHeaders;
    outgoing.once('error', fail);
    outgoing.once('upgrade', (_incoming, socket) => {
      socket.destroy();
      fail(new UnixTransportError('BAD_RESPONSE', 'The local control service attempted a protocol upgrade'));
    });
    outgoing.once('response', (incoming) => {
      response = incoming;
      if (timer) clearTimeout(timer);
      const status = incoming.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        incoming.resume();
        incoming.destroy();
        fail(new UnixTransportError('REDIRECT_REFUSED', 'The local control service returned a forbidden redirect'));
        return;
      }
      if (status < 200 || status > 599) {
        incoming.resume();
        incoming.destroy();
        fail(new UnixTransportError('BAD_RESPONSE', 'The local control service returned an invalid response'));
        return;
      }
      try {
        const responseHeaders = responseHeadersFrom(incoming);
        const hasBody = request.method !== 'HEAD' && status !== 204 && status !== 205 && status !== 304;
        const stream = hasBody
          ? sanitizedResponseBody(incoming, request.signal)
          : null;
        const result = new Response(stream, {
          status,
          ...(incoming.statusMessage ? { statusText: incoming.statusMessage } : {}),
          headers: responseHeaders,
        });
        responseDelivered = true;
        incoming.once('close', () => request.signal.removeEventListener('abort', abort));
        resolve(result);
      } catch {
        incoming.destroy();
        fail(new UnixTransportError('BAD_RESPONSE', 'The local control service returned malformed HTTP'));
      }
    });

    if (request.signal.aborted) {
      abort();
      return;
    }
    request.signal.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => {
      timedOut = true;
      outgoing?.destroy(new Error('response header timeout'));
    }, options.headerTimeoutMs);
    timer.unref();
    try {
      outgoing.end(body);
    } catch (error) {
      fail(error);
    }
  });
}

function responseHeadersFrom(response: IncomingMessage): Headers {
  const headers = new Headers();
  for (let index = 0; index < response.rawHeaders.length; index += 2) {
    const name = response.rawHeaders[index];
    const value = response.rawHeaders[index + 1];
    if (name !== undefined && value !== undefined) headers.append(name, value);
  }
  return headers;
}

function sanitizedResponseBody(
  response: IncomingMessage,
  signal: AbortSignal,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      let settled = false;
      const cleanup = (): void => {
        response.off('data', onData);
        response.off('end', onEnd);
        response.off('error', onError);
        response.off('aborted', onAborted);
        response.off('close', onClose);
      };
      const close = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        controller.close();
      };
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        cleanup();
        controller.error(mapTransportError(error, { aborted: signal.aborted, timedOut: false }));
      };
      const onData = (chunk: Buffer): void => {
        // Copy away from Node's pooled Buffer before crossing into a Web stream.
        controller.enqueue(Uint8Array.from(chunk));
        if ((controller.desiredSize ?? 1) <= 0) response.pause();
      };
      const onEnd = (): void => close();
      const onError = (error: Error): void => fail(error);
      const onAborted = (): void => fail(signal.aborted
        ? abortedError()
        : new UnixTransportError(
            'CONNECTION_RESET',
            'The local control service closed the connection',
          ));
      const onClose = (): void => {
        if (response.complete) close();
        else onAborted();
      };
      response.on('data', onData);
      response.once('end', onEnd);
      response.once('error', onError);
      response.once('aborted', onAborted);
      response.once('close', onClose);
    },
    pull() {
      response.resume();
    },
    cancel() {
      response.destroy();
    },
  });
}

function mapTransportError(
  error: unknown,
  state: { aborted: boolean; timedOut: boolean },
): UnixTransportError {
  if (error instanceof UnixTransportError) return error;
  if (state.timedOut) {
    return new UnixTransportError('TIMEOUT', 'The local control service did not respond in time');
  }
  if (state.aborted) return abortedError();
  const code = systemErrorCode(error);
  if (code === 'EACCES' || code === 'EPERM') {
    return new UnixTransportError('ACCESS_DENIED', 'Access to the local control service was denied');
  }
  if (code === 'ENOENT' || code === 'ECONNREFUSED') {
    return new UnixTransportError('UNAVAILABLE', 'The local control service is unavailable');
  }
  if (code === 'ECONNRESET' || code === 'EPIPE') {
    return new UnixTransportError('CONNECTION_RESET', 'The local control service closed the connection');
  }
  if (code === 'HPE_HEADER_OVERFLOW' || code?.startsWith('HPE_')) {
    return new UnixTransportError('BAD_RESPONSE', 'The local control service returned malformed HTTP');
  }
  if (code === 'ENAMETOOLONG') {
    return new UnixTransportError('INVALID_REQUEST', 'The local control transport configuration is invalid');
  }
  return new UnixTransportError('SOCKET_ERROR', 'The local control transport failed');
}

function systemErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

function abortedError(): UnixTransportError {
  return new UnixTransportError('ABORTED', 'The local control request was aborted');
}

function boundedInteger(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new UnixTransportError('INVALID_REQUEST', `${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}
