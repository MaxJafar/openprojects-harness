import { createHash } from 'node:crypto';

import type {
  CorporateRecord,
  CorporateRecordDomain,
  CorporateSourceSummary,
  CorporateSyncState,
  EmbeddingAdapter,
  EmbeddingDataBoundary,
  JsonObject,
  JsonValue,
} from '../core/types.js';
import { redactObviousSecrets } from '../learning/memory-engine.js';
import type {
  CorporateBatchStorageResult,
  CorporateSearchOptions,
  PreparedCorporateRecord,
} from '../storage/sqlite.js';
import { SqliteStorage } from '../storage/sqlite.js';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/u;
const SAFE_TYPE = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,127}$/u;
const DOMAINS = new Set<CorporateRecordDomain>([
  'project',
  'crm',
  'erp',
  'email',
  'messaging',
  'calendar',
  'document',
  'other',
]);
const MAX_BATCH_RECORDS = 100;
const MAX_BATCH_BYTES = 2_000_000;
const MAX_TITLE_BYTES = 4_096;
const MAX_CONTENT_BYTES = 65_536;
const MAX_METADATA_BYTES = 16_384;
const MAX_QUERY_BYTES = 4_096;
const MAX_CURSOR_BYTES = 4_096;
const MAX_SOURCE_VERSION_BYTES = 512;
const MAX_SOURCE_URL_BYTES = 2_048;
const MAX_METADATA_DEPTH = 8;
const MAX_METADATA_NODES = 512;
const SENSITIVE_METADATA_KEY = /(?:^|[._-])(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret|credential)(?:$|[._-])/iu;
const EMBEDDING_BATCH_SIZE = 16;

export interface CorporateRecordInput {
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
  status?: CorporateRecord['status'];
  metadata?: JsonObject;
}

export interface CorporateBatchInput {
  workspaceId: string;
  source: string;
  /** Immutable provider tenant/account identity, verified by the connector sidecar. */
  sourceAccountId: string;
  stream: string;
  /** Authenticated connector/service identity. Never supplied by model text. */
  ingestedBy: string;
  /** Compare-and-swap fence: the checkpoint cursor read before producing this page. */
  previousCursor?: string;
  cursor?: string;
  sourceWatermark?: string;
  records: readonly CorporateRecordInput[];
}

export interface CorporateIngestResult {
  records: CorporateRecord[];
  inserted: number;
  updated: number;
  unchanged: number;
  stale: number;
  checkpoint: CorporateSyncState;
  embeddings: {
    model: string;
    dataBoundary: EmbeddingDataBoundary | 'unreported';
    stored: number;
    failed: number;
    error?: string;
  };
}

export interface CorporateSearchInput {
  workspaceId: string;
  query: string;
  projectId?: string;
  source?: string;
  domain?: CorporateRecordDomain;
  asOf?: string;
  /** Return only versions the harness had actually observed by this host time. */
  knownAt?: string;
  limit?: number;
}

export interface CorporateSearchResult {
  records: CorporateRecord[];
  mode: 'hybrid' | 'lexical_fallback' | 'lexical_historical';
  embeddingModel: string;
  embeddingError?: string;
}

export interface CorporateEmbeddingBackfillInput {
  workspaceId: string;
  source?: string;
  limit?: number;
}

export interface CorporateEmbeddingBackfillResult {
  model: string;
  dataBoundary: EmbeddingDataBoundary | 'unreported';
  candidates: number;
  stored: number;
  failed: number;
  error?: string;
}

export class CorporateOracle {
  constructor(
    readonly storage: SqliteStorage,
    readonly embedding: EmbeddingAdapter,
    readonly clock: () => Date = () => new Date(),
  ) {}

