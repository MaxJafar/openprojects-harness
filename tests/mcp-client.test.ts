import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createMcpClientTransport,
  McpClientError,
  type McpHttpClientConfig,
  type McpStdioClientConfig,
} from '../src/integrations/mcp-client.js';
import type { McpIntegrationManifest } from '../src/integrations/manifest.js';
import type { McpCallToolOptions } from '../src/mcp/gateway.js';
import { createNetworkPolicy } from '../src/privacy/network-policy.js';
import type { JsonObject } from '../src/core/types.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const inputSchema: JsonObject = {
  type: 'object',
  additionalProperties: false,
  properties: { title: { type: 'string' } },
  required: ['title'],
};

function httpConfig(overrides: Partial<McpHttpClientConfig> = {}): McpHttpClientConfig {
  return {
    type: 'mcp-http',
    id: 'http-test',
    endpoint: 'https://mcp.example.test/exact',
    bearerTokenEnv: 'MCP_TEST_TOKEN',
    protocol: 'legacy',
    expectedServer: { name: 'reviewed-server', version: '1.2.3' },
    requiredTools: ['task_create'],
    limits: {
      connectTimeoutMs: 1_000,
      shutdownTimeoutMs: 500,
      maxWireRequestBytes: 2_048,
      maxWireResponseBytes: 2_048,
      maxToolListPages: 4,
      maxPendingRequests: 2,
    },
    ...overrides,
  };
}

function callOptions(overrides: Partial<McpCallToolOptions> = {}): McpCallToolOptions {
  return {
    idempotencyKey: 'local-key-never-forwarded',
    idempotency: 'read',
    timeoutMs: 500,
    signal: new AbortController().signal,
    ...overrides,
  };
}

interface HttpServerOptions {
  readonly serverName?: string;
  readonly tools?: readonly string[];
  readonly onCall?: (
    message: Record<string, unknown>,
    init: RequestInit | undefined,
  ) => Response | Promise<Response>;
}

function legacyHttpServer(options: HttpServerOptions = {}) {
  const calls: Array<{ url: string; init: RequestInit | undefined; message?: Record<string, unknown> }> = [];
  const fetch = vi.fn(async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const message = typeof init?.body === 'string'
      ? JSON.parse(init.body) as Record<string, unknown>
      : undefined;
    calls.push({ url: url.toString(), init, ...(message ? { message } : {}) });
    if (!message || typeof message.method !== 'string') {
      return new Response(null, { status: 405 });
    }
    if (!Object.hasOwn(message, 'id')) return new Response('', { status: 200 });
    if (message.method === 'initialize') {
      const params = message.params as { protocolVersion: string };
      return rpcResponse(message.id, {
        protocolVersion: params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: {
          name: options.serverName ?? 'reviewed-server',
          version: '1.2.3',
        },
      });
    }
    if (message.method === 'tools/list') {
      return rpcResponse(message.id, {
        tools: (options.tools ?? ['task_create']).map((name) => ({
          name,
          description: 'Remote text is untrusted.',
          inputSchema,
          // If this remote schema were cached as authority, the valid local
          // result used by the tests below would be rejected by the SDK.
          outputSchema: {
            type: 'object',
            additionalProperties: false,
            properties: { forbidden: { const: true } },
            required: ['forbidden'],
          },
          annotations: { destructiveHint: false, readOnlyHint: true },
        })),
      });
    }
    if (message.method === 'tools/call') {
      if (options.onCall) return options.onCall(message, init);
      return rpcResponse(message.id, {
        content: [{ type: 'text', text: 'remote text' }],
        structuredContent: { id: 'task-1', created: true },
      });
    }
    return rpcResponse(message.id, {}, -32601);
  });
  return { fetch, calls };
}

