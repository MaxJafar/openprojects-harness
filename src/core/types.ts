export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type RunStatus =
  | 'queued'
  | 'running'
  | 'waiting_for_approval'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export type ToolEffect =
  | 'read'
  | 'draft'
  | 'memory_write'
  | 'internal_write'
  | 'external_write'
  | 'destructive';

export type PolicyDecision = 'allow' | 'ask' | 'deny';

export interface RunBudget {
  maxSteps: number;
  maxToolCalls: number;
  maxWallTimeMs: number;
  maxInputTokens: number;
  reservedOutputTokens: number;
}

export interface AgentDefinition {
  id: string;
  version: string;
  name: string;
  system: string;
  skills: string[];
  tools: string[];
  budgets: RunBudget;
}

export type RunSnapshotKind = 'agent' | 'tools' | 'policy';

/**
 * A redacted, deterministic description of one part of the execution contract.
 * `digest` is SHA-256 over the strict canonical JSON encoding of the other
 * fields; sensitive prompt and skill bodies are represented by digests only.
 */
export interface RunSnapshotDocument {
  schema: 'openprojects.run-snapshot.v1';
  kind: RunSnapshotKind;
  content: JsonObject;
  digest: string;
}

export interface RunSnapshotSet {
  agent: RunSnapshotDocument;
  tools: RunSnapshotDocument;
  policy: RunSnapshotDocument;
}

/** Content addresses bound immutably to a durable run at allocation time. */
export interface RunSnapshotDigests {
  agent: string;
  tools: string;
  policy: string;
}

export interface RunRecord {
  id: string;
  sessionId: string;
  workspaceId: string;
  actorId: string;
  projectId?: string;
  agentId: string;
  agentVersion: string;
  /** Absent only on runs written before the snapshot migration. */
  snapshots?: RunSnapshotDigests;
  status: RunStatus;
  input: string;
  output?: string;
  error?: string;
  step: number;
  toolCalls: number;
  activeMs: number;
  activeSince?: string;
  startedAt?: string;
  finishedAt?: string;
  createdAt: string;
  updatedAt: string;
  metadata: JsonObject;
}

export interface SessionRecord {
  id: string;
  workspaceId: string;
  actorId: string;
  channel: string;
  externalId?: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
  metadata: JsonObject;
}

export interface HarnessEvent<T extends JsonValue = JsonValue> {
  id: string;
  sessionId: string;
  runId: string;
  seq: number;
  type: string;
  data: T;
  createdAt: string;
}

