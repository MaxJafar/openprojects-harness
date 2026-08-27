import { createUnixSocketFetch } from '../api/unix-fetch.js';
import {
  loadControlClientCredential,
  type ControlClientCredential,
} from '../auth/control-auth.js';
import { resolveProtectedUnixSocketClientPath } from '../server-endpoint.js';
import type {
  LoadedSidecarConfig,
  PendingSidecarPage,
  SidecarCheckpoint,
  SidecarSyncReceipt,
} from './types.js';

const MAX_ORACLE_RESPONSE_BYTES = 2_000_000;
const ORACLE_TIMEOUT_MS = 30_000;

export interface OracleSidecarClientDependencies {
  readonly fetch?: typeof globalThis.fetch;
  readonly credential?: ControlClientCredential;
  /** Permits plaintext loopback only inside an explicitly disqualified test seam. */
  readonly allowInsecureLoopbackTestOnly?: boolean;
}

interface ParsedSyncRequest extends Record<string, unknown> {
  readonly workspaceId: string;
  readonly source: string;
  readonly sourceAccountId: string;
  readonly stream: string;
  readonly previousCursor?: string;
  readonly cursor: string;
  readonly sourceWatermark?: string;
  readonly records: unknown[];
}

export class OracleSidecarError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'OracleSidecarError';
  }
}

/** A pending sync POST may have reached the local service; replay its exact spool body. */
export class OracleSyncAmbiguousError extends OracleSidecarError {
  constructor(options?: ErrorOptions) {
    super('ORACLE_SYNC_AMBIGUOUS', 'Oracle sync outcome is ambiguous; the exact pending page was retained');
    this.name = 'OracleSyncAmbiguousError';
    if (options?.cause !== undefined) Object.defineProperty(this, 'cause', { value: options.cause });
  }
}

/** Narrow local sink: it can only read its own checkpoint and submit one staged page. */
export class OracleSidecarClient {
  readonly #loaded: LoadedSidecarConfig;
  readonly #fetch: typeof globalThis.fetch;
  readonly #credential: ControlClientCredential;

  constructor(
    loaded: LoadedSidecarConfig,
    dependencies: OracleSidecarClientDependencies = {},
  ) {
    this.#loaded = loaded;
    if (
      !loaded.config.oracle.socketPath
      && new URL(loaded.config.oracle.baseUrl).protocol !== 'https:'
      && dependencies.allowInsecureLoopbackTestOnly !== true
    ) {
      throw new OracleSidecarError(
        'ORACLE_SERVER_AUTH_UNQUALIFIED',
        'Oracle sync requires a protected POSIX socket or CA-authenticated loopback HTTPS',
      );
    }
    const socketPath = loaded.config.oracle.socketPath
      ? protectedSocketPath(loaded.config.oracle.socketPath)
      : undefined;
    this.#credential = dependencies.credential
      ?? loadControlClientCredential({ tokenFile: loaded.config.oracle.tokenFile });
    const transport = dependencies.fetch ?? (socketPath
      ? createUnixSocketFetch({
          socketPath,
          virtualOrigin: loaded.config.oracle.baseUrl,
          maxRequestBodyBytes: 2_100_000,
          headerTimeoutMs: 10_000,
        })
      : globalThis.fetch);
    this.#fetch = socketPath
      ? revalidatingSocketFetch(socketPath, transport)
      : transport;
  }

