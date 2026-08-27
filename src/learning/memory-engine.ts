import { createHash, randomUUID } from 'node:crypto';

import { formatEmbeddingQuery } from '../adapters/embeddings.js';
import type {
  EmbeddingAdapter,
  JsonObject,
  MemoryRecord,
} from '../core/types.js';
import { SqliteStorage } from '../storage/sqlite.js';

const DEFAULT_MINIMUM_SALIENCE = 0.55;
const DEFAULT_LEARNING_RATE = 0.1;
const DEFAULT_RETENTION_DAYS = 90;
const MAX_OBSERVATION_CHARACTERS = 4_000;

export interface MemoryEngineOptions {
  storage: SqliteStorage;
  embedding: EmbeddingAdapter;
  minimumSalience?: number;
  feedbackLearningRate?: number;
  retentionDays?: number;
  clock?: () => Date;
}

export interface ObserveGroupMessageInput {
  groupSpaceId: string;
  externalMessageId: string;
  actorId: string;
  text: string;
  transcript?: boolean;
  occurredAt?: string;
}

export interface SalienceAssessment {
  score: number;
  salient: boolean;
  eligible: boolean;
  kind: MemoryRecord['kind'];
  reasons: string[];
}

export interface GroupObservationResult {
  observed: boolean;
  duplicate: boolean;
  assessment: SalienceAssessment;
  redactions: number;
  messageId?: string;
  memory?: MemoryRecord;
  embeddingError?: string;
  reason?: 'learning_disabled';
}

export interface MemorySearchScope {
  workspaceId: string;
  projectId?: string;
  actorId?: string;
}

export interface MemorySearchOptions {
  limit?: number;
  runId?: string;
  signal?: AbortSignal;
}

export interface MemorySearchResult {
  memories: MemoryRecord[];
  mode: 'hybrid' | 'lexical_fallback';
  embeddingError?: string;
}

export interface ReinforcementResult {
  feedbackId: string;
  runId: string;
  reward: number;
  appliedMemoryIds: string[];
  alreadyAppliedMemoryIds: string[];
  memories: MemoryRecord[];
}

export interface MemoryStatusResult {
  memory: MemoryRecord;
  embedding: 'stored' | 'deferred' | 'failed';
  embeddingError?: string;
}

export interface PurgeOptions {
  asOf?: Date;
  retentionDays?: number;
  workspaceId?: string;
}

export interface PurgeResult {
  cutoff: string;
  messagesDeleted: number;
  memoriesDeleted: number;
  signalsDeleted: number;
}

export interface SecretRedactionResult {
  text: string;
  redactions: number;
}

interface SecretPattern {
  source: string;
  flags: string;
  replacement: string;
}

const SECRET_PATTERNS: SecretPattern[] = [
  {
    source: '-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\\s\\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----',
    flags: 'gi',
    replacement: '[REDACTED:PRIVATE_KEY]',
  },
  {
    source: '\\bBearer\\s+[A-Za-z0-9._~+\\/=-]{12,}',
    flags: 'gi',
    replacement: 'Bearer [REDACTED:TOKEN]',
  },
  {
    source: '\\b(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{12,}|AKIA[0-9A-Z]{16})\\b',
    flags: 'g',
    replacement: '[REDACTED:TOKEN]',
  },
  {
    source: '\\b\\d{6,12}:[A-Za-z0-9_-]{30,}\\b',
    flags: 'g',
    replacement: '[REDACTED:BOT_TOKEN]',
  },
  {
    source: '\\b(api[_-]?key|access[_-]?token|secret|password|passwd|pwd)\\b(\\s*[:=]\\s*)["\\\']?([^\\s"\\\',;]{8,})',
    flags: 'gi',
    replacement: '$1$2[REDACTED:SECRET]',
  },
  {
    source: '(https?:\\/\\/)([^\\s:@\\/]+):([^\\s@\\/]+)@',
    flags: 'gi',
    replacement: '$1[REDACTED:CREDENTIALS]@',
  },
];

