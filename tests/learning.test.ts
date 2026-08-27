import { createHash } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type {
  EmbeddingAdapter,
  MemoryRecord,
  RunRecord,
} from '../src/core/types.js';
import { createApp } from '../src/app.js';
import {
  exportLearningDatasets,
  type LearningDatasetArtifact,
  type PreferenceDatasetRow,
  type RewardDatasetRow,
  type SftDatasetRow,
} from '../src/learning/export.js';
import { MemoryEngine } from '../src/learning/memory-engine.js';
import { startServer } from '../src/server.js';
import { SqliteStorage } from '../src/storage/sqlite.js';

const FIXED_TIME = new Date('2026-08-25T08:00:00.000Z');

let storage: SqliteStorage;

beforeEach(() => {
  storage = new SqliteStorage(':memory:');
});

afterEach(() => {
  storage.close();
});

class FakeEmbedding implements EmbeddingAdapter {
  readonly dimensions = 2;
  readonly calls: string[][] = [];

  constructor(
    readonly id = 'fake-embedding-v1',
    private readonly vectorFor: (text: string) => number[] = () => [1, 0],
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    this.calls.push([...texts]);
    return texts.map((text) => this.vectorFor(text));
  }
}

class FailingEmbedding implements EmbeddingAdapter {
  readonly id = 'offline-embedding-v1';
  readonly dimensions = 2;

  async embed(_texts: string[]): Promise<number[][]> {
    throw new Error('local embedder offline');
  }
}