  async ingestBatch(input: CorporateBatchInput, signal?: AbortSignal): Promise<CorporateIngestResult> {
    const workspaceId = safeId(input.workspaceId, 'workspaceId');
    const source = safeId(input.source, 'source');
    const sourceAccountId = safeId(input.sourceAccountId, 'sourceAccountId');
    const stream = safeId(input.stream, 'stream');
    const ingestedBy = safeId(input.ingestedBy, 'ingestedBy');
    const previousCursor = optionalBoundedText(
      input.previousCursor,
      'previousCursor',
      MAX_CURSOR_BYTES,
      false,
    );
    const cursor = optionalBoundedText(input.cursor, 'cursor', MAX_CURSOR_BYTES, false);
    const sourceWatermark = input.sourceWatermark
      ? normalizedTimestamp(input.sourceWatermark, 'sourceWatermark')
      : undefined;
    if (!Array.isArray(input.records) || input.records.length > MAX_BATCH_RECORDS) {
      throw new Error(`Corporate sync pages may contain at most ${MAX_BATCH_RECORDS} records`);
    }
    const observedAt = this.clock().toISOString();
    const seen = new Set<string>();
    const prepared = input.records.map((record) => {
      const normalized = prepareRecord(
        record,
        { workspaceId, source, sourceAccountId, stream, ingestedBy },
        observedAt,
      );
      if (seen.has(normalized.externalId)) {
        throw new Error('Corporate sync pages must not repeat an externalId');
      }
      seen.add(normalized.externalId);
      return normalized;
    });
    const pageCommitment = canonicalJson({
      schema: previousCursor === undefined
        ? 'openprojects.corporate-sync-page.v1'
        : 'openprojects.corporate-sync-page.v2',
      workspaceId,
      source,
      sourceAccountId,
      stream,
      ...(previousCursor === undefined ? {} : { previousCursor }),
      cursor: cursor ?? null,
      sourceWatermark: sourceWatermark ?? null,
      records: prepared.map((record) => ({
        externalId: record.externalId,
        sourceUpdatedAt: record.sourceUpdatedAt,
        status: record.status,
        contentSha256: record.contentSha256,
      })),
    });
    if (Buffer.byteLength(pageCommitment, 'utf8') > MAX_BATCH_BYTES) {
      throw new Error(`Corporate sync page exceeds ${MAX_BATCH_BYTES} bytes`);
    }
    const batchSha256 = sha256(pageCommitment);
    const stored = this.storage.ingestCorporateBatch(prepared, {
      workspaceId,
      source,
      sourceAccountId,
      stream,
      ...(previousCursor ? { previousCursor } : {}),
      ...(cursor ? { cursor } : {}),
      ...(sourceWatermark ? { sourceWatermark } : {}),
      batchSha256,
      successAt: observedAt,
    });
    const embeddingResult = await this.embedChanged(stored, signal);
    return {
      records: stored.records,
      inserted: stored.inserted,
      updated: stored.updated,
      unchanged: stored.unchanged,
      stale: stored.stale,
      checkpoint: stored.checkpoint,
      embeddings: embeddingResult,
    };
  }