  async getCheckpoint(signal?: AbortSignal): Promise<SidecarCheckpoint | undefined> {
    const url = new URL('/api/oracle/checkpoint', this.#loaded.config.oracle.baseUrl);
    url.searchParams.set('workspaceId', this.#loaded.config.workspaceId);
    url.searchParams.set('source', this.#loaded.config.id);
    url.searchParams.set('stream', this.#loaded.config.stream);
    const response = await this.#request(url, {
      method: 'GET',
      headers: { authorization: this.#credential.authorizationHeader() },
      ...(signal ? { signal } : {}),
    }, false);
    const body = objectValue(response, 'Oracle checkpoint response');
    if (Object.keys(body).some((key) => key !== 'checkpoint')) {
      throw new OracleSidecarError('ORACLE_SCHEMA', 'Oracle checkpoint response contains unknown fields');
    }
    if (body.checkpoint === null) return undefined;
    const checkpoint = parseCheckpoint(body.checkpoint);
    this.#assertCheckpointScope(checkpoint);
    return checkpoint;
  }

  async submit(pending: PendingSidecarPage, signal?: AbortSignal): Promise<SidecarSyncReceipt> {
    const requestBody = parseSyncRequestBody(pending.body);
    this.#assertRequestScope(requestBody);
    try {
      const response = await this.#request(
        new URL('/api/oracle/sync', this.#loaded.config.oracle.baseUrl),
        {
          method: 'POST',
          headers: {
            authorization: this.#credential.authorizationHeader(),
            'content-type': 'application/json',
          },
          body: pending.body,
          ...(signal ? { signal } : {}),
        },
        true,
      );
      const receipt = parseReceipt(response, requestBody.records);
      this.#assertCheckpointScope(receipt.checkpoint);
      if (receipt.checkpoint.cursor !== requestBody.cursor) {
        throw new OracleSidecarError('ORACLE_RECEIPT_MISMATCH', 'Oracle receipt cursor does not match the staged page');
      }
      if (receipt.checkpoint.sourceWatermark !== requestBody.sourceWatermark) {
        throw new OracleSidecarError('ORACLE_RECEIPT_MISMATCH', 'Oracle receipt watermark does not match the staged page');
      }
      return receipt;
    } catch (error) {
      if (
        error instanceof OracleSidecarError
        && error.code === 'ORACLE_SERVER_AUTH_UNQUALIFIED'
      ) {
        throw error;
      }
      if (error instanceof OracleSyncAmbiguousError) throw error;
      if (
        error instanceof OracleSidecarError
        && error.status !== undefined
        && error.status >= 400
        && error.status < 500
      ) {
        throw error;
      }
      throw new OracleSyncAmbiguousError({ cause: error });
    }
  }

  async #request(url: URL, init: RequestInit, writeAttempted: boolean): Promise<unknown> {
    const timeout = AbortSignal.timeout(ORACLE_TIMEOUT_MS);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await this.#fetch(url, {
        ...init,
        signal,
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        headers: { accept: 'application/json', ...headersRecord(init.headers) },
      });
    } catch (error) {
      if (
        error instanceof OracleSidecarError
        && error.code === 'ORACLE_SERVER_AUTH_UNQUALIFIED'
      ) {
        throw error;
      }
      if (writeAttempted) throw new OracleSyncAmbiguousError({ cause: error });
      throw new OracleSidecarError('ORACLE_TRANSPORT', 'Oracle checkpoint read failed');
    }
    const text = await readBounded(response, MAX_ORACLE_RESPONSE_BYTES);
    if (!response.ok) {
      throw new OracleSidecarError(
        response.status === 401 || response.status === 403 ? 'ORACLE_AUTH' : 'ORACLE_RESPONSE',
        `Oracle request returned HTTP ${response.status}`,
        response.status,
      );
    }
    if (!response.headers.get('content-type')?.toLocaleLowerCase().startsWith('application/json')) {
      throw new OracleSidecarError('ORACLE_CONTENT_TYPE', 'Oracle returned a non-JSON response');
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new OracleSidecarError('ORACLE_JSON', 'Oracle returned invalid JSON');
    }
  }

  #assertCheckpointScope(checkpoint: SidecarCheckpoint): void {
    if (
      checkpoint.workspaceId !== this.#loaded.config.workspaceId
      || checkpoint.source !== this.#loaded.config.id
      || checkpoint.stream !== this.#loaded.config.stream
      || checkpoint.sourceAccountId !== this.#loaded.config.provider.expectedAccountId
    ) {
      throw new OracleSidecarError('ORACLE_SCOPE_DRIFT', 'Oracle checkpoint identity does not match the reviewed sidecar');
    }
  }

  #assertRequestScope(body: Record<string, unknown>): void {
    if (
      body.workspaceId !== this.#loaded.config.workspaceId
      || body.source !== this.#loaded.config.id
      || body.stream !== this.#loaded.config.stream
      || body.sourceAccountId !== this.#loaded.config.provider.expectedAccountId
    ) {
      throw new OracleSidecarError('ORACLE_REQUEST_SCOPE', 'Staged Oracle page does not match the reviewed sidecar');
    }
  }
}

