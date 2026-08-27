import { createHash, randomUUID } from 'node:crypto';

import type { CorporateRecordInput } from '../oracle/corporate-oracle.js';
import { redactObviousSecrets } from '../learning/memory-engine.js';
import { OracleSidecarClient, OracleSyncAmbiguousError } from './oracle-client.js';
import {
  createSidecarProvider,
  type SidecarProviderAdapter,
  type SidecarProviderDependencies,
} from './providers/index.js';
import { openSidecarState, type SidecarState } from './state.js';
import {
  SIDECAR_CURSOR_SCHEMA,
  SIDECAR_REPORT_SCHEMA,
  type LoadedSidecarConfig,
  type PendingSidecarPage,
  type SidecarCheckpoint,
  type SidecarCheckpointEvidence,
  type SidecarCursor,
  type SidecarReport,
  type SidecarRequestEvidence,
  type SidecarSyncReceipt,
} from './types.js';

const CURSOR_PREFIX = 'opsc1.';
const MAX_CURSOR_BYTES = 4_096;
const MAX_EMBEDDING_EVIDENCE_VALUES = 8;

const REMAINING_UNQUALIFIED = Object.freeze([
  'provider OAuth authorization, consent, refresh, rotation, and revocation',
  'provider deletion and archive reconciliation',
  'complete Oracle deployment inside a 4 GB total-system envelope',
  'physical Windows deployment, NTFS ACL, firewall, and Task Scheduler behavior',
  'Linux CI and target Linux VM deployment',
  'live vision readiness and product vision ingestion',
]);

export interface SidecarRunnerDependencies {
  readonly provider?: SidecarProviderAdapter;
  readonly providerDependencies?: SidecarProviderDependencies;
  readonly oracle?: OracleSidecarClient;
  readonly state?: SidecarState;
  readonly clock?: () => Date;
  readonly uuid?: () => string;
  /** Any injected transport or clock must explicitly disqualify live evidence. */
  readonly testSeam?: boolean;
}

interface MutableSyncTotals {
  connected: boolean;
  ingestionWritesAttempted: boolean;
  pagesAcknowledged: number;
  pagesPossiblyCommitted: number;
  lastWriteOutcome: SidecarReport['oracle']['lastWriteOutcome'];
  recordsReceived: number;
  inserted: number;
  updated: number;
  unchanged: number;
  stale: number;
  embeddings: MutableEmbeddingTotals;
  cycleComplete: boolean;
  finalCheckpoint?: SidecarCheckpointEvidence;
}

interface MutableEmbeddingTotals {
  invoked: boolean;
  invocationOutcome: SidecarReport['oracle']['embeddings']['invocationOutcome'];
  stored: number;
  failed: number;
  models: string[];
  dataBoundaries: Array<SidecarSyncReceipt['embeddings']['dataBoundary']>;
  errorCount: number;
  errors: string[];
  evidenceTruncated: boolean;
}

interface SidecarFailureContext {
  readonly contractSha256: string;
  readonly mode: 'probe' | 'sync';
  readonly testSeam: boolean;
  readonly requests: readonly SidecarRequestEvidence[];
  readonly verifiedAccountId?: string;
  readonly oracle: SidecarReport['oracle'];
}

const failureContexts = new WeakMap<object, SidecarFailureContext>();

export function sidecarCheckReport(
  loaded: LoadedSidecarConfig,
  clock: () => Date = () => new Date(),
): SidecarReport {
  const serverAuthenticated = oracleServerAuthenticated(loaded);
  const report = reportBase(loaded, 'check', serverAuthenticated ? 'ready' : 'not_ready', clock(), false, [], undefined, {
    connected: false,
    ingestionWritesAttempted: false,
    pagesAcknowledged: 0,
    pagesPossiblyCommitted: 0,
    lastWriteOutcome: 'not_attempted',
    recordsReceived: 0,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    stale: 0,
    embeddings: emptyEmbeddingEvidence(),
  });
  return serverAuthenticated ? report : Object.freeze({
    ...report,
    error: 'Oracle sync requires a protected POSIX socket or CA-authenticated loopback HTTPS',
  });
}

