import { randomUUID } from 'node:crypto';

import type {
  AssistantMessage,
  JsonObject,
  JsonValue,
  ModelAdapter,
  ModelMessage,
  ModelRequest,
  ModelResponse,
  TokenUsage,
  ToolCall,
} from '../core/types.js';
import {
  createNetworkPolicy,
  isLoopbackHostname,
  type OutboundNetworkPolicy,
} from '../privacy/network-policy.js';

export interface OpenAICompatibleOptions {
  id?: string;
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  /** Fail closed on malformed/unoffered structured tool calls. Defaults to true. */
  strictToolCalls?: boolean;
  /** Disabled by default until the exact provider/model is qualified. */
  parallelToolCalls?: boolean;
  networkPolicy?: OutboundNetworkPolicy;
}

export interface MlxLmOptions {
  id?: string;
  baseUrl: string;
  networkPolicy?: OutboundNetworkPolicy;
}

export interface LlamaCppOptions {
  id?: string;
  /** Exact loopback OpenAI-compatible endpoint, including the /v1 path. */
  baseUrl: string;
  /** Dedicated llama-server bearer key, normally read from its 0600 key file. */
  apiKey: string;
  /** Exact alias supplied to llama-server with --alias. */
  modelAlias: string;
  networkPolicy?: OutboundNetworkPolicy;
}

export interface FreeTokenOptions {
  id?: string;
  /** Exact loopback OpenAI-compatible endpoint, including the /v1 path. */
  baseUrl: string;
  /** Exact alias supplied to ft serve with --served-model-name. */
  modelAlias: string;
  networkPolicy?: OutboundNetworkPolicy;
}

interface CompletionCompatibility {
  /** Omitting the model makes mlx_lm.server use its externally pinned default_model. */
  sendModel: boolean;
  sendToolChoice: boolean;
  parallelToolCalls?: boolean;
  strictToolCalls: boolean;
  strictToolProvider?: string;
}

/** Maximum decoded JSON envelope accepted from a model completion endpoint. */
export const MAX_MODEL_RESPONSE_BYTES = 256 * 1024;

export class OpenAICompatibleAdapter implements ModelAdapter {
  readonly id: string;
  readonly #baseUrl: string;
  readonly #apiKey: string | undefined;
  readonly #headers: Record<string, string>;
  readonly #strictToolCalls: boolean;
  readonly #parallelToolCalls: boolean;
  readonly #external: boolean;
  readonly #networkPolicy: OutboundNetworkPolicy;

