import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import { createApp, type OpenProjectsApp } from '../src/app.js';
import type {
  AgentDefinition,
  AppConfig,
  JsonObject,
  RunSnapshotDocument,
  SkillDefinition,
  ToolDefinition,
} from '../src/core/types.js';
import {
  canonicalSnapshotJson,
  captureRunSnapshots,
  createRunSnapshot,
  sha256Json,
  verifyRunSnapshot,
} from '../src/runtime/run-snapshots.js';
import { AgentRuntime } from '../src/runtime/agent.js';
import { SqliteStorage } from '../src/storage/sqlite.js';

const openApps = new Set<OpenProjectsApp>();
const temporaryDirectories = new Set<string>();

afterEach(async () => {
  for (const app of openApps) await app.close();
  openApps.clear();
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
  temporaryDirectories.clear();
});

describe('run snapshot canonical JSON', () => {
  it('is recursively key-order stable and content addresses the canonical representation', () => {
    const left = { z: 3, a: { y: [true, { b: 2, a: 1 }], x: 'ok' } };
    const right = { a: { x: 'ok', y: [true, { a: 1, b: 2 }] }, z: 3 };

    expect(canonicalSnapshotJson(left)).toBe('{"a":{"x":"ok","y":[true,{"a":1,"b":2}]},"z":3}');
    expect(canonicalSnapshotJson(right)).toBe(canonicalSnapshotJson(left));
    expect(sha256Json(right)).toBe(sha256Json(left));
  });

  it('fails closed on values outside its documented strict JSON subset', () => {
    expect(() => canonicalSnapshotJson(-0)).toThrow('negative zero');
    expect(() => canonicalSnapshotJson(Number.NaN)).toThrow('finite');
    expect(() => canonicalSnapshotJson(Number.MAX_SAFE_INTEGER + 1)).toThrow('safe integers');
    expect(() => canonicalSnapshotJson('\ud800')).toThrow('unpaired surrogates');
    expect(() => canonicalSnapshotJson([, 1])).toThrow('sparse arrays');
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalSnapshotJson(cyclic)).toThrow('cycles');
  });
});

describe('redacted content-addressed run commitments', () => {
  it('binds prompts, skills, tool contracts, grants, budgets, guards and policy without storing bodies', () => {
    const first = fixtureCapture();
    const serialized = JSON.stringify(first);
    expect(serialized).not.toContain('SYSTEM-SECRET-ALPHA');
    expect(serialized).not.toContain('SKILL-SECRET-BETA');
    expect(serialized).not.toContain('TOOL-SCHEMA-SECRET-GAMMA');

    const reordered = fixtureCapture({ reorder: true });
    expect(digests(reordered)).toEqual(digests(first));

    const promptChanged = fixtureCapture({ system: 'different prompt' });
    expect(promptChanged.agent.digest).not.toBe(first.agent.digest);
    expect(promptChanged.tools.digest).toBe(first.tools.digest);
    expect(promptChanged.policy.digest).toBe(first.policy.digest);

    const schemaChanged = fixtureCapture({ schemaConst: 'changed schema' });
    expect(schemaChanged.agent.digest).toBe(first.agent.digest);
    expect(schemaChanged.tools.digest).not.toBe(first.tools.digest);
    expect(schemaChanged.policy.digest).toBe(first.policy.digest);

    const bindingChanged = fixtureCapture({ maxResponseBytes: 32_000 });
    expect(bindingChanged.tools.digest).not.toBe(first.tools.digest);

    const policyChanged = fixtureCapture({ externalWrite: 'deny' });
    expect(policyChanged.agent.digest).toBe(first.agent.digest);
    expect(policyChanged.tools.digest).toBe(first.tools.digest);
    expect(policyChanged.policy.digest).not.toBe(first.policy.digest);
  });

  it('detects envelope tampering before storage', () => {
    const snapshot = createRunSnapshot('agent', { id: 'agent-a' });
    const tampered = {
      ...snapshot,
      content: { id: 'agent-b' },
    } as RunSnapshotDocument;
    expect(() => verifyRunSnapshot(tampered)).toThrow('digest mismatch');
  });
});