export async function runSidecarProbe(
  loaded: LoadedSidecarConfig,
  dependencies: SidecarRunnerDependencies = {},
): Promise<SidecarReport> {
  const clock = dependencies.clock ?? (() => new Date());
  const provider = dependencies.provider
    ?? createSidecarProvider(loaded, dependencies.providerDependencies);
  const testSeam = hasTestSeam(dependencies);
  const requests: SidecarRequestEvidence[] = [];
  const oracle: SidecarReport['oracle'] = {
    connected: false,
    ingestionWritesAttempted: false,
    pagesAcknowledged: 0,
    pagesPossiblyCommitted: 0,
    lastWriteOutcome: 'not_attempted',
    recordsReceived: 0,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    stale: 0,
    embeddings: emptyEmbeddingEvidence(),
  };
  let verifiedAccountId: string | undefined;
  try {
    const before = await provider.probeIdentity();
    requests.push(...before.requests);
    verifiedAccountId = before.accountId;
    assertAccount(before.accountId, loaded.config.provider.expectedAccountId);
    const page = await provider.fetchPage({ until: clock().toISOString() });
    requests.push(...page.requests);
    verifiedAccountId = page.accountId;
    assertAccount(page.accountId, before.accountId);
    const after = await provider.probeIdentity();
    requests.push(...after.requests);
    verifiedAccountId = after.accountId;
    assertAccount(after.accountId, before.accountId);
    return reportBase(
      loaded,
      'probe',
      testSeam ? 'not_ready' : 'ready',
      clock(),
      testSeam,
      requests,
      before.accountId,
      { ...oracle, recordsReceived: page.records.length },
    );
  } catch (error) {
    rememberFailure(error, {
      contractSha256: loaded.contractSha256,
      mode: 'probe',
      testSeam,
      requests: providerEvidence(provider, requests),
      ...(verifiedAccountId ? { verifiedAccountId } : {}),
      oracle,
    });
    throw error;
  }
}