  constructor(options: OpenAICompatibleOptions) {
    this.id = options.id ?? 'openai-compatible';
    this.#baseUrl = validateApiBaseUrl(options.baseUrl, 'OpenAI-compatible model');
    this.#apiKey = options.apiKey === undefined
      ? undefined
      : validateHttpApiKey(options.apiKey, 'OpenAI-compatible model');
    this.#headers = validateHttpHeaders(options.headers, 'OpenAI-compatible model', [
      'authorization',
      'content-type',
    ]);
    this.#strictToolCalls = options.strictToolCalls ?? true;
    this.#parallelToolCalls = options.parallelToolCalls ?? false;
    this.#external = !isLoopbackHostname(new URL(this.#baseUrl).hostname);
    this.#networkPolicy = options.networkPolicy ?? createNetworkPolicy();
    this.#networkPolicy.assertAllowed(this.#baseUrl, `model adapter ${this.id}`);
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    return this.completeCompatible(request, {
      sendModel: true,
      sendToolChoice: true,
      parallelToolCalls: this.#parallelToolCalls,
      strictToolCalls: this.#strictToolCalls,
    });
  }

  protected async completeCompatible(
    request: ModelRequest,
    compatibility: CompletionCompatibility,
  ): Promise<ModelResponse> {
    const endpoint = `${this.#baseUrl}/chat/completions`;
    this.#networkPolicy.assertAllowed(endpoint, `model adapter ${this.id}`);
    const tools = request.tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        // `redirect: error` is surfaced by fetch as a TypeError, which would be
        // indistinguishable from a transient transport failure and could trigger
        // a disclosure-changing fallback. A manual 3xx remains an ordinary,
        // non-retryable HTTP provider error.
        redirect: 'manual',
        headers: {
          ...(this.#apiKey ? { authorization: `Bearer ${this.#apiKey}` } : {}),
          'content-type': 'application/json',
          ...this.#headers,
        },
        body: JSON.stringify({
          ...(compatibility.sendModel ? { model: request.model } : {}),
          messages: request.messages.map(toWireMessage),
          ...(tools.length ? { tools } : {}),
          ...(compatibility.sendToolChoice && tools.length ? { tool_choice: 'auto' } : {}),
          ...(tools.length && compatibility.parallelToolCalls !== undefined
            ? { parallel_tool_calls: compatibility.parallelToolCalls }
            : {}),
          max_tokens: request.maxOutputTokens,
          stream: false,
        }),
        signal: request.signal,
      });
    } catch (error) {
      if (request.signal.aborted) throw error;
      throw new ModelTransportError(
        this.#external ? 'External model transport failed' : 'Model transport failed',
        error,
      );
    }

    const body = await readBoundedModelJson(response);
    if (!response.ok) {
      throw new ModelHttpError(
        response.status,
        this.#external
          ? `External model request failed with HTTP ${response.status}`
          : readErrorMessage(body) ?? `Model request failed with HTTP ${response.status}`,
      );
    }
    if (!isObject(body)) throw new Error('Model response is not a JSON object');
    const choices = body.choices;
    if (!Array.isArray(choices) || !isObject(choices[0]) || !isObject(choices[0].message)) {
      throw new Error('Model response does not contain choices[0].message');
    }
    const wireMessage = choices[0].message;
    if (wireMessage.role !== 'assistant') {
      throw new Error('Model response choices[0].message.role must be assistant');
    }
    const message: AssistantMessage = {
      role: 'assistant',
      content: typeof wireMessage.content === 'string' ? wireMessage.content : null,
      ...readToolCalls(wireMessage.tool_calls, compatibility.strictToolCalls),
    };
    const usage = readTokenUsage(body.usage);
    const finishReason = typeof choices[0].finish_reason === 'string' ? choices[0].finish_reason : undefined;
    if (compatibility.strictToolCalls) {
      validateStrictToolResponse(
        request,
        message,
        finishReason,
        compatibility.strictToolProvider ?? 'Local model server',
      );
    }
    return {
      message,
      ...(usage ? { usage } : {}),
      ...(finishReason ? { rawFinishReason: finishReason } : {}),
      ...(typeof body.model === 'string' ? { model: body.model } : {}),
    };
  }
}

