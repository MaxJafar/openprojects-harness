import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, resolve } from 'node:path';

import type { OpenProjectsApp } from './app.js';
import {
  hasControlCapability,
  isControlWorkspaceAllowed,
  loadControlAuthenticator,
  type ControlAuthenticator,
  type ControlPrincipal,
} from './auth/control-auth.js';
import type { ControlCapability, HarnessEvent, InboundEvent, JsonObject, JsonValue } from './core/types.js';
import { parseJsonRejectingDuplicateKeys } from './core/strict-json.js';
import type {
  CorporateIngestResult,
  CorporateRecordInput,
  CorporateSearchResult,
} from './oracle/corporate-oracle.js';
import { exportLearningDatasets, type LearningDatasetKind } from './learning/export.js';
import { isLoopbackHostname } from './privacy/network-policy.js';
import { DeadlineScheduler } from './runtime/scheduler.js';
import { RunAdmissionError } from './runtime/run-admission.js';
import {
  ApprovalArgumentIntegrityError,
  ApprovalCursorError,
  ApprovalDecisionConflictError,
  CorporateSourceConflictError,
} from './storage/sqlite.js';
import {
  closeUnixSocketServer,
  listenOnUnixSocket,
  type UnixSocketLease,
} from './server-endpoint.js';
import { TelegramAdapter, type TelegramUpdate } from './telegram.js';
import { captureTuiSnapshot } from './tui/model.js';
import { OPENPROJECTS_VERSION } from './version.js';

const MAX_BACKGROUND_OPERATIONS = 32;
const MAX_ACTIVE_SSE_STREAMS = 16;
const CORE_4G_MAX_ACTIVE_SSE_STREAMS = 4;
const RUN_EVENT_PAGE_SIZE = 128;
const MAX_SSE_FRAME_BYTES = 1_000_000;
const MAX_SSE_QUEUED_BYTES = 2_000_000;
const MAX_BUFFERED_LIVE_EVENTS = 512;
const SSE_DRAIN_TIMEOUT_MS = 5_000;
const CORPORATE_SYNC_PAGE_FIELDS = new Set([
  'workspaceId',
  'source',
  'sourceAccountId',
  'stream',
  'previousCursor',
  'cursor',
  'sourceWatermark',
  'records',
]);
const CORPORATE_RECORD_FIELDS = new Set([
  'externalId',
  'domain',
  'recordType',
  'projectId',
  'title',
  'content',
  'sourceUrl',
  'sourceVersion',
  'occurredAt',
  'sourceUpdatedAt',
  'status',
  'metadata',
]);
const CORPORATE_EMBEDDING_BACKFILL_FIELDS = new Set([
  'workspaceId',
  'source',
  'limit',
]);

interface ServerRuntimeState {
  auth: ControlAuthenticator | undefined;
  ready: boolean;
  operations: Set<Promise<void>>;
  streams: Set<ServerResponse>;
  maxActiveStreams: number;
}

export interface StartServerOptions {
  /** May reduce, but never raise, the built-in connection ceiling. */
  maxActiveStreams?: number;
}

export interface StartedServer {
  server: Server;
  transport: 'tcp' | 'unix';
  url: string;
  socketPath?: string;
  recoveredRunIds: string[];
  scheduler?: DeadlineScheduler;
  close(): Promise<void>;
}

