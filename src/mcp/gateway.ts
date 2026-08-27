import {
  TOOL_EXECUTION_AMBIGUOUS_CODE,
  ToolExecutionError,
  type HarnessPlugin,
} from '../core/kernel.js';
import type {
  JsonObject,
  JsonValue,
  ToolDefinition,
  ToolEffect,
} from '../core/types.js';
import { Ajv, type ValidateFunction } from 'ajv';

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const GATEWAY_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const TRANSPORT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/;
const MAX_TOOLS = 64;
const MAX_DESCRIPTION_BYTES = 4_096;
const MAX_SCHEMA_BYTES = 65_536;
const MAX_REQUEST_BYTES = 65_536;
const MAX_RESPONSE_BYTES = 262_144;
const MAX_TEXT_BYTES = 65_536;
const MAX_TIMEOUT_MS = 30_000;
const MAX_CONTENT_BLOCKS = 32;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_NODES = 20_000;

export interface McpCallToolRequest {
  readonly name: string;
  readonly arguments: JsonObject;
}

export interface McpCallToolOptions {
  /** Host-generated replay key. It is not forwarded without a reviewed remote contract. */
  readonly idempotencyKey: string;
  /** Locally reviewed semantics; remote annotations never determine retry safety. */
  readonly idempotency: ToolDefinition['idempotency'];
  /** Exact locally reviewed request timeout for this tool. */
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
}

/**
 * Deliberately narrow transport seam for MCP `tools/call`.
 *
 * It has no discovery, sampling, elicitation, resources, tasks, authentication,
 * policy, or approval API. Implementations must also bound bytes while reading
 * from their underlying process/socket; this gateway bounds the materialized
 * value before it can reach the model or host tool result.
 */
export interface McpCallToolTransport {
  /** Stable identity for the reviewed transport configuration, never remote metadata. */
  readonly id: string;
  /**
   * Redacted transport commitment. It may contain endpoint/process identity,
   * protocol version, credential environment-variable names, and wire limits,
   * but never credential values. The run snapshot commits to this object.
   */
  readonly snapshotBinding?: JsonObject;
  /** Establish and verify the reviewed peer before tools become available. */
  start?(): Promise<void>;
  /** Release a child process, HTTP session, or other owned transport state. */
  close?(): Promise<void>;
  callTool(request: McpCallToolRequest, options: McpCallToolOptions): Promise<unknown>;
}

export interface McpToolLimits {
  readonly timeoutMs: number;
  readonly maxRequestBytes: number;
  readonly maxResponseBytes: number;
  readonly maxTextBytes: number;
}

/** All security-relevant fields are supplied and reviewed locally. */
export interface LocalMcpToolDeclaration {
  /** Name exposed to the local agent and used by local grants/policy. */
  readonly name: string;
  /** Exact remote MCP tool name. Dynamic discovery cannot change this value. */
  readonly remoteName: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
  readonly outputSchema: JsonObject;
  readonly effect: ToolEffect;
  /** Whether invoking the tool can disclose arguments outside this host. */
  readonly dataBoundary?: 'local' | 'external';
  readonly idempotency: ToolDefinition['idempotency'];
  readonly limits: McpToolLimits;
}

export interface McpToolGatewayOptions {
  /** Stable local identifier, not a URL. */
  readonly id: string;
  readonly transport: McpCallToolTransport;
  /** Exact allowlist. Only these tools are registered or callable. */
  readonly tools: readonly LocalMcpToolDeclaration[];
}

/**
 * Adapts an exact local allowlist of synchronous MCP calls into ordinary
 * HarnessKernel tools. Consequently the existing agent grant, monotonic policy
 * guards, durable approval record, timeout handling, and result hooks remain
 * authoritative. Remote annotations are neither requested nor accepted.
 */