async function readBoundedModelJson(response: Response): Promise<unknown> {
  const declaredLength = response.headers.get('content-length')?.trim();
  if (declaredLength && /^\d+$/u.test(declaredLength)
    && BigInt(declaredLength) > BigInt(MAX_MODEL_RESPONSE_BYTES)) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Model response exceeds the ${MAX_MODEL_RESPONSE_BYTES}-byte limit`);
  }

  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_MODEL_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`Model response exceeds the ${MAX_MODEL_RESPONSE_BYTES}-byte limit`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Strict adapter for an externally supervised official mlx_lm.server process.
 *
 * The request deliberately omits `model`: mlx_lm.server then selects the
 * model pinned by its `--model` argument through the `default_model` alias.
 * This prevents a chat request from selecting an arbitrary repo/path and
 * triggering an implicit Hugging Face download. The harness never starts,
 * downloads, or manages the Python service.
 */
export class MlxLmAdapter extends OpenAICompatibleAdapter {
  constructor(options: MlxLmOptions) {
    const baseUrl = validateMlxLmBaseUrl(options.baseUrl);
    super({
      id: options.id ?? 'mlx-lm',
      baseUrl,
      ...(options.networkPolicy ? { networkPolicy: options.networkPolicy } : {}),
    });
  }

  override async complete(request: ModelRequest): Promise<ModelResponse> {
    const response = await this.completeCompatible(request, {
      sendModel: false,
      // The official server currently accepts tools but does not implement
      // these OpenAI request controls. Capability depends on the exact model,
      // tokenizer, chat template, and MLX-LM version and must be probed.
      sendToolChoice: false,
      strictToolCalls: true,
      strictToolProvider: 'MLX-LM',
    });
    if (response.model !== 'default_model') {
      throw new Error(
        `MLX-LM response must identify the externally pinned default_model alias; received ${response.model === undefined ? 'no model identifier' : 'a different model identifier'}`,
      );
    }
    return response;
  }
}

/** Enforces the official local server shape even when global egress is relaxed. */
export function validateMlxLmBaseUrl(value: string): string {
  return validateLoopbackV1BaseUrl(value, 'MLX-LM');
}

/**
 * Strict adapter for an externally supervised, single-model llama-server.
 *
 * OpenProjects still owns policy, tools, approvals, and routing. This adapter
 * only permits authenticated loopback HTTP, always replaces the request model
 * with the reviewed `--alias`, disables parallel tool calls, and requires the
 * response to echo that same alias. It never starts or downloads a model.
 */
export class LlamaCppAdapter extends OpenAICompatibleAdapter {
  readonly #modelAlias: string;

  constructor(options: LlamaCppOptions) {
    const baseUrl = validateLlamaCppBaseUrl(options.baseUrl);
    const apiKey = validateLlamaCppApiKey(options.apiKey);
    const modelAlias = validateLlamaCppModelAlias(options.modelAlias);
    super({
      id: options.id ?? 'llama.cpp',
      baseUrl,
      apiKey,
      ...(options.networkPolicy ? { networkPolicy: options.networkPolicy } : {}),
    });
    this.#modelAlias = modelAlias;
  }

  override async complete(request: ModelRequest): Promise<ModelResponse> {
    const response = await this.completeCompatible({ ...request, model: this.#modelAlias }, {
      sendModel: true,
      sendToolChoice: true,
      parallelToolCalls: false,
      strictToolCalls: true,
      strictToolProvider: 'llama.cpp',
    });
    if (response.model !== this.#modelAlias) {
      throw new Error(
        `llama.cpp response must identify the pinned model alias ${this.#modelAlias}; received ${response.model === undefined ? 'no model identifier' : 'a different model identifier'}`,
      );
    }
    return response;
  }
}

/**
 * Strict adapter for an externally supervised, single-model FreeToken server.
 *
 * The route model is a fixed `--served-model-name` alias, never a Hugging Face
 * repository ID or local path. This prevents a request from selecting or
 * downloading another checkpoint. FreeToken currently has no model-server
 * authentication boundary, so OpenProjects permits only loopback HTTP and
 * keeps policy, tools, approvals, and routing in the host runtime.
 */
export class FreeTokenAdapter extends OpenAICompatibleAdapter {
  readonly #modelAlias: string;

  constructor(options: FreeTokenOptions) {
    const baseUrl = validateFreeTokenBaseUrl(options.baseUrl);
    const modelAlias = validateFreeTokenModelAlias(options.modelAlias);
    super({
      id: options.id ?? 'freetoken',
      baseUrl,
      ...(options.networkPolicy ? { networkPolicy: options.networkPolicy } : {}),
    });
    this.#modelAlias = modelAlias;
  }

  override async complete(request: ModelRequest): Promise<ModelResponse> {
    const response = await this.completeCompatible({ ...request, model: this.#modelAlias }, {
      sendModel: true,
      sendToolChoice: true,
      parallelToolCalls: false,
      strictToolCalls: true,
      strictToolProvider: 'FreeToken',
    });
    if (response.model !== this.#modelAlias) {
      throw new Error(
        `FreeToken response must identify the pinned served-model alias ${this.#modelAlias}; received ${response.model === undefined ? 'no model identifier' : 'a different model identifier'}`,
      );
    }
    return response;
  }
}

/** Enforces the reviewed local llama-server API boundary. */
export function validateLlamaCppBaseUrl(value: string): string {
  return validateLoopbackV1BaseUrl(value, 'llama.cpp');
}

/** Enforces the reviewed local FreeToken API boundary. */
export function validateFreeTokenBaseUrl(value: string): string {
  return validateLoopbackV1BaseUrl(value, 'FreeToken');
}

/**
 * Normalizes a reviewed HTTP API base and forbids cleartext transport outside
 * loopback. Credentials, queries, and fragments never belong in configuration.
 */
