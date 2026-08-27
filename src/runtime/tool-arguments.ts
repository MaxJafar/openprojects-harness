import type { JsonObject } from '../core/types.js';
import { parseJsonRejectingDuplicateKeys } from '../core/strict-json.js';
import { canonicalSnapshotJson, sha256Text } from './run-snapshots.js';

export const TOOL_ARGUMENT_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;

export interface CanonicalToolArguments {
  /** Immutable object used for policy evaluation. */
  input: JsonObject;
  /** Exact canonical bytes persisted, reviewed, recovered, and executed. */
  arguments: string;
  argumentsDigest: string;
}

export class ToolArgumentIntegrityError extends Error {
  readonly code = 'TOOL_ARGUMENT_INTEGRITY_ERROR';

  constructor(message: string) {
    super(message);
    this.name = 'ToolArgumentIntegrityError';
  }
}

export function canonicalizeToolArguments(input: JsonObject): CanonicalToolArguments {
  const argumentsJson = canonicalSnapshotJson(input);
  const canonicalInput = parseJsonRejectingDuplicateKeys(argumentsJson);
  if (!isJsonObject(canonicalInput)) throw new Error('Canonical tool arguments must be a JSON object');
  deepFreeze(canonicalInput);
  return {
    input: canonicalInput,
    arguments: argumentsJson,
    argumentsDigest: sha256Text(argumentsJson),
  };
}

/** Verify that durable bytes are canonical, object-shaped, and content-addressed. */
export function verifyCanonicalToolArguments(argumentsJson: string, argumentsDigest: string): JsonObject {
  if (!TOOL_ARGUMENT_DIGEST_PATTERN.test(argumentsDigest)) {
    throw new ToolArgumentIntegrityError('Tool arguments digest is missing or malformed');
  }
  let parsed: unknown;
  try {
    parsed = parseJsonRejectingDuplicateKeys(argumentsJson);
  } catch {
    throw new ToolArgumentIntegrityError('Durable tool arguments are not strict JSON');
  }
  if (!isJsonObject(parsed)) throw new ToolArgumentIntegrityError('Durable tool arguments are not a JSON object');
  let canonical: string;
  try {
    canonical = canonicalSnapshotJson(parsed);
  } catch {
    throw new ToolArgumentIntegrityError('Durable tool arguments cannot be canonically encoded');
  }
  if (canonical !== argumentsJson) {
    throw new ToolArgumentIntegrityError('Durable tool arguments are not in canonical form');
  }
  if (sha256Text(argumentsJson) !== argumentsDigest) {
    throw new ToolArgumentIntegrityError('Durable tool arguments digest does not match their canonical bytes');
  }
  return parsed;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepFreeze(value: JsonObject): void {
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') {
      deepFreezeValue(child);
    }
  }
  Object.freeze(value);
}

function deepFreezeValue(value: object): void {
  if (Array.isArray(value)) {
    for (const child of value) if (child && typeof child === 'object') deepFreezeValue(child);
  } else {
    for (const child of Object.values(value)) if (child && typeof child === 'object') deepFreezeValue(child);
  }
  Object.freeze(value);
}
