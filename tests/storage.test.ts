import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ApprovalArgumentIntegrityError,
  SqliteStorage,
  STORAGE_READ_LIMITS,
} from '../src/storage/sqlite.js';
import type { ApprovalRecord, MemoryRecord, RunRecord, SessionRecord } from '../src/core/types.js';
import { canonicalizeToolArguments } from '../src/runtime/tool-arguments.js';

let storage: SqliteStorage;
const temporaryDirectories = new Set<string>();

beforeEach(() => {
  storage = new SqliteStorage(':memory:');
});

afterEach(() => {
  storage.close();
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
  temporaryDirectories.clear();
});

function createSession(workspaceId = 'workspace-a', actorId = 'actor-a'): SessionRecord {
  return storage.createSession({ workspaceId, actorId, channel: 'test' });
}

function createRun(
  session = createSession(),
  workspaceId = session.workspaceId,
  actorId = session.actorId,
): RunRecord {
  return storage.createRun({
    sessionId: session.id,
    workspaceId,
    actorId,
    projectId: 'project-a',
    agentId: 'openprojects',
    agentVersion: '1.0.0',
    input: 'Do the work',
  });
}

function createRecoverableRun(
  agentId: string,
  agentVersion: string,
  status: 'running' | 'waiting_for_approval' | 'succeeded' = 'running',
): RunRecord {
  const session = createSession('workspace-a', `actor-${agentId}-${agentVersion}-${status}`);
  const run = storage.createRun({
    sessionId: session.id,
    workspaceId: session.workspaceId,
    actorId: session.actorId,
    agentId,
    agentVersion,
    input: 'Recover this run',
  });
  const running = storage.transitionRun(run.id, ['queued'], 'running');
  if (status === 'running') return running;
  return storage.transitionRun(running.id, ['running'], status);
}

function createApprovalFor(workspaceId: string, callId: string): ApprovalRecord {
  const run = createRun(createSession(workspaceId, `actor-${workspaceId}`));
  storage.transitionRun(run.id, ['queued'], 'running');
  const batch = storage.createToolBatch(run.id, 0);
  const invocation = storage.createToolInvocation({
    batchId: batch.id,
    runId: run.id,
    callId,
    callIndex: 0,
    toolName: `tool.${callId}`,
    ...boundArguments({}),
    effect: 'external_write',
    policyDecision: 'ask',
    status: 'pending_approval',
    idempotencyKey: `${run.id}:${callId}`,
  });
  return storage.createApproval(invocation);
}

function boundArguments(value: Record<string, string> = {}): {
  arguments: string;
  argumentsDigest: string;
} {
  const canonical = canonicalizeToolArguments(value);
  return { arguments: canonical.arguments, argumentsDigest: canonical.argumentsDigest };
}

function putMemory(
  content: string,
  scope: { workspaceId: string; projectId?: string; actorId?: string },
  status: MemoryRecord['status'] = 'active',
): MemoryRecord {
  return storage.putMemory({
    ...scope,
    kind: 'semantic',
    content,
    importance: 0.5,
    sourceType: 'test',
    sourceId: `source:${content}`,
    status,
  });
}

describe('SqliteStorage memory isolation', () => {
  it('never crosses tenants, projects, actors, or inactive-memory boundaries during retrieval', () => {
    putMemory('shared roadmap', { workspaceId: 'workspace-a' });
    putMemory('project alpha roadmap', {
      workspaceId: 'workspace-a',
      projectId: 'project-a',
    });
    putMemory('project beta roadmap', {
      workspaceId: 'workspace-a',
      projectId: 'project-b',
    });
    putMemory('alice private roadmap', {
      workspaceId: 'workspace-a',
      projectId: 'project-a',
      actorId: 'alice',
    });
    putMemory('bob private roadmap', {
      workspaceId: 'workspace-a',
      projectId: 'project-a',
      actorId: 'bob',
    });
    putMemory('other tenant roadmap', {
      workspaceId: 'workspace-b',
      projectId: 'project-a',
      actorId: 'alice',
    });
    putMemory(
      'archived roadmap',
      { workspaceId: 'workspace-a', projectId: 'project-a', actorId: 'alice' },
      'archived',
    );

    const retrieved = storage.searchMemories(
      { workspaceId: 'workspace-a', projectId: 'project-a', actorId: 'alice' },
      'roadmap',
      20,
    );
    expect(retrieved.map((memory) => memory.content).sort()).toEqual(
      ['alice private roadmap', 'project alpha roadmap', 'shared roadmap'].sort(),
    );

    expect(
      storage
        .searchMemories({ workspaceId: 'workspace-a', projectId: 'project-b', actorId: 'bob' }, 'roadmap', 20)
        .map((memory) => memory.content)
        .sort(),
    ).toEqual(['project beta roadmap', 'shared roadmap'].sort());
    expect(
      storage
        .searchMemories({ workspaceId: 'workspace-b', projectId: 'project-a', actorId: 'alice' }, 'roadmap', 20)
        .map((memory) => memory.content),
    ).toEqual(['other tenant roadmap']);
  });

  it('includes workspace-global memory for a project list but excludes sibling projects and tenants', () => {
    putMemory('workspace global', { workspaceId: 'workspace-a' });
    putMemory('alpha only', { workspaceId: 'workspace-a', projectId: 'project-a' });
    putMemory('beta only', { workspaceId: 'workspace-a', projectId: 'project-b' });
    putMemory('other workspace', { workspaceId: 'workspace-b', projectId: 'project-a' });

    expect(
      storage.listMemories('workspace-a', 'project-a').map((memory) => memory.content).sort(),
    ).toEqual(['alpha only', 'workspace global']);
  });
});