  async search(input: CorporateSearchInput, signal?: AbortSignal): Promise<CorporateSearchResult> {
    const workspaceId = safeId(input.workspaceId, 'workspaceId');
    const query = boundedText(input.query, 'query', MAX_QUERY_BYTES, true);
    const projectId = input.projectId ? safeId(input.projectId, 'projectId') : undefined;
    const source = input.source ? safeId(input.source, 'source') : undefined;
    const domain = input.domain ? validDomain(input.domain) : undefined;
    const asOf = input.asOf ? normalizedTimestamp(input.asOf, 'asOf') : undefined;
    const knownAt = input.knownAt ? normalizedTimestamp(input.knownAt, 'knownAt') : undefined;
    const limit = input.limit ?? 8;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) {
      throw new Error('Corporate search limit must be an integer between 1 and 20');
    }
    const common: CorporateSearchOptions = {
      ...(projectId ? { projectId } : {}),
      ...(source ? { source } : {}),
      ...(domain ? { domain } : {}),
      ...(asOf ? { asOf } : {}),
      ...(knownAt ? { knownAt } : {}),
      limit,
    };
    if (asOf || knownAt) {
      return {
        records: this.storage.searchCorporateRecords(workspaceId, query, common),
        mode: 'lexical_historical',
        embeddingModel: this.embedding.id,
      };
    }
    try {
      const [queryVector] = await this.embedding.embed([query], signal);
      if (!queryVector) throw new Error('Embedding adapter returned no query vector');
      return {
        records: this.storage.searchCorporateRecords(workspaceId, query, {
          ...common,
          queryVector,
          embeddingModel: this.embedding.id,
        }),
        mode: 'hybrid',
        embeddingModel: this.embedding.id,
      };
    } catch (error) {
      return {
        records: this.storage.searchCorporateRecords(workspaceId, query, common),
        mode: 'lexical_fallback',
        embeddingModel: this.embedding.id,
        embeddingError: safeError(error),
      };
    }
  }

  listSources(workspaceId: string): CorporateSourceSummary[] {
    return this.storage.listCorporateSources(safeId(workspaceId, 'workspaceId'));
  }

  getCheckpoint(workspaceId: string, source: string, stream: string): CorporateSyncState | undefined {
    return this.storage.getCorporateSyncState(
      safeId(workspaceId, 'workspaceId'),
      safeId(source, 'source'),
      safeId(stream, 'stream'),
    );
  }

  forgetSource(workspaceId: string, source: string, stream?: string): {
    recordsDeleted: number;
    checkpointsDeleted: number;
  } {
    return this.storage.forgetCorporateSource(
      safeId(workspaceId, 'workspaceId'),
      safeId(source, 'source'),
      stream ? safeId(stream, 'stream') : undefined,
    );
  }

  async backfillEmbeddings(
    input: CorporateEmbeddingBackfillInput,
    signal?: AbortSignal,
  ): Promise<CorporateEmbeddingBackfillResult> {
    const workspaceId = safeId(input.workspaceId, 'workspaceId');
    const source = input.source ? safeId(input.source, 'source') : undefined;
    const limit = input.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('Corporate embedding backfill limit must be an integer between 1 and 100');
    }
    const records = this.storage.listCorporateRecordsNeedingEmbedding(
      workspaceId,
      this.embedding.id,
      source,
      limit,
    );
    const result = await this.embedRecords(records, signal);
    return { candidates: records.length, ...result };
  }

  private async embedChanged(
    stored: CorporateBatchStorageResult,
    signal?: AbortSignal,
  ): Promise<CorporateIngestResult['embeddings']> {
    const changed = stored.records.filter(
      (record) => record.status === 'active' && (
        stored.changedRecordIds.includes(record.id)
        || !this.storage.hasCorporateRecordEmbedding(
          record.id,
          record.workspaceId,
          this.embedding.id,
          record.contentSha256,
        )
      ),
    );
    return this.embedRecords(changed, signal);
  }

  private async embedRecords(
    records: readonly CorporateRecord[],
    signal?: AbortSignal,
  ): Promise<CorporateIngestResult['embeddings']> {
    let storedCount = 0;
    let failed = 0;
    let firstError: string | undefined;
    for (let offset = 0; offset < records.length; offset += EMBEDDING_BATCH_SIZE) {
      const batch = records.slice(offset, offset + EMBEDDING_BATCH_SIZE);
      let storedInBatch = 0;
      try {
        const vectors = await this.embedding.embed(batch.map(corporateEmbeddingText), signal);
        if (vectors.length !== batch.length) {
          throw new Error('Embedding adapter returned the wrong corporate batch size');
        }
        for (let index = 0; index < batch.length; index += 1) {
          const record = batch[index];
          const vector = vectors[index];
          if (!record || !vector) throw new Error('Corporate embedding result is incomplete');
          this.storage.putCorporateRecordEmbedding(
            record.id,
            record.workspaceId,
            this.embedding.id,
            record.contentSha256,
            vector,
          );
          storedCount += 1;
          storedInBatch += 1;
        }
      } catch (error) {
        // Earlier writes in this batch are already durable. Count only the
        // failing item and unattempted remainder so receipt totals cannot
        // double-count a partially stored batch.
        failed += batch.length - storedInBatch;
        firstError ??= safeError(error);
      }
    }
    return {
      model: this.embedding.id,
      dataBoundary: this.embedding.dataBoundary ?? 'unreported',
      stored: storedCount,
      failed,
      ...(firstError ? { error: firstError } : {}),
    };
  }
}

function prepareRecord(
  input: CorporateRecordInput,
  scope: Pick<
    PreparedCorporateRecord,
    'workspaceId' | 'source' | 'sourceAccountId' | 'stream' | 'ingestedBy'
  >,
  defaultObservedAt: string,
): PreparedCorporateRecord {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Each corporate record must be an object');
  }
  const externalId = safeId(input.externalId, 'externalId');
  const domain = validDomain(input.domain);
  const recordType = safeType(input.recordType, 'recordType');
  const projectId = input.projectId ? safeId(input.projectId, 'projectId') : undefined;
  const status = input.status ?? 'active';
  if (status !== 'active' && status !== 'deleted') {
    throw new Error('Corporate record status must be active or deleted');
  }
  const title = redactObviousSecrets(
    boundedText(input.title, 'title', MAX_TITLE_BYTES, status === 'active'),
  ).text;
  const content = redactObviousSecrets(
    boundedText(input.content, 'content', MAX_CONTENT_BYTES, status === 'active'),
  ).text;
  const sourceUrl = input.sourceUrl ? validSourceUrl(input.sourceUrl) : undefined;
  const sourceVersion = optionalBoundedText(
    input.sourceVersion,
    'sourceVersion',
    MAX_SOURCE_VERSION_BYTES,
    false,
  );
  const occurredAt = normalizedTimestamp(input.occurredAt, 'occurredAt');
  const sourceUpdatedAt = normalizedTimestamp(input.sourceUpdatedAt, 'sourceUpdatedAt');
  const observedAt = normalizedTimestamp(defaultObservedAt, 'observedAt');
  const metadata = input.metadata ?? {};
  validateMetadata(metadata);
  const contentSha256 = sha256(canonicalJson({
    domain,
    recordType,
    projectId: projectId ?? null,
    title,
    content,
    sourceUrl: sourceUrl ?? null,
    sourceVersion: sourceVersion ?? null,
    occurredAt,
    sourceUpdatedAt,
    status,
    metadata,
  }));
  return {
    ...scope,
    externalId,
    domain,
    recordType,
    ...(projectId ? { projectId } : {}),
    title,
    content,
    ...(sourceUrl ? { sourceUrl } : {}),
    ...(sourceVersion ? { sourceVersion } : {}),
    occurredAt,
    sourceUpdatedAt,
    observedAt,
    status,
    contentSha256,
    metadata,
  };
}