export function mcpToolGatewayPlugin(options: McpToolGatewayOptions): HarnessPlugin {
  validateOptions(options);
  const ajv = new Ajv({ allErrors: true, strict: false });
  const tools = options.tools.map((declaration) => toolDefinition(
    options.id,
    options.transport,
    declaration,
    ajv,
    ajv.compile(declaration.outputSchema),
  ));
  return {
    id: `mcp-gateway:${options.id}`,
    async setup(context) {
      try {
        await options.transport.start?.();
        for (const tool of tools) context.registerTool(tool);
      } catch (error) {
        try {
          await options.transport.close?.();
        } catch {
          // Preserve the startup failure. A transport implementation must make
          // close idempotent and should consume its own teardown diagnostics.
        }
        throw error;
      }
      return options.transport.close ? () => options.transport.close!() : undefined;
    },
  };
}

function toolDefinition(
  gatewayId: string,
  transport: McpCallToolTransport,
  declaration: LocalMcpToolDeclaration,
  ajv: Ajv,
  outputValidator: ValidateFunction,
): ToolDefinition {
  const limits = { ...declaration.limits };
  const remoteName = declaration.remoteName;
  const localName = declaration.name;
  return {
    name: declaration.name,
    description: declaration.description,
    inputSchema: canonicalObject(declaration.inputSchema, 'MCP input schema'),
    outputSchema: canonicalObject(declaration.outputSchema, 'MCP output schema'),
    effect: declaration.effect,
    idempotency: declaration.idempotency,
    timeoutMs: limits.timeoutMs,
    snapshotBinding: {
      protocol: 'mcp.tools-call.v1',
      gatewayId,
      transportId: transport.id,
      ...(transport.snapshotBinding
        ? { transportBinding: canonicalObject(transport.snapshotBinding, 'MCP transport binding') }
        : {}),
      remoteName,
      ...(declaration.dataBoundary ? { dataBoundary: declaration.dataBoundary } : {}),
      limits: {
        timeoutMs: limits.timeoutMs,
        maxRequestBytes: limits.maxRequestBytes,
        maxResponseBytes: limits.maxResponseBytes,
        maxTextBytes: limits.maxTextBytes,
      },
    },
    async execute(context, input) {
      const request = canonicalObject(
        { name: remoteName, arguments: input },
        `MCP request for ${localName}`,
      ) as unknown as McpCallToolRequest;
      assertByteLimit(request, limits.maxRequestBytes, 'MCP_REQUEST_TOO_LARGE', 'MCP request');

      let raw: unknown;
      try {
        raw = await transport.callTool(request, {
          idempotencyKey: context.idempotencyKey,
          idempotency: declaration.idempotency,
          timeoutMs: limits.timeoutMs,
          signal: context.signal,
        });
      } catch (error) {
        // A concrete transport may know that a non-idempotent request left
        // the process before the connection failed. Preserve that durable
        // ambiguity signal so the runtime stops instead of reporting a safe
        // retryable failure.
        if (
          error instanceof ToolExecutionError
          && error.code === TOOL_EXECUTION_AMBIGUOUS_CODE
        ) {
          throw error;
        }
        if (context.signal.aborted) throw context.signal.reason ?? error;
        // Transport and remote error text is untrusted and never becomes a
        // model-visible ToolResult message.
        throw new ToolExecutionError('MCP_TRANSPORT_ERROR', 'The local MCP transport failed');
      }
      try {
        const result = parseCallToolResult(raw, limits);
        if (!outputValidator(result)) {
          throw new ToolExecutionError(
            'INVALID_TOOL_OUTPUT',
            ajv.errorsText(outputValidator.errors, { separator: '; ' }),
          );
        }
        return result;
      } catch (error) {
        // The peer already returned from tools/call, so a non-idempotent side
        // effect may have happened even when its envelope or structured output
        // is unusable. Stop the durable run instead of inviting a fresh call.
        if (declaration.idempotency === 'none') {
          throw new ToolExecutionError(
            TOOL_EXECUTION_AMBIGUOUS_CODE,
            'The MCP tool execution outcome is unknown',
          );
        }
        throw error;
      }
    },
  };
}

