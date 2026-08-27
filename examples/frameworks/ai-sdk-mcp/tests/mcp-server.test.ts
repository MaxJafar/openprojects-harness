import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { createMCPClient } from '@ai-sdk/mcp';
import { Client as OfficialMcpClient, InMemoryTransport } from '@modelcontextprotocol/client';

import { selectOnlyProjectTool } from '../src/ai-sdk-agent.js';
import { MCP_TOOL_NAME } from '../src/config.js';
import { createOpenProjectsMcpServer } from '../src/mcp-server.js';
import {
  bridgeConfig,
  fakeOpenProjectsFetch,
  jsonResponse,
  type RecordedRequest,
  runRecord,
  scopedIdentity,
} from './helpers.js';

test('AI SDK discovers one strict MCP tool backed by the fixed OpenProjects scope', async () => {
  const requests: RecordedRequest[] = [];
  const fetch = fakeOpenProjectsFetch((request) => {
    if (request.url.pathname === '/api/whoami') return jsonResponse(scopedIdentity());
    if (request.url.pathname === '/api/runs/async') {
      return jsonResponse({
        run: runRecord('succeeded', { output: 'Project is on track.' }),
        links: {},
      }, 202);
    }
    return jsonResponse({ error: 'not found' }, 404);
  }, requests);

  const server = createOpenProjectsMcpServer(bridgeConfig(), fetch);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = await createMCPClient({
    transport: clientTransport,
    protocolVersionDiscovery: false,
    initializationOptions: { timeout: 1_000, maxTotalTimeout: 1_000 },
    maxRetries: 0,
  });

  try {
    const definitions = await client.listTools();
    assert.deepEqual(definitions.tools.map((tool) => tool.name), [MCP_TOOL_NAME]);
    assert.deepEqual(Object.keys(await selectOnlyProjectTool(client)), [MCP_TOOL_NAME]);

    const invalid = await client.callTool({
      name: MCP_TOOL_NAME,
      arguments: {
        question: 'Check delivery',
        workspaceId: 'model-selected-workspace',
        projectId: 'model-selected-project',
        principalId: 'model-selected-principal',
      },
    });
    assert.equal(invalid.isError, true);
    assert.equal(requests.length, 0, 'strict schema must reject scope fields before the handler');

    const result = await client.callTool({
      name: MCP_TOOL_NAME,
      arguments: { question: 'Check delivery' },
    });
    assert.notEqual(result.isError, true);
    assert.deepEqual(result.structuredContent, {
      schema: 'openprojects.framework-result.v1',
      runId: 'run-1',
      status: 'succeeded',
      workspaceId: 'workspace-fixed',
      projectId: 'project-fixed',
      principalId: 'framework-runner',
      approvalRequired: false,
      outputTruncated: false,
      output: 'Project is on track.',
      snapshots: {
        agent: 'a'.repeat(64),
        tools: 'a'.repeat(64),
        policy: 'a'.repeat(64),
      },
    });
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1]?.body, {
      message: 'Check delivery',
      workspaceId: 'workspace-fixed',
      projectId: 'project-fixed',
      actorId: 'framework-runner',
    });
    assert.ok(requests.every((request) => !request.url.pathname.startsWith('/api/approvals')));
  } finally {
    await client.close();
    await server.close().catch(() => undefined);
  }
});

test('MCP request cancellation aborts bridge polling before another API call', async () => {
  const requests: RecordedRequest[] = [];
  let accepted!: () => void;
  const runAccepted = new Promise<void>((resolve) => { accepted = resolve; });
  const fetch = fakeOpenProjectsFetch((request) => {
    if (request.url.pathname === '/api/whoami') return jsonResponse(scopedIdentity());
    if (request.url.pathname === '/api/runs/async') {
      accepted();
      return jsonResponse({ run: runRecord('queued'), links: {} }, 202);
    }
    return jsonResponse({ run: runRecord('running'), approvals: [], events: [] });
  }, requests);

  const server = createOpenProjectsMcpServer(bridgeConfig(), fetch);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new OfficialMcpClient({ name: 'cancellation-test', version: '0.1.0' });
  await client.connect(clientTransport);
  const controller = new AbortController();
  try {
    const pending = client.callTool({
      name: MCP_TOOL_NAME,
      arguments: { question: 'Cancel this bounded analysis' },
    }, { signal: controller.signal, timeout: 1_000 });
    await runAccepted;
    controller.abort(new Error('operator cancelled'));
    await assert.rejects(pending);
    await sleep(75);
    assert.deepEqual(requests.map((request) => request.url.pathname), [
      '/api/whoami',
      '/api/runs/async',
    ]);
    assert.ok(requests.every((request) => !request.url.pathname.startsWith('/api/approvals')));
  } finally {
    await client.close();
    await server.close().catch(() => undefined);
  }
});