function corporateEmbeddingText(record: CorporateRecord): string {
  return `${record.domain}/${record.recordType}\n${record.title}\n${record.content}`;
}

function safeId(value: string, field: string): string {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    throw new Error(`${field} must be a safe identifier of at most 256 characters`);
  }
  return value;
}

function safeType(value: string, field: string): string {
  if (typeof value !== 'string' || !SAFE_TYPE.test(value)) {
    throw new Error(`${field} must be a safe identifier of at most 128 characters`);
  }
  return value;
}

function validDomain(value: CorporateRecordDomain): CorporateRecordDomain {
  if (!DOMAINS.has(value)) throw new Error('Corporate record domain is not supported');
  return value;
}

function boundedText(value: string, field: string, maximumBytes: number, nonEmpty: boolean): string {
  if (
    typeof value !== 'string'
    || (nonEmpty && !value.trim())
    || Buffer.byteLength(value, 'utf8') > maximumBytes
    || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value)
  ) {
    throw new Error(`${field} must be safe UTF-8 text of at most ${maximumBytes} bytes`);
  }
  return value;
}

function optionalBoundedText(
  value: string | undefined,
  field: string,
  maximumBytes: number,
  allowLineBreaks: boolean,
): string | undefined {
  if (value === undefined) return undefined;
  const controls = allowLineBreaks
    ? /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u
    : /[\u0000-\u001F\u007F]/u;
  if (!value || Buffer.byteLength(value, 'utf8') > maximumBytes || controls.test(value)) {
    throw new Error(`${field} must be non-empty safe text of at most ${maximumBytes} bytes`);
  }
  return value;
}

function validSourceUrl(value: string): string {
  if (Buffer.byteLength(value, 'utf8') > MAX_SOURCE_URL_BYTES) {
    throw new Error(`sourceUrl must not exceed ${MAX_SOURCE_URL_BYTES} bytes`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('sourceUrl must be an absolute HTTP(S) URL');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('sourceUrl must be an absolute credential-free HTTP(S) URL');
  }
  if (url.search || url.hash) {
    throw new Error('sourceUrl must not contain query parameters or fragments');
  }
  return url.toString();
}

function normalizedTimestamp(value: string, field: string): string {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value, 'utf8') > 128) {
    throw new Error(`${field} must be a bounded ISO timestamp`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${field} must be a valid ISO timestamp`);
  return new Date(parsed).toISOString();
}

function validateMetadata(value: JsonObject): void {
  const canonical = canonicalJson(value, true);
  if (Buffer.byteLength(canonical, 'utf8') > MAX_METADATA_BYTES) {
    throw new Error(`Corporate metadata exceeds ${MAX_METADATA_BYTES} bytes`);
  }
}

function canonicalJson(value: JsonValue, validateBounds = false): string {
  let nodes = 0;
  const normalize = (item: JsonValue, depth: number): JsonValue => {
    nodes += 1;
    if (validateBounds && (nodes > MAX_METADATA_NODES || depth > MAX_METADATA_DEPTH)) {
      throw new Error('Corporate metadata exceeds structural limits');
    }
    if (Array.isArray(item)) return item.map((entry) => normalize(entry, depth + 1));
    if (item && typeof item === 'object') {
      return Object.fromEntries(
        Object.entries(item)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, entry]) => {
            if (validateBounds && (!key || key.length > 128 || /[\u0000-\u001F\u007F]/u.test(key))) {
              throw new Error('Corporate metadata keys must be bounded and control-free');
            }
            if (validateBounds && SENSITIVE_METADATA_KEY.test(key)) {
              throw new Error('Corporate metadata must not contain credential fields');
            }
            return [key, normalize(entry, depth + 1)];
          }),
      );
    }
    if (typeof item === 'number' && !Number.isFinite(item)) {
      throw new Error('Corporate metadata numbers must be finite');
    }
    if (typeof item === 'string' && /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(item)) {
      throw new Error('Corporate metadata strings contain forbidden control characters');
    }
    return item;
  };
  return JSON.stringify(normalize(value, 0));
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactObviousSecrets(message)
    .text
    .replace(/[\u0000-\u001F\u007F]/gu, ' ')
    .slice(0, 512);
}