const EXPLICIT_MEMORY = /\b(?:remember|note that|important|fyi|запомни|важно|обрати внимание)\b/iu;
const COMMITMENT = /(?:\b(?:i|we)\s+(?:will|shall|promise|plan to|need to|can deliver)\b|\b(?:я|мы)\s+(?:сделаю|сделаем|обязуюсь|планирую|доставлю|закончу)\b)/iu;
const DEADLINE = /(?:\b(?:deadline|due|eta|by|before|today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b|\b(?:дедлайн|срок|до|сегодня|завтра|понедельник|вторник|сред[ау]|четверг|пятниц[ау]|суббот[ау]|воскресенье)\b|\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}[./-]\d{1,2}(?:[./-]\d{2,4})?\b)/iu;
const DECISION = /\b(?:decided|agreed|approved|confirmed|final decision|решили|договорились|утвердили|подтвердили)\b/iu;
const PROGRESS = /\b(?:blocked|blocker|waiting for|completed|done|shipped|delayed|at risk|progress|блокер|заблокирован|жд[её]м|готово|завершено|отправлено|задерж|риск|прогресс)\b/iu;
const PROCEDURE = /\b(?:always|never|standard|process|workflow|whenever|rule|всегда|никогда|стандарт|процесс|регламент|правило)\b/iu;
const PREFERENCE = /\b(?:prefer|preference|usually|like to|предпочита|обычно|удобнее)\b/iu;
const UNSAFE_INSTRUCTION = /(?:ignore (?:all |the )?(?:previous|prior) instructions|reveal (?:the )?(?:system prompt|secret)|developer message|system message|call (?:the )?tool|обойди (?:правила|инструкции)|игнорируй (?:предыдущие )?инструкции|покажи системн(?:ый|ые) промпт)/iu;
const ACK_ONLY = /^(?:ok|okay|thanks|thank you|got it|yes|no|👍|👌|спасибо|ок|хорошо|понял[аи]?|да|нет)[.!\s]*$/iu;

/**
 * Durable local learning around the existing storage boundary. Inferred group
 * memories are deliberately proposed rather than activated; confirmation is a
 * separate operator/product decision.
 */
export class MemoryEngine {
  readonly #storage: SqliteStorage;
  readonly #embedding: EmbeddingAdapter;
  readonly #minimumSalience: number;
  readonly #feedbackLearningRate: number;
  readonly #retentionDays: number;
  readonly #clock: () => Date;
  readonly #queryVectorCache = new Map<string, number[]>();

  constructor(options: MemoryEngineOptions) {
    this.#storage = options.storage;
    this.#embedding = options.embedding;
    this.#minimumSalience = bounded(options.minimumSalience ?? DEFAULT_MINIMUM_SALIENCE, 0, 1);
    this.#feedbackLearningRate = bounded(options.feedbackLearningRate ?? DEFAULT_LEARNING_RATE, 0.01, 0.25);
    this.#retentionDays = integerInRange(options.retentionDays ?? DEFAULT_RETENTION_DAYS, 1, 3_650);
    this.#clock = options.clock ?? (() => new Date());
    this.ensureAuxiliarySchema();
  }

  get embeddingId(): string {
    return this.#embedding.id;
  }

