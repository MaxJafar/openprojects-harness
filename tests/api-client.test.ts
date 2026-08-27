import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import { OpenProjectsApiClient } from '../src/api/client.js';
import { createUnixSocketFetch, UnixTransportError } from '../src/api/unix-fetch.js';
import { createApp, type OpenProjectsApp } from '../src/app.js';
import { loadControlClientCredential } from '../src/auth/control-auth.js';
import type { AppConfig, ModelAdapter, ServerAuthConfig } from '../src/core/types.js';
import {
  BoundedSseWriter,
  startServer,
  type StartedServer,
  type StartServerOptions,
} from '../src/server.js';
import { runTui, type TuiInput, type TuiOutput } from '../src/tui/index.js';

const apps = new Set<OpenProjectsApp>();
const servers = new Set<StartedServer>();
const temporaryDirectories = new Set<string>();

afterEach(async () => {
  for (const server of servers) await server.close();
  servers.clear();
  for (const app of apps) await app.close();
  apps.clear();
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
  temporaryDirectories.clear();
});

describe('OpenProjects local API client', () => {
  it('refuses a non-loopback server bind before opening the control-plane socket', async () => {
    const config = testConfig();
    config.server = { host: '0.0.0.0', port: 0 };
    const app = await createApp({ config, databasePath: ':memory:', skills: [], seedDemo: false });
    apps.add(app);

    await expect(startServer(app)).rejects.toThrow(
      'Refusing to expose the OpenProjects control plane on 0.0.0.0',
    );
  });

  it('refuses Telegram with a Unix control socket at the service boundary', async () => {
    const config = testConfig();
    config.server.socketPath = join(tmpdir(), 'openprojects-unreachable-telegram.sock');
    config.telegram = { enabled: true, apiBaseUrl: 'https://api.telegram.org' };
    config.privacy = { localOnly: true, allowedOrigins: ['https://api.telegram.org'] };
    const app = await createApp({ config, databasePath: ':memory:', skills: [], seedDemo: false });
    apps.add(app);

    await expect(startServer(app)).rejects.toThrow(
      'Telegram webhook ingress cannot use the private Unix control socket',
    );
  });

  it('closes the control transport even when scheduler classification teardown fails', async () => {
    const previousToken = process.env.TELEGRAM_BOT_TOKEN;
    const previousSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
    process.env.TELEGRAM_BOT_TOKEN = 'fixture-token';
    process.env.TELEGRAM_WEBHOOK_SECRET = 'fixture-secret';
    try {
      const config = testConfig();
      config.telegram = { enabled: true, apiBaseUrl: 'https://api.telegram.org' };
      config.privacy = { localOnly: true, allowedOrigins: ['https://api.telegram.org'] };
      config.notifications = { enabled: true, intervalMs: 60_000, lookaheadHours: 48 };
      const app = await createApp({ config, databasePath: ':memory:', skills: [], seedDemo: false });
      apps.add(app);
      const started = await startServer(app);
      expect(started.scheduler).toBeDefined();
      Object.defineProperty(started.scheduler!, 'stop', {
        configurable: true,
        value: async () => { throw new Error('durable classification failed'); },
      });

      await expect(started.close()).rejects.toThrow('durable classification failed');
      await expect(fetch(`${started.url}/health`)).rejects.toThrow();
    } finally {
      if (previousToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
      else process.env.TELEGRAM_BOT_TOKEN = previousToken;
      if (previousSecret === undefined) delete process.env.TELEGRAM_WEBHOOK_SECRET;
      else process.env.TELEGRAM_WEBHOOK_SECRET = previousSecret;
    }
  });

  it('releases the listener when scheduler recovery fails during startup', async () => {
    const previousToken = process.env.TELEGRAM_BOT_TOKEN;
    const previousSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
    process.env.TELEGRAM_BOT_TOKEN = 'fixture-token';
    process.env.TELEGRAM_WEBHOOK_SECRET = 'fixture-secret';
    try {
      const port = await reserveTcpPort();
      const config = testConfig();
      config.server.port = port;
      config.telegram = { enabled: true, apiBaseUrl: 'https://api.telegram.org' };
      config.privacy = { localOnly: true, allowedOrigins: ['https://api.telegram.org'] };
      config.notifications = { enabled: true, intervalMs: 60_000, lookaheadHours: 48 };
      const app = await createApp({ config, databasePath: ':memory:', skills: [], seedDemo: false });
      apps.add(app);
      Object.defineProperty(app.storage, 'recoverSendingNotifications', {
        configurable: true,
        value: () => { throw new Error('notification recovery failed'); },
      });

      await expect(startServer(app)).rejects.toThrow('notification recovery failed');
      await expect(reserveTcpPort(port)).resolves.toBe(port);
    } finally {
      if (previousToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
      else process.env.TELEGRAM_BOT_TOKEN = previousToken;
      if (previousSecret === undefined) delete process.env.TELEGRAM_WEBHOOK_SECRET;
      else process.env.TELEGRAM_WEBHOOK_SECRET = previousSecret;
    }
  });

  it('refuses non-loopback, credential-bearing, and path-prefixed service URLs', () => {
    expect(() => new OpenProjectsApiClient('http://10.0.0.2:4310')).toThrow('only connects to a loopback');
    expect(() => new OpenProjectsApiClient('https://user:secret@localhost:4310')).toThrow('must not contain credentials');
    expect(() => new OpenProjectsApiClient('http://localhost:4310/openprojects')).toThrow('without a path');
    expect(() => new OpenProjectsApiClient('file:///tmp/openprojects.sock')).toThrow('must use http or https');
    expect(new OpenProjectsApiClient('http://127.0.0.2:4310').baseUrl).toBe('http://127.0.0.2:4310');
  });

  it('forbids redirects for both JSON commands and event streams', async () => {
    const redirects: Array<RequestRedirect | undefined> = [];
    const urls: string[] = [];
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      urls.push(String(input));
      redirects.push(init?.redirect);
      const accept = new Headers(init?.headers).get('accept');
      if (accept === 'text/event-stream') {
        return new Response(
          'event: run.snapshot\ndata: {"run":{"id":"run-1","workspaceId":"local","actorId":"operator","status":"succeeded","sessionId":"session-1"},"approvals":[],"cursor":-1}\n\n',
          {
          headers: { 'content-type': 'text/event-stream' },
          },
        );
      }
      return new Response(JSON.stringify({
        workspaceId: 'local',
        runs: [],
        approvals: [],
        approvalPage: { limit: 100 },
        memories: [],
        projects: [],
      }), { headers: { 'content-type': 'application/json' } });
    }) as typeof globalThis.fetch;
    const client = new OpenProjectsApiClient('http://localhost:4310', { fetch: fakeFetch });

    await client.snapshot('local', { approvalCursor: 'cursor+/=', approvalLimit: 25 });
    await client.streamRunEvents('run-1', () => undefined);

    expect(redirects).toEqual(['error', 'error']);
    expect(urls[0]).toContain('approvalCursor=cursor%2B%2F%3D');
    expect(urls[0]).toContain('approvalLimit=25');
  });

  it('resumes a durable run stream after an explicit cursor and omits history from snapshots', async () => {
    const { app, server } = await startTestService();
    const outcome = await app.runtime.start({
      message: 'Summarize the durable cursor behavior',
      workspaceId: 'local',
      actorId: 'operator',
    });
    const cursor = outcome.events[2]!.seq;

    const response = await fetch(
      `${server.url}/api/runs/${outcome.run.id}/events/stream?afterSeq=${cursor}`,
      { headers: { 'last-event-id': String(cursor) } },
    );
    expect(response.status).toBe(200);
    const frames = parseSseFrames(await response.text());
    const durable = frames.filter((frame) => frame.id !== undefined);
    expect(durable.length).toBeGreaterThan(0);
    expect(durable.every((frame) => frame.id! > cursor)).toBe(true);
    expect(durable.map((frame) => frame.id)).toEqual([...new Set(durable.map((frame) => frame.id))]);
    const snapshot = frames.find((frame) => frame.event === 'run.snapshot');
    expect(snapshot).toBeDefined();
    expect(snapshot!.data).toMatchObject({ run: { id: outcome.run.id }, approvals: [] });
    expect(snapshot!.data).not.toHaveProperty('events');
  });

  it('rejects malformed, duplicate, mismatched, and future run cursors before opening SSE', async () => {
    const { app, server } = await startTestService();
    const outcome = await app.runtime.start({ message: 'Cursor validation', workspaceId: 'local', actorId: 'operator' });
    const latest = app.storage.latestEventSeqForRun(outcome.run.id)!;
    const urls = [
      `${server.url}/api/runs/${outcome.run.id}/events/stream?afterSeq=-1`,
      `${server.url}/api/runs/${outcome.run.id}/events/stream?afterSeq=abc`,
      `${server.url}/api/runs/${outcome.run.id}/events/stream?afterSeq=0&afterSeq=0`,
      `${server.url}/api/runs/${outcome.run.id}/events/stream?afterSeq=${latest + 1}`,
    ];
    for (const url of urls) expect((await fetch(url)).status).toBe(400);
    expect((await fetch(
      `${server.url}/api/runs/${outcome.run.id}/events/stream?afterSeq=${latest}`,
      { headers: { 'last-event-id': String(latest - 1) } },
    )).status).toBe(400);
  });

  it('reconnects with Last-Event-ID and afterSeq while deduplicating replay races', async () => {
    const requests: Array<{ url: string; lastEventId: string | null }> = [];
    let attempt = 0;
    const event = (seq: number, type: string): string =>
      `id: ${seq}\nevent: ${type}\ndata: ${JSON.stringify({
        id: `event-${seq}`,
        sessionId: 'session-1',
        runId: 'run-1',
        seq,
        type,
        data: {},
        createdAt: new Date(0).toISOString(),
      })}\n\n`;
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(input),
        lastEventId: new Headers(init?.headers).get('last-event-id'),
      });
      attempt += 1;
      if (attempt === 2) {
        throw new UnixTransportError('CONNECTION_RESET', 'The local control service closed the connection');
      }
      const body = attempt === 1
        ? `${event(0, 'run.created')}event: run.snapshot\ndata: {"run":{"id":"run-1","workspaceId":"local","actorId":"operator","status":"running","sessionId":"session-1"},"approvals":[],"cursor":0}\n\n`
        : `${event(0, 'run.created')}${event(2, 'run.succeeded')}`;
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    }) as typeof globalThis.fetch;
    const client = new OpenProjectsApiClient('http://localhost:4310', {
      fetch: fakeFetch,
      reconnectDelayMs: 50,
    });
    const sequences: number[] = [];

    await client.streamRunEvents('run-1', ({ id }) => {
      if (id !== undefined) sequences.push(id);
    });

    expect(sequences).toEqual([0, 2]);
    expect(requests).toHaveLength(3);
    expect(requests[1]).toEqual({
      url: 'http://localhost:4310/api/runs/run-1/events/stream?afterSeq=0',
      lastEventId: '0',
    });
    expect(requests[2]).toEqual(requests[1]);
  });

  it('surfaces consumer failures without advancing or retrying the durable cursor', async () => {
    let requests = 0;
    const fakeFetch = (async () => {
      requests += 1;
      return new Response(
        'id: 0\nevent: run.succeeded\ndata: {"id":"event-0","sessionId":"session-1","runId":"run-1","seq":0,"type":"run.succeeded","data":{},"createdAt":"2026-08-25T00:00:00.000Z"}\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      );
    }) as typeof globalThis.fetch;
    const client = new OpenProjectsApiClient('http://localhost:4310', {
      fetch: fakeFetch,
      reconnectDelayMs: 50,
    });

    await expect(client.streamRunEvents('run-1', () => {
      throw new TypeError('consumer boom');
    })).rejects.toThrow('consumer boom');
    expect(requests).toBe(1);
  });

  it('rejects oversized SSE frames and bounds writers that cannot drain', async () => {
    const fakeFetch = (async () => new Response(
      `event: run.created\ndata: ${'x'.repeat(1_000_001)}\n\n`,
      { headers: { 'content-type': 'text/event-stream' } },
    )) as typeof globalThis.fetch;
    const client = new OpenProjectsApiClient('http://localhost:4310', { fetch: fakeFetch });
    await expect(client.streamRunEvents('run-1', () => undefined)).rejects.toThrow('frame is too large');

    const blocked = new FakeServerResponse(false);
    const writer = new BoundedSseWriter(blocked as unknown as ServerResponse, {
      maxFrameBytes: 1_000,
      maxQueuedBytes: 100,
      drainTimeoutMs: 20,
    });
    const first = writer.send('workspace.changed', { value: 'a' });
    const second = writer.send('workspace.changed', { value: 'b' });
    const third = writer.send('workspace.changed', { value: 'c' });
    expect(await third).toBe(false);
    expect(await first).toBe(false);
    expect(await second).toBe(false);
    expect(blocked.destroyed).toBe(true);

    const draining = new FakeServerResponse(false);
    const drainWriter = new BoundedSseWriter(draining as unknown as ServerResponse, {
      drainTimeoutMs: 100,
    });
    const pending = drainWriter.send('workspace.changed', { value: 'ok' });
    await Promise.resolve();
    draining.emit('drain');
    expect(await pending).toBe(true);
    await drainWriter.end();
  });

  it('accepts a durable run before model completion and follows status plus SSE events', async () => {
    const { app, server } = await startTestService();
    const model = app.kernel.model('mock') as ModelAdapter;
    const originalComplete = model.complete.bind(model);
    let releaseModel!: () => void;
    const modelGate = new Promise<void>((resolve) => { releaseModel = resolve; });
    model.complete = async (request) => {
      await modelGate;
      return originalComplete(request);
    };
    const client = new OpenProjectsApiClient(server.url, { reconnectDelayMs: 50 });

    const snapshot = await client.snapshot('local');
    expect(snapshot.workspaceId).toBe('local');
    expect(snapshot.agent.name).toBe('API test agent');

    const accepted = await Promise.race([
      client.startRun({ message: 'Summarize the project', workspaceId: 'local', actorId: 'operator' }),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('async acceptance timed out')), 750)),
    ]);
    expect(accepted.run).toMatchObject({ workspaceId: 'local', actorId: 'operator', status: 'running' });
    expect(accepted.statusUrl).toBe(`${server.url}/api/runs/${accepted.run.id}`);
    expect(accepted.eventsUrl).toBe(`${server.url}/api/runs/${accepted.run.id}/events/stream`);
    const running = await client.getRun(accepted.run.id);
    expect(running.run.status).toBe('running');
    expect(running.snapshotDocuments).toMatchObject({
      agent: { kind: 'agent', digest: running.run.snapshots?.agent },
      tools: { kind: 'tools', digest: running.run.snapshots?.tools },
      policy: { kind: 'policy', digest: running.run.snapshots?.policy },
    });

    const eventNames: string[] = [];
    let streamReady!: () => void;
    const sawSnapshot = new Promise<void>((resolve) => { streamReady = resolve; });
    const streaming = client.streamRunEvents(accepted.run.id, ({ event }) => {
      eventNames.push(event);
      if (event === 'run.snapshot') streamReady();
    });
    await sawSnapshot;
    releaseModel();
    await streaming;

    const completed = await client.getRun(accepted.run.id);
    expect(completed.run.status).toBe('succeeded');
    expect(eventNames).toContain('run.created');
    expect(eventNames).toContain('run.snapshot');
    expect(eventNames).toContain('run.succeeded');
    expect((await client.snapshot('local')).runs[0]?.id).toBe(accepted.run.id);
  });

  it('streams workspace changes and isolates snapshots by workspace', async () => {
    const { server } = await startTestService();
    const client = new OpenProjectsApiClient(server.url, { reconnectDelayMs: 50 });
    let changes = 0;
    let changed!: () => void;
    const sawRunChange = new Promise<void>((resolve) => { changed = resolve; });
    const unsubscribe = client.subscribe('workspace-a', () => {
      changes += 1;
      if (changes >= 2) changed();
    });
    try {
      await waitFor(() => changes >= 1);
      const accepted = await client.startRun({
        message: 'Status update',
        workspaceId: 'workspace-a',
        actorId: 'operator',
      });
      await sawRunChange;
      const own = await client.snapshot('workspace-a');
      const other = await client.snapshot('workspace-b');
      expect(own.runs.some((run) => run.id === accepted.run.id)).toBe(true);
      expect(other.runs.some((run) => run.id === accepted.run.id)).toBe(false);
    } finally {
      unsubscribe();
    }
  });

  it('caps active SSE clients globally and releases capacity when a client disconnects', async () => {
    const { server } = await startTestService(undefined, [], { maxActiveStreams: 2 });
    const first = await fetch(`${server.url}/api/events/stream?workspaceId=local`);
    const second = await fetch(`${server.url}/api/events/stream?workspaceId=local`);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const rejected = await fetch(`${server.url}/api/events/stream?workspaceId=local`);
    expect(rejected.status).toBe(429);
    expect(await rejected.json()).toMatchObject({
      error: 'Active event-stream capacity is full (2 maximum)',
    });

    await first.body?.cancel();
    let replacement: Response | undefined;
    await waitFor(async () => {
      const response = await fetch(`${server.url}/api/events/stream?workspaceId=local`);
      if (response.status === 200) {
        replacement = response;
        return true;
      }
      await response.body?.cancel();
      return false;
    });
    expect(replacement?.status).toBe(200);
    await replacement?.body?.cancel();
    await second.body?.cancel();
  });

  it('renders the TUI through the service client without owning an app runtime', async () => {
    const { server } = await startTestService();
    const client = new OpenProjectsApiClient(server.url);
    const input = new PassThrough() as TuiInput;
    const output = new PassThrough() as TuiOutput;
    input.isTTY = false;
    output.isTTY = false;
    let rendered = '';
    output.on('data', (chunk: Buffer) => { rendered += chunk.toString(); });

    await runTui(client, { input, output, workspaceId: 'local' });

    expect(rendered).toContain('OpenProjects - private project operations');
    expect(rendered).toContain('Workspace: local');
    expect(rendered).not.toContain('\u001b');
  });

  it('requires configured Bearer auth and ignores mutation identity fields from the body', async () => {
    const tokenFile = protectedTokenFile('correct-control-token-1234567890abcdef');
    const wrongTokenFile = protectedTokenFile('incorrect-token-value-1234567890abcdef');
    const auth = { tokenFile, operatorId: 'verified-operator' };
    const { server } = await startTestService(auth);

    expect((await fetch(`${server.url}/health`)).status).toBe(200);
    const missing = await fetch(`${server.url}/api/tui/snapshot`);
    expect(missing.status).toBe(401);
    expect(missing.headers.get('www-authenticate')).toContain('Bearer');

    const wrong = new OpenProjectsApiClient(server.url, {
      credential: loadControlClientCredential({ tokenFile: wrongTokenFile }),
      principalId: auth.operatorId,
    });
    await expect(wrong.snapshot('local')).rejects.toMatchObject({ status: 401 });

    const credential = loadControlClientCredential(auth);
    const client = new OpenProjectsApiClient(server.url, {
      credential,
      principalId: auth.operatorId,
    });
    const accepted = await client.startRun({
      message: 'Authenticated task',
      workspaceId: 'local',
      actorId: 'body-impersonator',
    });
    expect(accepted.run.actorId).toBe('verified-operator');
    const unauthenticatedStream = await fetch(`${server.url}/api/runs/${accepted.run.id}/events/stream`);
    expect(unauthenticatedStream.status).toBe(401);
    const authenticatedEvents: string[] = [];
    await client.streamRunEvents(accepted.run.id, ({ event }) => authenticatedEvents.push(event));
    expect(authenticatedEvents).toContain('run.snapshot');

    const direct = await fetch(`${server.url}/api/runs/async`, {
      method: 'POST',
      redirect: 'error',
      headers: {
        authorization: credential.authorizationHeader(),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        message: 'Direct authenticated task',
        workspaceId: 'local',
        actorId: 'another-impersonator',
      }),
    });
    expect(direct.status).toBe(202);
    expect((await direct.json() as { run: { actorId: string } }).run.actorId).toBe('verified-operator');

    const group = await fetch(`${server.url}/api/groups`, {
      method: 'POST',
      redirect: 'error',
      headers: {
        authorization: credential.authorizationHeader(),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        source: 'test',
        externalId: 'authenticated-group',
        createdBy: 'forged-creator',
      }),
    });
    expect(group.status).toBe(201);
    expect((await group.json() as { createdBy: string }).createdBy).toBe('verified-operator');
  });

  it('enforces capabilities and workspace scope for independent control principals', async () => {
    const readerToken = protectedTokenFile('reader-control-token-1234567890abcdef');
    const runnerToken = protectedTokenFile('runner-control-token-1234567890abcdef');
    const approvalOnlyToken = protectedTokenFile('approval-only-token-1234567890abcdef');
    const approverToken = protectedTokenFile('approver-control-token-123456789abcdef');
    const scopedAdminToken = protectedTokenFile('scoped-admin-token-1234567890abcdef');
    const globalAdminToken = protectedTokenFile('global-admin-token-1234567890abcdef');
    const auth: ServerAuthConfig = {
      principals: [
        { id: 'reader', tokenFile: readerToken, capabilities: ['read'], workspaces: ['local'] },
        { id: 'runner', tokenFile: runnerToken, capabilities: ['run'], workspaces: ['local'] },
        { id: 'approval-only', tokenFile: approvalOnlyToken, capabilities: ['approve'], workspaces: ['local'] },
        { id: 'approver', tokenFile: approverToken, capabilities: ['read', 'approve'], workspaces: ['local'] },
        { id: 'scoped-admin', tokenFile: scopedAdminToken, capabilities: ['admin'], workspaces: ['local'] },
        { id: 'global-admin', tokenFile: globalAdminToken, capabilities: ['admin'] },
      ],
    };
    const { app, server } = await startTestService(auth, ['draft_followup', 'send_followup']);
    const client = (id: string, tokenFile: string) => new OpenProjectsApiClient(server.url, {
      credential: loadControlClientCredential({ tokenFile }),
      principalId: id,
    });
    const reader = client('reader', readerToken);
    expect((await reader.snapshot('local')).workspaceId).toBe('local');
    await expect(reader.snapshot('other')).rejects.toMatchObject({ status: 403 });
    const otherRun = await app.runtime.start({
      message: 'Workspace-private run',
      workspaceId: 'other',
      actorId: 'other-operator',
    });
    await expect(reader.getRun(otherRun.run.id)).rejects.toMatchObject({ status: 404 });
    await expect(reader.startRun({ message: 'Forbidden mutation', workspaceId: 'local' }))
      .rejects.toMatchObject({ status: 403 });

    const runner = client('runner', runnerToken);
    const started = await runner.startRun({ message: 'Allowed bounded run', workspaceId: 'local' });
    expect(started.run.actorId).toBe('runner');
    await expect(runner.snapshot('local')).rejects.toMatchObject({ status: 403 });
    await app.runtime.ingestEvent({
      source: 'shared-webhook',
      dedupeKey: 'event-42',
      type: 'project.changed',
      workspaceId: 'other',
      actorId: 'other-system',
      payload: { private: 'other-workspace' },
    });
    const runnerCredential = loadControlClientCredential({ tokenFile: runnerToken });
    const localEvent = await fetch(`${server.url}/api/events`, {
      method: 'POST',
      headers: {
        authorization: runnerCredential.authorizationHeader(),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        source: 'shared-webhook',
        dedupeKey: 'event-42',
        type: 'project.changed',
        workspaceId: 'local',
        payload: { local: true },
      }),
    });
    expect(localEvent.status).toBe(201);
    const localReceipt = await localEvent.json() as Record<string, unknown>;
    expect(localReceipt).toMatchObject({ duplicate: false });
    expect(localReceipt).not.toHaveProperty('outcome');
    expect(app.storage.getRun(String(localReceipt.runId)).workspaceId).toBe('local');

    const trustedTelegram = await app.runtime.ingestEvent({
      source: 'telegram',
      dedupeKey: 'reserved-update-77',
      type: 'message',
      workspaceId: 'local',
      actorId: 'telegram-user:77',
      payload: { verifiedTransport: true },
    });
    const forgedTelegram = await fetch(`${server.url}/api/events`, {
      method: 'POST',
      headers: {
        authorization: runnerCredential.authorizationHeader(),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        source: 'telegram',
        dedupeKey: 'reserved-update-77',
        type: 'message',
        workspaceId: 'local',
        payload: { forgedTransport: true },
      }),
    });
    expect(forgedTelegram.status).toBe(201);
    const forgedReceipt = await forgedTelegram.json() as { duplicate: boolean; runId: string };
    expect(forgedReceipt.duplicate).toBe(false);
    expect(forgedReceipt.runId).not.toBe(trustedTelegram.outcome?.run.id);
    expect(app.storage.getSession(app.storage.getRun(forgedReceipt.runId).sessionId).channel)
      .toMatch(/^event:control-api\//u);

    const poisonedAttempt = await fetch(`${server.url}/api/events`, {
      method: 'POST',
      headers: {
        authorization: runnerCredential.authorizationHeader(),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        source: 'corporate-webhook',
        dedupeKey: 'correctable-event',
        type: 'project.changed',
        workspaceId: 'local',
        projectId: 'missing-project',
        payload: {},
      }),
    });
    expect(poisonedAttempt.status).toBe(500);
    const correctedAttempt = await fetch(`${server.url}/api/events`, {
      method: 'POST',
      headers: {
        authorization: runnerCredential.authorizationHeader(),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        source: 'corporate-webhook',
        dedupeKey: 'correctable-event',
        type: 'project.changed',
        workspaceId: 'local',
        payload: {},
      }),
    });
    expect(correctedAttempt.status).toBe(201);
    expect(await correctedAttempt.json()).toMatchObject({ duplicate: false });

    const waiting = await app.runtime.start({
      message: 'Send an email to unblock the Atlas launch.',
      workspaceId: 'local',
      actorId: 'telegram-user:42',
      projectId: 'project-atlas',
    });
    const approvalId = waiting.approvals[0]!.id;
    const argumentsDigest = waiting.approvals[0]!.argumentsDigest!;
    await app.runtime.start({
      message: 'Send another email to unblock the Atlas launch.',
      workspaceId: 'local',
      actorId: 'telegram-user:43',
      projectId: 'project-atlas',
    });
    const readerCredential = loadControlClientCredential({ tokenFile: readerToken });
    const firstApprovalPage = await fetch(
      `${server.url}/api/approvals?workspaceId=local&status=pending&limit=1`,
      { headers: { authorization: readerCredential.authorizationHeader() } },
    );
    expect(firstApprovalPage.status).toBe(200);
    const firstApprovalBody = await firstApprovalPage.json() as {
      approvals: Array<{ id: string }>;
      page: { limit: number; nextCursor?: string };
    };
    expect(firstApprovalBody.approvals).toHaveLength(1);
    expect(firstApprovalBody.page).toMatchObject({ limit: 1 });
    expect(firstApprovalBody.page.nextCursor).toBeTruthy();
    const secondApprovalPage = await fetch(
      `${server.url}/api/approvals?workspaceId=local&status=pending&limit=1&cursor=${encodeURIComponent(firstApprovalBody.page.nextCursor!)}`,
      { headers: { authorization: readerCredential.authorizationHeader() } },
    );
    expect(secondApprovalPage.status).toBe(200);
    expect((await secondApprovalPage.json() as { approvals: unknown[] }).approvals).toHaveLength(1);
    expect((await fetch(`${server.url}/api/approvals?workspaceId=local&status=unknown`, {
      headers: { authorization: readerCredential.authorizationHeader() },
    })).status).toBe(400);
    await expect(reader.resolveApproval({ approvalId, decision: 'approve', actorId: 'reader', argumentsDigest }))
      .rejects.toMatchObject({ status: 403 });
    await expect(client('approval-only', approvalOnlyToken).resolveApproval({
      approvalId,
      decision: 'approve',
      actorId: 'approval-only',
      argumentsDigest,
    })).rejects.toMatchObject({ status: 403 });
    await client('approver', approverToken).resolveApproval({
      approvalId,
      decision: 'approve',
      actorId: 'ignored-body-actor',
      argumentsDigest,
    });
    expect(app.storage.getApproval(approvalId)).toMatchObject({ status: 'approved', resolvedBy: 'approver' });

    const scopedAdminCredential = loadControlClientCredential({ tokenFile: scopedAdminToken });
    const scopedGroupBinding = await fetch(`${server.url}/api/groups`, {
      method: 'POST',
      headers: {
        authorization: scopedAdminCredential.authorizationHeader(),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ workspaceId: 'local', source: 'telegram', externalId: 'chat-42' }),
    });
    expect(scopedGroupBinding.status).toBe(403);
    const scopedExport = await fetch(`${server.url}/api/feedback/export`, {
      headers: { authorization: scopedAdminCredential.authorizationHeader() },
    });
    expect(scopedExport.status).toBe(403);
    const globalAdminCredential = loadControlClientCredential({ tokenFile: globalAdminToken });
    expect((await fetch(`${server.url}/api/feedback/export`, {
      headers: { authorization: globalAdminCredential.authorizationHeader() },
    })).status).toBe(200);
  });

  it.runIf(process.platform !== 'win32' && process.geteuid !== undefined)(
    'attaches the authenticated API client through a protected Unix socket',
    async () => {
      const directory = mkdtempSync('/tmp/openprojects-sock-');
      temporaryDirectories.add(directory);
      chmodSync(directory, 0o700);
      const tokenFile = join(directory, 'admin.token');
      writeFileSync(tokenFile, 'unix-admin-control-token-1234567890abcdef\n', { mode: 0o600 });
      const auth: ServerAuthConfig = {
        principals: [{ id: 'unix-admin', tokenFile, capabilities: ['admin'] }],
      };
      const config = testConfig(auth);
      config.server.socketPath = join(directory, 'control.sock');
      const app = await createApp({ config, databasePath: ':memory:', skills: [], seedDemo: true });
      apps.add(app);
      const server = await startServer(app);
      servers.add(server);
      expect(server).toMatchObject({ transport: 'unix', url: 'http://localhost' });

      const client = new OpenProjectsApiClient('http://localhost', {
        fetch: createUnixSocketFetch({ socketPath: config.server.socketPath }),
        credential: loadControlClientCredential({ tokenFile }),
        principalId: 'unix-admin',
      });
      expect((await client.snapshot('local')).workspaceId).toBe('local');
    },
  );

  it('does not acknowledge a rejected approval preflight as accepted', async () => {
    const { app, server } = await startTestService(undefined, ['draft_followup', 'send_followup']);
    const waiting = await app.runtime.start({
      message: 'Send an email to unblock the Atlas launch.',
      workspaceId: 'local',
      actorId: 'telegram-user:42',
      projectId: 'project-atlas',
    });
    const approvalId = waiting.approvals[0]!.id;

    const response = await fetch(`${server.url}/api/approvals/${approvalId}/async`, {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'approve', actorId: 'not-the-run-actor' }),
    });

    expect(response.status).not.toBe(202);
    expect(app.storage.getApproval(approvalId).status).toBe('pending');
    expect(app.storage.outboxCount()).toBe(0);
  });

  it('lets the verified operator resolve a Telegram-origin approval and commits before 202', async () => {
    const tokenFile = protectedTokenFile('operator-approval-token-1234567890abcdef');
    const auth = { tokenFile, operatorId: 'verified-operator' };
    const { app, server } = await startTestService(auth, ['draft_followup', 'send_followup']);
    const waiting = await app.runtime.start({
      message: 'Send an email to unblock the Atlas launch.',
      workspaceId: 'local',
      actorId: 'telegram-user:42',
      projectId: 'project-atlas',
    });
    const approvalId = waiting.approvals[0]!.id;
    const argumentsDigest = waiting.approvals[0]!.argumentsDigest!;
    const client = new OpenProjectsApiClient(server.url, {
      credential: loadControlClientCredential(auth),
      principalId: auth.operatorId,
    });

    const missingDigest = await fetch(`${server.url}/api/approvals/${approvalId}/async`, {
      method: 'POST',
      headers: {
        authorization: loadControlClientCredential(auth).authorizationHeader(),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ decision: 'approve', actorId: auth.operatorId }),
    });
    expect(missingDigest.status).toBe(400);
    await expect(client.resolveApproval({
      approvalId,
      decision: 'approve',
      actorId: auth.operatorId,
      argumentsDigest: `sha256:${'0'.repeat(64)}`,
    })).rejects.toMatchObject({ status: 409 });
    expect(app.storage.getApproval(approvalId).status).toBe('pending');
    expect(app.storage.outboxCount()).toBe(0);

    const accepted = await client.resolveApproval({
      approvalId,
      decision: 'approve',
      actorId: 'body-impersonator',
      argumentsDigest,
    });

    expect(accepted.run.id).toBe(waiting.run.id);
    expect(app.storage.getApproval(approvalId)).toMatchObject({
      status: 'approved',
      resolvedBy: 'verified-operator',
    });
    await waitFor(() => ['succeeded', 'failed', 'cancelled'].includes(app.storage.getRun(waiting.run.id).status));
    expect(app.runtime.outcome(waiting.run.id).run.status).toBe('succeeded');
    expect(app.storage.outboxCount()).toBe(1);
    await expect(client.resolveApproval({
      approvalId,
      decision: 'reject',
      actorId: auth.operatorId,
      argumentsDigest,
    })).rejects.toMatchObject({ status: 409 });

    const rejectWaiting = await app.runtime.start({
      message: 'Send a second email, if explicitly authorized.',
      workspaceId: 'local',
      actorId: 'telegram-user:42',
      projectId: 'project-atlas',
    });
    const rejectApproval = rejectWaiting.approvals[0]!;
    await expect(client.resolveApproval({
      approvalId: rejectApproval.id,
      decision: 'reject',
      actorId: auth.operatorId,
      argumentsDigest: `sha256:${'f'.repeat(64)}`,
    })).rejects.toMatchObject({ status: 409 });
    expect(app.storage.getApproval(rejectApproval.id).status).toBe('pending');
    await client.resolveApproval({
      approvalId: rejectApproval.id,
      decision: 'reject',
      actorId: auth.operatorId,
      argumentsDigest: rejectApproval.argumentsDigest!,
    });
    expect(app.storage.getApproval(rejectApproval.id).status).toBe('rejected');
  });

  it('forbids legacy approval but lets an operator safely reject the unbound row', async () => {
    const tokenFile = protectedTokenFile('operator-legacy-token-1234567890abcdef');
    const auth = { tokenFile, operatorId: 'verified-operator' };
    const { app, server } = await startTestService(auth, ['draft_followup', 'send_followup']);
    const waiting = await app.runtime.start({
      message: 'Send an email to unblock the legacy Atlas launch.',
      workspaceId: 'local',
      actorId: 'telegram-user:42',
      projectId: 'project-atlas',
    });
    const approval = waiting.approvals[0]!;
    app.storage.db.prepare('UPDATE approvals SET arguments_digest = NULL WHERE id = ?').run(approval.id);
    app.storage.db.prepare('UPDATE tool_invocations SET arguments_digest = NULL WHERE id = ?').run(approval.invocationId);
    const credential = loadControlClientCredential(auth);

    const forbidden = await fetch(`${server.url}/api/approvals/${approval.id}/async`, {
      method: 'POST',
      headers: {
        authorization: credential.authorizationHeader(),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ decision: 'approve', actorId: auth.operatorId }),
    });
    expect(forbidden.status).toBe(409);
    expect(app.storage.getApproval(approval.id).status).toBe('pending');

    await new OpenProjectsApiClient(server.url, {
      credential,
      principalId: auth.operatorId,
    }).resolveApproval({
      approvalId: approval.id,
      decision: 'reject',
      actorId: auth.operatorId,
    });
    expect(app.storage.getApproval(approval.id).status).toBe('rejected');
  });

  it('surfaces bounded HTTP failures as typed API errors', async () => {
    const { server } = await startTestService();
    const client = new OpenProjectsApiClient(server.url);
    await expect(client.getRun('missing-run')).rejects.toMatchObject({
      name: 'OpenProjectsApiError',
      status: 500,
    });
  });

  it('omits private main and subagent prompts from runtime metadata', async () => {
    const { server } = await startTestService();
    const response = await fetch(`${server.url}/api/meta`);
    expect(response.status).toBe(200);
    const metadata = await response.json() as {
      agent: Record<string, unknown>;
      subagents: Array<Record<string, unknown>>;
    };
    expect(metadata.agent).not.toHaveProperty('system');
    expect(metadata.subagents.length).toBeGreaterThan(0);
    expect(metadata.subagents.every((subagent) => !Object.hasOwn(subagent, 'system'))).toBe(true);
  });
});