describe('durable run snapshot bindings', () => {
  it('binds even direct compatibility allocations and deduplicates immutable documents', () => {
    const storage = new SqliteStorage(':memory:');
    try {
      const session = storage.createSession({ workspaceId: 'local', actorId: 'alice', channel: 'test' });
      const first = storage.createRun({
        sessionId: session.id,
        workspaceId: 'local',
        actorId: 'alice',
        agentId: 'legacy-caller',
        agentVersion: '1.0.0',
        input: 'first',
      });
      const second = storage.createRun({
        sessionId: session.id,
        workspaceId: 'local',
        actorId: 'alice',
        agentId: 'legacy-caller',
        agentVersion: '1.0.0',
        input: 'second',
      });

      expect(first.snapshots).toEqual(second.snapshots);
      expect(first.snapshots).toEqual({
        agent: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
        tools: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
        policy: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      });
      expect(storage.getRunSnapshots(first.id)?.agent.content).toMatchObject({
        capture: 'compatibility',
        complete: false,
      });
      const count = storage.db.prepare('SELECT COUNT(*) AS count FROM run_snapshot_documents').get() as { count: number };
      expect(count.count).toBe(3);
    } finally {
      storage.close();
    }
  });

  it('migrates legacy rows as explicitly unbound while snapshotting every later allocation', () => {
    const directory = mkdtempSync(join(tmpdir(), 'openprojects-snapshot-migration-'));
    temporaryDirectories.add(directory);
    const databasePath = join(directory, 'legacy.db');
    createLegacyRunDatabase(databasePath);

    const storage = new SqliteStorage(databasePath);
    try {
      expect(storage.getRun('legacy-run').snapshots).toBeUndefined();
      expect(storage.getRunSnapshots('legacy-run')).toBeUndefined();
      const next = storage.createRun({
        sessionId: 'legacy-session',
        workspaceId: 'local',
        actorId: 'alice',
        agentId: 'legacy-agent',
        agentVersion: '1.0.0',
        input: 'new run after migration',
      });
      expect(next.snapshots).toBeDefined();
      expect(storage.getRunSnapshots(next.id)?.policy.content).toMatchObject({ complete: false });
    } finally {
      storage.close();
    }
  });

  it('records complete identities on the run and run.created trace without prompt leakage', async () => {
    const config = appConfig();
    const app = await createApp({ config, databasePath: ':memory:', skills: [], seedDemo: true });
    openApps.add(app);
    const outcome = await app.runtime.start({
      message: 'Give a concise project update.',
      workspaceId: 'local',
      actorId: 'alice',
      projectId: 'project-atlas',
      channel: 'test',
    });

    expect(outcome.run.snapshots).toBeDefined();
    const created = outcome.events.find((event) => event.type === 'run.created');
    expect(asObject(created?.data).snapshots).toEqual(outcome.run.snapshots);
    const stored = app.storage.getRunSnapshots(outcome.run.id)!;
    expect(stored.agent.content).toMatchObject({ capture: 'complete' });
    expect(stored.tools.content).toMatchObject({ capture: 'complete' });
    expect(stored.policy.content).toMatchObject({ capture: 'complete' });
    const durableText = (app.storage.db.prepare(
      'SELECT group_concat(canonical_json, ?) AS value FROM run_snapshot_documents',
    ).get('\n') as { value: string }).value;
    expect(durableText).not.toContain(config.agent.system!);
  });

  it('fails closed when recovery would resume under a changed agent commitment', async () => {
    const config = appConfig();
    const app = await createApp({ config, databasePath: ':memory:', skills: [] });
    openApps.add(app);
    const agent = { ...app.config.agent, system: app.config.agent.system ?? '' };
    const session = app.storage.createSession({ workspaceId: 'local', actorId: 'alice', channel: 'test' });
    const run = app.storage.createRun({
      sessionId: session.id,
      workspaceId: 'local',
      actorId: 'alice',
      agentId: agent.id,
      agentVersion: agent.version,
      input: 'recover me only under the same contract',
      snapshots: captureRunSnapshots({
        agent,
        runtimeProfile: { task: 'supervisor', retrieveMemory: true, maxModelAttempts: 2 },
        skills: app.skills,
        tools: [],
        policy: app.config.policy,
        policyGuards: app.kernel.listToolGuardPlugins(),
      }),
    });
    app.storage.transitionRun(run.id, ['queued'], 'running');
    const changedConfig: AppConfig = {
      ...app.config,
      agent: { ...app.config.agent, system: 'a changed system contract under the same nominal version' },
    };
    const restarted = new AgentRuntime(changedConfig, app.kernel, app.storage, app.skills, app.memoryEngine);

    const recovered = await restarted.recover();
    expect(recovered).toHaveLength(1);
    expect(app.storage.getRun(run.id)).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('[snapshot_mismatch]'),
    });
    expect(recovered[0]!.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'run.recovery.failed',
        data: expect.objectContaining({ reason: 'snapshot_mismatch', toolExecutionResumed: false }),
      }),
    ]));
  });
});

