import { createHash } from 'node:crypto';

import { Ajv, type ValidateFunction } from 'ajv';

import {
  TOOL_EXECUTION_AMBIGUOUS_CODE,
  ToolExecutionError,
  type HarnessPlugin,
} from '../core/kernel.js';
import type { JsonObject, JsonPrimitive, JsonValue, ToolDefinition, ToolEffect } from '../core/types.js';
import {
  validateIntegrationManifest,
  type JsonApiAuthConfig,
  type JsonApiIntegrationManifest,
  type JsonApiIntegrationToolConfig,
  type JsonApiTransportConfig,
  type JsonApiValueSource,
  type IntegrationManifest,
  type LoadedIntegrationManifest,
} from './manifest.js';
import {
  mcpToolGatewayPlugin,
  type LocalMcpToolDeclaration,
  type McpCallToolOptions,
  type McpCallToolRequest,
  type McpCallToolTransport,
  type McpToolLimits,
} from '../mcp/gateway.js';
import {
  createNetworkPolicy,
  isLoopbackHostname,
  type OutboundNetworkPolicy,
} from '../privacy/network-policy.js';

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const FIELD_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.~-]{0,127}$/u;
const HEADER_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9-]{0,126}$/u;
const STATIC_PATH_SEGMENT_PATTERN = /^[A-Za-z0-9._~!$&'()*+,;=:@-]+$/u;
const JSON_CONTENT_TYPE_PATTERN = /^application\/(?:json|[A-Za-z0-9!#$&^_.+-]+\+json)(?:\s*;|\s*$)/iu;
const MAX_CREDENTIAL_BYTES = 8_192;
const MAX_IDEMPOTENCY_KEY_BYTES = 1_024;
const outputAjv = new Ajv({ allErrors: true, strict: false });

const FORBIDDEN_HEADERS = new Set([
  'accept-encoding',
  'authorization',
  'connection',
  'content-length',
  'cookie',
  'forwarded',
  'host',
  'keep-alive',
  'origin',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'referer',
  'set-cookie',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'via',
]);
const SENSITIVE_STATIC_HEADER = /(?:^|-)(?:api-key|token|secret|password|signature|credential)(?:-|$)/iu;

export interface JsonApiIntegrationOptions {
  /** Injectable only for qualification/tests. The production default is the host fetch. */
  readonly fetch?: typeof globalThis.fetch;
  /** Credential values are looked up for every call, allowing host-managed rotation. */
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

export interface JsonApiTransportDependencies extends JsonApiIntegrationOptions {
  readonly networkPolicy?: OutboundNetworkPolicy;
  /** Exact loaded-file digest when available; credential values are never part of it. */
  readonly manifestSha256?: string;
}

interface CompiledValueSource {
  readonly source: 'input' | 'literal';
  readonly name?: string;
  readonly value?: JsonValue;
}

interface CompiledPathSegment {
  readonly literal?: string;
  readonly variable?: CompiledValueSource;
}

interface CompiledOperation {
  readonly name: string;
  readonly remoteName: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
  readonly outputSchema: JsonObject;
  readonly outputValidator: ValidateFunction;
  readonly outputProperties: readonly string[];
  readonly effect: ToolEffect;
  readonly idempotency: ToolDefinition['idempotency'];
  readonly method: JsonApiIntegrationToolConfig['method'];
  readonly pathTemplate: string;
  readonly pathVariables: Readonly<Record<string, CompiledValueSource>>;
  readonly pathSegments: readonly CompiledPathSegment[];
  readonly query: Readonly<Record<string, CompiledValueSource>>;
  readonly body: Readonly<Record<string, CompiledValueSource>>;
  readonly successStatuses: ReadonlySet<number>;
  readonly successStatusList: readonly number[];
  readonly idempotencyKeyHeader?: string;
  readonly limits: McpToolLimits;
}

interface PreparedRequest {
  readonly url: URL;
  readonly headers: Headers;
  readonly body?: string;
}

/**
 * Mount a reviewed JSON API manifest through the ordinary MCP-shaped gateway.
 *
 * The gateway remains the sole tool registration boundary, so grants, effect
 * policy, durable approvals, timeouts, schema validation, and snapshots apply
 * exactly as they do to every other local tool transport.
 */
export function createJsonApiIntegrationPlugin(
  loaded: LoadedIntegrationManifest,
  networkPolicy: OutboundNetworkPolicy,
  options: JsonApiIntegrationOptions = {},
): HarnessPlugin {
  if (!SHA256_PATTERN.test(loaded.sha256)) {
    throw new Error('JSON API integration requires a valid loaded manifest digest');
  }
  if (loaded.manifest.transport.kind !== 'json-api') {
    throw new Error('JSON API integration factory requires a json-api manifest');
  }

  const manifest = loaded.manifest as JsonApiIntegrationManifest;
  const compiled = compileManifest(manifest);
  const transport = createJsonApiTransport(manifest, {
    networkPolicy,
    manifestSha256: loaded.sha256,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.environment ? { environment: options.environment } : {}),
  });

  const declarations: LocalMcpToolDeclaration[] = compiled.operations.map((operation) => ({
    name: operation.name,
    remoteName: operation.remoteName,
    description: operation.description,
    inputSchema: operation.inputSchema,
    outputSchema: operation.outputSchema,
    effect: operation.effect,
    dataBoundary: 'external',
    idempotency: operation.idempotency,
    limits: operation.limits,
  }));

  return mcpToolGatewayPlugin({
    id: `json-${loaded.sha256.slice(0, 32)}`,
    transport,
    tools: declarations,
  });
}

/**
 * Build only the reviewed transport for callers that compose their own local
 * declarations with `mcpToolGatewayPlugin`.
 *
 * Passing `manifestSha256` binds the exact loaded file. Without it, the
 * snapshot still commits to a deterministic contract digest over this parsed
 * manifest, and a configured loader can add the exact file digest later.
 */
export function createJsonApiTransport(
  manifest: JsonApiIntegrationManifest,
  dependencies?: JsonApiTransportDependencies,
): McpCallToolTransport;
export function createJsonApiTransport(
  manifest: IntegrationManifest,
  dependencies?: JsonApiTransportDependencies,
): McpCallToolTransport;
export function createJsonApiTransport(
  manifest: IntegrationManifest,
  dependencies: JsonApiTransportDependencies = {},
): McpCallToolTransport {
  validateIntegrationManifest(manifest);
  if (dependencies.manifestSha256 !== undefined && !SHA256_PATTERN.test(dependencies.manifestSha256)) {
    throw new Error('JSON API integration received an invalid manifest digest');
  }
  if (manifest.transport.kind !== 'json-api') {
    throw new Error('JSON API transport factory requires a json-api manifest');
  }
  const jsonManifest = manifest as JsonApiIntegrationManifest;
  const compiled = compileManifest(jsonManifest);
  const contractSha256 = createHash('sha256')
    .update(JSON.stringify(jsonManifest))
    .digest('hex');
  return new JsonApiTransport({
    manifestId: jsonManifest.id,
    ...(dependencies.manifestSha256 === undefined
      ? {}
      : { manifestSha256: dependencies.manifestSha256 }),
    contractSha256,
    origin: compiled.origin,
    auth: compiled.auth,
    staticHeaders: compiled.staticHeaders,
    operations: compiled.operations,
    networkPolicy: dependencies.networkPolicy ?? createNetworkPolicy(),
    fetch: dependencies.fetch ?? globalThis.fetch,
    environment: dependencies.environment ?? process.env,
  });
}

interface CompiledManifest {
  readonly origin: string;
  readonly auth: JsonApiAuthConfig;
  readonly staticHeaders: Readonly<Record<string, string>>;
  readonly operations: readonly CompiledOperation[];
}

function compileManifest(manifest: JsonApiIntegrationManifest): CompiledManifest {
  if (manifest.transport.kind !== 'json-api') throw new Error('Expected a JSON API transport');
  const origin = validateOrigin(manifest.transport.baseUrl);
  const staticHeaders = compileStaticHeaders(manifest.transport);
  const auth = compileAuth(manifest.transport.auth, staticHeaders);
  const operations = Object.freeze(manifest.tools.map((tool) =>
    compileOperation(tool, staticHeaders, auth),
  ));
  if (operations.length < 1) throw new Error('JSON API manifest must declare at least one operation');
  if (new Set(operations.map((operation) => operation.name)).size !== operations.length) {
    throw new Error('JSON API manifest contains duplicate local operation names');
  }
  if (new Set(operations.map((operation) => operation.remoteName)).size !== operations.length) {
    throw new Error('JSON API manifest contains duplicate remote operation names');
  }
  return { origin, auth, staticHeaders, operations };
}

interface JsonApiTransportOptions {
  readonly manifestId: string;
  readonly manifestSha256?: string;
  readonly contractSha256: string;
  readonly origin: string;
  readonly auth: JsonApiAuthConfig;
  readonly staticHeaders: Readonly<Record<string, string>>;
  readonly operations: readonly CompiledOperation[];
  readonly networkPolicy: OutboundNetworkPolicy;
  readonly fetch: typeof globalThis.fetch;
  readonly environment: Readonly<Record<string, string | undefined>>;
}

class JsonApiTransport implements McpCallToolTransport {
  readonly id: string;
  readonly snapshotBinding: JsonObject;

  readonly #manifestId: string;
  readonly #origin: string;
  readonly #auth: JsonApiAuthConfig;
  readonly #staticHeaders: Readonly<Record<string, string>>;
  readonly #operations: ReadonlyMap<string, CompiledOperation>;
  readonly #networkPolicy: OutboundNetworkPolicy;
  readonly #fetch: typeof globalThis.fetch;
  readonly #environment: Readonly<Record<string, string | undefined>>;

  constructor(options: JsonApiTransportOptions) {
    this.id = `json-api:${(options.manifestSha256 ?? options.contractSha256).slice(0, 32)}`;
    this.#manifestId = options.manifestId;
    this.#origin = options.origin;
    this.#auth = options.auth;
    this.#staticHeaders = options.staticHeaders;
    this.#operations = new Map(options.operations.map((operation) => [operation.remoteName, operation]));
    this.#networkPolicy = options.networkPolicy;
    this.#fetch = options.fetch;
    this.#environment = options.environment;
    this.snapshotBinding = snapshotBinding(options);
  }

  async start(): Promise<void> {
    this.#networkPolicy.assertAllowed(
      this.#origin,
      `JSON API integration ${this.#manifestId} startup`,
    );
    // Resolve and validate, but never retain, the current credential value.
    resolveAuthHeader(this.#auth, this.#environment);
  }

  async callTool(request: McpCallToolRequest, options: McpCallToolOptions): Promise<unknown> {
    const operation = this.#operations.get(request.name);
    if (!operation) throw new ToolExecutionError('JSON_API_OPERATION_DENIED', 'JSON API operation is not declared');
    if (options.idempotency !== operation.idempotency || options.timeoutMs !== operation.limits.timeoutMs) {
      throw new ToolExecutionError('JSON_API_CONTRACT_MISMATCH', 'JSON API host contract does not match the manifest');
    }
    if (options.signal.aborted) {
      throw new ToolExecutionError('JSON_API_ABORTED', 'The JSON API request was cancelled');
    }

    const prepared = prepareRequest(
      this.#origin,
      this.#auth,
      this.#staticHeaders,
      this.#environment,
      operation,
      request.arguments,
      options.idempotencyKey,
    );
    this.#networkPolicy.assertAllowed(
      prepared.url,
      `JSON API integration ${this.#manifestId} operation ${operation.remoteName}`,
    );

    let sendAttempted = false;
    try {
      sendAttempted = true;
      const response = await this.#fetch(prepared.url, {
        method: operation.method,
        headers: prepared.headers,
        ...(prepared.body === undefined ? {} : { body: prepared.body }),
        signal: options.signal,
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
      });
      await assertReviewedResponse(response, prepared.url, operation);
      const text = await readBoundedDecodedBody(response, operation.limits.maxResponseBytes);
      const projected = parseAndProjectResponse(text, operation);
      if (operation.idempotency !== 'read' && !operation.outputValidator(projected)) {
        throw new ToolExecutionError(
          'JSON_API_RESPONSE_SCHEMA_INVALID',
          'JSON API response does not match the reviewed output schema',
        );
      }
      return {
        content: [],
        structuredContent: projected,
      };
    } catch {
      if (sendAttempted && operation.idempotency !== 'read') {
        throw new ToolExecutionError(
          TOOL_EXECUTION_AMBIGUOUS_CODE,
          'The JSON API write may have completed',
        );
      }
      throw new ToolExecutionError('JSON_API_TRANSPORT_ERROR', 'The JSON API request failed');
    }
  }
}

function validateOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('JSON API baseUrl must be an exact HTTP(S) origin');
  }
  if (
    value !== url.origin
    || url.pathname !== '/'
    || url.search
    || url.hash
    || url.username
    || url.password
  ) {
    throw new Error('JSON API baseUrl must be an exact origin without credentials, path, query, or fragment');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHostname(url.hostname))) {
    throw new Error('JSON API integrations require HTTPS except for exact loopback HTTP origins');
  }
  return url.origin;
}

function compileStaticHeaders(transport: JsonApiTransportConfig): Readonly<Record<string, string>> {
  const headers = Object.create(null) as Record<string, string>;
  for (const [rawName, value] of Object.entries(transport.staticHeaders).sort(([left], [right]) =>
    compareAscii(left, right),
  )) {
    const name = validateSafeHeaderName(rawName, 'static');
    if (Object.hasOwn(headers, name)) throw new Error('JSON API static headers collide by case');
    validateSafeHeaderValue(value, 'JSON API static header');
    headers[name] = value;
  }
  return Object.freeze(headers);
}

function compileAuth(
  auth: JsonApiAuthConfig,
  staticHeaders: Readonly<Record<string, string>>,
): JsonApiAuthConfig {
  if (auth.kind === 'none') return Object.freeze({ kind: 'none' });
  if (auth.kind === 'bearer') {
    validateEnvironmentName(auth.tokenEnv);
    if (Object.hasOwn(staticHeaders, 'authorization')) {
      throw new Error('JSON API bearer authentication conflicts with a static header');
    }
    return Object.freeze({ kind: 'bearer', tokenEnv: auth.tokenEnv });
  }
  const header = validateSafeHeaderName(auth.header, 'authentication');
  validateEnvironmentName(auth.valueEnv);
  if (Object.hasOwn(staticHeaders, header)) {
    throw new Error('JSON API authentication header conflicts with a static header');
  }
  return Object.freeze({ kind: 'header', header, valueEnv: auth.valueEnv });
}