async function startTestService(
  auth?: ServerAuthConfig,
  tools: string[] = [],
  serverOptions: StartServerOptions = {},
): Promise<{ app: OpenProjectsApp; server: StartedServer }> {
  const app = await createApp({
    config: testConfig(auth, tools),
    databasePath: ':memory:',
    skills: [],
    seedDemo: true,
  });
  apps.add(app);
  const server = await startServer(app, serverOptions);
  servers.add(server);
  return { app, server };
}

function testConfig(auth?: ServerAuthConfig, tools: string[] = []): AppConfig {
  return {
    version: 1,
    agent: {
      id: 'api-test',
      version: '1.0.0',
      name: 'API test agent',
      system: 'Test.',
      skills: [],
      tools,
      budgets: {
        maxSteps: 8,
        maxToolCalls: 16,
        maxWallTimeMs: 10_000,
        maxInputTokens: 24_000,
        reservedOutputTokens: 1_024,
      },
    },
    policy: {
      read: 'allow',
      draft: 'allow',
      memory_write: 'allow',
      internal_write: 'ask',
      external_write: 'ask',
      destructive: 'deny',
    },
    server: { host: '127.0.0.1', port: 0, ...(auth ? { auth } : {}) },
    storage: { database: ':memory:' },
    model: { provider: 'mock', model: 'project-ops-v1' },
    memory: { retrievalLimit: 4, maxContextCharacters: 4_000 },
    notifications: { enabled: false, intervalMs: 60_000, lookaheadHours: 48 },
  };
}

