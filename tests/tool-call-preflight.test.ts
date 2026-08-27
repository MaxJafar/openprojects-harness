import { describe, expect, it } from 'vitest';

import {
  MAX_TOOL_CALL_ARGUMENT_BYTES,
  MAX_TOOL_CALL_BATCH_BYTES,
  preflightToolCallBatch,
} from '../src/runtime/tool-call-preflight.js';

describe('tool-call batch preflight', () => {
  it('accepts one fully bounded batch', () => {
    expect(() => preflightToolCallBatch([
      { id: 'call_1', name: 'project_risk_report', arguments: '{"projectId":"atlas"}' },
      { id: 'call_2', name: 'readiness-probe', arguments: '{}' },
    ])).not.toThrow();
  });

  it('rejects duplicate IDs before a caller can process the batch', () => {
    expect(() => preflightToolCallBatch([
      { id: 'same', name: 'first_tool', arguments: '{}' },
      { id: 'same', name: 'second_tool', arguments: '{}' },
    ])).toThrow('duplicate tool call ID');
  });

  it.each([
    [{ id: '', name: 'valid_tool', arguments: '{}' }, 'bounded non-empty ID'],
    [{ id: 'call', name: '../invalid', arguments: '{}' }, 'invalid tool name'],
  ])('rejects malformed call envelopes', (call, expected) => {
    expect(() => preflightToolCallBatch([call])).toThrow(expected);
  });

  it('rejects oversized individual arguments and aggregate batches', () => {
    expect(() => preflightToolCallBatch([{
      id: 'call',
      name: 'valid_tool',
      arguments: 'x'.repeat(MAX_TOOL_CALL_ARGUMENT_BYTES + 1),
    }])).toThrow(`${MAX_TOOL_CALL_ARGUMENT_BYTES}-byte limit`);

    const half = Math.floor(MAX_TOOL_CALL_BATCH_BYTES / 2);
    expect(() => preflightToolCallBatch([
      { id: 'one', name: 'valid_tool', arguments: 'x'.repeat(half) },
      { id: 'two', name: 'valid_tool', arguments: 'x'.repeat(half) },
    ])).toThrow('tool-call batch exceeds');
  });
});