function compileOperation(
  tool: JsonApiIntegrationToolConfig,
  staticHeaders: Readonly<Record<string, string>>,
  auth: JsonApiAuthConfig,
): CompiledOperation {
  if (tool.dataBoundary !== 'external') throw new Error('JSON API tools must declare an external data boundary');
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(tool.method)) {
    throw new Error('JSON API tool uses an unsupported method');
  }
  const path = compilePath(tool.pathTemplate.template, tool.pathTemplate.variables);
  const query = compileSourceMap(tool.query, 'query');
  const body = compileSourceMap(tool.body, 'body');
  if ((tool.method === 'GET' || tool.method === 'DELETE') && Object.keys(body).length > 0) {
    throw new Error('JSON API GET and DELETE operations cannot send request bodies');
  }

  const successStatusList = [...tool.successStatuses].sort((left, right) => left - right);
  if (
    successStatusList.length < 1
    || new Set(successStatusList).size !== successStatusList.length
    || successStatusList.some((status) => !Number.isInteger(status) || status < 200 || status > 299)
  ) {
    throw new Error('JSON API operations require unique explicit 2xx success statuses');
  }

  const keyed = tool.idempotency === 'keyed';
  if (keyed !== (tool.idempotencyKeyHeader !== undefined)) {
    throw new Error('JSON API keyed operations require exactly one idempotency header');
  }
  let idempotencyKeyHeader: string | undefined;
  if (tool.idempotencyKeyHeader !== undefined) {
    idempotencyKeyHeader = validateSafeHeaderName(tool.idempotencyKeyHeader, 'idempotency');
    const authHeader = auth.kind === 'bearer'
      ? 'authorization'
      : auth.kind === 'header'
        ? auth.header.toLowerCase()
        : undefined;
    if (Object.hasOwn(staticHeaders, idempotencyKeyHeader) || idempotencyKeyHeader === authHeader) {
      throw new Error('JSON API idempotency header conflicts with a reviewed transport header');
    }
  }

  if (!isPlainObject(tool.outputSchema.properties)) {
    throw new Error('JSON API output schema must declare an exact object property map');
  }
  const outputProperties = Object.freeze(Object.keys(tool.outputSchema.properties).sort());
  for (const property of outputProperties) assertSafeObjectKey(property, 'JSON API output property');
  const outputValidator = outputAjv.compile(tool.outputSchema);

  const limits = Object.freeze({ ...tool.limits });
  // The gateway performs the authoritative full validation. These checks make
  // the values safe to use while constructing the transport snapshot first.
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < (name === 'maxTextBytes' ? 0 : 1)) {
      throw new Error('JSON API operation contains invalid limits');
    }
  }
  if (limits.maxTextBytes > limits.maxResponseBytes) {
    throw new Error('JSON API maxTextBytes cannot exceed maxResponseBytes');
  }

  return Object.freeze({
    name: tool.name,
    remoteName: tool.remoteName,
    description: tool.description,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
    outputValidator,
    outputProperties,
    effect: tool.effect,
    idempotency: tool.idempotency,
    method: tool.method,
    pathTemplate: tool.pathTemplate.template,
    pathVariables: path.variables,
    pathSegments: path.segments,
    query,
    body,
    successStatuses: new Set(successStatusList),
    successStatusList: Object.freeze(successStatusList),
    ...(idempotencyKeyHeader === undefined ? {} : { idempotencyKeyHeader }),
    limits,
  });
}