describe('SqliteStorage event sequencing', () => {
  it('allocates a gap-free sequence per session across multiple runs', () => {
    const session = createSession();
    const firstRun = createRun(session);
    const secondRun = createRun(session);

    const first = storage.appendEvent(session.id, firstRun.id, 'run.started', { ordinal: 1 });
    const second = storage.appendEvent(session.id, secondRun.id, 'run.started', { ordinal: 2 });
    const third = storage.appendEvent(session.id, firstRun.id, 'run.finished', { ordinal: 3 });

    expect([first.seq, second.seq, third.seq]).toEqual([0, 1, 2]);
    expect(storage.eventsForSession(session.id).map((event) => event.seq)).toEqual([0, 1, 2]);
    expect(storage.eventsForRun(firstRun.id).map((event) => event.seq)).toEqual([0, 2]);
    expect(storage.eventsForRun(secondRun.id).map((event) => event.seq)).toEqual([1]);

    const otherSession = createSession();
    const otherRun = createRun(otherSession);
    expect(storage.appendEvent(otherSession.id, otherRun.id, 'run.started', {}).seq).toBe(0);
  });

  it('pages a run history after a cursor without materializing sibling-run events', () => {
    const session = createSession();
    const run = createRun(session);
    const sibling = createRun(session);
    for (let ordinal = 0; ordinal < 9; ordinal += 1) {
      storage.appendEvent(
        session.id,
        ordinal % 3 === 1 ? sibling.id : run.id,
        'test.event',
        { ordinal },
      );
    }

    const first = storage.eventsForRunPage(run.id, { limit: 2 });
    const second = storage.eventsForRunPage(run.id, { afterSeq: first.at(-1)!.seq, limit: 2 });
    const fenced = storage.eventsForRunPage(run.id, {
      afterSeq: second.at(-1)!.seq,
      throughSeq: 7,
      limit: 2,
    });

    expect(first.map((event) => event.seq)).toEqual([0, 2]);
    expect(second.map((event) => event.seq)).toEqual([3, 5]);
    expect(fenced.map((event) => event.seq)).toEqual([6]);
    expect(storage.latestEventSeqForRun(run.id)).toBe(8);
    expect(() => storage.eventsForRunPage(run.id, { limit: 1_001 })).toThrow('page limit');
    expect(() => storage.eventsForRunPage(run.id, { afterSeq: -2 })).toThrow('cursor');
  });

  it('bounds inspection windows, pages full session history, and preserves post-compaction context', () => {
    const session = createSession();
    const run = createRun(session);
    for (let ordinal = 0; ordinal < 3; ordinal += 1) {
      storage.appendEvent(session.id, run.id, 'test.event', { ordinal });
    }
    storage.appendEvent(session.id, run.id, 'context.compacted', {
      throughSeq: 2,
      summary: 'older history',
    });
    storage.appendEvent(session.id, run.id, 'user.message', { message: { content: 'latest request' } });
    storage.appendEvent(session.id, run.id, 'assistant.message', { message: { content: 'latest answer' } });

    expect(storage.eventsForSession(session.id, 2).map((event) => event.seq)).toEqual([4, 5]);
    expect(storage.eventsForRun(run.id, 2).map((event) => event.seq)).toEqual([4, 5]);
    expect(storage.eventsForSessionPage(session.id, { limit: 2 }).map((event) => event.seq)).toEqual([0, 1]);
    expect(storage.eventsForSessionPage(session.id, { afterSeq: 1, limit: 2 }).map((event) => event.seq))
      .toEqual([2, 3]);
    expect(storage.contextEventsForSession(session.id, 3).map((event) => event.seq)).toEqual([3, 4, 5]);
    expect(() => storage.contextEventsForSession(session.id, 2)).toThrow('materialization limit');
    expect(() => storage.eventsForSession(session.id, STORAGE_READ_LIMITS.sessionEvents + 1))
      .toThrow('Session event history limit');
    expect(() => storage.eventsForSessionPage(session.id, { limit: 1_001 })).toThrow('page limit');
  });
});