describe('MemoryEngine group observation', () => {
  it('requires group opt-in, isolates workspaces, deduplicates messages, redacts secrets, and proposes salient memory', async () => {
    const enabled = storage.upsertGroupSpace({
      workspaceId: 'workspace-enabled',
      source: 'telegram',
      externalId: 'chat-enabled',
      title: 'Enabled group',
      projectId: 'project-enabled',
      learningEnabled: true,
      notificationsEnabled: false,
      createdBy: 'admin-a',
    });
    const disabled = storage.upsertGroupSpace({
      workspaceId: 'workspace-disabled',
      source: 'telegram',
      externalId: 'chat-disabled',
      title: 'Disabled group',
      projectId: 'project-disabled',
      learningEnabled: false,
      notificationsEnabled: false,
      createdBy: 'admin-b',
    });
    const embedding = new FakeEmbedding();
    const engine = new MemoryEngine({
      storage,
      embedding,
      minimumSalience: 0.55,
      clock: () => FIXED_TIME,
    });
    const text = 'Important: we will deliver by 2026-09-01. api_key=abcdefghijklmnop';

    const ignored = await engine.observeGroupMessage({
      groupSpaceId: disabled.id,
      externalMessageId: 'disabled-message-1',
      actorId: 'bob',
      text,
    });
    expect(ignored).toMatchObject({
      observed: false,
      duplicate: false,
      reason: 'learning_disabled',
    });
    expect(storage.listGroupMessages(disabled.id)).toEqual([]);
    expect(storage.listMemories('workspace-disabled')).toEqual([]);

    const first = await engine.observeGroupMessage({
      groupSpaceId: enabled.id,
      externalMessageId: 'enabled-message-1',
      actorId: 'alice',
      text,
      occurredAt: FIXED_TIME.toISOString(),
    });
    const replay = await engine.observeGroupMessage({
      groupSpaceId: enabled.id,
      externalMessageId: 'enabled-message-1',
      actorId: 'mallory',
      text: 'Important: conflicting replay says we will deliver tomorrow.',
      occurredAt: new Date(FIXED_TIME.getTime() + 1_000).toISOString(),
    });

    expect(first).toMatchObject({
      observed: true,
      duplicate: false,
      redactions: 1,
      assessment: { salient: true, eligible: true },
      memory: {
        workspaceId: 'workspace-enabled',
        projectId: 'project-enabled',
        status: 'proposed',
      },
    });
    expect(first.memory?.content).toContain('api_key=[REDACTED:SECRET]');
    expect(first.memory?.content).not.toContain('abcdefghijklmnop');
    expect(replay).toMatchObject({
      observed: true,
      duplicate: true,
      messageId: first.messageId,
      memory: { id: first.memory?.id },
    });
    expect(storage.listGroupMessages(enabled.id)).toHaveLength(1);
    expect(storage.listMemories('workspace-enabled', 'project-enabled')).toHaveLength(1);
    expect(storage.searchMemories(
      { workspaceId: 'workspace-enabled', projectId: 'project-enabled', actorId: 'alice' },
      'deliver',
    )).toEqual([]);
    expect(embedding.calls).toEqual([]);
    await expect(engine.embedMemory(first.memory!.id)).rejects.toThrow('must be active before embedding');
    expect(embedding.calls).toEqual([]);

    const cancellation = new AbortController();
    cancellation.abort(new Error('activation cancelled'));
    await expect(engine.setStatus(
      first.memory!.id,
      'workspace-enabled',
      'active',
      cancellation.signal,
    )).rejects.toThrow('activation cancelled');
    expect(embedding.calls).toEqual([]);

    const activated = await engine.setStatus(
      first.memory!.id,
      'workspace-enabled',
      'active',
    );
    expect(activated).toMatchObject({
      memory: { id: first.memory?.id, status: 'active' },
      embedding: 'stored',
    });
    expect(embedding.calls).toEqual([[first.memory!.content]]);
    expect(storage.searchMemories(
      { workspaceId: 'workspace-enabled', projectId: 'project-enabled', actorId: 'alice' },
      'deliver',
    ).map((memory) => memory.id)).toEqual([first.memory!.id]);

    expect(storage.forgetGroupData(enabled.id)).toMatchObject({
      messagesDeleted: 1,
      memoriesDeleted: 1,
      signalsDeleted: 1,
      bindingRetainedDisabled: true,
    });
    expect(storage.listGroupMessages(enabled.id)).toEqual([]);
    expect(storage.listMemories('workspace-enabled')).toEqual([]);
    expect(storage.getGroupSpace(enabled.id)).toMatchObject({
      learningEnabled: false,
      notificationsEnabled: false,
    });
  });

  it('assesses non-salient chatter before persistence and retains no message text', async () => {
    const group = storage.upsertGroupSpace({
      workspaceId: 'workspace-private',
      source: 'telegram',
      externalId: 'chat-private',
      learningEnabled: true,
      notificationsEnabled: false,
      createdBy: 'admin-private',
    });
    const embedding = new FakeEmbedding();
    const engine = new MemoryEngine({ storage, embedding, clock: () => FIXED_TIME });
    const secret = 'non-salient-secret-value';

    const result = await engine.observeGroupMessage({
      groupSpaceId: group.id,
      externalMessageId: 'chatter-1',
      actorId: 'alice',
      text: `Nice weather outside, api_key=${secret}`,
      occurredAt: FIXED_TIME.toISOString(),
    });

    expect(result).toMatchObject({
      observed: true,
      duplicate: false,
      assessment: { salient: false },
      redactions: 1,
    });
    expect(result.messageId).toBeUndefined();
    expect(storage.listGroupMessages(group.id)).toEqual([]);
    expect(storage.listMemories('workspace-private')).toEqual([]);
    expect(embedding.calls).toEqual([]);
    expect(storage.db.prepare(`SELECT COUNT(*) AS count FROM learning_signals
      WHERE workspace_id = ?`).get('workspace-private')).toMatchObject({ count: 0 });
    expect(JSON.stringify(storage.db.prepare('SELECT * FROM group_messages').all())).not.toContain(secret);
  });

  it('purges memories by source occurrence time before deleting their source messages', async () => {
    const group = storage.upsertGroupSpace({
      workspaceId: 'workspace-retention',
      source: 'telegram',
      externalId: 'chat-retention',
      learningEnabled: true,
      notificationsEnabled: false,
      createdBy: 'admin-retention',
    });
    const engine = new MemoryEngine({ storage, embedding: new FakeEmbedding() });
    const observed = await engine.observeGroupMessage({
      groupSpaceId: group.id,
      externalMessageId: 'historical-message',
      actorId: 'alice',
      text: 'Important: we agreed to ship the retained project decision by 2000-01-02.',
      occurredAt: '2000-01-01T00:00:00.000Z',
    });
    expect(observed.memory).toBeDefined();

    const purged = engine.purgeExpired({
      asOf: new Date(),
      retentionDays: 1,
      workspaceId: 'workspace-retention',
    });

    expect(purged).toMatchObject({
      messagesDeleted: 1,
      memoriesDeleted: 1,
      signalsDeleted: 1,
    });
    expect(storage.listGroupMessages(group.id)).toEqual([]);
    expect(storage.listMemories('workspace-retention')).toEqual([]);
  });

  it('forgets already-orphaned group memories using retained learning provenance', async () => {
    const group = storage.upsertGroupSpace({
      workspaceId: 'workspace-orphan',
      source: 'telegram',
      externalId: 'chat-orphan',
      learningEnabled: true,
      notificationsEnabled: false,
      createdBy: 'admin-orphan',
    });
    const engine = new MemoryEngine({ storage, embedding: new FakeEmbedding() });
    const observed = await engine.observeGroupMessage({
      groupSpaceId: group.id,
      externalMessageId: 'orphan-source',
      actorId: 'alice',
      text: 'Important: we agreed that Alice will deliver by 2000-01-02.',
      occurredAt: '2000-01-01T00:00:00.000Z',
    });
    expect(observed.messageId).toBeDefined();
    expect(observed.memory).toBeDefined();

    storage.db.prepare(`UPDATE learning_signals SET memory_id = NULL,
      metadata_json = json_remove(metadata_json, '$.memoryId')
      WHERE kind = 'group_observation'`).run();
    storage.db.prepare('DELETE FROM group_messages WHERE id = ?').run(observed.messageId!);

    const forgotten = storage.forgetGroupData(group.id);
    expect(forgotten).toMatchObject({
      messagesDeleted: 0,
      memoriesDeleted: 1,
      signalsDeleted: 1,
      bindingRetainedDisabled: true,
    });
    expect(storage.listMemories('workspace-orphan')).toEqual([]);
  });
});