export async function startServer(
  app: OpenProjectsApp,
  options: StartServerOptions = {},
): Promise<StartedServer> {
  const configuredSocketPath = app.config.server.socketPath;
  if (configuredSocketPath && app.config.telegram?.enabled === true) {
    throw new Error(
      'Telegram webhook ingress cannot use the private Unix control socket; configure loopback TCP behind a reviewed TLS reverse proxy',
    );
  }
  if (!configuredSocketPath && !isLoopbackHostname(app.config.server.host)) {
    throw new Error(
      `Refusing to expose the OpenProjects control plane on ${app.config.server.host}. `
        + 'Bind to a loopback address and use an SSH tunnel for remote administration.',
    );
  }
  const telegram = new TelegramAdapter(app);
  const state: ServerRuntimeState = {
    auth: app.config.server.auth ? loadControlAuthenticator(app.config.server.auth) : undefined,
    ready: false,
    operations: new Set(),
    streams: new Set(),
    maxActiveStreams: activeStreamLimit(app, options.maxActiveStreams),
  };
  const scheduler = telegram.enabled && app.config.notifications?.enabled !== false
    ? new DeadlineScheduler({
        storage: app.storage,
        sender: (destination, body, signal) => telegram.sendNotification(destination, body, signal),
        intervalMs: app.config.notifications?.intervalMs ?? 60_000,
        lookaheadHours: app.config.notifications?.lookaheadHours ?? 48,
        onError: (error) => console.error('Deadline scheduler:', error),
      })
    : undefined;
  const server = createServer((request, response) => {
    if (!state.ready) {
      securityHeaders(response);
      json(response, 503, { error: 'OpenProjects is recovering durable work and is not ready yet' });
      return;
    }
    void route(app, telegram, scheduler, state, request, response).catch((error) => {
      if (response.headersSent) {
        response.end();
        return;
      }
      const status = error instanceof HttpError
        ? error.status
        : error instanceof RunAdmissionError
          ? 429
        : error instanceof ApprovalCursorError
          ? 400
        : error instanceof ApprovalDecisionConflictError || error instanceof ApprovalArgumentIntegrityError
          ? 409
        : error instanceof CorporateSourceConflictError
          ? 409
          : 500;
      json(response, status, {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });
  let socketLease: UnixSocketLease | undefined;
  if (configuredSocketPath) {
    socketLease = await listenOnUnixSocket(server, configuredSocketPath);
  } else {
    await new Promise<void>((resolvePromise, reject) => {
      server.once('error', reject);
      server.listen(app.config.server.port, app.config.server.host, () => {
        server.off('error', reject);
        resolvePromise();
      });
    });
  }
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : app.config.server.port;
  const configuredHost = app.config.server.host;
  const host = configuredHost === '0.0.0.0' || configuredHost === '::' || configuredHost === '[::]'
    ? '127.0.0.1'
    : configuredHost;
  const urlHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  let recoveredRunIds: string[];
  try {
    recoveredRunIds = (await app.recover()).map((outcome) => outcome.run.id);
    // Scheduler recovery is synchronous inside start(). Keep it inside the
    // listener cleanup boundary so a corrupt notification ledger cannot leave
    // an orphaned control socket behind.
    if (scheduler) void scheduler.start();
    state.ready = true;
  } catch (error) {
    if (socketLease) {
      await closeUnixSocketServer(server, socketLease).catch(() => undefined);
    } else {
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    }
    throw error;
  }
  return {
    server,
    transport: socketLease ? 'unix' : 'tcp',
    url: socketLease ? 'http://localhost' : `http://${urlHost}:${port}`,
    ...(socketLease ? { socketPath: socketLease.socketPath } : {}),
    recoveredRunIds,
    ...(scheduler ? { scheduler } : {}),
    async close() {
      state.ready = false;
      const teardownErrors: unknown[] = [];
      const attempt = async (operation: () => void | Promise<void>): Promise<void> => {
        try {
          await operation();
        } catch (error) {
          teardownErrors.push(error);
        }
      };

      // Disable new deadline ticks and let a claimed delivery settle before
      // aborting Telegram. Even if durable ambiguity classification fails,
      // the scheduler has already barred late storage writes; the remaining
      // transport and socket cleanup must still run.
      await attempt(async () => {
        const schedulerStop = await scheduler?.stop();
        if (schedulerStop && !schedulerStop.settled) {
          console.error(
            'Deadline scheduler shutdown timed out; the claimed notification was recorded with unknown outcome',
          );
        }
      });
      await attempt(() => telegram.close());
      for (const stream of state.streams) {
        await attempt(() => { stream.end(); });
      }
      await attempt(async () => {
        if (socketLease) {
          await closeUnixSocketServer(server, socketLease);
        } else {
          await new Promise<void>((resolvePromise, reject) => {
            server.close((error) => (error ? reject(error) : resolvePromise()));
          });
        }
      });
      const operations = await Promise.allSettled([...state.operations]);
      for (const operation of operations) {
        if (operation.status === 'rejected') teardownErrors.push(operation.reason);
      }
      if (teardownErrors.length === 1) throw teardownErrors[0];
      if (teardownErrors.length > 1) {
        throw new AggregateError(teardownErrors, 'OpenProjects service teardown encountered multiple errors');
      }
    },
  };
}

async function route(
  app: OpenProjectsApp,
  telegram: TelegramAdapter,
  scheduler: DeadlineScheduler | undefined,
  state: ServerRuntimeState,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  securityHeaders(response);
  const method = request.method ?? 'GET';
  const url = new URL(request.url ?? '/', 'http://localhost');
  const path = url.pathname;
  const principal = path.startsWith('/api/')
    ? authenticateControlRequest(state.auth, request, response)
    : undefined;

  if (method === 'GET' && path === '/health') {
    json(response, 200, {
      status: 'ok',
      version: OPENPROJECTS_VERSION,
      model: { provider: app.config.model.provider, model: app.config.model.model },
      plugins: app.kernel.listPlugins(),
      telegram: telegram.enabled ? 'configured-external-transport' : 'disabled',
      privacy: app.networkPolicy.localOnly ? 'local-only' : 'unrestricted',
      learning: app.config.learning?.enabled === false ? 'disabled' : 'enabled',
      embeddings: app.embedding.id,
      transcription: app.transcriber.id,
      modelRouter: app.modelRouter ? 'enabled' : 'single-route',
      scheduler: scheduler?.running ? 'running' : 'disabled',
      integrations: app.integrations.length,
      oracle: 'enabled',
    });
    return;
  }
  if (method === 'GET' && path === '/api/meta') {
    requireControlCapability(principal, 'read');
    const { system: _system, ...publicAgent } = app.runtime.agent;
    json(response, 200, {
      version: OPENPROJECTS_VERSION,
      agent: publicAgent,
      model: { provider: app.config.model.provider, model: app.config.model.model },
      policy: app.config.policy,
      privacy: {
        localOnly: app.networkPolicy.localOnly,
        allowlistedOriginCount: app.networkPolicy.allowedOrigins.length,
        telegramExternalTransport: app.config.telegram?.enabled === true,
      },
      skills: app.skills.map(({ instructions: _instructions, ...skill }) => skill),
      tools: app.kernel.listTools().map((tool) => ({
        name: tool.name,
        description: tool.description,
        effect: tool.effect,
        idempotency: tool.idempotency,
        inputSchema: tool.inputSchema,
      })),
      plugins: app.kernel.listPlugins(),
      integrations: app.integrations.map(({ workspaces: _workspaces, mode: _mode, ...integration }) => integration),
      modelRoutes: app.config.routing?.routes.map((route) => ({
        id: route.id,
        provider: route.provider,
        model: route.model,
        tasks: route.tasks,
        local: route.local,
        enabled: route.enabled,
        quality: route.quality,
        inputCostPerMillion: route.inputCostPerMillion,
        outputCostPerMillion: route.outputCostPerMillion,
        contextWindow: route.contextWindow,
      })) ?? [],
      subagents: app.subagents.list().map(({ system: _system, ...publicSubagent }) => publicSubagent),
      learning: {
        enabled: app.config.learning?.enabled !== false,
        embedding: app.embedding.id,
        transcription: app.transcriber.id,
      },
    });
    return;
  }
  if (method === 'GET' && path === '/api/whoami') {
    requireControlCapability(principal, 'read');
    json(response, 200, principal
      ? {
          authenticated: true,
          id: principal.id,
          capabilities: principal.capabilities,
          workspaces: principal.workspaces ?? 'all',
        }
      : {
          authenticated: false,
          id: 'legacy-unauthenticated',
          capabilities: ['admin'],
          workspaces: 'all',
        });
    return;
  }
  if (method === 'GET' && path === '/api/tui/snapshot') {
    const workspaceId = boundedIdentifier(url.searchParams.get('workspaceId') ?? 'local', 'workspaceId');
    requireControlCapability(principal, 'read');
    requireControlWorkspace(principal, workspaceId);
    const approvalLimit = boundedInteger(url.searchParams.get('approvalLimit'), 100, 1, 200);
    const approvalCursor = url.searchParams.get('approvalCursor') ?? undefined;
    const snapshot = captureTuiSnapshot(app, workspaceId, {
      approvalLimit,
      ...(approvalCursor ? { approvalCursor } : {}),
    });
    json(response, 200, {
      ...snapshot,
      control: principal
        ? {
            authenticated: true,
            principalId: principal.id,
            capabilities: principal.capabilities,
            workspaceScope: principal.workspaces === undefined ? 'all' : 'scoped',
          }
        : {
            authenticated: false,
            principalId: 'legacy-unauthenticated',
            capabilities: ['admin'],
            workspaceScope: 'all',
          },
    } as unknown as JsonValue);
    return;
  }
  if (method === 'GET' && path === '/api/projects') {
    const workspaceId = boundedIdentifier(url.searchParams.get('workspaceId') ?? 'local', 'workspaceId');
    requireControlCapability(principal, 'read');
    requireControlWorkspace(principal, workspaceId);
    const projects = app.storage.listProjects(workspaceId).map((project) => ({
      ...project,
      tasks: app.storage.listTasks(project.id, workspaceId),
      evidence: app.storage.listEvidence(project.id, workspaceId),
    }));
    json(response, 200, { projects });
    return;
  }
  if (method === 'GET' && path === '/api/memories') {
    const workspaceId = boundedIdentifier(url.searchParams.get('workspaceId') ?? 'local', 'workspaceId');
    requireControlCapability(principal, 'read');
    requireControlWorkspace(principal, workspaceId);
    const projectId = url.searchParams.get('projectId') ?? undefined;
    json(response, 200, { memories: app.storage.listMemories(workspaceId, projectId) });
    return;
  }
  if (method === 'POST' && path === '/api/oracle/embeddings/backfill') {
    const body = await readJson(request, 64_000);
    assertExactObjectFields(
      body,
      CORPORATE_EMBEDDING_BACKFILL_FIELDS,
      'Corporate embedding backfill',
    );
    const workspaceId = boundedIdentifier(optionalString(body, 'workspaceId') ?? 'local', 'workspaceId');
    requireControlCapability(principal, 'admin');
    requireControlWorkspace(principal, workspaceId);
    const source = optionalString(body, 'source');
    const limit = body.limit;
    if (limit !== undefined && (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 100)) {
      throw new HttpError(400, 'limit must be an integer between 1 and 100');
    }
    try {
      const result = await app.oracle.backfillEmbeddings({
        workspaceId,
        ...(source ? { source } : {}),
        ...(typeof limit === 'number' ? { limit } : {}),
      });
      json(response, 200, {
        schema: 'openprojects.oracle-embedding-backfill.v1',
        ...result,
        actionTaken: result.stored > 0,
        agentRunInvoked: false,
        chatModelInvoked: false,
      });
    } catch (error) {
      throw new HttpError(400, error instanceof Error ? error.message : 'Invalid corporate embedding backfill');
    }
    return;
  }
  if (method === 'POST' && path === '/api/oracle/sync') {
    const body = await readJson(request, 2_000_000);
    assertExactObjectFields(body, CORPORATE_SYNC_PAGE_FIELDS, 'Corporate sync page');
    const workspaceId = boundedIdentifier(optionalString(body, 'workspaceId') ?? 'local', 'workspaceId');
    requireControlCapability(principal, 'ingest');
    requireControlWorkspace(principal, workspaceId);
    const claimedSource = optionalString(body, 'source');
    const source = principal?.id ?? (claimedSource ? boundedIdentifier(claimedSource, 'source') : undefined);
    if (!source) throw new HttpError(400, 'source is required when control authentication is disabled');
    if (principal && claimedSource && claimedSource !== principal.id) {
      throw new HttpError(403, 'Authenticated connector source is bound to its control principal ID');
    }
    const rawRecords = body.records;
    if (!Array.isArray(rawRecords)) throw new HttpError(400, 'records must be an array');
    const records = rawRecords.map((record, index) => corporateRecordInput(record, index));
    const previousCursor = optionalString(body, 'previousCursor');
    const cursor = optionalString(body, 'cursor');
    const sourceWatermark = optionalString(body, 'sourceWatermark');
    try {
      const result = await app.oracle.ingestBatch({
        workspaceId,
        source,
        sourceAccountId: requiredString(body, 'sourceAccountId'),
        stream: requiredString(body, 'stream'),
        ingestedBy: principal?.id ?? 'legacy-loopback',
        ...(previousCursor ? { previousCursor } : {}),
        ...(cursor ? { cursor } : {}),
        ...(sourceWatermark ? { sourceWatermark } : {}),
        records,
      });
      json(response, 201, corporateIngestReceipt(result));
    } catch (error) {
      if (error instanceof CorporateSourceConflictError) throw error;
      throw new HttpError(400, error instanceof Error ? error.message : 'Invalid corporate sync page');
    }
    return;
  }
  if (method === 'GET' && path === '/api/oracle/search') {
    const workspaceId = boundedIdentifier(url.searchParams.get('workspaceId') ?? 'local', 'workspaceId');
    requireControlCapability(principal, 'read');
    requireControlWorkspace(principal, workspaceId);
    const query = url.searchParams.get('q');
    if (!query) throw new HttpError(400, 'q is required');
    try {
      const result = await app.oracle.search({
        workspaceId,
        query,
        ...(url.searchParams.get('projectId') ? { projectId: url.searchParams.get('projectId')! } : {}),
        ...(url.searchParams.get('source') ? { source: url.searchParams.get('source')! } : {}),
        ...(url.searchParams.get('domain')
          ? { domain: url.searchParams.get('domain')! as CorporateRecordInput['domain'] }
          : {}),
        ...(url.searchParams.get('asOf') ? { asOf: url.searchParams.get('asOf')! } : {}),
        ...(url.searchParams.get('knownAt') ? { knownAt: url.searchParams.get('knownAt')! } : {}),
        limit: boundedInteger(url.searchParams.get('limit'), 8, 1, 20),
      });
      json(response, 200, corporateSearchReceipt(result));
    } catch (error) {
      throw new HttpError(400, error instanceof Error ? error.message : 'Invalid corporate search');
    }
    return;
  }
  if (method === 'GET' && path === '/api/oracle/sources') {
    const workspaceId = boundedIdentifier(url.searchParams.get('workspaceId') ?? 'local', 'workspaceId');
    requireControlCapability(principal, 'read');
    requireControlWorkspace(principal, workspaceId);
    json(response, 200, { sources: app.oracle.listSources(workspaceId) } as unknown as JsonValue);
    return;
  }
  if (method === 'GET' && path === '/api/oracle/checkpoint') {
    const workspaceId = boundedIdentifier(url.searchParams.get('workspaceId') ?? 'local', 'workspaceId');
    requireControlCapability(principal, 'ingest');
    requireControlWorkspace(principal, workspaceId);
    const claimedSource = url.searchParams.get('source') ?? undefined;
    const source = principal?.id ?? claimedSource;
    if (!source) throw new HttpError(400, 'source is required when control authentication is disabled');
    if (principal && claimedSource && claimedSource !== principal.id) {
      throw new HttpError(403, 'Authenticated connector source is bound to its control principal ID');
    }
    const stream = url.searchParams.get('stream');
    if (!stream) throw new HttpError(400, 'stream is required');
    let checkpoint;
    try {
      checkpoint = app.oracle.getCheckpoint(workspaceId, source, stream);
    } catch (error) {
      throw new HttpError(400, error instanceof Error ? error.message : 'Invalid corporate checkpoint query');
    }
    json(response, 200, { checkpoint: checkpoint ?? null } as unknown as JsonValue);
    return;
  }
  const oracleHistoryMatch = path.match(/^\/api\/oracle\/records\/([^/]+)\/history$/);
  if (method === 'GET' && oracleHistoryMatch?.[1]) {
    const workspaceId = boundedIdentifier(url.searchParams.get('workspaceId') ?? 'local', 'workspaceId');
    requireControlCapability(principal, 'read');
    requireControlWorkspace(principal, workspaceId);
    const limit = boundedInteger(url.searchParams.get('limit'), 100, 1, 100);
    json(response, 200, {
      records: app.storage.listCorporateRecordHistory(decodeURIComponent(oracleHistoryMatch[1]), workspaceId, limit),
    } as unknown as JsonValue);
    return;
  }
  const oracleSourceDataMatch = path.match(/^\/api\/oracle\/sources\/([^/]+)\/data$/);
  if (method === 'DELETE' && oracleSourceDataMatch?.[1]) {
    const workspaceId = boundedIdentifier(url.searchParams.get('workspaceId') ?? 'local', 'workspaceId');
    requireControlCapability(principal, 'admin');
    requireControlWorkspace(principal, workspaceId);
    try {
      json(response, 200, app.oracle.forgetSource(
        workspaceId,
        decodeURIComponent(oracleSourceDataMatch[1]),
        url.searchParams.get('stream') ?? undefined,
      ));
    } catch (error) {
      throw new HttpError(400, error instanceof Error ? error.message : 'Invalid corporate source deletion');
    }
    return;
  }
  const memoryStatusMatch = path.match(/^\/api\/memories\/([^/]+)\/status$/);
  if (method === 'POST' && memoryStatusMatch?.[1]) {
    const body = await readJson(request);
    const workspaceId = boundedIdentifier(optionalString(body, 'workspaceId') ?? 'local', 'workspaceId');
    requireControlCapability(principal, 'admin');
    requireControlWorkspace(principal, workspaceId);
    const status = requiredString(body, 'status');
    if (status !== 'active' && status !== 'proposed' && status !== 'archived') {
      throw new HttpError(400, 'status must be active, proposed, or archived');
    }
    const result = await app.memoryEngine.setStatus(
      memoryStatusMatch[1],
      workspaceId,
      status,
    );
    json(response, 200, {
      ...result.memory,
      embeddingStatus: result.embedding,
      ...(result.embeddingError ? { embeddingError: result.embeddingError } : {}),
    } as unknown as JsonValue);
    return;
  }
  if (method === 'GET' && path === '/api/groups') {
    const workspaceId = boundedIdentifier(url.searchParams.get('workspaceId') ?? 'local', 'workspaceId');
    requireControlCapability(principal, 'read');
    requireControlWorkspace(principal, workspaceId);
    json(response, 200, { groups: app.storage.listGroupSpaces(workspaceId) });
    return;
  }
  const groupDataMatch = path.match(/^\/api\/groups\/([^/]+)\/data$/);
  if (method === 'DELETE' && groupDataMatch?.[1]) {
    requireControlCapability(principal, 'admin');
    const group = app.storage.getGroupSpace(groupDataMatch[1]);
    requireControlResourceWorkspace(principal, group.workspaceId);
    json(response, 200, app.storage.forgetGroupData(groupDataMatch[1]));
    return;
  }
  if (method === 'POST' && path === '/api/groups') {
    const body = await readJson(request);
    const workspaceId = boundedIdentifier(optionalString(body, 'workspaceId') ?? 'local', 'workspaceId');
    requireControlCapability(principal, 'admin');
    requireControlWorkspace(principal, workspaceId);
    // External group identifiers live in a provider-global namespace. Binding
    // or rebinding one therefore requires a global administrator even though
    // subsequent reads/deletion remain workspace-scoped.
    requireGlobalControlScope(principal);
    const projectId = optionalString(body, 'projectId');
    const title = optionalString(body, 'title');
    if (projectId && !app.storage.getProject(projectId, workspaceId)) throw new HttpError(404, 'Project not found');
    const group = app.storage.upsertGroupSpace({
      workspaceId,
      source: requiredString(body, 'source'),
      externalId: requiredString(body, 'externalId'),
      ...(title ? { title } : {}),
      ...(projectId ? { projectId } : {}),
      learningEnabled: body.learningEnabled === true,
      notificationsEnabled: body.notificationsEnabled === true,
      createdBy: mutationActor(principal, body, 'createdBy', 'local-operator'),
    });
    json(response, 201, group as unknown as JsonValue);
    return;
  }
  if (method === 'GET' && path === '/api/learning/stats') {
    const workspaceId = boundedIdentifier(url.searchParams.get('workspaceId') ?? 'local', 'workspaceId');
    requireControlCapability(principal, 'read');
    requireControlWorkspace(principal, workspaceId);
    json(response, 200, app.storage.learningStats(workspaceId));
    return;
  }
  if (method === 'POST' && path === '/api/learning/purge') {
    const body = await readJson(request);
    const retentionDays = typeof body.retentionDays === 'number'
      ? body.retentionDays
      : app.config.learning?.retentionDays ?? 180;
    const workspaceId = optionalString(body, 'workspaceId');
    requireControlCapability(principal, 'admin');
    if (workspaceId) requireControlWorkspace(principal, boundedIdentifier(workspaceId, 'workspaceId'));
    else requireGlobalControlScope(principal);
    const result = app.memoryEngine.purgeExpired({
      retentionDays,
      ...(workspaceId ? { workspaceId } : {}),
    });
    json(response, 200, result as unknown as JsonValue);
    return;
  }
  if (method === 'GET' && path === '/api/learning/export') {
    requireControlCapability(principal, 'admin');
    requireGlobalControlScope(principal);
    const rawKinds = url.searchParams.get('kinds');
    const kinds = rawKinds ? rawKinds.split(',') as LearningDatasetKind[] : undefined;
    const exported = exportLearningDatasets(app.storage, {
      ...(kinds ? { kinds } : {}),
      includeComments: url.searchParams.get('includeComments') !== 'false',
    });
    json(response, 200, exported as unknown as JsonValue);
    return;
  }
  if (method === 'GET' && path === '/api/notifications') {
    const workspaceId = boundedIdentifier(url.searchParams.get('workspaceId') ?? 'local', 'workspaceId');
    requireControlCapability(principal, 'read');
    requireControlWorkspace(principal, workspaceId);
    json(response, 200, { notifications: app.storage.listNotifications(workspaceId) });
    return;
  }
  if (method === 'POST' && path === '/api/notifications/tick') {
    requireControlCapability(principal, 'admin');
    requireGlobalControlScope(principal);
    if (!scheduler) throw new HttpError(409, 'Telegram scheduler is not configured');
    await scheduler.tick();
    json(response, 200, { notifications: app.storage.listNotifications('local', undefined, 50) });
    return;
  }
  if (method === 'GET' && path === '/api/runs') {
    const workspaceId = boundedIdentifier(url.searchParams.get('workspaceId') ?? 'local', 'workspaceId');
    requireControlCapability(principal, 'read');
    requireControlWorkspace(principal, workspaceId);
    const limit = boundedInteger(url.searchParams.get('limit'), 50, 1, 200);
    json(response, 200, { runs: app.storage.listRuns(workspaceId, limit) });
    return;
  }
  if (method === 'POST' && path === '/api/runs') {
    const body = await readJson(request);
    const workspaceId = boundedIdentifier(optionalString(body, 'workspaceId') ?? 'local', 'workspaceId');
    requireControlCapability(principal, 'run');
    requireControlWorkspace(principal, workspaceId);
    const message = requiredString(body, 'message');
    const projectId = optionalString(body, 'projectId');
    const sessionId = optionalString(body, 'sessionId');
    const outcome = await app.runtime.start({
      message,
      workspaceId,
      actorId: mutationActor(principal, body, 'actorId', 'local-user'),
      ...(projectId ? { projectId } : {}),
      ...(sessionId ? { sessionId } : {}),
      channel: 'web',
    });
    json(response, outcome.run.status === 'waiting_for_approval' ? 202 : 201, outcome as unknown as JsonValue);
    return;
  }
  if (method === 'POST' && path === '/api/runs/async') {
    const body = await readJson(request);
    const workspaceId = boundedIdentifier(optionalString(body, 'workspaceId') ?? 'local', 'workspaceId');
    requireControlCapability(principal, 'run');
    requireControlWorkspace(principal, workspaceId);
    assertBackgroundCapacity(state);
    const projectId = optionalString(body, 'projectId');
    const sessionId = optionalString(body, 'sessionId');
    const started = app.runtime.startAsync({
      message: requiredString(body, 'message'),
      workspaceId,
      actorId: mutationActor(principal, body, 'actorId', 'local-user'),
      ...(projectId ? { projectId } : {}),
      ...(sessionId ? { sessionId } : {}),
      channel: 'tui',
    });
    trackBackgroundOperation(state, started.completion, 'asynchronous run');
    json(response, 202, runAcceptance(app.storage.getRun(started.run.id)));
    return;
  }
  const runMatch = path.match(/^\/api\/runs\/([^/]+)$/);
  if (method === 'GET' && runMatch?.[1]) {
    requireControlCapability(principal, 'read');
    const outcome = app.runtime.outcome(runMatch[1]);
    requireControlResourceWorkspace(principal, outcome.run.workspaceId);
    json(response, 200, {
      ...outcome,
      snapshotDocuments: app.storage.getRunSnapshots(runMatch[1]) ?? null,
      feedback: app.storage.listFeedback(runMatch[1]),
      invocations: app.storage.listToolInvocationsForRun(runMatch[1]),
    } as unknown as JsonValue);
    return;
  }
  const streamMatch = path.match(/^\/api\/runs\/([^/]+)\/events\/stream$/);
  if (method === 'GET' && streamMatch?.[1]) {
    requireControlCapability(principal, 'read');
    const run = app.storage.getRun(streamMatch[1]);
    requireControlResourceWorkspace(principal, run.workspaceId);
    const afterSeq = runEventCursor(request, url);
    await streamRun(app, state, streamMatch[1], afterSeq, response);
    return;
  }
  const feedbackMatch = path.match(/^\/api\/runs\/([^/]+)\/feedback$/);
  if (method === 'POST' && feedbackMatch?.[1]) {
    const body = await readJson(request);
    requireControlCapability(principal, 'run');
    const run = app.storage.getRun(feedbackMatch[1]);
    requireControlResourceWorkspace(principal, run.workspaceId);
    const reaction = optionalString(body, 'reaction');
    const comment = optionalString(body, 'comment');
    const correction = optionalString(body, 'correction');
    const dimensions = isObject(body.dimensions)
      ? Object.fromEntries(Object.entries(body.dimensions).filter((entry): entry is [string, number] => typeof entry[1] === 'number'))
      : undefined;
    const feedback = app.runtime.addFeedback(feedbackMatch[1], {
      actorId: mutationActor(principal, body, 'actorId', 'local-user'),
      ...(reaction ? { reaction } : {}),
      ...(typeof body.score === 'number' ? { score: body.score } : {}),
      ...(dimensions ? { dimensions } : {}),
      ...(comment ? { comment } : {}),
      ...(correction ? { correction } : {}),
    });
    json(response, 201, feedback as unknown as JsonValue);
    return;
  }
  const approvalMatch = path.match(/^\/api\/approvals\/([^/]+)$/);
  if (method === 'POST' && approvalMatch?.[1]) {
    const body = await readJson(request);
    requireControlCapability(principal, 'approve');
    // Exact approval requires the same read authority used to inspect the run,
    // tool invocation, and destination. An approve-only bearer must not become
    // a side channel for run input/output and traces.
    requireControlCapability(principal, 'read');
    const approval = app.storage.getApproval(approvalMatch[1]);
    const run = app.storage.getRun(approval.runId);
    requireControlResourceWorkspace(principal, run.workspaceId);
    const decision = requiredString(body, 'decision');
    if (decision !== 'approve' && decision !== 'reject') throw new HttpError(400, 'decision must be approve or reject');
    const argumentsDigest = reviewedApprovalDigest(body, approval, decision);
    const outcome = await app.runtime.resolveApproval(
      approvalMatch[1],
      decision,
      mutationActor(principal, body, 'actorId', 'local-user'),
      optionalString(body, 'reason'),
      principal ? { trustedOperator: true } : undefined,
      argumentsDigest,
    );
    json(response, 200, outcome as unknown as JsonValue);
    return;
  }
  const asyncApprovalMatch = path.match(/^\/api\/approvals\/([^/]+)\/async$/);
  if (method === 'POST' && asyncApprovalMatch?.[1]) {
    const body = await readJson(request);
    requireControlCapability(principal, 'approve');
    requireControlCapability(principal, 'read');
    assertBackgroundCapacity(state);
    const approval = app.storage.getApproval(asyncApprovalMatch[1]);
    const run = app.storage.getRun(approval.runId);
    requireControlResourceWorkspace(principal, run.workspaceId);
    const decision = requiredString(body, 'decision');
    if (decision !== 'approve' && decision !== 'reject') throw new HttpError(400, 'decision must be approve or reject');
    const argumentsDigest = reviewedApprovalDigest(body, approval, decision);
    const started = app.runtime.resolveApprovalAsync(
      asyncApprovalMatch[1],
      decision,
      mutationActor(principal, body, 'actorId', 'local-user'),
      optionalString(body, 'reason'),
      principal ? { trustedOperator: true } : undefined,
      argumentsDigest,
    );
    trackBackgroundOperation(state, started.completion, 'asynchronous approval resolution');
    json(response, 202, runAcceptance(started.run));
    return;
  }
  if (method === 'GET' && path === '/api/approvals') {
    requireControlCapability(principal, 'read');
    const workspaceId = boundedIdentifier(url.searchParams.get('workspaceId') ?? 'local', 'workspaceId');
    requireControlWorkspace(principal, workspaceId);
    const status = url.searchParams.get('status');
    if (status && status !== 'pending' && status !== 'approved' && status !== 'rejected') {
      throw new HttpError(400, 'status must be pending, approved, or rejected');
    }
    const typedStatus = status as 'pending' | 'approved' | 'rejected' | null;
    const limit = boundedInteger(url.searchParams.get('limit'), 50, 1, 200);
    const cursor = url.searchParams.get('cursor') ?? undefined;
    const page = app.storage.listApprovalsPage({
      workspaceId,
      limit,
      ...(typedStatus ? { status: typedStatus } : {}),
      ...(cursor ? { cursor } : {}),
    });
    json(response, 200, {
      approvals: page.approvals,
      page: {
        limit,
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      },
    });
    return;
  }
  if (method === 'GET' && path === '/api/events/stream') {
    const workspaceId = boundedIdentifier(url.searchParams.get('workspaceId') ?? 'local', 'workspaceId');
    requireControlCapability(principal, 'read');
    requireControlWorkspace(principal, workspaceId);
    await streamWorkspace(app, state, workspaceId, response);
    return;
  }
  if (method === 'POST' && path === '/api/events') {
    const body = await readJson(request);
    const workspaceId = boundedIdentifier(optionalString(body, 'workspaceId') ?? 'local', 'workspaceId');
    requireControlCapability(principal, 'run');
    requireControlWorkspace(principal, workspaceId);
    const source = controlEventSource(principal, requiredString(body, 'source'));
    const outcome = await app.runtime.ingestEvent({
      source,
      dedupeKey: requiredString(body, 'dedupeKey'),
      type: requiredString(body, 'type'),
      workspaceId,
      actorId: mutationActor(principal, body, 'actorId', 'event-system'),
      ...(optionalString(body, 'projectId') ? { projectId: optionalString(body, 'projectId') } : {}),
      payload: isObject(body.payload) ? body.payload : {},
      ...(optionalString(body, 'occurredAt') ? { occurredAt: optionalString(body, 'occurredAt') } : {}),
    } as InboundEvent);
    json(response, outcome.duplicate ? 200 : 201, inboundEventReceipt(outcome));
    return;
  }
  if (method === 'GET' && path === '/api/feedback/export') {
    requireControlCapability(principal, 'admin');
    requireGlobalControlScope(principal);
    const format = url.searchParams.get('format') ?? 'rewards';
    const exported = exportLearningDatasets(app.storage, {
      kinds: ['rewards'],
      includeComments: false,
    });
    if (format === 'jsonl') {
      response.statusCode = 200;
      response.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
      response.end(exported.datasets[0]?.jsonl ?? '');
      return;
    }
    json(response, 200, exported as unknown as JsonValue);
    return;
  }
  if (method === 'POST' && path === '/webhooks/telegram') {
    const header = request.headers['x-telegram-bot-api-secret-token'];
    if (!telegram.authenticates(typeof header === 'string' ? header : undefined)) {
      throw new HttpError(404, 'Not found');
    }
    const update = await readJson(request, 2_000_000) as unknown as TelegramUpdate;
    assertBackgroundCapacity(state);
    const handling = telegram.handle(update);
    trackBackgroundOperation(state, handling, 'Telegram update');
    json(response, 202, { accepted: true });
    return;
  }
  if (method === 'GET' || method === 'HEAD') {
    if (serveStatic(path, method, response)) return;
  }
  throw new HttpError(404, 'Not found');
}

async function streamRun(
  app: OpenProjectsApp,
  state: ServerRuntimeState,
  runId: string,
  afterSeq: number,
  response: ServerResponse,
): Promise<void> {
  // Validate the run and cursor before allocating a long-lived response/listener.
  app.storage.getRun(runId);
  const latestBeforeSubscription = app.storage.latestEventSeqForRun(runId) ?? -1;
  if (afterSeq > latestBeforeSubscription) {
    throw new HttpError(400, 'Run event cursor is ahead of the durable event history');
  }
  assertStreamCapacity(state);
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  });
  state.streams.add(response);
  const writer = new BoundedSseWriter(response);
  const buffered = new Map<number, { event: HarnessEvent; bytes: number }>();
  let bufferedBytes = 0;
  let replaying = true;
  let pumping = false;
  let cleaned = false;
  let lastSentSeq = afterSeq;
  let terminalDelivered = false;
  let heartbeat: NodeJS.Timeout | undefined;
  let unsubscribe = (): void => undefined;

  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    if (heartbeat) clearInterval(heartbeat);
    unsubscribe();
    buffered.clear();
    bufferedBytes = 0;
    state.streams.delete(response);
  };
  const finish = async (): Promise<void> => {
    cleanup();
    await writer.end();
  };
  const failSlowConsumer = (): void => {
    cleanup();
    writer.abort();
  };
  const pumpLive = async (): Promise<void> => {
    if (pumping || replaying || cleaned) return;
    pumping = true;
    try {
      while (!cleaned && buffered.size) {
        const nextSeq = Math.min(...buffered.keys());
        const pending = buffered.get(nextSeq);
        if (!pending) continue;
        buffered.delete(nextSeq);
        bufferedBytes -= pending.bytes;
        if (pending.event.seq <= lastSentSeq) continue;
        if (!await writer.send(pending.event.type, pending.event, pending.event.seq)) {
          cleanup();
          return;
        }
        lastSentSeq = pending.event.seq;
        if (terminalEvent(pending.event.type)) {
          terminalDelivered = true;
          await finish();
          return;
        }
      }
    } finally {
      pumping = false;
      if (!cleaned && !replaying && buffered.size) void pumpLive();
    }
  };
  const bufferLive = (event: HarnessEvent): void => {
    if (cleaned || event.runId !== runId || event.seq <= lastSentSeq || buffered.has(event.seq)) return;
    const bytes = Buffer.byteLength(JSON.stringify(event), 'utf8');
    if (
      bytes > MAX_SSE_FRAME_BYTES
      || buffered.size >= MAX_BUFFERED_LIVE_EVENTS
      || bufferedBytes + bytes > MAX_SSE_QUEUED_BYTES
    ) {
      failSlowConsumer();
      return;
    }
    buffered.set(event.seq, { event, bytes });
    bufferedBytes += bytes;
    if (!replaying) void pumpLive();
  };

  unsubscribe = app.runtime.subscribe(bufferLive);
  response.once('close', cleanup);

  // The fence is captured after subscribing. Events created while paged replay
  // waits for socket drain are buffered, then sequence-deduplicated at handoff.
  const replayFence = app.storage.latestEventSeqForRun(runId) ?? -1;
  while (!cleaned && lastSentSeq < replayFence) {
    const page = app.storage.eventsForRunPage(runId, {
      afterSeq: lastSentSeq,
      throughSeq: replayFence,
      limit: RUN_EVENT_PAGE_SIZE,
    });
    if (!page.length) break;
    for (const event of page) {
      if (!await writer.send(event.type, event, event.seq)) {
        cleanup();
        return;
      }
      lastSentSeq = event.seq;
      if (terminalEvent(event.type)) terminalDelivered = true;
    }
  }
  if (cleaned) return;

  const run = app.storage.getRun(runId);
  if (!await writer.send('run.snapshot', {
    run,
    approvals: app.storage.listApprovals(runId),
    cursor: lastSentSeq,
  })) {
    cleanup();
    return;
  }
  replaying = false;
  await pumpLive();
  if (cleaned) return;
  if (terminalDelivered || terminal(app.storage.getRun(runId).status)) {
    await finish();
    return;
  }
  heartbeat = setInterval(() => {
    void writer.comment('keep-alive').then((sent) => {
      if (!sent) cleanup();
    });
  }, 15_000);
}

async function streamWorkspace(
  app: OpenProjectsApp,
  state: ServerRuntimeState,
  workspaceId: string,
  response: ServerResponse,
): Promise<void> {
  assertStreamCapacity(state);
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  });
  state.streams.add(response);
  const writer = new BoundedSseWriter(response);
  let cleaned = false;
  let heartbeat: NodeJS.Timeout | undefined;
  let unsubscribe = (): void => undefined;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    if (heartbeat) clearInterval(heartbeat);
    unsubscribe();
    state.streams.delete(response);
  };
  response.once('close', cleanup);
  if (!await writer.send('workspace.ready', { workspaceId, generatedAt: new Date().toISOString() })) {
    cleanup();
    return;
  }
  heartbeat = setInterval(() => {
    void writer.comment('keep-alive').then((sent) => {
      if (!sent) cleanup();
    });
  }, 15_000);
  unsubscribe = app.runtime.subscribe((event) => {
    try {
      if (app.storage.getRun(event.runId).workspaceId !== workspaceId) return;
      // Workspace subscribers only need an invalidation cursor; they fetch a
      // fresh bounded snapshot instead of receiving arbitrary event payloads.
      void writer.send('workspace.changed', {
        workspaceId,
        runId: event.runId,
        seq: event.seq,
        changedAt: event.createdAt,
      }).then((sent) => {
        if (!sent) cleanup();
      });
    } catch {
      // Fail closed: never stream an event whose durable workspace cannot be verified.
    }
  });
}