describe('SqliteStorage bounded collection reads', () => {
  it('applies deterministic limits before project collections reach tools or list routes', () => {
    storage.putProject({
      id: 'project-a',
      workspaceId: 'workspace-a',
      name: 'Alpha',
      status: 'active',
      summary: 'Alpha project',
      owner: 'Alice',
    });
    storage.putProject({
      id: 'project-b',
      workspaceId: 'workspace-a',
      name: 'Beta',
      status: 'active',
      summary: 'Beta project',
      owner: 'Bob',
    });
    for (const id of ['task-c', 'task-a', 'task-b']) {
      storage.putTask({
        id,
        workspaceId: 'workspace-a',
        projectId: 'project-a',
        title: id,
        status: 'open',
        priority: 'medium',
      });
    }

    expect(storage.listProjects('workspace-a', 1)).toHaveLength(1);
    const firstTaskWindow = storage.listTasks('project-a', 'workspace-a', 2).map((task) => task.id);
    expect(firstTaskWindow).toHaveLength(2);
    expect(storage.listTasks('project-a', 'workspace-a', 2).map((task) => task.id)).toEqual(firstTaskWindow);
    expect(() => storage.listProjects('workspace-a', STORAGE_READ_LIMITS.projects + 1))
      .toThrow('Project list limit');
    expect(() => storage.listTasks('project-a', 'workspace-a', STORAGE_READ_LIMITS.tasksPerProject + 1))
      .toThrow('Project task list limit');
    expect(() => storage.listEvidence(
      'project-a',
      'workspace-a',
      STORAGE_READ_LIMITS.evidencePerProject + 1,
    )).toThrow('Project evidence list limit');
  });
});

