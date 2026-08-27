import { createHash } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import { Ajv } from 'ajv';
import YAML from 'yaml';

import type {
  JsonObject,
  JsonValue,
  ToolDefinition,
  ToolEffect,
} from '../core/types.js';
import { isLoopbackHostname } from '../privacy/network-policy.js';
import { isShellFreeExecutablePath } from '../runtime/executable-path.js';
import { filesystemPathKey } from '../runtime/filesystem-path.js';

export const INTEGRATION_MANIFEST_SCHEMA = 'openprojects.integration.v1' as const;
export const MAX_INTEGRATION_MANIFEST_BYTES = 1_048_576;

const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/;
const TOOL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const FIELD_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.~-]{0,127}$/;
const HEADER_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9-]{0,126}$/;
const MAX_DESCRIPTION_BYTES = 4_096;
const MAX_SCHEMA_BYTES = 65_536;
const MAX_SCHEMA_DEPTH = 32;
const MAX_SCHEMA_NODES = 20_000;
const MAX_TOOL_REQUEST_BYTES = 65_536;
const MAX_TOOL_RESPONSE_BYTES = 262_144;
const MAX_TOOL_TEXT_BYTES = 65_536;
const MAX_TOOL_TIMEOUT_MS = 30_000;
const MAX_TRANSPORT_WIRE_BYTES = 1_048_576;
const MAX_STDERR_BYTES = 262_144;
const MAX_STARTUP_TIMEOUT_MS = 60_000;
const MAX_SHUTDOWN_TIMEOUT_MS = 30_000;
const MAX_PENDING_REQUESTS = 64;
const MAX_PATH_TEMPLATE_BYTES = 2_048;
const MAX_MAPPING_ENTRIES = 128;
const MAX_LITERAL_BYTES = 16_384;

const FORBIDDEN_STATIC_HEADERS = new Set([
  'authorization',
  'connection',
  'content-length',
  'cookie',
  'host',
  'keep-alive',
  'proxy-authorization',
  'set-cookie',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
const SENSITIVE_CREDENTIAL_NAME = /(?:^|[._~-])(?:access[._~-]?token|api[._~-]?key|bearer[._~-]?token|token|secret|password|signature|credential|authorization)(?:$|[._~-])/iu;

export type McpProtocolVersion = 'legacy' | 'auto' | '2026-07-28';
export type IntegrationDataBoundary = 'local' | 'external';

export interface IntegrationToolLimits {
  readonly timeoutMs: number;
  readonly maxRequestBytes: number;
  readonly maxResponseBytes: number;
  readonly maxTextBytes: number;
}

interface IntegrationToolBaseConfig {
  /** Local name exposed to the agent, grants, policy, approvals, and snapshots. */
  readonly name: string;
  /** Exact reviewed operation name sent to the integration. */
  readonly remoteName: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
  readonly outputSchema: JsonObject;
  readonly effect: ToolEffect;
  readonly idempotency: ToolDefinition['idempotency'];
  /** Explicit host-reviewed trust boundary; never inferred from remote metadata. */
  readonly dataBoundary: IntegrationDataBoundary;
  readonly limits: IntegrationToolLimits;
}

export interface McpIntegrationToolConfig extends IntegrationToolBaseConfig {}

export interface McpStdioTransportConfig {
  readonly kind: 'mcp-stdio';
  /** Absolute executable path. PATH lookup and shell evaluation are forbidden. */
  readonly command: string;
  /** Literal argv entries. No shell parsing or interpolation is performed. */
  readonly argv: string[];
  /** Absolute child working directory. */
  readonly cwd: string;
  /** Child variable name -> source process variable name. Values are never manifested. */
  readonly env: Record<string, string>;
  readonly protocol: McpProtocolVersion;
  readonly expectedServerName: string;
  readonly expectedServerVersion: string;
  readonly maxWireBytes: number;
  readonly maxStderrBytes: number;
  readonly startupTimeoutMs: number;
  readonly shutdownTimeoutMs: number;
  readonly maxPendingRequests: number;
}

export interface McpHttpTransportConfig {
  readonly kind: 'mcp-http';
  /** Exact normalized HTTP(S) endpoint; redirects are never part of this contract. */
  readonly endpoint: string;
  /** Source process variable containing the static bearer credential. */
  /** Optional only for an exact loopback endpoint; remote MCP requires a credential reference. */
  readonly bearerTokenEnv?: string;
  readonly protocol: McpProtocolVersion;
  readonly expectedServerName: string;
  readonly expectedServerVersion: string;
  readonly maxWireBytes: number;
  readonly startupTimeoutMs: number;
  readonly maxPendingRequests: number;
}

export type McpTransportConfig = McpStdioTransportConfig | McpHttpTransportConfig;

export type JsonApiAuthConfig =
  | { readonly kind: 'none' }
  | { readonly kind: 'bearer'; readonly tokenEnv: string }
  | { readonly kind: 'header'; readonly header: string; readonly valueEnv: string };

export interface JsonApiTransportConfig {
  readonly kind: 'json-api';
  /** Exact origin only (scheme + host + optional port), without credentials or path. */
  readonly baseUrl: string;
  readonly auth: JsonApiAuthConfig;
  /** Non-secret reviewed headers. Credential and hop-by-hop headers are forbidden. */
  readonly staticHeaders: Record<string, string>;
}

/** A request value is either model-controlled input or an immutable reviewed literal. */
export type JsonApiValueSource =
  | { readonly source: 'input'; readonly name: string }
  | { readonly source: 'literal'; readonly value: JsonValue };

export interface JsonApiPathTemplate {
  /** Literal path with named `{variable}` slots. Values are URL-encoded by the transport. */
  readonly template: string;
  /** Exact slot -> value-source mapping. Raw interpolation is not permitted. */
  readonly variables: Record<string, JsonApiValueSource>;
}

export interface JsonApiIntegrationToolConfig extends IntegrationToolBaseConfig {
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly pathTemplate: JsonApiPathTemplate;
  readonly query: Record<string, JsonApiValueSource>;
  /** Flat JSON object mapping; transport constructs JSON, never an interpolated JSON string. */
  readonly body: Record<string, JsonApiValueSource>;
  readonly successStatuses: number[];
  /** Required exactly when idempotency is `keyed`; value comes from the host run key. */
  readonly idempotencyKeyHeader?: string;
}

interface IntegrationManifestBase {
  readonly schema: typeof INTEGRATION_MANIFEST_SCHEMA;
  readonly id: string;
  /** Omitted means every workspace; when present the allowlist is non-empty. */
  readonly workspaces?: string[];
}

export interface McpIntegrationManifest extends IntegrationManifestBase {
  readonly transport: McpTransportConfig;
  readonly tools: McpIntegrationToolConfig[];
}

export interface JsonApiIntegrationManifest extends IntegrationManifestBase {
  readonly transport: JsonApiTransportConfig;
  readonly tools: JsonApiIntegrationToolConfig[];
}

export type IntegrationManifest = McpIntegrationManifest | JsonApiIntegrationManifest;

export interface LoadedIntegrationManifest {
  /** Absolute manifest path used for this load. */
  readonly path: string;
  /** Bare SHA-256 over the exact bytes read from the regular manifest file. */
  readonly sha256: string;
  readonly manifest: IntegrationManifest;
}

const valueSourceSchema = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['source', 'name'],
      properties: {
        source: { const: 'input' },
        name: { type: 'string', pattern: FIELD_NAME_PATTERN.source },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['source', 'value'],
      properties: {
        source: { const: 'literal' },
        value: {},
      },
    },
  ],
} as const;

