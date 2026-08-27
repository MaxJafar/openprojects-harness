import type {
  ApprovalRecord,
  HarnessEvent,
  RunOutcome,
  RunRecord,
  RunSnapshotSet,
  StartRunInput,
} from '../core/types.js';
import type { ControlClientCredential } from '../auth/control-auth.js';
import { isLoopbackHostname } from '../privacy/network-policy.js';
import type { TuiApprovalResolution, TuiBackend, TuiRunHandle } from '../tui/backend.js';
import type { TuiSnapshot, TuiSnapshotOptions } from '../tui/model.js';
import { UnixTransportError } from './unix-fetch.js';

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const MAX_JSON_BYTES = 5_000_000;
const MAX_SSE_EVENT_BYTES = 1_000_000;

export interface OpenProjectsApiClientOptions {
  fetch?: typeof globalThis.fetch;
  requestTimeoutMs?: number;
  reconnectDelayMs?: number;
  credential?: ControlClientCredential;
  principalId?: string;
}

export interface RunStreamEvent {
  event: string;
  /** Durable session-scoped sequence. Snapshots do not have an event id. */
  id?: number;
  data: HarnessEvent | RunOutcome | RunStreamSnapshot;
}

export interface RunStreamSnapshot {
  run: RunRecord;
  approvals: ApprovalRecord[];
  /** Last durable event included in the replay immediately preceding this snapshot. */
  cursor: number;
}

/** Read-authorized run detail, including its verified redacted commitments. */
export interface RunDetails extends RunOutcome {
  snapshotDocuments: RunSnapshotSet | null;
}

export class OpenProjectsApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'OpenProjectsApiError';
  }
}

/** Strict-loopback client for the service-owned OpenProjects runtime. */
export class OpenProjectsApiClient implements TuiBackend {
  readonly baseUrl: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #requestTimeoutMs: number;
  readonly #reconnectDelayMs: number;
  readonly #credential: ControlClientCredential | undefined;
  readonly #principalId: string | undefined;

