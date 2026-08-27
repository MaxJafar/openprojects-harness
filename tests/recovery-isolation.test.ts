import { afterEach, describe, expect, it } from 'vitest';

import { createApp, type OpenProjectsApp } from '../src/app.js';
import type {
  AgentDefinition,
  AppConfig,
  HarnessEvent,
  JsonObject,
  ModelAdapter,
  ModelResponse,
  RunRecord,
  RunSnapshotSet,
} from '../src/core/types.js';
import { modelPlugin } from '../src/plugins/builtin.js';
import {
  PROJECT_ANALYST_AGENT,
  PROJECT_ANALYST_TOOL,
} from '../src/runtime/project-analyst.js';
import { captureRunSnapshots } from '../src/runtime/run-snapshots.js';
import { canonicalizeToolArguments } from '../src/runtime/tool-arguments.js';
import { startServer, type StartedServer } from '../src/server.js';

const openApps = new Set<OpenProjectsApp>();
const openServers = new Set<StartedServer>();

afterEach(async () => {
  for (const server of openServers) await server.close();
  openServers.clear();
  for (const app of openApps) await app.close();
  openApps.clear();
});

describe('startup recovery isolation', () => {
  it('quarantines mixed version, snapshot, and corruption failures while recovering a healthy run', async () => {
    const app = await recoveryApp();
    const currentAgent = normalizedAgent(app.config.agent);
    const matching = supervisorSnapshots(app, currentAgent);
    const mismatched = supervisorSnapshots(app, {
      ...currentAgent,
      system: 'A different committed system contract under the same nominal version.',
    });
    const corrupt = supervisorSnapshots(app, currentAgent, [
      ...app.kernel.listToolGuardPlugins(),
      'corrupt-snapshot-fixture',
    ]);
    const oldAgent = { ...currentAgent, version: '0.9.0' };

    const mismatchRun = allocateRunningRun(app, currentAgent, mismatched, 'snapshot mismatch', true);
    const corruptRun = allocateRunningRun(app, currentAgent, corrupt, 'corrupt snapshot', true);
    const versionRun = allocateRunningRun(
      app,
      oldAgent,
      supervisorSnapshots(app, oldAgent),
      'old agent version',
    );
    const healthyRun = allocateRunningRun(app, currentAgent, matching, 'healthy recovery');
    const corruptRowRun = allocateRunningRun(app, currentAgent, matching, 'corrupt row mapping', true);
    app.storage.db.prepare('UPDATE run_snapshot_documents SET canonical_json = ? WHERE digest = ?')
      .run('{"corrupt":', corrupt.policy.digest);
    app.storage.db.prepare('UPDATE runs SET metadata_json = ? WHERE id = ?')
      .run('{"corrupt":', corruptRowRun.id);
    const originalPage = app.storage.listRecoverableRunsForAgentPage.bind(app.storage);
    let pageCalls = 0;
    Object.defineProperty(app.storage, 'listRecoverableRunsForAgentPage', {
      configurable: true,
      value: (
        agentId: string,
        preferredVersion: string,
        options: { cursor?: string; limit?: number } = {},
      ) => {
        pageCalls += 1;
        return originalPage(agentId, preferredVersion, { ...options, limit: 2 });
      },
    });
    const unsubscribe = app.runtime.subscribe((event) => {
      if (event.type === 'run.recovery.failed') throw new Error('listener fixture failure');
    });

    const outcomes = await app.runtime.recover();
    unsubscribe();

    expect(outcomes.map((outcome) => outcome.run.id)).toEqual(expect.arrayContaining([
      mismatchRun.id,
      corruptRun.id,
      versionRun.id,
      healthyRun.id,
    ]));
    expect(app.storage.getRun(healthyRun.id).status).toBe('succeeded');
    expectRecoveryFailure(app, mismatchRun.id, 'snapshot_mismatch', true);
    expectRecoveryFailure(app, corruptRun.id, 'snapshot_invalid', true);
    expectRecoveryFailure(app, versionRun.id, 'agent_version_mismatch');
    expect(pageCalls).toBeGreaterThan(1);
    for (const run of [mismatchRun, corruptRun, versionRun]) {
      expect(app.storage.eventsForRun(run.id).some((event) => event.type === 'tool.execution.started')).toBe(false);
    }
    for (const run of [mismatchRun, corruptRun]) {
      const invocation = app.storage.unflushedBatchForRun(run.id);
      expect(invocation).toBeDefined();
      expect(app.storage.listToolInvocations(invocation!.id)[0]).toMatchObject({
        status: 'failed',
        result: {
          ok: false,
          error: {
            code: 'RUN_RECOVERY_UNKNOWN_OUTCOME',
            message: expect.stringContaining('Verify the effect before retrying'),
          },
        },
      });
    }
    const corruptRaw = app.storage.db.prepare('SELECT status, error FROM runs WHERE id = ?')
      .get(corruptRowRun.id) as { status: string; error: string };
    expect(corruptRaw).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('Unexpected end of JSON input'),
    });
    expect(occurrences(corruptRaw.error, 'external outcome is unknown')).toBe(1);
    const rawRecoveryEvent = eventObject(
      oneEvent(app.storage.eventsForRun(corruptRowRun.id), 'run.recovery.failed'),
    );
    expect(rawRecoveryEvent).toMatchObject({
      reason: 'corrupt_run_record',
      toolExecutionResumed: false,
      priorRunningInvocationCount: 1,
      externalOutcomeUnknown: true,
      forensicMetadataPreserved: true,
      error: expect.stringContaining('external outcome is unknown'),
    });
    expect(occurrences(String(rawRecoveryEvent.error), 'external outcome is unknown')).toBe(1);
    const corruptBatch = app.storage.unflushedBatchForRun(corruptRowRun.id);
    const corruptInvocation = app.storage.listToolInvocations(corruptBatch!.id)[0]!;
    expect(corruptInvocation).toMatchObject({
      status: 'failed',
      result: {
        ok: false,
        error: {
            code: 'RUN_RECOVERY_UNKNOWN_OUTCOME',
          message: expect.stringContaining('Verify the effect before retrying'),
        },
      },
    });
    expect(occurrences(
      corruptInvocation.result?.ok === false ? corruptInvocation.result.error?.message ?? '' : '',
      'external outcome is unknown',
    )).toBe(1);
    expect(app.storage.eventsForRun(corruptRowRun.id).some((event) => event.type === 'tool.execution.started')).toBe(false);
    expect(app.storage.outboxCount()).toBe(0);
  });

  it('keeps service startup ready when one agent lane is unrecoverable', async () => {
    const app = await recoveryApp();
    const analystSnapshots = captureRunSnapshots({
      agent: PROJECT_ANALYST_AGENT,
      systemPromptCommitment: 'static:',
      runtimeProfile: { task: 'project_analysis', retrieveMemory: false, maxModelAttempts: 2 },
      skills: [],
      tools: [requiredTool(app, PROJECT_ANALYST_TOOL)],
      policy: app.config.policy,
      policyGuards: app.kernel.listToolGuardPlugins(),
    });
    const badAnalyst = allocateRunningRun(
      app,
      PROJECT_ANALYST_AGENT,
      analystSnapshots,
      'analyst snapshot mismatch',
      true,
      PROJECT_ANALYST_TOOL,
    );
    const supervisor = normalizedAgent(app.config.agent);
    const healthySupervisor = allocateRunningRun(
      app,
      supervisor,
      supervisorSnapshots(app, supervisor),
      'healthy supervisor startup recovery',
    );
    const inertWait = allocateWaitingApproval(
      app,
      supervisor,
      supervisorSnapshots(app, supervisor),
      'unchanged approval wait',
    );

    const server = await startServer(app);
    openServers.add(server);

    expect(server.recoveredRunIds).toEqual(expect.arrayContaining([badAnalyst.id, healthySupervisor.id]));
    expect(server.recoveredRunIds).not.toContain(inertWait.id);
    expect(app.storage.getRun(badAnalyst.id).status).toBe('failed');
    expect(app.storage.getRun(healthySupervisor.id).status).toBe('succeeded');
    expect(app.storage.eventsForRun(badAnalyst.id).some((event) => event.type === 'tool.execution.started')).toBe(false);
    expect((await fetch(`${server.url}/health`)).status).toBe(200);
  });

  it('does not retain or materialize outcomes for many unchanged approval waits', async () => {
    const app = await recoveryApp();
    const agent = normalizedAgent(app.config.agent);
    const snapshots = supervisorSnapshots(app, agent);
    const waits = Array.from({ length: 128 }, (_, index) => allocateWaitingApproval(
      app,
      agent,
      snapshots,
      `unchanged approval wait ${index}`,
    ));
    const reconciled = allocateWaitingApproval(
      app,
      agent,
      snapshots,
      'crash before waiting transition',
      false,
    );
    const invalidWait = allocateRunningRun(
      app,
      agent,
      snapshots,
      'waiting without an approval batch',
      true,
    );
    const invalidBatch = app.storage.unflushedBatchForRun(invalidWait.id)!;
    app.storage.setToolBatchStatus(invalidBatch.id, 'flushed');
    app.storage.transitionRun(invalidWait.id, ['running'], 'waiting_for_approval');
    const sampleEventCount = app.storage.eventsForRun(waits[0]!.id).length;

    const recovered = await app.runtime.recover();

    expect(recovered).toHaveLength(2);
    expect(recovered.map((outcome) => outcome.run.id)).toEqual(expect.arrayContaining([
      reconciled.id,
      invalidWait.id,
    ]));
    expect(app.storage.getRun(waits[0]!.id).status).toBe('waiting_for_approval');
    expect(app.storage.eventsForRun(waits[0]!.id)).toHaveLength(sampleEventCount);
    expect(app.storage.listApprovals(waits[0]!.id, 'pending')).toHaveLength(1);
    expect(app.storage.getRun(waits.at(-1)!.id).status).toBe('waiting_for_approval');
    expect(app.storage.getRun(reconciled.id).status).toBe('waiting_for_approval');
    expect(eventObject(oneEvent(app.storage.eventsForRun(reconciled.id), 'run.waiting_for_approval')))
      .toMatchObject({ reason: 'restart_pending_approval_reconciled' });
    expectRecoveryFailure(app, invalidWait.id, 'recovery_state_invalid', true);
    expect(app.storage.listToolInvocations(invalidBatch.id)[0]).toMatchObject({
      status: 'failed',
      result: {
        ok: false,
        error: { code: 'RUN_RECOVERY_UNKNOWN_OUTCOME' },
      },
    });
  });
});

