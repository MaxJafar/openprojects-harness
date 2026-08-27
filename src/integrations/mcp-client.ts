import { createHash } from 'node:crypto';
import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import { isAbsolute } from 'node:path';
import type { Readable } from 'node:stream';

import {
  Client,
  ReadBuffer,
  StreamableHTTPClientTransport,
  type FetchLike,
  type JSONRPCMessage,
  type Tool,
  type Transport,
  serializeMessage,
} from '@modelcontextprotocol/client';

import {
  TOOL_EXECUTION_AMBIGUOUS_CODE,
  ToolExecutionError,
} from '../core/kernel.js';
import type { JsonObject } from '../core/types.js';
import type {
  McpCallToolOptions,
  McpCallToolRequest,
  McpCallToolTransport,
} from '../mcp/gateway.js';
import {
  validateIntegrationManifest,
  type IntegrationManifest,
  type McpIntegrationManifest,
} from './manifest.js';
import {
  createNetworkPolicy,
  isLoopbackHostname,
  type OutboundNetworkPolicy,
} from '../privacy/network-policy.js';
import { isShellFreeExecutablePath } from '../runtime/executable-path.js';
import { OPENPROJECTS_VERSION } from '../version.js';

const CLIENT_INFO = Object.freeze({ name: 'openprojects', version: OPENPROJECTS_VERSION });
const MODERN_PROTOCOL_VERSION = '2026-07-28';
const TOOL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const TRANSPORT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_REQUIRED_TOOLS = 64;
const MAX_TOOL_LIST_PAGES = 64;
const MAX_CONNECT_TIMEOUT_MS = 300_000;
const MAX_SHUTDOWN_TIMEOUT_MS = 30_000;
const MAX_WIRE_REQUEST_BYTES = 65_536;
const MAX_WIRE_RESPONSE_BYTES = 262_144;
const MAX_STDERR_BYTES = 262_144;
const MAX_PENDING_REQUESTS = 64;
const MAX_ARGV_ENTRIES = 128;
const MAX_ARG_BYTES = 8_192;
const MAX_ENV_VALUE_BYTES = 65_536;
const SENSITIVE_QUERY_NAME = /(?:^|[_-])(?:access[_-]?token|api[_-]?key|token|key|secret|password|signature|credential|authorization)(?:$|[_-])/iu;

export type McpProtocolPolicy = 'legacy' | 'auto' | typeof MODERN_PROTOCOL_VERSION;

export interface ExpectedMcpServer {
  readonly name: string;
  readonly version: string;
}

export interface McpWireLimits {
  /** Bounds the complete connect, identity, and required-tool verification phase. */
  readonly connectTimeoutMs: number;
  /** Bounds each serialized HTTP request body and locally constructed tool call. */
  readonly maxWireRequestBytes: number;
  /** Bounds each inbound stdio message or HTTP response body before JSON parsing. */
  readonly maxWireResponseBytes: number;
  /** Bounds adversarial pagination during required-tool verification. Defaults to 16. */
  readonly maxToolListPages?: number;
  /** Bounds concurrent tools/call requests. Defaults to 1. */
  readonly maxPendingRequests?: number;
  /** Bounds owned transport teardown. Defaults to 5 seconds. */
  readonly shutdownTimeoutMs?: number;
}

interface BaseMcpClientConfig {
  readonly id: string;
  readonly protocol?: McpProtocolPolicy;
  readonly expectedServer: ExpectedMcpServer;
  readonly requiredTools: readonly string[];
  readonly limits: McpWireLimits;
}

export interface McpStdioClientConfig extends BaseMcpClientConfig {
  readonly type: 'mcp-stdio';
  /** Absolute executable path. It is passed directly to spawn; no shell is used. */
  readonly executable: string;
  readonly argv: readonly string[];
  /** Absolute, reviewed working directory. */
  readonly cwd: string;
  /** Child variable name -> source host variable name. No ambient variables are inherited. */
  readonly env?: Readonly<Record<string, string>>;
  readonly limits: McpWireLimits & {
    /** Maximum stderr bytes retained privately; additional bytes are drained and discarded. */
    readonly maxStderrBytes: number;
  };
}

export interface McpHttpClientConfig extends BaseMcpClientConfig {
  readonly type: 'mcp-http';
  /** Exact MCP endpoint. Remote endpoints require HTTPS; HTTP is loopback-only. */
  readonly endpoint: string;
  /** Optional static bearer token source. OAuth and refresh are deliberately unsupported. */
  readonly bearerTokenEnv?: string;
}

export type McpClientConfig = McpStdioClientConfig | McpHttpClientConfig;

export interface McpClientDependencies {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: FetchLike;
  readonly networkPolicy?: OutboundNetworkPolicy;
}

