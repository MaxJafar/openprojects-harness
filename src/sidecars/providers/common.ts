import type { JsonObject, JsonValue } from '../../core/types.js';
import type { CorporateRecordInput } from '../../oracle/corporate-oracle.js';
import type { SidecarReadWindow } from './provider.js';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/u;
const SAFE_TYPE = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,127}$/u;
const FORBIDDEN_TEXT_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;
const FORBIDDEN_SINGLE_LINE_CONTROL = /[\u0000-\u001F\u007F]/u;
const SENSITIVE_METADATA_KEY = /(?:^|[._-])(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret|credential)(?:$|[._-])/iu;
const MAX_TITLE_BYTES = 4_096;
const MAX_CONTENT_BYTES = 65_536;
const MAX_METADATA_BYTES = 16_384;
const MAX_SOURCE_VERSION_BYTES = 512;
const MAX_SOURCE_URL_BYTES = 2_048;
const MAX_PROVIDER_TIMESTAMP_BYTES = 64;
const MAX_METADATA_DEPTH = 8;
const MAX_METADATA_NODES = 512;
// Leave ample room under the Oracle's 2,000,000-byte JSON request limit for
// scope fields, predecessor/current cursors, and the source watermark.
const MAX_NORMALIZED_PAGE_BYTES = 1_900_000;

export function objectValue(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${context} is not an object`);
  }
  return value as Record<string, unknown>;
}

export function stringValue(value: unknown, context: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`${context} is not a non-empty string`);
  return value;
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

export function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function arrayValue(value: unknown, context: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${context} is not an array`);
  return value;
}

export function normalizedProviderTimestamp(value: unknown, context: string): string {
  const raw = stringValue(value, context);
  if (
    Buffer.byteLength(raw, 'utf8') > MAX_PROVIDER_TIMESTAMP_BYTES
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})$/u.test(raw)
  ) {
    throw new Error(`${context} must be a bounded timestamp with an explicit UTC offset`);
  }
  const milliseconds = Date.parse(raw);
  if (!Number.isFinite(milliseconds)) throw new Error(`${context} is not a valid timestamp`);
  return new Date(milliseconds).toISOString();
}

export function assertProviderReadWindow(window: SidecarReadWindow, provider: string): void {
  const until = Date.parse(window.until);
  const from = window.from === undefined ? undefined : Date.parse(window.from);
  if (
    !Number.isFinite(until)
    || new Date(until).toISOString() !== window.until
    || (
      from !== undefined
      && (!Number.isFinite(from) || new Date(from).toISOString() !== window.from)
    )
  ) {
    throw new Error(`${provider} sync window must use canonical timestamps`);
  }
  if (from !== undefined && from > until) {
    throw new Error(`${provider} sync window begins after it ends`);
  }
}

export function boundedProviderText(
  value: unknown,
  maxBytes: number,
  allowLineBreaks = false,
): string {
  if (typeof value !== 'string' || !value) return '';
  const controls = allowLineBreaks ? FORBIDDEN_TEXT_CONTROL : FORBIDDEN_SINGLE_LINE_CONTROL;
  if (controls.test(value)) throw new Error('Provider text contains forbidden control characters');
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let output = '';
  let bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, 'utf8');
    if (bytes + size > maxBytes) break;
    output += character;
    bytes += size;
  }
  return output;
}

export function boundedOptionalProviderText(value: unknown, maxBytes: number): string | undefined {
  const text = optionalString(value);
  return text ? boundedProviderText(text, maxBytes) : undefined;
}

export function safeProviderUrl(value: unknown, requiredOrigin?: string): string | undefined {
  if (
    typeof value !== 'string'
    || !value
    || Buffer.byteLength(value, 'utf8') > MAX_SOURCE_URL_BYTES
  ) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (
    url.protocol !== 'https:'
    || url.username
    || url.password
    || url.search
    || url.hash
    || (requiredOrigin && url.origin !== requiredOrigin)
  ) return undefined;
  return url.toString();
}

/** Final fail-closed check against the Corporate Oracle's accepted record contract. */
export function finalizeProviderRecords(
  records: readonly CorporateRecordInput[],
  provider: string,
): readonly CorporateRecordInput[] {
  const externalIds = new Set<string>();
  for (const record of records) {
    validateCorporateRecord(record, provider);
    if (externalIds.has(record.externalId)) {
      throw new Error(`${provider} returned a duplicate issue identity in one page`);
    }
    externalIds.add(record.externalId);
  }
  if (Buffer.byteLength(JSON.stringify(records), 'utf8') > MAX_NORMALIZED_PAGE_BYTES) {
    throw new Error(`${provider} normalized page exceeds the Oracle request limit`);
  }
  return Object.freeze([...records]);
}

/**
 * Enforce provider chronology before a remote timestamp can become an Oracle
 * version fence. Returning false lets adapters discard deliberate query-margin
 * results without admitting them to the local ledger.
 */