class RecoveryAnswerModel implements ModelAdapter {
  readonly id = 'mock';

  async complete(): Promise<ModelResponse> {
    return { message: { role: 'assistant', content: 'Recovered without executing a tool.' } };
  }
}

async function recoveryApp(): Promise<OpenProjectsApp> {
  const app = await createApp({
    config: recoveryConfig(),
    databasePath: ':memory:',
    skills: [],
    seedDemo: true,
  });
  openApps.add(app);
  await app.kernel.unmount('model:mock');
  await app.kernel.mount(modelPlugin(new RecoveryAnswerModel()));
  return app;
}

function allocateRunningRun(
  app: OpenProjectsApp,
  agent: AgentDefinition,
  snapshots: RunSnapshotSet,
  input: string,
  withInvocation = false,
  toolName = 'project_risk_report',
): RunRecord {
  const session = app.storage.createSession({
    workspaceId: 'local',
    actorId: 'recovery-operator',
    channel: 'test',
  });
  const run = app.storage.createRun({
    sessionId: session.id,
    workspaceId: 'local',
    actorId: 'recovery-operator',
    projectId: 'project-atlas',
    agentId: agent.id,
    agentVersion: agent.version,
    input,
    snapshots,
  });
  app.storage.transitionRun(run.id, ['queued'], 'running');
  app.storage.appendEvent(session.id, run.id, 'user.message', {
    message: { role: 'user', content: input },
    source: 'test',
  });
  if (withInvocation) {
    const batch = app.storage.createToolBatch(run.id, 0);
    const canonical = canonicalizeToolArguments(
      toolName === PROJECT_ANALYST_TOOL ? {} : { projectId: 'project-atlas' },
    );
    app.storage.createToolInvocation({
      batchId: batch.id,
      runId: run.id,
      callId: `recover-${run.id}`,
      callIndex: 0,
      toolName,
      arguments: canonical.arguments,
      argumentsDigest: canonical.argumentsDigest,
      effect: 'read',
      policyDecision: 'allow',
      status: 'running',
      idempotencyKey: `recover-${run.id}`,
    });
  }
  return app.storage.getRun(run.id);
}