describe('SqliteStorage agent-scoped recovery reads', () => {
  it('filters the agent lane before LIMIT and orders the preferred version first', () => {
    for (let index = 0; index < 4; index += 1) {
      createRecoverableRun('other-agent', '9.0.0');
    }
    const oldestVersion = createRecoverableRun('lane-agent', '0.9.0');
    const old = createRecoverableRun('lane-agent', '1.0.0', 'waiting_for_approval');
    const preferred = createRecoverableRun('lane-agent', '2.0.0');
    const inertWait = createRecoverableRun('lane-agent', '2.0.0', 'waiting_for_approval');
    const inertBatch = storage.createToolBatch(inertWait.id, 0);
    const inertInvocation = storage.createToolInvocation({
      batchId: inertBatch.id,
      runId: inertWait.id,
      callId: 'inert-wait',
      callIndex: 0,
      toolName: 'project.read',
      ...boundArguments(),
      effect: 'read',
      policyDecision: 'ask',
      status: 'pending_approval',
      idempotencyKey: `${inertWait.id}:inert-wait`,
    });
    storage.createApproval(inertInvocation);
    createRecoverableRun('lane-agent', '2.0.0', 'succeeded');

    expect(storage.listRecoverableRunsForAgent('lane-agent', '2.0.0', 1).map((run) => run.id))
      .toEqual([preferred.id]);
    expect(storage.listRecoverableRunsForAgent('lane-agent', '2.0.0', 3).map((run) => run.id))
      .toEqual([preferred.id, oldestVersion.id, old.id]);
    expect(storage.listRecoverableRunsForAgent('lane-agent', '2.0.0', 10).map((run) => run.id))
      .not.toContain(inertWait.id);
    expect(storage.listRecoverableRunsForAgent('missing-agent', '2.0.0')).toEqual([]);
    expect(() => storage.listRecoverableRunsForAgent(
      'lane-agent',
      '2.0.0',
      STORAGE_READ_LIMITS.runRows + 1,
    )).toThrow('Agent recoverable run page limit');

    const first = storage.listRecoverableRunsForAgentPage('lane-agent', '2.0.0', { limit: 1 });
    const second = storage.listRecoverableRunsForAgentPage('lane-agent', '2.0.0', {
      limit: 1,
      cursor: first.nextCursor!,
    });
    const third = storage.listRecoverableRunsForAgentPage('lane-agent', '2.0.0', {
      limit: 1,
      cursor: second.nextCursor!,
    });
    const fourth = storage.listRecoverableRunsForAgentPage('lane-agent', '2.0.0', {
      limit: 1,
      cursor: third.nextCursor!,
    });
    expect([first, second, third].map((page) => page.candidates[0]))
      .toEqual([
        { ok: true, run: preferred },
        { ok: true, run: oldestVersion },
        { ok: true, run: old },
      ]);
    expect(fourth.candidates).toEqual([]);
    expect(() => storage.listRecoverableRunsForAgentPage('other-agent', '2.0.0', {
      cursor: first.nextCursor!,
    })).toThrow('Recoverable run cursor is invalid');
    expect(() => storage.listRecoverableRunsForAgentPage('lane-agent', 'different-version', {
      cursor: first.nextCursor!,
    })).toThrow('Recoverable run cursor is invalid');
    expect(() => storage.listRecoverableRunsForAgentPage('lane-agent', '3.0.0', {
      cursor: third.nextCursor!,
    })).toThrow('Recoverable run cursor is invalid');

    const preferredPlan = storage.db.prepare(`EXPLAIN QUERY PLAN
      SELECT * FROM runs INDEXED BY runs_recoverable_agent_idx
      WHERE agent_id = ? AND agent_version = ?
        AND status IN ('running', 'waiting_for_approval')
        AND (
          status = 'running'
          OR EXISTS (SELECT 1 FROM tool_invocations AS running_invocation
            WHERE running_invocation.run_id = runs.id AND running_invocation.status = 'running')
          OR NOT EXISTS (SELECT 1 FROM tool_invocations AS pending_invocation
            WHERE pending_invocation.run_id = runs.id AND pending_invocation.status = 'pending_approval')
        )
      ORDER BY created_at, id LIMIT ?`)
      .all('lane-agent', '2.0.0', 2) as Array<Record<string, unknown>>;
    const nonpreferredPlan = storage.db.prepare(`EXPLAIN QUERY PLAN
      SELECT * FROM runs INDEXED BY runs_recoverable_agent_idx
      WHERE agent_id = ? AND agent_version != ?
        AND status IN ('running', 'waiting_for_approval')
      ORDER BY agent_version, created_at, id LIMIT ?`)
      .all('lane-agent', '2.0.0', 2) as Array<Record<string, unknown>>;
    for (const plan of [preferredPlan, nonpreferredPlan]) {
      expect(plan.some((row) => String(row.detail).includes('runs_recoverable_agent_idx'))).toBe(true);
      expect(plan.some((row) => String(row.detail).includes('USE TEMP B-TREE'))).toBe(false);
    }
  });

  it('pages past malformed rows and quarantines them without rewriting forensic fields', () => {
    const corrupt = createRecoverableRun('lane-agent', '2.0.0');
    const healthy = createRecoverableRun('lane-agent', '2.0.0');
    storage.db.prepare(`UPDATE runs SET metadata_json = ?, created_at = ? WHERE id = ?`)
      .run('{not-json', '!invalid-but-bounded-created-at', corrupt.id);

    const first = storage.listRecoverableRunsForAgentPage('lane-agent', '2.0.0', { limit: 1 });
    expect(first.candidates).toEqual([expect.objectContaining({
      ok: false,
      id: corrupt.id,
      sessionId: corrupt.sessionId,
      error: expect.any(String),
    })]);
    const failed = first.candidates[0]!;
    if (failed.ok) throw new Error('Expected a malformed recovery candidate');
    const quarantined = storage.quarantineCorruptRecoverableRun(
      failed.id,
      failed.agentId,
      '2.0.0',
      failed.error,
    );
    expect(quarantined).toMatchObject({
      changed: true,
      event: {
        type: 'run.recovery.failed',
        data: {
          reason: 'corrupt_run_record',
          forensicMetadataPreserved: true,
        },
      },
    });
    expect(storage.db.prepare(`SELECT status, metadata_json AS metadataJson,
      agent_snapshot_digest AS agentSnapshot FROM runs WHERE id = ?`).get(corrupt.id)).toEqual({
      status: 'failed',
      metadataJson: '{not-json',
      agentSnapshot: corrupt.snapshots!.agent,
    });
    expect(storage.quarantineCorruptRecoverableRun(
      failed.id,
      failed.agentId,
      '2.0.0',
      failed.error,
    )).toEqual({ changed: false });

    const second = storage.listRecoverableRunsForAgentPage('lane-agent', '2.0.0', {
      limit: 1,
      cursor: first.nextCursor!,
    });
    expect(second.candidates).toEqual([{ ok: true, run: healthy }]);
  });

  it('continues after oversized raw sort keys without embedding them in the cursor', () => {
    const oversized = createRecoverableRun('lane-agent', '2.0.0');
    const healthy = createRecoverableRun('lane-agent', '2.0.0');
    const oversizedId = `oversized-${'i'.repeat(257)}`;
    const oversizedCreatedAt = `!${'t'.repeat(256)}`;
    storage.db.exec('PRAGMA foreign_keys = OFF');
    storage.db.prepare('UPDATE runs SET rowid = -1, id = ?, created_at = ? WHERE id = ?')
      .run(oversizedId, oversizedCreatedAt, oversized.id);
    storage.db.exec('PRAGMA foreign_keys = ON');

    const first = storage.listRecoverableRunsForAgentPage('lane-agent', '2.0.0', { limit: 1 });
    expect(first.candidates).toEqual([expect.objectContaining({
      ok: true,
      run: expect.objectContaining({ id: oversizedId, createdAt: oversizedCreatedAt }),
    })]);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(first.nextCursor!.length).toBeLessThan(128);

    const second = storage.listRecoverableRunsForAgentPage('lane-agent', '2.0.0', {
      limit: 1,
      cursor: first.nextCursor!,
    });
    expect(second.candidates).toEqual([{ ok: true, run: healthy }]);
  });
});