async function reserveTcpPort(requestedPort = 0): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(requestedPort, '127.0.0.1', () => {
      server.off('error', reject);
      resolvePromise();
    });
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : requestedPort;
  await new Promise<void>((resolvePromise, reject) => {
    server.close((error) => (error ? reject(error) : resolvePromise()));
  });
  return port;
}

function protectedTokenFile(token: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'openprojects-api-client-'));
  temporaryDirectories.add(directory);
  const path = join(directory, 'control.token');
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  return path;
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error('condition timed out');
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

interface ParsedSseFrame {
  event: string;
  id?: number;
  data: unknown;
}

function parseSseFrames(body: string): ParsedSseFrame[] {
  return body
    .split(/\r?\n\r?\n/u)
    .map((block) => block.trim())
    .filter(Boolean)
    .filter((block) => !block.startsWith(':'))
    .map((block) => {
      let event = 'message';
      let id: number | undefined;
      const data: string[] = [];
      for (const line of block.split(/\r?\n/u)) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        if (line.startsWith('id:')) id = Number(line.slice(3).trim());
        if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
      }
      return {
        event,
        ...(id === undefined ? {} : { id }),
        data: JSON.parse(data.join('\n')) as unknown,
      };
    });
}

class FakeServerResponse extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  readonly frames: string[] = [];

  constructor(readonly drainsImmediately: boolean) {
    super();
  }

  write(frame: string): boolean {
    this.frames.push(frame);
    return this.drainsImmediately;
  }

  end(): this {
    if (this.writableEnded) return this;
    this.writableEnded = true;
    this.emit('close');
    return this;
  }

  destroy(): this {
    if (this.destroyed) return this;
    this.destroyed = true;
    this.emit('close');
    return this;
  }
}