function compilePath(
  template: string,
  rawVariables: Readonly<Record<string, JsonApiValueSource>>,
): {
  variables: Readonly<Record<string, CompiledValueSource>>;
  segments: readonly CompiledPathSegment[];
} {
  if (
    !template.startsWith('/')
    || template.includes('//')
    || template.includes('?')
    || template.includes('#')
    || /[\\\u0000-\u001f\u007f]/u.test(template)
  ) {
    throw new Error('JSON API path template is unsafe');
  }
  const variables = compileSourceMap(rawVariables, 'path');
  const usedVariables = new Set<string>();
  const rawSegments = template === '/' ? [] : template.slice(1).split('/');
  if (rawSegments.some((segment) => segment.length === 0)) {
    throw new Error('JSON API path template contains an empty segment');
  }
  const segments = rawSegments.map((segment): CompiledPathSegment => {
    const match = /^\{([A-Za-z0-9][A-Za-z0-9_.~-]{0,127})\}$/u.exec(segment);
    if (match) {
      const name = match[1]!;
      const source = variables[name];
      if (!source) throw new Error('JSON API path variable is not structurally mapped');
      if (source.source === 'literal' && source.value === null) {
        throw new Error('JSON API path variable cannot be null');
      }
      usedVariables.add(name);
      return Object.freeze({ variable: source });
    }
    if (
      segment === '.'
      || segment === '..'
      || segment.includes('{')
      || segment.includes('}')
      || segment.includes('%')
      || !STATIC_PATH_SEGMENT_PATTERN.test(segment)
    ) {
      throw new Error('JSON API path template contains an unsafe literal segment');
    }
    return Object.freeze({ literal: segment });
  });
  if (
    usedVariables.size !== Object.keys(variables).length
    || Object.keys(variables).some((name) => !usedVariables.has(name))
  ) {
    throw new Error('JSON API path variables must exactly match whole-segment placeholders');
  }
  return { variables, segments: Object.freeze(segments) };
}

