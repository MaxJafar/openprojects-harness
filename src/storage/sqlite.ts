import { chmodSync, existsSync, lstatSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';

import type {
  ApprovalRecord,
  CorporateRecord,
  CorporateRecordDomain,
  CorporateSourceSummary,
  CorporateSyncState,
  FeedbackRecord,
  GroupMessageRecord,
  GroupSpaceRecord,
  HarnessEvent,
  JsonObject,
  JsonValue,
  MemoryRecord,
  ModelRouteSelection,
  ModelTask,
  NotificationRecord,
  RunRecord,
  RunSnapshotDocument,
  RunSnapshotSet,
  RunStatus,
  SessionRecord,
  ToolInvocationRecord,
  ToolResult,
} from '../core/types.js';
import {
  canonicalSnapshotJson,
  compatibilityRunSnapshots,
  runSnapshotDigests,
  verifyRunSnapshot,
  verifyRunSnapshotSet,
} from '../runtime/run-snapshots.js';
import { verifyCanonicalToolArguments } from '../runtime/tool-arguments.js';

interface SqlRow {
  [key: string]: unknown;
}

export interface CreateSessionInput {
  workspaceId: string;
  actorId: string;
  channel: string;
  externalId?: string;
  title?: string;
  metadata?: JsonObject;
}

export interface CreateRunInput {
  sessionId: string;
  workspaceId: string;
  actorId: string;
  projectId?: string;
  agentId: string;
  agentVersion: string;
  input: string;
  metadata?: JsonObject;
  /** Full runtime capture; omitted callers receive an explicit incomplete compatibility capture. */
  snapshots?: RunSnapshotSet;
}

export interface PreparedCorporateRecord {
  workspaceId: string;
  source: string;
  sourceAccountId: string;
  stream: string;
  externalId: string;
  domain: CorporateRecordDomain;
  recordType: string;
  projectId?: string;
  title: string;
  content: string;
  sourceUrl?: string;
  sourceVersion?: string;
  occurredAt: string;
  sourceUpdatedAt: string;
  observedAt: string;
  status: CorporateRecord['status'];
  contentSha256: string;
  metadata: JsonObject;
  ingestedBy: string;
}

export interface CorporateBatchCheckpoint {
  workspaceId: string;
  source: string;
  sourceAccountId: string;
  stream: string;
  previousCursor?: string;
  cursor?: string;
  sourceWatermark?: string;
  batchSha256: string;
  successAt: string;
}

export interface CorporateBatchStorageResult {
  records: CorporateRecord[];
  changedRecordIds: string[];
  inserted: number;
  updated: number;
  unchanged: number;
  stale: number;
  checkpoint: CorporateSyncState;
}

export interface CorporateSearchOptions {
  projectId?: string;
  source?: string;
  domain?: CorporateRecordDomain;
  /** Historical queries are lexical because embeddings only bind the current head. */
  asOf?: string;
  /** Trusted host-observation cutoff for bitemporal historical reads. */
  knownAt?: string;
  limit?: number;
  queryVector?: number[];
  embeddingModel?: string;
}

export interface RunEventPageOptions {
  /** Return events whose durable, session-scoped sequence is greater than this cursor. */
  afterSeq?: number;
  /** Optional inclusive replay fence used when handing a stream from replay to live delivery. */
  throughSeq?: number;
  /** Hard page bound. Callers must explicitly request another page. */
  limit?: number;
}

export interface SessionEventPageOptions {
  /** Return events whose durable, session-scoped sequence is greater than this cursor. */
  afterSeq?: number;
  /** Optional inclusive replay fence. */
  throughSeq?: number;
  /** Hard page bound. Callers must explicitly request another page. */
  limit?: number;
}

/**
 * Central row-count ceilings for reads that can feed prompts or API responses.
 *
 * These are intentionally independent of SQLite's own limits: a valid query
 * must not be able to materialize an unbounded history into the Node process.
 */
export const STORAGE_READ_LIMITS = Object.freeze({
  sessionContextEvents: 512,
  sessionEvents: 1_000,
  runEvents: 1_000,
  runRows: 1_000,
  approvals: 1_000,
  toolInvocations: 1_000,
  feedback: 1_000,
  projects: 100,
  tasksPerProject: 256,
  evidencePerProject: 128,
  groupSpaces: 100,
  groupMessages: 1_000,
  memories: 10_000,
  notifications: 1_000,
});

export interface ApprovalPageOptions {
  workspaceId: string;
  status?: ApprovalRecord['status'];
  /** Opaque keyset cursor returned by the preceding page. */
  cursor?: string;
  /** Hard page bound; defaults to 50 and never exceeds 200. */
  limit?: number;
}

export interface ApprovalPage {
  approvals: ApprovalRecord[];
  nextCursor?: string;
}

export interface RecoverableRunPageOptions {
  /** Opaque keyset cursor returned by the preceding page. */
  cursor?: string;
  /** Hard page bound; defaults to the storage run-row ceiling. */
  limit?: number;
}

export type RecoverableRunCandidate =
  | { ok: true; run: RunRecord }
  | {
      ok: false;
      id: string;
      sessionId: string;
      agentId: string;
      agentVersion: string;
      status: 'running' | 'waiting_for_approval';
      createdAt: string;
      error: string;
    };

export interface RecoverableRunPage {
  candidates: RecoverableRunCandidate[];
  nextCursor?: string;
}

export interface ProjectRecord {
  id: string;
  workspaceId: string;
  name: string;
  status: string;
  summary: string;
  owner: string;
  dueAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskRecord {
  id: string;
  workspaceId: string;
  projectId: string;
  title: string;
  status: string;
  priority: string;
  assignee?: string;
  dueAt?: string;
  blockedReason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface EvidenceRecord {
  id: string;
  workspaceId: string;
  projectId: string;
  sourceType: string;
  sourceRef: string;
  title: string;
  content: string;
  observedAt: string;
}

export interface ToolBatchRecord {
  id: string;
  runId: string;
  step: number;
  status: 'pending' | 'ready' | 'flushed';
  createdAt: string;
  updatedAt: string;
}

export interface ModelRouteStats {
  routeId: string;
  task: ModelTask;
  attempts: number;
  successes: number;
  rewardSum: number;
  rewardCount: number;
  costUsd: number;
  latencyMs: number;
  updatedAt: string;
}

export class ApprovalDecisionConflictError extends Error {
  constructor(readonly approvalId: string, readonly existing: 'approved' | 'rejected') {
    super(`Approval ${approvalId} was already ${existing} and cannot be resolved with the opposite decision`);
    this.name = 'ApprovalDecisionConflictError';
  }
}

export class ApprovalArgumentIntegrityError extends Error {
  readonly code = 'APPROVAL_ARGUMENT_INTEGRITY_ERROR';

  constructor(readonly approvalId: string, message: string) {
    super(`Approval ${approvalId} argument integrity check failed: ${message}`);
    this.name = 'ApprovalArgumentIntegrityError';
  }
}

export class ApprovalCursorError extends Error {
  constructor(message = 'Approval cursor is invalid') {
    super(message);
    this.name = 'ApprovalCursorError';
  }
}

export class RecoverableRunCursorError extends Error {
  constructor(message = 'Recoverable run cursor is invalid') {
    super(message);
    this.name = 'RecoverableRunCursorError';
  }
}

export class CorporateSourceConflictError extends Error {
  readonly code = 'CORPORATE_SOURCE_CONFLICT';

  constructor(message: string) {
    super(message);
    this.name = 'CorporateSourceConflictError';
  }
}

/**
 * Durable SQLite schema contract. Every committed version has exactly one
 * immutable ledger row and must equal PRAGMA user_version.
 */
export const SQLITE_SCHEMA_MIGRATIONS = Object.freeze([
  { version: 1, name: 'initial_control_plane_schema' },
  { version: 2, name: 'workspace_scoped_inbound_deduplication' },
  { version: 3, name: 'active_run_accounting' },
  { version: 4, name: 'adaptive_memory_and_route_statistics' },
  { version: 5, name: 'workspace_approval_queue' },
  { version: 6, name: 'content_addressed_run_snapshots' },
  { version: 7, name: 'canonical_tool_argument_digests' },
  { version: 8, name: 'agent_scoped_recovery_pagination' },
  { version: 9, name: 'scoped_route_feedback_and_accounting_indexes' },
  { version: 10, name: 'temporal_corporate_oracle_ledger' },
  { version: 11, name: 'oracle_replay_ledger_and_full_text_indexes' },
] as const);

export const SQLITE_SCHEMA_VERSION = SQLITE_SCHEMA_MIGRATIONS.length;

export class SqliteSchemaVersionError extends Error {
  readonly code = 'SQLITE_SCHEMA_VERSION_ERROR';

  constructor(message: string) {
    super(message);
    this.name = 'SqliteSchemaVersionError';
  }
}

function secureDatabaseArtifacts(target: string): void {
  if (target === ':memory:') return;
  for (const path of [target, `${target}-wal`, `${target}-shm`]) {
    if (!existsSync(path)) continue;
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) {
      throw new Error('SQLite artifact must be a single-link regular non-symlink file');
    }
    // chmod cannot express or verify a Windows ACL. Keep the structural checks
    // on every platform; Windows deployment qualification must inspect ACLs
    // separately. POSIX platforms additionally enforce the exact file mode.
    if (process.platform !== 'win32') chmodSync(path, 0o600);
  }
}

export class SqliteStorage {
  readonly db: DatabaseSync;
  readonly #target: string;

  constructor(databasePath: string) {
    const target = databasePath === ':memory:' ? databasePath : resolve(databasePath);
    this.#target = target;
    if (target !== ':memory:') {
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      if (existsSync(target)) {
        const info = lstatSync(target);
        if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) {
          throw new Error('SQLite database path must be a single-link regular non-symlink file');
        }
      }
    }
    this.db = new DatabaseSync(target);
    try {
      // Connection-local safety settings may precede the schema gate. WAL is a
      // persistent file mutation and is enabled only after the database proves
      // it is not from a newer or inconsistent schema contract.
      this.db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
      this.migrate();
      this.db.exec('PRAGMA journal_mode = WAL;');
      secureDatabaseArtifacts(target);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void {
    const failures: unknown[] = [];
    try {
      secureDatabaseArtifacts(this.#target);
    } catch (error) {
      failures.push(error);
    }
    try {
      this.db.close();
    } catch (error) {
      failures.push(error);
    }
    try {
      secureDatabaseArtifacts(this.#target);
    } catch (error) {
      failures.push(error);
    }
    if (failures.length) throw new AggregateError(failures, 'SQLite shutdown or artifact hardening failed');
  }

  migrate(): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const userVersion = this.schemaUserVersion();
      if (userVersion > SQLITE_SCHEMA_VERSION) {
        throw new SqliteSchemaVersionError(
          `SQLite schema version ${userVersion} is newer than supported version ${SQLITE_SCHEMA_VERSION}`,
        );
      }

      const ledgerExists = this.tableExists('schema_migrations');
      if (!ledgerExists && userVersion !== 0) {
        throw new SqliteSchemaVersionError(
          `SQLite schema version ${userVersion} has no migration ledger`,
        );
      }
      this.db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY CHECK(version > 0),
        name TEXT NOT NULL UNIQUE,
        applied_at TEXT NOT NULL
      ) STRICT`);

      const applied = this.readAndValidateMigrationLedger(userVersion);
      for (const migration of SQLITE_SCHEMA_MIGRATIONS) {
        if (migration.version <= applied) continue;
        this.applySchemaMigration(migration.version);
        this.db.prepare(`INSERT INTO schema_migrations (version, name, applied_at)
          VALUES (?, ?, ?)`)
          .run(migration.version, migration.name, now());
        this.db.exec(`PRAGMA user_version = ${migration.version}`);
      }
      this.verifyCurrentSchema();
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private createInitialSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        external_id TEXT,
        title TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(channel, external_id)
      );

      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        workspace_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        project_id TEXT,
        agent_id TEXT NOT NULL,
        agent_version TEXT NOT NULL,
        status TEXT NOT NULL,
        input TEXT NOT NULL,
        output TEXT,
        error TEXT,
        step INTEGER NOT NULL DEFAULT 0,
        tool_calls INTEGER NOT NULL DEFAULT 0,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        started_at TEXT,
        finished_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS runs_session_idx ON runs(session_id, created_at);
      CREATE INDEX IF NOT EXISTS runs_workspace_idx ON runs(workspace_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        run_id TEXT NOT NULL REFERENCES runs(id),
        seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        data_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(session_id, seq)
      );
      CREATE INDEX IF NOT EXISTS events_run_idx ON events(run_id, seq);

      CREATE TABLE IF NOT EXISTS tool_batches (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id),
        step INTEGER NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(run_id, step)
      );

      CREATE TABLE IF NOT EXISTS tool_invocations (
        id TEXT PRIMARY KEY,
        batch_id TEXT NOT NULL REFERENCES tool_batches(id),
        run_id TEXT NOT NULL REFERENCES runs(id),
        call_id TEXT NOT NULL,
        call_index INTEGER NOT NULL,
        tool_name TEXT NOT NULL,
        arguments_json TEXT NOT NULL,
        effect TEXT,
        policy_decision TEXT NOT NULL,
        status TEXT NOT NULL,
        result_json TEXT,
        idempotency_key TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(batch_id, call_index),
        UNIQUE(run_id, call_id)
      );

      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        invocation_id TEXT NOT NULL UNIQUE REFERENCES tool_invocations(id),
        run_id TEXT NOT NULL REFERENCES runs(id),
        tool_name TEXT NOT NULL,
        arguments_json TEXT NOT NULL,
        status TEXT NOT NULL,
        requested_at TEXT NOT NULL,
        resolved_at TEXT,
        resolved_by TEXT,
        reason TEXT
      );
      CREATE INDEX IF NOT EXISTS approvals_run_idx ON approvals(run_id, status);

      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        project_id TEXT,
        actor_id TEXT,
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        importance REAL NOT NULL,
        source_type TEXT NOT NULL,
        source_id TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS memories_scope_idx ON memories(workspace_id, project_id, status);

      CREATE TABLE IF NOT EXISTS memory_embeddings (
        memory_id TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
        model TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        vector_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS run_memory_usage (
        run_id TEXT NOT NULL REFERENCES runs(id),
        memory_id TEXT NOT NULL REFERENCES memories(id),
        retrieved_at TEXT NOT NULL,
        PRIMARY KEY(run_id, memory_id)
      );

      CREATE TABLE IF NOT EXISTS memory_feedback_applications (
        feedback_id TEXT NOT NULL REFERENCES feedback(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        reward REAL NOT NULL,
        learning_rate REAL NOT NULL,
        applied_at TEXT NOT NULL,
        PRIMARY KEY(feedback_id, memory_id)
      );

      CREATE TABLE IF NOT EXISTS learning_signals (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        run_id TEXT,
        memory_id TEXT,
        route_id TEXT,
        kind TEXT NOT NULL,
        reward REAL NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS learning_signals_run_idx ON learning_signals(run_id, created_at);

      CREATE TABLE IF NOT EXISTS group_spaces (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        source TEXT NOT NULL,
        external_id TEXT NOT NULL,
        title TEXT,
        project_id TEXT,
        learning_enabled INTEGER NOT NULL,
        notifications_enabled INTEGER NOT NULL,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(source, external_id)
      );

      CREATE TABLE IF NOT EXISTS group_messages (
        id TEXT PRIMARY KEY,
        group_space_id TEXT NOT NULL REFERENCES group_spaces(id),
        workspace_id TEXT NOT NULL,
        external_message_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        text TEXT NOT NULL,
        transcript INTEGER NOT NULL,
        salient INTEGER NOT NULL,
        occurred_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(group_space_id, external_message_id)
      );
      CREATE INDEX IF NOT EXISTS group_messages_space_idx ON group_messages(group_space_id, occurred_at DESC);

      CREATE TABLE IF NOT EXISTS model_route_stats (
        route_id TEXT NOT NULL,
        task TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        successes INTEGER NOT NULL DEFAULT 0,
        reward_sum REAL NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0,
        latency_ms REAL NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(route_id, task)
      );

      CREATE TABLE IF NOT EXISTS model_route_calls (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id),
        route_id TEXT NOT NULL,
        task TEXT NOT NULL,
        success INTEGER NOT NULL,
        cost_usd REAL NOT NULL,
        latency_ms REAL NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS model_route_calls_run_idx ON model_route_calls(run_id, created_at);

      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        summary TEXT NOT NULL,
        owner TEXT NOT NULL,
        due_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(workspace_id, name)
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id),
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        priority TEXT NOT NULL,
        assignee TEXT,
        due_at TEXT,
        blocked_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS tasks_project_idx ON tasks(project_id, status);

      CREATE TABLE IF NOT EXISTS evidence (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id),
        source_type TEXT NOT NULL,
        source_ref TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        observed_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS evidence_project_idx ON evidence(project_id, observed_at DESC);

      CREATE TABLE IF NOT EXISTS feedback (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id),
        actor_id TEXT NOT NULL,
        reaction TEXT,
        score REAL NOT NULL,
        dimensions_json TEXT NOT NULL,
        comment TEXT,
        correction TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS feedback_run_idx ON feedback(run_id, created_at);

      CREATE TABLE IF NOT EXISTS inbound_events (
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
      );

      CREATE TABLE IF NOT EXISTS outbox (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        project_id TEXT,
        destination TEXT NOT NULL,
        subject TEXT NOT NULL,
        body TEXT NOT NULL,
        status TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        group_space_id TEXT NOT NULL REFERENCES group_spaces(id),
        project_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        destination TEXT NOT NULL,
        body TEXT NOT NULL,
        status TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        scheduled_at TEXT NOT NULL,
        sent_at TEXT,
        error TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS notifications_status_idx ON notifications(status, scheduled_at);
    `);
  }

  private applySchemaMigration(version: number): void {
    switch (version) {
      case 1:
        this.createInitialSchema();
        return;
      case 2:
        this.migrateInboundEventScope();
        return;
      case 3:
        this.addColumnIfMissing('runs', 'active_ms', 'INTEGER NOT NULL DEFAULT 0');
        this.addColumnIfMissing('runs', 'active_since', 'TEXT');
        return;
      case 4:
        this.addColumnIfMissing('memories', 'strength', 'REAL NOT NULL DEFAULT 0.5');
        this.addColumnIfMissing('memories', 'reward', 'REAL NOT NULL DEFAULT 0');
        this.addColumnIfMissing('memories', 'access_count', 'INTEGER NOT NULL DEFAULT 0');
        this.addColumnIfMissing('memories', 'last_accessed_at', 'TEXT');
        this.addColumnIfMissing('model_route_stats', 'reward_count', 'INTEGER NOT NULL DEFAULT 0');
        return;
      case 5:
        this.migrateApprovalWorkspaceQueue();
        return;
      case 6:
        this.db.exec(`CREATE TABLE IF NOT EXISTS run_snapshot_documents (
          digest TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          schema TEXT NOT NULL,
          canonical_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        )`);
        this.addColumnIfMissing(
          'runs',
          'agent_snapshot_digest',
          'TEXT REFERENCES run_snapshot_documents(digest)',
        );
        this.addColumnIfMissing(
          'runs',
          'tools_snapshot_digest',
          'TEXT REFERENCES run_snapshot_documents(digest)',
        );
        this.addColumnIfMissing(
          'runs',
          'policy_snapshot_digest',
          'TEXT REFERENCES run_snapshot_documents(digest)',
        );
        return;
      case 7:
        this.addColumnIfMissing('tool_invocations', 'arguments_digest', 'TEXT');
        this.addColumnIfMissing('approvals', 'arguments_digest', 'TEXT');
        return;
      case 8:
        this.db.exec('DROP INDEX IF EXISTS runs_recoverable_agent_idx');
        this.db.exec(`CREATE INDEX IF NOT EXISTS runs_recoverable_agent_idx
          ON runs(agent_id, agent_version, created_at, id)
          WHERE status IN ('running', 'waiting_for_approval')`);
        return;
      case 9:
        this.db.exec(`
          CREATE INDEX IF NOT EXISTS model_route_calls_created_idx
            ON model_route_calls(created_at);
          CREATE INDEX IF NOT EXISTS model_route_calls_task_run_route_idx
            ON model_route_calls(task, run_id, route_id);
          CREATE INDEX IF NOT EXISTS learning_signals_workspace_kind_route_idx
            ON learning_signals(workspace_id, kind, route_id);
          CREATE TABLE IF NOT EXISTS route_feedback_applications (
            feedback_id TEXT NOT NULL REFERENCES feedback(id) ON DELETE CASCADE,
            route_id TEXT NOT NULL,
            task TEXT NOT NULL,
            applied_at TEXT NOT NULL,
            PRIMARY KEY(feedback_id, route_id, task)
          );
        `);
        return;
      case 10:
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS oracle_records (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL,
            source TEXT NOT NULL,
            source_account_id TEXT NOT NULL,
            stream TEXT NOT NULL,
            external_id TEXT NOT NULL,
            domain TEXT NOT NULL,
            record_type TEXT NOT NULL,
            project_id TEXT,
            title TEXT NOT NULL,
            content TEXT NOT NULL,
            source_url TEXT,
            source_version TEXT,
            occurred_at TEXT NOT NULL,
            source_updated_at TEXT NOT NULL,
            observed_at TEXT NOT NULL,
            status TEXT NOT NULL,
            content_sha256 TEXT NOT NULL,
            revision INTEGER NOT NULL CHECK(revision > 0),
            metadata_json TEXT NOT NULL,
            ingested_by TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(workspace_id, source, stream, external_id)
          ) STRICT;
          CREATE INDEX IF NOT EXISTS oracle_records_scope_idx
            ON oracle_records(workspace_id, status, project_id, occurred_at DESC, id);
          CREATE INDEX IF NOT EXISTS oracle_records_source_idx
            ON oracle_records(workspace_id, source, source_account_id, stream, status, source_updated_at DESC, id);

          CREATE TABLE IF NOT EXISTS oracle_record_versions (
            record_id TEXT NOT NULL REFERENCES oracle_records(id) ON DELETE CASCADE,
            revision INTEGER NOT NULL CHECK(revision > 0),
            workspace_id TEXT NOT NULL,
            source TEXT NOT NULL,
            source_account_id TEXT NOT NULL,
            stream TEXT NOT NULL,
            external_id TEXT NOT NULL,
            domain TEXT NOT NULL,
            record_type TEXT NOT NULL,
            project_id TEXT,
            title TEXT NOT NULL,
            content TEXT NOT NULL,
            source_url TEXT,
            source_version TEXT,
            occurred_at TEXT NOT NULL,
            source_updated_at TEXT NOT NULL,
            observed_at TEXT NOT NULL,
            status TEXT NOT NULL,
            content_sha256 TEXT NOT NULL,
            metadata_json TEXT NOT NULL,
            ingested_by TEXT NOT NULL,
            created_at TEXT NOT NULL,
            PRIMARY KEY(record_id, revision)
          ) STRICT;
          CREATE INDEX IF NOT EXISTS oracle_record_versions_time_idx
            ON oracle_record_versions(workspace_id, source, source_account_id, stream, external_id, source_updated_at DESC, revision DESC);

          CREATE TABLE IF NOT EXISTS oracle_record_embeddings (
            record_id TEXT PRIMARY KEY REFERENCES oracle_records(id) ON DELETE CASCADE,
            model TEXT NOT NULL,
            dimensions INTEGER NOT NULL,
            vector_json TEXT NOT NULL,
            content_sha256 TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          ) STRICT;

          CREATE TABLE IF NOT EXISTS oracle_sync_state (
            workspace_id TEXT NOT NULL,
            source TEXT NOT NULL,
            source_account_id TEXT NOT NULL,
            stream TEXT NOT NULL,
            cursor TEXT,
            source_watermark TEXT,
            last_batch_sha256 TEXT NOT NULL,
            records_seen INTEGER NOT NULL CHECK(records_seen >= 0),
            last_success_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY(workspace_id, source, stream)
          ) STRICT;
        `);
        return;
      case 11: {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS oracle_sync_pages (
            workspace_id TEXT NOT NULL,
            source TEXT NOT NULL,
            source_account_id TEXT NOT NULL,
            stream TEXT NOT NULL,
            page_key TEXT NOT NULL,
            previous_cursor TEXT,
            cursor TEXT,
            batch_sha256 TEXT NOT NULL,
            record_count INTEGER NOT NULL CHECK(record_count >= 0),
            accepted_at TEXT NOT NULL,
            PRIMARY KEY(workspace_id, source, stream, page_key)
          ) STRICT;
          CREATE INDEX IF NOT EXISTS oracle_sync_pages_account_idx
            ON oracle_sync_pages(workspace_id, source, source_account_id, stream, accepted_at);

          CREATE VIRTUAL TABLE IF NOT EXISTS oracle_records_fts USING fts5(
            record_id UNINDEXED,
            workspace_id UNINDEXED,
            title,
            content,
            record_type,
            tokenize='unicode61 remove_diacritics 2'
          );
          CREATE VIRTUAL TABLE IF NOT EXISTS oracle_record_versions_fts USING fts5(
            record_id UNINDEXED,
            revision UNINDEXED,
            workspace_id UNINDEXED,
            title,
            content,
            record_type,
            tokenize='unicode61 remove_diacritics 2'
          );

          INSERT INTO oracle_records_fts (record_id, workspace_id, title, content, record_type)
            SELECT id, workspace_id, title, content, record_type FROM oracle_records;
          INSERT INTO oracle_record_versions_fts
            (record_id, revision, workspace_id, title, content, record_type)
            SELECT record_id, revision, workspace_id, title, content, record_type
              FROM oracle_record_versions;

          CREATE TRIGGER IF NOT EXISTS oracle_records_fts_insert
            AFTER INSERT ON oracle_records BEGIN
              INSERT INTO oracle_records_fts
                (record_id, workspace_id, title, content, record_type)
                VALUES (new.id, new.workspace_id, new.title, new.content, new.record_type);
            END;
          CREATE TRIGGER IF NOT EXISTS oracle_records_fts_update
            AFTER UPDATE ON oracle_records BEGIN
              DELETE FROM oracle_records_fts WHERE record_id = old.id;
              INSERT INTO oracle_records_fts
                (record_id, workspace_id, title, content, record_type)
                VALUES (new.id, new.workspace_id, new.title, new.content, new.record_type);
            END;
          CREATE TRIGGER IF NOT EXISTS oracle_records_fts_delete
            AFTER DELETE ON oracle_records BEGIN
              DELETE FROM oracle_records_fts WHERE record_id = old.id;
            END;

          CREATE TRIGGER IF NOT EXISTS oracle_record_versions_fts_insert
            AFTER INSERT ON oracle_record_versions BEGIN
              INSERT INTO oracle_record_versions_fts
                (record_id, revision, workspace_id, title, content, record_type)
                VALUES (new.record_id, new.revision, new.workspace_id,
                  new.title, new.content, new.record_type);
            END;
          CREATE TRIGGER IF NOT EXISTS oracle_record_versions_fts_delete
            AFTER DELETE ON oracle_record_versions BEGIN
              DELETE FROM oracle_record_versions_fts
                WHERE record_id = old.record_id AND revision = old.revision;
            END;
        `);
        const seedPage = this.db.prepare(`INSERT OR IGNORE INTO oracle_sync_pages
          (workspace_id, source, source_account_id, stream, page_key, previous_cursor,
           cursor, batch_sha256, record_count, accepted_at)
          VALUES (?, ?, ?, ?, ?, NULL, ?, ?, 0, ?)`);
        const checkpoints = this.db.prepare('SELECT * FROM oracle_sync_state').all() as SqlRow[];
        for (const checkpoint of checkpoints) {
          const cursor = nullableString(checkpoint.cursor);
          const batchSha256 = stringValue(checkpoint.last_batch_sha256);
          seedPage.run(
            stringValue(checkpoint.workspace_id),
            stringValue(checkpoint.source),
            stringValue(checkpoint.source_account_id),
            stringValue(checkpoint.stream),
            corporatePageKey(cursor, batchSha256),
            cursor ?? null,
            batchSha256,
            stringValue(checkpoint.last_success_at),
          );
        }
        return;
      }
      default:
        throw new SqliteSchemaVersionError(`Unknown SQLite migration version ${version}`);
    }
  }

  private migrateApprovalWorkspaceQueue(): void {
    this.addColumnIfMissing('approvals', 'workspace_id', 'TEXT');
    this.addColumnIfMissing('approvals', 'queue_order', 'INTEGER NOT NULL DEFAULT 0');
    this.db.exec(`
      UPDATE approvals SET workspace_id = (
        SELECT workspace_id FROM runs WHERE runs.id = approvals.run_id
      ) WHERE workspace_id IS NULL;
      UPDATE approvals SET queue_order = CASE WHEN status = 'pending' THEN 0 ELSE 1 END
        WHERE queue_order IS NULL
          OR queue_order != CASE WHEN status = 'pending' THEN 0 ELSE 1 END;
      CREATE INDEX IF NOT EXISTS approvals_workspace_queue_page_idx
        ON approvals(workspace_id, queue_order, requested_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS approvals_workspace_status_page_idx
        ON approvals(workspace_id, status, requested_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS approvals_workspace_status_queue_page_idx
        ON approvals(workspace_id, status, queue_order, requested_at DESC, id DESC);
    `);
    const orphanedApproval = this.db.prepare(
      'SELECT id FROM approvals WHERE workspace_id IS NULL LIMIT 1',
    ).get();
    if (orphanedApproval) throw new Error('Approval workspace migration found an orphaned run reference');
  }

  private migrateInboundEventScope(): void {
    const row = this.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'inbound_events'")
      .get() as SqlRow | undefined;
    const source = typeof row?.sql === 'string' ? row.sql : '';
    if (!/UNIQUE\s*\(\s*source\s*,\s*dedupe_key\s*\)/iu.test(source)) return;
    this.db.exec(`
      ALTER TABLE inbound_events RENAME TO inbound_events_v02;
      CREATE TABLE inbound_events (
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
        UNIQUE(workspace_id, source, dedupe_key)
      );
      INSERT INTO inbound_events
        (id, source, dedupe_key, type, workspace_id, actor_id, project_id, payload_json,
         occurred_at, run_id, created_at)
      SELECT id, source, dedupe_key, type, workspace_id, actor_id, project_id, payload_json,
        occurred_at, run_id, created_at
      FROM inbound_events_v02;
      DROP TABLE inbound_events_v02;
    `);
  }

  private addColumnIfMissing(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as SqlRow[];
    if (columns.some((row) => row.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  private schemaUserVersion(): number {
    const row = this.db.prepare('PRAGMA user_version').get() as SqlRow;
    return numberValue(row.user_version);
  }

  private tableExists(table: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table));
  }

  private readAndValidateMigrationLedger(userVersion: number): number {
    const rows = this.db.prepare('SELECT version, name, applied_at FROM schema_migrations ORDER BY version')
      .all() as SqlRow[];
    const newest = rows.length ? numberValue(rows.at(-1)!.version) : 0;
    if (newest > SQLITE_SCHEMA_VERSION) {
      throw new SqliteSchemaVersionError(
        `SQLite migration ledger version ${newest} is newer than supported version ${SQLITE_SCHEMA_VERSION}`,
      );
    }
    if (newest !== userVersion) {
      throw new SqliteSchemaVersionError(
        `SQLite migration ledger version ${newest} does not match PRAGMA user_version ${userVersion}`,
      );
    }
    for (const [index, row] of rows.entries()) {
      const expected = SQLITE_SCHEMA_MIGRATIONS[index];
      const version = numberValue(row.version);
      const name = stringValue(row.name);
      if (!expected || version !== expected.version || name !== expected.name) {
        throw new SqliteSchemaVersionError(
          `SQLite migration ledger is not the expected contiguous history at version ${version}`,
        );
      }
      if (!stringValue(row.applied_at)) {
        throw new SqliteSchemaVersionError(`SQLite migration ${version} has no application timestamp`);
      }
    }
    return newest;
  }

  private verifyCurrentSchema(): void {
    const requiredColumns: Record<string, string[]> = {
      runs: [
        'active_ms',
        'active_since',
        'agent_snapshot_digest',
        'tools_snapshot_digest',
        'policy_snapshot_digest',
      ],
      memories: ['strength', 'reward', 'access_count', 'last_accessed_at'],
      model_route_stats: ['reward_count'],
      approvals: ['workspace_id', 'queue_order', 'arguments_digest'],
      tool_invocations: ['arguments_digest'],
      run_snapshot_documents: ['digest', 'kind', 'schema', 'canonical_json', 'created_at'],
      route_feedback_applications: ['feedback_id', 'route_id', 'task', 'applied_at'],
      oracle_records: [
        'id', 'workspace_id', 'source', 'source_account_id', 'stream', 'external_id', 'domain', 'record_type',
        'project_id', 'title', 'content', 'source_url', 'source_version', 'occurred_at',
        'source_updated_at', 'observed_at', 'status', 'content_sha256', 'revision',
        'metadata_json', 'ingested_by', 'created_at', 'updated_at',
      ],
      oracle_record_versions: [
        'record_id', 'revision', 'workspace_id', 'source', 'source_account_id', 'stream', 'external_id',
        'domain', 'record_type', 'project_id', 'title', 'content', 'source_url',
        'source_version', 'occurred_at', 'source_updated_at', 'observed_at', 'status',
        'content_sha256', 'metadata_json', 'ingested_by', 'created_at',
      ],
      oracle_record_embeddings: [
        'record_id', 'model', 'dimensions', 'vector_json', 'content_sha256', 'created_at', 'updated_at',
      ],
      oracle_sync_state: [
        'workspace_id', 'source', 'source_account_id', 'stream', 'cursor', 'source_watermark',
        'last_batch_sha256', 'records_seen', 'last_success_at', 'updated_at',
      ],
      oracle_sync_pages: [
        'workspace_id', 'source', 'source_account_id', 'stream', 'page_key',
        'previous_cursor', 'cursor', 'batch_sha256', 'record_count', 'accepted_at',
      ],
      oracle_records_fts: ['record_id', 'workspace_id', 'title', 'content', 'record_type'],
      oracle_record_versions_fts: [
        'record_id', 'revision', 'workspace_id', 'title', 'content', 'record_type',
      ],
    };
    for (const [table, expectedColumns] of Object.entries(requiredColumns)) {
      const columns = new Set(
        (this.db.prepare(`PRAGMA table_info(${table})`).all() as SqlRow[])
          .map((row) => stringValue(row.name)),
      );
      for (const column of expectedColumns) {
        if (!columns.has(column)) {
          throw new SqliteSchemaVersionError(
            `SQLite schema version ${SQLITE_SCHEMA_VERSION} is missing ${table}.${column}`,
          );
        }
      }
    }
    const orphanedApproval = this.db.prepare(
      'SELECT id FROM approvals WHERE workspace_id IS NULL LIMIT 1',
    ).get();
    if (orphanedApproval) {
      throw new SqliteSchemaVersionError('SQLite approval workspace migration is incomplete');
    }
    const inboundRow = this.db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'inbound_events'",
    ).get() as SqlRow | undefined;
    const inboundSql = typeof inboundRow?.sql === 'string' ? inboundRow.sql : '';
    if (!/UNIQUE\s*\(\s*workspace_id\s*,\s*source\s*,\s*dedupe_key\s*\)/iu.test(inboundSql)) {
      throw new SqliteSchemaVersionError('SQLite inbound-event deduplication scope is not current');
    }
    const recoveryIndex = this.db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?",
    ).get('runs_recoverable_agent_idx') as SqlRow | undefined;
    const recoveryIndexColumns = (this.db.prepare('PRAGMA index_info(runs_recoverable_agent_idx)')
      .all() as SqlRow[]).map((row) => stringValue(row.name));
    const recoveryIndexSql = typeof recoveryIndex?.sql === 'string'
      ? recoveryIndex.sql.replace(/\s+/gu, ' ').trim()
      : '';
    if (
      recoveryIndexColumns.join(',') !== 'agent_id,agent_version,created_at,id'
      || !/WHERE\s+status\s+IN\s*\(\s*'running'\s*,\s*'waiting_for_approval'\s*\)\s*$/iu
        .test(recoveryIndexSql)
    ) {
      throw new SqliteSchemaVersionError('SQLite agent-scoped recovery index contract is invalid');
    }
    const requiredIndexes: Record<string, string> = {
      model_route_calls_created_idx: 'created_at',
      model_route_calls_task_run_route_idx: 'task,run_id,route_id',
      learning_signals_workspace_kind_route_idx: 'workspace_id,kind,route_id',
      oracle_records_scope_idx: 'workspace_id,status,project_id,occurred_at,id',
      oracle_records_source_idx: 'workspace_id,source,source_account_id,stream,status,source_updated_at,id',
      oracle_record_versions_time_idx: 'workspace_id,source,source_account_id,stream,external_id,source_updated_at,revision',
      oracle_sync_pages_account_idx: 'workspace_id,source,source_account_id,stream,accepted_at',
    };
    for (const [index, expectedColumns] of Object.entries(requiredIndexes)) {
      const columns = (this.db.prepare(`PRAGMA index_info(${index})`).all() as SqlRow[])
        .map((row) => stringValue(row.name))
        .join(',');
      if (columns !== expectedColumns) {
        throw new SqliteSchemaVersionError(`SQLite index ${index} contract is invalid`);
      }
    }
    const feedbackApplicationPrimaryKey = (this.db
      .prepare('PRAGMA table_info(route_feedback_applications)')
      .all() as SqlRow[])
      .filter((row) => numberValue(row.pk) > 0)
      .sort((left, right) => numberValue(left.pk) - numberValue(right.pk))
      .map((row) => stringValue(row.name))
      .join(',');
    if (feedbackApplicationPrimaryKey !== 'feedback_id,route_id,task') {
      throw new SqliteSchemaVersionError('SQLite route-feedback application primary key is invalid');
    }
    if (this.schemaUserVersion() !== SQLITE_SCHEMA_VERSION) {
      throw new SqliteSchemaVersionError('SQLite user_version did not advance with the migration ledger');
    }
  }

  createSession(input: CreateSessionInput): SessionRecord {
    if (input.externalId) {
      const existing = this.findSessionByExternal(input.channel, input.externalId);
      if (existing) return existing;
    }
    const id = randomUUID();
    const timestamp = now();
    this.db
      .prepare(`INSERT INTO sessions
        (id, workspace_id, actor_id, channel, external_id, title, metadata_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        id,
        input.workspaceId,
        input.actorId,
        input.channel,
        input.externalId ?? null,
        input.title ?? null,
        stringify(input.metadata ?? {}),
        timestamp,
        timestamp,
      );
    return this.getSession(id);
  }

  getSession(id: string): SessionRecord {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SqlRow | undefined;
    if (!row) throw new Error(`Session not found: ${id}`);
    return mapSession(row);
  }

  findSessionByExternal(channel: string, externalId: string): SessionRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM sessions WHERE channel = ? AND external_id = ?')
      .get(channel, externalId) as SqlRow | undefined;
    return row ? mapSession(row) : undefined;
  }

  createRun(input: CreateRunInput): RunRecord {
    const id = randomUUID();
    const timestamp = now();
    const snapshots = input.snapshots ?? compatibilityRunSnapshots(input.agentId, input.agentVersion);
    verifyRunSnapshotSet(snapshots);
    const snapshotAgent = snapshots.agent.content.agent;
    if (
      !isJsonObject(snapshotAgent)
      || snapshotAgent.id !== input.agentId
      || snapshotAgent.version !== input.agentVersion
    ) {
      throw new Error('Run agent identity does not match its agent snapshot');
    }
    const digests = runSnapshotDigests(snapshots);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const snapshot of [snapshots.agent, snapshots.tools, snapshots.policy]) {
        this.insertRunSnapshot(snapshot, timestamp);
      }
      this.db
        .prepare(`INSERT INTO runs
          (id, session_id, workspace_id, actor_id, project_id, agent_id, agent_version,
           agent_snapshot_digest, tools_snapshot_digest, policy_snapshot_digest, status,
           input, metadata_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)`)
        .run(
          id,
          input.sessionId,
          input.workspaceId,
          input.actorId,
          input.projectId ?? null,
          input.agentId,
          input.agentVersion,
          digests.agent,
          digests.tools,
          digests.policy,
          input.input,
          stringify(input.metadata ?? {}),
          timestamp,
          timestamp,
        );
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.getRun(id);
  }

  getRunSnapshot(digest: string): RunSnapshotDocument {
    const row = this.db.prepare('SELECT * FROM run_snapshot_documents WHERE digest = ?').get(digest) as SqlRow | undefined;
    if (!row) throw new Error(`Run snapshot not found: ${digest}`);
    const addressable = parseObject(row.canonical_json);
    const content = addressable.content;
    if (!isJsonObject(content)) throw new Error(`Run snapshot content is corrupt: ${digest}`);
    const snapshot: RunSnapshotDocument = {
      schema: stringValue(addressable.schema) as RunSnapshotDocument['schema'],
      kind: stringValue(addressable.kind) as RunSnapshotDocument['kind'],
      content,
      digest: stringValue(row.digest),
    };
    if (snapshot.schema !== stringValue(row.schema) || snapshot.kind !== stringValue(row.kind)) {
      throw new Error(`Run snapshot envelope is corrupt: ${digest}`);
    }
    verifyRunSnapshot(snapshot);
    return snapshot;
  }

  getRunSnapshots(runId: string): RunSnapshotSet | undefined {
    const run = this.getRun(runId);
    if (!run.snapshots) return undefined;
    const snapshots = {
      agent: this.getRunSnapshot(run.snapshots.agent),
      tools: this.getRunSnapshot(run.snapshots.tools),
      policy: this.getRunSnapshot(run.snapshots.policy),
    };
    verifyRunSnapshotSet(snapshots);
    return snapshots;
  }

  private insertRunSnapshot(snapshot: RunSnapshotDocument, timestamp: string): void {
    verifyRunSnapshot(snapshot);
    const canonical = canonicalSnapshotJson({
      schema: snapshot.schema,
      kind: snapshot.kind,
      content: snapshot.content,
    });
    this.db.prepare(`INSERT OR IGNORE INTO run_snapshot_documents
      (digest, kind, schema, canonical_json, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(snapshot.digest, snapshot.kind, snapshot.schema, canonical, timestamp);
    const existing = this.db.prepare(`SELECT kind, schema, canonical_json
      FROM run_snapshot_documents WHERE digest = ?`).get(snapshot.digest) as SqlRow | undefined;
    if (
      !existing
      || existing.kind !== snapshot.kind
      || existing.schema !== snapshot.schema
      || existing.canonical_json !== canonical
    ) {
      throw new Error(`Run snapshot content-address collision: ${snapshot.digest}`);
    }
  }

  getRun(id: string): RunRecord {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as SqlRow | undefined;
    if (!row) throw new Error(`Run not found: ${id}`);
    return mapRun(row);
  }

  listRuns(workspaceId = 'local', limit = 50): RunRecord[] {
    const boundedLimit = storageReadLimit(limit, STORAGE_READ_LIMITS.runRows, 'Run list');
    return (this.db
      .prepare('SELECT * FROM runs WHERE workspace_id = ? ORDER BY created_at DESC, id DESC LIMIT ?')
      .all(workspaceId, boundedLimit) as SqlRow[]).map(mapRun);
  }

  /**
   * Bound recovery to one agent lane before LIMIT. Compatible rows are ordered
   * first, while other versions remain visible for explicit quarantine.
   */
  listRecoverableRunsForAgent(
    agentId: string,
    preferredVersion: string,
    limit = 1000,
  ): RunRecord[] {
    return this.listRecoverableRunsForAgentPage(agentId, preferredVersion, { limit }).candidates
      .flatMap((candidate) => candidate.ok ? [candidate.run] : []);
  }

  listRecoverableRunsForAgentPage(
    agentId: string,
    preferredVersion: string,
    options: RecoverableRunPageOptions = {},
  ): RecoverableRunPage {
    const limit = storageReadLimit(
      options.limit ?? STORAGE_READ_LIMITS.runRows,
      STORAGE_READ_LIMITS.runRows,
      'Agent recoverable run page',
    );
    const cursor = options.cursor
      ? decodeRecoverableRunCursor(options.cursor, agentId, preferredVersion)
      : undefined;
    if (cursor) {
      const scope = this.db.prepare(`SELECT
          agent_id = ? AS agent_matches,
          agent_version = ? AS preferred_version_matches
        FROM runs WHERE rowid = CAST(? AS INTEGER)`)
        .get(agentId, preferredVersion, cursor.rowId) as SqlRow | undefined;
      const agentMatches = scope ? numberValue(scope.agent_matches) === 1 : false;
      const preferredVersionMatches = scope
        ? numberValue(scope.preferred_version_matches) === 1
        : false;
      if (
        !agentMatches
        || (cursor.phase === 'preferred') !== preferredVersionMatches
      ) {
        throw new RecoverableRunCursorError();
      }
    }
    const rows: SqlRow[] = [];

    if (cursor?.phase !== 'nonpreferred') {
      const preferredKeyset = cursor
        ? `AND (
            created_at > (SELECT created_at FROM runs WHERE rowid = CAST(? AS INTEGER))
            OR (created_at = (SELECT created_at FROM runs WHERE rowid = CAST(? AS INTEGER))
              AND id > (SELECT id FROM runs WHERE rowid = CAST(? AS INTEGER)))
          )`
        : '';
      const preferredParameters: SQLInputValue[] = [agentId, preferredVersion];
      if (cursor) {
        preferredParameters.push(cursor.rowId, cursor.rowId, cursor.rowId);
      }
      preferredParameters.push(limit);
      rows.push(...this.db.prepare(`SELECT
          CAST(rowid AS TEXT) AS recovery_cursor_rowid,
          'preferred' AS recovery_cursor_phase,
          *
        FROM runs INDEXED BY runs_recoverable_agent_idx
        WHERE agent_id = ? AND agent_version = ?
          AND status IN ('running', 'waiting_for_approval')
          AND (
            status = 'running'
            OR EXISTS (
              SELECT 1 FROM tool_invocations AS running_invocation
              WHERE running_invocation.run_id = runs.id
                AND running_invocation.status = 'running'
            )
            OR NOT EXISTS (
              SELECT 1 FROM tool_invocations AS pending_invocation
              WHERE pending_invocation.run_id = runs.id
                AND pending_invocation.status = 'pending_approval'
            )
          )
          ${preferredKeyset}
        ORDER BY created_at, id
        LIMIT ?`).all(...preferredParameters) as SqlRow[]);
    }

    const remaining = limit - rows.length;
    if (remaining > 0) {
      const nonpreferredCursor = cursor?.phase === 'nonpreferred' ? cursor : undefined;
      const nonpreferredKeyset = nonpreferredCursor
        ? `AND (
            agent_version > (SELECT agent_version FROM runs WHERE rowid = CAST(? AS INTEGER))
            OR (agent_version = (SELECT agent_version FROM runs WHERE rowid = CAST(? AS INTEGER))
              AND (
                created_at > (SELECT created_at FROM runs WHERE rowid = CAST(? AS INTEGER))
                OR (created_at = (SELECT created_at FROM runs WHERE rowid = CAST(? AS INTEGER))
                  AND id > (SELECT id FROM runs WHERE rowid = CAST(? AS INTEGER)))
              ))
          )`
        : '';
      const nonpreferredParameters: SQLInputValue[] = [agentId, preferredVersion];
      if (nonpreferredCursor) {
        nonpreferredParameters.push(
          nonpreferredCursor.rowId,
          nonpreferredCursor.rowId,
          nonpreferredCursor.rowId,
          nonpreferredCursor.rowId,
          nonpreferredCursor.rowId,
        );
      }
      nonpreferredParameters.push(remaining);
      rows.push(...this.db.prepare(`SELECT
          CAST(rowid AS TEXT) AS recovery_cursor_rowid,
          'nonpreferred' AS recovery_cursor_phase,
          *
        FROM runs INDEXED BY runs_recoverable_agent_idx
        WHERE agent_id = ? AND agent_version != ?
          AND status IN ('running', 'waiting_for_approval')
          ${nonpreferredKeyset}
        ORDER BY agent_version, created_at, id
        LIMIT ?`).all(...nonpreferredParameters) as SqlRow[]);
    }

    const candidates = rows.map(mapRecoverableRunCandidate);
    const last = rows.length === limit ? rows.at(-1) : undefined;
    let nextCursor: string | undefined;
    if (last) {
      const phase = stringValue(last.recovery_cursor_phase);
      if (phase !== 'preferred' && phase !== 'nonpreferred') {
        throw new Error('Recoverable run query returned an invalid cursor phase');
      }
      nextCursor = encodeRecoverableRunCursor({
        scopeDigest: recoverableRunCursorScopeDigest(agentId, preferredVersion),
        phase,
        rowId: recoveryCursorRowId(last.recovery_cursor_rowid),
      });
    }
    return {
      candidates,
      ...(nextCursor ? { nextCursor } : {}),
    };
  }

  quarantineCorruptRecoverableRun(
    runId: string,
    agentId: string,
    expectedAgentVersion: string,
    error: string,
  ): { changed: boolean; event?: HarnessEvent } {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare(`SELECT id, session_id, agent_id, agent_version, status
        FROM runs WHERE id = ?`).get(runId) as SqlRow | undefined;
      if (!row) throw new Error(`Recoverable run not found: ${runId}`);
      const durableAgentId = stringValue(row.agent_id);
      if (durableAgentId !== agentId) {
        throw new Error('Recoverable run does not belong to the requested agent lane');
      }
      const status = stringValue(row.status);
      if (status !== 'running' && status !== 'waiting_for_approval') {
        this.db.exec('COMMIT');
        return { changed: false };
      }
      const durableRunId = stringValue(row.id);
      const sessionId = stringValue(row.session_id);
      const actualAgentVersion = stringValue(row.agent_version);
      const runningInvocationRow = this.db.prepare(`SELECT COUNT(*) AS count
        FROM tool_invocations WHERE run_id = ? AND status = 'running'`)
        .get(durableRunId) as SqlRow;
      const priorRunningInvocationCount = numberValue(runningInvocationRow.count);
      const externalOutcomeUnknown = priorRunningInvocationCount > 0;
      const riskWarning = externalOutcomeUnknown
        ? ' One or more tool invocations were already marked running before recovery; their external outcome is unknown. Verify the effect before retrying.'
        : '';
      const baseLimit = 2_048 - riskWarning.length;
      const boundedBaseError = error.length <= baseLimit
        ? error
        : `${error.slice(0, baseLimit - 1)}…`;
      const boundedError = `${boundedBaseError}${riskWarning}`;
      const timestamp = now();
      const update = this.db.prepare(`UPDATE runs SET
        status = 'failed', error = ?, active_since = NULL, finished_at = ?, updated_at = ?
        WHERE id = ? AND agent_id = ? AND status IN ('running', 'waiting_for_approval')`)
        .run(boundedError, timestamp, timestamp, durableRunId, agentId);
      if (update.changes !== 1) {
        throw new Error(`Recoverable run changed while it was being quarantined: ${durableRunId}`);
      }
      const event = this.insertEvent(
        sessionId,
        durableRunId,
        'run.recovery.failed',
        {
          reason: 'corrupt_run_record',
          error: boundedError,
          expectedAgentVersion,
          actualAgentVersion,
          toolExecutionResumed: false,
          priorRunningInvocationCount,
          externalOutcomeUnknown,
          forensicMetadataPreserved: true,
        },
        timestamp,
      );
      this.db.exec('COMMIT');
      return { changed: true, event };
    } catch (failure) {
      this.db.exec('ROLLBACK');
      throw failure;
    }
  }

  latestRunForSession(sessionId: string): RunRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM runs WHERE session_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(sessionId) as SqlRow | undefined;
    return row ? mapRun(row) : undefined;
  }

  transitionRun(id: string, allowedFrom: RunStatus[], status: RunStatus, patch: Partial<Pick<RunRecord, 'output' | 'error' | 'step' | 'toolCalls'>> = {}): RunRecord {
    const current = this.getRun(id);
    if (!allowedFrom.includes(current.status)) {
      throw new Error(`Invalid run transition ${current.status} -> ${status} for ${id}`);
    }
    const timestamp = now();
    const startedAt = status === 'running' && !current.startedAt ? timestamp : current.startedAt ?? null;
    const finishedAt = ['succeeded', 'failed', 'cancelled'].includes(status) ? timestamp : current.finishedAt ?? null;
    const activeMs = accumulatedActiveMs(current, timestamp);
    const activeSince = status === 'running' ? timestamp : null;
    this.db
      .prepare(`UPDATE runs SET status = ?, output = ?, error = ?, step = ?, tool_calls = ?,
        active_ms = ?, active_since = ?, started_at = ?, finished_at = ?, updated_at = ? WHERE id = ?`)
      .run(
        status,
        patch.output ?? current.output ?? null,
        patch.error ?? current.error ?? null,
        patch.step ?? current.step,
        patch.toolCalls ?? current.toolCalls,
        activeMs,
        activeSince,
        startedAt,
        finishedAt,
        timestamp,
        id,
      );
    return this.getRun(id);
  }

  transitionRunAndAppend(
    id: string,
    allowedFrom: RunStatus[],
    status: RunStatus,
    eventType: string,
    eventData: JsonValue,
    patch: Partial<Pick<RunRecord, 'output' | 'error' | 'step' | 'toolCalls'>> = {},
  ): { run: RunRecord; event: HarnessEvent } {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as SqlRow | undefined;
      if (!row) throw new Error(`Run not found: ${id}`);
      const current = mapRun(row);
      if (!allowedFrom.includes(current.status)) {
        throw new Error(`Invalid run transition ${current.status} -> ${status} for ${id}`);
      }
      const timestamp = now();
      const startedAt = status === 'running' && !current.startedAt ? timestamp : current.startedAt ?? null;
      const finishedAt = ['succeeded', 'failed', 'cancelled'].includes(status) ? timestamp : current.finishedAt ?? null;
      const activeMs = accumulatedActiveMs(current, timestamp);
      const activeSince = status === 'running' ? timestamp : null;
      this.db
        .prepare(`UPDATE runs SET status = ?, output = ?, error = ?, step = ?, tool_calls = ?,
          active_ms = ?, active_since = ?, started_at = ?, finished_at = ?, updated_at = ? WHERE id = ?`)
        .run(
          status,
          patch.output ?? current.output ?? null,
          patch.error ?? current.error ?? null,
          patch.step ?? current.step,
          patch.toolCalls ?? current.toolCalls,
          activeMs,
          activeSince,
          startedAt,
          finishedAt,
          timestamp,
          id,
        );
      const event = this.insertEvent(current.sessionId, id, eventType, eventData, timestamp);
      this.db.exec('COMMIT');
      return { run: this.getRun(id), event };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  updateRunCounters(id: string, step: number, toolCalls: number): RunRecord {
    this.db.prepare('UPDATE runs SET step = ?, tool_calls = ?, updated_at = ? WHERE id = ?').run(step, toolCalls, now(), id);
    return this.getRun(id);
  }

  appendEvent(sessionId: string, runId: string, type: string, data: JsonValue): HarnessEvent {
    const timestamp = now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const event = this.insertEvent(sessionId, runId, type, data, timestamp);
      this.db.exec('COMMIT');
      return event;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private insertEvent(
    sessionId: string,
    runId: string,
    type: string,
    data: JsonValue,
    timestamp: string,
  ): HarnessEvent {
    const id = randomUUID();
    const seqRow = this.db
      .prepare('SELECT COALESCE(MAX(seq), -1) + 1 AS next_seq FROM events WHERE session_id = ?')
      .get(sessionId) as SqlRow;
    const seq = numberValue(seqRow.next_seq);
    this.db
      .prepare('INSERT INTO events (id, session_id, run_id, seq, type, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, sessionId, runId, seq, type, stringify(data), timestamp);
    return { id, sessionId, runId, seq, type, data, createdAt: timestamp };
  }

  /** Return the newest bounded inspection window in chronological order. */
  eventsForSession(sessionId: string, limit: number = STORAGE_READ_LIMITS.sessionEvents): HarnessEvent[] {
    const boundedLimit = storageReadLimit(limit, STORAGE_READ_LIMITS.sessionEvents, 'Session event history');
    return (this.db.prepare(`SELECT * FROM (
      SELECT * FROM events WHERE session_id = ? ORDER BY seq DESC LIMIT ?
    ) ORDER BY seq`).all(sessionId, boundedLimit) as SqlRow[]).map(mapEvent);
  }

  /** Return the newest bounded inspection window in chronological order. */
  eventsForRun(runId: string, limit: number = STORAGE_READ_LIMITS.runEvents): HarnessEvent[] {
    const boundedLimit = storageReadLimit(limit, STORAGE_READ_LIMITS.runEvents, 'Run event history');
    return (this.db.prepare(`SELECT * FROM (
      SELECT * FROM events WHERE run_id = ? ORDER BY seq DESC LIMIT ?
    ) ORDER BY seq`).all(runId, boundedLimit) as SqlRow[]).map(mapEvent);
  }

  /**
   * Read the complete post-compaction prompt context without ever hydrating an
   * unbounded session. Overflow is an explicit failure instead of a silent
   * mid-tool truncation, so callers can fail closed and ask for compaction.
   */
  contextEventsForSession(
    sessionId: string,
    limit: number = STORAGE_READ_LIMITS.sessionContextEvents,
  ): HarnessEvent[] {
    const boundedLimit = storageReadLimit(
      limit,
      STORAGE_READ_LIMITS.sessionContextEvents,
      'Session context event history',
    );
    const compaction = this.db.prepare(`SELECT seq FROM events
      WHERE session_id = ? AND type = 'context.compacted'
      ORDER BY seq DESC LIMIT 1`).get(sessionId) as SqlRow | undefined;
    const fromSeq = compaction ? numberValue(compaction.seq) : 0;
    const rows = this.db.prepare(`SELECT * FROM events
      WHERE session_id = ? AND seq >= ? ORDER BY seq LIMIT ?`)
      .all(sessionId, fromSeq, boundedLimit + 1) as SqlRow[];
    if (rows.length > boundedLimit) {
      throw new Error(
        `Session context exceeds the ${boundedLimit}-event materialization limit; compact the session before continuing`,
      );
    }
    return rows.map(mapEvent);
  }

  eventsForSessionPage(sessionId: string, options: SessionEventPageOptions = {}): HarnessEvent[] {
    const { afterSeq, throughSeq, limit } = eventPageBounds(options, 'Session event');
    return (this.db
      .prepare('SELECT * FROM events WHERE session_id = ? AND seq > ? AND seq <= ? ORDER BY seq LIMIT ?')
      .all(sessionId, afterSeq, throughSeq, limit) as SqlRow[]).map(mapEvent);
  }

  eventsForRunPage(runId: string, options: RunEventPageOptions = {}): HarnessEvent[] {
    const { afterSeq, throughSeq, limit } = eventPageBounds(options, 'Run event');
    return (this.db
      .prepare('SELECT * FROM events WHERE run_id = ? AND seq > ? AND seq <= ? ORDER BY seq LIMIT ?')
      .all(runId, afterSeq, throughSeq, limit) as SqlRow[]).map(mapEvent);
  }

  latestEventSeqForRun(runId: string): number | undefined {
    const row = this.db
      .prepare('SELECT MAX(seq) AS latest_seq FROM events WHERE run_id = ?')
      .get(runId) as SqlRow;
    return typeof row.latest_seq === 'number' ? row.latest_seq : undefined;
  }

  createToolBatch(runId: string, step: number): ToolBatchRecord {
    const id = randomUUID();
    const timestamp = now();
    this.db
      .prepare('INSERT INTO tool_batches (id, run_id, step, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, runId, step, 'pending', timestamp, timestamp);
    return this.getToolBatch(id);
  }

  getToolBatch(id: string): ToolBatchRecord {
    const row = this.db.prepare('SELECT * FROM tool_batches WHERE id = ?').get(id) as SqlRow | undefined;
    if (!row) throw new Error(`Tool batch not found: ${id}`);
    return mapToolBatch(row);
  }

  unflushedBatchForRun(runId: string): ToolBatchRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM tool_batches WHERE run_id = ? AND status != 'flushed' ORDER BY step LIMIT 1")
      .get(runId) as SqlRow | undefined;
    return row ? mapToolBatch(row) : undefined;
  }

  setToolBatchStatus(id: string, status: ToolBatchRecord['status']): void {
    this.db.prepare('UPDATE tool_batches SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), id);
  }

  flushToolBatch(id: string): HarnessEvent[] {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const batchRow = this.db
        .prepare(`SELECT b.*, r.session_id FROM tool_batches b JOIN runs r ON r.id = b.run_id WHERE b.id = ?`)
        .get(id) as SqlRow | undefined;
      if (!batchRow) throw new Error(`Tool batch not found: ${id}`);
      if (stringValue(batchRow.status) === 'flushed') {
        this.db.exec('COMMIT');
        return [];
      }
      const invocationRows = this.db
        .prepare('SELECT * FROM tool_invocations WHERE batch_id = ? ORDER BY call_index LIMIT ?')
        .all(id, STORAGE_READ_LIMITS.toolInvocations + 1) as SqlRow[];
      if (invocationRows.length > STORAGE_READ_LIMITS.toolInvocations) {
        throw new Error(`Tool batch exceeds the ${STORAGE_READ_LIMITS.toolInvocations}-invocation runtime limit`);
      }
      const invocations = invocationRows.map(mapToolInvocation);
      if (invocations.some((item) => item.status === 'pending_approval' || item.status === 'running')) {
        throw new Error(`Tool batch is not ready to flush: ${id}`);
      }
      const timestamp = now();
      const events: HarnessEvent[] = [];
      for (const invocation of invocations) {
        const result = invocation.result ?? {
          callId: invocation.callId,
          name: invocation.toolName,
          ok: false,
          error: { code: 'MISSING_TOOL_RESULT', message: 'The tool ended without a canonical result.' },
          durationMs: 0,
        };
        events.push(this.insertEvent(
          stringValue(batchRow.session_id),
          stringValue(batchRow.run_id),
          'tool.result',
          {
            step: numberValue(batchRow.step),
            batchId: id,
            callId: invocation.callId,
            name: invocation.toolName,
            argumentsDigest: invocation.argumentsDigest ?? null,
            result: JSON.parse(JSON.stringify(result)) as JsonValue,
          },
          timestamp,
        ));
      }
      events.push(this.insertEvent(
        stringValue(batchRow.session_id),
        stringValue(batchRow.run_id),
        'step.ended',
        { step: numberValue(batchRow.step), reason: 'tools_completed' },
        timestamp,
      ));
      this.db.prepare("UPDATE tool_batches SET status = 'flushed', updated_at = ? WHERE id = ?").run(timestamp, id);
      this.db.exec('COMMIT');
      return events;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  createToolInvocation(input: {
    batchId: string;
    runId: string;
    callId: string;
    callIndex: number;
    toolName: string;
    arguments: string;
    argumentsDigest?: string;
    effect?: string;
    policyDecision: string;
    status: ToolInvocationRecord['status'];
    idempotencyKey: string;
  }): ToolInvocationRecord {
    if (input.argumentsDigest !== undefined) {
      verifyCanonicalToolArguments(input.arguments, input.argumentsDigest);
    }
    const id = randomUUID();
    const timestamp = now();
    this.db
      .prepare(`INSERT INTO tool_invocations
        (id, batch_id, run_id, call_id, call_index, tool_name, arguments_json, arguments_digest, effect,
         policy_decision, status, idempotency_key, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        id,
        input.batchId,
        input.runId,
        input.callId,
        input.callIndex,
        input.toolName,
        input.arguments,
        input.argumentsDigest ?? null,
        input.effect ?? null,
        input.policyDecision,
        input.status,
        input.idempotencyKey,
        timestamp,
        timestamp,
      );
    return this.getToolInvocation(id);
  }

  getToolInvocation(id: string): ToolInvocationRecord {
    const row = this.db.prepare('SELECT * FROM tool_invocations WHERE id = ?').get(id) as SqlRow | undefined;
    if (!row) throw new Error(`Tool invocation not found: ${id}`);
    return mapToolInvocation(row);
  }

  listToolInvocations(
    batchId: string,
    limit: number = STORAGE_READ_LIMITS.toolInvocations,
  ): ToolInvocationRecord[] {
    const boundedLimit = storageReadLimit(limit, STORAGE_READ_LIMITS.toolInvocations, 'Tool invocation list');
    return (this.db
      .prepare('SELECT * FROM tool_invocations WHERE batch_id = ? ORDER BY call_index LIMIT ?')
      .all(batchId, boundedLimit) as SqlRow[]).map(mapToolInvocation);
  }

  listToolInvocationsForRun(
    runId: string,
    limit: number = STORAGE_READ_LIMITS.toolInvocations,
  ): ToolInvocationRecord[] {
    const boundedLimit = storageReadLimit(limit, STORAGE_READ_LIMITS.toolInvocations, 'Run tool invocation list');
    return (this.db
      .prepare('SELECT * FROM tool_invocations WHERE run_id = ? ORDER BY created_at, call_index, id LIMIT ?')
      .all(runId, boundedLimit) as SqlRow[]).map(mapToolInvocation);
  }

  finishToolInvocation(id: string, status: 'completed' | 'denied' | 'failed', result: ToolResult): ToolInvocationRecord {
    this.db
      .prepare('UPDATE tool_invocations SET status = ?, result_json = ?, updated_at = ? WHERE id = ?')
      .run(status, stringify(result as unknown as JsonValue), now(), id);
    return this.getToolInvocation(id);
  }

  createApproval(invocation: ToolInvocationRecord): ApprovalRecord {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const invocationRow = this.db.prepare(`SELECT i.*, r.workspace_id AS approval_workspace_id
        FROM tool_invocations i JOIN runs r ON r.id = i.run_id WHERE i.id = ?`)
        .get(invocation.id) as SqlRow | undefined;
      if (!invocationRow) throw new Error(`Tool invocation not found: ${invocation.id}`);
      const durableInvocation = mapToolInvocation(invocationRow);
      if (durableInvocation.status !== 'pending_approval') {
        throw new Error('Approval can only be created for a pending invocation');
      }
      if (durableInvocation.argumentsDigest !== undefined) {
        verifyCanonicalToolArguments(durableInvocation.arguments, durableInvocation.argumentsDigest);
      }
      const id = randomUUID();
      const timestamp = now();
      this.db
        .prepare(`INSERT INTO approvals
          (id, invocation_id, run_id, workspace_id, tool_name, arguments_json, arguments_digest,
           status, queue_order, requested_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?)`)
        .run(
          id,
          durableInvocation.id,
          durableInvocation.runId,
          stringValue(invocationRow.approval_workspace_id),
          durableInvocation.toolName,
          durableInvocation.arguments,
          durableInvocation.argumentsDigest ?? null,
          timestamp,
        );
      const approvalRow = this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as SqlRow;
      this.db.exec('COMMIT');
      return mapApproval(approvalRow);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  getApproval(id: string): ApprovalRecord {
    const row = this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as SqlRow | undefined;
    if (!row) throw new Error(`Approval not found: ${id}`);
    return mapApproval(row);
  }

  approvalWithInvocation(id: string): { approval: ApprovalRecord; invocation: ToolInvocationRecord } {
    const approval = this.getApproval(id);
    const row = this.db.prepare('SELECT invocation_id FROM approvals WHERE id = ?').get(id) as SqlRow;
    return { approval, invocation: this.getToolInvocation(stringValue(row.invocation_id)) };
  }

  listApprovals(
    runId?: string,
    status?: ApprovalRecord['status'],
    limit: number = STORAGE_READ_LIMITS.approvals,
  ): ApprovalRecord[] {
    const boundedLimit = storageReadLimit(limit, STORAGE_READ_LIMITS.approvals, 'Approval list');
    let query = 'SELECT * FROM approvals';
    const clauses: string[] = [];
    const params: SQLInputValue[] = [];
    if (runId) {
      clauses.push('run_id = ?');
      params.push(runId);
    }
    if (status) {
      clauses.push('status = ?');
      params.push(status);
    }
    if (clauses.length) query += ` WHERE ${clauses.join(' AND ')}`;
    query += ' ORDER BY requested_at DESC, id DESC LIMIT ?';
    params.push(boundedLimit);
    return (this.db.prepare(query).all(...params) as SqlRow[]).map(mapApproval);
  }

  listApprovalsPage(options: ApprovalPageOptions): ApprovalPage {
    const limit = approvalPageLimit(options.limit ?? 50);
    const cursor = options.cursor
      ? decodeApprovalCursor(options.cursor, options.workspaceId, options.status)
      : undefined;
    const clauses = ['workspace_id = ?'];
    const params: SQLInputValue[] = [options.workspaceId];
    if (options.status) {
      clauses.push('status = ?');
      params.push(options.status);
    }
    if (cursor) {
      clauses.push(`(queue_order > ? OR (queue_order = ? AND
        (requested_at < ? OR (requested_at = ? AND id < ?))))`);
      params.push(
        cursor.queueOrder,
        cursor.queueOrder,
        cursor.requestedAt,
        cursor.requestedAt,
        cursor.id,
      );
    }
    const rows = this.db.prepare(`SELECT * FROM approvals
      WHERE ${clauses.join(' AND ')}
      ORDER BY queue_order, requested_at DESC, id DESC
      LIMIT ?`).all(...params, limit + 1) as SqlRow[];
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const approvals = pageRows.map(mapApproval);
    const last = hasMore ? pageRows.at(-1) : undefined;
    return {
      approvals,
      ...(last
        ? {
            nextCursor: encodeApprovalCursor({
              workspaceId: options.workspaceId,
              ...(options.status ? { status: options.status } : {}),
              queueOrder: numberValue(last.queue_order),
              requestedAt: stringValue(last.requested_at),
              id: stringValue(last.id),
            }),
          }
        : {}),
    };
  }

  resolveApproval(
    id: string,
    decision: 'approve' | 'reject',
    actorId: string,
    reason?: string,
    expectedArgumentsDigest?: string,
  ): {
    approval: ApprovalRecord;
    invocation: ToolInvocationRecord;
    changed: boolean;
    event?: HarnessEvent;
  } {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as SqlRow | undefined;
      if (!row) throw new Error(`Approval not found: ${id}`);
      const current = mapApproval(row);
      const invocationRow = this.db
        .prepare('SELECT * FROM tool_invocations WHERE id = ?')
        .get(stringValue(row.invocation_id)) as SqlRow | undefined;
      if (!invocationRow) throw new ApprovalArgumentIntegrityError(id, 'linked invocation is missing');
      const currentInvocation = mapToolInvocation(invocationRow);
      this.assertApprovalInvocationIdentity(current, currentInvocation);
      if (expectedArgumentsDigest !== undefined && current.argumentsDigest !== expectedArgumentsDigest) {
        throw new ApprovalArgumentIntegrityError(id, 'reviewed digest is stale or does not match the pending approval');
      }
      if (decision === 'approve') {
        this.assertApprovalArgumentIntegrity(current, currentInvocation);
      }
      if (current.status !== 'pending') {
        const requested = decision === 'approve' ? 'approved' : 'rejected';
        if (current.status !== requested) throw new ApprovalDecisionConflictError(id, current.status);
        this.db.exec('COMMIT');
        return { approval: current, invocation: currentInvocation, changed: false };
      }
      if (currentInvocation.status !== 'pending_approval') {
        throw new ApprovalArgumentIntegrityError(id, 'linked invocation is not pending approval');
      }
      const status = decision === 'approve' ? 'approved' : 'rejected';
      const invocationStatus = decision === 'approve' ? 'running' : 'denied';
      const timestamp = now();
      const approvalUpdate = this.db
        .prepare(`UPDATE approvals SET status = ?, queue_order = 1,
          resolved_at = ?, resolved_by = ?, reason = ? WHERE id = ? AND status = 'pending'`)
        .run(status, timestamp, actorId, reason ?? null, id);
      if (approvalUpdate.changes !== 1) {
        throw new ApprovalArgumentIntegrityError(id, 'pending approval could not be updated');
      }
      const invocationUpdate = this.db
        .prepare(`UPDATE tool_invocations SET status = ?, updated_at = ?
          WHERE id = ? AND status = 'pending_approval'`)
        .run(invocationStatus, timestamp, stringValue(row.invocation_id));
      if (invocationUpdate.changes !== 1) {
        throw new ApprovalArgumentIntegrityError(id, 'linked invocation could not be updated');
      }
      const runRow = this.db.prepare('SELECT session_id FROM runs WHERE id = ?').get(stringValue(row.run_id)) as SqlRow;
      const event = this.insertEvent(
        stringValue(runRow.session_id),
        stringValue(row.run_id),
        'approval.resolved',
        {
          approvalId: id,
          invocationId: stringValue(row.invocation_id),
          decision,
          actorId,
          reason: reason ?? null,
          argumentsDigest: current.argumentsDigest ?? null,
        },
        timestamp,
      );
      const resolvedApprovalRow = this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as SqlRow;
      const resolvedInvocationRow = this.db
        .prepare('SELECT * FROM tool_invocations WHERE id = ?')
        .get(stringValue(row.invocation_id)) as SqlRow;
      this.db.exec('COMMIT');
      return {
        approval: mapApproval(resolvedApprovalRow),
        invocation: mapToolInvocation(resolvedInvocationRow),
        changed: true,
        event,
      };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private assertApprovalArgumentIntegrity(
    approval: ApprovalRecord,
    invocation: ToolInvocationRecord,
  ): void {
    if (!approval.argumentsDigest || !invocation.argumentsDigest) {
      throw new ApprovalArgumentIntegrityError(approval.id, 'legacy approval has no bound argument digest');
    }
    if (approval.arguments !== invocation.arguments) {
      throw new ApprovalArgumentIntegrityError(approval.id, 'approval arguments do not match invocation arguments');
    }
    if (approval.argumentsDigest !== invocation.argumentsDigest) {
      throw new ApprovalArgumentIntegrityError(approval.id, 'approval digest does not match invocation digest');
    }
    try {
      verifyCanonicalToolArguments(approval.arguments, approval.argumentsDigest);
      verifyCanonicalToolArguments(invocation.arguments, invocation.argumentsDigest);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'canonical argument verification failed';
      throw new ApprovalArgumentIntegrityError(approval.id, message);
    }
  }

  private assertApprovalInvocationIdentity(
    approval: ApprovalRecord,
    invocation: ToolInvocationRecord,
  ): void {
    if (approval.invocationId !== invocation.id || approval.runId !== invocation.runId) {
      throw new ApprovalArgumentIntegrityError(approval.id, 'approval identity does not match its invocation');
    }
    if (approval.toolName !== invocation.toolName) {
      throw new ApprovalArgumentIntegrityError(approval.id, 'approval tool does not match its invocation');
    }
  }

  putMemory(
    input: Omit<
      MemoryRecord,
      'id' | 'createdAt' | 'updatedAt' | 'strength' | 'reward' | 'accessCount' | 'lastAccessedAt'
    > & Partial<Pick<MemoryRecord, 'strength' | 'reward' | 'accessCount' | 'lastAccessedAt'>>,
  ): MemoryRecord {
    const existing = this.db
      .prepare(`SELECT * FROM memories
        WHERE workspace_id = ? AND source_type = ? AND source_id = ?
          AND COALESCE(project_id, '') = COALESCE(?, '')
          AND COALESCE(actor_id, '') = COALESCE(?, '')
        LIMIT 1`)
      .get(
        input.workspaceId,
        input.sourceType,
        input.sourceId,
        input.projectId ?? null,
        input.actorId ?? null,
      ) as SqlRow | undefined;
    if (existing) return mapMemory(existing);
    const id = randomUUID();
    const timestamp = now();
    this.db
      .prepare(`INSERT INTO memories
        (id, workspace_id, project_id, actor_id, kind, content, importance, strength,
         reward, access_count, last_accessed_at, source_type, source_id, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        id,
        input.workspaceId,
        input.projectId ?? null,
        input.actorId ?? null,
        input.kind,
        input.content,
        input.importance,
        input.strength ?? input.importance,
        input.reward ?? 0,
        input.accessCount ?? 0,
        input.lastAccessedAt ?? null,
        input.sourceType,
        input.sourceId,
        input.status,
        timestamp,
        timestamp,
      );
    return this.getMemory(id);
  }

  getMemory(id: string): MemoryRecord {
    const row = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as SqlRow | undefined;
    if (!row) throw new Error(`Memory not found: ${id}`);
    return mapMemory(row);
  }

  setMemoryStatus(id: string, workspaceId: string, status: MemoryRecord['status']): MemoryRecord {
    const result = this.db.prepare(`UPDATE memories SET status = ?, updated_at = ?
      WHERE id = ? AND workspace_id = ?`).run(status, now(), id, workspaceId);
    if (Number(result.changes) !== 1) throw new Error(`Memory not found in workspace: ${id}`);
    return this.getMemory(id);
  }

  searchMemories(scope: { workspaceId: string; projectId?: string; actorId?: string }, query: string, limit = 6): MemoryRecord[] {
    const boundedLimit = storageReadLimit(limit, 100, 'Memory search');
    const rows = this.db
      .prepare(`SELECT * FROM memories
        WHERE workspace_id = ? AND status = 'active'
          AND (project_id IS NULL OR project_id = ?)
          AND (actor_id IS NULL OR actor_id = ?)
        ORDER BY strength DESC, importance DESC, updated_at DESC
        LIMIT 200`)
      .all(scope.workspaceId, scope.projectId ?? null, scope.actorId ?? null) as SqlRow[];
    const terms = tokenize(query);
    return rows
      .map(mapMemory)
      .map((memory) => {
        const lexical = lexicalScore(memory.content, terms);
        return {
          memory,
          lexical,
          score:
          lexical +
          memory.importance * 0.2 +
          memory.strength * 0.35 +
          memory.reward * 0.15,
        };
      })
      // Strength/reward can rerank evidence but can never manufacture relevance.
      .filter((entry) => entry.lexical > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, boundedLimit)
      .map((entry) => entry.memory);
  }

  searchMemoriesHybrid(
    scope: { workspaceId: string; projectId?: string; actorId?: string },
    query: string,
    queryVector: number[],
    model: string,
    limit = 6,
  ): MemoryRecord[] {
    const boundedLimit = storageReadLimit(limit, 100, 'Hybrid memory search');
    const rows = this.db
      .prepare(`SELECT memories.*, memory_embeddings.vector_json, memory_embeddings.model AS embedding_model
        FROM memories
        LEFT JOIN memory_embeddings ON memory_embeddings.memory_id = memories.id
        WHERE memories.workspace_id = ? AND memories.status = 'active'
          AND (memories.project_id IS NULL OR memories.project_id = ?)
          AND (memories.actor_id IS NULL OR memories.actor_id = ?)
        ORDER BY memories.strength DESC, memories.updated_at DESC
        LIMIT 500`)
      .all(scope.workspaceId, scope.projectId ?? null, scope.actorId ?? null) as SqlRow[];
    const terms = tokenize(query);
    const ranked = rows.map((row) => {
      const memory = mapMemory(row);
      const embedded = nullableString(row.embedding_model) === model && typeof row.vector_json === 'string'
        ? parseNumberArray(row.vector_json)
        : undefined;
      const semantic = embedded && embedded.length === queryVector.length ? cosineSimilarity(queryVector, embedded) : 0;
      const lexical = lexicalScore(memory.content, terms);
      const score = semantic * 0.58 + Math.min(1, lexical / 3) * 0.2 + memory.strength * 0.17 + memory.reward * 0.05;
      return { memory, score, semantic, lexical };
    });
    const selected = ranked
      // A record must actually match. This prevents strong but unrelated memory
      // from leaking into every prompt merely because its prior is positive.
      .filter((entry) => entry.lexical > 0 || entry.semantic >= 0.2)
      .sort((left, right) => right.score - left.score)
      .slice(0, boundedLimit)
      .map((entry) => entry.memory);
    return selected;
  }

  putMemoryEmbedding(memoryId: string, model: string, vector: number[]): void {
    this.getMemory(memoryId);
    if (!vector.length || vector.some((value) => !Number.isFinite(value))) {
      throw new Error('Embedding vector must contain finite numbers');
    }
    const timestamp = now();
    this.db.prepare(`INSERT INTO memory_embeddings
      (memory_id, model, dimensions, vector_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(memory_id) DO UPDATE SET model = excluded.model,
      dimensions = excluded.dimensions, vector_json = excluded.vector_json, updated_at = excluded.updated_at`)
      .run(memoryId, model, vector.length, JSON.stringify(vector), timestamp, timestamp);
  }

  recordMemoryUsage(runId: string, memoryIds: string[]): void {
    const uniqueMemoryIds = [...new Set(memoryIds)];
    if (uniqueMemoryIds.length > 100) throw new Error('Run memory usage exceeds the 100-record limit');
    if (uniqueMemoryIds.some((memoryId) => typeof memoryId !== 'string' || !memoryId)) {
      throw new Error('Run memory usage contains an invalid memory ID');
    }
    const timestamp = now();
    const visible = this.db.prepare(`SELECT 1 FROM memories
      WHERE id = ? AND workspace_id = ? AND status = 'active'
        AND (project_id IS NULL OR project_id = ?)
        AND (actor_id IS NULL OR actor_id = ?)`);
    const insert = this.db.prepare(`INSERT OR IGNORE INTO run_memory_usage
      (run_id, memory_id, retrieved_at) VALUES (?, ?, ?)`);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const run = this.getRun(runId);
      for (const memoryId of uniqueMemoryIds) {
        if (!visible.get(memoryId, run.workspaceId, run.projectId ?? null, run.actorId)) {
          throw new Error('Run memory usage contains a memory outside the run visibility scope');
        }
      }
      const newlyExposed: string[] = [];
      for (const memoryId of uniqueMemoryIds) {
        if (Number(insert.run(runId, memoryId, timestamp).changes) === 1) newlyExposed.push(memoryId);
      }
      this.touchMemories(newlyExposed, timestamp);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  reinforceRunMemories(
    runId: string,
    workspaceId: string,
    reward: number,
    learningRate: number,
    feedbackId: string,
  ): MemoryRecord[] {
    const run = this.getRun(runId);
    if (run.workspaceId !== workspaceId) {
      throw new Error('Run memory reinforcement workspace does not match the run');
    }
    const feedback = this.getFeedback(feedbackId);
    if (feedback.runId !== runId) throw new Error('Memory reinforcement feedback does not match the run');
    validateReinforcementReward(reward, feedback.score);
    if (!Number.isFinite(learningRate)) throw new Error('Memory reinforcement learning rate must be finite');
    const boundedReward = feedback.score;
    const rate = Math.max(0.01, Math.min(1, learningRate));
    const rows = this.db.prepare(`SELECT memories.* FROM memories
      JOIN run_memory_usage ON run_memory_usage.memory_id = memories.id
      WHERE run_memory_usage.run_id = ? AND memories.workspace_id = ?
      ORDER BY memories.id LIMIT 101`)
      .all(runId, workspaceId) as SqlRow[];
    if (rows.length > 100) throw new Error('Run memory reinforcement exceeds the 100-record limit');
    const update = this.db.prepare(`UPDATE memories SET
      reward = MAX(-1, MIN(1, reward * (1 - ?) + ? * ?)),
      strength = MAX(0.05, MIN(1, strength + ? * ?)),
      updated_at = ? WHERE id = ? AND workspace_id = ?`);
    const mark = this.db.prepare(`INSERT OR IGNORE INTO memory_feedback_applications
      (feedback_id, run_id, memory_id, reward, learning_rate, applied_at)
      VALUES (?, ?, ?, ?, ?, ?)`);
    const applied: MemoryRecord[] = [];
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of rows) {
        const memoryId = stringValue(row.id);
        const timestamp = now();
        if (Number(mark.run(feedbackId, runId, memoryId, boundedReward, rate, timestamp).changes) === 0) continue;
        update.run(rate, boundedReward, rate, boundedReward, rate * 0.25, timestamp, memoryId, workspaceId);
        this.addLearningSignal({
          workspaceId,
          runId,
          memoryId,
          kind: 'memory_reward',
          reward: boundedReward,
          metadata: { feedbackId, learningRate: rate },
        });
        applied.push(this.getMemory(memoryId));
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return applied;
  }

  private touchMemories(memoryIds: string[], timestamp = now()): void {
    const update = this.db.prepare(`UPDATE memories SET access_count = access_count + 1,
      last_accessed_at = ?, updated_at = ? WHERE id = ?`);
    for (const memoryId of [...new Set(memoryIds)]) update.run(timestamp, timestamp, memoryId);
  }

  listMemories(workspaceId: string, projectId?: string, limit = 100): MemoryRecord[] {
    const boundedLimit = storageReadLimit(limit, STORAGE_READ_LIMITS.memories, 'Memory list');
    const rows = projectId
      ? (this.db
          .prepare(`SELECT * FROM memories WHERE workspace_id = ? AND (project_id IS NULL OR project_id = ?)
            ORDER BY updated_at DESC, id DESC LIMIT ?`)
          .all(workspaceId, projectId, boundedLimit) as SqlRow[])
      : (this.db
          .prepare('SELECT * FROM memories WHERE workspace_id = ? ORDER BY updated_at DESC, id DESC LIMIT ?')
          .all(workspaceId, boundedLimit) as SqlRow[]);
    return rows.map(mapMemory);
  }

  addLearningSignal(input: {
    workspaceId: string;
    runId?: string;
    memoryId?: string;
    routeId?: string;
    kind: 'memory_reward' | 'route_reward' | 'group_observation';
    reward: number;
    metadata: JsonObject;
  }): string {
    const id = randomUUID();
    this.db.prepare(`INSERT INTO learning_signals
      (id, workspace_id, run_id, memory_id, route_id, kind, reward, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        id,
        input.workspaceId,
        input.runId ?? null,
        input.memoryId ?? null,
        input.routeId ?? null,
        input.kind,
        input.reward,
        stringify(input.metadata),
        now(),
      );
    return id;
  }

  upsertGroupSpace(input: {
    workspaceId: string;
    source: string;
    externalId: string;
    title?: string;
    projectId?: string;
    learningEnabled: boolean;
    notificationsEnabled: boolean;
    createdBy: string;
  }): GroupSpaceRecord {
    const existing = this.findGroupSpace(input.source, input.externalId);
    const timestamp = now();
    if (existing) {
      if (existing.workspaceId !== input.workspaceId) {
        throw new Error('Group space is already bound to a different workspace');
      }
      this.db.prepare(`UPDATE group_spaces SET workspace_id = ?, title = ?, project_id = ?,
        learning_enabled = ?, notifications_enabled = ?, updated_at = ? WHERE id = ?`)
        .run(
          input.workspaceId,
          input.title ?? null,
          input.projectId ?? null,
          input.learningEnabled ? 1 : 0,
          input.notificationsEnabled ? 1 : 0,
          timestamp,
          existing.id,
        );
      return this.getGroupSpace(existing.id);
    }
    const id = randomUUID();
    this.db.prepare(`INSERT INTO group_spaces
      (id, workspace_id, source, external_id, title, project_id, learning_enabled,
       notifications_enabled, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        id,
        input.workspaceId,
        input.source,
        input.externalId,
        input.title ?? null,
        input.projectId ?? null,
        input.learningEnabled ? 1 : 0,
        input.notificationsEnabled ? 1 : 0,
        input.createdBy,
        timestamp,
        timestamp,
      );
    return this.getGroupSpace(id);
  }

  getGroupSpace(id: string): GroupSpaceRecord {
    const row = this.db.prepare('SELECT * FROM group_spaces WHERE id = ?').get(id) as SqlRow | undefined;
    if (!row) throw new Error(`Group space not found: ${id}`);
    return mapGroupSpace(row);
  }

  findGroupSpace(source: string, externalId: string): GroupSpaceRecord | undefined {
    const row = this.db.prepare('SELECT * FROM group_spaces WHERE source = ? AND external_id = ?')
      .get(source, externalId) as SqlRow | undefined;
    return row ? mapGroupSpace(row) : undefined;
  }

  listGroupSpaces(
    workspaceId: string,
    limit: number = STORAGE_READ_LIMITS.groupSpaces,
  ): GroupSpaceRecord[] {
    const boundedLimit = storageReadLimit(limit, STORAGE_READ_LIMITS.groupSpaces, 'Group space list');
    return (this.db.prepare(`SELECT * FROM group_spaces WHERE workspace_id = ?
      ORDER BY updated_at DESC, id DESC LIMIT ?`)
      .all(workspaceId, boundedLimit) as SqlRow[]).map(mapGroupSpace);
  }

  disableGroupSpace(source: string, externalId: string): GroupSpaceRecord | undefined {
    const group = this.findGroupSpace(source, externalId);
    if (!group) return undefined;
    this.db.prepare(`UPDATE group_spaces SET learning_enabled = 0,
      notifications_enabled = 0, updated_at = ? WHERE id = ?`).run(now(), group.id);
    return this.getGroupSpace(group.id);
  }

  recordGroupMessage(input: {
    groupSpaceId: string;
    workspaceId: string;
    externalMessageId: string;
    actorId: string;
    text: string;
    transcript: boolean;
    salient: boolean;
    occurredAt: string;
  }): { message: GroupMessageRecord; duplicate: boolean } {
    const group = this.getGroupSpace(input.groupSpaceId);
    if (group.workspaceId !== input.workspaceId) throw new Error('Group message workspace scope mismatch');
    const existing = this.db.prepare(`SELECT * FROM group_messages
      WHERE group_space_id = ? AND external_message_id = ?`)
      .get(input.groupSpaceId, input.externalMessageId) as SqlRow | undefined;
    if (existing) return { message: mapGroupMessage(existing), duplicate: true };
    const id = randomUUID();
    this.db.prepare(`INSERT INTO group_messages
      (id, group_space_id, workspace_id, external_message_id, actor_id, text,
       transcript, salient, occurred_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        id,
        input.groupSpaceId,
        input.workspaceId,
        input.externalMessageId,
        input.actorId,
        input.text,
        input.transcript ? 1 : 0,
        input.salient ? 1 : 0,
        input.occurredAt,
        now(),
      );
    const row = this.db.prepare('SELECT * FROM group_messages WHERE id = ?').get(id) as SqlRow;
    return { message: mapGroupMessage(row), duplicate: false };
  }

  listGroupMessages(groupSpaceId: string, limit = 100): GroupMessageRecord[] {
    const boundedLimit = storageReadLimit(limit, STORAGE_READ_LIMITS.groupMessages, 'Group message list');
    return (this.db.prepare(`SELECT * FROM group_messages WHERE group_space_id = ?
      ORDER BY occurred_at DESC, id DESC LIMIT ?`).all(groupSpaceId, boundedLimit) as SqlRow[]).map(mapGroupMessage);
  }

  purgeGroupMessagesBefore(cutoff: string): number {
    const result = this.db.prepare('DELETE FROM group_messages WHERE occurred_at < ?').run(cutoff);
    return Number(result.changes);
  }

  forgetGroupData(groupSpaceId: string): JsonObject {
    const group = this.getGroupSpace(groupSpaceId);
    let memoriesDeleted = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const memoryRows = this.db.prepare(`WITH provenance(message_id, memory_id) AS (
          SELECT id, NULL FROM group_messages WHERE group_space_id = ?
          UNION ALL
          SELECT
            CASE WHEN json_valid(metadata_json)
              AND json_type(metadata_json, '$.messageId') = 'text'
              THEN json_extract(metadata_json, '$.messageId') END,
            COALESCE(
              memory_id,
              CASE WHEN json_valid(metadata_json)
                AND json_type(metadata_json, '$.memoryId') = 'text'
                THEN json_extract(metadata_json, '$.memoryId') END
            )
          FROM learning_signals
          WHERE kind = 'group_observation'
            AND json_valid(metadata_json)
            AND json_extract(metadata_json, '$.groupSpaceId') = ?
        ), candidate_ids(id) AS (
          SELECT memories.id FROM memories
          JOIN provenance ON provenance.message_id = memories.source_id
          WHERE memories.source_type = 'group_observation'
          UNION
          SELECT memories.id FROM memories
          JOIN provenance ON provenance.memory_id = memories.id
          WHERE memories.source_type = 'group_observation'
        )
        SELECT id FROM candidate_ids ORDER BY id`).all(groupSpaceId, groupSpaceId) as SqlRow[];
      const detachSignal = this.db.prepare('UPDATE learning_signals SET memory_id = NULL WHERE memory_id = ?');
      const deleteUsage = this.db.prepare('DELETE FROM run_memory_usage WHERE memory_id = ?');
      const deleteApplications = this.db.prepare('DELETE FROM memory_feedback_applications WHERE memory_id = ?');
      const deleteMemory = this.db.prepare('DELETE FROM memories WHERE id = ?');
      for (const row of memoryRows) {
        const id = stringValue(row.id);
        detachSignal.run(id);
        deleteUsage.run(id);
        deleteApplications.run(id);
        memoriesDeleted += Number(deleteMemory.run(id).changes);
      }
      const messagesDeleted = Number(this.db.prepare('DELETE FROM group_messages WHERE group_space_id = ?')
        .run(groupSpaceId).changes);
      const notificationsDeleted = Number(this.db.prepare(`DELETE FROM notifications
        WHERE group_space_id = ? AND status <> 'sending'`).run(groupSpaceId).changes);
      const signalsDeleted = Number(this.db.prepare(`DELETE FROM learning_signals
        WHERE kind = 'group_observation'
          AND json_extract(metadata_json, '$.groupSpaceId') = ?`).run(groupSpaceId).changes);
      this.db.prepare(`UPDATE group_spaces SET learning_enabled = 0,
        notifications_enabled = 0, updated_at = ? WHERE id = ?`).run(now(), groupSpaceId);
      this.db.exec('COMMIT');
      return {
        groupSpaceId,
        workspaceId: group.workspaceId,
        messagesDeleted,
        memoriesDeleted,
        notificationsDeleted,
        signalsDeleted,
        bindingRetainedDisabled: true,
      };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  modelRouteStats(task: ModelTask, runId?: string, routeIds?: readonly string[]): ModelRouteStats[] {
    const currentRouteIds = validateStatsRouteIds(routeIds);
    if (currentRouteIds?.length === 0) return [];
    if (!runId) {
      const routeFilter = currentRouteIds
        ? ` AND route_id IN (${currentRouteIds.map(() => '?').join(', ')})`
        : '';
      return (this.db.prepare(`SELECT * FROM model_route_stats
        WHERE task = ?${routeFilter} ORDER BY route_id LIMIT 32`)
        .all(task, ...(currentRouteIds ?? [])) as SqlRow[]).map(mapModelRouteStats);
    }
    const workspaceId = this.getRun(runId).workspaceId;
    return this.modelRouteStatsForWorkspace(task, workspaceId, currentRouteIds);
  }

  private modelRouteStatsForWorkspace(
    task: ModelTask,
    workspaceId: string,
    routeIds?: readonly string[],
  ): ModelRouteStats[] {
    const routeFilter = routeIds
      ? ` AND calls.route_id IN (${routeIds.map(() => '?').join(', ')})`
      : '';
    return (this.db.prepare(`WITH scoped_rewards AS (
      SELECT route_id, SUM(reward) AS reward_sum, COUNT(*) AS reward_count
      FROM learning_signals
      WHERE workspace_id = ? AND kind = 'route_reward'
        AND route_id IS NOT NULL
        AND json_valid(metadata_json)
        AND json_extract(metadata_json, '$.task') = ?
      GROUP BY route_id
    )
    SELECT calls.route_id, calls.task,
      COUNT(*) AS attempts,
      SUM(calls.success) AS successes,
      COALESCE(scoped_rewards.reward_sum, 0) AS reward_sum,
      COALESCE(scoped_rewards.reward_count, 0) AS reward_count,
      SUM(calls.cost_usd) AS cost_usd,
      SUM(calls.latency_ms) AS latency_ms,
      MAX(calls.created_at) AS updated_at
    FROM model_route_calls AS calls
    JOIN runs ON runs.id = calls.run_id
    LEFT JOIN scoped_rewards ON scoped_rewards.route_id = calls.route_id
    WHERE calls.task = ? AND runs.workspace_id = ?${routeFilter}
    GROUP BY calls.route_id, calls.task, scoped_rewards.reward_sum, scoped_rewards.reward_count
    ORDER BY calls.route_id LIMIT 32`)
      .all(workspaceId, task, task, workspaceId, ...(routeIds ?? [])) as SqlRow[]).map(mapModelRouteStats);
  }

  recordModelRouteCall(input: {
    runId: string;
    selection: ModelRouteSelection;
    statsRouteId?: string;
    success: boolean;
    costUsd: number;
    latencyMs: number;
  }): void {
    this.getRun(input.runId);
    const statsRouteId = validateStatsRouteId(input.statsRouteId ?? input.selection.routeId);
    const id = randomUUID();
    const timestamp = now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`INSERT INTO model_route_calls
        (id, run_id, route_id, task, success, cost_usd, latency_ms, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          id,
          input.runId,
          statsRouteId,
          input.selection.task,
          input.success ? 1 : 0,
          input.costUsd,
          input.latencyMs,
          timestamp,
        );
      this.db.prepare(`INSERT INTO model_route_stats
        (route_id, task, attempts, successes, reward_sum, reward_count, cost_usd, latency_ms, updated_at)
        VALUES (?, ?, 1, ?, 0, 0, ?, ?, ?)
        ON CONFLICT(route_id, task) DO UPDATE SET attempts = attempts + 1,
        successes = successes + excluded.successes, cost_usd = cost_usd + excluded.cost_usd,
        latency_ms = latency_ms + excluded.latency_ms, updated_at = excluded.updated_at`)
        .run(statsRouteId, input.selection.task, input.success ? 1 : 0, input.costUsd, input.latencyMs, timestamp);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  reinforceRunRoutes(
    runId: string,
    workspaceId: string,
    reward: number,
    feedbackId: string,
  ): string[] {
    const run = this.getRun(runId);
    if (run.workspaceId !== workspaceId) {
      throw new Error('Run route reinforcement workspace does not match the run');
    }
    const feedback = this.getFeedback(feedbackId);
    if (feedback.runId !== runId) {
      throw new Error('Route reinforcement feedback does not match the run');
    }
    validateReinforcementReward(reward, feedback.score);
    const bounded = feedback.score;
    const rows = this.db.prepare(`SELECT DISTINCT route_id, task FROM model_route_calls
      WHERE run_id = ? AND success = 1 ORDER BY route_id, task LIMIT 33`).all(runId) as SqlRow[];
    if (rows.length > 32) throw new Error('Run route reinforcement exceeds the 32-route limit');
    const update = this.db.prepare(`UPDATE model_route_stats SET reward_sum = reward_sum + ?,
      reward_count = reward_count + 1, updated_at = ? WHERE route_id = ? AND task = ?`);
    const apply = this.db.prepare(`INSERT OR IGNORE INTO route_feedback_applications
      (feedback_id, route_id, task, applied_at) VALUES (?, ?, ?, ?)`);
    const routeIds: string[] = [];
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of rows) {
        const routeId = stringValue(row.route_id);
        const task = stringValue(row.task);
        const timestamp = now();
        if (Number(apply.run(feedbackId, routeId, task, timestamp).changes) === 0) continue;
        update.run(bounded, timestamp, routeId, task);
        this.addLearningSignal({
          workspaceId,
          runId,
          routeId,
          kind: 'route_reward',
          reward: bounded,
          metadata: { task, feedbackId },
        });
        routeIds.push(routeId);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return routeIds;
  }

  modelSpendSince(since: string): number {
    const row = this.db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS total FROM model_route_calls WHERE created_at >= ?')
      .get(since) as SqlRow;
    return numberValue(row.total);
  }

  learningStats(workspaceId: string): JsonObject {
    const memory = this.db.prepare(`SELECT COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END), 0) AS active,
      COALESCE(SUM(CASE WHEN status = 'proposed' THEN 1 ELSE 0 END), 0) AS proposed,
      COALESCE(AVG(strength), 0) AS average_strength,
      COALESCE(AVG(reward), 0) AS average_reward
      FROM memories WHERE workspace_id = ?`).get(workspaceId) as SqlRow;
    const groups = this.db.prepare(`SELECT COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN learning_enabled = 1 THEN 1 ELSE 0 END), 0) AS learning
      FROM group_spaces WHERE workspace_id = ?`).get(workspaceId) as SqlRow;
    const signals = this.db.prepare('SELECT COUNT(*) AS total FROM learning_signals WHERE workspace_id = ?')
      .get(workspaceId) as SqlRow;
    const oracle = this.db.prepare(`SELECT COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END), 0) AS active,
      COALESCE(SUM(CASE WHEN status = 'deleted' THEN 1 ELSE 0 END), 0) AS deleted,
      COALESCE(SUM(revision), 0) AS revisions
      FROM oracle_records WHERE workspace_id = ?`).get(workspaceId) as SqlRow;
    const oracleSources = this.db.prepare(`SELECT COUNT(*) AS total
      FROM oracle_sync_state WHERE workspace_id = ?`).get(workspaceId) as SqlRow;
    return {
      memories: {
        total: numberValue(memory.total),
        active: numberValue(memory.active),
        proposed: numberValue(memory.proposed),
        averageStrength: numberValue(memory.average_strength),
        averageReward: numberValue(memory.average_reward),
      },
      groups: { total: numberValue(groups.total), learningEnabled: numberValue(groups.learning) },
      corporateOracle: {
        records: numberValue(oracle.total),
        active: numberValue(oracle.active),
        deleted: numberValue(oracle.deleted),
        sourceVersions: numberValue(oracle.revisions),
        sourceStreams: numberValue(oracleSources.total),
      },
      learningSignals: numberValue(signals.total),
      modelRoutes: ['supervisor', 'project_analysis', 'memory_curator', 'summarization', 'notification']
        .flatMap((task) => this.modelRouteStatsForWorkspace(task as ModelTask, workspaceId).map((stats) => ({
          routeId: stats.routeId,
          task: stats.task,
          attempts: stats.attempts,
          successes: stats.successes,
          averageReward: stats.rewardCount ? stats.rewardSum / stats.rewardCount : 0,
          costUsd: stats.costUsd,
          averageLatencyMs: stats.attempts ? stats.latencyMs / stats.attempts : 0,
        }))),
    };
  }

  /**
   * Commit one bounded connector page and its resume checkpoint atomically.
   * Mutable heads make current reads cheap; append-only versions preserve what
   * the harness knew at an earlier source timestamp.
   */
  ingestCorporateBatch(
    records: readonly PreparedCorporateRecord[],
    checkpoint: CorporateBatchCheckpoint,
  ): CorporateBatchStorageResult {
    for (const record of records) {
      if (
        record.workspaceId !== checkpoint.workspaceId
        || record.source !== checkpoint.source
        || record.sourceAccountId !== checkpoint.sourceAccountId
        || record.stream !== checkpoint.stream
      ) {
        throw new Error('Corporate batch records must match the checkpoint scope');
      }
    }
    const find = this.db.prepare(`SELECT * FROM oracle_records
      WHERE workspace_id = ? AND source = ? AND stream = ? AND external_id = ?`);
    const insert = this.db.prepare(`INSERT INTO oracle_records
      (id, workspace_id, source, source_account_id, stream, external_id, domain, record_type, project_id,
       title, content, source_url, source_version, occurred_at, source_updated_at,
       observed_at, status, content_sha256, revision, metadata_json, ingested_by,
       created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const update = this.db.prepare(`UPDATE oracle_records SET
      domain = ?, record_type = ?, project_id = ?, title = ?, content = ?, source_url = ?,
      source_version = ?, occurred_at = ?, source_updated_at = ?, observed_at = ?,
      status = ?, content_sha256 = ?, revision = ?, metadata_json = ?, ingested_by = ?,
      updated_at = ? WHERE id = ?`);
    const insertVersion = this.db.prepare(`INSERT INTO oracle_record_versions
      (record_id, revision, workspace_id, source, source_account_id, stream, external_id, domain, record_type,
       project_id, title, content, source_url, source_version, occurred_at, source_updated_at,
       observed_at, status, content_sha256, metadata_json, ingested_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const deleteEmbedding = this.db.prepare(
      'DELETE FROM oracle_record_embeddings WHERE record_id = ?',
    );
    const checkpointRow = this.db.prepare(`SELECT * FROM oracle_sync_state
      WHERE workspace_id = ? AND source = ? AND stream = ?`);
    const acceptedPageRow = this.db.prepare(`SELECT * FROM oracle_sync_pages
      WHERE workspace_id = ? AND source = ? AND stream = ? AND page_key = ?`);
    const insertAcceptedPage = this.db.prepare(`INSERT INTO oracle_sync_pages
      (workspace_id, source, source_account_id, stream, page_key, previous_cursor,
       cursor, batch_sha256, record_count, accepted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const upsertCheckpoint = this.db.prepare(`INSERT INTO oracle_sync_state
      (workspace_id, source, source_account_id, stream, cursor, source_watermark, last_batch_sha256,
       records_seen, last_success_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, source, stream) DO UPDATE SET
        source_account_id = excluded.source_account_id,
        cursor = excluded.cursor,
        source_watermark = excluded.source_watermark,
        last_batch_sha256 = excluded.last_batch_sha256,
        records_seen = excluded.records_seen,
        last_success_at = excluded.last_success_at,
        updated_at = excluded.updated_at`);

    const recordIds: string[] = [];
    const changedRecordIds: string[] = [];
    let inserted = 0;
    let updated = 0;
    let unchanged = 0;
    let stale = 0;
    const transactionTime = now();
    const pageKey = corporatePageKey(checkpoint.cursor, checkpoint.batchSha256);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const currentCheckpoint = checkpointRow.get(
        checkpoint.workspaceId,
        checkpoint.source,
        checkpoint.stream,
      ) as SqlRow | undefined;
      if (
        currentCheckpoint
        && stringValue(currentCheckpoint.source_account_id) !== checkpoint.sourceAccountId
      ) {
        throw new CorporateSourceConflictError('Corporate sync provider account identity changed');
      }
      const acceptedPage = acceptedPageRow.get(
        checkpoint.workspaceId,
        checkpoint.source,
        checkpoint.stream,
        pageKey,
      ) as SqlRow | undefined;
      if (
        acceptedPage
        && (
          stringValue(acceptedPage.source_account_id) !== checkpoint.sourceAccountId
          || stringValue(acceptedPage.batch_sha256) !== checkpoint.batchSha256
          || nullableString(acceptedPage.previous_cursor) !== checkpoint.previousCursor
          || nullableString(acceptedPage.cursor) !== checkpoint.cursor
        )
      ) {
        throw new CorporateSourceConflictError('A corporate sync cursor was replayed with different content');
      }
      const replay = acceptedPage !== undefined;
      if (
        currentCheckpoint
        && checkpoint.cursor !== undefined
        && nullableString(currentCheckpoint.cursor) === checkpoint.cursor
        && stringValue(currentCheckpoint.last_batch_sha256) !== checkpoint.batchSha256
      ) {
        throw new CorporateSourceConflictError('A corporate sync cursor was replayed with different content');
      }

      if (!replay) {
        const currentCursor = currentCheckpoint
          ? nullableString(currentCheckpoint.cursor)
          : undefined;
        if (currentCursor !== undefined) {
          if (checkpoint.cursor === undefined) {
            throw new CorporateSourceConflictError(
              'A cursor-bearing corporate sync stream cannot advance with a cursorless page',
            );
          }
          if (checkpoint.previousCursor !== currentCursor) {
            throw new CorporateSourceConflictError(
              'Corporate sync page does not continue from the current checkpoint cursor',
            );
          }
        } else if (checkpoint.previousCursor !== undefined) {
          throw new CorporateSourceConflictError(
            'Corporate sync page supplied a previous cursor before a checkpoint cursor exists',
          );
        }
      }

      if (replay) {
        for (const record of records) {
          const existingRow = find.get(
            record.workspaceId,
            record.source,
            record.stream,
            record.externalId,
          ) as SqlRow | undefined;
          if (!existingRow) {
            throw new CorporateSourceConflictError('Corporate replay checkpoint no longer matches retained heads');
          }
          const existing = mapCorporateRecord(existingRow);
          if (existing.sourceAccountId !== record.sourceAccountId) {
            throw new CorporateSourceConflictError('Corporate replay checkpoint no longer matches retained heads');
          }
          unchanged += 1;
          recordIds.push(existing.id);
        }
      } else {
        for (const record of records) {
          const existingRow = find.get(
            record.workspaceId,
            record.source,
            record.stream,
            record.externalId,
          ) as SqlRow | undefined;
          if (!existingRow) {
            const id = randomUUID();
            const revision = 1;
            insert.run(
              id,
              record.workspaceId,
              record.source,
              record.sourceAccountId,
              record.stream,
              record.externalId,
              record.domain,
              record.recordType,
              record.projectId ?? null,
              record.title,
              record.content,
              record.sourceUrl ?? null,
              record.sourceVersion ?? null,
              record.occurredAt,
              record.sourceUpdatedAt,
              record.observedAt,
              record.status,
              record.contentSha256,
              revision,
              JSON.stringify(record.metadata),
              record.ingestedBy,
              transactionTime,
              transactionTime,
            );
            insertCorporateVersion(insertVersion, id, revision, record, transactionTime);
            inserted += 1;
            recordIds.push(id);
            changedRecordIds.push(id);
            continue;
          }

          const existing = mapCorporateRecord(existingRow);
          if (existing.sourceAccountId !== record.sourceAccountId) {
            throw new CorporateSourceConflictError('Corporate connector provider account identity changed');
          }
          const incomingTime = Date.parse(record.sourceUpdatedAt);
          const currentTime = Date.parse(existing.sourceUpdatedAt);
          if (incomingTime < currentTime) {
            stale += 1;
            recordIds.push(existing.id);
            continue;
          }
          if (incomingTime === currentTime) {
            if (record.contentSha256 !== existing.contentSha256) {
              throw new CorporateSourceConflictError(
                `Source ${record.source}/${record.stream} supplied conflicting content for one external version`,
              );
            }
            unchanged += 1;
            recordIds.push(existing.id);
            continue;
          }

          const revision = existing.revision + 1;
          update.run(
            record.domain,
            record.recordType,
            record.projectId ?? null,
            record.title,
            record.content,
            record.sourceUrl ?? null,
            record.sourceVersion ?? null,
            record.occurredAt,
            record.sourceUpdatedAt,
            record.observedAt,
            record.status,
            record.contentSha256,
            revision,
            JSON.stringify(record.metadata),
            record.ingestedBy,
            transactionTime,
            existing.id,
          );
          insertCorporateVersion(insertVersion, existing.id, revision, record, transactionTime);
          deleteEmbedding.run(existing.id);
          updated += 1;
          recordIds.push(existing.id);
          changedRecordIds.push(existing.id);
        }

        const recordsSeen = (currentCheckpoint ? numberValue(currentCheckpoint.records_seen) : 0)
          + records.length;
        upsertCheckpoint.run(
          checkpoint.workspaceId,
          checkpoint.source,
          checkpoint.sourceAccountId,
          checkpoint.stream,
          checkpoint.cursor ?? null,
          checkpoint.sourceWatermark ?? null,
          checkpoint.batchSha256,
          recordsSeen,
          checkpoint.successAt,
          transactionTime,
        );
        insertAcceptedPage.run(
          checkpoint.workspaceId,
          checkpoint.source,
          checkpoint.sourceAccountId,
          checkpoint.stream,
          pageKey,
          checkpoint.previousCursor ?? null,
          checkpoint.cursor ?? null,
          checkpoint.batchSha256,
          records.length,
          checkpoint.successAt,
        );
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }

    return {
      records: recordIds.map((id) => this.getCorporateRecord(id, checkpoint.workspaceId)),
      changedRecordIds,
      inserted,
      updated,
      unchanged,
      stale,
      checkpoint: this.getCorporateSyncState(
        checkpoint.workspaceId,
        checkpoint.source,
        checkpoint.stream,
      )!,
    };
  }

  getCorporateRecord(id: string, workspaceId: string): CorporateRecord {
    const row = this.db.prepare(`SELECT * FROM oracle_records
      WHERE id = ? AND workspace_id = ?`).get(id, workspaceId) as SqlRow | undefined;
    if (!row) throw new Error(`Corporate record not found in workspace: ${id}`);
    return mapCorporateRecord(row);
  }

  listCorporateRecordHistory(id: string, workspaceId: string, limit = 100): CorporateRecord[] {
    const boundedLimit = storageReadLimit(limit, 100, 'Corporate record history');
    return (this.db.prepare(`SELECT *, created_at AS updated_at
      FROM oracle_record_versions WHERE record_id = ? AND workspace_id = ?
      ORDER BY revision DESC LIMIT ?`).all(id, workspaceId, boundedLimit) as SqlRow[])
      .map((row) => mapCorporateRecord(row, id));
  }

  searchCorporateRecords(
    workspaceId: string,
    query: string,
    options: CorporateSearchOptions = {},
  ): CorporateRecord[] {
    const limit = storageReadLimit(options.limit ?? 8, 20, 'Corporate record search');
    const terms = tokenize(query).slice(0, 32);
    if (!terms.length) return [];
    const ftsQuery = corporateFtsQuery(terms);
    const scopedFilters = (alias: string): { clauses: string[]; parameters: SQLInputValue[] } => {
      const parameters: SQLInputValue[] = [];
      const clauses = [`${alias}.status = 'active'`];
      if (options.projectId) {
        clauses.push(`(${alias}.project_id IS NULL OR ${alias}.project_id = ?)`);
        parameters.push(options.projectId);
      }
      if (options.source) {
        clauses.push(`${alias}.source = ?`);
        parameters.push(options.source);
      }
      if (options.domain) {
        clauses.push(`${alias}.domain = ?`);
        parameters.push(options.domain);
      }
      return { clauses, parameters };
    };

    let rows: SqlRow[];
    if (options.asOf || options.knownAt) {
      const scoped = scopedFilters('historical');
      const historyFilters = ['workspace_id = ?'];
      const historyParameters: SQLInputValue[] = [workspaceId];
      if (options.asOf) {
        historyFilters.push('source_updated_at <= ?');
        historyParameters.push(options.asOf);
      }
      if (options.knownAt) {
        historyFilters.push('observed_at <= ?');
        historyParameters.push(options.knownAt);
      }
      rows = this.db.prepare(`WITH historical AS (
        SELECT oracle_record_versions.*,
          ROW_NUMBER() OVER (PARTITION BY record_id ORDER BY revision DESC) AS history_rank
        FROM oracle_record_versions
        WHERE ${historyFilters.join(' AND ')}
      )
      SELECT historical.*, historical.created_at AS updated_at,
        NULL AS vector_json, NULL AS embedding_model, NULL AS embedding_content_sha256
      FROM historical
      JOIN oracle_record_versions_fts
        ON oracle_record_versions_fts.record_id = historical.record_id
        AND CAST(oracle_record_versions_fts.revision AS INTEGER) = historical.revision
      WHERE history_rank = 1 AND ${scoped.clauses.join(' AND ')}
        AND oracle_record_versions_fts MATCH ?
      ORDER BY bm25(oracle_record_versions_fts), historical.observed_at DESC, historical.record_id
      LIMIT 1000`).all(...historyParameters, ...scoped.parameters, ftsQuery) as SqlRow[];
    } else {
      const scoped = scopedFilters('records');
      const lexicalRows = this.db.prepare(`SELECT records.*,
          embeddings.vector_json,
          embeddings.model AS embedding_model,
          embeddings.content_sha256 AS embedding_content_sha256
        FROM oracle_records_fts
        JOIN oracle_records AS records ON records.id = oracle_records_fts.record_id
        LEFT JOIN oracle_record_embeddings AS embeddings ON embeddings.record_id = records.id
        WHERE records.workspace_id = ? AND ${scoped.clauses.join(' AND ')}
          AND oracle_records_fts MATCH ?
        ORDER BY bm25(oracle_records_fts), records.observed_at DESC, records.id
        LIMIT 1000`).all(workspaceId, ...scoped.parameters, ftsQuery) as SqlRow[];
      const semanticRows = options.queryVector
        ? this.db.prepare(`SELECT records.*,
            embeddings.vector_json,
            embeddings.model AS embedding_model,
            embeddings.content_sha256 AS embedding_content_sha256
          FROM oracle_records AS records
          LEFT JOIN oracle_record_embeddings AS embeddings ON embeddings.record_id = records.id
          WHERE records.workspace_id = ? AND ${scoped.clauses.join(' AND ')}
          ORDER BY records.observed_at DESC, records.id
          LIMIT 1000`).all(workspaceId, ...scoped.parameters) as SqlRow[]
        : [];
      rows = [...new Map(
        [...lexicalRows, ...semanticRows].map((row) => [stringValue(row.id), row]),
      ).values()];
    }

    const referenceTime = Date.parse(options.asOf ?? options.knownAt ?? now());
    return rows.map((row) => {
      const record = mapCorporateRecord(row, nullableString(row.record_id));
      const text = `${record.title}\n${record.content}\n${record.recordType}`;
      const lexical = lexicalScore(text, terms);
      const embedded = options.queryVector
        && nullableString(row.embedding_model) === options.embeddingModel
        && nullableString(row.embedding_content_sha256) === record.contentSha256
        && typeof row.vector_json === 'string'
        ? parseNumberArray(row.vector_json)
        : undefined;
      const semantic = embedded && embedded.length === options.queryVector?.length
        ? cosineSimilarity(options.queryVector, embedded)
        : 0;
      const ageDays = Math.max(0, referenceTime - Date.parse(record.sourceUpdatedAt)) / 86_400_000;
      const freshness = 1 / (1 + ageDays / 30);
      return {
        record,
        lexical,
        semantic,
        score: semantic * 0.55 + Math.min(1, lexical / Math.max(1, terms.length)) * 0.35 + freshness * 0.1,
      };
    })
      .filter((entry) => entry.lexical > 0 || entry.semantic >= 0.2)
      .sort((left, right) => right.score - left.score
        || right.record.sourceUpdatedAt.localeCompare(left.record.sourceUpdatedAt)
        || left.record.id.localeCompare(right.record.id))
      .slice(0, limit)
      .map((entry) => entry.record);
  }

  putCorporateRecordEmbedding(
    recordId: string,
    workspaceId: string,
    model: string,
    contentSha256: string,
    vector: number[],
  ): void {
    const record = this.getCorporateRecord(recordId, workspaceId);
    if (record.status !== 'active' || record.contentSha256 !== contentSha256) {
      throw new Error('Corporate record changed before its embedding could be committed');
    }
    if (!vector.length || vector.some((value) => !Number.isFinite(value))) {
      throw new Error('Corporate embedding vector must contain finite numbers');
    }
    const timestamp = now();
    this.db.prepare(`INSERT INTO oracle_record_embeddings
      (record_id, model, dimensions, vector_json, content_sha256, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(record_id) DO UPDATE SET model = excluded.model,
        dimensions = excluded.dimensions, vector_json = excluded.vector_json,
        content_sha256 = excluded.content_sha256, updated_at = excluded.updated_at`)
      .run(recordId, model, vector.length, JSON.stringify(vector), contentSha256, timestamp, timestamp);
  }

  hasCorporateRecordEmbedding(
    recordId: string,
    workspaceId: string,
    model: string,
    contentSha256: string,
  ): boolean {
    return this.db.prepare(`SELECT 1
      FROM oracle_record_embeddings AS embeddings
      JOIN oracle_records AS records ON records.id = embeddings.record_id
      WHERE embeddings.record_id = ? AND records.workspace_id = ?
        AND records.status = 'active' AND embeddings.model = ?
        AND embeddings.content_sha256 = ?`).get(
      recordId,
      workspaceId,
      model,
      contentSha256,
    ) !== undefined;
  }

  listCorporateRecordsNeedingEmbedding(
    workspaceId: string,
    model: string,
    source?: string,
    limit = 100,
  ): CorporateRecord[] {
    const boundedLimit = storageReadLimit(limit, 100, 'Corporate embedding backfill');
    return (this.db.prepare(`SELECT records.*
      FROM oracle_records AS records
      LEFT JOIN oracle_record_embeddings AS embeddings ON embeddings.record_id = records.id
      WHERE records.workspace_id = ? AND records.status = 'active'
        AND (? IS NULL OR records.source = ?)
        AND (embeddings.record_id IS NULL OR embeddings.model != ?
          OR embeddings.content_sha256 != records.content_sha256)
      ORDER BY records.observed_at, records.id
      LIMIT ?`).all(
      workspaceId,
      source ?? null,
      source ?? null,
      model,
      boundedLimit,
    ) as SqlRow[]).map((row) => mapCorporateRecord(row));
  }

  hasCompletedToolInvocationInSession(
    sessionId: string,
    workspaceId: string,
    toolName: string,
  ): boolean {
    return this.db.prepare(`SELECT 1
      FROM tool_invocations AS invocations
      JOIN runs ON runs.id = invocations.run_id
      WHERE runs.session_id = ? AND runs.workspace_id = ?
        AND invocations.tool_name = ? AND invocations.status = 'completed'
      LIMIT 1`).get(sessionId, workspaceId, toolName) !== undefined;
  }

  getCorporateSyncState(
    workspaceId: string,
    source: string,
    stream: string,
  ): CorporateSyncState | undefined {
    const row = this.db.prepare(`SELECT * FROM oracle_sync_state
      WHERE workspace_id = ? AND source = ? AND stream = ?`)
      .get(workspaceId, source, stream) as SqlRow | undefined;
    return row ? mapCorporateSyncState(row) : undefined;
  }

  listCorporateSources(workspaceId: string): CorporateSourceSummary[] {
    return (this.db.prepare(`SELECT sync.workspace_id, sync.source, sync.stream,
      sync.source_account_id,
      COALESCE(SUM(CASE WHEN records.status = 'active' THEN 1 ELSE 0 END), 0) AS active_records,
      COALESCE(SUM(CASE WHEN records.status = 'deleted' THEN 1 ELSE 0 END), 0) AS deleted_records,
      MAX(records.observed_at) AS last_observed_at,
      MAX(records.source_updated_at) AS last_source_update_at,
      sync.last_success_at
      FROM oracle_sync_state AS sync
      LEFT JOIN oracle_records AS records
        ON records.workspace_id = sync.workspace_id
        AND records.source = sync.source
        AND records.source_account_id = sync.source_account_id
        AND records.stream = sync.stream
      WHERE sync.workspace_id = ?
      GROUP BY sync.workspace_id, sync.source, sync.source_account_id, sync.stream, sync.last_success_at
      ORDER BY sync.source, sync.stream`).all(workspaceId) as SqlRow[]).map(mapCorporateSourceSummary);
  }

  forgetCorporateSource(workspaceId: string, source: string, stream?: string): {
    recordsDeleted: number;
    checkpointsDeleted: number;
  } {
    const suffix = stream ? ' AND stream = ?' : '';
    const parameters: SQLInputValue[] = stream ? [workspaceId, source, stream] : [workspaceId, source];
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`DELETE FROM oracle_sync_pages
        WHERE workspace_id = ? AND source = ?${suffix}`).run(...parameters);
      const recordsDeleted = Number(this.db.prepare(`DELETE FROM oracle_records
        WHERE workspace_id = ? AND source = ?${suffix}`).run(...parameters).changes);
      const checkpointsDeleted = Number(this.db.prepare(`DELETE FROM oracle_sync_state
        WHERE workspace_id = ? AND source = ?${suffix}`).run(...parameters).changes);
      this.db.exec('COMMIT');
      return { recordsDeleted, checkpointsDeleted };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  listProjects(
    workspaceId: string,
    limit: number = STORAGE_READ_LIMITS.projects,
  ): ProjectRecord[] {
    const boundedLimit = storageReadLimit(limit, STORAGE_READ_LIMITS.projects, 'Project list');
    return (this.db
      .prepare('SELECT * FROM projects WHERE workspace_id = ? ORDER BY updated_at DESC, id DESC LIMIT ?')
      .all(workspaceId, boundedLimit) as SqlRow[]).map(mapProject);
  }

  getProject(id: string, workspaceId: string): ProjectRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM projects WHERE id = ? AND workspace_id = ?')
      .get(id, workspaceId) as SqlRow | undefined;
    return row ? mapProject(row) : undefined;
  }

  findProjectByName(name: string, workspaceId: string): ProjectRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM projects WHERE workspace_id = ? AND lower(name) = lower(?)')
      .get(workspaceId, name) as SqlRow | undefined;
    return row ? mapProject(row) : undefined;
  }

  putProject(input: Omit<ProjectRecord, 'createdAt' | 'updatedAt'>): ProjectRecord {
    const timestamp = now();
    this.db
      .prepare(`INSERT INTO projects
        (id, workspace_id, name, status, summary, owner, due_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET name = excluded.name, status = excluded.status,
        summary = excluded.summary, owner = excluded.owner, due_at = excluded.due_at,
        updated_at = excluded.updated_at`)
      .run(
        input.id,
        input.workspaceId,
        input.name,
        input.status,
        input.summary,
        input.owner,
        input.dueAt ?? null,
        timestamp,
        timestamp,
      );
    return this.getProject(input.id, input.workspaceId)!;
  }

  listTasks(
    projectId: string,
    workspaceId: string,
    limit: number = STORAGE_READ_LIMITS.tasksPerProject,
  ): TaskRecord[] {
    const boundedLimit = storageReadLimit(limit, STORAGE_READ_LIMITS.tasksPerProject, 'Project task list');
    return (this.db
      .prepare(`SELECT * FROM tasks WHERE project_id = ? AND workspace_id = ?
        ORDER BY due_at, created_at, id LIMIT ?`)
      .all(projectId, workspaceId, boundedLimit) as SqlRow[]).map(mapTask);
  }

  putTask(input: Omit<TaskRecord, 'createdAt' | 'updatedAt'>): TaskRecord {
    const timestamp = now();
    this.db
      .prepare(`INSERT INTO tasks
        (id, workspace_id, project_id, title, status, priority, assignee, due_at,
         blocked_reason, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET title = excluded.title, status = excluded.status,
        priority = excluded.priority, assignee = excluded.assignee, due_at = excluded.due_at,
        blocked_reason = excluded.blocked_reason, updated_at = excluded.updated_at`)
      .run(
        input.id,
        input.workspaceId,
        input.projectId,
        input.title,
        input.status,
        input.priority,
        input.assignee ?? null,
        input.dueAt ?? null,
        input.blockedReason ?? null,
        timestamp,
        timestamp,
      );
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(input.id) as SqlRow;
    return mapTask(row);
  }

  listEvidence(
    projectId: string,
    workspaceId: string,
    limit: number = STORAGE_READ_LIMITS.evidencePerProject,
  ): EvidenceRecord[] {
    const boundedLimit = storageReadLimit(limit, STORAGE_READ_LIMITS.evidencePerProject, 'Project evidence list');
    return (this.db
      .prepare(`SELECT * FROM evidence WHERE project_id = ? AND workspace_id = ?
        ORDER BY observed_at DESC, id DESC LIMIT ?`)
      .all(projectId, workspaceId, boundedLimit) as SqlRow[]).map(mapEvidence);
  }

  putEvidence(input: EvidenceRecord): EvidenceRecord {
    this.db
      .prepare(`INSERT INTO evidence
        (id, workspace_id, project_id, source_type, source_ref, title, content, observed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET title = excluded.title, content = excluded.content,
        source_ref = excluded.source_ref, observed_at = excluded.observed_at`)
      .run(
        input.id,
        input.workspaceId,
        input.projectId,
        input.sourceType,
        input.sourceRef,
        input.title,
        input.content,
        input.observedAt,
      );
    const row = this.db.prepare('SELECT * FROM evidence WHERE id = ?').get(input.id) as SqlRow;
    return mapEvidence(row);
  }

  addFeedback(input: Omit<FeedbackRecord, 'id' | 'createdAt'>): FeedbackRecord {
    validateFeedbackInput(input);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.getRun(input.runId);
      const existing = this.db.prepare(`SELECT * FROM feedback
        WHERE run_id = ? AND actor_id = ? ORDER BY created_at, id LIMIT 1`)
        .get(input.runId, input.actorId) as SqlRow | undefined;
      if (existing) {
        this.db.exec('COMMIT');
        return mapFeedback(existing);
      }
      const id = randomUUID();
      const timestamp = now();
      this.db.prepare(`INSERT INTO feedback
        (id, run_id, actor_id, reaction, score, dimensions_json, comment, correction, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          id,
          input.runId,
          input.actorId,
          input.reaction ?? null,
          input.score,
          stringify(input.dimensions as unknown as JsonValue),
          input.comment ?? null,
          input.correction ?? null,
          timestamp,
        );
      const created = this.getFeedback(id);
      this.db.exec('COMMIT');
      return created;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  findFeedback(runId: string, actorId: string): FeedbackRecord | undefined {
    validateFeedbackActorId(actorId);
    const row = this.db.prepare(`SELECT * FROM feedback
      WHERE run_id = ? AND actor_id = ? ORDER BY created_at, id LIMIT 1`)
      .get(runId, actorId) as SqlRow | undefined;
    return row ? mapFeedback(row) : undefined;
  }

  hasFeedbackLifecycleEvent(
    runId: string,
    type: 'feedback.recorded' | 'learning.updated',
    feedbackId: string,
  ): boolean {
    const path = type === 'feedback.recorded' ? '$.id' : '$.feedbackId';
    return Boolean(this.db.prepare(`SELECT 1 FROM events
      WHERE run_id = ? AND type = ? AND json_valid(data_json)
        AND json_extract(data_json, ?) = ? LIMIT 1`)
      .get(runId, type, path, feedbackId));
  }

  getFeedback(id: string): FeedbackRecord {
    const row = this.db.prepare('SELECT * FROM feedback WHERE id = ?').get(id) as SqlRow | undefined;
    if (!row) throw new Error(`Feedback not found: ${id}`);
    return mapFeedback(row);
  }

  listFeedback(runId?: string, limit: number = STORAGE_READ_LIMITS.feedback): FeedbackRecord[] {
    const boundedLimit = storageReadLimit(limit, STORAGE_READ_LIMITS.feedback, 'Feedback list');
    const rows = runId
      ? (this.db.prepare('SELECT * FROM feedback WHERE run_id = ? ORDER BY created_at, id LIMIT ?')
          .all(runId, boundedLimit) as SqlRow[])
      : (this.db.prepare('SELECT * FROM feedback ORDER BY created_at, id LIMIT ?')
          .all(boundedLimit) as SqlRow[]);
    return rows.map(mapFeedback);
  }

  recordInboundEvent(input: {
    source: string;
    dedupeKey: string;
    type: string;
    workspaceId: string;
    actorId: string;
    projectId?: string;
    payload: JsonObject;
    occurredAt: string;
  }): { id: string; duplicate: boolean; runId?: string } {
    const existing = this.db
      .prepare(`SELECT id, run_id FROM inbound_events
        WHERE workspace_id = ? AND source = ? AND dedupe_key = ?`)
      .get(input.workspaceId, input.source, input.dedupeKey) as SqlRow | undefined;
    if (existing) {
      const runId = nullableString(existing.run_id);
      return runId
        ? { id: stringValue(existing.id), duplicate: true, runId }
        : { id: stringValue(existing.id), duplicate: true };
    }
    const id = randomUUID();
    this.db
      .prepare(`INSERT INTO inbound_events
        (id, source, dedupe_key, type, workspace_id, actor_id, project_id, payload_json,
         occurred_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        id,
        input.source,
        input.dedupeKey,
        input.type,
        input.workspaceId,
        input.actorId,
        input.projectId ?? null,
        stringify(input.payload),
        input.occurredAt,
        now(),
      );
    return { id, duplicate: false };
  }

  attachInboundRun(id: string, runId: string): void {
    const result = this.db.prepare(`UPDATE inbound_events SET run_id = ?
      WHERE id = ? AND run_id IS NULL
        AND workspace_id = (SELECT workspace_id FROM runs WHERE id = ?)`)
      .run(runId, id, runId);
    if (Number(result.changes) !== 1) {
      throw new Error('Inbound event and run workspace scopes do not match');
    }
  }

  enqueueOutbox(input: {
    workspaceId: string;
    projectId?: string;
    destination: string;
    subject: string;
    body: string;
    idempotencyKey: string;
  }): JsonObject {
    const existing = this.db
      .prepare('SELECT * FROM outbox WHERE idempotency_key = ?')
      .get(input.idempotencyKey) as SqlRow | undefined;
    if (existing) return outboxJson(existing, true);
    const id = randomUUID();
    const timestamp = now();
    this.db
      .prepare(`INSERT INTO outbox
        (id, workspace_id, project_id, destination, subject, body, status, idempotency_key, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)`)
      .run(
        id,
        input.workspaceId,
        input.projectId ?? null,
        input.destination,
        input.subject,
        input.body,
        input.idempotencyKey,
        timestamp,
      );
    const row = this.db.prepare('SELECT * FROM outbox WHERE id = ?').get(id) as SqlRow;
    return outboxJson(row, false);
  }

  planDeadlineNotifications(asOf: string, lookaheadHours: number): NotificationRecord[] {
    const nowMs = Date.parse(asOf);
    if (!Number.isFinite(nowMs)) throw new Error('asOf must be a valid ISO timestamp');
    const horizon = new Date(nowMs + Math.max(0, lookaheadHours) * 3_600_000).toISOString();
    const groups = this.db.prepare(`SELECT * FROM group_spaces
      WHERE notifications_enabled = 1 AND project_id IS NOT NULL
      ORDER BY updated_at DESC, id DESC LIMIT ?`).all(STORAGE_READ_LIMITS.groupSpaces) as SqlRow[];
    const planned: NotificationRecord[] = [];
    for (const groupRow of groups) {
      const group = mapGroupSpace(groupRow);
      if (!group.projectId) continue;
      const tasks = this.db.prepare(`SELECT * FROM tasks WHERE workspace_id = ? AND project_id = ?
        AND status <> 'done' AND ((due_at IS NOT NULL AND due_at <= ?) OR status = 'blocked')
        ORDER BY due_at, created_at, id LIMIT ?`)
        .all(group.workspaceId, group.projectId, horizon, STORAGE_READ_LIMITS.tasksPerProject) as SqlRow[];
      for (const taskRow of tasks) {
        const task = mapTask(taskRow);
        const kind: NotificationRecord['kind'] = task.status === 'blocked'
          ? 'blocked'
          : task.dueAt && Date.parse(task.dueAt) < nowMs
            ? 'overdue'
            : 'deadline_approaching';
        const dueKey = task.dueAt ?? task.updatedAt.slice(0, 10);
        const dayBucket = asOf.slice(0, 10);
        const key = `notification:${group.id}:${task.id}:${kind}:${dueKey}:${dayBucket}`;
        const body = notificationBody(task, kind);
        planned.push(this.putNotification({
          workspaceId: group.workspaceId,
          groupSpaceId: group.id,
          projectId: group.projectId,
          taskId: task.id,
          kind,
          destination: group.externalId,
          body,
          idempotencyKey: key,
          scheduledAt: asOf,
        }));
      }
    }
    return planned;
  }

  putNotification(input: {
    workspaceId: string;
    groupSpaceId: string;
    projectId: string;
    taskId: string;
    kind: NotificationRecord['kind'];
    destination: string;
    body: string;
    idempotencyKey: string;
    scheduledAt: string;
  }): NotificationRecord {
    const existing = this.db.prepare('SELECT * FROM notifications WHERE idempotency_key = ?')
      .get(input.idempotencyKey) as SqlRow | undefined;
    if (existing) return mapNotification(existing);
    const id = randomUUID();
    this.db.prepare(`INSERT INTO notifications
      (id, workspace_id, group_space_id, project_id, task_id, kind, destination,
       body, status, idempotency_key, scheduled_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`)
      .run(
        id,
        input.workspaceId,
        input.groupSpaceId,
        input.projectId,
        input.taskId,
        input.kind,
        input.destination,
        input.body,
        input.idempotencyKey,
        input.scheduledAt,
        now(),
      );
    return this.getNotification(id);
  }

  getNotification(id: string): NotificationRecord {
    const row = this.db.prepare('SELECT * FROM notifications WHERE id = ?').get(id) as SqlRow | undefined;
    if (!row) throw new Error(`Notification not found: ${id}`);
    return mapNotification(row);
  }

  listNotifications(workspaceId?: string, status?: NotificationRecord['status'], limit = 100): NotificationRecord[] {
    const boundedLimit = storageReadLimit(limit, STORAGE_READ_LIMITS.notifications, 'Notification list');
    const clauses: string[] = [];
    const params: SQLInputValue[] = [];
    if (workspaceId) {
      clauses.push('workspace_id = ?');
      params.push(workspaceId);
    }
    if (status) {
      clauses.push('status = ?');
      params.push(status);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return (this.db.prepare(`SELECT * FROM notifications ${where}
      ORDER BY scheduled_at DESC, id DESC LIMIT ?`).all(...params, boundedLimit) as SqlRow[]).map(mapNotification);
  }

  claimNotifications(asOf: string, limit = 20): NotificationRecord[] {
    const boundedLimit = storageReadLimit(limit, STORAGE_READ_LIMITS.notifications, 'Notification claim');
    const rows = this.db.prepare(`SELECT * FROM notifications
      WHERE status = 'pending' AND scheduled_at <= ? ORDER BY scheduled_at, id LIMIT ?`)
      .all(asOf, boundedLimit) as SqlRow[];
    const claimed: NotificationRecord[] = [];
    const claim = this.db.prepare(`UPDATE notifications SET status = 'sending'
      WHERE id = ? AND status = 'pending'`);
    for (const row of rows) {
      const id = stringValue(row.id);
      const result = claim.run(id);
      if (Number(result.changes) === 1) claimed.push(this.getNotification(id));
    }
    return claimed;
  }

  finishNotification(id: string, status: 'sent' | 'failed', error?: string): NotificationRecord {
    const result = this.db.prepare(`UPDATE notifications SET status = ?, sent_at = ?, error = ?
      WHERE id = ? AND status = 'sending'`)
      .run(status, status === 'sent' ? now() : null, error ?? null, id);
    if (Number(result.changes) !== 1) throw new Error(`Notification is not in sending state: ${id}`);
    return this.getNotification(id);
  }

  markNotificationUnknownOutcome(id: string, error: string): boolean {
    const result = this.db.prepare(`UPDATE notifications SET status = 'unknown_outcome', error = ?
      WHERE id = ? AND status = 'sending'`).run(error, id);
    return Number(result.changes) === 1;
  }

  recoverSendingNotifications(): number {
    const result = this.db.prepare(`UPDATE notifications SET status = 'unknown_outcome',
      error = 'UNKNOWN_OUTCOME_AFTER_RESTART' WHERE status = 'sending'`).run();
    return Number(result.changes);
  }

  outboxCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM outbox').get() as SqlRow;
    return numberValue(row.count);
  }
}

function mapSession(row: SqlRow): SessionRecord {
  const externalId = nullableString(row.external_id);
  const title = nullableString(row.title);
  return {
    id: stringValue(row.id),
    workspaceId: stringValue(row.workspace_id),
    actorId: stringValue(row.actor_id),
    channel: stringValue(row.channel),
    ...(externalId ? { externalId } : {}),
    ...(title ? { title } : {}),
    createdAt: stringValue(row.created_at),
    updatedAt: stringValue(row.updated_at),
    metadata: parseObject(row.metadata_json),
  };
}

function mapRun(row: SqlRow): RunRecord {
  const projectId = nullableString(row.project_id);
  const output = nullableString(row.output);
  const error = nullableString(row.error);
  const startedAt = nullableString(row.started_at);
  const finishedAt = nullableString(row.finished_at);
  const activeSince = nullableString(row.active_since);
  const agentSnapshot = nullableString(row.agent_snapshot_digest);
  const toolsSnapshot = nullableString(row.tools_snapshot_digest);
  const policySnapshot = nullableString(row.policy_snapshot_digest);
  const snapshotCount = [agentSnapshot, toolsSnapshot, policySnapshot].filter(Boolean).length;
  if (snapshotCount !== 0 && snapshotCount !== 3) {
    throw new Error(`Run snapshot binding is incomplete: ${stringValue(row.id)}`);
  }
  return {
    id: stringValue(row.id),
    sessionId: stringValue(row.session_id),
    workspaceId: stringValue(row.workspace_id),
    actorId: stringValue(row.actor_id),
    ...(projectId ? { projectId } : {}),
    agentId: stringValue(row.agent_id),
    agentVersion: stringValue(row.agent_version),
    ...(snapshotCount === 3
      ? { snapshots: { agent: agentSnapshot!, tools: toolsSnapshot!, policy: policySnapshot! } }
      : {}),
    status: stringValue(row.status) as RunStatus,
    input: stringValue(row.input),
    ...(output ? { output } : {}),
    ...(error ? { error } : {}),
    step: numberValue(row.step),
    toolCalls: numberValue(row.tool_calls),
    activeMs: row.active_ms === undefined ? 0 : numberValue(row.active_ms),
    ...(activeSince ? { activeSince } : {}),
    ...(startedAt ? { startedAt } : {}),
    ...(finishedAt ? { finishedAt } : {}),
    createdAt: stringValue(row.created_at),
    updatedAt: stringValue(row.updated_at),
    metadata: parseObject(row.metadata_json),
  };
}

function mapRecoverableRunCandidate(row: SqlRow): RecoverableRunCandidate {
  try {
    return { ok: true, run: mapRun(row) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      id: safeRecoveryText(row.id, 'invalid-run-id', 256),
      sessionId: safeRecoveryText(row.session_id, 'invalid-session-id', 256),
      agentId: safeRecoveryText(row.agent_id, 'invalid-agent-id', 256),
      agentVersion: safeRecoveryText(row.agent_version, 'invalid-agent-version', 256),
      status: row.status === 'waiting_for_approval' ? 'waiting_for_approval' : 'running',
      createdAt: safeRecoveryText(row.created_at, 'invalid-created-at', 256),
      error: message.length <= 2_048 ? message : `${message.slice(0, 2_047)}…`,
    };
  }
}

function safeRecoveryText(value: unknown, fallback: string, maximum: number): string {
  if (typeof value === 'string' && value.length > 0) {
    return value.length <= maximum ? value : value.slice(0, maximum);
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'bigint') return value.toString();
  return fallback;
}

function mapEvent(row: SqlRow): HarnessEvent {
  return {
    id: stringValue(row.id),
    sessionId: stringValue(row.session_id),
    runId: stringValue(row.run_id),
    seq: numberValue(row.seq),
    type: stringValue(row.type),
    data: parseJson(row.data_json),
    createdAt: stringValue(row.created_at),
  };
}

function mapToolBatch(row: SqlRow): ToolBatchRecord {
  return {
    id: stringValue(row.id),
    runId: stringValue(row.run_id),
    step: numberValue(row.step),
    status: stringValue(row.status) as ToolBatchRecord['status'],
    createdAt: stringValue(row.created_at),
    updatedAt: stringValue(row.updated_at),
  };
}

function mapToolInvocation(row: SqlRow): ToolInvocationRecord {
  const effect = nullableString(row.effect) as ToolInvocationRecord['effect'];
  const resultRaw = nullableString(row.result_json);
  const argumentsDigest = nullableString(row.arguments_digest);
  return {
    id: stringValue(row.id),
    batchId: stringValue(row.batch_id),
    runId: stringValue(row.run_id),
    callId: stringValue(row.call_id),
    callIndex: numberValue(row.call_index),
    toolName: stringValue(row.tool_name),
    arguments: stringValue(row.arguments_json),
    ...(argumentsDigest ? { argumentsDigest } : {}),
    ...(effect ? { effect } : {}),
    policyDecision: stringValue(row.policy_decision) as ToolInvocationRecord['policyDecision'],
    status: stringValue(row.status) as ToolInvocationRecord['status'],
    ...(resultRaw ? { result: JSON.parse(resultRaw) as ToolResult } : {}),
    idempotencyKey: stringValue(row.idempotency_key),
    createdAt: stringValue(row.created_at),
    updatedAt: stringValue(row.updated_at),
  };
}

function mapApproval(row: SqlRow): ApprovalRecord {
  const resolvedAt = nullableString(row.resolved_at);
  const resolvedBy = nullableString(row.resolved_by);
  const reason = nullableString(row.reason);
  const argumentsDigest = nullableString(row.arguments_digest);
  return {
    id: stringValue(row.id),
    invocationId: stringValue(row.invocation_id),
    runId: stringValue(row.run_id),
    toolName: stringValue(row.tool_name),
    arguments: stringValue(row.arguments_json),
    ...(argumentsDigest ? { argumentsDigest } : {}),
    status: stringValue(row.status) as ApprovalRecord['status'],
    requestedAt: stringValue(row.requested_at),
    ...(resolvedAt ? { resolvedAt } : {}),
    ...(resolvedBy ? { resolvedBy } : {}),
    ...(reason ? { reason } : {}),
  };
}

function mapMemory(row: SqlRow): MemoryRecord {
  const projectId = nullableString(row.project_id);
  const actorId = nullableString(row.actor_id);
  const lastAccessedAt = nullableString(row.last_accessed_at);
  const importance = numberValue(row.importance);
  return {
    id: stringValue(row.id),
    workspaceId: stringValue(row.workspace_id),
    ...(projectId ? { projectId } : {}),
    ...(actorId ? { actorId } : {}),
    kind: stringValue(row.kind) as MemoryRecord['kind'],
    content: stringValue(row.content),
    importance,
    strength: row.strength === undefined ? importance : numberValue(row.strength),
    reward: row.reward === undefined ? 0 : numberValue(row.reward),
    accessCount: row.access_count === undefined ? 0 : numberValue(row.access_count),
    ...(lastAccessedAt ? { lastAccessedAt } : {}),
    sourceType: stringValue(row.source_type),
    sourceId: stringValue(row.source_id),
    status: stringValue(row.status) as MemoryRecord['status'],
    createdAt: stringValue(row.created_at),
    updatedAt: stringValue(row.updated_at),
  };
}

function mapCorporateRecord(row: SqlRow, recordId?: string): CorporateRecord {
  const projectId = nullableString(row.project_id);
  const sourceUrl = nullableString(row.source_url);
  const sourceVersion = nullableString(row.source_version);
  return {
    id: recordId ?? nullableString(row.id) ?? stringValue(row.record_id),
    workspaceId: stringValue(row.workspace_id),
    source: stringValue(row.source),
    sourceAccountId: stringValue(row.source_account_id),
    stream: stringValue(row.stream),
    externalId: stringValue(row.external_id),
    domain: stringValue(row.domain) as CorporateRecordDomain,
    recordType: stringValue(row.record_type),
    ...(projectId ? { projectId } : {}),
    title: stringValue(row.title),
    content: stringValue(row.content),
    ...(sourceUrl ? { sourceUrl } : {}),
    ...(sourceVersion ? { sourceVersion } : {}),
    occurredAt: stringValue(row.occurred_at),
    sourceUpdatedAt: stringValue(row.source_updated_at),
    observedAt: stringValue(row.observed_at),
    status: stringValue(row.status) as CorporateRecord['status'],
    contentSha256: stringValue(row.content_sha256),
    revision: numberValue(row.revision),
    metadata: parseObject(row.metadata_json),
    ingestedBy: stringValue(row.ingested_by),
    createdAt: stringValue(row.created_at),
    updatedAt: nullableString(row.updated_at) ?? stringValue(row.created_at),
  };
}

function mapCorporateSyncState(row: SqlRow): CorporateSyncState {
  const cursor = nullableString(row.cursor);
  const sourceWatermark = nullableString(row.source_watermark);
  return {
    workspaceId: stringValue(row.workspace_id),
    source: stringValue(row.source),
    sourceAccountId: stringValue(row.source_account_id),
    stream: stringValue(row.stream),
    ...(cursor ? { cursor } : {}),
    ...(sourceWatermark ? { sourceWatermark } : {}),
    lastBatchSha256: stringValue(row.last_batch_sha256),
    recordsSeen: numberValue(row.records_seen),
    lastSuccessAt: stringValue(row.last_success_at),
    updatedAt: stringValue(row.updated_at),
  };
}

function mapCorporateSourceSummary(row: SqlRow): CorporateSourceSummary {
  const lastObservedAt = nullableString(row.last_observed_at);
  const lastSourceUpdateAt = nullableString(row.last_source_update_at);
  const lastSuccessAt = nullableString(row.last_success_at);
  return {
    workspaceId: stringValue(row.workspace_id),
    source: stringValue(row.source),
    sourceAccountId: stringValue(row.source_account_id),
    stream: stringValue(row.stream),
    activeRecords: numberValue(row.active_records),
    deletedRecords: numberValue(row.deleted_records),
    ...(lastObservedAt ? { lastObservedAt } : {}),
    ...(lastSourceUpdateAt ? { lastSourceUpdateAt } : {}),
    ...(lastSuccessAt ? { lastSuccessAt } : {}),
  };
}

function mapGroupSpace(row: SqlRow): GroupSpaceRecord {
  const title = nullableString(row.title);
  const projectId = nullableString(row.project_id);
  return {
    id: stringValue(row.id),
    workspaceId: stringValue(row.workspace_id),
    source: stringValue(row.source),
    externalId: stringValue(row.external_id),
    ...(title ? { title } : {}),
    ...(projectId ? { projectId } : {}),
    learningEnabled: numberValue(row.learning_enabled) === 1,
    notificationsEnabled: numberValue(row.notifications_enabled) === 1,
    createdBy: stringValue(row.created_by),
    createdAt: stringValue(row.created_at),
    updatedAt: stringValue(row.updated_at),
  };
}

function mapGroupMessage(row: SqlRow): GroupMessageRecord {
  return {
    id: stringValue(row.id),
    groupSpaceId: stringValue(row.group_space_id),
    workspaceId: stringValue(row.workspace_id),
    externalMessageId: stringValue(row.external_message_id),
    actorId: stringValue(row.actor_id),
    text: stringValue(row.text),
    transcript: numberValue(row.transcript) === 1,
    salient: numberValue(row.salient) === 1,
    occurredAt: stringValue(row.occurred_at),
    createdAt: stringValue(row.created_at),
  };
}

function mapModelRouteStats(row: SqlRow): ModelRouteStats {
  return {
    routeId: stringValue(row.route_id),
    task: stringValue(row.task) as ModelTask,
    attempts: numberValue(row.attempts),
    successes: numberValue(row.successes),
    rewardSum: numberValue(row.reward_sum),
    rewardCount: numberValue(row.reward_count),
    costUsd: numberValue(row.cost_usd),
    latencyMs: numberValue(row.latency_ms),
    updatedAt: stringValue(row.updated_at),
  };
}

function mapNotification(row: SqlRow): NotificationRecord {
  const sentAt = nullableString(row.sent_at);
  const error = nullableString(row.error);
  return {
    id: stringValue(row.id),
    workspaceId: stringValue(row.workspace_id),
    groupSpaceId: stringValue(row.group_space_id),
    projectId: stringValue(row.project_id),
    taskId: stringValue(row.task_id),
    kind: stringValue(row.kind) as NotificationRecord['kind'],
    destination: stringValue(row.destination),
    body: stringValue(row.body),
    status: stringValue(row.status) as NotificationRecord['status'],
    idempotencyKey: stringValue(row.idempotency_key),
    scheduledAt: stringValue(row.scheduled_at),
    ...(sentAt ? { sentAt } : {}),
    ...(error ? { error } : {}),
    createdAt: stringValue(row.created_at),
  };
}

function mapProject(row: SqlRow): ProjectRecord {
  const dueAt = nullableString(row.due_at);
  return {
    id: stringValue(row.id),
    workspaceId: stringValue(row.workspace_id),
    name: stringValue(row.name),
    status: stringValue(row.status),
    summary: stringValue(row.summary),
    owner: stringValue(row.owner),
    ...(dueAt ? { dueAt } : {}),
    createdAt: stringValue(row.created_at),
    updatedAt: stringValue(row.updated_at),
  };
}

function mapTask(row: SqlRow): TaskRecord {
  const assignee = nullableString(row.assignee);
  const dueAt = nullableString(row.due_at);
  const blockedReason = nullableString(row.blocked_reason);
  return {
    id: stringValue(row.id),
    workspaceId: stringValue(row.workspace_id),
    projectId: stringValue(row.project_id),
    title: stringValue(row.title),
    status: stringValue(row.status),
    priority: stringValue(row.priority),
    ...(assignee ? { assignee } : {}),
    ...(dueAt ? { dueAt } : {}),
    ...(blockedReason ? { blockedReason } : {}),
    createdAt: stringValue(row.created_at),
    updatedAt: stringValue(row.updated_at),
  };
}

function mapEvidence(row: SqlRow): EvidenceRecord {
  return {
    id: stringValue(row.id),
    workspaceId: stringValue(row.workspace_id),
    projectId: stringValue(row.project_id),
    sourceType: stringValue(row.source_type),
    sourceRef: stringValue(row.source_ref),
    title: stringValue(row.title),
    content: stringValue(row.content),
    observedAt: stringValue(row.observed_at),
  };
}

function mapFeedback(row: SqlRow): FeedbackRecord {
  const reaction = nullableString(row.reaction);
  const comment = nullableString(row.comment);
  const correction = nullableString(row.correction);
  return {
    id: stringValue(row.id),
    runId: stringValue(row.run_id),
    actorId: stringValue(row.actor_id),
    ...(reaction ? { reaction } : {}),
    score: numberValue(row.score),
    dimensions: JSON.parse(stringValue(row.dimensions_json)) as Record<string, number>,
    ...(comment ? { comment } : {}),
    ...(correction ? { correction } : {}),
    createdAt: stringValue(row.created_at),
  };
}

function outboxJson(row: SqlRow, replayed: boolean): JsonObject {
  return {
    id: stringValue(row.id),
    destination: stringValue(row.destination),
    subject: stringValue(row.subject),
    status: stringValue(row.status),
    replayed,
    createdAt: stringValue(row.created_at),
  };
}

function stringify(value: JsonValue): string {
  return JSON.stringify(value);
}

interface ApprovalCursorPayload {
  workspaceId: string;
  status?: ApprovalRecord['status'];
  queueOrder: number;
  requestedAt: string;
  id: string;
}

interface RecoverableRunCursorPayload {
  scopeDigest: string;
  phase: 'preferred' | 'nonpreferred';
  /** Exact, bounded locator; raw TEXT sort keys remain inside SQLite. */
  rowId: string;
}

function approvalPageLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 200) {
    throw new RangeError('Approval page limit must be an integer between 1 and 200');
  }
  return value;
}

function storageReadLimit(value: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${label} limit must be an integer between 1 and ${maximum}`);
  }
  return value;
}

function eventPageBounds(
  options: SessionEventPageOptions,
  label: string,
): { afterSeq: number; throughSeq: number; limit: number } {
  const afterSeq = options.afterSeq ?? -1;
  const throughSeq = options.throughSeq ?? Number.MAX_SAFE_INTEGER;
  const limit = options.limit ?? 128;
  if (!Number.isSafeInteger(afterSeq) || afterSeq < -1) {
    throw new Error(`${label} cursor must be a safe integer greater than or equal to -1`);
  }
  if (!Number.isSafeInteger(throughSeq) || throughSeq < 0) {
    throw new Error(`${label} replay fence must be a non-negative safe integer`);
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new Error(`${label} page limit must be an integer from 1 to 1000`);
  }
  return { afterSeq, throughSeq, limit };
}

function encodeApprovalCursor(payload: ApprovalCursorPayload): string {
  return Buffer.from(JSON.stringify([
    1,
    payload.workspaceId,
    payload.status ?? null,
    payload.queueOrder,
    payload.requestedAt,
    payload.id,
  ]), 'utf8').toString('base64url');
}

function decodeApprovalCursor(
  cursor: string,
  workspaceId: string,
  status: ApprovalRecord['status'] | undefined,
): ApprovalCursorPayload {
  try {
    if (cursor.length < 8 || cursor.length > 2_048 || !/^[A-Za-z0-9_-]+$/u.test(cursor)) {
      throw new ApprovalCursorError();
    }
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 6) throw new ApprovalCursorError();
    const [version, cursorWorkspace, cursorStatus, queueOrder, requestedAt, id] = parsed;
    if (
      version !== 1
      || cursorWorkspace !== workspaceId
      || cursorStatus !== (status ?? null)
      || (queueOrder !== 0 && queueOrder !== 1)
      || typeof requestedAt !== 'string'
      || requestedAt.length > 64
      || !Number.isFinite(Date.parse(requestedAt))
      || typeof id !== 'string'
      || id.length < 1
      || id.length > 128
    ) {
      throw new ApprovalCursorError();
    }
    return {
      workspaceId,
      ...(status ? { status } : {}),
      queueOrder,
      requestedAt,
      id,
    };
  } catch (error) {
    if (error instanceof ApprovalCursorError) throw error;
    throw new ApprovalCursorError();
  }
}

function encodeRecoverableRunCursor(payload: RecoverableRunCursorPayload): string {
  return Buffer.from(JSON.stringify([
    2,
    payload.scopeDigest,
    payload.phase,
    payload.rowId,
  ]), 'utf8').toString('base64url');
}

function decodeRecoverableRunCursor(
  cursor: string,
  agentId: string,
  preferredVersion: string,
): RecoverableRunCursorPayload {
  try {
    if (cursor.length < 8 || cursor.length > 192 || !/^[A-Za-z0-9_-]+$/u.test(cursor)) {
      throw new RecoverableRunCursorError();
    }
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 4) throw new RecoverableRunCursorError();
    const [version, scopeDigest, phase, rowId] = parsed;
    if (
      version !== 2
      || scopeDigest !== recoverableRunCursorScopeDigest(agentId, preferredVersion)
      || (phase !== 'preferred' && phase !== 'nonpreferred')
      || typeof rowId !== 'string'
    ) {
      throw new RecoverableRunCursorError();
    }
    return { scopeDigest, phase, rowId: recoveryCursorRowId(rowId) };
  } catch (error) {
    if (error instanceof RecoverableRunCursorError) throw error;
    throw new RecoverableRunCursorError();
  }
}

function recoveryCursorRowId(value: unknown): string {
  if (typeof value !== 'string' || !/^(?:0|-?[1-9][0-9]{0,18})$/u.test(value)) {
    throw new RecoverableRunCursorError();
  }
  const numeric = BigInt(value);
  if (numeric < -9_223_372_036_854_775_808n || numeric > 9_223_372_036_854_775_807n) {
    throw new RecoverableRunCursorError();
  }
  return value;
}

function recoverableRunCursorScopeDigest(agentId: string, preferredVersion: string): string {
  const digest = createHash('sha256');
  for (const value of [agentId, preferredVersion]) {
    digest.update(String(Buffer.byteLength(value, 'utf8')));
    digest.update(':');
    digest.update(value, 'utf8');
  }
  return digest.digest('hex');
}

function parseJson(value: unknown): JsonValue {
  return JSON.parse(stringValue(value)) as JsonValue;
}

function parseObject(value: unknown): JsonObject {
  const parsed = parseJson(value);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
  return parsed;
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  if (typeof value !== 'string') throw new Error(`Expected string database value, received ${typeof value}`);
  return value;
}

function nullableString(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : stringValue(value);
}

function numberValue(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  throw new Error(`Expected numeric database value, received ${typeof value}`);
}

function now(): string {
  return new Date().toISOString();
}

function insertCorporateVersion(
  statement: { run(...values: SQLInputValue[]): unknown },
  recordId: string,
  revision: number,
  record: PreparedCorporateRecord,
  createdAt: string,
): void {
  statement.run(
    recordId,
    revision,
    record.workspaceId,
    record.source,
    record.sourceAccountId,
    record.stream,
    record.externalId,
    record.domain,
    record.recordType,
    record.projectId ?? null,
    record.title,
    record.content,
    record.sourceUrl ?? null,
    record.sourceVersion ?? null,
    record.occurredAt,
    record.sourceUpdatedAt,
    record.observedAt,
    record.status,
    record.contentSha256,
    JSON.stringify(record.metadata),
    record.ingestedBy,
    createdAt,
  );
}

function corporatePageKey(cursor: string | undefined, batchSha256: string): string {
  if (!cursor) return `digest:${batchSha256}`;
  return `cursor:${createHash('sha256').update(cursor).digest('hex')}`;
}

function accumulatedActiveMs(run: RunRecord, timestamp: string): number {
  if (run.status !== 'running' || !run.activeSince) return run.activeMs;
  return run.activeMs + Math.max(0, Date.parse(timestamp) - Date.parse(run.activeSince));
}

function tokenize(value: string): string[] {
  return [...new Set(value.toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? [])];
}

function lexicalScore(content: string, terms: string[]): number {
  const lower = content.toLowerCase();
  return terms.reduce((score, term) => score + (lower.includes(term) ? 1 : 0), 0);
}

function corporateFtsQuery(terms: string[]): string {
  return terms
    .map((term) => `"${term.replace(/"/gu, '""')}"*`)
    .join(' OR ');
}

function validateFeedbackInput(input: Omit<FeedbackRecord, 'id' | 'createdAt'>): void {
  validateFeedbackActorId(input.actorId);
  if (!Number.isFinite(input.score) || input.score < -1 || input.score > 1) {
    throw new Error('Feedback score must be finite and between -1 and 1');
  }
  if (
    typeof input.dimensions !== 'object'
    || input.dimensions === null
    || Array.isArray(input.dimensions)
  ) {
    throw new Error('Feedback dimensions must be an object');
  }
  const dimensions = Object.entries(input.dimensions);
  if (dimensions.length > 32) throw new Error('Feedback dimensions exceed the 32-dimension limit');
  for (const [key, value] of dimensions) {
    if (!key || Buffer.byteLength(key, 'utf8') > 64 || !/^[A-Za-z0-9_.:-]+$/u.test(key)) {
      throw new Error('Feedback dimension names must be 1-64 safe characters');
    }
    if (!Number.isFinite(value) || value < -1 || value > 1) {
      throw new Error(`Feedback dimension ${key} must be finite and between -1 and 1`);
    }
  }
  validateOptionalFeedbackText(input.reaction, 'reaction', 64, false);
  validateOptionalFeedbackText(input.comment, 'comment', 4_096, true);
  validateOptionalFeedbackText(input.correction, 'correction', 8_192, true);
}

function validateFeedbackActorId(actorId: string): void {
  if (
    typeof actorId !== 'string'
    || !actorId
    || actorId !== actorId.trim()
    || Buffer.byteLength(actorId, 'utf8') > 256
    || /[\u0000-\u001F\u007F]/u.test(actorId)
  ) {
    throw new Error('Feedback actor ID must be a trimmed, control-free string of at most 256 bytes');
  }
}

function validateOptionalFeedbackText(
  value: string | undefined,
  field: string,
  maximumBytes: number,
  allowLineBreaks: boolean,
): void {
  if (value === undefined) return;
  const forbiddenControls = allowLineBreaks
    ? /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u
    : /[\u0000-\u001F\u007F]/u;
  if (
    typeof value !== 'string'
    || !value
    || Buffer.byteLength(value, 'utf8') > maximumBytes
    || forbiddenControls.test(value)
  ) {
    throw new Error(`Feedback ${field} must be non-empty, safely encoded, and at most ${maximumBytes} bytes`);
  }
}

function validateReinforcementReward(reward: number, feedbackScore: number): void {
  if (!Number.isFinite(reward) || reward < -1 || reward > 1) {
    throw new Error('Reinforcement reward must be finite and between -1 and 1');
  }
  if (reward !== feedbackScore) throw new Error('Reinforcement reward does not match the feedback score');
}

function validateStatsRouteIds(routeIds: readonly string[] | undefined): string[] | undefined {
  if (routeIds === undefined) return undefined;
  const unique = [...new Set(routeIds.map(validateStatsRouteId))];
  if (unique.length > 32) throw new Error('Model route statistics exceed the 32-route query limit');
  return unique;
}

function validateStatsRouteId(routeId: string): string {
  if (
    typeof routeId !== 'string'
    || !routeId
    || Buffer.byteLength(routeId, 'utf8') > 512
    || /[\u0000-\u001F\u007F]/u.test(routeId)
  ) {
    throw new Error('Model statistics route ID must be a control-free string of at most 512 bytes');
  }
  return routeId;
}

function parseNumberArray(value: string): number[] | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'number' || !Number.isFinite(item))) {
      return undefined;
    }
    return parsed as number[];
  } catch {
    return undefined;
  }
}

function cosineSimilarity(left: number[], right: number[]): number {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / Math.sqrt(leftNorm * rightNorm);
}

function notificationBody(task: TaskRecord, kind: NotificationRecord['kind']): string {
  const assignee = task.assignee ? ` — owner: ${task.assignee}` : '';
  if (kind === 'blocked') {
    return `OpenProjects: “${task.title}” is blocked${assignee}${task.blockedReason ? `. ${task.blockedReason}` : '.'}`;
  }
  if (kind === 'overdue') {
    return `OpenProjects: “${task.title}” is overdue${task.dueAt ? ` (due ${task.dueAt})` : ''}${assignee}.`;
  }
  return `OpenProjects: “${task.title}” is approaching its deadline${task.dueAt ? ` (${task.dueAt})` : ''}${assignee}.`;
}