export async function runSidecarSync(
  loaded: LoadedSidecarConfig,
  dependencies: SidecarRunnerDependencies = {},
): Promise<SidecarReport> {
  const clock = dependencies.clock ?? (() => new Date());
  const uuid = dependencies.uuid ?? randomUUID;
  const provider = dependencies.provider
    ?? createSidecarProvider(loaded, dependencies.providerDependencies);
  const oracle = dependencies.oracle ?? new OracleSidecarClient(loaded);
  const state = dependencies.state ?? openSidecarState(loaded);
  const ownState = dependencies.state === undefined;
  const testSeam = hasTestSeam(dependencies);
  const requests: SidecarRequestEvidence[] = [];
  const totals: MutableSyncTotals = {
    connected: false,
    ingestionWritesAttempted: false,
    pagesAcknowledged: 0,
    pagesPossiblyCommitted: 0,
    lastWriteOutcome: 'not_attempted',
    recordsReceived: 0,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    stale: 0,
    embeddings: mutableEmbeddingTotals(),
    cycleComplete: false,
  };
  let completedCycle = false;
  let writeInFlight = false;
  let primaryFailure: unknown;
  let hasPrimaryFailure = false;
  let verifiedAccountId: string | undefined;
  try {
    let checkpoint = await oracle.getCheckpoint();
    totals.connected = true;
    const pending = state.loadPending();
    if (pending) {
      assertPendingPredecessor(pending, checkpoint);
      provider.assertCredentialAbsent(pending.body);
      totals.recordsReceived += pendingRecordCount(pending);
      totals.ingestionWritesAttempted = true;
      writeInFlight = true;
      const receipt = await oracle.submit(pending);
      accumulateReceipt(totals, receipt);
      checkpoint = receipt.checkpoint;
      writeInFlight = false;
      state.clear(pending.bodySha256);
    }

    const before = await provider.probeIdentity();
    requests.push(...before.requests);
    verifiedAccountId = before.accountId;
    assertAccount(before.accountId, loaded.config.provider.expectedAccountId);
    let cycle = resumeOrStartCycle(loaded, checkpoint, clock(), uuid);
    const seenProviderCursors = new Set<string>();
    if (cycle.next) seenProviderCursors.add(cycle.next);

    for (let index = 0; index < loaded.config.limits.maxPagesPerRun; index += 1) {
      const page = await provider.fetchPage({
        ...(cycle.from ? { from: cycle.from } : {}),
        until: cycle.until,
        ...(cycle.next ? { cursor: cycle.next } : {}),
      });
      requests.push(...page.requests);
      verifiedAccountId = page.accountId;
      assertAccount(page.accountId, before.accountId);
      totals.recordsReceived += page.records.length;
      if (page.nextCursor && seenProviderCursors.has(page.nextCursor)) {
        throw new Error('Provider pagination repeated a cursor within one bounded sync run');
      }
      if (page.nextCursor) seenProviderCursors.add(page.nextCursor);
      const nextCursor: SidecarCursor = Object.freeze({
        schema: SIDECAR_CURSOR_SCHEMA,
        contractSha256: loaded.contractSha256,
        provider: loaded.config.provider.kind,
        cycleId: cycle.cycleId,
        page: cycle.page + 1,
        from: cycle.from,
        until: cycle.until,
        next: page.nextCursor ?? null,
      });
      const encodedCursor = encodeCursor(nextCursor);
      const body = syncBody(
        loaded,
        checkpoint,
        encodedCursor,
        page.nextCursor ? checkpoint?.sourceWatermark : cycle.until,
        page.records,
      );
      provider.assertCredentialAbsent(body);
      const pendingPage = state.stage(body, clock().toISOString());
      totals.ingestionWritesAttempted = true;
      writeInFlight = true;
      const receipt = await oracle.submit(pendingPage);
      accumulateReceipt(totals, receipt);
      checkpoint = receipt.checkpoint;
      writeInFlight = false;
      state.clear(pendingPage.bodySha256);
      cycle = nextCursor;
      if (!page.nextCursor) {
        completedCycle = true;
        break;
      }
    }

    const after = await provider.probeIdentity();
    requests.push(...after.requests);
    verifiedAccountId = after.accountId;
    assertAccount(after.accountId, before.accountId);
    totals.cycleComplete = completedCycle;
    return reportBase(
      loaded,
      'sync',
      testSeam ? 'not_ready' : 'ready',
      clock(),
      testSeam,
      requests,
      before.accountId,
      totals,
    );
  } catch (error) {
    if (writeInFlight) {
      if (error instanceof OracleSyncAmbiguousError) {
        totals.lastWriteOutcome = 'ambiguous';
        totals.pagesPossiblyCommitted = totals.pagesAcknowledged + 1;
        totals.embeddings.invocationOutcome = 'unknown';
      } else {
        totals.lastWriteOutcome = 'rejected';
        totals.pagesPossiblyCommitted = totals.pagesAcknowledged;
      }
    }
    primaryFailure = error;
    hasPrimaryFailure = true;
    rememberFailure(error, syncFailureContext(
      loaded,
      testSeam,
      provider,
      requests,
      verifiedAccountId,
      totals,
    ));
    throw error;
  } finally {
    if (ownState) {
      try {
        state.close();
      } catch (closeError) {
        const context = syncFailureContext(
          loaded,
          testSeam,
          provider,
          requests,
          verifiedAccountId,
          totals,
        );
        const normalizedCloseError = closeError instanceof Error
          ? closeError
          : new Error('Sidecar state close failed', { cause: closeError });
        if (hasPrimaryFailure) {
          const aggregate = new AggregateError(
            [primaryFailure, normalizedCloseError],
            'Sidecar sync failed and state cleanup also failed',
          );
          Object.defineProperty(aggregate, 'cause', { value: primaryFailure });
          rememberFailure(aggregate, context);
          throw aggregate;
        }
        rememberFailure(normalizedCloseError, context);
        throw normalizedCloseError;
      }
    }
  }
}