export type McpClientErrorCode =
  | 'MCP_CLIENT_INVALID_CONFIG'
  | 'MCP_CLIENT_NOT_STARTED'
  | 'MCP_CLIENT_START_FAILED'
  | 'MCP_CLIENT_SERVER_MISMATCH'
  | 'MCP_CLIENT_TOOL_MISMATCH'
  | 'MCP_CLIENT_TOOL_NOT_ALLOWED'
  | 'MCP_CLIENT_KEYED_IDEMPOTENCY_UNSUPPORTED'
  | 'MCP_CLIENT_REQUEST_TOO_LARGE'
  | 'MCP_CLIENT_RESPONSE_TOO_LARGE'
  | 'MCP_CLIENT_REDIRECT_BLOCKED'
  | 'MCP_CLIENT_HTTP_BLOCKED'
  | 'MCP_CLIENT_CALL_FAILED';

/** Messages are intentionally generic: peer data, endpoints, and credentials never enter them. */
export class McpClientError extends Error {
  constructor(
    readonly code: McpClientErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'McpClientError';
  }
}

/**
 * Constructs a reviewed, lifecycle-owned MCP tools client.
 *
 * The returned transport performs discovery only to verify exact configured
 * server/tool identities. Remote schemas and annotations are not cached or
 * passed to `callTool`; the gateway's local declarations remain authoritative.
 */
export function createMcpClientTransport(
  config: McpClientConfig | IntegrationManifest,
  dependencies: McpClientDependencies = {},
): McpCallToolTransport {
  return new ReviewedMcpClientTransport(adaptManifestConfig(config), dependencies);
}

class ReviewedMcpClientTransport implements McpCallToolTransport {
  readonly id: string;
  readonly snapshotBinding: JsonObject;

  readonly #config: McpClientConfig;
  readonly #protocol: McpProtocolPolicy;
  readonly #requiredTools: ReadonlySet<string>;
  readonly #environment: Readonly<Record<string, string | undefined>>;
  readonly #networkPolicy: OutboundNetworkPolicy;
  readonly #baseFetch: FetchLike;
  readonly #lifecycleAbort = new AbortController();

  #client: Client | undefined;
  #wireTransport: StrictStdioClientTransport | StreamableHTTPClientTransport | undefined;
  #stderrCapture: BoundedStderrCapture | undefined;
  #startPromise: Promise<void> | undefined;
  #started = false;
  #closed = false;
  #pendingCalls = 0;

