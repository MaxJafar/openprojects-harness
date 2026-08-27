import { setTimeout as sleep } from 'node:timers/promises';

import {
  type OpenProjectsBridgeConfig,
  validateBridgeConfig,
  validateQuestion,
} from './config.js';

const MAX_JSON_BYTES = 1_048_576;
const MAX_OUTPUT_BYTES = 65_536;
const MAX_ERROR_BYTES = 4_096;
const RESPONSE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/u;
const AUTHORIZATION_PATTERN = /^Bearer[ \t]+([A-Za-z0-9._~+/-]+=*)$/u;
const RUN_STATUSES = new Set([
  'queued',
  'running',
  'waiting_for_approval',
  'succeeded',
  'failed',
  'cancelled',
]);

type BridgeRunStatus =
  | 'queued'
  | 'running'
  | 'waiting_for_approval'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export interface BridgeResult {
  schema: 'openprojects.framework-result.v1';
  runId: string;
  status: BridgeRunStatus;
  workspaceId: string;
  projectId: string;
  principalId: string;
  approvalRequired: boolean;
  outputTruncated: boolean;
  output?: string;
  error?: string;
  snapshots?: {
    agent: string;
    tools: string;
    policy: string;
  };
}

interface ParsedRun {
  id: string;
  status: BridgeRunStatus;
  workspaceId: string;
  actorId: string;
  projectId?: string;
  output?: string;
  error?: string;
  snapshots?: {
    agent: string;
    tools: string;
    policy: string;
  };
}

export class OpenProjectsBridgeClient {
  readonly #config: OpenProjectsBridgeConfig;
  readonly #fetch: typeof globalThis.fetch;

  constructor(
    config: OpenProjectsBridgeConfig,
    fetchImplementation: typeof globalThis.fetch = globalThis.fetch.bind(globalThis),
  ) {
    this.#config = validateBridgeConfig(config);
    this.#fetch = fetchImplementation;
  }