export function sidecarFailureReport(
  loaded: LoadedSidecarConfig,
  mode: 'probe' | 'sync',
  error: unknown,
  clock: () => Date = () => new Date(),
): SidecarReport {
  const context = failureContext(error, loaded.contractSha256, mode);
  return {
    ...reportBase(
      loaded,
      mode,
      'not_ready',
      clock(),
      context?.testSeam ?? false,
      context?.requests ?? [],
      context?.verifiedAccountId,
      context?.oracle ?? {
        connected: false,
        ingestionWritesAttempted: false,
        pagesAcknowledged: 0,
        pagesPossiblyCommitted: 0,
        lastWriteOutcome: 'not_attempted',
        recordsReceived: 0,
        inserted: 0,
        updated: 0,
        unchanged: 0,
        stale: 0,
        embeddings: emptyEmbeddingEvidence(),
        ...(mode === 'sync' ? { cycleComplete: false } : {}),
      },
    ),
    error: sanitizedError(error),
  };
}

export function renderSidecarReport(report: SidecarReport): string {
  const lines = [
    `OpenProjects read-only sidecar: ${report.overall.toUpperCase()}`,
    `Mode: ${report.mode}; provider: ${report.provider.kind}; config: ${report.config.sha256}`,
    `Provider writes attempted: no; Oracle ingestion writes attempted: ${report.oracle.ingestionWritesAttempted ? 'yes' : 'no'}`,
    `Provider requests: ${report.provider.requests.length}; records received: ${report.oracle.recordsReceived}`,
    `Oracle pages acknowledged: ${report.oracle.pagesAcknowledged}; possibly committed: ${report.oracle.pagesPossiblyCommitted}; last write: ${report.oracle.lastWriteOutcome}`,
    `Oracle records inserted: ${report.oracle.inserted}; updated: ${report.oracle.updated}; unchanged: ${report.oracle.unchanged}; stale: ${report.oracle.stale}`,
    `Embedding evidence: acknowledged invocation ${report.oracle.embeddings.invoked ? 'yes' : 'no'}; invocation outcome: ${report.oracle.embeddings.invocationOutcome}; stored: ${report.oracle.embeddings.stored}; failed: ${report.oracle.embeddings.failed}; models: ${evidenceList(report.oracle.embeddings.models)}; boundaries: ${embeddingBoundaryList(report.oracle.embeddings)}`,
    `Embedding errors: ${report.oracle.embeddings.errorCount}; samples: ${evidenceList(report.oracle.embeddings.errors)}${report.oracle.embeddings.evidenceTruncated ? '; bounded samples truncated' : ''}`,
    `OAuth flow invoked: no; credential lifecycle: ${report.provider.credentialLifecycle}`,
  ];
  if (report.testSeam) lines.push('Live qualification disallowed: an injected test seam was present.');
  if (report.mode === 'sync') {
    lines.push(`Sync window complete: ${report.oracle.cycleComplete ? 'yes' : 'no; continuation or recovery remains'}`);
  }
  if (report.error) lines.push(`Error: ${report.error}`);
  lines.push('Remaining unqualified:');
  for (const item of report.remainingUnqualified) lines.push(`- ${item}`);
  return `${lines.join('\n')}\n`;
}

function resumeOrStartCycle(
  loaded: LoadedSidecarConfig,
  checkpoint: SidecarCheckpoint | undefined,
  now: Date,
  uuid: () => string,
): SidecarCursor {
  if (checkpoint?.cursor) {
    const prior = decodeCursor(checkpoint.cursor);
    if (prior.contractSha256 !== loaded.contractSha256 || prior.provider !== loaded.config.provider.kind) {
      throw new Error('Oracle checkpoint belongs to a different sidecar contract or provider');
    }
    if (prior.next) return prior;
  }
  const watermark = checkpoint?.sourceWatermark;
  if (watermark && now.getTime() < Date.parse(watermark)) {
    throw new Error('Sidecar clock is earlier than the completed Oracle source watermark');
  }
  return Object.freeze({
    schema: SIDECAR_CURSOR_SCHEMA,
    contractSha256: loaded.contractSha256,
    provider: loaded.config.provider.kind,
    cycleId: uuid(),
    page: 0,
    from: watermark ? subtractSeconds(watermark, loaded.config.limits.overlapSeconds) : null,
    until: now.toISOString(),
    next: null,
  });
}

