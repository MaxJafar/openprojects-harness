import { afterEach, describe, expect, it } from 'vitest';

import { HarnessKernel } from '../src/core/kernel.js';
import type {
  AgentDefinition,
  HarnessEvent,
  JsonObject,
  RunRecord,
  ToolExecutionContext,
} from '../src/core/types.js';
import {
  createJsonApiIntegrationPlugin,
  createJsonApiTransport,
} from '../src/integrations/json-api.js';
import type {
  JsonApiIntegrationManifest,
  JsonApiIntegrationToolConfig,
  LoadedIntegrationManifest,
} from '../src/integrations/manifest.js';
import { policyPlugin } from '../src/plugins/builtin.js';
import {
  createNetworkPolicy,
  type OutboundNetworkPolicy,
} from '../src/privacy/network-policy.js';

const MANIFEST_SHA256 = 'a'.repeat(64);
const DEFAULT_LIMITS = {
  timeoutMs: 1_000,
  maxRequestBytes: 8_192,
  maxResponseBytes: 8_192,
  maxTextBytes: 4_096,
} as const;

const kernels = new Set<HarnessKernel>();

afterEach(async () => {
  for (const kernel of kernels) await kernel.dispose();
  kernels.clear();
});

function strictSchema(properties: JsonObject, required = Object.keys(properties)): JsonObject {
  return {
    type: 'object',
    additionalProperties: false,
    properties,
    required,
  };
}

function githubIssueTool(
  overrides: Partial<JsonApiIntegrationToolConfig> = {},
): JsonApiIntegrationToolConfig {
  return {
    name: 'github_issue_get',
    remoteName: 'github.issue.get',
    description: 'Read one issue from the reviewed GitHub repository.',
    inputSchema: strictSchema({
      owner: { type: 'string', minLength: 1 },
      repo: { type: 'string', minLength: 1 },
      issueNumber: { type: 'integer', minimum: 1 },
    }),
    outputSchema: strictSchema({
      id: { type: 'integer' },
      number: { type: 'integer' },
      title: { type: 'string' },
      state: { type: 'string' },
    }),
    effect: 'read',
    idempotency: 'read',
    dataBoundary: 'external',
    limits: { ...DEFAULT_LIMITS },
    method: 'GET',
    pathTemplate: {
      template: '/repos/{owner}/{repo}/issues/{issueNumber}',
      variables: {
        owner: { source: 'input', name: 'owner' },
        repo: { source: 'input', name: 'repo' },
        issueNumber: { source: 'input', name: 'issueNumber' },
      },
    },
    query: {
      view: { source: 'literal', value: 'summary' },
    },
    body: {},
    successStatuses: [200],
    ...overrides,
  };
}

function slackNotifyTool(
  overrides: Partial<JsonApiIntegrationToolConfig> = {},
): JsonApiIntegrationToolConfig {
  return {
    name: 'slack_notify',
    remoteName: 'slack.chat.postMessage',
    description: 'Notify the one reviewed project channel.',
    inputSchema: strictSchema({ text: { type: 'string', minLength: 1, maxLength: 4_000 } }),
    outputSchema: strictSchema({
      ok: { type: 'boolean' },
      channel: { type: 'string' },
      ts: { type: 'string' },
    }),
    effect: 'external_write',
    idempotency: 'none',
    dataBoundary: 'external',
    limits: { ...DEFAULT_LIMITS },
    method: 'POST',
    pathTemplate: { template: '/api/chat.postMessage', variables: {} },
    query: {},
    body: {
      channel: { source: 'literal', value: 'C-PROJECT-REVIEWED' },
      text: { source: 'input', name: 'text' },
      mrkdwn: { source: 'literal', value: false },
      unfurl_links: { source: 'literal', value: false },
      unfurl_media: { source: 'literal', value: false },
    },
    successStatuses: [200],
    ...overrides,
  };
}