  constructor(baseUrl: string | URL, options: OpenProjectsApiClientOptions = {}) {
    const parsed = normalizeLoopbackBaseUrl(baseUrl);
    this.baseUrl = parsed.origin;
    if ((options.credential === undefined) !== (options.principalId === undefined)) {
      throw new Error('OpenProjects client credential and principalId must be configured together');
    }
    if (options.principalId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/u.test(options.principalId)) {
      throw new Error('OpenProjects client principalId is invalid');
    }
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#credential = options.credential;
    this.#principalId = options.principalId;
    this.#requestTimeoutMs = boundedDuration(
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      'requestTimeoutMs',
      250,
      120_000,
    );
    this.#reconnectDelayMs = boundedDuration(
      options.reconnectDelayMs ?? 1_000,
      'reconnectDelayMs',
      50,
      30_000,
    );
  }

  async snapshot(workspaceId: string, options: TuiSnapshotOptions = {}): Promise<TuiSnapshot> {
    const workspace = pathComponent(workspaceId, 'workspaceId');
    const query = [
      `workspaceId=${workspace}`,
      ...(options.approvalCursor
        ? [`approvalCursor=${encodeURIComponent(options.approvalCursor)}`]
        : []),
      ...(options.approvalLimit !== undefined
        ? [`approvalLimit=${encodeURIComponent(String(options.approvalLimit))}`]
        : []),
    ].join('&');
    const body = await this.#json(`/api/tui/snapshot?${query}`);
    const snapshot = requireRecord(body, 'TUI snapshot');
    if (snapshot.workspaceId !== workspaceId) {
      throw new Error('OpenProjects service returned a snapshot for a different workspace');
    }
    for (const key of ['runs', 'approvals', 'memories', 'projects'] as const) {
      if (!Array.isArray(snapshot[key])) throw new Error(`OpenProjects TUI snapshot is missing ${key}`);
    }
    for (const approval of snapshot.approvals as unknown[]) requireApprovalDigest(approval, 'TUI approval');
    const approvalPage = requireRecord(snapshot.approvalPage, 'TUI approval page');
    if (
      !Number.isSafeInteger(approvalPage.limit)
      || Number(approvalPage.limit) < 1
      || Number(approvalPage.limit) > 200
      || (approvalPage.nextCursor !== undefined && typeof approvalPage.nextCursor !== 'string')
    ) {
      throw new Error('OpenProjects service returned an invalid approval page');
    }
    if (snapshot.control !== undefined) {
      const control = requireRecord(snapshot.control, 'TUI control session');
      if (
        typeof control.authenticated !== 'boolean'
        || typeof control.principalId !== 'string'
        || !Array.isArray(control.capabilities)
        || control.capabilities.some((item) => !['read', 'run', 'ingest', 'approve', 'admin'].includes(String(item)))
        || (control.workspaceScope !== 'all' && control.workspaceScope !== 'scoped')
      ) {
        throw new Error('OpenProjects service returned an invalid control session');
      }
      if (this.#principalId && control.principalId !== this.#principalId) {
        throw new Error('OpenProjects service returned a different authenticated principal');
      }
    }
    return snapshot as unknown as TuiSnapshot;
  }

  async startRun(input: StartRunInput): Promise<TuiRunHandle> {
    const actorId = this.#principalId ?? input.actorId;
    const body = await this.#json('/api/runs/async', {
      method: 'POST',
      body: JSON.stringify({
        ...input,
        ...(actorId ? { actorId } : {}),
      }),
    });
    const handle = parseRunHandle(body, this.baseUrl);
    const requestedWorkspace = input.workspaceId ?? 'local';
    const requestedActor = actorId ?? 'local-user';
    if (handle.run.workspaceId !== requestedWorkspace || handle.run.actorId !== requestedActor) {
      throw new Error('OpenProjects service returned a run outside the requested actor/workspace scope');
    }
    return handle;
  }

  async resolveApproval(input: TuiApprovalResolution): Promise<TuiRunHandle> {
    const approvalId = pathComponent(input.approvalId, 'approvalId');
    const body = await this.#json(`/api/approvals/${approvalId}/async`, {
      method: 'POST',
      body: JSON.stringify({
        decision: input.decision,
        actorId: this.#principalId ?? input.actorId,
        ...(input.argumentsDigest ? { argumentsDigest: input.argumentsDigest } : {}),
        ...(input.reason ? { reason: input.reason } : {}),
      }),
    });
    return parseRunHandle(body, this.baseUrl);
  }

  async getRun(runId: string): Promise<RunDetails> {
    const body = await this.#json(`/api/runs/${pathComponent(runId, 'runId')}`);
    const record = requireRecord(body, 'run outcome');
    requireRun(record.run, 'run outcome');
    if (!Array.isArray(record.approvals) || !Array.isArray(record.events)) {
      throw new Error('OpenProjects run outcome is incomplete');
    }
    for (const approval of record.approvals) requireApprovalDigest(approval, 'run approval');
    if (record.snapshotDocuments !== null) {
      const snapshots = requireRecord(record.snapshotDocuments, 'run snapshot documents');
      for (const kind of ['agent', 'tools', 'policy'] as const) {
        const snapshot = requireRecord(snapshots[kind], `${kind} run snapshot`);
        if (snapshot.kind !== kind || typeof snapshot.digest !== 'string') {
          throw new Error(`OpenProjects ${kind} run snapshot is invalid`);
        }
      }
    }
    return record as unknown as RunDetails;
  }

  async streamRunEvents(
    runId: string,
    onEvent: (event: RunStreamEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const encodedRunId = pathComponent(runId, 'runId');
    let cursor = -1;
    let reachedTerminal = false;
    while (!signal?.aborted && !reachedTerminal) {
      const path = `/api/runs/${encodedRunId}/events/stream${cursor >= 0 ? `?afterSeq=${cursor}` : ''}`;
      try {
        await this.#consumeSse(path, signal, (event, raw, id) => {
          const parsed = parseEventData(raw);
          if (event === 'run.snapshot') {
            const snapshot = parseRunStreamSnapshot(parsed, runId);
            deliverRunStreamEvent(onEvent, { event, data: snapshot });
            reachedTerminal = terminalRunStatus(snapshot.run.status);
            return;
          }
          if (id === undefined) throw new SseProtocolError('Durable run event is missing its SSE id');
          const durable = parseHarnessEvent(parsed, runId, id);
          if (id <= cursor) return;
          deliverRunStreamEvent(onEvent, { event, id, data: durable });
          cursor = id;
          if (terminalRunEvent(event)) reachedTerminal = true;
        }, cursor >= 0 ? cursor : undefined);
      } catch (error) {
        if (signal?.aborted) return;
        if (!retryableStreamError(error)) throw error;
      }
      if (!reachedTerminal && !signal?.aborted) {
        try {
          await abortableDelay(this.#reconnectDelayMs, signal ?? new AbortController().signal);
        } catch {
          return;
        }
      }
    }
  }

  subscribe(
    workspaceId: string,
    onChange: () => void,
    onError?: (error: Error) => void,
  ): () => void {
    const workspace = pathComponent(workspaceId, 'workspaceId');
    const controller = new AbortController();
    let stopped = false;
    void (async () => {
      while (!stopped) {
        try {
          await this.#consumeSse(
            `/api/events/stream?workspaceId=${workspace}`,
            controller.signal,
            () => onChange(),
          );
          if (!stopped) throw new Error('OpenProjects event stream closed unexpectedly');
        } catch (error) {
          if (stopped || controller.signal.aborted) return;
          onError?.(asError(error));
          try {
            await abortableDelay(this.#reconnectDelayMs, controller.signal);
          } catch {
            return;
          }
        }
      }
    })();
    return () => {
      stopped = true;
      controller.abort();
    };
  }

  async #json(path: string, init: RequestInit = {}): Promise<unknown> {
    const timeout = AbortSignal.timeout(this.#requestTimeoutMs);
    const headers = new Headers(init.headers);
    headers.set('accept', 'application/json');
    if (init.body !== undefined) headers.set('content-type', 'application/json');
    if (this.#credential) headers.set('authorization', this.#credential.authorizationHeader());
    const response = await this.#fetch(new URL(path, this.baseUrl), {
      ...init,
      headers,
      redirect: 'error',
      signal: timeout,
    });
    const body = await readBoundedBody(response, MAX_JSON_BYTES);
    if (!response.ok) throw new OpenProjectsApiError(response.status, apiErrorMessage(body, response.status));
    const contentType = response.headers.get('content-type')?.toLocaleLowerCase() ?? '';
    if (!contentType.startsWith('application/json')) {
      throw new Error('OpenProjects service returned a non-JSON response');
    }
    try {
      return JSON.parse(body) as unknown;
    } catch {
      throw new Error('OpenProjects service returned invalid JSON');
    }
  }

  async #consumeSse(
    path: string,
    signal: AbortSignal | undefined,
    onEvent: (event: string, data: string, id: number | undefined) => void,
    lastEventId?: number,
  ): Promise<void> {
    const headers = new Headers({ accept: 'text/event-stream' });
    if (this.#credential) headers.set('authorization', this.#credential.authorizationHeader());
    if (lastEventId !== undefined) headers.set('last-event-id', String(lastEventId));
    const response = await this.#fetch(new URL(path, this.baseUrl), {
      headers,
      redirect: 'error',
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      const body = await readBoundedBody(response, 16_384);
      throw new OpenProjectsApiError(response.status, apiErrorMessage(body, response.status));
    }
    if (!response.headers.get('content-type')?.toLocaleLowerCase().startsWith('text/event-stream')) {
      throw new SseProtocolError('OpenProjects service returned a non-event-stream response');
    }
    if (!response.body) throw new SseProtocolError('OpenProjects event stream has no body');
    await consumeSseBody(response.body, onEvent, signal);
  }
}