export interface TextContent {
  type: 'text';
  text: string;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface UserMessage {
  role: 'user';
  content: string;
}

export interface SystemMessage {
  role: 'system';
  content: string;
}

export interface AssistantMessage {
  role: 'assistant';
  content: string | null;
  toolCalls?: ToolCall[];
}

export interface ToolMessage {
  role: 'tool';
  toolCallId: string;
  name: string;
  content: string;
}

export type ModelMessage = SystemMessage | UserMessage | AssistantMessage | ToolMessage;

export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: JsonObject;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface ModelRequest {
  runId: string;
  provider: string;
  model: string;
  /** Work class used by the cost/quality router. Defaults to supervisor. */
  task?: ModelTask;
  messages: ModelMessage[];
  tools: ToolSchema[];
  maxOutputTokens: number;
  signal: AbortSignal;
}

export interface ModelResponse {
  message: AssistantMessage;
  usage?: TokenUsage;
  rawFinishReason?: string;
  model?: string;
  route?: ModelRouteSelection;
}

export interface ModelAdapter {
  readonly id: string;
  complete(request: ModelRequest): Promise<ModelResponse>;
}

export interface ToolExecutionContext {
  run: RunRecord;
  callId: string;
  idempotencyKey: string;
  /** Canonical invocation digest when execution is driven by the durable runtime. */
  argumentsDigest?: string;
  signal: AbortSignal;
  emit(type: string, data: JsonValue): HarnessEvent;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonObject;
  outputSchema?: JsonObject;
  effect: ToolEffect;
  /** Whether a crashed execution can be replayed safely. */
  idempotency: 'read' | 'keyed' | 'none';
  timeoutMs?: number;
  /**
   * Security-relevant execution metadata not represented by the JSON schemas
   * (for example a remote tool/transport identity and byte limits). The run
   * snapshot stores only its canonical digest, never this raw object.
   */
  snapshotBinding?: JsonObject;
  execute(context: ToolExecutionContext, input: JsonObject): Promise<JsonValue>;
}

export interface ToolResult {
  callId: string;
  name: string;
  ok: boolean;
  value?: JsonValue;
  error?: {
    code: string;
    message: string;
  };
  durationMs: number;
}

export interface ToolInvocationRecord {
  id: string;
  batchId: string;
  runId: string;
  callId: string;
  callIndex: number;
  toolName: string;
  arguments: string;
  /** Absent only on legacy or structurally invalid invocations. */
  argumentsDigest?: string;
  effect?: ToolEffect;
  policyDecision: PolicyDecision;
  status: 'pending_approval' | 'running' | 'completed' | 'denied' | 'failed';
  result?: ToolResult;
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
}

export interface ApprovalRecord {
  id: string;
  invocationId: string;
  runId: string;
  toolName: string;
  arguments: string;
  /** Absent only on legacy approvals, which cannot be approved or executed. */
  argumentsDigest?: string;
  status: 'pending' | 'approved' | 'rejected';
  requestedAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
  reason?: string;
}

export interface MemoryRecord {
  id: string;
  workspaceId: string;
  projectId?: string;
  actorId?: string;
  kind: 'semantic' | 'episodic' | 'procedural';
  content: string;
  importance: number;
  /** Retrieval weight learned from use and explicit outcome feedback. */
  strength: number;
  reward: number;
  accessCount: number;
  lastAccessedAt?: string;
  sourceType: string;
  sourceId: string;
  status: 'active' | 'proposed' | 'archived';
  createdAt: string;
  updatedAt: string;
}

export type ModelTask =
  | 'supervisor'
  | 'project_analysis'
  | 'memory_curator'
  | 'summarization'
  | 'notification';

export interface ModelRouteConfig {
  id: string;
  provider: string;
  model: string;
  /** Operator-managed immutable provider/model generation for mutable aliases. */
  generation?: string;
  tasks: ModelTask[];
  baseUrl?: string;
  apiKey?: string;
  apiKeyEnv?: string;
  local: boolean;
  enabled: boolean;
  quality: number;
  inputCostPerMillion: number;
  outputCostPerMillion: number;
  /** Explicitly reviewed zero-price external route; never inferred from 0/0 prices. */
  unmetered?: boolean;
  contextWindow: number;
}

export interface ModelRouteSelection {
  routeId: string;
  provider: string;
  model: string;
  local: boolean;
  task: ModelTask;
  reason: string;
  estimatedCostUsd: number;
  latencyMs?: number;
  fallbackFrom?: string;
}

export interface EmbeddingAdapter {
  readonly id: string;
  readonly dimensions?: number;
  embed(texts: string[], signal?: AbortSignal): Promise<number[][]>;
}

export interface TranscriptionResult {
  text: string;
  language?: string;
  durationMs: number;
  model: string;
}

export interface TranscriptionAdapter {
  readonly id: string;
  transcribe(inputPath: string, signal?: AbortSignal): Promise<TranscriptionResult>;
}

export interface GroupSpaceRecord {
  id: string;
  workspaceId: string;
  source: string;
  externalId: string;
  title?: string;
  projectId?: string;
  learningEnabled: boolean;
  notificationsEnabled: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface GroupMessageRecord {
  id: string;
  groupSpaceId: string;
  workspaceId: string;
  externalMessageId: string;
  actorId: string;
  text: string;
  transcript: boolean;
  salient: boolean;
  occurredAt: string;
  createdAt: string;
}

export interface LearningSignalRecord {
  id: string;
  workspaceId: string;
  runId?: string;
  memoryId?: string;
  routeId?: string;
  kind: 'memory_reward' | 'route_reward' | 'group_observation';
  reward: number;
  metadata: JsonObject;
  createdAt: string;
}

/**
 * A normalized corporate record is durable source evidence, never an
 * instruction. Connector-specific payloads are projected into this compact
 * shape before they cross the Oracle ingestion boundary.
 */
export type CorporateRecordDomain =
  | 'project'
  | 'crm'
  | 'erp'
  | 'email'
  | 'messaging'
  | 'calendar'
  | 'document'
  | 'other';

export interface CorporateRecord {
  id: string;
  workspaceId: string;
  /** Reviewed connector identity, for example `linear`, `salesforce`, or `gmail`. */
  source: string;
  /** Immutable provider tenant/account identity verified by the connector. */
  sourceAccountId: string;
  /** A bounded connector feed such as `issues`, `opportunities`, or `inbox`. */
  stream: string;
  externalId: string;
  domain: CorporateRecordDomain;
  /** Provider-specific record type such as `issue`, `invoice`, or `message`. */
  recordType: string;
  projectId?: string;
  title: string;
  content: string;
  sourceUrl?: string;
  sourceVersion?: string;
  /** Time the underlying business event occurred. */
  occurredAt: string;
  /** Monotonic provider timestamp used to reject stale connector replays. */
  sourceUpdatedAt: string;
  /** Time this harness last observed the exact source version. */
  observedAt: string;
  status: 'active' | 'deleted';
  contentSha256: string;
  revision: number;
  metadata: JsonObject;
  /** Authenticated local principal or process that supplied the record. */
  ingestedBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface CorporateSyncState {
  workspaceId: string;
  source: string;
  sourceAccountId: string;
  stream: string;
  cursor?: string;
  sourceWatermark?: string;
  lastBatchSha256: string;
  recordsSeen: number;
  lastSuccessAt: string;
  updatedAt: string;
}

export interface CorporateSourceSummary {
  workspaceId: string;
  source: string;
  sourceAccountId: string;
  stream: string;
  activeRecords: number;
  deletedRecords: number;
  lastObservedAt?: string;
  lastSourceUpdateAt?: string;
  lastSuccessAt?: string;
}

export interface NotificationRecord {
  id: string;
  workspaceId: string;
  groupSpaceId: string;
  projectId: string;
  taskId: string;
  kind: 'deadline_approaching' | 'overdue' | 'blocked';
  destination: string;
  body: string;
  status: 'pending' | 'sending' | 'sent' | 'failed' | 'unknown_outcome';
  idempotencyKey: string;
  scheduledAt: string;
  sentAt?: string;
  error?: string;
  createdAt: string;
}

export interface SubagentDefinition {
  id: string;
  version: string;
  name: string;
  task: ModelTask;
  system: string;
}

export interface SubagentResult {
  childRunId: string;
  agentId: string;
  output: string;
  route?: ModelRouteSelection;
}

export interface FeedbackRecord {
  id: string;
  runId: string;
  actorId: string;
  reaction?: string;
  score: number;
  dimensions: Record<string, number>;
  comment?: string;
  correction?: string;
  createdAt: string;
}

export interface SkillDefinition {
  id: string;
  version: string;
  name: string;
  description: string;
  tools: string[];
  instructions: string;
  evaluators: string[];
}

export interface StartRunInput {
  message: string;
  workspaceId?: string;
  actorId?: string;
  projectId?: string;
  sessionId?: string;
  channel?: string;
  externalSessionId?: string;
  metadata?: JsonObject;
}

export interface RunOutcome {
  run: RunRecord;
  approvals: ApprovalRecord[];
  events: HarnessEvent[];
}

export interface InboundEvent {
  source: string;
  dedupeKey: string;
  type: string;
  workspaceId: string;
  actorId: string;
  projectId?: string;
  payload: JsonObject;
  occurredAt?: string;
}

export type ControlCapability = 'read' | 'run' | 'ingest' | 'approve' | 'admin';

export interface ControlPrincipalConfig {
  /** Stable audit identity; unique within the control-plane configuration. */
  id: string;
  /** Absolute path after configuration loading; contains only this principal's token. */
  tokenFile: string;
  /** Least-privilege control-plane capabilities granted to this principal. */
  capabilities: ControlCapability[];
  /**
   * Optional workspace allowlist. Omitted means all workspaces; when present,
   * it must be non-empty. This avoids an ambiguous empty list ever expanding a
   * workspace-bound principal to global access.
   */
  workspaces?: string[];
}

export interface LegacyServerAuthConfig {
  /** Absolute path after configuration loading; the file contains only the local control token. */
  tokenFile: string;
  /** Stable audit identity assigned to callers that prove possession of the control token. */
  operatorId: string;
  /** Legacy and multi-principal forms are intentionally mutually exclusive. */
  principals?: never;
}

export interface PrincipalsServerAuthConfig {
  /** One or more independently authenticated, least-privilege local identities. */
  principals: ControlPrincipalConfig[];
  /** Legacy and multi-principal forms are intentionally mutually exclusive. */
  tokenFile?: never;
  /** Legacy and multi-principal forms are intentionally mutually exclusive. */
  operatorId?: never;
}

/**
 * Local control authentication. The legacy single-token form remains accepted
 * and is normalized to one principal with every capability and all workspaces.
 */
export type ServerAuthConfig = LegacyServerAuthConfig | PrincipalsServerAuthConfig;

export interface IntegrationsConfig {
  /** Independent approval/deny decision for data leaving the local harness boundary. */
  externalDataPolicy: PolicyDecision;
  /** Explicit absolute paths after configuration loading; globs are never supported. */
  manifests: string[];
}

export interface AppConfig {
  version: number;
  agent: Omit<AgentDefinition, 'system'> & { system?: string };
  policy: Record<ToolEffect, PolicyDecision>;
  /** Optional harness resource posture. Model/runtime memory is qualified separately. */
  resources?: {
    profile: 'core-4g-v1';
    /** Aggregate UTF-16 character cap across memories supplied to one model request. */
    maxRetrievedContextCharacters: number;
  };
  /** Optional reviewed tool integrations. Omitted means no configured integrations. */
  integrations?: IntegrationsConfig;
  server: {
    /** Loopback TCP compatibility endpoint. Ignored when socketPath is configured. */
    host: string;
    /** Loopback TCP compatibility port. Ignored when socketPath is configured. */
    port: number;
    /** POSIX-only protected Unix-domain control socket. */
    socketPath?: string;
    auth?: ServerAuthConfig;
  };
  storage: { database: string };
  model: {
    provider: string;
    model: string;
    baseUrl?: string;
    apiKey?: string;
  };
  memory: {
    retrievalLimit: number;
    maxContextCharacters: number;
  };
  privacy?: {
    /** Deny non-loopback HTTP egress unless its exact origin is allowlisted. */
    localOnly: boolean;
    allowedOrigins: string[];
  };
  telegram?: {
    /** Telegram is an external integration and is disabled in the private profile by default. */
    enabled: boolean;
    apiBaseUrl: string;
  };
  routing?: {
    dailyBudgetUsd: number;
    explorationRate: number;
    /** Explicit deployment-level permission for enabled non-loopback model routes. */
    externalInference?: 'deny' | 'allow';
    /** Prefer an eligible loopback route before any external route. Defaults to true. */
    preferLocal?: boolean;
    /** Permit a retryable loopback failure to disclose the request to an external route. */
    allowRemoteFallback?: boolean;
    routes: ModelRouteConfig[];
  };
  learning?: {
    enabled: boolean;
    groupObservation: boolean;
    minimumSalience: number;
    feedbackLearningRate: number;
    retentionDays: number;
  };
  embeddings?: {
    provider: 'builtin' | 'ollama' | 'openai-compatible';
    model: string;
    baseUrl?: string;
    /** Credential reference for an OpenAI-compatible embedding endpoint. */
    apiKeyEnv?: string;
    /** Operator-managed immutable index generation for compatible endpoints. */
    generation?: string;
    /** Explicit permission to send memory/query text to a non-loopback embedding service. */
    externalData?: 'deny' | 'allow';
    /** Required bare Ollama model digest; binds stored and query vectors to one artifact. */
    serviceDigest?: string;
    dimensions: number;
    timeoutMs: number;
  };
  transcription?: {
    provider: 'disabled' | 'whisper-cpp';
    command: string;
    modelPath?: string;
    ffmpegCommand: string;
    language?: string;
    timeoutMs: number;
    maxBytes: number;
    maxDurationSeconds: number;
  };
  notifications?: {
    enabled: boolean;
    intervalMs: number;
    lookaheadHours: number;
  };
  subagents?: {
    maxCallsPerRun: number;
    maxParallel: number;
    maxDepth: number;
  };
}

export function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