  constructor(config: McpClientConfig, dependencies: McpClientDependencies) {
    this.#config = normalizeConfig(config);
    this.id = this.#config.id;
    this.#protocol = this.#config.protocol
      ?? (this.#config.type === 'mcp-stdio' ? 'legacy' : 'auto');
    this.#requiredTools = new Set(this.#config.requiredTools);
    this.#environment = dependencies.environment ?? process.env;
    this.#networkPolicy = dependencies.networkPolicy ?? createNetworkPolicy();
    this.#baseFetch = dependencies.fetch ?? ((url, init) => fetch(url, init));

    if (this.#config.type === 'mcp-http') {
      assertHttpPolicy(this.#config.endpoint, this.#networkPolicy);
    }
    this.snapshotBinding = deepFreezeJson(createSnapshotBinding(this.#config, this.#protocol));
  }

  start(): Promise<void> {
    if (this.#closed) {
      return Promise.reject(clientError('MCP_CLIENT_NOT_STARTED', 'The MCP client is not available'));
    }
    this.#startPromise ??= this.#startOwnedClient();
    return this.#startPromise;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#started = false;
    this.#lifecycleAbort.abort();
    await this.#disposeOwnedClient();
  }

  async callTool(request: McpCallToolRequest, options: McpCallToolOptions): Promise<unknown> {
    if (!this.#started || !this.#client || this.#closed) {
      throw clientError('MCP_CLIENT_NOT_STARTED', 'The MCP client is not available');
    }
    if (!this.#requiredTools.has(request.name)) {
      throw clientError('MCP_CLIENT_TOOL_NOT_ALLOWED', 'The MCP tool is not in the reviewed allowlist');
    }
    if (options.idempotency === 'keyed') {
      // MCP has no standard idempotency-key contract. Forwarding the host key
      // without a reviewed peer contract would create false replay safety.
      throw clientError(
        'MCP_CLIENT_KEYED_IDEMPOTENCY_UNSUPPORTED',
        'Keyed idempotency is not supported by this MCP transport',
      );
    }
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) {
      throw clientError('MCP_CLIENT_INVALID_CONFIG', 'The MCP call timeout is invalid');
    }
    if (options.signal.aborted) throw options.signal.reason ?? new DOMException('Aborted', 'AbortError');
    if (this.#pendingCalls >= (this.#config.limits.maxPendingRequests ?? 1)) {
      throw clientError('MCP_CLIENT_CALL_FAILED', 'The MCP client has reached its request limit');
    }

    assertConstructedRequestSize(request, this.#config.limits.maxWireRequestBytes);
    const localToolIdentity: Tool = {
      name: request.name,
      inputSchema: { type: 'object' },
    };

    this.#pendingCalls += 1;
    try {
      // Passing a minimal, locally constructed definition prevents the SDK
      // from consulting a remote tools/list schema for output validation or
      // x-mcp-header mirroring. The gateway validates the real local schemas.
      return await this.#client.callTool(
        { name: request.name, arguments: request.arguments },
        {
          signal: options.signal,
          timeout: options.timeoutMs,
          maxTotalTimeout: options.timeoutMs,
          toolDefinition: localToolIdentity,
        },
      );
    } catch (error) {
      if (options.idempotency === 'none') {
        throw new ToolExecutionError(
          TOOL_EXECUTION_AMBIGUOUS_CODE,
          'The MCP tool execution outcome is unknown',
        );
      }
      if (options.signal.aborted) throw options.signal.reason ?? error;
      throw clientError('MCP_CLIENT_CALL_FAILED', 'The MCP tool call failed');
    } finally {
      this.#pendingCalls -= 1;
    }
  }

  async #startOwnedClient(): Promise<void> {
    const timeoutSignal = AbortSignal.timeout(this.#config.limits.connectTimeoutMs);
    const signal = AbortSignal.any([this.#lifecycleAbort.signal, timeoutSignal]);

    try {
      const wireTransport = this.#createWireTransport();
      const client = new Client(CLIENT_INFO, {
        capabilities: {},
        enforceStrictCapabilities: true,
        inputRequired: { autoFulfill: false },
        versionNegotiation: {
          mode: this.#protocol === MODERN_PROTOCOL_VERSION
            ? { pin: MODERN_PROTOCOL_VERSION }
            : this.#protocol,
          probe: { timeoutMs: this.#config.limits.connectTimeoutMs, maxRetries: 0 },
        },
      });
      // Errors are observed through awaited operations and converted below;
      // never print SDK/peer messages out of band.
      client.onerror = () => undefined;
      this.#wireTransport = wireTransport;
      this.#client = client;

      await client.connect(wireTransport, {
        signal,
        timeout: this.#config.limits.connectTimeoutMs,
        maxTotalTimeout: this.#config.limits.connectTimeoutMs,
      });
      await this.#verifyServerAndTools(client, signal);
      if (this.#closed) throw clientError('MCP_CLIENT_NOT_STARTED', 'The MCP client is not available');
      this.#started = true;
    } catch (error) {
      await this.#disposeOwnedClient();
      if (error instanceof McpClientError) throw error;
      throw clientError('MCP_CLIENT_START_FAILED', 'The MCP client failed to start');
    }
  }

  #createWireTransport(): StrictStdioClientTransport | StreamableHTTPClientTransport {
    if (this.#config.type === 'mcp-stdio') {
      const capture = new BoundedStderrCapture(this.#config.limits.maxStderrBytes);
      const transport = new StrictStdioClientTransport({
        command: this.#config.executable,
        args: this.#config.argv,
        cwd: this.#config.cwd,
        env: resolveMappedEnvironment(this.#config.env, this.#environment),
        stderr: 'pipe',
        maxBufferSize: this.#config.limits.maxWireResponseBytes,
        maxRequestBytes: this.#config.limits.maxWireRequestBytes,
        shutdownTimeoutMs: this.#config.limits.shutdownTimeoutMs ?? 5_000,
        stderrCapture: capture,
      });
      this.#stderrCapture = capture;
      return transport;
    }

    const endpoint = new URL(this.#config.endpoint);
    const token = this.#config.bearerTokenEnv === undefined
      ? undefined
      : readSecretEnvironment(this.#config.bearerTokenEnv, this.#environment);
    const boundedFetch = createBoundedMcpFetch({
      endpoint,
      maxRequestBytes: this.#config.limits.maxWireRequestBytes,
      maxResponseBytes: this.#config.limits.maxWireResponseBytes,
      networkPolicy: this.#networkPolicy,
      fetch: this.#baseFetch,
    });
    return new StreamableHTTPClientTransport(endpoint, {
      fetch: boundedFetch,
      requestInit: { redirect: 'error' },
      ...(token === undefined ? {} : { authProvider: { token: async () => token } }),
      onInsufficientScope: 'throw',
      maxStepUpRetries: 0,
      reconnectionOptions: {
        initialReconnectionDelay: 1_000,
        maxReconnectionDelay: 1_000,
        reconnectionDelayGrowFactor: 1,
        maxRetries: 0,
      },
    });
  }

  async #verifyServerAndTools(client: Client, signal: AbortSignal): Promise<void> {
    const server = client.getServerVersion();
    if (
      server?.name !== this.#config.expectedServer.name
      || server.version !== this.#config.expectedServer.version
    ) {
      throw clientError(
        'MCP_CLIENT_SERVER_MISMATCH',
        'The MCP server identity did not match the reviewed configuration',
      );
    }

    const found = new Set<string>();
    const seenRemoteNames = new Set<string>();
    const seenCursors = new Set<string>();
    const maximumPages = this.#config.limits.maxToolListPages ?? 16;
    let cursor: string | undefined;

    for (let pageNumber = 0; pageNumber < maximumPages; pageNumber += 1) {
      const result = await client.request(
        cursor === undefined
          ? { method: 'tools/list' }
          : { method: 'tools/list', params: { cursor } },
        {
          signal,
          timeout: this.#config.limits.connectTimeoutMs,
          maxTotalTimeout: this.#config.limits.connectTimeoutMs,
        },
      );
      for (const tool of result.tools) {
        if (seenRemoteNames.has(tool.name)) {
          throw clientError(
            'MCP_CLIENT_TOOL_MISMATCH',
            'The MCP server tool list did not match the reviewed configuration',
          );
        }
        seenRemoteNames.add(tool.name);
        if (this.#requiredTools.has(tool.name)) found.add(tool.name);
      }

      if (result.nextCursor === undefined) {
        if (found.size !== this.#requiredTools.size) {
          throw clientError(
            'MCP_CLIENT_TOOL_MISMATCH',
            'The MCP server tool list did not match the reviewed configuration',
          );
        }
        return;
      }
      if (seenCursors.has(result.nextCursor)) {
        throw clientError(
          'MCP_CLIENT_TOOL_MISMATCH',
          'The MCP server tool list did not match the reviewed configuration',
        );
      }
      seenCursors.add(result.nextCursor);
      cursor = result.nextCursor;
    }

    throw clientError(
      'MCP_CLIENT_TOOL_MISMATCH',
      'The MCP server tool list did not match the reviewed configuration',
    );
  }

  async #disposeOwnedClient(): Promise<void> {
    const client = this.#client;
    const transport = this.#wireTransport;
    this.#client = undefined;
    this.#wireTransport = undefined;
    this.#started = false;
    try {
      const closing = client ? client.close() : transport?.close();
      if (closing) {
        await settleWithin(closing, this.#config.limits.shutdownTimeoutMs ?? 5_000);
      }
    } catch {
      // Teardown diagnostics can contain child stderr, endpoint paths, or
      // response bodies. The owned resources were still signalled to close.
    } finally {
      this.#stderrCapture?.clear();
      this.#stderrCapture = undefined;
    }
  }
}

interface StrictStdioOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly stderr: 'pipe' | 'ignore';
  readonly maxBufferSize: number;
  readonly maxRequestBytes: number;
  readonly shutdownTimeoutMs: number;
  readonly stderrCapture: BoundedStderrCapture;
}

/** SDK-compatible stdio framing with an exact, empty-by-default child environment. */
class StrictStdioClientTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T) => void;

  /** Read structurally by SDK v2 to create a disposable auto-negotiation sibling. */
  readonly _serverParams: StrictStdioOptions;
  readonly #readBuffer: ReadBuffer;
  #process: ChildProcessWithoutNullStreams | undefined;
  #closeNotified = false;

  constructor(options: StrictStdioOptions) {
    this._serverParams = Object.freeze({
      ...options,
      args: Object.freeze([...options.args]),
      env: Object.freeze({ ...options.env }),
    });
    this.#readBuffer = new ReadBuffer({ maxBufferSize: options.maxBufferSize });
  }

  get stderr(): Readable | null {
    return this._serverParams.stderr === 'pipe' ? this.#process?.stderr ?? null : null;
  }

  get pid(): number | null {
    return this.#process?.pid ?? null;
  }

  async start(): Promise<void> {
    if (this.#process) throw clientError('MCP_CLIENT_START_FAILED', 'The MCP client failed to start');

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this._serverParams.command, [...this._serverParams.args], {
        cwd: this._serverParams.cwd,
        env: { ...this._serverParams.env },
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      throw clientError('MCP_CLIENT_START_FAILED', 'The MCP client failed to start');
    }
    this.#process = child;
    this.#closeNotified = false;

    child.stdout.on('data', (chunk: Buffer) => this.#acceptStdout(chunk));
    child.stdout.on('error', () => this.#failWire());
    child.stdin.on('error', () => this.#failWire());
    if (this._serverParams.stderr === 'pipe') {
      child.stderr.on('data', (chunk: Buffer) => this._serverParams.stderrCapture.push(chunk));
    } else {
      child.stderr.resume();
    }
    child.stderr.on('error', () => undefined);
    child.once('exit', () => {
      // A descendant can inherit the pipes and keep them open after the direct
      // child exits. Never let that orphan retain this harness process: fail
      // pending protocol work, release buffers, and destroy every owned pipe.
      if (this.#process === child) this.#process = undefined;
      this.#readBuffer.clear();
      child.stdout.destroy();
      child.stdin.destroy();
      child.stderr.destroy();
      this.#notifyClose();
    });

    await new Promise<void>((resolve, reject) => {
      let spawned = false;
      child.once('spawn', () => {
        spawned = true;
        resolve();
      });
      child.once('error', () => {
        this.#failWire();
        if (!spawned) reject(clientError('MCP_CLIENT_START_FAILED', 'The MCP client failed to start'));
      });
    });
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const child = this.#process;
    if (!child?.stdin.writable) {
      throw clientError('MCP_CLIENT_CALL_FAILED', 'The MCP stdio request failed');
    }
    const serialized = serializeMessage(message);
    if (Buffer.byteLength(serialized, 'utf8') > this._serverParams.maxRequestBytes) {
      throw clientError('MCP_CLIENT_REQUEST_TOO_LARGE', 'The MCP request exceeded its wire limit');
    }
    try {
      await new Promise<void>((resolve, reject) => {
        child.stdin.write(serialized, (error) => {
          if (error) reject(clientError('MCP_CLIENT_CALL_FAILED', 'The MCP stdio request failed'));
          else resolve();
        });
      });
    } catch (error) {
      if (error instanceof McpClientError) throw error;
      throw clientError('MCP_CLIENT_CALL_FAILED', 'The MCP stdio request failed');
    }
  }

  async close(): Promise<void> {
    const child = this.#process;
    this.#process = undefined;
    this.#readBuffer.clear();
    if (!child) {
      this.#notifyClose();
      return;
    }

    const deadline = Date.now() + this._serverParams.shutdownTimeoutMs;
    try {
      child.stdin.end();
    } catch {
      // Continue through signal escalation.
    }
    await waitForProcessExit(child, Math.min(1_000, remainingMs(deadline)));
    if (isProcessRunning(child)) {
      try {
        child.kill('SIGTERM');
      } catch {
        // Continue to the hard-kill stage.
      }
      await waitForProcessExit(child, Math.min(1_000, remainingMs(deadline)));
    }
    if (isProcessRunning(child)) {
      try {
        child.kill('SIGKILL');
      } catch {
        // The process may have exited between the check and signal.
      }
      await waitForProcessExit(child, remainingMs(deadline));
    }
    child.stdout.destroy();
    child.stdin.destroy();
    child.stderr.destroy();
    this.#notifyClose();
  }

  #acceptStdout(chunk: Buffer): void {
    try {
      this.#readBuffer.append(chunk);
      while (true) {
        const message = this.#readBuffer.readMessage();
        if (message === null) return;
        this.onmessage?.(message);
      }
    } catch {
      this.#failWire();
      void this.close();
    }
  }

  #failWire(): void {
    this.onerror?.(clientError('MCP_CLIENT_CALL_FAILED', 'The MCP stdio connection failed'));
  }

  #notifyClose(): void {
    if (this.#closeNotified) return;
    this.#closeNotified = true;
    this.onclose?.();
  }

  /** SDK disposable-sibling reaper hook; deliberately an own prototype method. */
  async _dispose(): Promise<void> {
    await this.close();
  }
}

interface BoundedFetchOptions {
  readonly endpoint: URL;
  readonly maxRequestBytes: number;
  readonly maxResponseBytes: number;
  readonly networkPolicy: OutboundNetworkPolicy;
  readonly fetch: FetchLike;
}

function createBoundedMcpFetch(options: BoundedFetchOptions): FetchLike {
  const expectedEndpoint = options.endpoint.href;
  return async (value, init) => {
    let requestUrl: URL;
    try {
      requestUrl = new URL(value.toString());
    } catch {
      throw clientError('MCP_CLIENT_HTTP_BLOCKED', 'The MCP HTTP request was blocked');
    }
    if (requestUrl.href !== expectedEndpoint) {
      throw clientError('MCP_CLIENT_HTTP_BLOCKED', 'The MCP HTTP request was blocked');
    }
    try {
      options.networkPolicy.assertAllowed(requestUrl, 'MCP');
    } catch {
      throw clientError('MCP_CLIENT_HTTP_BLOCKED', 'The MCP HTTP request was blocked');
    }

    const requestBytes = bodyByteLength(init?.body);
    if (requestBytes > options.maxRequestBytes) {
      throw clientError('MCP_CLIENT_REQUEST_TOO_LARGE', 'The MCP request exceeded its wire limit');
    }

    let response: Response;
    try {
      response = await options.fetch(requestUrl, { ...init, redirect: 'error' });
    } catch (error) {
      if (error instanceof McpClientError) throw error;
      throw clientError('MCP_CLIENT_CALL_FAILED', 'The MCP HTTP request failed');
    }
    if (
      response.redirected
      || (response.url !== '' && response.url !== expectedEndpoint)
      || (response.status >= 300 && response.status < 400)
    ) {
      void response.body?.cancel().catch(() => undefined);
      throw clientError('MCP_CLIENT_REDIRECT_BLOCKED', 'The MCP HTTP redirect was blocked');
    }
    return boundResponseBody(response, options.maxResponseBytes);
  };
}

function boundResponseBody(response: Response, maximumBytes: number): Response {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null && /^\d+$/u.test(contentLength)) {
    if (BigInt(contentLength) > BigInt(maximumBytes)) {
      void response.body?.cancel().catch(() => undefined);
      throw clientError('MCP_CLIENT_RESPONSE_TOO_LARGE', 'The MCP response exceeded its wire limit');
    }
  }
  if (!response.body) return response;

  let bytesRead = 0;
  const boundedBody = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytesRead += chunk.byteLength;
      if (bytesRead > maximumBytes) {
        controller.error(
          clientError('MCP_CLIENT_RESPONSE_TOO_LARGE', 'The MCP response exceeded its wire limit'),
        );
        return;
      }
      controller.enqueue(chunk);
    },
  }));
  return new Response(boundedBody, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function bodyByteLength(body: BodyInit | null | undefined): number {
  if (body === undefined || body === null) return 0;
  if (typeof body === 'string') return Buffer.byteLength(body, 'utf8');
  if (body instanceof URLSearchParams) return Buffer.byteLength(body.toString(), 'utf8');
  if (body instanceof Blob) return body.size;
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  // The reviewed MCP transport emits JSON strings only. Reject streams and
  // multipart bodies because their size cannot be established before send.
  throw clientError('MCP_CLIENT_REQUEST_TOO_LARGE', 'The MCP request body type is unsupported');
}

function assertConstructedRequestSize(request: McpCallToolRequest, maximumBytes: number): void {
  let serialized: string;
  try {
    serialized = JSON.stringify({
      jsonrpc: '2.0',
      id: 0,
      method: 'tools/call',
      params: request,
    });
  } catch {
    throw clientError('MCP_CLIENT_INVALID_CONFIG', 'The MCP request is not valid JSON');
  }
  const bytes = Buffer.byteLength(serialized, 'utf8');
  if (bytes > maximumBytes) {
    throw clientError('MCP_CLIENT_REQUEST_TOO_LARGE', 'The MCP request exceeded its wire limit');
  }
}

function resolveMappedEnvironment(
  mapping: Readonly<Record<string, string>> | undefined,
  source: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [childName, sourceName] of Object.entries(mapping ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    const value = source[sourceName];
    if (value === undefined) {
      throw clientError('MCP_CLIENT_INVALID_CONFIG', 'A declared MCP environment variable is missing');
    }
    if (
      value.trim() !== value
      || Buffer.byteLength(value, 'utf8') > MAX_ENV_VALUE_BYTES
      || containsControl(value)
    ) {
      throw clientError('MCP_CLIENT_INVALID_CONFIG', 'A declared MCP environment variable is invalid');
    }
    resolved[childName] = value;
  }
  return resolved;
}

function readSecretEnvironment(
  name: string,
  source: Readonly<Record<string, string | undefined>>,
): string {
  const value = source[name];
  if (
    value === undefined
    || value.length < 1
    || value.trim() !== value
    || Buffer.byteLength(value, 'utf8') > 8_192
    || containsControl(value)
  ) {
    throw clientError('MCP_CLIENT_INVALID_CONFIG', 'The MCP bearer credential is unavailable');
  }
  return value;
}

function assertHttpPolicy(endpointValue: string, policy: OutboundNetworkPolicy): void {
  let endpoint: URL;
  try {
    endpoint = new URL(endpointValue);
  } catch {
    throw invalidConfig('The MCP HTTP endpoint is invalid');
  }
  if (
    endpoint.username
    || endpoint.password
    || endpoint.hash
    || (endpoint.protocol !== 'https:'
      && !(endpoint.protocol === 'http:' && isLoopbackHostname(endpoint.hostname)))
  ) {
    throw invalidConfig('The MCP HTTP endpoint does not satisfy transport policy');
  }
  for (const name of endpoint.searchParams.keys()) {
    if (SENSITIVE_QUERY_NAME.test(name)) {
      throw invalidConfig('The MCP HTTP endpoint must not contain credential parameters');
    }
  }
  try {
    policy.assertAllowed(endpoint, 'MCP');
  } catch {
    throw invalidConfig('The MCP HTTP endpoint is not allowed by network policy');
  }
}

function adaptManifestConfig(
  value: McpClientConfig | IntegrationManifest,
): McpClientConfig {
  if (!('schema' in value)) return value;
  validateIntegrationManifest(value);
  if (value.transport.kind === 'json-api') {
    throw invalidConfig('MCP client requires an MCP integration manifest');
  }
  const mcpManifest = value as McpIntegrationManifest;

  if (mcpManifest.tools.some((tool) => tool.idempotency === 'keyed')) {
    throw invalidConfig('Configured MCP tools cannot use keyed idempotency without a reviewed peer contract');
  }
  const minimumGatewayResponseBytes = Math.min(...mcpManifest.tools.map((tool) => tool.limits.maxResponseBytes));
  const minimumGatewayRequestBytes = Math.min(...mcpManifest.tools.map((tool) => tool.limits.maxRequestBytes));
  if (mcpManifest.transport.maxWireBytes > minimumGatewayResponseBytes) {
    throw invalidConfig('The MCP wire response limit must not exceed the gateway response limit');
  }
  const common = {
    id: mcpManifest.id,
    protocol: mcpManifest.transport.protocol,
    expectedServer: {
      name: mcpManifest.transport.expectedServerName,
      version: mcpManifest.transport.expectedServerVersion,
    },
    requiredTools: mcpManifest.tools.map((tool) => tool.remoteName),
  } as const;

  if (mcpManifest.transport.kind === 'mcp-stdio') {
    return {
      ...common,
      type: 'mcp-stdio',
      executable: mcpManifest.transport.command,
      argv: mcpManifest.transport.argv,
      cwd: mcpManifest.transport.cwd,
      env: mcpManifest.transport.env,
      limits: {
        connectTimeoutMs: mcpManifest.transport.startupTimeoutMs,
        shutdownTimeoutMs: mcpManifest.transport.shutdownTimeoutMs,
        maxWireRequestBytes: Math.min(mcpManifest.transport.maxWireBytes, minimumGatewayRequestBytes),
        maxWireResponseBytes: mcpManifest.transport.maxWireBytes,
        maxPendingRequests: mcpManifest.transport.maxPendingRequests,
        maxStderrBytes: mcpManifest.transport.maxStderrBytes,
      },
    };
  }

  return {
    ...common,
    type: 'mcp-http',
    endpoint: mcpManifest.transport.endpoint,
    ...(mcpManifest.transport.bearerTokenEnv
      ? { bearerTokenEnv: mcpManifest.transport.bearerTokenEnv }
      : {}),
    limits: {
      connectTimeoutMs: mcpManifest.transport.startupTimeoutMs,
      maxWireRequestBytes: Math.min(mcpManifest.transport.maxWireBytes, minimumGatewayRequestBytes),
      maxWireResponseBytes: mcpManifest.transport.maxWireBytes,
      maxPendingRequests: mcpManifest.transport.maxPendingRequests,
    },
  };
}

function normalizeConfig(config: McpClientConfig): McpClientConfig {
  if (!config || typeof config !== 'object') throw invalidConfig('MCP client configuration is required');
  if (!TRANSPORT_ID_PATTERN.test(config.id)) throw invalidConfig('MCP client id is invalid');
  if (config.protocol !== undefined && !['legacy', 'auto', MODERN_PROTOCOL_VERSION].includes(config.protocol)) {
    throw invalidConfig('MCP protocol policy is invalid');
  }
  validateIdentity(config.expectedServer);
  validateRequiredTools(config.requiredTools);
  validateWireLimits(config.limits);

  const expectedServer = Object.freeze({
    name: config.expectedServer.name,
    version: config.expectedServer.version,
  });
  const requiredTools = Object.freeze([...config.requiredTools]);

  if (config.type === 'mcp-stdio') {
    if (!isAbsolute(config.executable) || containsControl(config.executable)) {
      throw invalidConfig('MCP stdio executable must be an absolute path');
    }
    if (!isShellFreeExecutablePath(config.executable)) {
      throw invalidConfig('MCP stdio executable requires a native .exe or .com path on Windows');
    }
    if (!isAbsolute(config.cwd) || containsControl(config.cwd)) {
      throw invalidConfig('MCP stdio working directory must be an absolute path');
    }
    if (!Array.isArray(config.argv) || config.argv.length > MAX_ARGV_ENTRIES) {
      throw invalidConfig('MCP stdio argv is invalid');
    }
    for (const argument of config.argv) {
      if (
        typeof argument !== 'string'
        || containsControl(argument)
        || Buffer.byteLength(argument, 'utf8') > MAX_ARG_BYTES
      ) {
        throw invalidConfig('MCP stdio argv is invalid');
      }
    }
    validateEnvironmentMapping(config.env);
    boundedInteger(config.limits.maxStderrBytes, 0, MAX_STDERR_BYTES, 'MCP stderr limit');
    return Object.freeze({
      ...config,
      expectedServer,
      requiredTools,
      limits: Object.freeze({ ...config.limits }),
      argv: Object.freeze([...config.argv]),
      env: Object.freeze({ ...config.env }),
    });
  }

  if (config.type !== 'mcp-http') throw invalidConfig('MCP client transport type is invalid');
  if (typeof config.endpoint !== 'string') throw invalidConfig('MCP HTTP endpoint is invalid');
  if (config.bearerTokenEnv !== undefined && !ENV_NAME_PATTERN.test(config.bearerTokenEnv)) {
    throw invalidConfig('MCP bearer environment-variable name is invalid');
  }
  return Object.freeze({
    ...config,
    expectedServer,
    requiredTools,
    limits: Object.freeze({ ...config.limits }),
  });
}

function validateIdentity(identity: ExpectedMcpServer): void {
  if (
    !identity
    || typeof identity.name !== 'string'
    || typeof identity.version !== 'string'
    || identity.name.length < 1
    || identity.version.length < 1
    || Buffer.byteLength(identity.name, 'utf8') > 256
    || Buffer.byteLength(identity.version, 'utf8') > 128
    || containsControl(identity.name)
    || containsControl(identity.version)
  ) {
    throw invalidConfig('Expected MCP server identity is invalid');
  }
}

function validateRequiredTools(tools: readonly string[]): void {
  if (!Array.isArray(tools) || tools.length < 1 || tools.length > MAX_REQUIRED_TOOLS) {
    throw invalidConfig('MCP required-tools allowlist is invalid');
  }
  const names = new Set<string>();
  for (const name of tools) {
    if (!TOOL_NAME_PATTERN.test(name) || names.has(name)) {
      throw invalidConfig('MCP required-tools allowlist is invalid');
    }
    names.add(name);
  }
}

function validateWireLimits(limits: McpWireLimits): void {
  if (!limits || typeof limits !== 'object') throw invalidConfig('MCP wire limits are required');
  boundedInteger(limits.connectTimeoutMs, 1, MAX_CONNECT_TIMEOUT_MS, 'MCP connect timeout');
  boundedInteger(limits.maxWireRequestBytes, 256, MAX_WIRE_REQUEST_BYTES, 'MCP request limit');
  boundedInteger(limits.maxWireResponseBytes, 256, MAX_WIRE_RESPONSE_BYTES, 'MCP response limit');
  if (limits.maxToolListPages !== undefined) {
    boundedInteger(limits.maxToolListPages, 1, MAX_TOOL_LIST_PAGES, 'MCP tool-list page limit');
  }
  if (limits.maxPendingRequests !== undefined) {
    boundedInteger(limits.maxPendingRequests, 1, MAX_PENDING_REQUESTS, 'MCP pending-request limit');
  }
  if (limits.shutdownTimeoutMs !== undefined) {
    boundedInteger(limits.shutdownTimeoutMs, 100, MAX_SHUTDOWN_TIMEOUT_MS, 'MCP shutdown timeout');
  }
}

function validateEnvironmentMapping(mapping: Readonly<Record<string, string>> | undefined): void {
  if (mapping === undefined) return;
  if (!isPlainRecord(mapping) || Object.keys(mapping).length > 64) {
    throw invalidConfig('MCP stdio environment mapping is invalid');
  }
  const childNames = new Set<string>();
  for (const [childName, sourceName] of Object.entries(mapping)) {
    if (!ENV_NAME_PATTERN.test(childName) || !ENV_NAME_PATTERN.test(sourceName)) {
      throw invalidConfig('MCP stdio environment mapping is invalid');
    }
    const comparisonName = process.platform === 'win32' ? childName.toUpperCase() : childName;
    if (childNames.has(comparisonName)) {
      throw invalidConfig('MCP stdio environment mapping is ambiguous on this platform');
    }
    childNames.add(comparisonName);
  }
}

function createSnapshotBinding(config: McpClientConfig, protocol: McpProtocolPolicy): JsonObject {
  const identity: JsonObject = {
    server: {
      name: config.expectedServer.name,
      version: config.expectedServer.version,
    },
    requiredTools: [...config.requiredTools].sort(),
  };
  const baseLimits: JsonObject = {
    connectTimeoutMs: config.limits.connectTimeoutMs,
    maxWireRequestBytes: config.limits.maxWireRequestBytes,
    maxWireResponseBytes: config.limits.maxWireResponseBytes,
    maxToolListPages: config.limits.maxToolListPages ?? 16,
    maxPendingRequests: config.limits.maxPendingRequests ?? 1,
    shutdownTimeoutMs: config.limits.shutdownTimeoutMs ?? 5_000,
  };

  if (config.type === 'mcp-stdio') {
    const environmentNames = Object.entries(config.env ?? {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([child, source]) => ({ child, source }));
    return {
      transport: 'mcp-stdio',
      process: {
        executable: config.executable,
        cwd: config.cwd,
        argvCount: config.argv.length,
        argvSha256: createHash('sha256').update(JSON.stringify(config.argv)).digest('hex'),
      },
      protocol,
      identity,
      environmentNames,
      limits: { ...baseLimits, maxStderrBytes: config.limits.maxStderrBytes },
    };
  }

  return {
    transport: 'mcp-http',
    endpoint: config.endpoint,
    protocol,
    identity,
    environmentNames: config.bearerTokenEnv === undefined
      ? []
      : [{ purpose: 'bearerToken', source: config.bearerTokenEnv }],
    limits: baseLimits,
  };
}

class BoundedStderrCapture {
  readonly #maximumBytes: number;
  #chunks: Buffer[] = [];
  #bytes = 0;

  constructor(maximumBytes: number) {
    this.#maximumBytes = maximumBytes;
  }

  push(value: unknown): void {
    if (this.#bytes >= this.#maximumBytes) return;
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
    const retained = chunk.subarray(0, this.#maximumBytes - this.#bytes);
    if (retained.length > 0) {
      this.#chunks.push(Buffer.from(retained));
      this.#bytes += retained.length;
    }
  }

  clear(): void {
    for (const chunk of this.#chunks) chunk.fill(0);
    this.#chunks = [];
    this.#bytes = 0;
  }
}

async function settleWithin(promise: Promise<void>, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    void promise.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      () => {
        clearTimeout(timer);
        resolve();
      },
    );
  });
}

async function waitForProcessExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<void> {
  if (!isProcessRunning(child) || timeoutMs <= 0) return;
  await new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      child.off('exit', finish);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    child.once('exit', finish);
  });
}

function isProcessRunning(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode === null && child.signalCode === null;
}

function remainingMs(deadline: number): number {
  return Math.max(0, deadline - Date.now());
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw invalidConfig(`${label} is invalid`);
  }
}

function containsControl(value: string): boolean {
  return /[\u0000-\u001f\u007f]/u.test(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function invalidConfig(message: string): McpClientError {
  return clientError('MCP_CLIENT_INVALID_CONFIG', message);
}

function clientError(code: McpClientErrorCode, message: string): McpClientError {
  return new McpClientError(code, message);
}

function deepFreezeJson<T extends JsonObject>(value: T): T {
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') deepFreezeUnknown(child);
  }
  return Object.freeze(value);
}

function deepFreezeUnknown(value: object): void {
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') deepFreezeUnknown(child);
  }
  Object.freeze(value);
}