function protectedSocketPath(value: string): string {
  try {
    return resolveProtectedUnixSocketClientPath(value);
  } catch {
    throw new OracleSidecarError(
      'ORACLE_SERVER_AUTH_UNQUALIFIED',
      'Oracle sync requires a protected POSIX socket or CA-authenticated loopback HTTPS',
    );
  }
}

function revalidatingSocketFetch(
  socketPath: string,
  transport: typeof globalThis.fetch,
): typeof globalThis.fetch {
  return async (input, init) => {
    if (protectedSocketPath(socketPath) !== socketPath) {
      throw new OracleSidecarError(
        'ORACLE_SERVER_AUTH_UNQUALIFIED',
        'Oracle sync requires a protected POSIX socket or CA-authenticated loopback HTTPS',
      );
    }
    return transport(input, init);
  };
}

function parseSyncRequestBody(body: string): ParsedSyncRequest {
  let value: unknown;
  try {
    value = JSON.parse(body) as unknown;
  } catch {
    throw new OracleSidecarError('ORACLE_PENDING_JSON', 'Staged Oracle page contains invalid JSON');
  }
  const parsed = objectValue(value, 'staged Oracle page');
  assertExactKeys(parsed, [
    'cursor',
    'previousCursor',
    'records',
    'source',
    'sourceAccountId',
    'sourceWatermark',
    'stream',
    'workspaceId',
  ], 'staged Oracle page', true);
  if (
    typeof parsed.workspaceId !== 'string'
    || typeof parsed.source !== 'string'
    || typeof parsed.sourceAccountId !== 'string'
    || typeof parsed.stream !== 'string'
    || typeof parsed.cursor !== 'string'
    || !Array.isArray(parsed.records)
    || parsed.records.length > 100
    || (
      Object.prototype.hasOwnProperty.call(parsed, 'previousCursor')
      && typeof parsed.previousCursor !== 'string'
    )
    || (
      Object.prototype.hasOwnProperty.call(parsed, 'sourceWatermark')
      && typeof parsed.sourceWatermark !== 'string'
    )
  ) {
    throw new OracleSidecarError('ORACLE_PENDING_SCHEMA', 'Staged Oracle page is missing required fields');
  }
  return parsed as ParsedSyncRequest;
}

function parseReceipt(value: unknown, expectedRecords: readonly unknown[]): SidecarSyncReceipt {
  const body = objectValue(value, 'Oracle sync receipt');
  assertExactKeys(body, [
    'agentRunInvoked',
    'chatModelInvoked',
    'checkpoint',
    'embeddingInvoked',
    'embeddings',
    'inserted',
    'modelInvoked',
    'records',
    'schema',
    'stale',
    'unchanged',
    'updated',
  ], 'Oracle sync receipt');
  if (
    body.schema !== 'openprojects.corporate-sync-receipt.v1'
    || body.agentRunInvoked !== false
    || body.chatModelInvoked !== false
    || typeof body.embeddingInvoked !== 'boolean'
    || body.modelInvoked !== false
  ) {
    throw new OracleSidecarError('ORACLE_RECEIPT_SCHEMA', 'Oracle sync receipt does not match the reviewed contract');
  }
  const checkpoint = parseCheckpoint(body.checkpoint);
  const embeddings = objectValue(body.embeddings, 'Oracle embedding receipt');
  assertExactKeys(
    embeddings,
    ['dataBoundary', 'error', 'failed', 'model', 'stored'],
    'Oracle embedding receipt',
  );
  const records = parseReceiptRecords(body.records, expectedRecords);
  const stored = nonNegativeInteger(embeddings.stored, 'embeddings stored');
  const failed = nonNegativeInteger(embeddings.failed, 'embeddings failed');
  if (stored + failed > expectedRecords.length) {
    throw new OracleSidecarError(
      'ORACLE_RECEIPT_MISMATCH',
      'Oracle embedding counts exceed the staged page',
    );
  }
  if (body.embeddingInvoked !== (stored + failed > 0)) {
    throw new OracleSidecarError('ORACLE_RECEIPT_MISMATCH', 'Oracle embedding receipt contradicts its invocation flag');
  }
  const receipt: SidecarSyncReceipt = {
    schema: 'openprojects.corporate-sync-receipt.v1',
    inserted: nonNegativeInteger(body.inserted, 'inserted'),
    updated: nonNegativeInteger(body.updated, 'updated'),
    unchanged: nonNegativeInteger(body.unchanged, 'unchanged'),
    stale: nonNegativeInteger(body.stale, 'stale'),
    records,
    checkpoint,
    embeddings: {
      model: requiredBoundedSingleLine(embeddings.model, 'embedding model', 512),
      dataBoundary: embeddingDataBoundary(embeddings.dataBoundary),
      stored,
      failed,
      error: embeddings.error === null
        ? null
        : requiredBoundedSingleLine(embeddings.error, 'embedding error', 512),
    },
    agentRunInvoked: false,
    chatModelInvoked: false,
    embeddingInvoked: body.embeddingInvoked,
    modelInvoked: false,
  };
  const accounted = receipt.inserted + receipt.updated + receipt.unchanged + receipt.stale;
  if (accounted !== expectedRecords.length) {
    throw new OracleSidecarError('ORACLE_RECEIPT_MISMATCH', 'Oracle receipt counts do not match the staged page');
  }
  return receipt;
}

