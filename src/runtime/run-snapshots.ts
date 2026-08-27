import { createHash } from 'node:crypto';

import type {
  AgentDefinition,
  JsonObject,
  JsonValue,
  PolicyDecision,
  RunSnapshotDigests,
  RunSnapshotDocument,
  RunSnapshotKind,
  RunSnapshotSet,
  SkillDefinition,
  ToolDefinition,
  ToolEffect,
} from '../core/types.js';

const SNAPSHOT_SCHEMA = 'openprojects.run-snapshot.v1' as const;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const MAX_CANONICAL_DEPTH = 100;
const TOOL_EFFECTS: ToolEffect[] = [
  'read',
  'draft',
  'memory_write',
  'internal_write',
  'external_write',
  'destructive',
];

export interface CaptureRunSnapshotsInput {
  agent: AgentDefinition;
  /** Effective static prompt or stable source/template commitment for a dynamic prompt. */
  systemPromptCommitment?: string;
  runtimeProfile?: {
    task: string;
    retrieveMemory: boolean;
    maxModelAttempts: number;
    finalOutputValidatorCommitment?: string;
  };
  skills: SkillDefinition[];
  tools: ToolDefinition[];
  policy: Record<ToolEffect, PolicyDecision>;
  /** Stable plugin identifiers participating in policy evaluation. */
  policyGuards?: string[];
}

/**
 * Captures complete redacted content-addressed commitments for the
 * least-privilege contract visible to one agent run.
 * Prompt/skill bodies and tool descriptions/schemas are committed by digest
 * rather than copied into SQLite, avoiding durable disclosure of their text.
 */
export function captureRunSnapshots(input: CaptureRunSnapshotsInput): RunSnapshotSet {
  const grants = sortedUnique(input.agent.tools, 'agent tool grants');
  const skillGrants = sortedUnique(input.agent.skills, 'agent skill grants');
  const toolByName = uniqueBy(input.tools, (tool) => tool.name, 'tool definitions');
  const skillById = uniqueBy(input.skills, (skill) => skill.id, 'skill definitions');

  const tools = grants.map((name) => {
    const tool = toolByName.get(name);
    if (!tool) throw new Error(`Cannot snapshot unresolved agent tool: ${name}`);
    return {
      name,
      effect: tool.effect,
      idempotency: tool.idempotency,
      timeoutMs: tool.timeoutMs ?? 30_000,
      descriptionDigest: sha256Text(tool.description),
      inputSchemaDigest: sha256Json(tool.inputSchema),
      outputSchemaDigest: tool.outputSchema ? sha256Json(tool.outputSchema) : null,
      snapshotBindingDigest: tool.snapshotBinding ? sha256Json(tool.snapshotBinding) : null,
    };
  });
  const skills = skillGrants.map((id) => {
    const skill = skillById.get(id);
    if (!skill) throw new Error(`Cannot snapshot unresolved agent skill: ${id}`);
    return {
      id,
      version: skill.version,
      nameDigest: sha256Text(skill.name),
      descriptionDigest: sha256Text(skill.description),
      instructionsDigest: sha256Text(skill.instructions),
      toolGrants: sortedUnique(skill.tools, `skill ${id} tool grants`),
      evaluators: sortedUnique(skill.evaluators, `skill ${id} evaluators`),
    };
  });
  const effectDecisions = Object.fromEntries(
    TOOL_EFFECTS.map((effect) => [effect, input.policy[effect]]),
  ) as Record<ToolEffect, PolicyDecision>;

  return {
    agent: createRunSnapshot('agent', {
      capture: 'complete',
      contract: 'redacted-agent-contract-v1',
      agent: {
        id: input.agent.id,
        version: input.agent.version,
        name: input.agent.name,
        systemPromptDigest: sha256Text(input.systemPromptCommitment ?? `static:${input.agent.system}`),
        runtimeProfile: input.runtimeProfile
          ? {
              task: input.runtimeProfile.task,
              retrieveMemory: input.runtimeProfile.retrieveMemory,
              maxModelAttempts: input.runtimeProfile.maxModelAttempts,
              finalOutputValidatorDigest: input.runtimeProfile.finalOutputValidatorCommitment
                ? sha256Text(input.runtimeProfile.finalOutputValidatorCommitment)
                : null,
            }
          : null,
        skillGrants,
        skills,
        toolGrants: grants,
        budgets: { ...input.agent.budgets },
      },
    }),
    tools: createRunSnapshot('tools', {
      capture: 'complete',
      contract: 'redacted-tool-contract-v1',
      tools,
    }),
    policy: createRunSnapshot('policy', {
      capture: 'complete',
      contract: 'openprojects-tool-policy-v1',
      agentId: input.agent.id,
      denyUngrant: true,
      toolGrants: grants,
      effectDecisions,
      guardPlugins: sortedUnique(input.policyGuards ?? ['policy'], 'policy guard plugins'),
    }),
  };
}

/**
 * Compatibility path for callers that allocate bookkeeping/test runs directly
 * through storage. It preserves the invariant that every new run is bound to
 * three snapshots without pretending unknown tool or policy state was captured.
 */
