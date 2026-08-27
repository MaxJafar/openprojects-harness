import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import {
  SQLITE_SCHEMA_MIGRATIONS,
  SQLITE_SCHEMA_VERSION,
  SqliteSchemaVersionError,
  SqliteStorage,
} from '../src/storage/sqlite.js';
import { canonicalizeToolArguments } from '../src/runtime/tool-arguments.js';
import type { EmbeddingAdapter } from '../src/core/types.js';
import { CorporateOracle } from '../src/oracle/corporate-oracle.js';

const temporaryDirectories = new Set<string>();

afterEach(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
  temporaryDirectories.clear();
});

function databasePath(label: string): string {
  const directory = mkdtempSync(join(tmpdir(), `openprojects-${label}-`));
  temporaryDirectories.add(directory);
  return join(directory, 'storage.db');
}

describe('numbered SQLite migrations', () => {
  it('commits one contiguous immutable ledger, mirrors user_version, and is idempotent', () => {
    const path = databasePath('migration-ledger');
    let first: Array<{ version: number; name: string; appliedAt: string }> = [];
    const storage = new SqliteStorage(path);
    try {
      const expected = SQLITE_SCHEMA_MIGRATIONS.map(({ version, name }) => ({ version, name }));
      first = storage.db.prepare(
        'SELECT version, name, applied_at AS appliedAt FROM schema_migrations ORDER BY version',
      ).all() as Array<{ version: number; name: string; appliedAt: string }>;

      expect(SQLITE_SCHEMA_VERSION).toBe(SQLITE_SCHEMA_MIGRATIONS.length);
      expect(first.map(({ version, name }) => ({ version, name }))).toEqual(expected);
      expect(first.every((migration) => Number.isFinite(Date.parse(migration.appliedAt)))).toBe(true);
      expect((storage.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
        .toBe(SQLITE_SCHEMA_VERSION);

      storage.migrate();
      expect(storage.db.prepare(
        'SELECT version, name, applied_at AS appliedAt FROM schema_migrations ORDER BY version',
      ).all()).toEqual(first);
    } finally {
      storage.close();
    }

    const reopened = new SqliteStorage(path);
    try {
      expect(reopened.db.prepare(
        'SELECT version, name, applied_at AS appliedAt FROM schema_migrations ORDER BY version',
      ).all()).toEqual(first);
    } finally {
      reopened.close();
    }
  });

  it('adopts a pre-ledger current-layout install without changing representative rows', () => {
    const path = databasePath('pre-ledger-current');
    const current = new SqliteStorage(path);
    const session = current.createSession({
      workspaceId: 'workspace-preserved',
      actorId: 'actor-preserved',
      channel: 'migration-test',
      title: 'Preserved session',
      metadata: { marker: 'session-metadata' },
    });
    const run = current.createRun({
      sessionId: session.id,
      workspaceId: session.workspaceId,
      actorId: session.actorId,
      projectId: 'project-preserved',
      agentId: 'agent-preserved',
      agentVersion: '3.2.1',
      input: 'Preserve this durable run exactly',
      metadata: { marker: 'run-metadata' },
    });
    current.close();

    const preLedger = new DatabaseSync(path);
    preLedger.exec(`
      DROP TABLE schema_migrations;
      PRAGMA user_version = 0;
    `);
    preLedger.close();

    const adopted = new SqliteStorage(path);
    try {
      expect(adopted.getSession(session.id)).toEqual(session);
      expect(adopted.getRun(run.id)).toEqual(run);
      expect(adopted.db.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all())
        .toEqual(SQLITE_SCHEMA_MIGRATIONS.map(({ version, name }) => ({ version, name })));
      expect((adopted.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
        .toBe(SQLITE_SCHEMA_VERSION);
    } finally {
      adopted.close();
    }
  });

  it('upgrades a version 6 install through argument digests and recovery pagination without row loss', () => {
    const path = databasePath('version-six-upgrade');
    const versionSix = new SqliteStorage(path);
    const session = versionSix.createSession({
      workspaceId: 'workspace-v6',
      actorId: 'actor-v6',
      channel: 'migration-test',
    });
    const allocated = versionSix.createRun({
      sessionId: session.id,
      workspaceId: session.workspaceId,
      actorId: session.actorId,
      agentId: 'agent-v6',
      agentVersion: '6.0.0',
      input: 'Preserve version six rows',
    });
    const run = versionSix.transitionRun(allocated.id, ['queued'], 'running');
    const batch = versionSix.createToolBatch(run.id, 1);
    const bound = canonicalizeToolArguments({ destination: 'operator@example.test' });
    const invocation = versionSix.createToolInvocation({
      batchId: batch.id,
      runId: run.id,
      callId: 'call-v6',
      callIndex: 0,
      toolName: 'notify',
      arguments: bound.arguments,
      argumentsDigest: bound.argumentsDigest,
      effect: 'external_write',
      policyDecision: 'ask',
      status: 'pending_approval',
      idempotencyKey: 'version-six-invocation',
    });
    const approval = versionSix.createApproval(invocation);
    versionSix.close();

    const legacy = new DatabaseSync(path);
    legacy.exec(`
      DELETE FROM schema_migrations WHERE version >= 7;
      PRAGMA user_version = 6;
      DROP INDEX runs_recoverable_agent_idx;
      ALTER TABLE approvals DROP COLUMN arguments_digest;
      ALTER TABLE tool_invocations DROP COLUMN arguments_digest;
    `);
    legacy.close();

    const upgraded = new SqliteStorage(path);
    try {
      expect(upgraded.getRun(run.id)).toEqual(run);
      expect(upgraded.getToolInvocation(invocation.id)).toMatchObject({
        id: invocation.id,
        arguments: bound.arguments,
        status: 'pending_approval',
      });
      expect(upgraded.getToolInvocation(invocation.id).argumentsDigest).toBeUndefined();
      expect(upgraded.getApproval(approval.id)).toMatchObject({
        id: approval.id,
        arguments: bound.arguments,
        status: 'pending',
      });
      expect(upgraded.getApproval(approval.id).argumentsDigest).toBeUndefined();
      expect(upgraded.db.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all())
        .toEqual(SQLITE_SCHEMA_MIGRATIONS.map(({ version, name }) => ({ version, name })));
      expect((upgraded.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
        .toBe(SQLITE_SCHEMA_VERSION);
    } finally {
      upgraded.close();
    }
  });

  it('fences migrated version 10 Oracle checkpoints against delayed cursor pages', async () => {
    const path = databasePath('version-ten-oracle-fence');
    const embedding: EmbeddingAdapter = {
      id: 'migration-test-embedding-v1',
      dimensions: 2,
      async embed(texts) {
        return texts.map(() => [1, 0]);
      },
    };
    const batch = {
      workspaceId: 'workspace-v10',
      source: 'legacy-connector',
      sourceAccountId: 'legacy-account',
      stream: 'issues',
      ingestedBy: 'legacy-connector',
      cursor: 'legacy-page-1',
      records: [{
        externalId: 'legacy-issue-1',
        domain: 'project' as const,
        recordType: 'issue',
        title: 'Migrated Oracle evidence',
        content: 'This record and checkpoint must survive migration.',
        occurredAt: '2026-08-01T09:00:00.000Z',
        sourceUpdatedAt: '2026-08-01T10:00:00.000Z',
      }],
    };

    const current = new SqliteStorage(path);
    const initial = await new CorporateOracle(
      current,
      embedding,
      () => new Date('2026-08-27T12:00:00.000Z'),
    ).ingestBatch(batch);
    current.close();

    const legacy = new DatabaseSync(path);
    legacy.exec(`
      DELETE FROM schema_migrations WHERE version = 11;
      PRAGMA user_version = 10;
      DROP TRIGGER oracle_records_fts_insert;
      DROP TRIGGER oracle_records_fts_update;
      DROP TRIGGER oracle_records_fts_delete;
      DROP TRIGGER oracle_record_versions_fts_insert;
      DROP TRIGGER oracle_record_versions_fts_delete;
      DROP TABLE oracle_records_fts;
      DROP TABLE oracle_record_versions_fts;
      DROP TABLE oracle_sync_pages;
    `);
    legacy.close();

    const upgraded = new SqliteStorage(path);
    try {
      const oracle = new CorporateOracle(
        upgraded,
        embedding,
        () => new Date('2026-08-28T12:00:00.000Z'),
      );
      expect(upgraded.db.prepare(`SELECT cursor, previous_cursor AS previousCursor
        FROM oracle_sync_pages WHERE workspace_id = ?`).get('workspace-v10')).toEqual({
        cursor: 'legacy-page-1',
        previousCursor: null,
      });
      expect(await oracle.ingestBatch(batch)).toMatchObject({
        inserted: 0,
        updated: 0,
        unchanged: 1,
        checkpoint: {
          cursor: 'legacy-page-1',
          lastBatchSha256: initial.checkpoint.lastBatchSha256,
        },
      });
      await expect(oracle.ingestBatch({
        ...batch,
        cursor: 'legacy-page-2',
        records: [],
      })).rejects.toThrow('does not continue from the current checkpoint cursor');
      expect(await oracle.ingestBatch({
        ...batch,
        previousCursor: 'legacy-page-1',
        cursor: 'legacy-page-2',
        records: [],
      })).toMatchObject({
        inserted: 0,
        updated: 0,
        unchanged: 0,
        checkpoint: { cursor: 'legacy-page-2', recordsSeen: 1 },
      });
    } finally {
      upgraded.close();
    }
  });

  it('fails closed on a newer user_version before creating or altering application tables', () => {
    const path = databasePath('newer-schema');
    const newer = new DatabaseSync(path);
    newer.exec(`
      CREATE TABLE sentinel (value TEXT NOT NULL);
      INSERT INTO sentinel (value) VALUES ('preserve-me');
      PRAGMA user_version = ${SQLITE_SCHEMA_VERSION + 1};
    `);
    newer.close();
    const bytesBefore = readFileSync(path);

    expect(() => new SqliteStorage(path)).toThrow(SqliteSchemaVersionError);
    expect(() => new SqliteStorage(path)).toThrow(`newer than supported version ${SQLITE_SCHEMA_VERSION}`);
    expect(readFileSync(path)).toEqual(bytesBefore);
    expect(existsSync(`${path}-wal`)).toBe(false);
    expect(existsSync(`${path}-shm`)).toBe(false);
    expect(existsSync(`${path}-journal`)).toBe(false);

    const inspected = new DatabaseSync(path);
    try {
      expect(inspected.prepare('SELECT value FROM sentinel').get()).toEqual({ value: 'preserve-me' });
      expect(inspected.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
      ).get()).toBeUndefined();
      expect((inspected.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
        .toBe(SQLITE_SCHEMA_VERSION + 1);
    } finally {
      inspected.close();
    }
  });

  it('fails closed when the ledger and user_version disagree', () => {
    const path = databasePath('ledger-mismatch');
    const current = new SqliteStorage(path);
    current.close();
    const mismatched = new DatabaseSync(path);
    mismatched.exec(`PRAGMA user_version = ${SQLITE_SCHEMA_VERSION - 1}`);
    mismatched.close();

    expect(() => new SqliteStorage(path)).toThrow('does not match PRAGMA user_version');

    const inspected = new DatabaseSync(path);
    try {
      expect((inspected.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number })
        .version).toBe(SQLITE_SCHEMA_VERSION);
      expect((inspected.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
        .toBe(SQLITE_SCHEMA_VERSION - 1);
    } finally {
      inspected.close();
    }
  });

  it('rejects a same-name recovery index with an incompatible contract', () => {
    const path = databasePath('tampered-recovery-index');
    const current = new SqliteStorage(path);
    current.close();

    const tampered = new DatabaseSync(path);
    tampered.exec(`
      DROP INDEX runs_recoverable_agent_idx;
      CREATE INDEX runs_recoverable_agent_idx ON runs(agent_id, status);
    `);
    tampered.close();

    expect(() => new SqliteStorage(path))
      .toThrow('SQLite agent-scoped recovery index contract is invalid');

    const inspected = new DatabaseSync(path);
    try {
      expect(inspected.prepare('PRAGMA index_info(runs_recoverable_agent_idx)').all())
        .toEqual([
          expect.objectContaining({ seqno: 0, name: 'agent_id' }),
          expect.objectContaining({ seqno: 1, name: 'status' }),
        ]);
      expect((inspected.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
        .toBe(SQLITE_SCHEMA_VERSION);
    } finally {
      inspected.close();
    }
  });

  it('rolls back the complete pending sequence and ledger when an upgrade step fails', () => {
    const path = databasePath('migration-rollback');
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE approvals (
        id TEXT PRIMARY KEY,
        invocation_id TEXT NOT NULL UNIQUE,
        run_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        arguments_json TEXT NOT NULL,
        status TEXT NOT NULL,
        requested_at TEXT NOT NULL,
        resolved_at TEXT,
        resolved_by TEXT,
        reason TEXT
      );
      INSERT INTO approvals
        (id, invocation_id, run_id, tool_name, arguments_json, status, requested_at)
      VALUES
        ('orphan-approval', 'missing-invocation', 'missing-run', 'notify', '{}', 'pending',
         '2026-01-01T00:00:00.000Z');
    `);
    legacy.close();

    expect(() => new SqliteStorage(path)).toThrow('orphaned run reference');

    const inspected = new DatabaseSync(path);
    try {
      const applicationTables = (inspected.prepare(`SELECT name FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as Array<{ name: string }>)
        .map((row) => row.name);
      const approvalColumns = (inspected.prepare('PRAGMA table_info(approvals)').all() as Array<{ name: string }>)
        .map((row) => row.name);
      expect(applicationTables).toEqual(['approvals']);
      expect(approvalColumns).not.toContain('workspace_id');
      expect(approvalColumns).not.toContain('queue_order');
      expect(approvalColumns).not.toContain('arguments_digest');
      expect((inspected.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(0);
      expect(inspected.prepare('SELECT id FROM approvals').get()).toEqual({ id: 'orphan-approval' });
    } finally {
      inspected.close();
    }
  });
});