function rpcResponse(id: unknown, result: unknown, errorCode?: number): Response {
  const body = errorCode === undefined
    ? { jsonrpc: '2.0', id, result }
    : { jsonrpc: '2.0', id, error: { code: errorCode, message: 'remote error' } };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function remoteNetworkPolicy() {
  return createNetworkPolicy({ localOnly: false, allowedOrigins: [] });
}

describe('reviewed MCP HTTP client', () => {
  it('verifies exact identity/tools, sends static auth only to the exact endpoint, and returns the raw SDK result', async () => {
    const server = legacyHttpServer();
    const transport = createMcpClientTransport(httpConfig(), {
      environment: { MCP_TEST_TOKEN: 'super-secret-token' },
      fetch: server.fetch,
      networkPolicy: remoteNetworkPolicy(),
    });

    await transport.start?.();
    const result = await transport.callTool(
      { name: 'task_create', arguments: { title: 'Ship' } },
      callOptions(),
    );
    await transport.close?.();

    expect(result).toEqual({
      content: [{ type: 'text', text: 'remote text' }],
      structuredContent: { id: 'task-1', created: true },
    });
    expect(server.calls.every((call) => call.url === 'https://mcp.example.test/exact')).toBe(true);
    expect(server.calls.every((call) => new Headers(call.init?.headers).get('authorization') === 'Bearer super-secret-token')).toBe(true);
    expect(server.calls.find((call) => call.message?.method === 'tools/call')?.message).toMatchObject({
      method: 'tools/call',
      params: { name: 'task_create', arguments: { title: 'Ship' } },
    });
    expect(JSON.stringify(transport.snapshotBinding)).not.toContain('super-secret-token');
    expect(transport.snapshotBinding).toMatchObject({
      transport: 'mcp-http',
      endpoint: 'https://mcp.example.test/exact',
      protocol: 'legacy',
      environmentNames: [{ purpose: 'bearerToken', source: 'MCP_TEST_TOKEN' }],
    });
  });

  it('defaults HTTP to auto and rejects wrong server identities or missing exact tool names', async () => {
    const autoConfig = httpConfig();
    delete (autoConfig as { protocol?: McpHttpClientConfig['protocol'] }).protocol;
    const defaultTransport = createMcpClientTransport(
      autoConfig,
      { environment: { MCP_TEST_TOKEN: 'token' }, networkPolicy: remoteNetworkPolicy() },
    );
    expect(defaultTransport.snapshotBinding?.protocol).toBe('auto');

    for (const server of [
      legacyHttpServer({ serverName: 'impostor' }),
      legacyHttpServer({ tools: ['task_create_similar'] }),
    ]) {
      const transport = createMcpClientTransport(httpConfig(), {
        environment: { MCP_TEST_TOKEN: 'token' },
        fetch: server.fetch,
        networkPolicy: remoteNetworkPolicy(),
      });
      await expect(transport.start?.()).rejects.toBeInstanceOf(McpClientError);
      await transport.close?.();
    }
  });

  it('blocks redirects and redacts endpoint, credential, and peer error text', async () => {
    const redirecting = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: 'https://attacker.example/steal?token=super-secret-token' },
    }));
    const redirected = createMcpClientTransport(httpConfig(), {
      environment: { MCP_TEST_TOKEN: 'super-secret-token' },
      fetch: redirecting,
      networkPolicy: remoteNetworkPolicy(),
    });
    const redirectError = await redirected.start?.().catch((error: unknown) => error);
    expect(redirectError).toBeInstanceOf(McpClientError);
    expect(String(redirectError)).not.toContain('super-secret-token');
    expect(String(redirectError)).not.toContain('/exact');
    expect(redirecting).toHaveBeenCalledTimes(1);

    const throwing = createMcpClientTransport(httpConfig(), {
      environment: { MCP_TEST_TOKEN: 'super-secret-token' },
      fetch: async () => {
        throw new Error('super-secret-token https://mcp.example.test/exact peer payload');
      },
      networkPolicy: remoteNetworkPolicy(),
    });
    const thrown = await throwing.start?.().catch((error: unknown) => error);
    expect(String(thrown)).toBe('McpClientError: The MCP HTTP request failed');
  });

  it('bounds HTTP request and streaming response bytes before SDK JSON materialization', async () => {
    const server = legacyHttpServer({
      onCall: (message) => {
        const body = JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          result: { content: [], structuredContent: { value: 'x'.repeat(2_000) } },
        });
        const bytes = new TextEncoder().encode(body);
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes.subarray(0, 300));
            controller.enqueue(bytes.subarray(300));
            controller.close();
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });
    const transport = createMcpClientTransport(httpConfig({
      limits: {
        connectTimeoutMs: 1_000,
        maxWireRequestBytes: 512,
        maxWireResponseBytes: 512,
        maxPendingRequests: 1,
      },
    }), {
      environment: { MCP_TEST_TOKEN: 'token' },
      fetch: server.fetch,
      networkPolicy: remoteNetworkPolicy(),
    });
    await transport.start?.();

    const requestsBeforeOversize = server.calls.length;
    await expect(transport.callTool(
      { name: 'task_create', arguments: { title: 'x'.repeat(2_000) } },
      callOptions(),
    )).rejects.toMatchObject({ code: 'MCP_CLIENT_REQUEST_TOO_LARGE' });
    expect(server.calls).toHaveLength(requestsBeforeOversize);

    await expect(transport.callTool(
      { name: 'task_create', arguments: { title: 'small' } },
      callOptions(),
    )).rejects.toMatchObject({ code: 'MCP_CLIENT_CALL_FAILED' });
    await transport.close?.();
  });

  it('passes abort/timeout, rejects keyed calls before send, and preserves none-call ambiguity', async () => {
    let behavior: 'wait' | 'fail' = 'wait';
    let dispatchedCalls = 0;
    const server = legacyHttpServer({
      onCall: (_message, init) => new Promise<Response>((_resolve, reject) => {
        dispatchedCalls += 1;
        if (behavior === 'fail') {
          reject(new Error('delivered then lost with peer secret'));
          return;
        }
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      }),
    });
    const transport = createMcpClientTransport(httpConfig(), {
      environment: { MCP_TEST_TOKEN: 'token' },
      fetch: server.fetch,
      networkPolicy: remoteNetworkPolicy(),
    });
    await transport.start?.();

    const beforeKeyed = server.calls.length;
    await expect(transport.callTool(
      { name: 'task_create', arguments: { title: 'keyed' } },
      callOptions({ idempotency: 'keyed' }),
    )).rejects.toMatchObject({ code: 'MCP_CLIENT_KEYED_IDEMPOTENCY_UNSUPPORTED' });
    expect(server.calls).toHaveLength(beforeKeyed);

    const controller = new AbortController();
    const aborted = transport.callTool(
      { name: 'task_create', arguments: { title: 'abort' } },
      callOptions({ signal: controller.signal, timeoutMs: 500 }),
    );
    const localReason = new Error('local cancellation');
    controller.abort(localReason);
    await expect(aborted).rejects.toBe(localReason);

    const beforeNoneCancellation = dispatchedCalls;
    const noneController = new AbortController();
    const cancelledWrite = transport.callTool(
      { name: 'task_create', arguments: { title: 'cancelled write' } },
      callOptions({
        idempotency: 'none',
        signal: noneController.signal,
        timeoutMs: 500,
      }),
    );
    await vi.waitFor(() => expect(dispatchedCalls).toBe(beforeNoneCancellation + 1));
    noneController.abort(new Error('operator cancelled'));
    await expect(cancelledWrite).rejects.toMatchObject({
      code: 'TOOL_EXECUTION_AMBIGUOUS',
      message: 'The MCP tool execution outcome is unknown',
    });

    const startedAt = Date.now();
    await expect(transport.callTool(
      { name: 'task_create', arguments: { title: 'timeout' } },
      callOptions({ timeoutMs: 25 }),
    )).rejects.toMatchObject({ code: 'MCP_CLIENT_CALL_FAILED' });
    expect(Date.now() - startedAt).toBeLessThan(500);

    behavior = 'fail';
    await expect(transport.callTool(
      { name: 'task_create', arguments: { title: 'non-idempotent' } },
      callOptions({ idempotency: 'none' }),
    )).rejects.toMatchObject({
      code: 'TOOL_EXECUTION_AMBIGUOUS',
      message: 'The MCP tool execution outcome is unknown',
    });
    await transport.close?.();
  });

  it('fails excess concurrent calls locally before another request is sent', async () => {
    let release: (() => void) | undefined;
    const server = legacyHttpServer({
      onCall: (message) => new Promise<Response>((resolve) => {
        release = () => resolve(rpcResponse(message.id, {
          content: [],
          structuredContent: { id: 'task-1', created: true },
        }));
      }),
    });
    const transport = createMcpClientTransport(httpConfig({
      limits: {
        connectTimeoutMs: 1_000,
        maxWireRequestBytes: 2_048,
        maxWireResponseBytes: 2_048,
        maxPendingRequests: 1,
      },
    }), {
      environment: { MCP_TEST_TOKEN: 'token' },
      fetch: server.fetch,
      networkPolicy: remoteNetworkPolicy(),
    });
    await transport.start?.();

    const first = transport.callTool(
      { name: 'task_create', arguments: { title: 'first' } },
      callOptions(),
    );
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const requestCount = server.calls.length;
    await expect(transport.callTool(
      { name: 'task_create', arguments: { title: 'second' } },
      callOptions(),
    )).rejects.toMatchObject({ code: 'MCP_CLIENT_CALL_FAILED' });
    expect(server.calls).toHaveLength(requestCount);
    release?.();
    await first;
    await transport.close?.();
  });
});