const valueSourceMapSchema = {
  type: 'object',
  maxProperties: MAX_MAPPING_ENTRIES,
  propertyNames: { pattern: FIELD_NAME_PATTERN.source },
  additionalProperties: valueSourceSchema,
} as const;

const limitsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['timeoutMs', 'maxRequestBytes', 'maxResponseBytes', 'maxTextBytes'],
  properties: {
    timeoutMs: { type: 'integer', minimum: 1, maximum: MAX_TOOL_TIMEOUT_MS },
    maxRequestBytes: { type: 'integer', minimum: 1, maximum: MAX_TOOL_REQUEST_BYTES },
    maxResponseBytes: { type: 'integer', minimum: 1, maximum: MAX_TOOL_RESPONSE_BYTES },
    maxTextBytes: { type: 'integer', minimum: 0, maximum: MAX_TOOL_TEXT_BYTES },
  },
} as const;

const commonToolProperties = {
  name: { type: 'string', pattern: TOOL_NAME_PATTERN.source },
  remoteName: { type: 'string', pattern: TOOL_NAME_PATTERN.source },
  description: { type: 'string', minLength: 1, maxLength: MAX_DESCRIPTION_BYTES },
  inputSchema: { type: 'object' },
  outputSchema: { type: 'object' },
  effect: {
    enum: ['read', 'draft', 'memory_write', 'internal_write', 'external_write', 'destructive'],
  },
  idempotency: { enum: ['read', 'keyed', 'none'] },
  dataBoundary: { enum: ['local', 'external'] },
  limits: limitsSchema,
} as const;

const commonToolRequired = [
  'name',
  'remoteName',
  'description',
  'inputSchema',
  'outputSchema',
  'effect',
  'idempotency',
  'dataBoundary',
  'limits',
] as const;

const mcpToolSchema = {
  type: 'object',
  additionalProperties: false,
  required: commonToolRequired,
  properties: commonToolProperties,
} as const;

const jsonApiToolSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    ...commonToolRequired,
    'method',
    'pathTemplate',
    'query',
    'body',
    'successStatuses',
  ],
  properties: {
    ...commonToolProperties,
    method: { enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
    pathTemplate: {
      type: 'object',
      additionalProperties: false,
      required: ['template', 'variables'],
      properties: {
        template: { type: 'string', minLength: 1, maxLength: MAX_PATH_TEMPLATE_BYTES },
        variables: valueSourceMapSchema,
      },
    },
    query: valueSourceMapSchema,
    body: valueSourceMapSchema,
    successStatuses: {
      type: 'array',
      minItems: 1,
      maxItems: 16,
      uniqueItems: true,
      items: { type: 'integer', minimum: 200, maximum: 299 },
    },
    idempotencyKeyHeader: { type: 'string', pattern: HEADER_NAME_PATTERN.source },
  },
} as const;

const stdioTransportSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'kind',
    'command',
    'argv',
    'cwd',
    'env',
    'protocol',
    'expectedServerName',
    'expectedServerVersion',
    'maxWireBytes',
    'maxStderrBytes',
    'startupTimeoutMs',
    'shutdownTimeoutMs',
    'maxPendingRequests',
  ],
  properties: {
    kind: { const: 'mcp-stdio' },
    command: { type: 'string', minLength: 1, maxLength: 4096 },
    argv: {
      type: 'array',
      maxItems: 128,
      items: { type: 'string', maxLength: 4096 },
    },
    cwd: { type: 'string', minLength: 1, maxLength: 4096 },
    env: {
      type: 'object',
      maxProperties: 64,
      propertyNames: { pattern: ENV_NAME_PATTERN.source },
      additionalProperties: { type: 'string', pattern: ENV_NAME_PATTERN.source },
    },
    protocol: { enum: ['legacy', 'auto', '2026-07-28'] },
    expectedServerName: { type: 'string', minLength: 1, maxLength: 128 },
    expectedServerVersion: { type: 'string', minLength: 1, maxLength: 128 },
    maxWireBytes: { type: 'integer', minimum: 256, maximum: MAX_TRANSPORT_WIRE_BYTES },
    maxStderrBytes: { type: 'integer', minimum: 0, maximum: MAX_STDERR_BYTES },
    startupTimeoutMs: { type: 'integer', minimum: 100, maximum: MAX_STARTUP_TIMEOUT_MS },
    shutdownTimeoutMs: { type: 'integer', minimum: 100, maximum: MAX_SHUTDOWN_TIMEOUT_MS },
    maxPendingRequests: { type: 'integer', minimum: 1, maximum: MAX_PENDING_REQUESTS },
  },
} as const;

const httpTransportSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'kind',
    'endpoint',
    'protocol',
    'expectedServerName',
    'expectedServerVersion',
    'maxWireBytes',
    'startupTimeoutMs',
    'maxPendingRequests',
  ],
  properties: {
    kind: { const: 'mcp-http' },
    endpoint: { type: 'string', minLength: 1, maxLength: 4096 },
    bearerTokenEnv: { type: 'string', pattern: ENV_NAME_PATTERN.source },
    protocol: { enum: ['legacy', 'auto', '2026-07-28'] },
    expectedServerName: { type: 'string', minLength: 1, maxLength: 128 },
    expectedServerVersion: { type: 'string', minLength: 1, maxLength: 128 },
    maxWireBytes: { type: 'integer', minimum: 256, maximum: MAX_TRANSPORT_WIRE_BYTES },
    startupTimeoutMs: { type: 'integer', minimum: 100, maximum: MAX_STARTUP_TIMEOUT_MS },
    maxPendingRequests: { type: 'integer', minimum: 1, maximum: MAX_PENDING_REQUESTS },
  },
} as const;

const jsonAuthSchema = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind'],
      properties: { kind: { const: 'none' } },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'tokenEnv'],
      properties: {
        kind: { const: 'bearer' },
        tokenEnv: { type: 'string', pattern: ENV_NAME_PATTERN.source },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'header', 'valueEnv'],
      properties: {
        kind: { const: 'header' },
        header: { type: 'string', pattern: HEADER_NAME_PATTERN.source },
        valueEnv: { type: 'string', pattern: ENV_NAME_PATTERN.source },
      },
    },
  ],
} as const;

const jsonTransportSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'baseUrl', 'auth', 'staticHeaders'],
  properties: {
    kind: { const: 'json-api' },
    baseUrl: { type: 'string', minLength: 1, maxLength: 4096 },
    auth: jsonAuthSchema,
    staticHeaders: {
      type: 'object',
      maxProperties: 64,
      propertyNames: { pattern: HEADER_NAME_PATTERN.source },
      additionalProperties: { type: 'string', minLength: 1, maxLength: 1024 },
    },
  },
} as const;