  assessSalience(text: string): SalienceAssessment {
    return assessSalience(text, this.#minimumSalience);
  }

  async observeGroupMessage(
    input: ObserveGroupMessageInput,
    signal?: AbortSignal,
  ): Promise<GroupObservationResult> {
    if (signal?.aborted) throw abortError(signal);
    requireNonEmpty(input.groupSpaceId, 'groupSpaceId');
    requireNonEmpty(input.externalMessageId, 'externalMessageId');
    requireNonEmpty(input.actorId, 'actorId');
    requireNonEmpty(input.text, 'text');

    const group = this.#storage.getGroupSpace(input.groupSpaceId);
    if (!group.learningEnabled) {
      return {
        observed: false,
        duplicate: false,
        assessment: assessSalience('', this.#minimumSalience),
        redactions: 0,
        reason: 'learning_disabled',
      };
    }

    const redacted = redactObviousSecrets(input.text);
    const text = normalizeObservation(redacted.text);
    const assessment = assessSalience(text, this.#minimumSalience);
    const occurredAt = validTimestamp(input.occurredAt ?? this.#clock().toISOString(), 'occurredAt');
    if (!assessment.salient) {
      return {
        observed: true,
        duplicate: false,
        assessment,
        redactions: redacted.redactions,
      };
    }

    const recorded = this.#storage.recordGroupMessage({
      groupSpaceId: group.id,
      workspaceId: group.workspaceId,
      externalMessageId: input.externalMessageId,
      actorId: input.actorId,
      text,
      transcript: input.transcript ?? false,
      salient: assessment.salient,
      occurredAt,
    });

    const memory = this.#storage.putMemory({
      workspaceId: group.workspaceId,
      ...(group.projectId ? { projectId: group.projectId } : {}),
      kind: assessment.kind,
      content: text,
      importance: assessment.score,
      strength: Math.max(0.1, Math.min(0.75, assessment.score)),
      sourceType: 'group_observation',
      sourceId: recorded.message.id,
      status: 'proposed',
    });

    if (!recorded.duplicate) {
      this.#storage.addLearningSignal({
        workspaceId: group.workspaceId,
        memoryId: memory.id,
        kind: 'group_observation',
        reward: assessment.score,
        metadata: {
          groupSpaceId: group.id,
          messageId: recorded.message.id,
          memoryId: memory.id,
          actorId: input.actorId,
          salient: true,
          salience: assessment.score,
          reasons: assessment.reasons,
          redactions: redacted.redactions,
          transcript: input.transcript ?? false,
        },
      });
    }

    return {
      observed: true,
      duplicate: recorded.duplicate,
      assessment,
      redactions: redacted.redactions,
      messageId: recorded.message.id,
      memory,
    };
  }

  /** Review/status transition. Only active memory is eligible for embedding. */
  async setStatus(
    memoryId: string,
    workspaceId: string,
    status: MemoryRecord['status'],
    signal?: AbortSignal,
  ): Promise<MemoryStatusResult> {
    const memory = this.#storage.setMemoryStatus(memoryId, workspaceId, status);
    if (status !== 'active') return { memory, embedding: 'deferred' };
    if (this.hasCurrentEmbedding(memory.id)) return { memory, embedding: 'stored' };
    try {
      await this.embedMemory(memory.id, signal);
      return { memory, embedding: 'stored' };
    } catch (error) {
      if (signal?.aborted) throw abortError(signal);
      return {
        memory,
        embedding: 'failed',
        embeddingError: safeErrorMessage(error),
      };
    }
  }

  async embedMemory(memoryId: string, signal?: AbortSignal): Promise<number[]> {
    if (signal?.aborted) throw abortError(signal);
    const memory = this.#storage.getMemory(memoryId);
    if (memory.status !== 'active') {
      throw new Error(`Memory ${memory.id} must be active before embedding`);
    }
    const vectors = await this.#embedding.embed([memory.content], signal);
    if (vectors.length !== 1 || !vectors[0]) {
      throw new Error(`Embedding adapter ${this.#embedding.id} must return exactly one vector`);
    }
    const vector = normalizeVector(vectors[0]);
    if (this.#embedding.dimensions !== undefined && vector.length !== this.#embedding.dimensions) {
      throw new Error(
        `Embedding adapter ${this.#embedding.id} returned ${vector.length} dimensions; expected ${this.#embedding.dimensions}`,
      );
    }
    this.#storage.putMemoryEmbedding(memory.id, this.#embedding.id, vector);
    return vector;
  }

  async search(
    scope: MemorySearchScope,
    query: string,
    options: MemorySearchOptions = {},
  ): Promise<MemorySearchResult> {
    requireNonEmpty(scope.workspaceId, 'workspaceId');
    requireNonEmpty(query, 'query');
    const limit = integerInRange(options.limit ?? 6, 1, 100);
    if (options.runId) {
      const run = this.#storage.getRun(options.runId);
      if (run.workspaceId !== scope.workspaceId) {
        throw new Error('Memory search run and workspace scopes do not match');
      }
      if ((run.projectId ?? null) !== (scope.projectId ?? null)
        || run.actorId !== scope.actorId) {
        throw new Error('Memory search scope must match the run project and actor');
      }
    }

    let memories: MemoryRecord[];
    let mode: MemorySearchResult['mode'];
    let embeddingError: string | undefined;
    try {
      if (options.signal?.aborted) throw abortError(options.signal);
      const vector = await this.queryVector(scope.workspaceId, query, options.signal);
      if (this.#embedding.dimensions !== undefined && vector.length !== this.#embedding.dimensions) {
        throw new Error(
          `Embedding adapter ${this.#embedding.id} returned ${vector.length} dimensions; expected ${this.#embedding.dimensions}`,
        );
      }
      memories = this.#storage.searchMemoriesHybrid(scope, query, vector, this.#embedding.id, limit);
      mode = 'hybrid';
    } catch (error) {
      if (options.signal?.aborted) throw abortError(options.signal);
      memories = this.#storage.searchMemories(scope, query, limit);
      mode = 'lexical_fallback';
      embeddingError = safeErrorMessage(error);
    }

    if (options.runId && memories.length) {
      this.#storage.recordMemoryUsage(options.runId, memories.map((memory) => memory.id));
    }
    return {
      memories,
      mode,
      ...(embeddingError ? { embeddingError } : {}),
    };
  }

  /** Attribute only records that were actually exposed to the model/tool caller. */
  recordUsage(runId: string, memoryIds: string[]): void {
    this.#storage.recordMemoryUsage(runId, memoryIds);
  }

  applyFeedback(feedbackId: string, learningRate = this.#feedbackLearningRate): ReinforcementResult {
    requireNonEmpty(feedbackId, 'feedbackId');
    const feedback = this.#storage.getFeedback(feedbackId);
    const run = this.#storage.getRun(feedback.runId);
    const reward = bounded(feedback.score, -1, 1);
    const rate = bounded(learningRate, 0.01, 0.25);
    const rows = this.#storage.db
      .prepare(`SELECT memories.id AS memory_id
        FROM memories
        JOIN run_memory_usage ON run_memory_usage.memory_id = memories.id
        WHERE run_memory_usage.run_id = ? AND memories.workspace_id = ?
        ORDER BY memories.id`)
      .all(run.id, run.workspaceId) as Array<Record<string, unknown>>;
    const memoryIds = rows.map((row) => requiredRowString(row, 'memory_id'));
    const appliedMemoryIds: string[] = [];
    const alreadyAppliedMemoryIds: string[] = [];
    const timestamp = this.#clock().toISOString();

    this.#storage.db.exec('BEGIN IMMEDIATE');
    try {
      const mark = this.#storage.db.prepare(`INSERT OR IGNORE INTO memory_feedback_applications
        (feedback_id, run_id, memory_id, reward, learning_rate, applied_at)
        VALUES (?, ?, ?, ?, ?, ?)`);
      const update = this.#storage.db.prepare(`UPDATE memories SET
        reward = MAX(-1, MIN(1, reward * (1 - ?) + ? * ?)),
        strength = MAX(0.05, MIN(1, strength + ? * ? * 0.25)),
        updated_at = ?
        WHERE id = ? AND workspace_id = ?`);
      const signal = this.#storage.db.prepare(`INSERT INTO learning_signals
        (id, workspace_id, run_id, memory_id, route_id, kind, reward, metadata_json, created_at)
        VALUES (?, ?, ?, ?, NULL, 'memory_reward', ?, ?, ?)`);

      for (const memoryId of memoryIds) {
        const inserted = mark.run(feedback.id, run.id, memoryId, reward, rate, timestamp);
        if (Number(inserted.changes) === 0) {
          alreadyAppliedMemoryIds.push(memoryId);
          continue;
        }
        update.run(rate, reward, rate, reward, rate, timestamp, memoryId, run.workspaceId);
        signal.run(
          randomUUID(),
          run.workspaceId,
          run.id,
          memoryId,
          reward,
          JSON.stringify({ feedbackId: feedback.id, learningRate: rate, algorithm: 'bounded-ewma-v1' }),
          timestamp,
        );
        appliedMemoryIds.push(memoryId);
      }
      this.#storage.db.exec('COMMIT');
    } catch (error) {
      this.#storage.db.exec('ROLLBACK');
      throw error;
    }

    return {
      feedbackId: feedback.id,
      runId: run.id,
      reward,
      appliedMemoryIds,
      alreadyAppliedMemoryIds,
      memories: memoryIds.map((memoryId) => this.#storage.getMemory(memoryId)),
    };
  }

  purgeExpired(options: PurgeOptions = {}): PurgeResult {
    const retentionDays = integerInRange(options.retentionDays ?? this.#retentionDays, 1, 3_650);
    const asOf = options.asOf ?? this.#clock();
    if (!Number.isFinite(asOf.getTime())) throw new Error('asOf must be a valid date');
    const cutoff = new Date(asOf.getTime() - retentionDays * 86_400_000).toISOString();
    const workspaceId = options.workspaceId;
    let messagesDeleted = 0;
    let memoriesDeleted = 0;
    let signalsDeleted = 0;

    this.#storage.db.exec('BEGIN IMMEDIATE');
    try {
      const memoryRows = workspaceId
        ? (this.#storage.db.prepare(`SELECT memories.id, memories.source_id
            FROM memories
            LEFT JOIN group_messages ON group_messages.id = memories.source_id
            WHERE memories.source_type = 'group_observation'
              AND memories.workspace_id = ?
              AND (group_messages.id IS NULL OR group_messages.occurred_at < ?)
            ORDER BY memories.id`).all(workspaceId, cutoff) as Array<Record<string, unknown>>)
        : (this.#storage.db.prepare(`SELECT memories.id, memories.source_id
            FROM memories
            LEFT JOIN group_messages ON group_messages.id = memories.source_id
            WHERE memories.source_type = 'group_observation'
              AND (group_messages.id IS NULL OR group_messages.occurred_at < ?)
            ORDER BY memories.id`).all(cutoff) as Array<Record<string, unknown>>);
      const messageRows = workspaceId
        ? (this.#storage.db.prepare(`SELECT id FROM group_messages
            WHERE workspace_id = ? AND occurred_at < ? ORDER BY id`)
            .all(workspaceId, cutoff) as Array<Record<string, unknown>>)
        : (this.#storage.db.prepare(`SELECT id FROM group_messages
            WHERE occurred_at < ? ORDER BY id`).all(cutoff) as Array<Record<string, unknown>>);
      const deleteApplications = this.#storage.db.prepare(
        'DELETE FROM memory_feedback_applications WHERE memory_id = ?',
      );
      const deleteUsage = this.#storage.db.prepare('DELETE FROM run_memory_usage WHERE memory_id = ?');
      const detachSignals = this.#storage.db.prepare('UPDATE learning_signals SET memory_id = NULL WHERE memory_id = ?');
      const deleteObservationSignalsForMemory = this.#storage.db.prepare(`DELETE FROM learning_signals
        WHERE workspace_id = ? AND kind = 'group_observation' AND (
          memory_id = ?
          OR CASE WHEN json_valid(metadata_json) THEN json_extract(metadata_json, '$.memoryId') END = ?
          OR CASE WHEN json_valid(metadata_json) THEN json_extract(metadata_json, '$.messageId') END = ?
        )`);
      const deleteObservationSignalsForMessage = this.#storage.db.prepare(`DELETE FROM learning_signals
        WHERE kind = 'group_observation'
          AND CASE WHEN json_valid(metadata_json) THEN json_extract(metadata_json, '$.messageId') END = ?`);
      const deleteMemory = this.#storage.db.prepare('DELETE FROM memories WHERE id = ?');
      for (const row of memoryRows) {
        const memoryId = requiredRowString(row, 'id');
        const sourceId = requiredRowString(row, 'source_id');
        const memory = this.#storage.getMemory(memoryId);
        signalsDeleted += Number(deleteObservationSignalsForMemory
          .run(memory.workspaceId, memoryId, memoryId, sourceId).changes);
        deleteApplications.run(memoryId);
        deleteUsage.run(memoryId);
        detachSignals.run(memoryId);
        memoriesDeleted += Number(deleteMemory.run(memoryId).changes);
      }

      for (const row of messageRows) {
        signalsDeleted += Number(deleteObservationSignalsForMessage
          .run(requiredRowString(row, 'id')).changes);
      }

      const messageDelete = workspaceId
        ? this.#storage.db.prepare('DELETE FROM group_messages WHERE workspace_id = ? AND occurred_at < ?')
            .run(workspaceId, cutoff)
        : this.#storage.db.prepare('DELETE FROM group_messages WHERE occurred_at < ?').run(cutoff);
      messagesDeleted = Number(messageDelete.changes);
      const signalDelete = workspaceId
        ? this.#storage.db.prepare(`DELETE FROM learning_signals
            WHERE workspace_id = ? AND kind = 'group_observation' AND created_at < ?`)
            .run(workspaceId, cutoff)
        : this.#storage.db.prepare(`DELETE FROM learning_signals
            WHERE kind = 'group_observation' AND created_at < ?`).run(cutoff);
      signalsDeleted += Number(signalDelete.changes);
      this.#storage.db.exec('COMMIT');
    } catch (error) {
      this.#storage.db.exec('ROLLBACK');
      throw error;
    }

    return { cutoff, messagesDeleted, memoriesDeleted, signalsDeleted };
  }

  private ensureAuxiliarySchema(): void {
    this.#storage.db.exec(`CREATE TABLE IF NOT EXISTS memory_feedback_applications (
      feedback_id TEXT NOT NULL REFERENCES feedback(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      reward REAL NOT NULL,
      learning_rate REAL NOT NULL,
      applied_at TEXT NOT NULL,
      PRIMARY KEY(feedback_id, memory_id)
    )`);
  }

  private hasCurrentEmbedding(memoryId: string): boolean {
    const row = this.#storage.db
      .prepare('SELECT model FROM memory_embeddings WHERE memory_id = ?')
      .get(memoryId) as Record<string, unknown> | undefined;
    return row?.model === this.#embedding.id;
  }

  private async queryVector(
    workspaceId: string,
    query: string,
    signal?: AbortSignal,
  ): Promise<number[]> {
    if (signal?.aborted) throw abortError(signal);
    const embeddingQuery = formatEmbeddingQuery(this.#embedding.id, query);
    const cacheKey = createHash('sha256')
      .update(workspaceId)
      .update('\u0000')
      .update(this.#embedding.id)
      .update('\u0000')
      .update(embeddingQuery)
      .digest('hex');
    const cached = this.#queryVectorCache.get(cacheKey);
    if (cached) {
      this.#queryVectorCache.delete(cacheKey);
      this.#queryVectorCache.set(cacheKey, cached);
      return [...cached];
    }
    const vectors = await this.#embedding.embed([embeddingQuery], signal);
    if (vectors.length !== 1 || !vectors[0]) {
      throw new Error(`Embedding adapter ${this.#embedding.id} must return exactly one query vector`);
    }
    const vector = normalizeVector(vectors[0]);
    if (this.#embedding.dimensions !== undefined && vector.length !== this.#embedding.dimensions) {
      throw new Error(
        `Embedding adapter ${this.#embedding.id} returned ${vector.length} dimensions; expected ${this.#embedding.dimensions}`,
      );
    }
    this.#queryVectorCache.set(cacheKey, [...vector]);
    while (this.#queryVectorCache.size > 32) {
      const oldest = this.#queryVectorCache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#queryVectorCache.delete(oldest);
    }
    return vector;
  }

}

export function assessSalience(
  text: string,
  minimumSalience = DEFAULT_MINIMUM_SALIENCE,
): SalienceAssessment {
  const normalized = normalizeObservation(text);
  const reasons: string[] = [];
  let score = 0;
  let kind: MemoryRecord['kind'] = 'semantic';
  let eligible = true;
  const tokenCount = normalized ? normalized.split(/\s+/u).length : 0;

  if (normalized.length >= 20) score += 0.08;
  if (tokenCount >= 5) score += 0.08;
  if (EXPLICIT_MEMORY.test(normalized)) {
    score += 0.4;
    reasons.push('explicit_memory');
  }
  if (COMMITMENT.test(normalized)) {
    score += 0.3;
    kind = 'episodic';
    reasons.push('commitment');
  }
  if (DEADLINE.test(normalized)) {
    score += 0.45;
    kind = 'episodic';
    reasons.push('deadline');
  }
  if (DECISION.test(normalized)) {
    score += 0.35;
    reasons.push('decision');
  }
  if (PROGRESS.test(normalized)) {
    score += 0.35;
    kind = 'episodic';
    reasons.push('progress_or_blocker');
  }
  if (PREFERENCE.test(normalized)) {
    score += 0.25;
    reasons.push('preference');
  }
  if (PROCEDURE.test(normalized)) {
    score += 0.3;
    kind = 'procedural';
    reasons.push('procedure');
  }
  if (!normalized || ACK_ONLY.test(normalized) || /^\//u.test(normalized)) {
    score -= 1;
    eligible = false;
    reasons.push('low_information');
  }
  if (UNSAFE_INSTRUCTION.test(normalized)) {
    score -= 1;
    eligible = false;
    reasons.push('unsafe_instruction');
  }

  const boundedScore = round(bounded(score, 0, 1), 3);
  return {
    score: boundedScore,
    salient: eligible && boundedScore >= bounded(minimumSalience, 0, 1),
    eligible,
    kind,
    reasons,
  };
}

export function redactObviousSecrets(input: string): SecretRedactionResult {
  let text = input;
  let redactions = 0;
  for (const pattern of SECRET_PATTERNS) {
    const expression = new RegExp(pattern.source, pattern.flags);
    text = text.replace(expression, (...args: unknown[]) => {
      redactions += 1;
      return expandReplacement(pattern.replacement, args);
    });
  }
  return { text, redactions };
}

function expandReplacement(replacement: string, replaceArguments: unknown[]): string {
  const captures = replaceArguments.slice(1, -2);
  return replacement.replace(/\$(\d+)/gu, (_match, index: string) => {
    const value = captures[Number(index) - 1];
    return typeof value === 'string' ? value : '';
  });
}

function normalizeObservation(value: string): string {
  const normalized = value.replace(/\u0000/gu, '').replace(/\s+/gu, ' ').trim();
  return normalized.slice(0, MAX_OBSERVATION_CHARACTERS);
}

function normalizeVector(values: number[]): number[] {
  if (!values.length || values.some((value) => !Number.isFinite(value))) {
    throw new Error('Embedding vector must contain finite numbers');
  }
  const magnitude = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  if (!Number.isFinite(magnitude) || magnitude === 0) {
    throw new Error('Embedding vector must have non-zero magnitude');
  }
  return values.map((value) => value / magnitude);
}

function requireNonEmpty(value: string, name: string): void {
  if (!value.trim()) throw new Error(`${name} must not be empty`);
}

function validTimestamp(value: string, name: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error(`${name} must be an ISO timestamp`);
  return new Date(timestamp).toISOString();
}

function bounded(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) throw new Error('Numeric learning values must be finite');
  return Math.max(minimum, Math.min(maximum, value));
}

function integerInRange(value: number, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`Expected an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function round(value: number, precision: number): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

function requiredRowString(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') throw new Error(`Expected ${key} to be a string`);
  return value;
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactObviousSecrets(message).text.slice(0, 500);
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('Operation aborted');
}

export function observationMetadata(value: {
  salience: SalienceAssessment;
  redactions: number;
}): JsonObject {
  return {
    salience: value.salience.score,
    salient: value.salience.salient,
    eligible: value.salience.eligible,
    kind: value.salience.kind,
    reasons: value.salience.reasons,
    redactions: value.redactions,
  };
}