function compileSourceMap(
  mapping: Readonly<Record<string, JsonApiValueSource>>,
  location: 'path' | 'query' | 'body',
): Readonly<Record<string, CompiledValueSource>> {
  const compiled = Object.create(null) as Record<string, CompiledValueSource>;
  for (const [name, source] of Object.entries(mapping).sort(([left], [right]) => compareAscii(left, right))) {
    if (!FIELD_NAME_PATTERN.test(name)) throw new Error(`JSON API ${location} mapping contains an unsafe field name`);
    assertSafeObjectKey(name, `JSON API ${location} mapping`);
    if (source.source === 'input') {
      if (!FIELD_NAME_PATTERN.test(source.name)) throw new Error(`JSON API ${location} input source is invalid`);
      compiled[name] = Object.freeze({ source: 'input', name: source.name });
      continue;
    }
    if (source.source !== 'literal' || !isJsonValue(source.value)) {
      throw new Error(`JSON API ${location} mapping must use a literal or top-level input source`);
    }
    if (location !== 'body' && !isJsonPrimitive(source.value)) {
      throw new Error(`JSON API ${location} literal must be a JSON primitive`);
    }
    compiled[name] = Object.freeze({ source: 'literal', value: cloneJsonValue(source.value) });
  }
  return Object.freeze(compiled);
}