const manifestCommonProperties = {
  schema: { const: INTEGRATION_MANIFEST_SCHEMA },
  id: { type: 'string', pattern: SAFE_ID_PATTERN.source },
  workspaces: {
    type: 'array',
    minItems: 1,
    maxItems: 128,
    uniqueItems: true,
    items: { type: 'string', pattern: SAFE_ID_PATTERN.source },
  },
} as const;

const manifestSchema = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['schema', 'id', 'transport', 'tools'],
      properties: {
        ...manifestCommonProperties,
        transport: stdioTransportSchema,
        tools: { type: 'array', minItems: 1, maxItems: 64, items: mcpToolSchema },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['schema', 'id', 'transport', 'tools'],
      properties: {
        ...manifestCommonProperties,
        transport: httpTransportSchema,
        tools: { type: 'array', minItems: 1, maxItems: 64, items: mcpToolSchema },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['schema', 'id', 'transport', 'tools'],
      properties: {
        ...manifestCommonProperties,
        transport: jsonTransportSchema,
        tools: { type: 'array', minItems: 1, maxItems: 64, items: jsonApiToolSchema },
      },
    },
  ],
} as const;

const ajv = new Ajv({ allErrors: true, strict: false });
const validateManifestShape = ajv.compile(manifestSchema);

/** Load and deeply validate one reviewed integration manifest without resolving credentials. */
export function loadIntegrationManifest(path: string): LoadedIntegrationManifest {
  const absolutePath = resolve(path);
  const bytes = readBoundedRegularFile(absolutePath);
  const parsed = parseManifest(bytes, absolutePath);
  validateIntegrationManifest(parsed, absolutePath);
  const manifest = parsed;
  return {
    path: absolutePath,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    manifest,
  };
}

/**
 * Validate a programmatically supplied manifest through the same strict shape
 * and semantic checks as a file-loaded contract.
 */
export function validateIntegrationManifest(
  value: unknown,
  source = '<programmatic>',
): asserts value is IntegrationManifest {
  try {
    assertPlainJsonValue(value, 'Integration manifest');
  } catch (error) {
    throw new Error(
      `Invalid integration manifest ${source}: ${safeError(error)}`,
    );
  }
  if (!validateManifestShape(value)) {
    throw new Error(`Invalid integration manifest ${source}: ${ajv.errorsText(validateManifestShape.errors, { separator: '; ' })}`);
  }
  validateManifestSemantics(value as unknown as IntegrationManifest);
}

/** Load an exact list and reject ambiguous identities/names across manifest files. */
export function loadIntegrationManifests(paths: readonly string[]): LoadedIntegrationManifest[] {
  if (paths.length > 64) throw new Error('At most 64 integration manifests may be loaded');
  const loaded: LoadedIntegrationManifest[] = [];
  const manifestPaths = new Set<string>();
  const integrationIds = new Set<string>();
  const toolNames = new Set<string>();

  for (const path of paths) {
    const absolutePath = resolve(path);
    const comparisonKey = filesystemPathKey(absolutePath);
    if (manifestPaths.has(comparisonKey)) {
      throw new Error(`Duplicate integration manifest path: ${absolutePath}`);
    }
    manifestPaths.add(comparisonKey);
    const item = loadIntegrationManifest(absolutePath);
    if (integrationIds.has(item.manifest.id)) {
      throw new Error(`Duplicate integration id across manifests: ${item.manifest.id}`);
    }
    integrationIds.add(item.manifest.id);
    for (const tool of item.manifest.tools) {
      if (toolNames.has(tool.name)) {
        throw new Error(`Duplicate integration tool name across manifests: ${tool.name}`);
      }
      toolNames.add(tool.name);
    }
    loaded.push(item);
  }
  return loaded;
}