function syncBody(
  loaded: LoadedSidecarConfig,
  checkpoint: SidecarCheckpoint | undefined,
  cursor: string,
  sourceWatermark: string | undefined,
  records: readonly CorporateRecordInput[],
): string {
  return JSON.stringify({
    workspaceId: loaded.config.workspaceId,
    source: loaded.config.id,
    sourceAccountId: loaded.config.provider.expectedAccountId,
    stream: loaded.config.stream,
    ...(checkpoint?.cursor ? { previousCursor: checkpoint.cursor } : {}),
    cursor,
    ...(sourceWatermark ? { sourceWatermark } : {}),
    records,
  });
}

function encodeCursor(cursor: SidecarCursor): string {
  const encoded = `${CURSOR_PREFIX}${Buffer.from(JSON.stringify(cursor)).toString('base64url')}`;
  if (Buffer.byteLength(encoded, 'utf8') > MAX_CURSOR_BYTES) {
    throw new Error('Sidecar cursor exceeds the Oracle checkpoint limit');
  }
  return encoded;
}

export function decodeSidecarCursor(value: string): SidecarCursor {
  return decodeCursor(value);
}

function decodeCursor(value: string): SidecarCursor {
  if (!value.startsWith(CURSOR_PREFIX) || Buffer.byteLength(value, 'utf8') > MAX_CURSOR_BYTES) {
    throw new Error('Oracle checkpoint cursor is not an OpenProjects sidecar cursor');
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(value.slice(CURSOR_PREFIX.length), 'base64url').toString('utf8')) as unknown;
  } catch {
    throw new Error('Oracle checkpoint sidecar cursor is invalid');
  }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new Error('Oracle checkpoint sidecar cursor is not an object');
  }
  const entry = decoded as Record<string, unknown>;
  const exactKeys = 'contractSha256,cycleId,from,next,page,provider,schema,until';
  if (
    Object.keys(entry).sort().join(',') !== exactKeys
    || entry.schema !== SIDECAR_CURSOR_SCHEMA
    || typeof entry.contractSha256 !== 'string'
    || !/^[a-f0-9]{64}$/u.test(entry.contractSha256)
    || (entry.provider !== 'linear' && entry.provider !== 'jira')
    || typeof entry.cycleId !== 'string'
    || !entry.cycleId
    || !Number.isSafeInteger(entry.page)
    || (entry.page as number) < 1
    || (entry.from !== null && typeof entry.from !== 'string')
    || typeof entry.until !== 'string'
    || (entry.next !== null && typeof entry.next !== 'string')
    || (typeof entry.from === 'string' && !Number.isFinite(Date.parse(entry.from)))
    || !Number.isFinite(Date.parse(entry.until))
    || (
      typeof entry.from === 'string'
      && Date.parse(entry.from) > Date.parse(entry.until)
    )
  ) {
    throw new Error('Oracle checkpoint sidecar cursor failed validation');
  }
  return Object.freeze(entry as unknown as SidecarCursor);
}

function assertPendingPredecessor(
  pending: PendingSidecarPage,
  checkpoint: SidecarCheckpoint | undefined,
): void {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(pending.body) as Record<string, unknown>;
  } catch {
    throw new Error('Sidecar pending page body is invalid');
  }
  const predecessor = typeof body.previousCursor === 'string' ? body.previousCursor : undefined;
  const cursor = typeof body.cursor === 'string' ? body.cursor : undefined;
  if (!cursor) throw new Error('Sidecar pending page has no cursor');
  const current = checkpoint?.cursor;
  if (current !== predecessor && current !== cursor && !(current === undefined && predecessor === undefined)) {
    throw new Error('Sidecar pending page no longer follows the Oracle checkpoint');
  }
}

function pendingRecordCount(pending: PendingSidecarPage): number {
  const body = JSON.parse(pending.body) as { records?: unknown };
  if (!Array.isArray(body.records)) throw new Error('Sidecar pending page has no records array');
  return body.records.length;
}