export function validateApiBaseUrl(value: string, provider = 'API'): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${provider} baseUrl must be a valid absolute URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${provider} baseUrl must use http or https`);
  }
  if (!isLoopbackHostname(url.hostname) && url.protocol !== 'https:') {
    throw new Error(`${provider} baseUrl must use HTTPS outside loopback`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`${provider} baseUrl must not contain credentials, a query, or a fragment`);
  }
  url.pathname = url.pathname.replace(/\/+$/u, '') || '/';
  return url.toString().replace(/\/$/u, '');
}

/** Validates a bearer secret before it can be interpolated into an HTTP header. */
export function validateHttpApiKey(value: string, provider = 'API'): string {
  if (!/^[!-~]{1,4096}$/u.test(value)) {
    throw new Error(`${provider} API key must be 1-4096 visible ASCII characters`);
  }
  return value;
}

/**
 * Copies and validates operator-supplied headers while protecting headers that
 * are owned by the adapter. Header values may contain ordinary ASCII spaces,
 * but never control bytes, Unicode ambiguity, or an all-whitespace value.
 */
export function validateHttpHeaders(
  headers: Record<string, string> | undefined,
  provider = 'API',
  reservedNames: readonly string[] = [],
): Record<string, string> {
  if (!headers) return {};
  const reserved = new Set(reservedNames.map((name) => name.toLowerCase()));
  const validated: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,128}$/u.test(name)) {
      throw new Error(`${provider} header name must be a valid 1-128 character ASCII token`);
    }
    if (reserved.has(name.toLowerCase())) {
      throw new Error(`${provider} custom headers must not override ${name.toLowerCase()}`);
    }
    if (typeof value !== 'string' || value.length > 8192
      || !/^[\x20-\x7e]+$/u.test(value) || !value.trim()) {
      throw new Error(`${provider} header ${name} must be non-empty control-free ASCII`);
    }
    validated[name] = value;
  }
  return validated;
}

function validateLoopbackV1BaseUrl(value: string, provider: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${provider} baseUrl must be a valid absolute URL`);
  }
  if (url.protocol !== 'http:') {
    throw new Error(`${provider} baseUrl must use loopback HTTP; terminate reviewed TLS outside the model process`);
  }
  if (!isLoopbackHostname(url.hostname)) {
    throw new Error(`${provider} baseUrl must use a loopback host`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`${provider} baseUrl must not contain credentials, a query, or a fragment`);
  }
  const pathname = url.pathname.replace(/\/+$/u, '') || '/';
  if (pathname !== '/v1') {
    throw new Error(`${provider} baseUrl path must be /v1`);
  }
  url.pathname = '/v1';
  return url.toString().replace(/\/$/u, '');
}

function validateLlamaCppApiKey(value: string): string {
  if (!/^[!-~]{16,256}$/u.test(value) || value.includes(',')) {
    throw new Error('llama.cpp apiKey must be 16-256 visible ASCII characters without commas');
  }
  return value;
}

export function validateLlamaCppModelAlias(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/u.test(value)) {
    throw new Error('llama.cpp model alias must be a 1-128 character safe identifier');
  }
  return value;
}

export function validateFreeTokenModelAlias(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/u.test(value)) {
    throw new Error('FreeToken served-model alias must be a 1-128 character safe identifier');
  }
  return value;
}

export class ModelHttpError extends Error {
  readonly retryable: boolean;

  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ModelHttpError';
    this.retryable = status === 408 || status === 409 || status === 429 || status >= 500;
  }
}

/** Explicit transient transport failure; route fallback never infers retryability from Error type. */
export class ModelTransportError extends Error {
  readonly retryable = true;

  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ModelTransportError';
  }
}

/** A credential-free model fixture that exercises the real loop and tools. */
export class ProjectOpsFixtureModel implements ModelAdapter {
  readonly id = 'mock';

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const latest = request.messages.at(-1);
    const userText = request.messages
      .filter((message): message is Extract<ModelMessage, { role: 'user' }> => message.role === 'user')
      .map((message) => message.content)
      .join('\n')
      .toLocaleLowerCase();

