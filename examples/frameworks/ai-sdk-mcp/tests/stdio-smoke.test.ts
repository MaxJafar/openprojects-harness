import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createMCPClient, type MCPClient } from '@ai-sdk/mcp';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';

import { MCP_TOOL_NAME } from '../src/config.js';

test('the built stdio MCP child reaches the bounded loopback API end to end', async () => {
  const paths: string[] = [];
  const requestBodies: unknown[] = [];
  const token = 's'.repeat(32);
  const server = createServer((request, response) => {
    void handleRequest(request, response, token, paths, requestBodies);
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolvePromise());
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  const serverEntry = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../src/mcp-server.js',
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    env: {
      ...getDefaultEnvironment(),
      OPENPROJECTS_BASE_URL: `http://127.0.0.1:${address.port}`,
      OPENPROJECTS_CONTROL_TOKEN: token,
      OPENPROJECTS_PRINCIPAL_ID: 'framework-runner',
      OPENPROJECTS_WORKSPACE_ID: 'workspace-fixed',
      OPENPROJECTS_PROJECT_ID: 'project-fixed',
      OPENPROJECTS_POLL_INTERVAL_MS: '25',
    },
    stderr: 'pipe',
    maxBufferSize: 1_048_576,
  });
  const stderr: Buffer[] = [];
  transport.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
  let client: MCPClient | undefined;
  try {
    client = await createMCPClient({
      transport,
      protocolVersionDiscovery: true,
      initializationOptions: { timeout: 5_000, maxTotalTimeout: 5_000 },
      maxRetries: 0,
    });
    assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), [MCP_TOOL_NAME]);
    const result = await client.callTool({
      name: MCP_TOOL_NAME,
      arguments: { question: 'Check the real stdio path' },
      options: { timeout: 5_000, maxTotalTimeout: 5_000 },
    });
    assert.notEqual(result.isError, true);
    assert.deepEqual(result.structuredContent, {
      schema: 'openprojects.framework-result.v1',
      runId: 'run-stdio',
      status: 'succeeded',
      workspaceId: 'workspace-fixed',
      projectId: 'project-fixed',
      principalId: 'framework-runner',
      approvalRequired: false,
      outputTruncated: false,
      output: 'stdio qualified',
      snapshots: {
        agent: 'b'.repeat(64),
        tools: 'b'.repeat(64),
        policy: 'b'.repeat(64),
      },
    });
    assert.deepEqual(paths, ['/api/whoami', '/api/runs/async']);
    assert.deepEqual(requestBodies, [{
      message: 'Check the real stdio path',
      workspaceId: 'workspace-fixed',
      projectId: 'project-fixed',
      actorId: 'framework-runner',
    }]);
    assert.equal(Buffer.concat(stderr).toString('utf8'), '');
  } finally {
    await client?.close().catch(() => undefined);
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  }
});

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  token: string,
  paths: string[],
  requestBodies: unknown[],
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  paths.push(url.pathname);
  assert.equal(request.headers.authorization, `Bearer ${token}`);
  if (request.method === 'GET' && url.pathname === '/api/whoami') {
    sendJson(response, 200, {
      authenticated: true,
      id: 'framework-runner',
      capabilities: ['read', 'run'],
      workspaces: ['workspace-fixed'],
    });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/runs/async') {
    requestBodies.push(JSON.parse(await readBody(request)) as unknown);
    sendJson(response, 202, {
      run: {
        id: 'run-stdio',
        status: 'succeeded',
        workspaceId: 'workspace-fixed',
        projectId: 'project-fixed',
        actorId: 'framework-runner',
        output: 'stdio qualified',
        snapshots: {
          agent: 'b'.repeat(64),
          tools: 'b'.repeat(64),
          policy: 'b'.repeat(64),
        },
      },
      links: {},
    });
    return;
  }
  sendJson(response, 500, { error: `unexpected or forbidden route ${url.pathname}` });
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > 16_384) throw new Error('test request body exceeded limit');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}