function allocateWaitingApproval(
  app: OpenProjectsApp,
  agent: AgentDefinition,
  snapshots: RunSnapshotSet,
  input: string,
  transitionToWaiting = true,
): RunRecord {
  const run = allocateRunningRun(app, agent, snapshots, input);
  const batch = app.storage.createToolBatch(run.id, 0);
  const canonical = canonicalizeToolArguments({ projectId: 'project-atlas' });
  const invocation = app.storage.createToolInvocation({
    batchId: batch.id,
    runId: run.id,
    callId: `pending-${run.id}`,
    callIndex: 0,
    toolName: 'project_risk_report',
    arguments: canonical.arguments,
    argumentsDigest: canonical.argumentsDigest,
    effect: 'read',
    policyDecision: 'ask',
    status: 'pending_approval',
    idempotencyKey: `pending-${run.id}`,
  });
  app.storage.createApproval(invocation);
  return transitionToWaiting
    ? app.storage.transitionRun(run.id, ['running'], 'waiting_for_approval')
    : app.storage.getRun(run.id);
}

function supervisorSnapshots(
  app: OpenProjectsApp,
  agent: AgentDefinition,
  policyGuards = app.kernel.listToolGuardPlugins(),
): RunSnapshotSet {
  return captureRunSnapshots({
    agent,
    systemPromptCommitment: `static:${agent.system}`,
    runtimeProfile: { task: 'supervisor', retrieveMemory: true, maxModelAttempts: 2 },
    skills: app.skills,
    tools: agent.tools.map((name) => requiredTool(app, name)),
    policy: app.config.policy,
    policyGuards,
  });
}