export function providerRecordWithinWindow(
  record: CorporateRecordInput,
  window: SidecarReadWindow,
  provider: string,
): boolean {
  const created = Date.parse(record.occurredAt);
  const updated = Date.parse(record.sourceUpdatedAt);
  const until = Date.parse(window.until);
  const from = window.from === undefined ? undefined : Date.parse(window.from);
  if (
    !Number.isFinite(created)
    || !Number.isFinite(updated)
    || !Number.isFinite(until)
    || (from !== undefined && !Number.isFinite(from))
  ) {
    throw new Error(`${provider} sync window or issue chronology is invalid`);
  }
  if (created > updated) {
    throw new Error(`${provider} issue creation time is later than its update time`);
  }
  return updated <= until && (from === undefined || updated >= from);
}

export function jsonMetadata(entries: Record<string, unknown>): JsonObject {
  const output: JsonObject = {};
  for (const [key, value] of Object.entries(entries)) {
    if (value === undefined) continue;
    if (isJsonValue(value)) output[key] = value;
  }
  return output;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (value && typeof value === 'object') return Object.values(value).every(isJsonValue);
  return false;
}

function validateCorporateRecord(record: CorporateRecordInput, provider: string): void {
  if (!SAFE_ID.test(record.externalId)) {
    throw new Error(`${provider} issue identity is outside the Oracle identifier contract`);
  }
  if (record.domain !== 'project' || !SAFE_TYPE.test(record.recordType)) {
    throw new Error(`${provider} record scope is outside the Oracle contract`);
  }
  if (record.projectId !== undefined && !SAFE_ID.test(record.projectId)) {
    throw new Error(`${provider} local project identity is outside the Oracle identifier contract`);
  }
  validateOracleText(record.title, MAX_TITLE_BYTES, true, `${provider} issue title`);
  validateOracleText(record.content, MAX_CONTENT_BYTES, true, `${provider} issue content`);
  if (record.sourceUrl !== undefined) validateOracleUrl(record.sourceUrl, provider);
  if (record.sourceVersion !== undefined) {
    validateSingleLineText(record.sourceVersion, MAX_SOURCE_VERSION_BYTES, `${provider} issue source version`);
  }
  validateTimestamp(record.occurredAt, `${provider} issue creation time`);
  validateTimestamp(record.sourceUpdatedAt, `${provider} issue update time`);
  if (record.status !== undefined && record.status !== 'active' && record.status !== 'deleted') {
    throw new Error(`${provider} issue status is outside the Oracle contract`);
  }
  validateMetadata(record.metadata ?? {}, provider);
}

function validateOracleText(value: unknown, maximumBytes: number, nonEmpty: boolean, context: string): void {
  if (
    typeof value !== 'string'
    || (nonEmpty && !value.trim())
    || Buffer.byteLength(value, 'utf8') > maximumBytes
    || FORBIDDEN_TEXT_CONTROL.test(value)
  ) {
    throw new Error(`${context} is outside the Oracle text contract`);
  }
}

function validateSingleLineText(value: unknown, maximumBytes: number, context: string): void {
  if (
    typeof value !== 'string'
    || !value
    || Buffer.byteLength(value, 'utf8') > maximumBytes
    || FORBIDDEN_SINGLE_LINE_CONTROL.test(value)
  ) {
    throw new Error(`${context} is outside the Oracle text contract`);
  }
}

function validateOracleUrl(value: string, provider: string): void {
  if (Buffer.byteLength(value, 'utf8') > MAX_SOURCE_URL_BYTES) {
    throw new Error(`${provider} issue URL is outside the Oracle URL contract`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${provider} issue URL is outside the Oracle URL contract`);
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:')
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    throw new Error(`${provider} issue URL is outside the Oracle URL contract`);
  }
}

function validateTimestamp(value: unknown, context: string): void {
  if (
    typeof value !== 'string'
    || !value
    || Buffer.byteLength(value, 'utf8') > 128
    || !Number.isFinite(Date.parse(value))
  ) {
    throw new Error(`${context} is outside the Oracle timestamp contract`);
  }
}

function validateMetadata(metadata: JsonObject, provider: string): void {
  let nodes = 0;
  const visit = (value: JsonValue, depth: number): void => {
    nodes += 1;
    if (nodes > MAX_METADATA_NODES || depth > MAX_METADATA_DEPTH) {
      throw new Error(`${provider} issue metadata exceeds the Oracle structural limit`);
    }
    if (typeof value === 'string' && FORBIDDEN_TEXT_CONTROL.test(value)) {
      throw new Error(`${provider} issue metadata contains forbidden control characters`);
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (value && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) {
        if (!key || key.length > 128 || FORBIDDEN_SINGLE_LINE_CONTROL.test(key) || SENSITIVE_METADATA_KEY.test(key)) {
          throw new Error(`${provider} issue metadata is outside the Oracle key contract`);
        }
        visit(item, depth + 1);
      }
    }
  };
  visit(metadata, 0);
  if (Buffer.byteLength(JSON.stringify(metadata), 'utf8') > MAX_METADATA_BYTES) {
    throw new Error(`${provider} issue metadata exceeds the Oracle byte limit`);
  }
}