function accumulateReceipt(
  totals: {
    pagesAcknowledged: number;
    pagesPossiblyCommitted: number;
    lastWriteOutcome: SidecarReport['oracle']['lastWriteOutcome'];
    inserted: number;
    updated: number;
    unchanged: number;
    stale: number;
    embeddings: MutableEmbeddingTotals;
    finalCheckpoint?: SidecarCheckpointEvidence;
  },
  receipt: SidecarSyncReceipt,
): void {
  totals.pagesAcknowledged += 1;
  totals.pagesPossiblyCommitted = totals.pagesAcknowledged;
  totals.lastWriteOutcome = 'acknowledged';
  totals.inserted += receipt.inserted;
  totals.updated += receipt.updated;
  totals.unchanged += receipt.unchanged;
  totals.stale += receipt.stale;
  totals.embeddings.invoked ||= receipt.embeddingInvoked;
  if (receipt.embeddingInvoked) totals.embeddings.invocationOutcome = 'observed';
  totals.embeddings.stored += receipt.embeddings.stored;
  totals.embeddings.failed += receipt.embeddings.failed;
  addEmbeddingEvidence(
    totals.embeddings,
    'models',
    sanitizedEvidenceText(receipt.embeddings.model),
  );
  addEmbeddingEvidence(totals.embeddings, 'dataBoundaries', receipt.embeddings.dataBoundary);
  if (receipt.embeddings.error !== null) {
    totals.embeddings.errorCount += 1;
    addEmbeddingEvidence(
      totals.embeddings,
      'errors',
      sanitizedEvidenceText(receipt.embeddings.error),
    );
  }
  totals.finalCheckpoint = checkpointEvidence(receipt.checkpoint);
}

function checkpointEvidence(checkpoint: SidecarCheckpoint): SidecarCheckpointEvidence {
  return Object.freeze({
    ...(checkpoint.cursor ? { cursorSha256: sha256(checkpoint.cursor) } : {}),
    ...(checkpoint.sourceWatermark ? { sourceWatermark: checkpoint.sourceWatermark } : {}),
    lastBatchSha256: checkpoint.lastBatchSha256,
    recordsSeen: checkpoint.recordsSeen,
    lastSuccessAt: checkpoint.lastSuccessAt,
  });
}

function reportBase(
  loaded: LoadedSidecarConfig,
  mode: SidecarReport['mode'],
  overall: SidecarReport['overall'],
  generatedAt: Date,
  testSeam: boolean,
  requests: readonly SidecarRequestEvidence[],
  verifiedAccountId: string | undefined,
  oracle: SidecarReport['oracle'],
): SidecarReport {
  return Object.freeze({
    schema: SIDECAR_REPORT_SCHEMA,
    generatedAt: generatedAt.toISOString(),
    mode,
    overall,
    config: Object.freeze({
      id: loaded.config.id,
      path: loaded.path,
      sha256: loaded.sha256,
      contractSha256: loaded.contractSha256,
      workspaceId: loaded.config.workspaceId,
      stream: loaded.config.stream,
    }),
    provider: Object.freeze({
      kind: loaded.config.provider.kind,
      expectedAccountSha256: sha256(loaded.config.provider.expectedAccountId),
      ...(verifiedAccountId ? { verifiedAccountSha256: sha256(verifiedAccountId) } : {}),
      readOnly: true,
      providerWritesAttempted: false,
      credentialLifecycle: 'externally-managed',
      oauthFlowInvoked: false,
      requests: Object.freeze(requests.map((request) => Object.freeze({ ...request }))),
    }),
    oracle: freezeOracleEvidence(oracle),
    testSeam,
    remainingUnqualified: REMAINING_UNQUALIFIED,
  });
}

function subtractSeconds(value: string, seconds: number): string {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error('Oracle source watermark is invalid');
  return new Date(Math.max(0, milliseconds - (seconds * 1_000))).toISOString();
}