function expectRecoveryFailure(
  app: OpenProjectsApp,
  runId: string,
  reason: string,
  priorOutcomeUnknown = false,
): void {
  expect(app.storage.getRun(runId)).toMatchObject({
    status: 'failed',
    error: expect.stringContaining(`[${reason}]`),
  });
  if (priorOutcomeUnknown) {
    expect(app.storage.getRun(runId).error).toContain('Verify the effect before retrying');
    expect(occurrences(
      app.storage.getRun(runId).error ?? '',
      'external outcome is unknown',
    )).toBe(1);
  }
  const recovery = eventObject(oneEvent(app.storage.eventsForRun(runId), 'run.recovery.failed'));
  expect(recovery).toMatchObject({
    reason,
    toolExecutionResumed: false,
    priorRunningInvocationCount: priorOutcomeUnknown ? 1 : 0,
    externalOutcomeUnknown: priorOutcomeUnknown,
  });
  const failed = eventObject(oneEvent(app.storage.eventsForRun(runId), 'run.failed'));
  expect(failed).toMatchObject({
    reason: 'recovery_failed',
    recoveryReason: reason,
    priorRunningInvocationCount: priorOutcomeUnknown ? 1 : 0,
    externalOutcomeUnknown: priorOutcomeUnknown,
  });
}

function oneEvent(events: HarnessEvent[], type: string): HarnessEvent {
  const matches = events.filter((event) => event.type === type);
  expect(matches, `expected exactly one ${type} event`).toHaveLength(1);
  return matches[0]!;
}

function eventObject(event: HarnessEvent): JsonObject {
  if (typeof event.data !== 'object' || event.data === null || Array.isArray(event.data)) {
    throw new Error(`${event.type} data is not an object`);
  }
  return event.data;
}

function occurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

function requiredTool(app: OpenProjectsApp, name: string) {
  const tool = app.kernel.tool(name);
  if (!tool) throw new Error(`Missing recovery test tool: ${name}`);
  return tool;
}

function normalizedAgent(agent: AppConfig['agent']): AgentDefinition {
  return { ...agent, system: agent.system ?? '' };
}

function recoveryConfig(): AppConfig {
  return {
    version: 1,
    agent: {
      id: 'recovery-supervisor',
      version: '1.0.0',
      name: 'Recovery Supervisor',
      system: 'Recover only under the exact durable contract.',
      skills: [],
      tools: ['project_risk_report'],
      budgets: {
        maxSteps: 3,
        maxToolCalls: 3,
        maxWallTimeMs: 30_000,
        maxInputTokens: 8_000,
        reservedOutputTokens: 512,
      },
    },
    policy: {
      read: 'allow',
      draft: 'allow',
      memory_write: 'ask',
      internal_write: 'ask',
      external_write: 'ask',
      destructive: 'deny',
    },
    server: { host: '127.0.0.1', port: 0 },
    storage: { database: ':memory:' },
    model: { provider: 'mock', model: 'recovery-fixture' },
    memory: { retrievalLimit: 2, maxContextCharacters: 1_000 },
  };
}