describe('MemoryEngine retrieval', () => {
  it('ranks embeddings only inside the requested scope and falls back to scoped lexical retrieval', async () => {
    const vectorFor = (text: string): number[] =>
      text.includes('semantic-query') || text.includes('semantic-neighbor') ? [1, 0] : [0, 1];
    const embedding = new FakeEmbedding('scope-embedding-v1', vectorFor);
    const engine = new MemoryEngine({ storage, embedding, clock: () => FIXED_TIME });

    const target = putActiveMemory({
      workspaceId: 'workspace-a',
      projectId: 'project-a',
      actorId: 'alice',
      content: 'semantic-neighbor target with no lexical query term',
      sourceId: 'target',
    });
    const workspaceGlobal = putActiveMemory({
      workspaceId: 'workspace-a',
      content: 'global orthogonal context',
      sourceId: 'global',
    });
    const siblingProject = putActiveMemory({
      workspaceId: 'workspace-a',
      projectId: 'project-b',
      actorId: 'alice',
      content: 'semantic-neighbor sibling project',
      sourceId: 'sibling-project',
    });
    const otherActor = putActiveMemory({
      workspaceId: 'workspace-a',
      projectId: 'project-a',
      actorId: 'bob',
      content: 'semantic-neighbor private to bob',
      sourceId: 'other-actor',
    });
    const otherWorkspace = putActiveMemory({
      workspaceId: 'workspace-b',
      projectId: 'project-a',
      actorId: 'alice',
      content: 'semantic-neighbor in another tenant',
      sourceId: 'other-workspace',
    });
    for (const memory of [target, workspaceGlobal, siblingProject, otherActor, otherWorkspace]) {
      await engine.embedMemory(memory.id);
    }

    const hybrid = await engine.search(
      { workspaceId: 'workspace-a', projectId: 'project-a', actorId: 'alice' },
      'semantic-query',
      { limit: 10 },
    );
    expect(hybrid.mode).toBe('hybrid');
    expect(hybrid.memories.map((memory) => memory.id)).toEqual([target.id]);
    expect(hybrid.memories.map((memory) => memory.id)).not.toContain(siblingProject.id);
    expect(hybrid.memories.map((memory) => memory.id)).not.toContain(otherActor.id);
    expect(hybrid.memories.map((memory) => memory.id)).not.toContain(otherWorkspace.id);

    const lexicalTarget = putActiveMemory({
      workspaceId: 'workspace-a',
      projectId: 'project-a',
      actorId: 'alice',
      content: 'The exact lexical-fallback-marker belongs to Alice.',
      sourceId: 'lexical-target',
    });
    const lexicalWrongScope = putActiveMemory({
      workspaceId: 'workspace-b',
      projectId: 'project-a',
      actorId: 'alice',
      content: 'lexical-fallback-marker in another workspace',
      sourceId: 'lexical-wrong-workspace',
    });
    const fallbackEngine = new MemoryEngine({
      storage,
      embedding: new FailingEmbedding(),
      clock: () => FIXED_TIME,
    });
    const fallback = await fallbackEngine.search(
      { workspaceId: 'workspace-a', projectId: 'project-a', actorId: 'alice' },
      'lexical-fallback-marker',
      { limit: 10 },
    );

    expect(fallback).toMatchObject({
      mode: 'lexical_fallback',
      embeddingError: 'local embedder offline',
    });
    expect(fallback.memories[0]?.id).toBe(lexicalTarget.id);
    expect(fallback.memories.map((memory) => memory.id)).not.toContain(lexicalWrongScope.id);
    expect(fallback.memories.every((memory) =>
      memory.workspaceId === 'workspace-a' &&
      (memory.projectId === undefined || memory.projectId === 'project-a') &&
      (memory.actorId === undefined || memory.actorId === 'alice'),
    )).toBe(true);
  });

  it('does not turn tokenless queries into match-all retrieval', async () => {
    const memory = putActiveMemory({
      workspaceId: 'workspace-tokenless',
      projectId: 'project-tokenless',
      actorId: 'alice',
      content: 'Unrelated retained project context.',
      sourceId: 'tokenless-unrelated',
    });
    storage.putMemoryEmbedding(memory.id, 'tokenless-model-v1', [1, 0]);
    const scope = {
      workspaceId: 'workspace-tokenless',
      projectId: 'project-tokenless',
      actorId: 'alice',
    };

    expect(storage.searchMemories(scope, '🙂', 10)).toEqual([]);
    expect(storage.searchMemoriesHybrid(scope, '🙂', [0, 1], 'tokenless-model-v1', 10)).toEqual([]);
  });

  it('binds query caching and run attribution to the complete scope', async () => {
    const embedding = new FakeEmbedding('scoped-query-cache-v1');
    const engine = new MemoryEngine({ storage, embedding, clock: () => FIXED_TIME });
    const run = createTerminalRun({
      workspaceId: 'workspace-cache-a',
      actorId: 'alice',
      projectId: 'project-a',
      input: 'Find the owner.',
      output: 'Done.',
    });

    await engine.search(
      { workspaceId: 'workspace-cache-a', projectId: 'project-a', actorId: 'alice' },
      'release owner',
      { runId: run.id },
    );
    await engine.search(
      { workspaceId: 'workspace-cache-a', projectId: 'project-a', actorId: 'alice' },
      'release owner',
      { runId: run.id },
    );
    await engine.search(
      { workspaceId: 'workspace-cache-b', projectId: 'project-a', actorId: 'alice' },
      'release owner',
    );

    expect(embedding.calls).toHaveLength(2);
    await expect(engine.search(
      { workspaceId: 'workspace-cache-a', projectId: 'project-b', actorId: 'alice' },
      'release owner',
      { runId: run.id },
    )).rejects.toThrow('must match the run project and actor');
    await expect(engine.search(
      { workspaceId: 'workspace-cache-a', projectId: 'project-a', actorId: 'mallory' },
      'release owner',
      { runId: run.id },
    )).rejects.toThrow('must match the run project and actor');
    await expect(engine.search(
      { workspaceId: 'workspace-cache-a', projectId: 'project-a', actorId: 'alice' },
      '   ',
    )).rejects.toThrow('query must not be empty');
    expect(embedding.calls).toHaveLength(2);
  });

  it('attributes only active memories visible to the exact run scope, atomically', () => {
    const run = createTerminalRun({
      workspaceId: 'workspace-usage',
      actorId: 'alice',
      projectId: 'project-a',
      input: 'Use only visible memory.',
      output: 'Done.',
    });
    const global = putActiveMemory({
      workspaceId: 'workspace-usage',
      content: 'Workspace-visible context.',
      sourceId: 'usage-global',
    });
    const exact = putActiveMemory({
      workspaceId: 'workspace-usage',
      projectId: 'project-a',
      actorId: 'alice',
      content: 'Exact-scope context.',
      sourceId: 'usage-exact',
    });
    const otherWorkspace = putActiveMemory({
      workspaceId: 'workspace-other',
      projectId: 'project-a',
      actorId: 'alice',
      content: 'Cross-workspace context.',
      sourceId: 'usage-other-workspace',
    });
    const inactive = storage.putMemory({
      workspaceId: 'workspace-usage',
      projectId: 'project-a',
      actorId: 'alice',
      kind: 'semantic',
      content: 'Unreviewed context.',
      importance: 0.5,
      sourceType: 'test',
      sourceId: 'usage-inactive',
      status: 'proposed',
    });

    expect(() => storage.recordMemoryUsage(run.id, [global.id, otherWorkspace.id]))
      .toThrow('outside the run visibility scope');
    expect(storage.getMemory(global.id).accessCount).toBe(0);
    expect(storage.db.prepare('SELECT COUNT(*) AS count FROM run_memory_usage WHERE run_id = ?')
      .get(run.id)).toMatchObject({ count: 0 });
    expect(() => storage.recordMemoryUsage(run.id, [inactive.id]))
      .toThrow('outside the run visibility scope');

    storage.recordMemoryUsage(run.id, [global.id, exact.id]);
    storage.recordMemoryUsage(run.id, [global.id, exact.id]);
    expect(storage.getMemory(global.id).accessCount).toBe(1);
    expect(storage.getMemory(exact.id).accessCount).toBe(1);
    expect(storage.db.prepare('SELECT COUNT(*) AS count FROM run_memory_usage WHERE run_id = ?')
      .get(run.id)).toMatchObject({ count: 2 });
  });
});