function readBoundedRegularFile(path: string): Buffer {
  let descriptor: number | undefined;
  try {
    const pathInfo = lstatSync(path);
    if (pathInfo.isSymbolicLink()) {
      throw new Error(`Integration manifest must not be a symbolic link: ${path}`);
    }
    const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
    descriptor = openSync(path, fsConstants.O_RDONLY | noFollow);
    const before = fstatSync(descriptor);
    if (
      pathInfo.dev !== before.dev
      || pathInfo.ino !== before.ino
      || pathInfo.size !== before.size
      || pathInfo.mtimeMs !== before.mtimeMs
      || pathInfo.birthtimeMs !== before.birthtimeMs
    ) {
      throw new Error(`Integration manifest changed while being opened: ${path}`);
    }
    if (!before.isFile()) throw new Error(`Integration manifest must be a regular file: ${path}`);
    if (before.size > MAX_INTEGRATION_MANIFEST_BYTES) {
      throw new Error(`Integration manifest exceeds ${MAX_INTEGRATION_MANIFEST_BYTES} bytes: ${path}`);
    }

    const buffer = Buffer.allocUnsafe(MAX_INTEGRATION_MANIFEST_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const read = readSync(descriptor, buffer, offset, buffer.length - offset, null);
      if (read === 0) break;
      offset += read;
    }
    if (offset > MAX_INTEGRATION_MANIFEST_BYTES) {
      throw new Error(`Integration manifest exceeds ${MAX_INTEGRATION_MANIFEST_BYTES} bytes: ${path}`);
    }
    const after = fstatSync(descriptor);
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || offset !== after.size
    ) {
      throw new Error(`Integration manifest changed while being read: ${path}`);
    }
    return buffer.subarray(0, offset);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ELOOP') throw new Error(`Integration manifest must not be a symbolic link: ${path}`);
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function parseManifest(bytes: Buffer, path: string): unknown {
  const source = bytes.toString('utf8');
  if (Buffer.from(source, 'utf8').compare(bytes) !== 0 || source.includes('\u0000')) {
    throw new Error(`Integration manifest must be valid UTF-8 text without NUL bytes: ${path}`);
  }
  const document = YAML.parseDocument(source, {
    schema: 'core',
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    throw new Error(`Integration manifest contains invalid or duplicate YAML/JSON keys: ${path}`);
  }
  try {
    const parsed = document.toJS({ maxAliasCount: 0 }) as unknown;
    assertPlainJsonValue(parsed, 'Integration manifest');
    return parsed;
  } catch (error) {
    throw new Error(`Integration manifest must contain alias-free plain JSON-compatible data: ${path}: ${safeError(error)}`);
  }
}

function validateManifestSemantics(manifest: IntegrationManifest): void {
  validateUnique(manifest.workspaces ?? [], `integration ${manifest.id} workspace`);
  validateTransport(manifest.transport);
  const localNames = new Set<string>();
  const remoteNames = new Set<string>();
  for (const tool of manifest.tools) {
    if (localNames.has(tool.name)) throw new Error(`Duplicate local tool name in ${manifest.id}: ${tool.name}`);
    if (remoteNames.has(tool.remoteName)) throw new Error(`Duplicate remote tool name in ${manifest.id}: ${tool.remoteName}`);
    localNames.add(tool.name);
    remoteNames.add(tool.remoteName);
    validateCommonTool(tool, manifest.transport.kind);
    if (
      manifest.transport.kind === 'mcp-http'
      && !isLoopbackHostname(new URL(manifest.transport.endpoint).hostname)
      && tool.dataBoundary !== 'external'
    ) {
      throw new Error(`Remote MCP tool ${tool.name} must declare dataBoundary external`);
    }
    if (manifest.transport.kind === 'json-api') {
      validateJsonApiTool(tool as JsonApiIntegrationToolConfig, manifest.transport);
    } else if (tool.idempotency === 'keyed') {
      throw new Error(`MCP tool ${tool.name} cannot declare keyed idempotency`);
    }
  }
}

function validateTransport(transport: McpTransportConfig | JsonApiTransportConfig): void {
  if (transport.kind === 'mcp-stdio') {
    if (!isAbsolute(transport.command) || !isAbsolute(transport.cwd)) {
      throw new Error('MCP stdio command and cwd must be absolute paths');
    }
    if (!isShellFreeExecutablePath(transport.command)) {
      throw new Error('MCP stdio on Windows requires a native .exe or .com command; invoke JavaScript through node.exe rather than a shell shim');
    }
    validateCleanStrings([transport.command, transport.cwd, ...transport.argv], 'MCP stdio process field');
    validateCleanStrings([transport.expectedServerName, transport.expectedServerVersion], 'MCP expected server identity');
    return;
  }
  if (transport.kind === 'mcp-http') {
    validateExactHttpUrl(transport.endpoint, 'MCP HTTP endpoint', false);
    const endpoint = new URL(transport.endpoint);
    if (!transport.bearerTokenEnv && !isLoopbackHostname(endpoint.hostname)) {
      throw new Error('Remote MCP HTTP endpoints require bearerTokenEnv');
    }
    validateCleanStrings([transport.expectedServerName, transport.expectedServerVersion], 'MCP expected server identity');
    return;
  }

  validateExactHttpUrl(transport.baseUrl, 'JSON API baseUrl', true);
  const occupiedHeaders = new Set<string>();
  for (const [name, value] of Object.entries(transport.staticHeaders)) {
    const lower = validateHeaderName(name, 'JSON API static header');
    if (FORBIDDEN_STATIC_HEADERS.has(lower) || SENSITIVE_CREDENTIAL_NAME.test(lower)) {
      throw new Error(`JSON API static header is forbidden: ${name}`);
    }
    if (occupiedHeaders.has(lower)) throw new Error(`Duplicate JSON API static header by case: ${name}`);
    if (value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) {
      throw new Error(`JSON API static header ${name} contains unsafe whitespace or control characters`);
    }
    occupiedHeaders.add(lower);
  }
  if (transport.auth.kind === 'bearer') occupiedHeaders.add('authorization');
  if (transport.auth.kind === 'header') {
    const lower = validateHeaderName(transport.auth.header, 'JSON API auth header');
    if (FORBIDDEN_STATIC_HEADERS.has(lower)) {
      throw new Error(`JSON API auth header is forbidden: ${transport.auth.header}`);
    }
    if (occupiedHeaders.has(lower)) throw new Error(`JSON API auth header conflicts with a static header: ${transport.auth.header}`);
  }
}

function validateCommonTool(
  tool: McpIntegrationToolConfig | JsonApiIntegrationToolConfig,
  transportKind: McpTransportConfig['kind'] | JsonApiTransportConfig['kind'],
): void {
  const descriptionBytes = Buffer.byteLength(tool.description, 'utf8');
  if (descriptionBytes < 1 || descriptionBytes > MAX_DESCRIPTION_BYTES) {
    throw new Error(`Integration tool ${tool.name} description must be 1-${MAX_DESCRIPTION_BYTES} UTF-8 bytes`);
  }
  validateStrictObjectSchema(tool.name, 'input', tool.inputSchema);
  validateStrictObjectSchema(tool.name, 'output', tool.outputSchema);
  if (tool.limits.maxTextBytes > Math.min(MAX_TOOL_TEXT_BYTES, tool.limits.maxResponseBytes)) {
    throw new Error(`Integration tool ${tool.name} maxTextBytes cannot exceed maxResponseBytes`);
  }
  if ((tool.effect === 'read' || tool.effect === 'draft') && tool.idempotency !== 'read') {
    throw new Error(`Integration tool ${tool.name} effect ${tool.effect} must use read idempotency`);
  }
  if (tool.effect !== 'read' && tool.effect !== 'draft' && tool.idempotency === 'read') {
    throw new Error(`Integration tool ${tool.name} effect ${tool.effect} cannot use read idempotency`);
  }
  if (
    transportKind === 'json-api'
    && tool.dataBoundary !== 'external'
  ) {
    throw new Error(`Network integration tool ${tool.name} must declare dataBoundary external`);
  }
}

function validateJsonApiTool(tool: JsonApiIntegrationToolConfig, transport: JsonApiTransportConfig): void {
  const inputProperties = tool.inputSchema.properties as JsonObject;
  const inputNames = new Set(Object.keys(inputProperties));
  const requiredInputNames = new Set(
    Array.isArray(tool.inputSchema.required)
      ? tool.inputSchema.required.filter((name): name is string => typeof name === 'string')
      : [],
  );
  if (!sameSet(inputNames, requiredInputNames)) {
    throw new Error(`JSON API tool ${tool.name} must require every declared input property`);
  }
  for (const name of inputNames) {
    if (!FIELD_NAME_PATTERN.test(name) || SENSITIVE_CREDENTIAL_NAME.test(name)) {
      throw new Error(`JSON API tool ${tool.name} input property is not safely mappable: ${name}`);
    }
  }

  const placeholders = validatePathTemplate(tool.name, tool.pathTemplate.template);
  const variableNames = new Set(Object.keys(tool.pathTemplate.variables));
  if (!sameSet(placeholders, variableNames)) {
    throw new Error(`JSON API tool ${tool.name} path variables must exactly match template placeholders`);
  }

  const urlMappings = [tool.pathTemplate.variables, tool.query];
  for (const mapping of urlMappings) {
    for (const source of Object.values(mapping)) {
      validateUrlValueSource(tool.name, source, inputProperties);
    }
  }

  const mappings = [...urlMappings, tool.body];
  const usedInputNames = new Set<string>();
  for (const mapping of mappings) {
    for (const [fieldName, source] of Object.entries(mapping)) {
      if (SENSITIVE_CREDENTIAL_NAME.test(fieldName)) {
        throw new Error(`JSON API tool ${tool.name} cannot map credential-like field: ${fieldName}`);
      }
      if (source.source === 'literal') {
        const literalBytes = Buffer.byteLength(JSON.stringify(source.value), 'utf8');
        if (literalBytes > MAX_LITERAL_BYTES) {
          throw new Error(`JSON API tool ${tool.name} literal exceeds ${MAX_LITERAL_BYTES} bytes`);
        }
        validateLiteralCredentialKeys(tool.name, source.value);
        continue;
      }
      if (!inputNames.has(source.name)) {
        throw new Error(`JSON API tool ${tool.name} maps unknown input property: ${source.name}`);
      }
      usedInputNames.add(source.name);
    }
  }
  if (!sameSet(inputNames, usedInputNames)) {
    throw new Error(`JSON API tool ${tool.name} must structurally map every declared input property`);
  }
  if ((tool.method === 'GET' || tool.method === 'DELETE') && Object.keys(tool.body).length > 0) {
    throw new Error(`JSON API tool ${tool.name} ${tool.method} requests cannot declare a body mapping`);
  }

  const keyed = tool.idempotency === 'keyed';
  if (keyed !== (tool.idempotencyKeyHeader !== undefined)) {
    throw new Error(`JSON API tool ${tool.name} keyed idempotency requires exactly one idempotencyKeyHeader`);
  }
  if (tool.idempotencyKeyHeader) {
    const header = validateHeaderName(tool.idempotencyKeyHeader, 'JSON API idempotency header');
    const occupied = new Set(Object.keys(transport.staticHeaders).map((name) => name.toLowerCase()));
    if (transport.auth.kind === 'bearer') occupied.add('authorization');
    if (transport.auth.kind === 'header') occupied.add(transport.auth.header.toLowerCase());
    if (FORBIDDEN_STATIC_HEADERS.has(header) || occupied.has(header)) {
      throw new Error(`JSON API idempotency header is forbidden or conflicts with transport headers: ${tool.idempotencyKeyHeader}`);
    }
  }
}

function validateLiteralCredentialKeys(toolName: string, value: JsonValue): void {
  if (Array.isArray(value)) {
    for (const item of value) validateLiteralCredentialKeys(toolName, item);
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [name, nested] of Object.entries(value)) {
    if (SENSITIVE_CREDENTIAL_NAME.test(name)) {
      throw new Error(`JSON API tool ${toolName} literal contains credential-like field: ${name}`);
    }
    validateLiteralCredentialKeys(toolName, nested);
  }
}

function validateUrlValueSource(
  toolName: string,
  source: JsonApiValueSource,
  inputProperties: JsonObject,
): void {
  if (source.source === 'literal') {
    if (source.value !== null && !['string', 'number', 'boolean'].includes(typeof source.value)) {
      throw new Error(`JSON API tool ${toolName} path and query literals must be JSON primitives`);
    }
    return;
  }
  const schema = inputProperties[source.name];
  if (!isPlainObject(schema) || !['string', 'number', 'integer', 'boolean', 'null'].includes(String(schema.type))) {
    throw new Error(`JSON API tool ${toolName} path and query inputs must have primitive schemas: ${source.name}`);
  }
}

function validatePathTemplate(toolName: string, template: string): Set<string> {
  if (
    !template.startsWith('/')
    || template.length > MAX_PATH_TEMPLATE_BYTES
    || /[?#\\\u0000-\u001f\u007f]/u.test(template)
    || /%(?:2e|2f|5c|7b|7d)/iu.test(template)
    || template.includes('//')
  ) {
    throw new Error(`JSON API tool ${toolName} has an unsafe path template`);
  }
  const placeholders = new Set<string>();
  let stripped = '';
  let cursor = 0;
  for (const match of template.matchAll(/\{([^{}]+)\}/gu)) {
    const index = match.index;
    if (index === undefined) continue;
    const name = match[1]!;
    if (!FIELD_NAME_PATTERN.test(name)) {
      throw new Error(`JSON API tool ${toolName} has an invalid path variable: ${name}`);
    }
    stripped += `${template.slice(cursor, index)}x`;
    cursor = index + match[0].length;
    placeholders.add(name);
  }
  stripped += template.slice(cursor);
  if (/[{}]/u.test(stripped)) throw new Error(`JSON API tool ${toolName} has unmatched path braces`);
  for (const segment of stripped.split('/')) {
    if (segment === '.' || segment === '..') throw new Error(`JSON API tool ${toolName} path cannot traverse directories`);
  }
  return placeholders;
}

function validateStrictObjectSchema(
  toolName: string,
  kind: 'input' | 'output',
  schema: JsonObject,
): void {
  const bytes = Buffer.byteLength(JSON.stringify(schema), 'utf8');
  if (bytes > MAX_SCHEMA_BYTES) throw new Error(`Integration tool ${toolName} ${kind} schema exceeds ${MAX_SCHEMA_BYTES} bytes`);
  if (schema.type !== 'object' || schema.additionalProperties !== false || !isPlainObject(schema.properties)) {
    throw new Error(`Integration tool ${toolName} ${kind} schema must be an object with properties and additionalProperties false`);
  }

  let nodes = 0;
  const visit = (value: JsonValue, depth: number): void => {
    nodes += 1;
    if (nodes > MAX_SCHEMA_NODES) throw new Error(`Integration tool ${toolName} ${kind} schema is too complex`);
    if (depth > MAX_SCHEMA_DEPTH) throw new Error(`Integration tool ${toolName} ${kind} schema is too deeply nested`);
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (!isPlainObject(value)) return;
    for (const forbidden of ['$ref', '$dynamicRef', '$recursiveRef', '$defs', 'definitions', 'patternProperties', 'unevaluatedProperties']) {
      if (Object.hasOwn(value, forbidden)) {
        throw new Error(`Integration tool ${toolName} ${kind} schema cannot use ${forbidden}`);
      }
    }
    if (value.type === 'object' || Object.hasOwn(value, 'properties')) {
      if (value.type !== 'object' || value.additionalProperties !== false || !isPlainObject(value.properties)) {
        throw new Error(`Integration tool ${toolName} ${kind} nested object schemas must be strict`);
      }
      const properties = value.properties;
      if (value.required !== undefined) {
        if (!Array.isArray(value.required) || value.required.some((name) => typeof name !== 'string' || !Object.hasOwn(properties, name))) {
          throw new Error(`Integration tool ${toolName} ${kind} schema has invalid required properties`);
        }
        validateUnique(value.required as string[], `integration tool ${toolName} ${kind} required property`);
      }
    }
    if (value.type === 'array' && !Object.hasOwn(value, 'items')) {
      throw new Error(`Integration tool ${toolName} ${kind} array schemas require items`);
    }
    for (const child of Object.values(value)) visit(child, depth + 1);
  };
  visit(schema, 0);
}

function validateExactHttpUrl(value: string, label: string, originOnly: boolean): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be an exact HTTP(S) URL`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error(`${label} must use HTTP(S) without embedded credentials`);
  }
  if (originOnly) {
    if (value !== parsed.origin || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      throw new Error(`${label} must be an exact origin without path, query, or fragment`);
    }
  } else if (value !== parsed.href || parsed.search || parsed.hash) {
    throw new Error(`${label} must be exact and cannot contain query or fragment`);
  }
}

function validateHeaderName(value: string, label: string): string {
  if (!HEADER_NAME_PATTERN.test(value)) throw new Error(`${label} is invalid: ${value}`);
  return value.toLowerCase();
}

function validateCleanStrings(values: readonly string[], label: string): void {
  for (const value of values) {
    if (value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) {
      throw new Error(`${label} must be trimmed and cannot contain control characters`);
    }
  }
}

function validateUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`Duplicate ${label}`);
}

function sameSet(first: ReadonlySet<string>, second: ReadonlySet<string>): boolean {
  return first.size === second.size && [...first].every((value) => second.has(value));
}

function assertPlainJsonValue(value: unknown, label: string): asserts value is JsonValue {
  const stack = new Set<object>();
  let nodes = 0;
  const visit = (current: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > 100_000 || depth > 64) throw new Error(`${label} is too complex`);
    if (
      current === null
      || typeof current === 'string'
      || typeof current === 'boolean'
      || (
        typeof current === 'number'
        && Number.isFinite(current)
        && !Object.is(current, -0)
        && (!Number.isInteger(current) || Number.isSafeInteger(current))
      )
    ) return;
    if (typeof current !== 'object') throw new Error(`${label} contains a non-JSON value`);
    if (stack.has(current)) throw new Error(`${label} contains a cycle`);
    stack.add(current);
    try {
      if (Array.isArray(current)) {
        const keys = Reflect.ownKeys(current);
        if (
          keys.length !== current.length + 1
          || keys.some((key) => typeof key !== 'string' || (key !== 'length' && !/^(?:0|[1-9][0-9]*)$/u.test(key)))
        ) {
          throw new Error(`${label} contains a sparse or decorated array`);
        }
        for (let index = 0; index < current.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
          if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
            throw new Error(`${label} contains a sparse or accessor array element`);
          }
          visit(descriptor.value, depth + 1);
        }
      } else {
        if (!isPlainObject(current)) throw new Error(`${label} contains a non-plain object`);
        const keys = Reflect.ownKeys(current);
        if (keys.some((key) => typeof key !== 'string')) {
          throw new Error(`${label} contains a symbol property`);
        }
        for (const key of keys as string[]) {
          if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
            throw new Error(`${label} contains a dangerous object key`);
          }
          const descriptor = Object.getOwnPropertyDescriptor(current, key);
          if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
            throw new Error(`${label} contains an accessor or hidden property`);
          }
          visit(descriptor.value, depth + 1);
        }
      }
    } finally {
      stack.delete(current);
    }
  };
  visit(value, 0);
}

function isPlainObject(value: unknown): value is JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message.replace(/[\r\n\u0000-\u001f\u007f]+/gu, ' ') : 'invalid data';
}