function parseCallToolResult(
  raw: unknown,
  limits: McpToolLimits,
): JsonObject {
  const response = canonicalObject(raw, 'MCP response');
  assertByteLimit(response, limits.maxResponseBytes, 'MCP_RESPONSE_TOO_LARGE', 'MCP response');

  const allowedKeys = new Set(['content', 'structuredContent', 'isError', '_meta']);
  if (Object.keys(response).some((key) => !allowedKeys.has(key))) {
    protocolError('MCP response contains unsupported fields');
  }
  if (response._meta !== undefined && !isPlainObject(response._meta)) {
    protocolError('MCP response _meta must be an object');
  }
  if (!Array.isArray(response.content)) protocolError('MCP response content must be an array');
  if (response.content.length > MAX_CONTENT_BLOCKS) {
    protocolError(`MCP response exceeds ${MAX_CONTENT_BLOCKS} text content blocks`);
  }

  let textBytes = 0;
  for (const block of response.content) {
    const allowedBlockKeys = new Set(['type', 'text', 'annotations', '_meta']);
    if (!isPlainObject(block) || Object.keys(block).some((key) => !allowedBlockKeys.has(key))) {
      protocolError('MCP response content must contain only exact text blocks');
    }
    if (block.type !== 'text' || typeof block.text !== 'string') {
      protocolError('MCP response supports text content only');
    }
    if (block.annotations !== undefined && !isPlainObject(block.annotations)) {
      protocolError('MCP text annotations must be an object');
    }
    if (block._meta !== undefined && !isPlainObject(block._meta)) {
      protocolError('MCP text _meta must be an object');
    }
    textBytes += Buffer.byteLength(block.text, 'utf8');
    if (textBytes > limits.maxTextBytes) {
      throw new ToolExecutionError(
        'MCP_RESPONSE_TOO_LARGE',
        `MCP response text exceeds ${limits.maxTextBytes} bytes`,
      );
    }
  }

  if (response.isError !== undefined && typeof response.isError !== 'boolean') {
    protocolError('MCP response isError must be a boolean');
  }
  if (response.isError === true) {
    throw new ToolExecutionError('MCP_REMOTE_TOOL_ERROR', 'Remote MCP tool reported an error');
  }
  if (!isPlainObject(response.structuredContent)) {
    protocolError('MCP response requires JSON-object structuredContent');
  }

  // Text is bounded for protocol hygiene but deliberately not exposed to the
  // model. Only locally schema-validated structured output crosses the gateway.
  return canonicalObject(response.structuredContent, 'MCP structuredContent');
}