function normalizeLoopbackBaseUrl(value: string | URL): URL {
  let url: URL;
  try {
    url = value instanceof URL ? new URL(value.toString()) : new URL(value);
  } catch {
    throw new Error('OpenProjects server URL is invalid');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('OpenProjects server URL must use http or https');
  }
  if (!isLoopbackHostname(url.hostname)) {
    throw new Error('OpenProjects TUI only connects to a loopback server');
  }
  if (url.username || url.password) throw new Error('OpenProjects server URL must not contain credentials');
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new Error('OpenProjects server URL must be an origin without a path, query, or fragment');
  }
  return url;
}

function parseRunHandle(value: unknown, baseUrl: string): TuiRunHandle {
  const body = requireRecord(value, 'run acceptance');
  const run = requireRun(body.run, 'run acceptance');
  const links = requireRecord(body.links, 'run acceptance links');
  const statusUrl = sameOriginLink(links.status, baseUrl, 'status');
  const eventsUrl = sameOriginLink(links.events, baseUrl, 'events');
  return { run, statusUrl, eventsUrl };
}

function requireRun(value: unknown, context: string): RunRecord {
  const run = requireRecord(value, context);
  for (const key of ['id', 'workspaceId', 'actorId', 'status', 'sessionId'] as const) {
    if (typeof run[key] !== 'string' || !run[key]) throw new Error(`OpenProjects ${context} has an invalid ${key}`);
  }
  return run as unknown as RunRecord;
}

