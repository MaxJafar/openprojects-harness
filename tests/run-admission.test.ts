import { afterEach, describe, expect, it } from 'vitest';

import { createApp, type OpenProjectsApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { AppConfig, ModelAdapter, ModelRequest, ModelResponse } from '../src/core/types.js';
import { modelPlugin } from '../src/plugins/builtin.js';
import { RunAdmissionError, RunAdmissionGovernor } from '../src/runtime/run-admission.js';
import { startServer, type StartedServer } from '../src/server.js';

const apps = new Set<OpenProjectsApp>();
const servers = new Set<StartedServer>();

afterEach(async () => {
  for (const server of servers) await server.close();
  servers.clear();
  for (const app of apps) await app.close();
  apps.clear();
});

describe('global run admission', () => {
  it('rejects overload without an unbounded queue and releases leases idempotently', () => {
    const admission = new RunAdmissionGovernor(1);
    const first = admission.acquire();

    expect(admission.activeRuns).toBe(1);
    expect(() => admission.acquire()).toThrowError(RunAdmissionError);
    expect(admission.activeRuns).toBe(1);

    first.release();
    first.release();
    expect(admission.activeRuns).toBe(0);

    const next = admission.acquire();
    expect(admission.activeRuns).toBe(1);
    next.release();
    expect(admission.activeRuns).toBe(0);
  });

  it('enforces one core-profile slot across asynchronous, synchronous, and specialist runs', async () => {
    const app = await coreApp();
    const model = new FirstRequestGateModel();
    await replaceModel(app, model);
    const server = await startServer(app);
    servers.add(server);

    const accepted = await postJson(server, '/api/runs/async', {
      message: 'Hold the one bounded run slot.',
      workspaceId: 'local',
      actorId: 'operator',
    });
    expect(accepted.status).toBe(202);
    const acceptance = await accepted.json() as { run: { id: string } };
    await model.firstStarted;

    const durableRunCount = app.storage.listRuns('local', 50).length;
    expect(() => app.projectAnalyst.startAsync({
      message: 'Analyze the project while the supervisor is active.',
      workspaceId: 'local',
      actorId: 'operator',
      projectId: 'project-atlas',
    })).toThrowError(RunAdmissionError);

    const overloaded = await postJson(server, '/api/runs', {
      message: 'This synchronous run must fail closed.',
      workspaceId: 'local',
      actorId: 'operator',
    });
    expect(overloaded.status).toBe(429);
    await expect(overloaded.json()).resolves.toMatchObject({
      error: 'Global run capacity is full (1 active run maximum)',
    });
    expect(app.storage.listRuns('local', 50)).toHaveLength(durableRunCount);

    model.releaseFirst();
    await waitFor(() => app.storage.getRun(acceptance.run.id).status === 'succeeded');

    const admittedAfterRelease = await postJson(server, '/api/runs', {
      message: 'Run after the first slot is released.',
      workspaceId: 'local',
      actorId: 'operator',
    });
    expect(admittedAfterRelease.status).toBe(201);
    await expect(admittedAfterRelease.json()).resolves.toMatchObject({ run: { status: 'succeeded' } });
  });

  it('releases the slot when model execution errors', async () => {
    const app = await coreApp();
    await replaceModel(app, new FailOneRunThenAnswerModel());

    const failed = await app.runtime.start({
      message: 'Exercise the error cleanup path.',
      workspaceId: 'local',
      actorId: 'operator',
    });
    expect(failed.run.status).toBe('failed');

    const next = await app.runtime.start({
      message: 'The slot must be reusable after failure.',
      workspaceId: 'local',
      actorId: 'operator',
    });
    expect(next.run.status).toBe('succeeded');
  });

  it('releases the slot when an external signal cancels in-flight model work', async () => {
    const app = await coreApp();
    const model = new AbortFirstThenAnswerModel();
    await replaceModel(app, model);
    const controller = new AbortController();

    const first = app.runtime.startAsync({
      message: 'Cancel this bounded request.',
      workspaceId: 'local',
      actorId: 'operator',
    }, { signal: controller.signal });
    await model.firstStarted;
    controller.abort(new Error('test cancellation'));
    expect((await first.completion).run.status).toBe('failed');

    const next = await app.runtime.start({
      message: 'The slot must be reusable after cancellation.',
      workspaceId: 'local',
      actorId: 'operator',
    });
    expect(next.run.status).toBe('succeeded');
  });

  it('does not commit an approval decision while another run owns the slot', async () => {
    const app = await coreApp((config) => ({
      ...config,
      agent: { ...config.agent, tools: ['task_create'] },
    }));
    const model = new ApprovalAndGateModel();
    await replaceModel(app, model);

    const waiting = await app.runtime.start({
      message: 'Request one reviewed task.',
      workspaceId: 'local',
      actorId: 'operator',
      projectId: 'project-atlas',
    });
    expect(waiting.run.status).toBe('waiting_for_approval');
    const approvalId = waiting.approvals[0]!.id;

    const occupant = app.runtime.startAsync({
      message: 'Occupy the only run slot.',
      workspaceId: 'local',
      actorId: 'operator',
    });
    await model.occupantStarted;

    expect(() => app.runtime.resolveApprovalAsync(approvalId, 'approve', 'operator'))
      .toThrowError(RunAdmissionError);
    expect(app.storage.getApproval(approvalId).status).toBe('pending');

    model.releaseOccupant();
    expect((await occupant.completion).run.status).toBe('succeeded');
    const resumed = app.runtime.resolveApprovalAsync(approvalId, 'approve', 'operator');
    expect(app.storage.getApproval(approvalId).status).toBe('approved');
    expect((await resumed.completion).run.status).toBe('succeeded');
  });
});

class FirstRequestGateModel implements ModelAdapter {
  readonly id = 'mock';
  readonly firstStarted: Promise<void>;
  #markFirstStarted!: () => void;
  #releaseFirst!: () => void;
  #calls = 0;

  constructor() {
    this.firstStarted = new Promise<void>((resolve) => {
      this.#markFirstStarted = resolve;
    });
  }

  async complete(_request: ModelRequest): Promise<ModelResponse> {
    this.#calls += 1;
    if (this.#calls === 1) {
      this.#markFirstStarted();
      await new Promise<void>((resolve) => {
        this.#releaseFirst = resolve;
      });
    }
    return answer('The bounded run completed.');
  }

  releaseFirst(): void {
    this.#releaseFirst();
  }
}

class FailOneRunThenAnswerModel implements ModelAdapter {
  readonly id = 'mock';
  #calls = 0;

  async complete(): Promise<ModelResponse> {
    this.#calls += 1;
    if (this.#calls === 1) throw new Error('fixture model failure');
    return answer('The retry run completed.');
  }
}

class AbortFirstThenAnswerModel implements ModelAdapter {
  readonly id = 'mock';
  readonly firstStarted: Promise<void>;
  #markFirstStarted!: () => void;
  #calls = 0;

  constructor() {
    this.firstStarted = new Promise<void>((resolve) => {
      this.#markFirstStarted = resolve;
    });
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.#calls += 1;
    if (this.#calls !== 1) return answer('The post-cancellation run completed.');
    this.#markFirstStarted();
    return new Promise<ModelResponse>((_resolve, reject) => {
      const abort = (): void => reject(request.signal.reason ?? new Error('aborted'));
      if (request.signal.aborted) abort();
      else request.signal.addEventListener('abort', abort, { once: true });
    });
  }
}

class ApprovalAndGateModel implements ModelAdapter {
  readonly id = 'mock';
  readonly occupantStarted: Promise<void>;
  #markOccupantStarted!: () => void;
  #releaseOccupant!: () => void;

  constructor() {
    this.occupantStarted = new Promise<void>((resolve) => {
      this.#markOccupantStarted = resolve;
    });
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    if (request.messages.some((message) => message.role === 'tool')) {
      return answer('The reviewed task was created.');
    }
    const latestUser = [...request.messages].reverse().find((message) => message.role === 'user');
    if (latestUser?.role === 'user' && latestUser.content.includes('Occupy the only run slot')) {
      this.#markOccupantStarted();
      await new Promise<void>((resolve) => {
        this.#releaseOccupant = resolve;
      });
      return answer('The occupying run completed.');
    }
    return {
      message: {
        role: 'assistant',
        content: null,
        toolCalls: [{
          id: 'call-reviewed-task',
          name: 'task_create',
          arguments: JSON.stringify({
            projectId: 'project-atlas',
            title: 'Review the bounded admission result',
            priority: 'high',
          }),
        }],
      },
    };
  }

  releaseOccupant(): void {
    this.#releaseOccupant();
  }
}

function answer(content: string): ModelResponse {
  return { message: { role: 'assistant', content } };
}

async function coreApp(
  configure: (config: AppConfig) => AppConfig = (config) => config,
): Promise<OpenProjectsApp> {
  const loaded = loadConfig('examples/openprojects.core-4g.yaml', {
    loadEnv: false,
    applyProcessEnvOverrides: false,
  });
  const config = configure({
    ...loaded,
    server: { host: '127.0.0.1', port: 0 },
    storage: { database: ':memory:' },
  });
  const app = await createApp({ config, databasePath: ':memory:', skills: [], seedDemo: true });
  apps.add(app);
  return app;
}

async function replaceModel(app: OpenProjectsApp, adapter: ModelAdapter): Promise<void> {
  await app.kernel.unmount('model:mock');
  await app.kernel.mount(modelPlugin(adapter));
}

function postJson(server: StartedServer, path: string, body: object): Promise<Response> {
  return fetch(`${server.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition timed out');
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}