function prepareRequest(
  origin: string,
  auth: JsonApiAuthConfig,
  staticHeaders: Readonly<Record<string, string>>,
  environment: Readonly<Record<string, string | undefined>>,
  operation: CompiledOperation,
  input: JsonObject,
  idempotencyKey: string,
): PreparedRequest {
  const path = operation.pathSegments.length === 0
    ? '/'
    : `/${operation.pathSegments.map((segment) => {
      if (segment.literal !== undefined) return segment.literal;
      const value = resolveSource(segment.variable!, input);
      return encodePathSegment(value);
    }).join('/')}`;
  const query = Object.entries(operation.query).map(([name, source]) => {
    const value = resolveSource(source, input);
    if (!isJsonPrimitive(value)) throw new ToolExecutionError('JSON_API_INPUT_INVALID', 'JSON API query value must be primitive');
    return `${strictPercentEncode(name)}=${strictPercentEncode(primitiveString(value))}`;
  }).join('&');
  const url = new URL(`${origin}${path}${query ? `?${query}` : ''}`);
  if (url.origin !== origin || url.username || url.password || url.hash) {
    throw new ToolExecutionError('JSON_API_URL_INVALID', 'JSON API request escaped its reviewed origin');
  }

  const headers = new Headers();
  for (const [name, value] of Object.entries(staticHeaders)) headers.set(name, value);
  if (!headers.has('accept')) headers.set('accept', 'application/json');
  headers.set('accept-encoding', 'identity');
  const authHeader = resolveAuthHeader(auth, environment);
  if (authHeader) headers.set(authHeader.name, authHeader.value);

  if (operation.idempotency === 'keyed') {
    validateIdempotencyKey(idempotencyKey);
    headers.set(operation.idempotencyKeyHeader!, idempotencyKey);
  }

  let body: string | undefined;
  if (Object.keys(operation.body).length > 0) {
    const value = Object.create(null) as JsonObject;
    for (const [name, source] of Object.entries(operation.body)) {
      value[name] = cloneJsonValue(resolveSource(source, input));
    }
    body = JSON.stringify(value);
    if (!headers.has('content-type')) headers.set('content-type', 'application/json');
    if (!JSON_CONTENT_TYPE_PATTERN.test(headers.get('content-type')!)) {
      throw new ToolExecutionError('JSON_API_HEADER_INVALID', 'JSON API request body requires a JSON content type');
    }
  }

  let headerBytes = 0;
  headers.forEach((value, name) => {
    headerBytes += byteLength(name) + byteLength(value) + 4;
  });
  const requestBytes = byteLength(operation.method)
    + byteLength(url.href)
    + headerBytes
    + (body === undefined ? 0 : byteLength(body));
  if (requestBytes > operation.limits.maxRequestBytes) {
    throw new ToolExecutionError('JSON_API_REQUEST_TOO_LARGE', 'JSON API request exceeds its reviewed byte limit');
  }
  return { url, headers, ...(body === undefined ? {} : { body }) };
}

function resolveSource(source: CompiledValueSource, input: JsonObject): JsonValue {
  if (source.source === 'literal') return source.value!;
  if (!source.name || !Object.hasOwn(input, source.name)) {
    throw new ToolExecutionError('JSON_API_INPUT_INVALID', 'JSON API input is missing a mapped top-level property');
  }
  const value = input[source.name];
  if (!isJsonValue(value)) {
    throw new ToolExecutionError('JSON_API_INPUT_INVALID', 'JSON API input is not lossless JSON');
  }
  return value;
}

function encodePathSegment(value: JsonValue): string {
  if (!isJsonPrimitive(value) || value === null) {
    throw new ToolExecutionError('JSON_API_INPUT_INVALID', 'JSON API path value must be a non-null primitive');
  }
  const raw = primitiveString(value);
  if (
    raw.length === 0
    || raw === '.'
    || raw === '..'
    || raw.includes('/')
    || raw.includes('\\')
    || raw.includes('%')
    || /[\u0000-\u001f\u007f]/u.test(raw)
  ) {
    throw new ToolExecutionError('JSON_API_INPUT_INVALID', 'JSON API path value is not one safe segment');
  }
  return strictPercentEncode(raw);
}

function primitiveString(value: JsonPrimitive): string {
  if (value === null) return 'null';
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new ToolExecutionError('JSON_API_INPUT_INVALID', 'JSON API numeric input must be finite');
  }
  return String(value);
}