describe('SqliteStorage atomic tool-batch flushing', () => {
  it('is idempotent and never appends duplicate tool.result or step.ended events', () => {
    const run = createRun();
    const batch = storage.createToolBatch(run.id, 3);
    const invocation = storage.createToolInvocation({
      batchId: batch.id,
      runId: run.id,
      callId: 'call-flush-once',
      callIndex: 0,
      toolName: 'project.read',
      ...boundArguments(),
      effect: 'read',
      policyDecision: 'allow',
      status: 'running',
      idempotencyKey: `${run.id}:call-flush-once`,
    });
    storage.finishToolInvocation(invocation.id, 'completed', {
      callId: invocation.callId,
      name: invocation.toolName,
      ok: true,
      value: { projectId: 'project-a' },
      durationMs: 4,
    });

    const first = storage.flushToolBatch(batch.id);
    const afterFirst = storage.eventsForRun(run.id);
    const second = storage.flushToolBatch(batch.id);
    const afterSecond = storage.eventsForRun(run.id);

    expect(first.map((event) => event.type)).toEqual(['tool.result', 'step.ended']);
    expect(eventData(first[0]!)).toEqual({
      step: 3,
      batchId: batch.id,
      callId: 'call-flush-once',
      name: 'project.read',
      argumentsDigest: invocation.argumentsDigest,
      result: {
        callId: 'call-flush-once',
        name: 'project.read',
        ok: true,
        value: { projectId: 'project-a' },
        durationMs: 4,
      },
    });
    expect(second).toEqual([]);
    expect(afterSecond).toEqual(afterFirst);
    expect(afterSecond.filter((event) => event.type === 'tool.result')).toHaveLength(1);
    expect(afterSecond.filter((event) => event.type === 'step.ended')).toHaveLength(1);
    expect(storage.getToolBatch(batch.id).status).toBe('flushed');
  });
});

describe('SqliteStorage run transitions', () => {
  it('applies compare-from transitions, timestamps lifecycle edges, and preserves state on rejection', () => {
    const run = createRun();
    expect(run.status).toBe('queued');
    expect(run.startedAt).toBeUndefined();

    const running = storage.transitionRun(run.id, ['queued'], 'running', {
      step: 1,
      toolCalls: 2,
    });
    expect(running).toMatchObject({ status: 'running', step: 1, toolCalls: 2 });
    expect(running.startedAt).toBeDefined();

    expect(() => storage.transitionRun(run.id, ['queued'], 'succeeded')).toThrow(
      `Invalid run transition running -> succeeded for ${run.id}`,
    );
    expect(storage.getRun(run.id)).toMatchObject({ status: 'running', step: 1, toolCalls: 2 });

    const waiting = storage.transitionRun(run.id, ['running'], 'waiting_for_approval');
    expect(waiting.status).toBe('waiting_for_approval');
    const resumed = storage.transitionRun(run.id, ['waiting_for_approval'], 'running');
    expect(resumed.startedAt).toBe(running.startedAt);

    const succeeded = storage.transitionRun(run.id, ['running'], 'succeeded', {
      output: 'complete',
    });
    expect(succeeded).toMatchObject({ status: 'succeeded', output: 'complete' });
    expect(succeeded.finishedAt).toBeDefined();
  });
});