function embeddingDataBoundary(
  value: unknown,
): SidecarSyncReceipt['embeddings']['dataBoundary'] {
  if (value !== 'local' && value !== 'external' && value !== 'unreported') {
    throw new OracleSidecarError('ORACLE_RECEIPT_SCHEMA', 'Oracle embedding data boundary is invalid');
  }
  return value;
}

function parseReceiptRecords(value: unknown, expectedRecords: readonly unknown[]): SidecarSyncReceipt['records'] {
  const expectedExternalIds = stagedExternalIds(expectedRecords);
  if (!Array.isArray(value) || value.length !== expectedExternalIds.length) {
    throw new OracleSidecarError('ORACLE_RECEIPT_MISMATCH', 'Oracle receipt records do not match the staged page');
  }
  return Object.freeze(value.map((item, index) => {
    const record = objectValue(item, 'Oracle receipt record');
    assertExactKeys(
      record,
      ['contentSha256', 'externalId', 'id', 'revision', 'status'],
      'Oracle receipt record',
    );
    const status = requiredString(record.status, 'Oracle receipt record status');
    if (status !== 'active' && status !== 'deleted') {
      throw new OracleSidecarError('ORACLE_SCHEMA', 'Oracle receipt record status is invalid');
    }
    const externalId = requiredBoundedSingleLine(
      record.externalId,
      'Oracle receipt record externalId',
      256,
    );
    if (externalId !== expectedExternalIds[index]) {
      throw new OracleSidecarError('ORACLE_RECEIPT_MISMATCH', 'Oracle receipt record identity does not match the staged page');
    }
    return Object.freeze({
      id: requiredString(record.id, 'Oracle receipt record id'),
      externalId,
      revision: positiveInteger(record.revision, 'Oracle receipt record revision'),
      status,
      contentSha256: requiredDigest(record.contentSha256, 'Oracle receipt record content digest'),
    });
  }));
}

function stagedExternalIds(records: readonly unknown[]): readonly string[] {
  const seen = new Set<string>();
  return Object.freeze(records.map((item) => {
    const record = objectValue(item, 'staged Oracle record');
    const externalId = requiredBoundedSingleLine(
      record.externalId,
      'staged Oracle record externalId',
      256,
    );
    if (seen.has(externalId)) {
      throw new OracleSidecarError('ORACLE_PENDING_SCHEMA', 'Staged Oracle page repeats an externalId');
    }
    seen.add(externalId);
    return externalId;
  }));
}