function loadedManifest(
  tool: JsonApiIntegrationToolConfig,
  options: {
    id?: string;
    baseUrl?: string;
    auth?: JsonApiIntegrationManifest['transport']['auth'];
    staticHeaders?: Record<string, string>;
  } = {},
): LoadedIntegrationManifest {
  const manifest: JsonApiIntegrationManifest = {
    schema: 'openprojects.integration.v1',
    id: options.id ?? 'json-api-test',
    transport: {
      kind: 'json-api',
      baseUrl: options.baseUrl ?? 'https://api.github.com',
      auth: options.auth ?? { kind: 'none' },
      staticHeaders: options.staticHeaders ?? {},
    },
    tools: [tool],
  };
  return {
    path: `/reviewed/${manifest.id}.yaml`,
    sha256: MANIFEST_SHA256,
    manifest,
  };
}

async function mount(
  loaded: LoadedIntegrationManifest,
  fetch: typeof globalThis.fetch,
  environment: Readonly<Record<string, string | undefined>> = {},
  networkPolicy: OutboundNetworkPolicy = createNetworkPolicy({
    localOnly: false,
    allowedOrigins: [],
  }),
): Promise<HarnessKernel> {
  const kernel = new HarnessKernel();
  kernels.add(kernel);
  await kernel.mount(createJsonApiIntegrationPlugin(loaded, networkPolicy, {
    fetch,
    environment,
  }));
  return kernel;
}

function runRecord(): RunRecord {
  const timestamp = '2026-08-25T00:00:00.000Z';
  return {
    id: 'run-json-api',
    sessionId: 'session-json-api',
    workspaceId: 'workspace-json-api',
    actorId: 'actor-json-api',
    agentId: 'agent-json-api',
    agentVersion: '1.0.0',
    status: 'running',
    input: 'test',
    step: 0,
    toolCalls: 0,
    activeMs: 0,
    activeSince: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
    metadata: {},
  };
}