function validateOptions(options: McpToolGatewayOptions): void {
  if (!GATEWAY_ID_PATTERN.test(options.id)) {
    throw new Error('MCP gateway id must match [a-z0-9][a-z0-9._-]{0,63}');
  }
  if (!options.transport || typeof options.transport.callTool !== 'function') {
    throw new Error('MCP gateway requires a callTool transport');
  }
  if (options.transport.start !== undefined && typeof options.transport.start !== 'function') {
    throw new Error('MCP transport start must be a function');
  }
  if (options.transport.close !== undefined && typeof options.transport.close !== 'function') {
    throw new Error('MCP transport close must be a function');
  }
  if (!TRANSPORT_ID_PATTERN.test(options.transport.id)) {
    throw new Error('MCP transport id must be a stable identifier of at most 128 characters');
  }
  if (
    typeof options.transport.id !== 'string'
    || options.transport.id.trim() !== options.transport.id
    || Buffer.byteLength(options.transport.id, 'utf8') < 1
    || Buffer.byteLength(options.transport.id, 'utf8') > 256
    || /[\u0000-\u001f\u007f]/u.test(options.transport.id)
  ) {
    throw new Error('MCP transport id must be a stable 1-256 byte string without control characters');
  }
  if (options.transport.snapshotBinding) {
    assertJsonSafe(options.transport.snapshotBinding, 'MCP transport binding');
    assertByteLimit(
      options.transport.snapshotBinding,
      MAX_SCHEMA_BYTES,
      'MCP_TRANSPORT_BINDING_TOO_LARGE',
      'MCP transport binding',
    );
  }
  if (!Array.isArray(options.tools) || options.tools.length < 1 || options.tools.length > MAX_TOOLS) {
    throw new Error(`MCP gateway must declare between 1 and ${MAX_TOOLS} tools`);
  }

  const localNames = new Set<string>();
  const remoteNames = new Set<string>();
  for (const tool of options.tools) {
    if (!NAME_PATTERN.test(tool.name)) throw new Error(`Invalid local MCP tool name: ${tool.name}`);
    if (!NAME_PATTERN.test(tool.remoteName)) throw new Error(`Invalid remote MCP tool name: ${tool.remoteName}`);
    if (localNames.has(tool.name)) throw new Error(`Duplicate local MCP tool name: ${tool.name}`);
    if (remoteNames.has(tool.remoteName)) throw new Error(`Duplicate remote MCP tool name: ${tool.remoteName}`);
    localNames.add(tool.name);
    remoteNames.add(tool.remoteName);

    const descriptionBytes = Buffer.byteLength(tool.description, 'utf8');
    if (descriptionBytes < 1 || descriptionBytes > MAX_DESCRIPTION_BYTES) {
      throw new Error(`MCP tool ${tool.name} description must be 1-${MAX_DESCRIPTION_BYTES} bytes`);
    }
    validateStrictObjectSchema(tool.name, 'input', tool.inputSchema);
    validateStrictObjectSchema(tool.name, 'output', tool.outputSchema);
    if (!isToolEffect(tool.effect)) throw new Error(`MCP tool ${tool.name} has an invalid effect`);
    if (tool.dataBoundary !== undefined && !['local', 'external'].includes(tool.dataBoundary)) {
      throw new Error(`MCP tool ${tool.name} has an invalid data boundary`);
    }
    if (!['read', 'keyed', 'none'].includes(tool.idempotency)) {
      throw new Error(`MCP tool ${tool.name} has invalid idempotency`);
    }
    validateLimits(tool.name, tool.limits);
    validateEffectAndIdempotency(tool);
  }
}

function validateStrictObjectSchema(
  toolName: string,
  kind: 'input' | 'output',
  schema: JsonObject,
): void {
  assertJsonSafe(schema, `${toolName} ${kind} schema`);
  assertByteLimit(schema, MAX_SCHEMA_BYTES, 'MCP_SCHEMA_TOO_LARGE', `${toolName} ${kind} schema`);
  if (schema.type !== 'object' || schema.additionalProperties !== false || !isPlainObject(schema.properties)) {
    throw new Error(
      `MCP tool ${toolName} ${kind} schema must be an object schema with properties and additionalProperties: false`,
    );
  }
}

function validateLimits(toolName: string, limits: McpToolLimits): void {
  if (!isPlainObject(limits)) throw new Error(`MCP tool ${toolName} requires explicit local limits`);
  boundedInteger(limits.timeoutMs, 1, MAX_TIMEOUT_MS, toolName, 'timeoutMs');
  boundedInteger(limits.maxRequestBytes, 1, MAX_REQUEST_BYTES, toolName, 'maxRequestBytes');
  boundedInteger(limits.maxResponseBytes, 1, MAX_RESPONSE_BYTES, toolName, 'maxResponseBytes');
  boundedInteger(limits.maxTextBytes, 0, Math.min(MAX_TEXT_BYTES, limits.maxResponseBytes), toolName, 'maxTextBytes');
}

function validateEffectAndIdempotency(tool: LocalMcpToolDeclaration): void {
  if ((tool.effect === 'read' || tool.effect === 'draft') && tool.idempotency !== 'read') {
    throw new Error(`MCP tool ${tool.name} effect ${tool.effect} must declare read idempotency`);
  }
  if (
    tool.effect !== 'read'
    && tool.effect !== 'draft'
    && tool.idempotency === 'read'
  ) {
    throw new Error(`MCP tool ${tool.name} effect ${tool.effect} cannot declare read idempotency`);
  }
}

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  toolName: string,
  field: string,
): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`MCP tool ${toolName} ${field} must be an integer from ${minimum} to ${maximum}`);
  }
}