describe('MemoryEngine feedback reinforcement', () => {
  it('applies a feedback ID once and lowers strength without rewriting memory content', () => {
    const engine = new MemoryEngine({
      storage,
      embedding: new FakeEmbedding(),
      feedbackLearningRate: 0.2,
      clock: () => FIXED_TIME,
    });
    const originalContent = 'Alice owns the release checklist; preserve this exact evidence.';
    const memory = storage.putMemory({
      workspaceId: 'workspace-a',
      projectId: 'project-a',
      actorId: 'alice',
      kind: 'semantic',
      content: originalContent,
      importance: 0.6,
      strength: 0.6,
      sourceType: 'test',
      sourceId: 'reinforcement-memory',
      status: 'active',
    });
    const run = createTerminalRun({
      workspaceId: 'workspace-a',
      actorId: 'alice',
      projectId: 'project-a',
      input: 'Who owns the release checklist?',
      output: 'Alice owns it.',
    });
    storage.recordMemoryUsage(run.id, [memory.id]);
    const feedback = storage.addFeedback({
      runId: run.id,
      actorId: 'alice',
      reaction: 'thumbs_down',
      score: -1,
      dimensions: { grounded: -1 },
      comment: 'This memory should rank lower.',
    });

    const first = engine.applyFeedback(feedback.id, 0.2);
    const afterFirst = storage.getMemory(memory.id);
    const replay = engine.applyFeedback(feedback.id, 0.2);
    const afterReplay = storage.getMemory(memory.id);

    expect(first).toMatchObject({
      feedbackId: feedback.id,
      runId: run.id,
      reward: -1,
      appliedMemoryIds: [memory.id],
      alreadyAppliedMemoryIds: [],
    });
    expect(replay).toMatchObject({
      feedbackId: feedback.id,
      appliedMemoryIds: [],
      alreadyAppliedMemoryIds: [memory.id],
    });
    expect(afterFirst.strength).toBeCloseTo(0.55, 8);
    expect(afterFirst.reward).toBeCloseTo(-0.2, 8);
    expect(afterReplay.strength).toBe(afterFirst.strength);
    expect(afterReplay.reward).toBe(afterFirst.reward);
    expect(afterReplay.content).toBe(originalContent);
    expect(sqlCount('memory_feedback_applications', 'feedback_id', feedback.id)).toBe(1);
    expect(sqlCount('learning_signals', 'memory_id', memory.id)).toBe(1);
  });

  it('keeps the first feedback per run and actor and rejects invalid rewards', () => {
    const run = createTerminalRun({
      workspaceId: 'workspace-feedback',
      actorId: 'alice',
      projectId: 'project-feedback',
      input: 'Review this answer.',
      output: 'Answer.',
    });
    const first = storage.addFeedback({
      runId: run.id,
      actorId: 'alice',
      reaction: 'up',
      score: 0.75,
      dimensions: { helpfulness: 0.75 },
      comment: 'Keep this first review.',
    });
    const replay = storage.addFeedback({
      runId: run.id,
      actorId: 'alice',
      reaction: 'down',
      score: -1,
      dimensions: { helpfulness: -1 },
      comment: 'This later write must not replace the first.',
    });

    expect(replay).toEqual(first);
    expect(storage.findFeedback(run.id, 'alice')).toEqual(first);
    expect(storage.listFeedback(run.id)).toEqual([first]);

    for (const score of [Number.NaN, Number.POSITIVE_INFINITY, -1.01, 1.01]) {
      expect(() => storage.addFeedback({
        runId: run.id,
        actorId: `reviewer-${String(score)}`,
        score,
        dimensions: {},
      })).toThrow('Feedback score must be finite and between -1 and 1');
    }
    expect(() => storage.addFeedback({
      runId: run.id,
      actorId: 'dimension-reviewer',
      score: 0,
      dimensions: { safety: Number.NaN },
    })).toThrow('Feedback dimension safety must be finite and between -1 and 1');
    expect(() => storage.addFeedback({
      runId: run.id,
      actorId: 'range-reviewer',
      score: 0,
      dimensions: { safety: 1.01 },
    })).toThrow('Feedback dimension safety must be finite and between -1 and 1');
    for (const actorId of ['', ' reviewer ', `reviewer-${'x'.repeat(257)}`, 'reviewer\nadmin']) {
      expect(() => storage.addFeedback({
        runId: run.id,
        actorId,
        score: 0,
        dimensions: {},
      })).toThrow('Feedback actor ID');
    }
    expect(() => storage.addFeedback({
      runId: run.id,
      actorId: 'unsafe-dimension-reviewer',
      score: 0,
      dimensions: { 'unsafe key': 0 },
    })).toThrow('Feedback dimension names');
    expect(() => storage.addFeedback({
      runId: run.id,
      actorId: 'too-many-dimensions-reviewer',
      score: 0,
      dimensions: Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`d${index}`, 0])),
    })).toThrow('32-dimension limit');
    expect(() => storage.addFeedback({
      runId: run.id,
      actorId: 'reaction-reviewer',
      reaction: 'x'.repeat(65),
      score: 0,
      dimensions: {},
    })).toThrow('Feedback reaction');
    expect(() => storage.addFeedback({
      runId: run.id,
      actorId: 'comment-reviewer',
      score: 0,
      dimensions: {},
      comment: 'x'.repeat(4_097),
    })).toThrow('Feedback comment');
    expect(() => storage.addFeedback({
      runId: run.id,
      actorId: 'correction-reviewer',
      score: 0,
      dimensions: {},
      correction: 'x'.repeat(8_193),
    })).toThrow('Feedback correction');
  });

  it('keeps adaptive route rewards and reliability inside the run workspace', () => {
    const workspaceA = createTerminalRun({
      workspaceId: 'workspace-a',
      actorId: 'alice',
      projectId: 'project-a',
      input: 'Summarize A',
      output: 'A',
    });
    const workspaceB = createTerminalRun({
      workspaceId: 'workspace-b',
      actorId: 'bob',
      projectId: 'project-b',
      input: 'Summarize B',
      output: 'B',
    });
    const selection = {
      routeId: 'shared-cloud-route',
      provider: 'openai-compatible',
      model: 'fixture-model',
      local: false,
      task: 'summarization' as const,
      reason: 'test',
      estimatedCostUsd: 0.01,
    };
    storage.recordModelRouteCall({
      runId: workspaceA.id,
      selection,
      statsRouteId: 'shared-cloud-route@generation-1',
      success: true,
      costUsd: 0.01,
      latencyMs: 10,
    });
    storage.recordModelRouteCall({
      runId: workspaceB.id,
      selection,
      statsRouteId: 'shared-cloud-route@generation-1',
      success: false,
      costUsd: 0.01,
      latencyMs: 20,
    });
    const feedback = storage.addFeedback({
      runId: workspaceA.id,
      actorId: 'alice',
      score: 1,
      dimensions: { helpfulness: 1 },
    });
    expect(storage.reinforceRunRoutes(workspaceA.id, 'workspace-a', 1, feedback.id))
      .toEqual(['shared-cloud-route@generation-1']);
    expect(storage.reinforceRunRoutes(workspaceA.id, 'workspace-a', 1, feedback.id)).toEqual([]);

    expect(storage.modelRouteStats('summarization', workspaceA.id)).toMatchObject([{
      routeId: 'shared-cloud-route@generation-1',
      attempts: 1,
      successes: 1,
      rewardSum: 1,
      rewardCount: 1,
    }]);
    expect(storage.modelRouteStats('summarization', workspaceB.id)).toMatchObject([{
      routeId: 'shared-cloud-route@generation-1',
      attempts: 1,
      successes: 0,
      rewardSum: 0,
      rewardCount: 0,
    }]);
    expect(storage.modelRouteStats('summarization', workspaceA.id, ['stale-generation'])).toEqual([]);
    expect(storage.modelRouteStats(
      'summarization',
      workspaceA.id,
      ['shared-cloud-route@generation-1'],
    )).toHaveLength(1);
    expect(storage.db.prepare(`SELECT COUNT(*) AS count FROM route_feedback_applications
      WHERE feedback_id = ?`).get(feedback.id)).toMatchObject({ count: 1 });
  });
});