describe('SqliteStorage approvals', () => {
  it('resolves an approval exactly once and never reverses the first decision', () => {
    const run = createRun();
    storage.transitionRun(run.id, ['queued'], 'running');
    const batch = storage.createToolBatch(run.id, 0);
    const invocation = storage.createToolInvocation({
      batchId: batch.id,
      runId: run.id,
      callId: 'call-1',
      callIndex: 0,
      toolName: 'projects.notify',
      ...boundArguments({ projectId: 'project-a' }),
      effect: 'external_write',
      policyDecision: 'ask',
      status: 'pending_approval',
      idempotencyKey: `${run.id}:call-1`,
    });
    const approval = storage.createApproval(invocation);

    const first = storage.resolveApproval(
      approval.id,
      'approve',
      'alice',
      'looks good',
      approval.argumentsDigest,
    );
    expect(first).toMatchObject({
      changed: true,
      approval: { status: 'approved', resolvedBy: 'alice', reason: 'looks good' },
      invocation: { status: 'running' },
    });

    const replay = storage.resolveApproval(
      approval.id,
      'approve',
      'mallory',
      'replayed decision',
      approval.argumentsDigest,
    );
    expect(replay).toMatchObject({
      changed: false,
      approval: { status: 'approved', resolvedBy: 'alice', reason: 'looks good' },
      invocation: { status: 'running' },
    });
    expect(replay.approval.resolvedAt).toBe(first.approval.resolvedAt);
    expect(() => storage.resolveApproval(approval.id, 'reject', 'mallory', 'changed mind')).toThrow(
      'already approved',
    );
  });

  it('checks the reviewed digest and both durable argument copies in the decision transaction', () => {
    const stale = createApprovalFor('workspace-a', 'stale-digest');
    const staleBefore = storage.eventsForRun(stale.runId).length;
    const wrongDigest = `sha256:${'0'.repeat(64)}`;
    expect(() => storage.resolveApproval(stale.id, 'approve', 'alice', undefined, wrongDigest))
      .toThrow(ApprovalArgumentIntegrityError);
    expect(storage.getApproval(stale.id).status).toBe('pending');
    expect(storage.approvalWithInvocation(stale.id).invocation.status).toBe('pending_approval');
    expect(storage.eventsForRun(stale.runId)).toHaveLength(staleBefore);

    const tamperedApproval = createApprovalFor('workspace-a', 'tampered-approval');
    storage.db.prepare('UPDATE approvals SET arguments_json = ? WHERE id = ?')
      .run('{"changed":"approval"}', tamperedApproval.id);
    expect(() => storage.resolveApproval(
      tamperedApproval.id,
      'approve',
      'alice',
      undefined,
      tamperedApproval.argumentsDigest,
    )).toThrow(ApprovalArgumentIntegrityError);
    expect(storage.getApproval(tamperedApproval.id).status).toBe('pending');
    expect(storage.approvalWithInvocation(tamperedApproval.id).invocation.status).toBe('pending_approval');

    const tamperedInvocation = createApprovalFor('workspace-a', 'tampered-invocation');
    storage.db.prepare('UPDATE tool_invocations SET arguments_digest = ? WHERE id = ?')
      .run(`sha256:${'f'.repeat(64)}`, tamperedInvocation.invocationId);
    expect(() => storage.resolveApproval(
      tamperedInvocation.id,
      'approve',
      'alice',
      undefined,
      tamperedInvocation.argumentsDigest,
    )).toThrow(ApprovalArgumentIntegrityError);
    expect(storage.getApproval(tamperedInvocation.id).status).toBe('pending');
    expect(storage.approvalWithInvocation(tamperedInvocation.id).invocation.status).toBe('pending_approval');
  });

  it('allows safe rejection but forbids approval of a legacy pending row without a digest', () => {
    const run = createRun();
    storage.transitionRun(run.id, ['queued'], 'running');
    const batch = storage.createToolBatch(run.id, 0);
    const invocation = storage.createToolInvocation({
      batchId: batch.id,
      runId: run.id,
      callId: 'legacy-call',
      callIndex: 0,
      toolName: 'projects.notify',
      arguments: '{"projectId":"project-a"}',
      effect: 'external_write',
      policyDecision: 'ask',
      status: 'pending_approval',
      idempotencyKey: `${run.id}:legacy-call`,
    });
    const approval = storage.createApproval(invocation);

    expect(approval.argumentsDigest).toBeUndefined();
    expect(() => storage.resolveApproval(approval.id, 'approve', 'alice'))
      .toThrow(ApprovalArgumentIntegrityError);
    expect(storage.getApproval(approval.id).status).toBe('pending');
    expect(storage.getToolInvocation(invocation.id).status).toBe('pending_approval');

    expect(storage.resolveApproval(approval.id, 'reject', 'alice')).toMatchObject({
      changed: true,
      approval: { status: 'rejected' },
      invocation: { status: 'denied' },
    });
  });

  it('keyset-pages an indexed workspace queue with pending approvals first', () => {
    const resolved = createApprovalFor('workspace-a', 'resolved');
    storage.resolveApproval(resolved.id, 'reject', 'alice');
    const pendingOne = createApprovalFor('workspace-a', 'pending-one');
    const pendingTwo = createApprovalFor('workspace-a', 'pending-two');
    createApprovalFor('workspace-b', 'other-tenant');

    const seen: ApprovalRecord[] = [];
    let cursor: string | undefined;
    do {
      const page = storage.listApprovalsPage({
        workspaceId: 'workspace-a',
        limit: 1,
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...page.approvals);
      cursor = page.nextCursor;
    } while (cursor);

    expect(new Set(seen.map((item) => item.id))).toEqual(
      new Set([pendingOne.id, pendingTwo.id, resolved.id]),
    );
    expect(seen.slice(0, 2).every((item) => item.status === 'pending')).toBe(true);
    expect(seen[2]?.status).toBe('rejected');
    expect(storage.listApprovalsPage({ workspaceId: 'workspace-b' }).approvals)
      .toEqual([expect.objectContaining({ toolName: 'tool.other-tenant' })]);

    const first = storage.listApprovalsPage({ workspaceId: 'workspace-a', limit: 1 });
    expect(() => storage.listApprovalsPage({
      workspaceId: 'workspace-b',
      limit: 1,
      cursor: first.nextCursor!,
    })).toThrow('Approval cursor is invalid');

    const plan = storage.db.prepare(`EXPLAIN QUERY PLAN SELECT * FROM approvals
      WHERE workspace_id = ? ORDER BY queue_order, requested_at DESC, id DESC LIMIT ?`)
      .all('workspace-a', 2) as Array<Record<string, unknown>>;
    expect(plan.some((row) => String(row.detail).includes('approvals_workspace_queue_page_idx'))).toBe(true);

    const statusPlan = storage.db.prepare(`EXPLAIN QUERY PLAN SELECT * FROM approvals
      WHERE workspace_id = ? AND status = ?
      ORDER BY queue_order, requested_at DESC, id DESC LIMIT ?`)
      .all('workspace-a', 'pending', 2) as Array<Record<string, unknown>>;
    expect(statusPlan.some((row) => String(row.detail).includes('approvals_workspace_status_queue_page_idx')))
      .toBe(true);
  });
});

describe('SqliteStorage tool argument binding migration', () => {
  it('adds nullable digest columns without treating legacy pending rows as approvable', () => {
    storage.close();
    const directory = mkdtempSync(join(tmpdir(), 'openprojects-tool-argument-migration-'));
    temporaryDirectories.add(directory);
    const databasePath = join(directory, 'legacy.db');
    storage = new SqliteStorage(databasePath);
    const legacyApproval = createApprovalFor('workspace-a', 'legacy-migration');
    storage.close();

    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      DELETE FROM schema_migrations WHERE version >= 7;
      PRAGMA user_version = 6;
      DROP INDEX runs_recoverable_agent_idx;
      ALTER TABLE approvals DROP COLUMN arguments_digest;
      ALTER TABLE tool_invocations DROP COLUMN arguments_digest;
    `);
    legacy.close();

    storage = new SqliteStorage(databasePath);
    const invocationColumns = storage.db.prepare('PRAGMA table_info(tool_invocations)').all() as Array<{ name: string }>;
    const approvalColumns = storage.db.prepare('PRAGMA table_info(approvals)').all() as Array<{ name: string }>;
    expect(invocationColumns.map((column) => column.name)).toContain('arguments_digest');
    expect(approvalColumns.map((column) => column.name)).toContain('arguments_digest');
    expect(storage.getApproval(legacyApproval.id).argumentsDigest).toBeUndefined();
    expect(storage.getToolInvocation(legacyApproval.invocationId).argumentsDigest).toBeUndefined();
    expect(() => storage.resolveApproval(legacyApproval.id, 'approve', 'alice'))
      .toThrow(ApprovalArgumentIntegrityError);
    expect(storage.resolveApproval(legacyApproval.id, 'reject', 'alice')).toMatchObject({
      approval: { status: 'rejected' },
      invocation: { status: 'denied' },
    });
  });
});

describe('SqliteStorage inbound deduplication', () => {
  it('deduplicates within a source and returns the originally attached run', () => {
    const occurredAt = '2026-01-01T00:00:00.000Z';
    const first = storage.recordInboundEvent({
      source: 'telegram',
      dedupeKey: 'update-42',
      type: 'message.received',
      workspaceId: 'workspace-a',
      actorId: 'alice',
      payload: { text: 'first payload' },
      occurredAt,
    });
    expect(first.duplicate).toBe(false);

    const run = createRun();
    storage.attachInboundRun(first.id, run.id);
    const replay = storage.recordInboundEvent({
      source: 'telegram',
      dedupeKey: 'update-42',
      type: 'message.received',
      workspaceId: 'workspace-a',
      actorId: 'alice',
      payload: { text: 'conflicting replay payload' },
      occurredAt,
    });
    expect(replay).toEqual({ id: first.id, duplicate: true, runId: run.id });

    const anotherSource = storage.recordInboundEvent({
      source: 'slack',
      dedupeKey: 'update-42',
      type: 'message.received',
      workspaceId: 'workspace-a',
      actorId: 'alice',
      payload: { text: 'independent event' },
      occurredAt,
    });
    expect(anotherSource.duplicate).toBe(false);
    expect(anotherSource.id).not.toBe(first.id);

    const anotherWorkspace = storage.recordInboundEvent({
      source: 'telegram',
      dedupeKey: 'update-42',
      type: 'message.received',
      workspaceId: 'workspace-b',
      actorId: 'bob',
      payload: { text: 'same provider key, different tenant' },
      occurredAt,
    });
    expect(anotherWorkspace.duplicate).toBe(false);
    expect(anotherWorkspace.id).not.toBe(first.id);
  });

  it('migrates the v0.2 global dedupe constraint without losing existing events', () => {
    storage.close();
    const directory = mkdtempSync(join(tmpdir(), 'openprojects-inbound-migration-'));
    temporaryDirectories.add(directory);
    const databasePath = join(directory, 'legacy.db');
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`CREATE TABLE inbound_events (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      dedupe_key TEXT NOT NULL,
      type TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      project_id TEXT,
      payload_json TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      run_id TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(source, dedupe_key)
    );`);
    legacy.prepare(`INSERT INTO inbound_events
      (id, source, dedupe_key, type, workspace_id, actor_id, payload_json, occurred_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('legacy-event', 'telegram', 'update-1', 'message', 'workspace-a', 'alice', '{}',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    legacy.close();

    storage = new SqliteStorage(databasePath);
    expect(storage.recordInboundEvent({
      source: 'telegram',
      dedupeKey: 'update-1',
      type: 'message',
      workspaceId: 'workspace-a',
      actorId: 'alice',
      payload: {},
      occurredAt: '2026-01-01T00:00:00.000Z',
    })).toMatchObject({ id: 'legacy-event', duplicate: true });
    expect(storage.recordInboundEvent({
      source: 'telegram',
      dedupeKey: 'update-1',
      type: 'message',
      workspaceId: 'workspace-b',
      actorId: 'bob',
      payload: {},
      occurredAt: '2026-01-01T00:00:00.000Z',
    }).duplicate).toBe(false);
  });
});

describe('SqliteStorage external group ownership', () => {
  it('never migrates a provider-global group identity across workspaces', () => {
    const original = storage.upsertGroupSpace({
      workspaceId: 'workspace-a',
      source: 'telegram',
      externalId: 'chat-42',
      learningEnabled: true,
      notificationsEnabled: false,
      createdBy: 'administrator',
    });
    expect(() => storage.upsertGroupSpace({
      workspaceId: 'workspace-b',
      source: 'telegram',
      externalId: 'chat-42',
      learningEnabled: false,
      notificationsEnabled: true,
      createdBy: 'other-administrator',
    })).toThrow('already bound to a different workspace');
    expect(storage.getGroupSpace(original.id)).toMatchObject({
      workspaceId: 'workspace-a',
      learningEnabled: true,
      notificationsEnabled: false,
    });
  });
});

describe('SqliteStorage outbox idempotency', () => {
  it('returns the original queued item for a replayed idempotency key', () => {
    const first = storage.enqueueOutbox({
      workspaceId: 'workspace-a',
      projectId: 'project-a',
      destination: 'telegram:123',
      subject: 'Project update',
      body: 'Original body',
      idempotencyKey: 'notify:project-a:revision-7',
    });
    const replay = storage.enqueueOutbox({
      workspaceId: 'workspace-b',
      projectId: 'project-b',
      destination: 'telegram:999',
      subject: 'Conflicting replay',
      body: 'Replacement body',
      idempotencyKey: 'notify:project-a:revision-7',
    });

    expect(first).toMatchObject({
      destination: 'telegram:123',
      subject: 'Project update',
      status: 'queued',
      replayed: false,
    });
    expect(replay).toEqual({ ...first, replayed: true });
    expect(storage.outboxCount()).toBe(1);

    storage.enqueueOutbox({
      workspaceId: 'workspace-a',
      destination: 'telegram:123',
      subject: 'Next update',
      body: 'New body',
      idempotencyKey: 'notify:project-a:revision-8',
    });
    expect(storage.outboxCount()).toBe(2);
  });
});

function eventData(event: { data: unknown }): unknown {
  return event.data;
}