function assertAccount(actual: string, expected: string): void {
  if (actual !== expected) throw new Error('Provider account identity changed or does not match the reviewed config');
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function hasTestSeam(dependencies: SidecarRunnerDependencies): boolean {
  return dependencies.testSeam === true
    || dependencies.provider !== undefined
    || dependencies.providerDependencies !== undefined
    || dependencies.oracle !== undefined
    || dependencies.state !== undefined
    || dependencies.clock !== undefined
    || dependencies.uuid !== undefined;
}

function oracleServerAuthenticated(loaded: LoadedSidecarConfig): boolean {
  return loaded.config.oracle.socketPath !== undefined
    || new URL(loaded.config.oracle.baseUrl).protocol === 'https:';
}

function providerEvidence(
  provider: SidecarProviderAdapter,
  fallback: readonly SidecarRequestEvidence[],
): readonly SidecarRequestEvidence[] {
  try {
    return Object.freeze([...(provider.evidence?.() ?? fallback)]);
  } catch {
    return Object.freeze([...fallback]);
  }
}

function rememberFailure(error: unknown, context: SidecarFailureContext): void {
  if ((typeof error !== 'object' || error === null) && typeof error !== 'function') return;
  failureContexts.set(error as object, Object.freeze({
    ...context,
    requests: Object.freeze(context.requests.map((request) => Object.freeze({ ...request }))),
    oracle: freezeOracleEvidence(context.oracle),
  }));
}

function failureContext(
  error: unknown,
  contractSha256: string,
  mode: 'probe' | 'sync',
): SidecarFailureContext | undefined {
  if ((typeof error !== 'object' || error === null) && typeof error !== 'function') return undefined;
  const context = failureContexts.get(error as object);
  return context?.contractSha256 === contractSha256 && context.mode === mode ? context : undefined;
}

function sanitizedError(error: unknown): string {
  if (!(error instanceof Error)) return 'Sidecar failed';
  return sanitizedEvidenceText(error.message);
}

function sanitizedEvidenceText(value: string): string {
  return redactObviousSecrets(value)
    .text
    .replace(/[\u0000-\u001F\u007F]/gu, ' ')
    .slice(0, 1_024);
}

function mutableEmbeddingTotals(): MutableEmbeddingTotals {
  return {
    invoked: false,
    invocationOutcome: 'not_observed',
    stored: 0,
    failed: 0,
    models: [],
    dataBoundaries: [],
    errorCount: 0,
    errors: [],
    evidenceTruncated: false,
  };
}

function emptyEmbeddingEvidence(): SidecarReport['oracle']['embeddings'] {
  return Object.freeze({
    ...mutableEmbeddingTotals(),
    models: Object.freeze([]),
    dataBoundaries: Object.freeze([]),
    errors: Object.freeze([]),
  });
}

function addEmbeddingEvidence<
  Key extends 'models' | 'dataBoundaries' | 'errors',
>(
  totals: MutableEmbeddingTotals,
  key: Key,
  value: MutableEmbeddingTotals[Key][number],
): void {
  const values = totals[key] as Array<MutableEmbeddingTotals[Key][number]>;
  if (values.includes(value)) return;
  if (values.length >= MAX_EMBEDDING_EVIDENCE_VALUES) {
    totals.evidenceTruncated = true;
    return;
  }
  values.push(value);
}

function freezeOracleEvidence(oracle: SidecarReport['oracle']): SidecarReport['oracle'] {
  return Object.freeze({
    ...oracle,
    embeddings: Object.freeze({
      ...oracle.embeddings,
      models: Object.freeze([...oracle.embeddings.models]),
      dataBoundaries: Object.freeze([...oracle.embeddings.dataBoundaries]),
      errors: Object.freeze([...oracle.embeddings.errors]),
    }),
  });
}

function evidenceList(values: readonly string[]): string {
  return values.length > 0 ? values.join(', ') : 'none';
}

function embeddingBoundaryList(
  embeddings: SidecarReport['oracle']['embeddings'],
): string {
  if (embeddings.dataBoundaries.length > 0) {
    const observed = evidenceList(embeddings.dataBoundaries);
    return embeddings.invocationOutcome === 'unknown'
      ? `${observed}; ambiguous receipt boundary unknown`
      : observed;
  }
  return embeddings.invocationOutcome === 'unknown' ? 'unknown (receipt unavailable)' : 'none';
}

function syncFailureContext(
  loaded: LoadedSidecarConfig,
  testSeam: boolean,
  provider: SidecarProviderAdapter,
  requests: readonly SidecarRequestEvidence[],
  verifiedAccountId: string | undefined,
  totals: MutableSyncTotals,
): SidecarFailureContext {
  return {
    contractSha256: loaded.contractSha256,
    mode: 'sync',
    testSeam,
    requests: providerEvidence(provider, requests),
    ...(verifiedAccountId ? { verifiedAccountId } : {}),
    oracle: freezeOracleEvidence(totals),
  };
}