describe('learning dataset export', () => {
  it('deterministically exports redacted reward, SFT, and preference rows with verifiable hashes', () => {
    const run = createTerminalRun({
      workspaceId: 'workspace-a',
      actorId: 'alice',
      projectId: 'project-a',
      input: 'Deploy using api_key=abcdefghijklmnop by Friday.',
      output: 'Bad response exposed Bearer abcdefghijklmnop in the answer.',
    });
    const feedback = storage.addFeedback({
      runId: run.id,
      actorId: 'alice',
      reaction: 'thumbs_down',
      score: -0.8,
      dimensions: { safety: -1, grounded: -0.5 },
      comment: 'Reviewer secret=supersecretvalue',
      correction: 'Use password=correcthorse and do not expose credentials.',
    });
    const options = { generatedAt: '2026-08-25T12:34:56+04:00' };

    const first = exportLearningDatasets(storage, options);
    const replay = exportLearningDatasets(storage, options);

    expect(replay).toEqual(first);
    expect(first.manifest).toMatchObject({
      schemaVersion: 'openprojects.learning-export.v1',
      generatedAt: '2026-08-25T08:34:56.000Z',
      sourceFeedbackCount: 1,
      exportedRowCount: 3,
      skipped: {
        rewardMissingResponse: 0,
        sftMissingCorrection: 0,
        preferenceInsufficient: 0,
        duplicateRows: 0,
      },
    });
    expect(first.manifest.redactionCount).toBeGreaterThanOrEqual(4);
    expect(first.datasets.map((dataset) => dataset.kind)).toEqual(['rewards', 'sft', 'preferences']);

    const reward = parseArtifact<RewardDatasetRow>(artifact(first.datasets, 'rewards'))[0]!;
    const sft = parseArtifact<SftDatasetRow>(artifact(first.datasets, 'sft'))[0]!;
    const preference = parseArtifact<PreferenceDatasetRow>(artifact(first.datasets, 'preferences'))[0]!;
    expect(reward).toMatchObject({
      schema: 'openprojects.reward.v1',
      feedbackId: feedback.id,
      reward: -0.8,
      dimensions: { grounded: -0.5, safety: -1 },
    });
    expect(reward.prompt).toContain('[REDACTED:SECRET]');
    expect(reward.response).toContain('Bearer [REDACTED:TOKEN]');
    expect(reward.comment).toContain('[REDACTED:SECRET]');
    expect(sft.response).toContain('password=[REDACTED:SECRET]');
    expect(preference.chosen).toBe(sft.response);
    expect(preference.rejected).toBe(reward.response);

    const serialized = JSON.stringify(first);
    for (const secret of [
      'abcdefghijklmnop',
      'supersecretvalue',
      'correcthorse',
    ]) {
      expect(serialized).not.toContain(secret);
    }
    for (const dataset of first.datasets) {
      expect(dataset.sha256).toBe(sha256(dataset.jsonl));
    }
    const { sha256: manifestHash, ...manifestCore } = first.manifest;
    expect(manifestHash).toBe(sha256(stableStringify(manifestCore)));
  });

  it('redacts and bounds untrusted feedback dimension keys', () => {
    const run = createTerminalRun({
      workspaceId: 'workspace-dimensions',
      actorId: 'alice',
      projectId: 'project-dimensions',
      input: 'Review this response.',
      output: 'A response to score.',
    });
    const dimensionSecret = 'dimensionsecretvalue';
    const feedback = storage.addFeedback({
      runId: run.id,
      actorId: 'alice',
      score: -0.5,
      dimensions: { safety: -1 },
    });
    storage.db.prepare('UPDATE feedback SET dimensions_json = ? WHERE id = ?').run(JSON.stringify({
      safety: -1,
      [`api_key=${dimensionSecret}`]: -0.5,
      [`very long metric ${'x'.repeat(200)}`]: 0.25,
    }), feedback.id);

    const exported = exportLearningDatasets(storage, {
      kinds: ['rewards'],
      generatedAt: FIXED_TIME.toISOString(),
    });
    const reward = parseArtifact<RewardDatasetRow>(artifact(exported.datasets, 'rewards'))[0]!;
    const keys = Object.keys(reward.dimensions);

    expect(JSON.stringify(exported)).not.toContain(dimensionSecret);
    expect(keys).toContain('safety');
    expect(keys.every((key) => key.length > 0 && key.length <= 64)).toBe(true);
    expect(keys.every((key) => /^[A-Za-z0-9_.:-]+$/u.test(key))).toBe(true);
    expect(exported.manifest.redactionCount).toBeGreaterThanOrEqual(1);
  });

  it('requires strictly negative feedback before emitting a preference pair', () => {
    const run = createTerminalRun({
      workspaceId: 'workspace-neutral',
      actorId: 'alice',
      projectId: 'project-neutral',
      input: 'Give an answer.',
      output: 'Original answer.',
    });
    storage.addFeedback({
      runId: run.id,
      actorId: 'alice',
      score: 0,
      dimensions: {},
      correction: 'Different corrected answer.',
    });

    const exported = exportLearningDatasets(storage, {
      kinds: ['preferences'],
      generatedAt: FIXED_TIME.toISOString(),
    });

    expect(artifact(exported.datasets, 'preferences').rowCount).toBe(0);
    expect(exported.manifest.skipped.preferenceInsufficient).toBe(1);
  });

  it('serves legacy feedback exports through the redacted reward exporter', async () => {
    const app = await createApp({
      configPath: 'openprojects.config.yaml',
      databasePath: ':memory:',
      seedDemo: false,
    });
    app.config.server.port = 0;
    if (app.config.notifications) app.config.notifications.enabled = false;
    let started: Awaited<ReturnType<typeof startServer>> | undefined;
    try {
      const run = createTerminalRun({
        workspaceId: 'workspace-legacy',
        actorId: 'alice',
        projectId: 'project-legacy',
        input: 'Use api_key=legacyinputsecret to answer.',
        output: 'Bearer legacyoutputsecretvalue was exposed.',
      }, app.storage);
      const feedback = app.storage.addFeedback({
        runId: run.id,
        actorId: 'alice',
        score: -1,
        dimensions: { safety: -1 },
        comment: 'password=legacycommentsecret',
        correction: 'Use secret=legacycorrectionsecret safely.',
      });
      app.storage.db.prepare('UPDATE feedback SET dimensions_json = ? WHERE id = ?')
        .run(JSON.stringify({ 'api_key=legacydimensionsecret': -1 }), feedback.id);
      started = await startServer(app);

      const response = await fetch(`${started.url}/api/feedback/export?format=jsonl`);
      const body = await response.text();
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('application/x-ndjson');
      for (const secret of [
        'legacyinputsecret',
        'legacyoutputsecretvalue',
        'legacydimensionsecret',
        'legacycommentsecret',
        'legacycorrectionsecret',
      ]) {
        expect(body).not.toContain(secret);
      }
      const row = JSON.parse(body.trim()) as Record<string, unknown>;
      expect(row.schema).toBe('openprojects.reward.v1');
      expect(row).not.toHaveProperty('comment');

      const jsonResponse = await fetch(`${started.url}/api/feedback/export`);
      const jsonBody = await jsonResponse.text();
      expect(jsonResponse.status).toBe(200);
      expect(jsonBody).not.toContain('legacyinputsecret');
      expect(JSON.parse(jsonBody)).toMatchObject({
        manifest: { schemaVersion: 'openprojects.learning-export.v1' },
      });
    } finally {
      await started?.close();
      await app.close();
    }
  });
});

