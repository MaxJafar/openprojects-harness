import { afterEach, describe, expect, it } from 'vitest';

import { createApp, type OpenProjectsApp } from '../src/app.js';
import type {
  AppConfig,
  JsonObject,
  ModelAdapter,
  ModelRequest,
  ModelResponse,
  RunRecord,
} from '../src/core/types.js';
import { modelPlugin } from '../src/plugins/builtin.js';

const openApps = new Set<OpenProjectsApp>();

afterEach(async () => {
  for (const app of openApps) await app.close();
  openApps.clear();
});

class CapturingChildModel implements ModelAdapter {
  readonly id = 'mock';
  readonly requests: ModelRequest[] = [];

  constructor(private readonly returnToolCall = false) {}

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    if (this.returnToolCall) {
      return {
        message: {
          role: 'assistant',
          content: 'Attempting a forbidden action.',
          toolCalls: [{
            id: 'child-call-1',
            name: 'project_get',
            arguments: '{"projectId":"project-atlas"}',
          }],
        },
        model: 'captured-child-model',
      };
    }
    const latest = request.messages.at(-1);
    if (latest?.role === 'tool') {
      const envelope = JSON.parse(latest.content) as { value?: { project?: { id?: string }; tasks?: Array<{ id?: string; status?: string }>; evidence?: Array<{ id?: string }> } };
      const value = envelope.value ?? {};
      const blocked = (value.tasks ?? []).filter((task) => task.status === 'blocked');
      return {
        message: {
          role: 'assistant',
          content: JSON.stringify({
            schema: 'openprojects.project-analysis-result.v1',
            projectId: value.project?.id ?? 'unknown',
            riskLevel: blocked.length >= 2 ? 'high' : blocked.length ? 'medium' : 'low',
            finding: 'The critical path remains blocked on credentials.',
            taskIds: blocked.map((task) => task.id).filter(Boolean),
            evidenceIds: (value.evidence ?? []).map((item) => item.id).filter(Boolean),
            impact: 'Dependent launch work may miss the deadline.',
            recommendedNextAction: 'Ask the owner to review the blocker; take no automatic action.',
            uncertainties: [],
            actionTaken: false,
          }),
        },
        model: 'captured-child-model',
      };
    }
    return {
      message: {
        role: 'assistant',
        content: null,
        toolCalls: [{ id: 'snapshot-call-1', name: 'project_analysis_snapshot_v1', arguments: '{}' }],
      },
      model: 'captured-child-model',
      route: {
        routeId: 'local-child-route',
        provider: 'mock',
        model: 'captured-child-model',
        local: true,
        task: request.task ?? 'project_analysis',
        reason: 'deterministic test route',
        estimatedCostUsd: 0,
      },
    };
  }
}