function strictPercentEncode(value: string): string {
  try {
    return encodeURIComponent(value).replace(/[!'()*]/gu, (character) =>
      `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`,
    );
  } catch {
    throw new ToolExecutionError('JSON_API_INPUT_INVALID', 'JSON API input cannot be safely encoded');
  }
}

function resolveAuthHeader(
  auth: JsonApiAuthConfig,
  environment: Readonly<Record<string, string | undefined>>,
): { name: string; value: string } | undefined {
  if (auth.kind === 'none') return undefined;
  const credential = environment[auth.kind === 'bearer' ? auth.tokenEnv : auth.valueEnv];
  if (
    credential === undefined
    || credential.length === 0
    || credential.trim() !== credential
    || byteLength(credential) > MAX_CREDENTIAL_BYTES
    || /[\u0000-\u001f\u007f]/u.test(credential)
  ) {
    throw new ToolExecutionError('JSON_API_AUTH_UNAVAILABLE', 'The JSON API credential is unavailable');
  }
  return auth.kind === 'bearer'
    ? { name: 'authorization', value: `Bearer ${credential}` }
    : { name: auth.header, value: credential };
}

async function assertReviewedResponse(
  response: Response,
  requestedUrl: URL,
  operation: CompiledOperation,
): Promise<void> {
  if (
    response.redirected
    || response.type === 'opaqueredirect'
    || (response.url !== '' && response.url !== requestedUrl.href)
  ) {
    await cancelBody(response);
    throw new ToolExecutionError('JSON_API_REDIRECT_DENIED', 'JSON API redirects are forbidden');
  }
  if (!operation.successStatuses.has(response.status)) {
    await cancelBody(response);
    throw new ToolExecutionError('JSON_API_STATUS_DENIED', 'JSON API returned an undeclared status');
  }
  const contentType = response.headers.get('content-type');
  if (contentType === null || !JSON_CONTENT_TYPE_PATTERN.test(contentType)) {
    await cancelBody(response);
    throw new ToolExecutionError('JSON_API_CONTENT_TYPE_DENIED', 'JSON API response is not JSON');
  }
}

async function readBoundedDecodedBody(response: Response, maximum: number): Promise<string> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(contentLength) || Number(contentLength) > maximum) {
      await cancelBody(response);
      throw new ToolExecutionError('JSON_API_RESPONSE_TOO_LARGE', 'JSON API response exceeds its reviewed byte limit');
    }
  }
  if (!response.body) throw new ToolExecutionError('JSON_API_RESPONSE_INVALID', 'JSON API response body is missing');

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maximum) {
        try {
          await reader.cancel();
        } catch {
          // Preserve the bounded-response failure.
        }
        throw new ToolExecutionError('JSON_API_RESPONSE_TOO_LARGE', 'JSON API response exceeds its reviewed byte limit');
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } catch (error) {
    try {
      await reader.cancel();
    } catch {
      // Preserve the bounded/decoded response failure.
    }
    if (error instanceof ToolExecutionError) throw error;
    throw new ToolExecutionError('JSON_API_RESPONSE_INVALID', 'JSON API response could not be decoded');
  } finally {
    reader.releaseLock();
  }
}

function parseAndProjectResponse(text: string, operation: CompiledOperation): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new ToolExecutionError('JSON_API_RESPONSE_INVALID', 'JSON API response contains invalid JSON');
  }
  const source: JsonObject = Array.isArray(parsed)
    ? { data: parsed as JsonValue[] }
    : isPlainObject(parsed)
      ? parsed
      : (() => {
          throw new ToolExecutionError(
            'JSON_API_RESPONSE_INVALID',
            'JSON API response must be an object or an array with a declared data envelope',
          );
        })();
  const projected = Object.create(null) as JsonObject;
  for (const property of operation.outputProperties) {
    if (Object.hasOwn(source, property)) projected[property] = source[property]!;
  }
  if (countStringBytes(projected) > operation.limits.maxTextBytes) {
    throw new ToolExecutionError('JSON_API_RESPONSE_TOO_LARGE', 'JSON API response text exceeds its reviewed byte limit');
  }
  return projected;
}