export function compatibilityRunSnapshots(agentId: string, agentVersion: string): RunSnapshotSet {
  return {
    agent: createRunSnapshot('agent', {
      capture: 'compatibility',
      complete: false,
      agent: { id: agentId, version: agentVersion },
    }),
    tools: createRunSnapshot('tools', {
      capture: 'compatibility',
      complete: false,
      tools: [],
    }),
    policy: createRunSnapshot('policy', {
      capture: 'compatibility',
      complete: false,
      authority: 'unknown',
    }),
  };
}

export function createRunSnapshot(kind: RunSnapshotKind, content: JsonObject): RunSnapshotDocument {
  const addressable = { schema: SNAPSHOT_SCHEMA, kind, content } satisfies JsonObject;
  return {
    ...addressable,
    digest: sha256Text(canonicalSnapshotJson(addressable)),
  };
}

export function verifyRunSnapshot(snapshot: RunSnapshotDocument): void {
  if (snapshot.schema !== SNAPSHOT_SCHEMA) throw new Error('Unsupported run snapshot schema');
  if (!['agent', 'tools', 'policy'].includes(snapshot.kind)) throw new Error('Invalid run snapshot kind');
  if (!DIGEST_PATTERN.test(snapshot.digest)) throw new Error('Invalid run snapshot digest');
  const expected = createRunSnapshot(snapshot.kind, snapshot.content).digest;
  if (snapshot.digest !== expected) throw new Error(`Run ${snapshot.kind} snapshot digest mismatch`);
}

export function verifyRunSnapshotSet(snapshots: RunSnapshotSet): void {
  for (const kind of ['agent', 'tools', 'policy'] as const) {
    const snapshot = snapshots[kind];
    if (snapshot.kind !== kind) throw new Error(`Run snapshot binding expected ${kind}, received ${snapshot.kind}`);
    verifyRunSnapshot(snapshot);
  }
}

export function runSnapshotDigests(snapshots: RunSnapshotSet): RunSnapshotDigests {
  verifyRunSnapshotSet(snapshots);
  return {
    agent: snapshots.agent.digest,
    tools: snapshots.tools.digest,
    policy: snapshots.policy.digest,
  };
}

export function sha256Json(value: JsonValue): string {
  return sha256Text(canonicalSnapshotJson(value));
}

export function sha256Text(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

/**
 * Strict deterministic JSON subset used for snapshot addressing. Object keys
 * are recursively ordered by UTF-16 code units. Non-JSON values, sparse arrays,
 * accessors, cycles, non-finite/unsafe numbers and unpaired surrogates fail
 * closed. This intentionally does not claim full RFC 8785 conformance.
 */
export function canonicalSnapshotJson(value: unknown): string {
  return encodeCanonical(value, new Set<object>(), 0);
}

function encodeCanonical(value: unknown, ancestors: Set<object>, depth: number): string {
  if (depth > MAX_CANONICAL_DEPTH) throw new Error('Canonical JSON exceeds maximum depth');
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') {
    assertUnicodeScalarString(value);
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Canonical JSON numbers must be finite');
    if (Object.is(value, -0)) throw new Error('Canonical JSON does not support negative zero');
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new Error('Canonical JSON integers must be safe integers');
    }
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') throw new Error(`Canonical JSON does not support ${typeof value}`);
  if (ancestors.has(value)) throw new Error('Canonical JSON does not support cycles');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const encoded: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) throw new Error('Canonical JSON does not support sparse arrays');
        encoded.push(encodeCanonical(value[index], ancestors, depth + 1));
      }
      return `[${encoded.join(',')}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('Canonical JSON objects must be plain records');
    }
    if (Object.getOwnPropertySymbols(value).length) {
      throw new Error('Canonical JSON does not support symbol properties');
    }
    const names = Object.getOwnPropertyNames(value);
    const keys = Object.keys(value);
    if (names.length !== keys.length) throw new Error('Canonical JSON does not support hidden properties');
    keys.sort(compareUtf16);
    const encoded = keys.map((key) => {
      assertUnicodeScalarString(key);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor)) throw new Error('Canonical JSON does not support accessors');
      return `${JSON.stringify(key)}:${encodeCanonical(descriptor.value, ancestors, depth + 1)}`;
    });
    return `{${encoded.join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

function compareUtf16(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertUnicodeScalarString(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new Error('Canonical JSON strings must not contain unpaired surrogates');
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error('Canonical JSON strings must not contain unpaired surrogates');
    }
  }
}

function sortedUnique(values: string[], label: string): string[] {
  const sorted = [...values].sort(compareUtf16);
  if (sorted.some((value, index) => index > 0 && value === sorted[index - 1])) {
    throw new Error(`Cannot snapshot duplicate ${label}`);
  }
  for (const value of sorted) assertUnicodeScalarString(value);
  return sorted;
}

function uniqueBy<T>(values: T[], key: (value: T) => string, label: string): Map<string, T> {
  const result = new Map<string, T>();
  for (const value of values) {
    const id = key(value);
    if (result.has(id)) throw new Error(`Cannot snapshot duplicate ${label}: ${id}`);
    result.set(id, value);
  }
  return result;
}