describe('SubagentCoordinator', () => {
  it('runs a bounded read-only child and preserves parent/child trace and provenance', async () => {
    const app = await createSubagentApp();
    const model = new CapturingChildModel();
    await replaceModel(app, model);
    const parent = createParentRun(app);

    const result = await app.subagents.invoke({
      parentRunId: parent.id,
      agentId: 'project-analyst',
      task: 'Analyze only the supplied critical-path evidence.',
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      agentId: 'project-analyst',
      output: expect.stringContaining('openprojects.project-analysis-result.v1'),
      route: {
        routeId: 'local-child-route',
        local: true,
        estimatedCostUsd: 0,
      },
    });
    expect(model.requests).toHaveLength(2);
    expect(model.requests[0]).toMatchObject({
      runId: result.childRunId,
      provider: 'mock',
      task: 'project_analysis',
      tools: [{
        name: 'project_analysis_snapshot_v1',
        description: expect.any(String),
        inputSchema: expect.any(Object),
      }],
    });
    expect(model.requests[0]?.messages[0]).toMatchObject({
      role: 'system',
      content: expect.stringContaining('project_analysis_snapshot_v1'),
    });
    expect(model.requests[0]?.messages[0]).toMatchObject({
      content: expect.stringContaining('actionTaken'),
    });

    const child = app.storage.getRun(result.childRunId);
    const childSession = app.storage.getSession(child.sessionId);
    expect(child).toMatchObject({
      workspaceId: parent.workspaceId,
      actorId: parent.actorId,
      projectId: parent.projectId,
      agentId: 'project-analyst',
      agentVersion: '0.5.0',
      status: 'succeeded',
      input: 'Analyze only the supplied critical-path evidence.',
      output: result.output,
      metadata: {
        parentRunId: parent.id,
        rootRunId: parent.id,
        subagentDepth: 1,
        laneContract: 'openprojects.project-analyst.v1',
      },
    });
    expect(childSession).toMatchObject({
      workspaceId: parent.workspaceId,
      actorId: parent.actorId,
      channel: 'internal:subagent',
      metadata: { parentRunId: parent.id },
    });

    const parentEvents = app.storage.eventsForRun(parent.id);
    expect(parentEvents.map((event) => event.type)).toEqual([
      'subagent.started',
      'subagent.completed',
    ]);
    expect(eventObject(parentEvents[0]!)).toMatchObject({
      childRunId: child.id,
      agent: { id: 'project-analyst', version: '0.5.0' },
      depth: 1,
    });
    expect(eventObject(parentEvents[1]!)).toMatchObject({
      childRunId: child.id,
      agentId: 'project-analyst',
      status: 'succeeded',
    });
    expect(app.storage.eventsForRun(child.id).map((event) => event.type)).toEqual(expect.arrayContaining([
      'run.created',
      'run.started',
      'user.message',
      'tool.call',
      'tool.result',
      'run.succeeded',
    ]));
    expect(app.storage.listToolInvocationsForRun(child.id)).toMatchObject([{
      toolName: 'project_analysis_snapshot_v1',
      policyDecision: 'allow',
      status: 'completed',
      result: { ok: true },
    }]);
  });

  it('rejects unknown agents, excessive depth, and calls beyond the parent budget', async () => {
    const app = await createSubagentApp({ maxCallsPerRun: 1, maxDepth: 1 });
    const model = new CapturingChildModel();
    await replaceModel(app, model);
    const parent = createParentRun(app);

    await expect(app.subagents.invoke({
      parentRunId: parent.id,
      agentId: 'not-allowlisted',
      task: 'Do something.',
      signal: new AbortController().signal,
    })).rejects.toThrow('Unknown subagent: not-allowlisted');
    expect(app.storage.eventsForRun(parent.id)).toEqual([]);

    const deepParent = createParentRun(app, { subagentDepth: 1 });
    await expect(app.subagents.invoke({
      parentRunId: deepParent.id,
      agentId: 'project-analyst',
      task: 'Recurse again.',
      signal: new AbortController().signal,
    })).rejects.toThrow('Subagent depth limit exceeded');
    expect(app.storage.eventsForRun(deepParent.id)).toEqual([]);

    await app.subagents.invoke({
      parentRunId: parent.id,
      agentId: 'project-analyst',
      task: 'First bounded call.',
      signal: new AbortController().signal,
    });
    await expect(app.subagents.invoke({
      parentRunId: parent.id,
      agentId: 'memory-curator',
      task: 'Second call should be rejected.',
      signal: new AbortController().signal,
    })).rejects.toThrow('Subagent call budget exceeded');
    expect(model.requests).toHaveLength(2);
    expect(app.storage.eventsForRun(parent.id).filter((event) => event.type === 'subagent.started')).toHaveLength(1);
  });

  it('fails the child without executing when the model returns an unoffered tool call', async () => {
    const app = await createSubagentApp();
    const model = new CapturingChildModel(true);
    await replaceModel(app, model);
    const parent = createParentRun(app);

    await expect(app.subagents.invoke({
      parentRunId: parent.id,
      agentId: 'project-analyst',
      task: 'Try to take an action.',
      signal: new AbortController().signal,
    })).rejects.toThrow('Tool-call budget exceeded');

    expect(model.requests).toHaveLength(2);
    expect(model.requests[0]?.tools.map((tool) => tool.name)).toEqual(['project_analysis_snapshot_v1']);
    const started = app.storage.eventsForRun(parent.id).find((event) => event.type === 'subagent.started');
    if (!started) throw new Error('Expected subagent.started');
    const childRunId = eventObject(started).childRunId;
    if (typeof childRunId !== 'string') throw new Error('Expected a child run ID');
    expect(app.storage.getRun(childRunId)).toMatchObject({
      status: 'failed',
      error: 'Tool-call budget exceeded',
    });
    expect(app.storage.listToolInvocationsForRun(childRunId)).toMatchObject([{
      toolName: 'project_get',
      policyDecision: 'deny',
      status: 'denied',
      result: { ok: false, error: { code: 'POLICY_DENIED' } },
    }]);
    expect(app.storage.eventsForRun(childRunId).map((event) => event.type)).toContain('run.failed');
    const completed = app.storage.eventsForRun(parent.id).find((event) => event.type === 'subagent.completed');
    if (!completed) throw new Error('Expected subagent.completed');
    expect(eventObject(completed)).toMatchObject({
      childRunId,
      agentId: 'project-analyst',
      status: 'failed',
      error: 'Tool-call budget exceeded',
    });
  });
});

async function createSubagentApp(
  limits: Partial<NonNullable<AppConfig['subagents']>> = {},
): Promise<OpenProjectsApp> {
  const config = testConfig({
    maxCallsPerRun: limits.maxCallsPerRun ?? 4,
    maxParallel: limits.maxParallel ?? 2,
    maxDepth: limits.maxDepth ?? 1,
  });
  const app = await createApp({
    config,
    databasePath: ':memory:',
    skills: [],
    seedDemo: true,
  });
  openApps.add(app);
  return app;
}

function testConfig(subagents: NonNullable<AppConfig['subagents']>): AppConfig {
  return {
    version: 1,
    agent: {
      id: 'test-parent',
      version: '1.0.0',
      name: 'Test Parent',
      system: 'Coordinate bounded project analysis.',
      skills: [],
      tools: [],
      budgets: {
        maxSteps: 4,
        maxToolCalls: 4,
        maxWallTimeMs: 30_000,
        maxInputTokens: 8_000,
        reservedOutputTokens: 512,
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
    server: { host: '127.0.0.1', port: 4310 },
    storage: { database: ':memory:' },
    model: { provider: 'mock', model: 'fixture' },
    memory: { retrievalLimit: 4, maxContextCharacters: 4_000 },
    subagents,
  };
}

function createParentRun(app: OpenProjectsApp, metadata: JsonObject = {}): RunRecord {
  const session = app.storage.createSession({
    workspaceId: 'local',
    actorId: 'alice',
    channel: 'test',
  });
  return app.storage.createRun({
    sessionId: session.id,
    workspaceId: 'local',
    actorId: 'alice',
    projectId: 'project-atlas',
    agentId: 'test-parent',
    agentVersion: '1.0.0',
    input: 'Parent task',
    metadata,
  });
}

async function replaceModel(app: OpenProjectsApp, model: ModelAdapter): Promise<void> {
  await app.kernel.unmount('model:mock');
  await app.kernel.mount(modelPlugin(model));
}

function eventObject(event: { type: string; data: unknown }): Record<string, unknown> {
  if (typeof event.data !== 'object' || event.data === null || Array.isArray(event.data)) {
    throw new Error(`${event.type} data is not an object`);
  }
  return event.data as Record<string, unknown>;
}