function putActiveMemory(input: {
  workspaceId: string;
  projectId?: string;
  actorId?: string;
  content: string;
  sourceId: string;
}): MemoryRecord {
  return storage.putMemory({
    workspaceId: input.workspaceId,
    ...(input.projectId ? { projectId: input.projectId } : {}),
    ...(input.actorId ? { actorId: input.actorId } : {}),
    kind: 'semantic',
    content: input.content,
    importance: 0.5,
    strength: 0.5,
    sourceType: 'test',
    sourceId: input.sourceId,
    status: 'active',
  });
}

function createTerminalRun(input: {
  workspaceId: string;
  actorId: string;
  projectId: string;
  input: string;
  output: string;
}, targetStorage: SqliteStorage = storage): RunRecord {
  const session = targetStorage.createSession({
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    channel: 'test',
  });
  const run = targetStorage.createRun({
    sessionId: session.id,
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    projectId: input.projectId,
    agentId: 'test-agent',
    agentVersion: '1.0.0',
    input: input.input,
  });
  targetStorage.transitionRun(run.id, ['queued'], 'running');
  return targetStorage.transitionRun(run.id, ['running'], 'succeeded', { output: input.output });
}

function sqlCount(table: string, column: string, value: string): number {
  const allowed = new Set([
    'memory_feedback_applications:feedback_id',
    'learning_signals:memory_id',
  ]);
  if (!allowed.has(`${table}:${column}`)) throw new Error('Unexpected count query');
  const row = storage.db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${column} = ?`)
    .get(value) as Record<string, unknown>;
  if (typeof row.count !== 'number') throw new Error('Expected a numeric count');
  return row.count;
}

function artifact(
  datasets: LearningDatasetArtifact[],
  kind: LearningDatasetArtifact['kind'],
): LearningDatasetArtifact {
  const found = datasets.find((dataset) => dataset.kind === kind);
  if (!found) throw new Error(`Missing ${kind} dataset`);
  return found;
}

function parseArtifact<T>(value: LearningDatasetArtifact): T[] {
  return value.jsonl.trim()
    ? value.jsonl.trimEnd().split('\n').map((line) => JSON.parse(line) as T)
    : [];
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entryValue]) => [key, sortJson(entryValue)]),
  );
}
