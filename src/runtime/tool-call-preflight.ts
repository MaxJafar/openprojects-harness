import type { ToolCall } from '../core/types.js';

/**
 * A model response is already bounded by the built-in HTTP adapters. Keep the
 * same invariant at the runtime boundary so custom adapters cannot bypass it.
 */
export const MAX_TOOL_CALL_BATCH_BYTES = 256 * 1024;
export const MAX_TOOL_CALL_ARGUMENT_BYTES = 256 * 1024;

const TOOL_NAME = /^[A-Za-z0-9_-]{1,128}$/u;

/**
 * Validate the complete call envelope before the runtime creates an
 * invocation, requests approval, or executes any member of the batch.
 */
export function preflightToolCallBatch(calls: readonly ToolCall[]): void {
  const ids = new Set<string>();
  let totalBytes = 0;

  for (const call of calls) {
    if (typeof call.id !== 'string' || call.id.length < 1 || call.id.length > 256) {
      throw new Error('Model response structured tool call requires a bounded non-empty ID');
    }
    if (ids.has(call.id)) {
      throw new Error(`Model response contains duplicate tool call ID: ${safeLabel(call.id)}`);
    }
    ids.add(call.id);

    if (typeof call.name !== 'string' || !TOOL_NAME.test(call.name)) {
      throw new Error('Model response contains an invalid tool name');
    }
    if (typeof call.arguments !== 'string') {
      throw new Error(`Model response tool ${safeLabel(call.name)} arguments must be a JSON string`);
    }

    const argumentBytes = Buffer.byteLength(call.arguments, 'utf8');
    if (argumentBytes > MAX_TOOL_CALL_ARGUMENT_BYTES) {
      throw new Error(
        `Model response tool ${safeLabel(call.name)} arguments exceed the ${MAX_TOOL_CALL_ARGUMENT_BYTES}-byte limit`,
      );
    }
    totalBytes += Buffer.byteLength(call.id, 'utf8')
      + Buffer.byteLength(call.name, 'utf8')
      + argumentBytes;
    if (totalBytes > MAX_TOOL_CALL_BATCH_BYTES) {
      throw new Error(`Model response tool-call batch exceeds the ${MAX_TOOL_CALL_BATCH_BYTES}-byte limit`);
    }
  }
}

function safeLabel(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/gu, '?').slice(0, 128);
}