describe('reviewed MCP stdio client', () => {
  it('supports explicit modern auto negotiation through an exact-environment disposable sibling', async () => {
    const directory = temporaryDirectory();
    const marker = join(directory, 'closed');
    const config = stdioConfig(marker, 'modern');
    (config as { protocol?: McpStdioClientConfig['protocol'] }).protocol = 'auto';
    const transport = createMcpClientTransport(config, {
      environment: {
        MCP_CHILD_SECRET: 'mapped-secret',
        UNDECLARED_SECRET: 'must-not-be-inherited',
      },
    });
    await transport.start?.();
    await expect(transport.callTool(
      { name: 'task_create', arguments: { title: 'modern stdio' } },
      callOptions(),
    )).resolves.toMatchObject({ structuredContent: { id: 'stdio-task', created: true } });
    await transport.close?.();
  });

  it('uses direct argv with an exact mapped environment, bounded stderr, legacy default, and lifecycle cleanup', async () => {
    const directory = temporaryDirectory();
    const marker = join(directory, 'closed');
    const transport = createMcpClientTransport(stdioConfig(marker, 'normal'), {
      environment: {
        MCP_CHILD_SECRET: 'mapped-secret',
        UNDECLARED_SECRET: 'must-not-be-inherited',
      },
    });

    expect(transport.snapshotBinding).toMatchObject({
      transport: 'mcp-stdio',
      protocol: 'legacy',
      environmentNames: [{ child: 'DECLARED_SECRET', source: 'MCP_CHILD_SECRET' }],
      limits: { maxStderrBytes: 128 },
    });
    expect(JSON.stringify(transport.snapshotBinding)).not.toContain('mapped-secret');
    expect(JSON.stringify(transport.snapshotBinding)).not.toContain('must-not-be-inherited');

    await transport.start?.();
    await expect(transport.callTool(
      { name: 'task_create', arguments: { title: 'stdio' } },
      callOptions(),
    )).resolves.toMatchObject({ structuredContent: { id: 'stdio-task', created: true } });
    await transport.close?.();
    await waitForFile(marker);
  });

  it('bounds oversized stdio messages and closes a child after failed tool verification', async () => {
    const oversizeDirectory = temporaryDirectory();
    const oversize = createMcpClientTransport(stdioConfig(join(oversizeDirectory, 'closed'), 'oversize'), {
      environment: { MCP_CHILD_SECRET: 'mapped-secret' },
    });
    await oversize.start?.();
    await expect(oversize.callTool(
      { name: 'task_create', arguments: { title: 'oversize' } },
      callOptions(),
    )).rejects.toMatchObject({ code: 'MCP_CLIENT_CALL_FAILED' });
    await oversize.close?.();

    const mismatchDirectory = temporaryDirectory();
    const marker = join(mismatchDirectory, 'closed');
    const mismatch = createMcpClientTransport(stdioConfig(marker, 'missing-tool'), {
      environment: { MCP_CHILD_SECRET: 'mapped-secret' },
    });
    await expect(mismatch.start?.()).rejects.toMatchObject({ code: 'MCP_CLIENT_TOOL_MISMATCH' });
    await waitForFile(marker);
    await mismatch.close?.();
  });
});

