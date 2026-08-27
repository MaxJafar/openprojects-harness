import type { OpenProjectsBridgeConfig } from '../src/config.js';

export const SHA256 = 'a'.repeat(64);

export function bridgeConfig(
  overrides: Partial<OpenProjectsBridgeConfig> = {},
): OpenProjectsBridgeConfig {
  return {
    baseUrl: 'http://127.0.0.1:4100',
    credential: Object.freeze({ authorizationHeader: () => `Bearer ${'t'.repeat(32)}` }),
    principalId: 'framework-runner',
    workspaceId: 'workspace-fixed',
    projectId: 'project-fixed',
    requestTimeoutMs: 1_000,
    runTimeoutMs: 2_000,
    pollIntervalMs: 25,
    ...overrides,
  };
}

export function scopedIdentity(
  capabilities: unknown[] = ['read', 'run'],
  workspaces: unknown = ['workspace-fixed'],
): Record<string, unknown> {
  return {
    authenticated: true,
    id: 'framework-runner',
    capabilities,
    workspaces,
  };
}

export function runRecord(
  status: 'queued' | 'running' | 'waiting_for_approval' | 'succeeded' | 'failed' | 'cancelled',
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 'run-1',
    status,
    workspaceId: 'workspace-fixed',
    projectId: 'project-fixed',
    actorId: 'framework-runner',
    snapshots: { agent: SHA256, tools: SHA256, policy: SHA256 },
    ...overrides,
  };
}

export function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export interface RecordedRequest {
  url: URL;
  method: string;
  authorization: string | null;
  body: unknown;
}

export function fakeOpenProjectsFetch(
  handler: (request: RecordedRequest) => Response | Promise<Response>,
  requests: RecordedRequest[] = [],
): typeof globalThis.fetch {
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const text = await request.text();
    const recorded: RecordedRequest = {
      url: new URL(request.url),
      method: request.method,
      authorization: request.headers.get('authorization'),
      body: text ? JSON.parse(text) as unknown : undefined,
    };
    requests.push(recorded);
    return await handler(recorded);
  }) as typeof globalThis.fetch;
}