function parseCheckpoint(value: unknown): SidecarCheckpoint {
  const entry = objectValue(value, 'Oracle checkpoint');
  assertExactKeys(entry, [
    'cursor',
    'lastBatchSha256',
    'lastSuccessAt',
    'recordsSeen',
    'source',
    'sourceAccountId',
    'sourceWatermark',
    'stream',
    'updatedAt',
    'workspaceId',
  ], 'Oracle checkpoint', true);
  const cursor = optionalNullableBoundedSingleLine(entry.cursor, 'checkpoint cursor', 4_096);
  const sourceWatermark = optionalNullableString(entry.sourceWatermark, 'checkpoint sourceWatermark');
  if (sourceWatermark) requiredTimestamp(sourceWatermark, 'checkpoint sourceWatermark');
  if (entry.updatedAt !== undefined) requiredTimestamp(entry.updatedAt, 'checkpoint updatedAt');
  return {
    workspaceId: requiredString(entry.workspaceId, 'checkpoint workspaceId'),
    source: requiredString(entry.source, 'checkpoint source'),
    sourceAccountId: requiredString(entry.sourceAccountId, 'checkpoint sourceAccountId'),
    stream: requiredString(entry.stream, 'checkpoint stream'),
    ...(cursor ? { cursor } : {}),
    ...(sourceWatermark ? { sourceWatermark } : {}),
    lastBatchSha256: requiredDigest(entry.lastBatchSha256, 'checkpoint batch digest'),
    recordsSeen: nonNegativeInteger(entry.recordsSeen, 'checkpoint recordsSeen'),
    lastSuccessAt: requiredTimestamp(entry.lastSuccessAt, 'checkpoint lastSuccessAt'),
  };
}

function objectValue(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new OracleSidecarError('ORACLE_SCHEMA', `${context} is not an object`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  context: string,
  optionalAllowed = false,
): void {
  const allowedKeys = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new OracleSidecarError('ORACLE_SCHEMA', `${context} contains unknown fields`);
  }
  if (!optionalAllowed && allowed.some((key) => !Object.prototype.hasOwnProperty.call(value, key))) {
    throw new OracleSidecarError('ORACLE_SCHEMA', `${context} is missing required fields`);
  }
}

function requiredString(value: unknown, context: string): string {
  if (typeof value !== 'string' || !value) {
    throw new OracleSidecarError('ORACLE_SCHEMA', `${context} is not a non-empty string`);
  }
  return value;
}

function optionalNullableString(value: unknown, context: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requiredString(value, context);
}

function optionalNullableBoundedSingleLine(
  value: unknown,
  context: string,
  maximumBytes: number,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requiredBoundedSingleLine(value, context, maximumBytes);
}

function requiredBoundedSingleLine(value: unknown, context: string, maximumBytes: number): string {
  const text = requiredString(value, context);
  if (Buffer.byteLength(text, 'utf8') > maximumBytes || /[\u0000-\u001F\u007F]/u.test(text)) {
    throw new OracleSidecarError('ORACLE_SCHEMA', `${context} is not bounded control-free text`);
  }
  return text;
}

function requiredDigest(value: unknown, context: string): string {
  const digest = requiredString(value, context);
  if (!/^[a-f0-9]{64}$/u.test(digest)) throw new OracleSidecarError('ORACLE_SCHEMA', `${context} is invalid`);
  return digest;
}

function requiredTimestamp(value: unknown, context: string): string {
  const timestamp = requiredString(value, context);
  const parsed = Date.parse(timestamp);
  if (
    Buffer.byteLength(timestamp, 'utf8') > 128
    || !Number.isFinite(parsed)
    || new Date(parsed).toISOString() !== timestamp
  ) {
    throw new OracleSidecarError('ORACLE_SCHEMA', `${context} is invalid`);
  }
  return timestamp;
}

function nonNegativeInteger(value: unknown, context: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new OracleSidecarError('ORACLE_SCHEMA', `${context} is not a non-negative integer`);
  }
  return value as number;
}

function positiveInteger(value: unknown, context: string): number {
  const parsed = nonNegativeInteger(value, context);
  if (parsed < 1) throw new OracleSidecarError('ORACLE_SCHEMA', `${context} is not a positive integer`);
  return parsed;
}

async function readBounded(response: Response, limit: number): Promise<string> {
  const declared = response.headers.get('content-length');
  if (declared && Number(declared) > limit) {
    await response.body?.cancel();
    throw new OracleSidecarError('ORACLE_RESPONSE_TOO_LARGE', 'Oracle response exceeds its byte limit');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > limit) {
        await reader.cancel();
        throw new OracleSidecarError('ORACLE_RESPONSE_TOO_LARGE', 'Oracle response exceeds its byte limit');
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), bytes).toString('utf8');
}

function headersRecord(value: HeadersInit | undefined): Record<string, string> {
  if (!value) return {};
  const output: Record<string, string> = {};
  new Headers(value).forEach((item, key) => {
    output[key] = item;
  });
  return output;
}