describe('MCP manifest adapter', () => {
  it('rejects keyed MCP manifests and wire bounds above the gateway response limit', () => {
    const keyed = mcpManifest();
    (keyed.tools[0] as { idempotency: 'read' | 'keyed' | 'none' }).idempotency = 'keyed';
    expect(() => createMcpClientTransport(keyed, {
      environment: { MCP_TEST_TOKEN: 'token' },
      networkPolicy: remoteNetworkPolicy(),
    })).toThrow(/idempotency/u);

    const unbounded = mcpManifest();
    (unbounded.transport as { maxWireBytes: number }).maxWireBytes = 4_096;
    (unbounded.tools[0]!.limits as { maxResponseBytes: number }).maxResponseBytes = 2_048;
    expect(() => createMcpClientTransport(unbounded, {
      environment: { MCP_TEST_TOKEN: 'token' },
      networkPolicy: remoteNetworkPolicy(),
    })).toThrow(/wire response limit/u);
  });
});

function stdioConfig(marker: string, mode: string): McpStdioClientConfig {
  const serverPath = join(dirname(marker), 'server.mjs');
  writeFileSync(serverPath, STDIO_SERVER_SOURCE, { mode: 0o600 });
  return {
    type: 'mcp-stdio',
    id: `stdio-${mode}`,
    executable: process.execPath,
    argv: [serverPath, marker, mode],
    cwd: process.cwd(),
    env: { DECLARED_SECRET: 'MCP_CHILD_SECRET' },
    expectedServer: { name: 'reviewed-server', version: '1.2.3' },
    requiredTools: ['task_create'],
    limits: {
      // This fixture starts a real sibling Node process while the full suite
      // runs in parallel. Keep the product's timeout path covered elsewhere,
      // without making this protocol-success case depend on host scheduling.
      connectTimeoutMs: 5_000,
      shutdownTimeoutMs: 1_000,
      maxWireRequestBytes: 1_024,
      maxWireResponseBytes: 1_024,
      maxToolListPages: 2,
      maxPendingRequests: 1,
      maxStderrBytes: 128,
    },
  };
}