function sameOriginLink(value: unknown, baseUrl: string, name: string): string {
  if (typeof value !== 'string') throw new Error(`OpenProjects run acceptance is missing its ${name} link`);
  const parsed = new URL(value, baseUrl);
  if (parsed.origin !== baseUrl) throw new Error(`OpenProjects ${name} link escaped the local service origin`);
  return parsed.toString();
}

function requireRecord(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`OpenProjects ${context} is not an object`);
  }
  return value as Record<string, unknown>;
}

function pathComponent(value: string, name: string): string {
  if (!value || value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${name} must be 1-256 control-free characters`);
  }
  return encodeURIComponent(value);
}

function boundedDuration(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

async function readBoundedBody(response: Response, maximum: number): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maximum) throw new Error('OpenProjects response is too large');
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > maximum) {
      await reader.cancel();
      throw new Error('OpenProjects response is too large');
    }
    chunks.push(chunk.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function consumeSseBody(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: string, data: string, id: number | undefined) => void,
  signal?: AbortSignal,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let event = 'message';
  let data: string[] = [];
  let dataBytes = 0;
  let id: number | undefined;
  const dispatch = (): void => {
    if (data.length) onEvent(event, data.join('\n'), id);
    event = 'message';
    data = [];
    dataBytes = 0;
    id = undefined;
  };
  const consumeLine = (line: string): void => {
    if (!line) {
      dispatch();
      return;
    }
    if (line.startsWith(':')) return;
    if (line.startsWith('event:')) {
      event = line.slice(6).trimStart();
      return;
    }
    if (line.startsWith('id:')) {
      const rawId = line.slice(3).trimStart();
      if (!/^(0|[1-9][0-9]{0,15})$/u.test(rawId) || !Number.isSafeInteger(Number(rawId))) {
        throw new SseProtocolError('OpenProjects event stream returned an invalid event id');
      }
      id = Number(rawId);
      return;
    }
    if (line.startsWith('data:')) {
      const value = line.slice(5).trimStart();
      dataBytes += Buffer.byteLength(value, 'utf8') + (data.length ? 1 : 0);
      if (dataBytes > MAX_SSE_EVENT_BYTES) {
        throw new SseProtocolError('OpenProjects event stream frame is too large');
      }
      data.push(value);
    }
  };
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const rawLine = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
        consumeLine(line);
        newline = buffer.indexOf('\n');
      }
      if (Buffer.byteLength(buffer, 'utf8') > MAX_SSE_EVENT_BYTES) {
        throw new SseProtocolError('OpenProjects event stream frame is too large');
      }
    }
    buffer += decoder.decode();
    if (buffer) {
      const line = buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer;
      consumeLine(line);
    }
    dispatch();
  } finally {
    if (signal?.aborted !== true) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function parseEventData(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new SseProtocolError('OpenProjects event stream returned invalid JSON');
  }
}

function parseRunStreamSnapshot(value: unknown, runId: string): RunStreamSnapshot {
  const snapshot = requireRecord(value, 'run stream snapshot');
  const run = requireRun(snapshot.run, 'run stream snapshot');
  if (run.id !== runId) throw new SseProtocolError('Run stream snapshot belongs to a different run');
  if (!Array.isArray(snapshot.approvals)) {
    throw new SseProtocolError('Run stream snapshot is missing approvals');
  }
  if (!Number.isSafeInteger(snapshot.cursor) || (snapshot.cursor as number) < -1) {
    throw new SseProtocolError('Run stream snapshot has an invalid cursor');
  }
  return snapshot as unknown as RunStreamSnapshot;
}

function parseHarnessEvent(value: unknown, runId: string, id: number): HarnessEvent {
  const event = requireRecord(value, 'run event');
  if (event.runId !== runId) throw new SseProtocolError('Run stream event belongs to a different run');
  if (event.seq !== id) throw new SseProtocolError('Run stream event sequence does not match its SSE id');
  if (typeof event.id !== 'string' || typeof event.type !== 'string' || typeof event.sessionId !== 'string') {
    throw new SseProtocolError('Run stream event is incomplete');
  }
  return event as unknown as HarnessEvent;
}

function requireApprovalDigest(value: unknown, label: string): void {
  const approval = requireRecord(value, label);
  if (
    approval.argumentsDigest !== undefined
    && (typeof approval.argumentsDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(approval.argumentsDigest))
  ) {
    throw new Error(`OpenProjects ${label} has an invalid argument digest`);
  }
}

function terminalRunStatus(status: string): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

function terminalRunEvent(event: string): boolean {
  return event === 'run.succeeded' || event === 'run.failed' || event === 'run.cancelled';
}

function retryableStreamError(error: unknown): boolean {
  if (error instanceof SseProtocolError || error instanceof StreamConsumerError) return false;
  if (error instanceof OpenProjectsApiError) return error.status >= 500;
  if (error instanceof UnixTransportError) {
    return error.code === 'CONNECTION_RESET'
      || error.code === 'TIMEOUT'
      || error.code === 'UNAVAILABLE'
      || error.code === 'SOCKET_ERROR';
  }
  return error instanceof TypeError || (error instanceof DOMException && error.name !== 'AbortError');
}

function deliverRunStreamEvent(
  consumer: (event: RunStreamEvent) => void,
  event: RunStreamEvent,
): void {
  try {
    consumer(event);
  } catch (error) {
    throw new StreamConsumerError(error);
  }
}

class StreamConsumerError extends Error {
  constructor(readonly consumerCause: unknown) {
    super(consumerCause instanceof Error ? consumerCause.message : 'Run stream consumer failed');
    this.name = 'StreamConsumerError';
  }
}

class SseProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SseProtocolError';
  }
}

function apiErrorMessage(body: string, status: number): string {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const message = (parsed as Record<string, unknown>).error;
      if (typeof message === 'string' && message) return message.slice(0, 4_096);
    }
  } catch {
    // Use a stable status-only error for non-JSON responses.
  }
  return `OpenProjects request failed with HTTP ${status}`;
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