function executionContext(
  options: { signal?: AbortSignal; idempotencyKey?: string } = {},
): ToolExecutionContext {
  const run = runRecord();
  return {
    run,
    callId: 'call-json-api',
    idempotencyKey: options.idempotencyKey ?? 'host-key-json-api',
    signal: options.signal ?? new AbortController().signal,
    emit: (type, data): HarnessEvent => ({
      id: 'event-json-api',
      sessionId: run.sessionId,
      runId: run.id,
      seq: 1,
      type,
      data,
      createdAt: run.createdAt,
    }),
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('declarative JSON API integration transport', () => {
  it('applies file-loader credential defenses to the public transport factory', () => {
    const tool = githubIssueTool({
      query: {
        api_key: { source: 'literal', value: 'must-not-enter-a-snapshot' },
      },
    });
    expect(() => createJsonApiTransport(loadedManifest(tool).manifest)).toThrow(
      /credential-like field/u,
    );
  });

  it('maps a GitHub read structurally, checks policy at start and call, and snapshots no credential', async () => {
    const secret = 'github-installation-secret';
    let credentialReads = 0;
    const environment = new Proxy<Record<string, string>>(
      { GITHUB_INSTALLATION_TOKEN: secret },
      {
        get(target, property, receiver) {
          if (property === 'GITHUB_INSTALLATION_TOKEN') credentialReads += 1;
          return Reflect.get(target, property, receiver) as string | undefined;
        },
      },
    );
    const policyCalls: Array<{ url: string; purpose: string }> = [];
    const networkPolicy: OutboundNetworkPolicy = {
      localOnly: false,
      allowedOrigins: [],
      assertAllowed(value, purpose) {
        policyCalls.push({ url: String(value), purpose });
      },
    };
    let request: { url: string; init?: RequestInit } | undefined;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      request = { url: String(input), ...(init === undefined ? {} : { init }) };
      return jsonResponse({
        id: 42,
        number: 7,
        title: 'Bound the integration',
        state: 'open',
        url: 'https://api.github.com/repos/acme/open-projects/issues/7',
        leaked_remote_metadata: 'must be projected out',
      });
    };
    const loaded = loadedManifest(githubIssueTool(), {
      auth: { kind: 'bearer', tokenEnv: 'GITHUB_INSTALLATION_TOKEN' },
      staticHeaders: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2026-03-10',
      },
    });

    const plugin = createJsonApiIntegrationPlugin(loaded, networkPolicy, { fetch, environment });
    expect(credentialReads).toBe(0);
    expect(policyCalls).toEqual([]);
    const kernel = new HarnessKernel();
    kernels.add(kernel);
    await kernel.mount(plugin);
    expect(credentialReads).toBe(1);
    expect(policyCalls).toHaveLength(1);

    const tool = kernel.tool('github_issue_get')!;
    const result = await kernel.executeTool(executionContext(), tool, {
      owner: 'acme',
      repo: 'open-projects',
      issueNumber: 7,
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        id: 42,
        number: 7,
        title: 'Bound the integration',
        state: 'open',
      },
    });
    expect(result.value).not.toHaveProperty('url');
    expect(result.value).not.toHaveProperty('leaked_remote_metadata');
    expect(credentialReads).toBe(2);
    expect(policyCalls).toHaveLength(2);
    expect(policyCalls[0]).toMatchObject({ url: 'https://api.github.com' });
    expect(policyCalls[1]?.url).toBe(
      'https://api.github.com/repos/acme/open-projects/issues/7?view=summary',
    );

    expect(request?.url).toBe('https://api.github.com/repos/acme/open-projects/issues/7?view=summary');
    const headers = new Headers(request?.init?.headers);
    expect(headers.get('authorization')).toBe(`Bearer ${secret}`);
    expect(headers.get('x-github-api-version')).toBe('2026-03-10');
    expect(headers.get('accept-encoding')).toBe('identity');
    expect(headers.get('cookie')).toBeNull();
    expect(request?.init).toMatchObject({
      method: 'GET',
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
    });
    expect(request?.init?.body).toBeUndefined();

    const snapshot = JSON.stringify(tool.snapshotBinding);
    expect(snapshot).toContain(MANIFEST_SHA256);
    expect(snapshot).toContain('https://api.github.com');
    expect(snapshot).toContain('GITHUB_INSTALLATION_TOKEN');
    expect(snapshot).toContain('/repos/{owner}/{repo}/issues/{issueNumber}');
    expect(snapshot).toContain('successStatuses');
    expect(snapshot).toContain('maxResponseBytes');
    expect(snapshot).not.toContain(secret);
  });

  it('envelopes a GitHub top-level array only through an explicitly declared data property', async () => {
    let requestedUrl = '';
    const fetch: typeof globalThis.fetch = async (input) => {
      requestedUrl = String(input);
      return jsonResponse([
        { number: 7, title: 'Bound transport' },
        { number: 8, title: 'Review policy' },
      ]);
    };
    const listTool = githubIssueTool({
      name: 'github_issues_list',
      remoteName: 'github.issues.list',
      description: 'List open issues from the reviewed GitHub repository.',
      inputSchema: strictSchema({
        owner: { type: 'string', minLength: 1 },
        repo: { type: 'string', minLength: 1 },
      }),
      outputSchema: strictSchema({
        data: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              number: { type: 'integer' },
              title: { type: 'string' },
            },
            required: ['number', 'title'],
          },
        },
      }),
      pathTemplate: {
        template: '/repos/{owner}/{repo}/issues',
        variables: {
          owner: { source: 'input', name: 'owner' },
          repo: { source: 'input', name: 'repo' },
        },
      },
      query: {
        state: { source: 'literal', value: 'open' },
        per_page: { source: 'literal', value: 50 },
      },
    });
    const kernel = await mount(loadedManifest(listTool), fetch);
    const result = await kernel.executeTool(executionContext(), kernel.tool('github_issues_list')!, {
      owner: 'acme', repo: 'open-projects',
    });

    expect(requestedUrl).toBe(
      'https://api.github.com/repos/acme/open-projects/issues?per_page=50&state=open',
    );
    expect(result).toMatchObject({
      ok: true,
      value: {
        data: [
          { number: 7, title: 'Bound transport' },
          { number: 8, title: 'Review policy' },
        ],
      },
    });
  });

  it('preserves a fixed-channel Slack write effect so the kernel requires approval before transport', async () => {
    let fetchCalls = 0;
    const fetch: typeof globalThis.fetch = async () => {
      fetchCalls += 1;
      return jsonResponse({ ok: true, channel: 'C-PROJECT-REVIEWED', ts: '1.2' });
    };
    const loaded = loadedManifest(slackNotifyTool(), {
      id: 'slack-project',
      baseUrl: 'https://slack.com',
      auth: { kind: 'bearer', tokenEnv: 'SLACK_BOT_TOKEN' },
      staticHeaders: { 'Content-Type': 'application/json' },
    });
    const kernel = await mount(loaded, fetch, { SLACK_BOT_TOKEN: 'slack-secret' });
    const agent: AgentDefinition = {
      id: 'agent-json-api',
      version: '1.0.0',
      name: 'JSON API policy fixture',
      system: 'Test only.',
      skills: [],
      tools: ['slack_notify'],
      budgets: {
        maxSteps: 2,
        maxToolCalls: 2,
        maxWallTimeMs: 10_000,
        maxInputTokens: 1_000,
        reservedOutputTokens: 100,
      },
    };
    await kernel.mount(policyPlugin(agent, {
      read: 'allow',
      draft: 'allow',
      memory_write: 'ask',
      internal_write: 'ask',
      external_write: 'ask',
      destructive: 'deny',
    }));

    const tool = kernel.tool('slack_notify')!;
    expect(tool).toMatchObject({ effect: 'external_write', idempotency: 'none' });
    await expect(kernel.policyDecision({
      run: runRecord(),
      tool,
      input: { text: 'Release is due tomorrow.' },
    })).resolves.toBe('ask');
    expect(fetchCalls).toBe(0);
    expect(JSON.stringify(tool.snapshotBinding)).toContain('C-PROJECT-REVIEWED');
  });

  it('redacts credential and remote failure text from tool results and snapshots', async () => {
    const secret = 'never-expose-this-token';
    const fetch: typeof globalThis.fetch = async () => {
      throw new Error(`remote stack included ${secret} and response body contents`);
    };
    const kernel = await mount(
      loadedManifest(githubIssueTool(), {
        auth: { kind: 'header', header: 'X-Api-Key', valueEnv: 'REMOTE_API_KEY' },
      }),
      fetch,
      { REMOTE_API_KEY: secret },
    );
    const tool = kernel.tool('github_issue_get')!;
    const result = await kernel.executeTool(executionContext(), tool, {
      owner: 'acme', repo: 'project', issueNumber: 1,
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'MCP_TRANSPORT_ERROR',
        message: 'The local MCP transport failed',
      },
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain('remote stack');
    expect(JSON.stringify(tool.snapshotBinding)).not.toContain(secret);
    expect(JSON.stringify(tool.snapshotBinding)).toContain('REMOTE_API_KEY');
  });

  it('rejects traversal and pre-encoded path separators before fetch', async () => {
    let fetchCalls = 0;
    const fetch: typeof globalThis.fetch = async () => {
      fetchCalls += 1;
      return jsonResponse({ id: 1, number: 1, title: 'x', state: 'open' });
    };
    const kernel = await mount(loadedManifest(githubIssueTool()), fetch);
    const tool = kernel.tool('github_issue_get')!;

    for (const owner of ['..', '../admin', String.raw`team\admin`, '%2Fadmin', '%5cadmin', '%2e%2e']) {
      const result = await kernel.executeTool(executionContext(), tool, {
        owner,
        repo: 'project',
        issueNumber: 1,
      });
      expect(result).toMatchObject({ ok: false, error: { code: 'MCP_TRANSPORT_ERROR' } });
    }
    expect(fetchCalls).toBe(0);
  });

  it('rejects undeclared statuses and non-JSON content without reading or exposing error bodies', async () => {
    const cases: Array<() => Response> = [
      () => new Response('SECRET HTML ERROR', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
      () => new Response(JSON.stringify({ error: 'SECRET JSON ERROR' }), {
        status: 418,
        headers: { 'content-type': 'application/json' },
      }),
    ];

    for (const response of cases) {
      const kernel = await mount(loadedManifest(githubIssueTool()), async () => response());
      const result = await kernel.executeTool(executionContext(), kernel.tool('github_issue_get')!, {
        owner: 'acme', repo: 'project', issueNumber: 1,
      });
      expect(result).toMatchObject({ ok: false, error: { code: 'MCP_TRANSPORT_ERROR' } });
      expect(JSON.stringify(result)).not.toContain('SECRET');
      await kernel.dispose();
      kernels.delete(kernel);
    }
  });

  it('bounds a chunked decoded response while streaming, before JSON parsing', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('x'.repeat(40)));
        controller.enqueue(new TextEncoder().encode('y'.repeat(40)));
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetch: typeof globalThis.fetch = async () => new Response(stream, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    const tool = githubIssueTool({
      limits: {
        ...DEFAULT_LIMITS,
        maxResponseBytes: 64,
        maxTextBytes: 32,
      },
    });
    const kernel = await mount(loadedManifest(tool), fetch);
    const result = await kernel.executeTool(executionContext(), kernel.tool('github_issue_get')!, {
      owner: 'acme', repo: 'project', issueNumber: 1,
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'MCP_TRANSPORT_ERROR' } });
    expect(cancelled).toBe(true);
  });

  it('forbids redirects and never follows Location', async () => {
    let requestInit: RequestInit | undefined;
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      requestInit = init;
      return new Response(null, {
        status: 302,
        headers: { location: 'https://metadata.invalid/latest' },
      });
    };
    const kernel = await mount(loadedManifest(githubIssueTool()), fetch);
    const result = await kernel.executeTool(executionContext(), kernel.tool('github_issue_get')!, {
      owner: 'acme', repo: 'project', issueNumber: 1,
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'MCP_TRANSPORT_ERROR' } });
    expect(requestInit?.redirect).toBe('error');
  });

  it('passes the bounded host abort signal to fetch and settles as a timeout', async () => {
    let sawAbort = false;
    const fetch: typeof globalThis.fetch = async (_input, init) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) {
        reject(new Error('missing signal'));
        return;
      }
      const onAbort = (): void => {
        sawAbort = true;
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    });
    const kernel = await mount(loadedManifest(githubIssueTool({
      limits: { ...DEFAULT_LIMITS, timeoutMs: 25 },
    })), fetch);
    const result = await kernel.executeTool(executionContext(), kernel.tool('github_issue_get')!, {
      owner: 'acme', repo: 'project', issueNumber: 1,
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'TOOL_TIMEOUT' } });
    expect(sawAbort).toBe(true);
  });

  it('marks any post-send failure of a non-idempotent write as ambiguous', async () => {
    const remoteError = 'SECRET connection reset after request bytes left the host';
    const kernel = await mount(
      loadedManifest(slackNotifyTool(), {
        id: 'slack-ambiguous',
        baseUrl: 'https://slack.com',
        auth: { kind: 'bearer', tokenEnv: 'SLACK_BOT_TOKEN' },
      }),
      async () => {
        throw new Error(remoteError);
      },
      { SLACK_BOT_TOKEN: 'slack-secret' },
    );
    const result = await kernel.executeTool(executionContext(), kernel.tool('slack_notify')!, {
      text: 'Ship the release.',
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'TOOL_EXECUTION_AMBIGUOUS',
        message: 'The JSON API write may have completed',
      },
    });
    expect(JSON.stringify(result)).not.toContain(remoteError);
  });

  it('injects only the host key into a reviewed keyed header and does not retry', async () => {
    let fetchCalls = 0;
    let headers: Headers | undefined;
    let requestBody: string | undefined;
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      fetchCalls += 1;
      headers = new Headers(init?.headers);
      requestBody = typeof init?.body === 'string' ? init.body : undefined;
      return jsonResponse({ id: 'task-1', created: true, provider_secret: 'drop-me' });
    };
    const keyedTool: JsonApiIntegrationToolConfig = {
      name: 'task_create_keyed',
      remoteName: 'tasks.create',
      description: 'Create one task with a provider-reviewed replay key.',
      inputSchema: strictSchema({ title: { type: 'string', minLength: 1 } }),
      outputSchema: strictSchema({
        id: { type: 'string' },
        created: { type: 'boolean' },
      }),
      effect: 'external_write',
      idempotency: 'keyed',
      dataBoundary: 'external',
      limits: { ...DEFAULT_LIMITS },
      method: 'POST',
      pathTemplate: { template: '/v1/tasks', variables: {} },
      query: {},
      body: { title: { source: 'input', name: 'title' } },
      successStatuses: [200, 201],
      idempotencyKeyHeader: 'Idempotency-Key',
    };
    const kernel = await mount(
      loadedManifest(keyedTool, {
        id: 'keyed-api',
        baseUrl: 'https://tasks.example.test',
        auth: { kind: 'header', header: 'X-Api-Key', valueEnv: 'TASKS_API_KEY' },
        staticHeaders: { 'Content-Type': 'application/json' },
      }),
      fetch,
      { TASKS_API_KEY: 'fixed-header-secret' },
    );
    const result = await kernel.executeTool(
      executionContext({ idempotencyKey: 'host-replay-key-123' }),
      kernel.tool('task_create_keyed')!,
      { title: 'Review release' },
    );

    expect(result).toMatchObject({ ok: true, value: { id: 'task-1', created: true } });
    expect(result.value).not.toHaveProperty('provider_secret');
    expect(fetchCalls).toBe(1);
    expect(headers?.get('idempotency-key')).toBe('host-replay-key-123');
    expect(headers?.get('x-api-key')).toBe('fixed-header-secret');
    expect(JSON.parse(requestBody!) as unknown).toEqual({ title: 'Review release' });

    for (const failingFetch of [
      async (): Promise<Response> => { throw new Error('connection reset after send'); },
      async (): Promise<Response> => jsonResponse({ id: 7, created: 'yes' }),
    ]) {
      const failureKernel = await mount(
        loadedManifest(keyedTool, {
          id: 'keyed-api-failure',
          baseUrl: 'https://tasks.example.test',
          auth: { kind: 'header', header: 'X-Api-Key', valueEnv: 'TASKS_API_KEY' },
          staticHeaders: { 'Content-Type': 'application/json' },
        }),
        failingFetch,
        { TASKS_API_KEY: 'fixed-header-secret' },
      );
      await expect(failureKernel.executeTool(
        executionContext({ idempotencyKey: 'same-invocation-key' }),
        failureKernel.tool('task_create_keyed')!,
        { title: 'Review release' },
      )).resolves.toMatchObject({
        ok: false,
        error: { code: 'TOOL_EXECUTION_AMBIGUOUS' },
      });
    }
  });

  it('lets the gateway reject projected output that violates the exact manifest schema', async () => {
    const kernel = await mount(
      loadedManifest(githubIssueTool()),
      async () => jsonResponse({
        id: 'wrong-type',
        number: 1,
        title: 'Schema mismatch',
        state: 'open',
        extra: 'projected out',
      }),
    );
    const result = await kernel.executeTool(executionContext(), kernel.tool('github_issue_get')!, {
      owner: 'acme', repo: 'project', issueNumber: 1,
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_TOOL_OUTPUT' } });
    expect(result.error?.message).toContain('must be integer');
    expect(result.error?.message).not.toContain('extra');
  });
});