    let message: AssistantMessage;
    if (request.task === 'project_analysis' && request.tools.some((tool) => tool.name === 'project_analysis_snapshot_v1')) {
      message = latest?.role === 'tool'
        ? projectAnalystFixtureResult(latest.content)
        : call('project_analysis_snapshot_v1', {});
    } else if (request.tools.length === 0 && request.task && request.task !== 'supervisor') {
      message = text(
        'Advisory finding: Atlas has a critical-path dependency on production credentials; dashboard integration and QA remain blocked. Verify against the parent run evidence before acting.',
      );
    } else if (latest?.role === 'tool') {
      message = this.afterTool(latest.name, latest.content, userText);
    } else if (matches(userText, ['delegate', 'subagent', 'specialist', 'multi-agent', 'multi agent'])) {
      message = call('delegate_agent', {
        agentId: 'project-analyst',
        task: 'Independently analyze the Atlas critical path and identify the strongest evidence-backed risk.',
      });
    } else if (matches(userText, ['send', 'email', 'message', 'отправ', 'напиши и отправ'])) {
      message = call('draft_followup', {
        projectId: 'project-atlas',
        recipient: 'backend-lead@example.test',
        purpose: 'Unblock the Atlas launch credentials dependency before the demo.',
      });
    } else if (matches(userText, ['draft', 'prepare follow-up', 'черновик', 'подготовь'])) {
      message = call('draft_followup', {
        projectId: 'project-atlas',
        recipient: 'backend-lead@example.test',
        purpose: 'Unblock the Atlas launch credentials dependency before the demo.',
      });
    } else if (matches(userText, ['list projects', 'show projects', 'проекты', 'projects'])) {
      message = call('project_list', {});
    } else if (matches(userText, ['create task', 'создай задачу'])) {
      message = call('task_create', {
        projectId: 'project-atlas',
        title: 'Resolve launch credentials blocker',
        priority: 'high',
        assignee: 'Nadia',
      });
    } else {
      message = call('project_risk_report', {
        projectId: 'project-atlas',
        asOf: '2026-08-25T12:00:00.000Z',
      });
    }

    return {
      message,
      model: 'project-ops-v1',
      rawFinishReason: message.toolCalls?.length ? 'tool_calls' : 'stop',
      usage: estimateUsage(request.messages, message),
    };
  }

  private afterTool(toolName: string, content: string, userText: string): AssistantMessage {
    const result = safeParse(content);
    if (result.ok === false) {
      const failure = isObject(result.error) && typeof result.error.message === 'string'
        ? result.error.message
        : 'unknown error';
      return text(`The action did not run: ${failure} No external change was claimed as complete.`);
    }
    if (toolName === 'draft_followup' && matches(userText, ['send', 'отправ'])) {
      const value = resultValue(result);
      return call('send_followup', {
        projectId: 'project-atlas',
        destination: readString(value, 'recipient') ?? 'backend-lead@example.test',
        subject: readString(value, 'subject') ?? 'Atlas launch blocker',
        body: readString(value, 'body') ?? 'Please help resolve the launch credentials blocker.',
      });
    }
    if (toolName === 'draft_followup') {
      const value = resultValue(result);
      return text(
        `Draft ready; nothing was sent.\n\nSubject: ${readString(value, 'subject') ?? 'Atlas launch blocker'}\n\n${readString(value, 'body') ?? 'No draft body was returned.'}`,
      );
    }
    if (toolName === 'project_list') {
      return call('project_risk_report', {
        projectId: 'project-atlas',
        asOf: '2026-08-25T12:00:00.000Z',
      });
    }
    if (toolName === 'project_risk_report') {
      const value = resultValue(result);
      const risks = Array.isArray(value.risks) ? value.risks.filter(isObject) : [];
      const first = risks[0];
      const evidence = first && Array.isArray(first.evidenceIds) ? first.evidenceIds : [];
      const citations = evidence.filter((item): item is string => typeof item === 'string').map((id) => `[evidence:${id}]`).join(' ');
      return text(
        `Finding: Atlas is at high delivery risk because the backend credentials task is blocked and the demo depends on it. ${citations}\n\nImpact: frontend integration and QA cannot complete on time.\n\nNext action: send the backend lead the prepared unblock request, with approval before any external message is queued.`,
      );
    }
    if (toolName === 'send_followup') {
      const value = resultValue(result);
      return text(
        `The approved follow-up was queued exactly once for ${readString(value, 'destination') ?? 'the project owner'} (outbox ${readString(value, 'id') ?? 'unknown'}).`,
      );
    }
    if (toolName === 'task_create') {
      const value = resultValue(result);
      return text(`Task created: ${readString(value, 'title') ?? 'new task'} (${readString(value, 'id') ?? 'unknown'}).`);
    }
    if (toolName === 'delegate_agent') {
      const value = resultValue(result);
      return text(`Specialist analysis completed in child run ${readString(value, 'childRunId') ?? 'unknown'}:\n\n${readString(value, 'output') ?? 'No specialist output was returned.'}`);
    }
    return text('The requested operation completed.');
  }
}