  async analyzeProject(question: string, signal?: AbortSignal): Promise<BridgeResult> {
    const boundedQuestion = validateQuestion(question);
    await this.#verifyReadRunScope(signal);

    const accepted = requireRecord(await this.#request('/api/runs/async', {
      method: 'POST',
      body: JSON.stringify({
        message: boundedQuestion,
        workspaceId: this.#config.workspaceId,
        projectId: this.#config.projectId,
        actorId: this.#config.principalId,
      }),
    }, signal), 'run acceptance');
    const initial = this.#requireScopedRun(accepted.run, 'run acceptance');

    const deadline = Date.now() + this.#config.runTimeoutMs;
    const runSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(this.#config.runTimeoutMs)])
      : AbortSignal.timeout(this.#config.runTimeoutMs);
    let run = initial;
    while (run.status === 'queued' || run.status === 'running') {
      if (Date.now() >= deadline) {
        throw new Error(`OpenProjects run ${run.id} exceeded the bridge timeout`);
      }
      await delay(Math.min(this.#config.pollIntervalMs, Math.max(1, deadline - Date.now())), runSignal);
      const outcome = requireRecord(
        await this.#request(`/api/runs/${encodeURIComponent(run.id)}`, {}, runSignal),
        'run outcome',
      );
      run = this.#requireScopedRun(outcome.run, 'run outcome');
      if (run.id !== initial.id) throw new Error('OpenProjects returned a different run ID');
    }

    const output = run.output === undefined ? undefined : truncateUtf8(run.output, MAX_OUTPUT_BYTES);
    const error = run.error === undefined ? undefined : truncateUtf8(run.error, MAX_ERROR_BYTES);
    return Object.freeze({
      schema: 'openprojects.framework-result.v1',
      runId: run.id,
      status: run.status,
      workspaceId: run.workspaceId,
      projectId: this.#config.projectId,
      principalId: this.#config.principalId,
      approvalRequired: run.status === 'waiting_for_approval',
      outputTruncated: output?.truncated ?? false,
      ...(output ? { output: output.value } : {}),
      ...(error ? { error: error.value } : {}),
      ...(run.snapshots ? { snapshots: Object.freeze(run.snapshots) } : {}),
    });
  }

  async #verifyReadRunScope(signal?: AbortSignal): Promise<void> {
    await this.#performScopeVerification(signal);
  }

  async #performScopeVerification(signal?: AbortSignal): Promise<void> {
    const identity = requireRecord(
      await this.#request('/api/whoami', {}, signal),
      'control identity',
    );
    const capabilities = Array.isArray(identity.capabilities) ? identity.capabilities : [];
    const workspaces = Array.isArray(identity.workspaces) ? identity.workspaces : [];
    if (
      identity.authenticated !== true
      || identity.id !== this.#config.principalId
      || capabilities.length !== 2
      || new Set(capabilities).size !== 2
      || capabilities.some((value) => typeof value !== 'string')
      || !capabilities.includes('read')
      || !capabilities.includes('run')
      || workspaces.length !== 1
      || workspaces[0] !== this.#config.workspaceId
      || workspaces.some((value) => typeof value !== 'string')
    ) {
      throw new Error(
        'MCP bridge requires the fixed principal, exactly read and run capabilities, and exactly one fixed workspace',
      );
    }
  }

  #requireScopedRun(value: unknown, label: string): ParsedRun {
    const run = requireRecord(value, label);
    const id = requiredIdentifier(run.id, `${label} run ID`);
    const status = requiredString(run.status, `${label} status`);
    if (!RUN_STATUSES.has(status)) throw new Error(`${label} has an invalid status`);
    const workspaceId = requiredIdentifier(run.workspaceId, `${label} workspace`);
    const actorId = requiredIdentifier(run.actorId, `${label} actor`);
    const projectId = run.projectId === undefined
      ? undefined
      : requiredIdentifier(run.projectId, `${label} project`);
    if (
      workspaceId !== this.#config.workspaceId
      || actorId !== this.#config.principalId
      || projectId !== this.#config.projectId
    ) {
      throw new Error(`${label} escaped the fixed principal, workspace, or project scope`);
    }
    const output = optionalString(run.output, `${label} output`);
    const error = optionalString(run.error, `${label} error`);
    const snapshots = parseSnapshotDigests(run.snapshots, label);
    return {
      id,
      status: status as BridgeRunStatus,
      workspaceId,
      actorId,
      ...(projectId ? { projectId } : {}),
      ...(output !== undefined ? { output } : {}),
      ...(error !== undefined ? { error } : {}),
      ...(snapshots ? { snapshots } : {}),
    };
  }

  async #request(
    path: string,
    init: RequestInit,
    outerSignal?: AbortSignal,
  ): Promise<unknown> {
    const authorization = this.#config.credential.authorizationHeader();
    const token = typeof authorization === 'string'
      ? AUTHORIZATION_PATTERN.exec(authorization)?.[1]
      : undefined;
    if (!token || token.length < 32 || token.length > 512) {
      throw new Error('OpenProjects bridge credential returned an invalid Authorization header');
    }
    const signal = outerSignal
      ? AbortSignal.any([outerSignal, AbortSignal.timeout(this.#config.requestTimeoutMs)])
      : AbortSignal.timeout(this.#config.requestTimeoutMs);
    const response = await this.#fetch(new URL(path, this.#config.baseUrl), {
      ...init,
      headers: {
        accept: 'application/json',
        authorization,
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      redirect: 'error',
      signal,
    });
    const body = await readBoundedJson(response);
    if (!response.ok) throw new Error(`OpenProjects request failed with HTTP ${response.status}`);
    return body;
  }
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (!contentType.startsWith('application/json')) {
    throw new Error('OpenProjects returned a non-JSON response');
  }
  const declared = response.headers.get('content-length');
  if (declared !== null && Number(declared) > MAX_JSON_BYTES) {
    throw new Error('OpenProjects response exceeds the bridge limit');
  }
  if (!response.body) throw new Error('OpenProjects returned an empty response');

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_JSON_BYTES) throw new Error('OpenProjects response exceeds the bridge limit');
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch (error) {
    throw new Error('OpenProjects returned invalid JSON', { cause: error });
  }
}

function parseSnapshotDigests(
  value: unknown,
  label: string,
): ParsedRun['snapshots'] | undefined {
  if (value === undefined) return undefined;
  const record = requireRecord(value, `${label} snapshots`);
  return {
    agent: requiredDigest(record.agent, `${label} agent snapshot`),
    tools: requiredDigest(record.tools, `${label} tools snapshot`),
    policy: requiredDigest(record.policy, `${label} policy snapshot`),
  };
}

function requiredDigest(value: unknown, label: string): string {
  const digest = requiredString(value, label);
  if (!/^[a-f0-9]{64}$/u.test(digest)) throw new Error(`${label} is not a SHA-256 digest`);
  return digest;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length < 1) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function requiredIdentifier(value: unknown, label: string): string {
  const identifier = requiredString(value, label);
  if (!RESPONSE_IDENTIFIER_PATTERN.test(identifier)) {
    throw new Error(`${label} must be a bounded safe identifier`);
  }
  return identifier;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, label);
}

function truncateUtf8(value: string, maximumBytes: number): { value: string; truncated: boolean } {
  const encoded = new TextEncoder().encode(value);
  if (encoded.byteLength <= maximumBytes) return { value, truncated: false };
  return {
    value: new TextDecoder().decode(encoded.subarray(0, maximumBytes)),
    truncated: true,
  };
}

async function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  await sleep(milliseconds, undefined, signal ? { signal } : undefined);
}