function fixtureCapture(options: {
  reorder?: boolean;
  system?: string;
  schemaConst?: string;
  externalWrite?: 'allow' | 'ask' | 'deny';
  maxResponseBytes?: number;
} = {}) {
  const agent: AgentDefinition = {
    id: 'agent-a',
    version: '1.2.3',
    name: 'Agent A',
    system: options.system ?? 'SYSTEM-SECRET-ALPHA',
    skills: options.reorder ? ['skill-b', 'skill-a'] : ['skill-a', 'skill-b'],
    tools: options.reorder ? ['tool-b', 'tool-a'] : ['tool-a', 'tool-b'],
    budgets: {
      maxSteps: 4,
      maxToolCalls: 3,
      maxWallTimeMs: 10_000,
      maxInputTokens: 2_000,
      reservedOutputTokens: 500,
    },
  };
  const skills: SkillDefinition[] = [
    {
      id: 'skill-a', version: '1', name: 'Skill A', description: 'A', tools: ['tool-a'],
      instructions: 'SKILL-SECRET-BETA', evaluators: ['grounding'],
    },
    {
      id: 'skill-b', version: '2', name: 'Skill B', description: 'B', tools: ['tool-b'],
      instructions: 'other private instructions', evaluators: [],
    },
  ];
  const tools = [
    tool('tool-a', options.schemaConst ?? 'TOOL-SCHEMA-SECRET-GAMMA', options.maxResponseBytes ?? 16_000),
    tool('tool-b', 'safe', 16_000),
  ];
  return captureRunSnapshots({
    agent,
    skills: options.reorder ? [...skills].reverse() : skills,
    tools: options.reorder ? [...tools].reverse() : tools,
    policy: {
      read: 'allow',
      draft: 'allow',
      memory_write: 'ask',
      internal_write: 'ask',
      external_write: options.externalWrite ?? 'ask',
      destructive: 'deny',
    },
    policyGuards: options.reorder ? ['z-guard', 'a-guard'] : ['a-guard', 'z-guard'],
  });
}

function tool(name: string, schemaConst: string, maxResponseBytes: number): ToolDefinition {
  return {
    name,
    description: `Description for ${name}`,
    inputSchema: { type: 'object', properties: { value: { const: schemaConst } } },
    outputSchema: { type: 'object' },
    effect: 'read',
    idempotency: 'read',
    snapshotBinding: { transportId: 'local:test', remoteName: name, maxResponseBytes },
    async execute() {
      return {};
    },
  };
}

function digests(value: ReturnType<typeof fixtureCapture>): string[] {
  return [value.agent.digest, value.tools.digest, value.policy.digest];
}

function asObject(value: unknown): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Expected object');
  return value as JsonObject;
}

function appConfig(): AppConfig {
  return {
    version: 1,
    agent: {
      id: 'snapshot-test-agent',
      version: '1.0.0',
      name: 'Snapshot Test Agent',
      system: 'PRIVATE-SYSTEM-PROMPT-MUST-NOT-BE-STORED',
      skills: [],
      tools: [],
      budgets: {
        maxSteps: 3,
        maxToolCalls: 0,
        maxWallTimeMs: 30_000,
        maxInputTokens: 8_000,
        reservedOutputTokens: 512,
      },
    },
    policy: {
      read: 'allow', draft: 'allow', memory_write: 'ask', internal_write: 'ask',
      external_write: 'ask', destructive: 'deny',
    },
    server: { host: '127.0.0.1', port: 4310 },
    storage: { database: ':memory:' },
    model: { provider: 'mock', model: 'fixture' },
    memory: { retrievalLimit: 2, maxContextCharacters: 1_000 },
  };
}

function createLegacyRunDatabase(path: string): void {
  const database = new DatabaseSync(path);
  database.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, actor_id TEXT NOT NULL, channel TEXT NOT NULL,
      external_id TEXT, title TEXT, metadata_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, UNIQUE(channel, external_id)
    );
    CREATE TABLE runs (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), workspace_id TEXT NOT NULL,
      actor_id TEXT NOT NULL, project_id TEXT, agent_id TEXT NOT NULL, agent_version TEXT NOT NULL,
      status TEXT NOT NULL, input TEXT NOT NULL, output TEXT, error TEXT, step INTEGER NOT NULL DEFAULT 0,
      tool_calls INTEGER NOT NULL DEFAULT 0, active_ms INTEGER NOT NULL DEFAULT 0, active_since TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}', started_at TEXT, finished_at TEXT, created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO sessions VALUES
      ('legacy-session', 'local', 'alice', 'test', NULL, NULL, '{}',
       '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    INSERT INTO runs VALUES
      ('legacy-run', 'legacy-session', 'local', 'alice', NULL, 'legacy-agent', '1.0.0', 'succeeded',
       'old input', 'old output', NULL, 1, 0, 0, NULL, '{}', '2026-01-01T00:00:00.000Z',
       '2026-01-01T00:00:01.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z');
  `);
  database.close();
}