function activeStreamLimit(app: OpenProjectsApp, requested: number | undefined): number {
  const configuredMaximum = app.config.resources?.profile === 'core-4g-v1'
    ? CORE_4G_MAX_ACTIVE_SSE_STREAMS
    : MAX_ACTIVE_SSE_STREAMS;
  if (requested === undefined) return configuredMaximum;
  if (!Number.isSafeInteger(requested) || requested < 1 || requested > configuredMaximum) {
    throw new Error(`maxActiveStreams must be an integer from 1 to ${configuredMaximum}`);
  }
  return requested;
}

function assertStreamCapacity(state: ServerRuntimeState): void {
  if (state.streams.size >= state.maxActiveStreams) {
    throw new HttpError(
      429,
      `Active event-stream capacity is full (${state.maxActiveStreams} maximum)`,
    );
  }
}

function runEventCursor(request: IncomingMessage, url: URL): number {
  const queryValues = url.searchParams.getAll('afterSeq');
  if (queryValues.length > 1) throw new HttpError(400, 'afterSeq must be specified at most once');
  const queryCursor = queryValues.length ? parseEventCursor(queryValues[0], 'afterSeq') : undefined;
  const rawHeader = request.headers['last-event-id'];
  if (Array.isArray(rawHeader)) throw new HttpError(400, 'Last-Event-ID must be a single value');
  const headerCursor = rawHeader === undefined || rawHeader === ''
    ? undefined
    : parseEventCursor(rawHeader, 'Last-Event-ID');
  if (queryCursor !== undefined && headerCursor !== undefined && queryCursor !== headerCursor) {
    throw new HttpError(400, 'afterSeq and Last-Event-ID must match when both are provided');
  }
  return queryCursor ?? headerCursor ?? -1;
}