function assertByteLimit(
  value: unknown,
  maximum: number,
  code: string,
  label: string,
): void {
  const canonical = canonicalJsonValue(value, label);
  const bytes = Buffer.byteLength(JSON.stringify(canonical), 'utf8');
  if (bytes > maximum) {
    throw new ToolExecutionError(code, `${label} exceeds ${maximum} bytes`);
  }
}

function canonicalObject(value: unknown, label: string): JsonObject {
  const canonical = canonicalJsonValue(value, label);
  if (!isPlainObject(canonical)) {
    throw new ToolExecutionError('MCP_PROTOCOL_ERROR', `${label} must be a JSON object`);
  }
  return canonical;
}

function assertJsonSafe(value: unknown, label: string): asserts value is JsonValue {
  canonicalJsonValue(value, label);
}

function canonicalJsonValue(value: unknown, label: string): JsonValue {
  const stack = new Set<object>();
  let nodes = 0;
  const visit = (current: unknown, depth: number): JsonValue => {
    nodes += 1;
    if (nodes > MAX_JSON_NODES) throw new ToolExecutionError('MCP_PROTOCOL_ERROR', `${label} is too complex`);
    if (depth > MAX_JSON_DEPTH) throw new ToolExecutionError('MCP_PROTOCOL_ERROR', `${label} is too deeply nested`);
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
    ) return current;
    if (typeof current !== 'object') {
      throw new ToolExecutionError('MCP_PROTOCOL_ERROR', `${label} is not lossless JSON`);
    }
    if (stack.has(current)) throw new ToolExecutionError('MCP_PROTOCOL_ERROR', `${label} is cyclic`);
    stack.add(current);
    if (Array.isArray(current)) {
      if (current.length > MAX_JSON_NODES) {
        throw new ToolExecutionError('MCP_PROTOCOL_ERROR', `${label} is too complex`);
      }
      const keys = Reflect.ownKeys(current);
      const expectedKeys = new Set<PropertyKey>([
        ...Array.from({ length: current.length }, (_, index) => String(index)),
        'length',
      ]);
      if (keys.length !== expectedKeys.size || keys.some((key) => !expectedKeys.has(key))) {
        throw new ToolExecutionError('MCP_PROTOCOL_ERROR', `${label} contains a sparse or decorated array`);
      }
      const clone: JsonValue[] = [];
      for (let index = 0; index < current.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
          throw new ToolExecutionError('MCP_PROTOCOL_ERROR', `${label} contains an accessor array element`);
        }
        clone.push(visit(descriptor.value, depth + 1));
      }
      stack.delete(current);
      return clone;
    } else {
      if (!isPlainObject(current) || Object.getOwnPropertySymbols(current).length > 0) {
        throw new ToolExecutionError('MCP_PROTOCOL_ERROR', `${label} contains a non-plain object`);
      }
      const keys = Reflect.ownKeys(current);
      if (keys.length > MAX_JSON_NODES || keys.some((key) => typeof key !== 'string')) {
        throw new ToolExecutionError('MCP_PROTOCOL_ERROR', `${label} is too complex or contains symbols`);
      }
      const descriptors = Object.getOwnPropertyDescriptors(current);
      const clone = Object.create(null) as JsonObject;
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (!descriptor.enumerable || !('value' in descriptor)) {
          throw new ToolExecutionError('MCP_PROTOCOL_ERROR', `${label} contains an accessor or hidden property`);
        }
        clone[key] = visit(descriptor.value, depth + 1);
      }
      stack.delete(current);
      return clone;
    }
  };
  return visit(value, 0);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function protocolError(message: string): never {
  throw new ToolExecutionError('MCP_PROTOCOL_ERROR', message);
}

function isToolEffect(value: unknown): value is ToolEffect {
  return new Set<unknown>([
    'read',
    'draft',
    'memory_write',
    'internal_write',
    'external_write',
    'destructive',
  ]).has(value);
}