function projectAnalystFixtureResult(content: string): AssistantMessage {
  const result = safeParse(content);
  const value = resultValue(result);
  const project = isObject(value.project) ? value.project : {};
  const tasks = Array.isArray(value.tasks) ? value.tasks.filter(isObject) : [];
  const evidence = Array.isArray(value.evidence) ? value.evidence.filter(isObject) : [];
  const blocked = tasks.filter((task) => task.status === 'blocked');
  return text(JSON.stringify({
    schema: 'openprojects.project-analysis-result.v1',
    projectId: readString(project, 'id') ?? 'unknown',
    riskLevel: blocked.length >= 2 ? 'high' : blocked.length === 1 ? 'medium' : 'low',
    finding: blocked.length
      ? `${blocked.length} blocked task(s) threaten the scoped project's delivery.`
      : 'No blocked task is present in the scoped project snapshot.',
    taskIds: blocked.map((task) => readString(task, 'id')).filter((id): id is string => Boolean(id)),
    evidenceIds: evidence.map((item) => readString(item, 'id')).filter((id): id is string => Boolean(id)),
    impact: blocked.length ? 'Dependent work may miss the project deadline.' : 'No immediate delivery impact is supported.',
    recommendedNextAction: blocked.length
      ? 'Ask the project owner to review the blocked tasks; do not send or change anything automatically.'
      : 'Continue monitoring the scoped project.',
    uncertainties: [],
    actionTaken: false,
  }));
}

function toWireMessage(message: ModelMessage): JsonObject {
  if (message.role === 'assistant') {
    return {
      role: 'assistant',
      content: message.content,
      ...(message.toolCalls?.length
        ? {
            tool_calls: message.toolCalls.map((callItem) => ({
              id: callItem.id,
              type: 'function',
              function: { name: callItem.name, arguments: callItem.arguments },
            })),
          }
        : {}),
    } as JsonObject;
  }
  if (message.role === 'tool') {
    return {
      role: 'tool',
      tool_call_id: message.toolCallId,
      name: message.name,
      content: message.content,
    };
  }
  return { role: message.role, content: message.content };
}

function readToolCalls(value: unknown, strict = false): { toolCalls?: ToolCall[] } {
  if (value === undefined || value === null) return {};
  if (!Array.isArray(value)) {
    if (strict) throw new Error('Model response tool_calls must be an array');
    return {};
  }
  const calls: ToolCall[] = [];
  const ids = new Set<string>();
  for (const item of value) {
    if (!isObject(item) || !isObject(item.function)
      || typeof item.function.name !== 'string'
      || typeof item.function.arguments !== 'string') {
      if (strict) throw new Error('Model response contains a malformed structured tool call');
      continue;
    }
    if (strict) {
      if (item.type !== 'function') {
        throw new Error('Model response structured tool call type must be function');
      }
      if (!/^[A-Za-z0-9_-]{1,128}$/u.test(item.function.name)) {
        throw new Error('Model response contains an invalid tool name');
      }
      let parsedArguments: unknown;
      try {
        parsedArguments = JSON.parse(item.function.arguments) as unknown;
      } catch {
        throw new Error(`Model response tool ${item.function.name} arguments are not valid JSON`);
      }
      if (!isObject(parsedArguments)) {
        throw new Error(`Model response tool ${item.function.name} arguments must be a JSON object`);
      }
    }
    if (strict && (typeof item.id !== 'string' || !item.id || item.id.length > 256)) {
      throw new Error('Model response structured tool call requires a bounded non-empty ID');
    }
    const id = typeof item.id === 'string' && item.id ? item.id : randomUUID();
    if (strict && ids.has(id)) throw new Error('Model response contains duplicate tool call IDs');
    ids.add(id);
    calls.push({
      id,
      name: item.function.name,
      arguments: item.function.arguments,
    });
  }
  return calls.length ? { toolCalls: calls } : {};
}