function parseEventCursor(value: string | undefined, name: string): number {
  if (value === undefined || !/^(0|[1-9][0-9]{0,15})$/u.test(value)) {
    throw new HttpError(400, `${name} must be a non-negative safe integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new HttpError(400, `${name} must be a non-negative safe integer`);
  return parsed;
}

export interface BoundedSseWriterOptions {
  maxFrameBytes?: number;
  maxQueuedBytes?: number;
  drainTimeoutMs?: number;
}

/**
 * Serializes writes, honors Node response backpressure, and disconnects a
 * consumer before its in-process queue can grow without bound.
 */
export class BoundedSseWriter {
  readonly #maxFrameBytes: number;
  readonly #maxQueuedBytes: number;
  readonly #drainTimeoutMs: number;
  #tail: Promise<void> = Promise.resolve();
  #queuedBytes = 0;
  #closed = false;

  constructor(
    readonly response: ServerResponse,
    options: BoundedSseWriterOptions = {},
  ) {
    this.#maxFrameBytes = options.maxFrameBytes ?? MAX_SSE_FRAME_BYTES;
    this.#maxQueuedBytes = options.maxQueuedBytes ?? MAX_SSE_QUEUED_BYTES;
    this.#drainTimeoutMs = options.drainTimeoutMs ?? SSE_DRAIN_TIMEOUT_MS;
    response.once('close', () => { this.#closed = true; });
  }

  send(event: string, data: unknown, id?: number): Promise<boolean> {
    if (/[^\u0021-\u007e]/u.test(event) || event.includes(':')) {
      this.abort();
      return Promise.resolve(false);
    }
    const idLine = id === undefined ? '' : `id: ${id}\n`;
    return this.#enqueue(`${idLine}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  comment(value: string): Promise<boolean> {
    return this.#enqueue(`: ${value.replace(/[\r\n]/gu, ' ')}\n\n`);
  }

  async end(): Promise<void> {
    await this.#tail;
    if (this.#closed) return;
    this.#closed = true;
    if (!this.response.writableEnded && !this.response.destroyed) this.response.end();
  }

  abort(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (!this.response.destroyed) this.response.destroy();
  }

  #enqueue(frame: string): Promise<boolean> {
    if (this.#closed) return Promise.resolve(false);
    const bytes = Buffer.byteLength(frame, 'utf8');
    if (
      bytes > this.#maxFrameBytes
      || bytes > this.#maxQueuedBytes
      || this.#queuedBytes + bytes > this.#maxQueuedBytes
    ) {
      this.abort();
      return Promise.resolve(false);
    }
    this.#queuedBytes += bytes;
    const operation = this.#tail.then(() => this.#flush(frame));
    this.#tail = operation.catch(() => undefined);
    return operation
      .then(() => true, () => {
        this.abort();
        return false;
      })
      .finally(() => { this.#queuedBytes -= bytes; });
  }

  async #flush(frame: string): Promise<void> {
    if (this.#closed || this.response.destroyed || this.response.writableEnded) {
      throw new Error('SSE response is closed');
    }
    if (!this.response.write(frame)) await waitForResponseDrain(this.response, this.#drainTimeoutMs);
  }
}

function waitForResponseDrain(response: ServerResponse, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolvePromise, reject) => {
    const finish = (error?: Error): void => {
      clearTimeout(timeout);
      response.off('drain', onDrain);
      response.off('close', onClose);
      response.off('error', onError);
      if (error) reject(error);
      else resolvePromise();
    };
    const onDrain = (): void => finish();
    const onClose = (): void => finish(new Error('SSE response closed before draining'));
    const onError = (error: Error): void => finish(error);
    const timeout = setTimeout(
      () => finish(new Error('SSE response did not drain before its deadline')),
      timeoutMs,
    );
    response.once('drain', onDrain);
    response.once('close', onClose);
    response.once('error', onError);
  });
}

function serveStatic(path: string, method: string, response: ServerResponse): boolean {
  const publicRoot = resolve('public');
  const relative = path === '/' ? 'index.html' : path.replace(/^\//, '');
  if (relative.includes('..')) return false;
  const file = join(publicRoot, relative);
  if (!existsSync(file) || !statSync(file).isFile()) return false;
  response.statusCode = 200;
  response.setHeader('content-type', mimeType(extname(file)));
  response.setHeader('cache-control', relative === 'index.html' ? 'no-cache' : 'public, max-age=300');
  if (method === 'HEAD') {
    response.end();
  } else {
    createReadStream(file).pipe(response);
  }
  return true;
}

async function readJson(request: IncomingMessage, maxBytes = 1_000_000): Promise<JsonObject> {
  const contentType = request.headers['content-type'];
  if (typeof contentType !== 'string' || !contentType.toLocaleLowerCase().startsWith('application/json')) {
    throw new HttpError(415, 'Content-Type must be application/json');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += buffer.length;
    if (size > maxBytes) throw new HttpError(413, 'Request body too large');
    chunks.push(buffer);
  }
  try {
    const parsed = parseJsonRejectingDuplicateKeys(
      Buffer.concat(chunks).toString('utf8') || '{}',
    );
    if (!isObject(parsed)) throw new Error('body is not an object');
    return parsed;
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
}

function json(response: ServerResponse, status: number, value: JsonValue | object): void {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.end(JSON.stringify(value));
}

function securityHeaders(response: ServerResponse): void {
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('x-frame-options', 'DENY');
  response.setHeader('referrer-policy', 'no-referrer');
  response.setHeader(
    'content-security-policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'",
  );
}

function requiredString(input: JsonObject, key: string): string {
  const value = input[key];
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, `${key} is required`);
  return value;
}

function optionalString(input: JsonObject, key: string): string | undefined {
  const value = input[key];
  return typeof value === 'string' && value.length ? value : undefined;
}

function reviewedApprovalDigest(
  input: JsonObject,
  approval: { argumentsDigest?: string },
  decision: 'approve' | 'reject',
): string | undefined {
  const reviewed = optionalString(input, 'argumentsDigest');
  if (approval.argumentsDigest === undefined) {
    if (decision === 'approve') {
      throw new HttpError(409, 'Legacy approval has no bound argument digest and cannot be approved');
    }
    if (reviewed !== undefined) {
      throw new HttpError(409, 'Legacy approval does not have an argument digest to review');
    }
    return undefined;
  }
  if (reviewed === undefined) {
    throw new HttpError(400, 'argumentsDigest is required for this approval decision');
  }
  return reviewed;
}

function authenticateControlRequest(
  authenticator: ControlAuthenticator | undefined,
  request: IncomingMessage,
  response: ServerResponse,
): ControlPrincipal | undefined {
  if (!authenticator) return undefined;
  const principal = authenticator.authenticate(request.headers.authorization);
  if (principal) return principal;
  response.setHeader('www-authenticate', 'Bearer realm="OpenProjects control", charset="UTF-8"');
  throw new HttpError(401, 'Valid control Bearer credentials are required');
}

function requireControlCapability(
  principal: ControlPrincipal | undefined,
  capability: ControlCapability,
): void {
  // Configurations without server.auth retain the explicit development-only
  // loopback behavior. Once auth is enabled, every API route is least-privilege.
  if (principal === undefined || hasControlCapability(principal, capability)) return;
  throw new HttpError(403, `Control capability ${capability} is required`);
}

function requireControlWorkspace(
  principal: ControlPrincipal | undefined,
  workspaceId: string,
): void {
  if (principal === undefined || isControlWorkspaceAllowed(principal, workspaceId)) return;
  throw new HttpError(403, 'Control principal is not authorized for this workspace');
}

function requireControlResourceWorkspace(
  principal: ControlPrincipal | undefined,
  workspaceId: string,
): void {
  if (principal === undefined || isControlWorkspaceAllowed(principal, workspaceId)) return;
  // Resource-ID routes conceal whether an object exists outside the caller's
  // configured workspace boundary.
  throw new HttpError(404, 'Not found');
}

function requireGlobalControlScope(principal: ControlPrincipal | undefined): void {
  if (principal === undefined || principal.workspaces === undefined) return;
  throw new HttpError(403, 'This operation requires an unscoped control principal');
}

function mutationActor(
  principal: ControlPrincipal | undefined,
  input: JsonObject,
  key: string,
  fallback: string,
): string {
  return principal?.id ?? optionalString(input, key) ?? fallback;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertExactObjectFields(
  input: JsonObject,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  const unknown = Object.keys(input).find((key) => !allowed.has(key));
  if (unknown) throw new HttpError(400, `${label} contains unknown field ${unknown}`);
}

function boundedInteger(value: string | null, fallback: number, min: number, max: number): number {
  const parsed = value === null ? fallback : Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function boundedIdentifier(value: string, name: string): string {
  if (!value || value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new HttpError(400, `${name} must be 1-256 control-free characters`);
  }
  return value;
}

/**
 * User-supplied event labels are data, not transport authority. Namespacing by
 * the authenticated control principal prevents collisions with verified
 * adapters (for example Telegram) and with another principal's dedupe keys.
 */
function controlEventSource(principal: ControlPrincipal | undefined, claimedSource: string): string {
  const source = boundedIdentifier(claimedSource, 'source');
  if (Buffer.byteLength(source, 'utf8') > 256) {
    throw new HttpError(400, 'source must be at most 256 UTF-8 bytes');
  }
  const principalId = principal?.id ?? 'legacy-loopback';
  return `control-api/${Buffer.from(principalId, 'utf8').toString('base64url')}/${Buffer.from(source, 'utf8').toString('base64url')}`;
}

function inboundEventReceipt(
  result: Awaited<ReturnType<OpenProjectsApp['runtime']['ingestEvent']>>,
): JsonValue {
  const runId = result.outcome?.run.id;
  return {
    duplicate: result.duplicate,
    ...(runId
      ? {
          runId,
          links: {
            status: `/api/runs/${encodeURIComponent(runId)}`,
            events: `/api/runs/${encodeURIComponent(runId)}/events/stream`,
          },
        }
      : {}),
  };
}

function corporateRecordInput(value: unknown, index: number): CorporateRecordInput {
  if (!isObject(value)) throw new HttpError(400, `records[${index}] must be an object`);
  assertExactObjectFields(value, CORPORATE_RECORD_FIELDS, `records[${index}]`);
  const domain = requiredString(value, 'domain') as CorporateRecordInput['domain'];
  const projectId = optionalString(value, 'projectId');
  const sourceUrl = optionalString(value, 'sourceUrl');
  const sourceVersion = optionalString(value, 'sourceVersion');
  const status = optionalString(value, 'status') as CorporateRecordInput['status'] | undefined;
  const metadata = value.metadata;
  if (metadata !== undefined && !isObject(metadata)) {
    throw new HttpError(400, `records[${index}].metadata must be an object`);
  }
  return {
    externalId: requiredString(value, 'externalId'),
    domain,
    recordType: requiredString(value, 'recordType'),
    ...(projectId ? { projectId } : {}),
    title: typeof value.title === 'string' ? value.title : '',
    content: typeof value.content === 'string' ? value.content : '',
    ...(sourceUrl ? { sourceUrl } : {}),
    ...(sourceVersion ? { sourceVersion } : {}),
    occurredAt: requiredString(value, 'occurredAt'),
    sourceUpdatedAt: requiredString(value, 'sourceUpdatedAt'),
    ...(status ? { status } : {}),
    ...(metadata ? { metadata } : {}),
  };
}

function corporateIngestReceipt(result: CorporateIngestResult): JsonValue {
  return {
    schema: 'openprojects.corporate-sync-receipt.v1',
    inserted: result.inserted,
    updated: result.updated,
    unchanged: result.unchanged,
    stale: result.stale,
    records: result.records.map((record) => ({
      id: record.id,
      externalId: record.externalId,
      revision: record.revision,
      status: record.status,
      contentSha256: record.contentSha256,
    })),
    checkpoint: {
      workspaceId: result.checkpoint.workspaceId,
      source: result.checkpoint.source,
      sourceAccountId: result.checkpoint.sourceAccountId,
      stream: result.checkpoint.stream,
      cursor: result.checkpoint.cursor ?? null,
      sourceWatermark: result.checkpoint.sourceWatermark ?? null,
      lastBatchSha256: result.checkpoint.lastBatchSha256,
      recordsSeen: result.checkpoint.recordsSeen,
      lastSuccessAt: result.checkpoint.lastSuccessAt,
    },
    embeddings: {
      model: result.embeddings.model,
      dataBoundary: result.embeddings.dataBoundary,
      stored: result.embeddings.stored,
      failed: result.embeddings.failed,
      error: result.embeddings.error ?? null,
    },
    agentRunInvoked: false,
    chatModelInvoked: false,
    embeddingInvoked: result.embeddings.stored + result.embeddings.failed > 0,
    // Retained for the unreleased v1 fixture contract; means no agent/chat completion.
    modelInvoked: false,
  };
}

function corporateSearchReceipt(result: CorporateSearchResult): JsonValue {
  return {
    schema: 'openprojects.oracle-search.v1',
    trust: 'untrusted-evidence',
    instructionAuthority: 'none',
    retrievalMode: result.mode,
    embeddingModel: result.embeddingModel,
    embeddingError: result.embeddingError ?? null,
    records: result.records.map((record) => ({
      id: record.id,
      citation: `[oracle:${record.id}]`,
      source: record.source,
      sourceAccountId: record.sourceAccountId,
      stream: record.stream,
      externalId: record.externalId,
      domain: record.domain,
      recordType: record.recordType,
      projectId: record.projectId ?? null,
      title: record.title,
      content: record.content.slice(0, 8_192),
      sourceUrl: record.sourceUrl ?? null,
      sourceVersion: record.sourceVersion ?? null,
      occurredAt: record.occurredAt,
      sourceUpdatedAt: record.sourceUpdatedAt,
      observedAt: record.observedAt,
      revision: record.revision,
    })),
    actionTaken: false,
  };
}

function assertBackgroundCapacity(state: ServerRuntimeState): void {
  if (state.operations.size >= MAX_BACKGROUND_OPERATIONS) {
    throw new HttpError(429, 'Too many background operations are active');
  }
}

function trackBackgroundOperation(
  state: ServerRuntimeState,
  operation: Promise<unknown>,
  label: string,
): void {
  let tracked: Promise<void>;
  tracked = operation
    .then(() => undefined)
    .catch((error) => console.error(`OpenProjects ${label} failed:`, error))
    .finally(() => state.operations.delete(tracked));
  state.operations.add(tracked);
}

function runAcceptance(run: ReturnType<OpenProjectsApp['storage']['getRun']>): JsonValue {
  return {
    run: run as unknown as JsonValue,
    links: {
      status: `/api/runs/${encodeURIComponent(run.id)}`,
      events: `/api/runs/${encodeURIComponent(run.id)}/events/stream`,
    },
  };
}

function terminal(status: string): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

function terminalEvent(type: string): boolean {
  return type === 'run.succeeded' || type === 'run.failed' || type === 'run.cancelled';
}

function mimeType(extension: string): string {
  if (extension === '.html') return 'text/html; charset=utf-8';
  if (extension === '.css') return 'text/css; charset=utf-8';
  if (extension === '.js') return 'text/javascript; charset=utf-8';
  if (extension === '.svg') return 'image/svg+xml';
  return 'application/octet-stream';
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}