function snapshotBinding(options: JsonApiTransportOptions): JsonObject {
  const auth: JsonObject = options.auth.kind === 'none'
    ? { kind: 'none', resolution: 'environment-per-call' }
    : options.auth.kind === 'bearer'
      ? {
          kind: 'bearer',
          tokenEnv: options.auth.tokenEnv,
          resolution: 'environment-per-call',
        }
      : {
          kind: 'header',
          header: options.auth.header,
          valueEnv: options.auth.valueEnv,
          resolution: 'environment-per-call',
        };
  return {
    protocol: 'openprojects.json-api.v1',
    manifestId: options.manifestId,
    manifestSha256: options.manifestSha256 ?? null,
    contractSha256: options.contractSha256,
    origin: options.origin,
    auth,
    staticHeaders: cloneStringMap(options.staticHeaders),
    redirect: 'error',
    credentials: 'omit',
    retry: 'none',
    operations: options.operations.map((operation): JsonObject => ({
      name: operation.name,
      remoteName: operation.remoteName,
      method: operation.method,
      pathTemplate: operation.pathTemplate,
      pathVariables: snapshotSourceMap(operation.pathVariables),
      query: snapshotSourceMap(operation.query),
      body: snapshotSourceMap(operation.body),
      successStatuses: [...operation.successStatusList],
      idempotency: operation.idempotency,
      idempotencyKeyHeader: operation.idempotencyKeyHeader ?? null,
      outputProjection: [...operation.outputProperties],
      limits: { ...operation.limits },
    })),
  };
}

function snapshotSourceMap(mapping: Readonly<Record<string, CompiledValueSource>>): JsonObject {
  const snapshot = Object.create(null) as JsonObject;
  for (const [name, source] of Object.entries(mapping)) {
    snapshot[name] = source.source === 'input'
      ? { source: 'input', name: source.name! }
      : { source: 'literal', value: cloneJsonValue(source.value!) };
  }
  return snapshot;
}

function cloneStringMap(mapping: Readonly<Record<string, string>>): JsonObject {
  const clone = Object.create(null) as JsonObject;
  for (const [name, value] of Object.entries(mapping)) clone[name] = value;
  return clone;
}

function validateSafeHeaderName(value: string, purpose: string): string {
  if (!HEADER_NAME_PATTERN.test(value)) throw new Error(`JSON API ${purpose} header name is invalid`);
  const lower = value.toLowerCase();
  if (
    FORBIDDEN_HEADERS.has(lower)
    || lower.startsWith('proxy-')
    || lower.startsWith('sec-')
    || lower.startsWith('x-forwarded-')
    || (purpose === 'static' && SENSITIVE_STATIC_HEADER.test(lower))
  ) {
    throw new Error(`JSON API ${purpose} header is forbidden`);
  }
  return lower;
}

function validateSafeHeaderValue(value: string, label: string): void {
  if (
    value.length === 0
    || value.trim() !== value
    || byteLength(value) > 1_024
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`${label} value is unsafe`);
  }
}

function validateEnvironmentName(value: string): void {
  if (!ENV_NAME_PATTERN.test(value)) throw new Error('JSON API credential environment name is invalid');
}

function validateIdempotencyKey(value: string): void {
  if (
    value.length === 0
    || byteLength(value) > MAX_IDEMPOTENCY_KEY_BYTES
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new ToolExecutionError('JSON_API_IDEMPOTENCY_KEY_INVALID', 'Host idempotency key is invalid');
  }
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Error bodies are intentionally discarded and never allowed to replace
    // the reviewed status/content-type failure.
  }
}

function countStringBytes(value: JsonValue): number {
  let total = 0;
  const pending: JsonValue[] = [value];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (typeof current === 'string') {
      total += byteLength(current);
    } else if (Array.isArray(current)) {
      pending.push(...current);
    } else if (isPlainObject(current)) {
      pending.push(...Object.values(current));
    }
  }
  return total;
}

function cloneJsonValue(value: JsonValue): JsonValue {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => cloneJsonValue(item));
  const clone = Object.create(null) as JsonObject;
  for (const [name, item] of Object.entries(value)) {
    assertSafeObjectKey(name, 'JSON API JSON value');
    clone[name] = cloneJsonValue(item);
  }
  return clone;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (isJsonPrimitive(value)) return true;
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item));
  return isPlainObject(value) && Object.entries(value).every(([name, item]) =>
    isSafeObjectKey(name) && isJsonValue(item),
  );
}

function isJsonPrimitive(value: unknown): value is JsonPrimitive {
  return value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
    || (
      typeof value === 'number'
      && Number.isFinite(value)
      && !Object.is(value, -0)
      && (!Number.isInteger(value) || Number.isSafeInteger(value))
    );
}

function isPlainObject(value: unknown): value is JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertSafeObjectKey(value: string, label: string): void {
  if (!isSafeObjectKey(value)) throw new Error(`${label} contains a dangerous object key`);
}

function isSafeObjectKey(value: string): boolean {
  return value !== '__proto__' && value !== 'prototype' && value !== 'constructor';
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