const STDIO_SERVER_SOURCE = String.raw`
import { writeFileSync } from 'node:fs';
const marker = process.argv[2];
const mode = process.argv[3];
let buffer = '';
process.stderr.write('stderr-secret:' + String(process.env.DECLARED_SECRET) + ':' + 'x'.repeat(10000));
const environmentIsExact = process.env.DECLARED_SECRET === 'mapped-secret' && process.env.UNDECLARED_SECRET === undefined;
function send(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n'); }
function handle(message) {
  if (message.method === 'server/discover' && mode === 'modern') {
    send(message.id, {
      supportedVersions: ['2026-07-28'],
      capabilities: { tools: {} },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: environmentIsExact ? 'reviewed-server' : 'wrong-environment', version: '1.2.3' } }
    });
    return;
  }
  if (message.method === 'initialize') {
    send(message.id, {
      protocolVersion: message.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: environmentIsExact ? 'reviewed-server' : 'wrong-environment', version: '1.2.3' }
    });
    return;
  }
  if (message.method === 'tools/list') {
    const name = mode === 'missing-tool' ? 'some_other_tool' : 'task_create';
    const modern = message.params?._meta?.['io.modelcontextprotocol/protocolVersion'] === '2026-07-28';
    send(message.id, {
      ...(modern ? { resultType: 'complete', ttlMs: 0, cacheScope: 'private' } : {}),
      tools: [{ name, inputSchema: { type: 'object' } }]
    });
    return;
  }
  if (message.method === 'tools/call') {
    const modern = message.params?._meta?.['io.modelcontextprotocol/protocolVersion'] === '2026-07-28';
    if (mode === 'oversize') {
      send(message.id, { ...(modern ? { resultType: 'complete' } : {}), content: [{ type: 'text', text: 'x'.repeat(3000) }], structuredContent: { id: 'big', created: true } });
    } else {
      send(message.id, { ...(modern ? { resultType: 'complete' } : {}), content: [], structuredContent: { id: 'stdio-task', created: true } });
    }
  }
}
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  while (buffer.includes('\n')) {
    const index = buffer.indexOf('\n');
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (line) handle(JSON.parse(line));
  }
});
process.stdin.on('end', () => { writeFileSync(marker, 'closed'); process.exit(0); });
`;

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'openprojects-mcp-client-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function waitForFile(path: string): Promise<void> {
  await vi.waitFor(() => expect(existsSync(path)).toBe(true), { timeout: 1_500, interval: 10 });
}

function mcpManifest(): McpIntegrationManifest {
  return {
    schema: 'openprojects.integration.v1',
    id: 'manifest-mcp',
    transport: {
      kind: 'mcp-http',
      endpoint: 'https://mcp.example.test/exact',
      bearerTokenEnv: 'MCP_TEST_TOKEN',
      protocol: 'legacy',
      expectedServerName: 'reviewed-server',
      expectedServerVersion: '1.2.3',
      maxWireBytes: 2_048,
      startupTimeoutMs: 1_000,
      maxPendingRequests: 1,
    },
    tools: [{
      name: 'mcp_task_create',
      remoteName: 'task_create',
      description: 'Create a task.',
      inputSchema: { ...inputSchema },
      outputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { id: { type: 'string' }, created: { type: 'boolean' } },
        required: ['id', 'created'],
      },
      effect: 'read',
      idempotency: 'read',
      dataBoundary: 'external',
      limits: {
        timeoutMs: 500,
        maxRequestBytes: 2_048,
        maxResponseBytes: 2_048,
        maxTextBytes: 512,
      },
    }],
  };
}