function validateStrictToolResponse(
  request: ModelRequest,
  message: AssistantMessage,
  finishReason: string | undefined,
  provider: string,
): void {
  const calls = message.toolCalls ?? [];
  if (calls.length > 0 && request.tools.length === 0) {
    throw new Error(`${provider} returned tool calls when no tools were supplied`);
  }
  const offered = new Set(request.tools.map((tool) => tool.name));
  for (const callItem of calls) {
    if (!offered.has(callItem.name)) {
      throw new Error(`${provider} returned unoffered tool ${callItem.name}`);
    }
  }
  if (finishReason === 'tool_calls' && calls.length === 0) {
    throw new Error(`${provider} reported tool_calls without a structured tool call`);
  }
  if (calls.length > 0 && finishReason !== 'tool_calls') {
    throw new Error(`${provider} returned structured tool calls with finish_reason ${finishReason ?? 'missing'}`);
  }
  if (calls.length === 0 && (finishReason === 'length' || finishReason === 'content_filter')) {
    throw new Error(`${provider} returned incomplete text with finish_reason ${finishReason}`);
  }
  if (calls.length === 0 && finishReason !== 'stop') {
    throw new Error(`${provider} returned text with unsupported finish_reason ${finishReason ?? 'missing'}`);
  }
  if (calls.length === 0 && !message.content?.trim()) {
    throw new Error(
      `${provider} returned neither text nor structured tool calls; verify this model/tokenizer tool parser with the appliance qualification probe`,
    );
  }
}

function readErrorMessage(value: unknown): string | undefined {
  if (!isObject(value)) return undefined;
  if (isObject(value.error) && typeof value.error.message === 'string') return value.error.message;
  return typeof value.message === 'string' ? value.message : undefined;
}

function readTokenUsage(value: unknown): TokenUsage | undefined {
  if (!isObject(value)) return undefined;
  const inputTokens = tokenCount(value.prompt_tokens);
  const outputTokens = tokenCount(value.completion_tokens);
  const totalTokens = tokenCount(value.total_tokens);
  if (inputTokens === undefined || outputTokens === undefined || totalTokens === undefined) {
    return undefined;
  }
  if (totalTokens === 0 || totalTokens !== inputTokens + outputTokens) return undefined;
  return { inputTokens, outputTokens, totalTokens };
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function call(name: string, input: JsonObject): AssistantMessage {
  return {
    role: 'assistant',
    content: null,
    toolCalls: [{ id: `call_${randomUUID()}`, name, arguments: JSON.stringify(input) }],
  };
}

function text(content: string): AssistantMessage {
  return { role: 'assistant', content };
}

function matches(value: string, patterns: string[]): boolean {
  return patterns.some((pattern) => value.includes(pattern));
}

function safeParse(value: string): JsonObject {
  try {
    const parsed = JSON.parse(value) as JsonValue;
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function resultValue(result: JsonObject): JsonObject {
  return isObject(result.value) ? result.value : {};
}

function readString(value: JsonObject, key: string): string | undefined {
  return typeof value[key] === 'string' ? value[key] : undefined;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function estimateUsage(messages: ModelMessage[], response: AssistantMessage): { inputTokens: number; outputTokens: number; totalTokens: number } {
  const inputCharacters = messages.reduce((sum, message) => sum + JSON.stringify(message).length, 0);
  const outputCharacters = JSON.stringify(response).length;
  const inputTokens = Math.ceil(inputCharacters / 4);
  const outputTokens = Math.ceil(outputCharacters / 4);
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
}
