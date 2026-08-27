import { describe, expect, it, vi } from 'vitest';

import {
  HarnessKernel,
  type HarnessPlugin,
  type ToolGuardContext,
} from '../src/core/kernel.js';
import type {
  HarnessEvent,
  JsonObject,
  JsonValue,
  ModelAdapter,
  RunRecord,
  ToolDefinition,
  ToolExecutionContext,
} from '../src/core/types.js';

function runRecord(): RunRecord {
  const timestamp = '2026-01-01T00:00:00.000Z';
  return {
    id: 'run-1',
    sessionId: 'session-1',
    workspaceId: 'workspace-1',
    actorId: 'actor-1',
    projectId: 'project-1',
    agentId: 'agent-1',
    agentVersion: '1.0.0',
    status: 'running',
    input: 'test input',
    step: 0,
    toolCalls: 0,
    activeMs: 0,
    activeSince: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
    metadata: {},
  };
}

function executionContext(run = runRecord()): ToolExecutionContext {
  return {
    run,
    callId: 'call-1',
    idempotencyKey: 'run-1:call-1',
    signal: new AbortController().signal,
    emit: (type, data): HarnessEvent => ({
      id: 'event-1',
      sessionId: run.sessionId,
      runId: run.id,
      seq: 0,
      type,
      data,
      createdAt: '2026-01-01T00:00:00.000Z',
    }),
  };
}

function toolDefinition(name = 'projects.inspect'): ToolDefinition {
  return {
    name,
    description: 'Inspect a project',
    effect: 'read',
    idempotency: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', minLength: 1 },
      },
      required: ['projectId'],
      additionalProperties: false,
    },
    execute: async (_context, input) => ({ projectId: input.projectId ?? null }),
  };
}

describe('HarnessKernel plugin lifecycle', () => {
  it('registers plugin capabilities reversibly and protects mounted dependencies', async () => {
    const kernel = new HarnessKernel();
    const trace: string[] = [];
    const observedEvents: string[] = [];
    const tool = toolDefinition();
    const model: ModelAdapter = {
      id: 'test-model',
      complete: async () => ({ message: { role: 'assistant', content: 'ok' } }),
    };

    const foundation: HarnessPlugin = {
      id: 'foundation',
      setup(context) {
        context.provide('clock', { kind: 'test-clock' });
        context.registerModel(model);
        context.registerTool(tool);
        context.registerPromptSection({
          id: 'identity',
          priority: 10,
          render: () => 'You are OpenProjects.',
        });
        context.registerToolGuard(() => 'ask');
        context.registerToolMiddleware((next) => async (execution, definition, input) => {
          trace.push('middleware:before');
          const result = await next(execution, definition, input);
          trace.push('middleware:after');
          return result;
        });
        context.registerToolResultHook((result) => {
          trace.push('hook');
          return { ...result, value: { hooked: true } };
        });
        context.onEvent((event) => {
          observedEvents.push(event.type);
        });
        return () => {
          trace.push('foundation:disposed');
        };
      },
    };
    const feature: HarnessPlugin = {
      id: 'feature',
      requires: ['foundation'],
      setup(context) {
        expect(context.service<{ kind: string }>('clock').kind).toBe('test-clock');
      },
    };

    await expect(
      kernel.mount({ id: 'missing-dependency', requires: ['absent'], setup() {} }),
    ).rejects.toThrow('requires absent');
    expect(kernel.listPlugins()).toEqual([]);

    await kernel.mount(foundation);
    await kernel.mount(feature);

    expect(kernel.listPlugins()).toEqual(['foundation', 'feature']);
    expect(kernel.listTools()).toEqual([tool]);
    expect(kernel.listModels()).toEqual(['test-model']);
    expect(kernel.model('test-model')).toBe(model);
    expect(kernel.service('clock')).toEqual({ kind: 'test-clock' });
    expect(
      await kernel.renderSystemPrompt({
        run: runRecord(),
        currentInput: 'hello',
        memories: [],
        skills: [],
      }),
    ).toBe('You are OpenProjects.');
    expect(
      await kernel.policyDecision({ run: runRecord(), tool, input: { projectId: 'p-1' } }),
    ).toBe('ask');
    await expect(
      kernel.executeTool(executionContext(), tool, { projectId: 'p-1' }),
    ).resolves.toMatchObject({ ok: true, value: { hooked: true } });
    expect(trace).toEqual(['middleware:before', 'middleware:after', 'hook']);
    await kernel.emit('run.started', { runId: 'run-1' });
    expect(observedEvents).toEqual(['run.started']);

    await expect(kernel.unmount('foundation')).rejects.toThrow(
      'Cannot unmount foundation; required by feature',
    );
    await kernel.unmount('feature');
    await kernel.unmount('foundation');

    expect(kernel.listPlugins()).toEqual([]);
    expect(kernel.listTools()).toEqual([]);
    expect(kernel.listModels()).toEqual([]);
    expect(kernel.tool(tool.name)).toBeUndefined();
    expect(() => kernel.model('test-model')).toThrow('Model adapter not registered');
    expect(() => kernel.service('clock')).toThrow('Service not registered');
    expect(
      await kernel.renderSystemPrompt({
        run: runRecord(),
        currentInput: 'hello',
        memories: [],
        skills: [],
      }),
    ).toBe('');
    expect(
      await kernel.policyDecision({ run: runRecord(), tool, input: { projectId: 'p-1' } }),
    ).toBe('allow');

    trace.length = 0;
    await kernel.executeTool(executionContext(), tool, { projectId: 'p-1' });
    await kernel.emit('run.finished', { runId: 'run-1' });
    expect(trace).toEqual([]);
    expect(observedEvents).toEqual(['run.started']);
  });

  it('rolls back partial registrations when plugin setup fails', async () => {
    const kernel = new HarnessKernel();
    const broken: HarnessPlugin = {
      id: 'broken',
      setup(context) {
        context.provide('temporary-service', 42);
        context.registerTool(toolDefinition('temporary-tool'));
        throw new Error('setup failed');
      },
    };

    await expect(kernel.mount(broken)).rejects.toThrow('setup failed');
    expect(kernel.listPlugins()).toEqual([]);
    expect(kernel.listTools()).toEqual([]);
    expect(() => kernel.service('temporary-service')).toThrow('Service not registered');

    await expect(kernel.mount({ id: 'broken', setup() {} })).resolves.toBeUndefined();
    expect(kernel.listPlugins()).toEqual(['broken']);
  });
});

describe('HarnessKernel tool policy', () => {
  it('combines guards monotonically: allow cannot weaken ask and deny is terminal', async () => {
    const kernel = new HarnessKernel();
    const finalGuard = vi.fn(() => 'allow' as const);
    await kernel.mount({
      id: 'policy',
      setup(context) {
        context.registerToolGuard(() => 'ask');
        context.registerToolGuard(() => 'allow');
        context.registerToolGuard(({ input }) => (input.blocked === true ? 'deny' : 'abstain'));
        context.registerToolGuard(finalGuard);
      },
    });
    const tool = toolDefinition();
    const base: Omit<ToolGuardContext, 'input'> = { run: runRecord(), tool };

    await expect(kernel.policyDecision({ ...base, input: {} })).resolves.toBe('ask');
    expect(finalGuard).toHaveBeenCalledTimes(1);

    await expect(kernel.policyDecision({ ...base, input: { blocked: true } })).resolves.toBe(
      'deny',
    );
    expect(finalGuard).toHaveBeenCalledTimes(1);
  });
});

describe('HarnessKernel tool input validation', () => {
  it('rejects unknown, non-object, malformed, and extra input while preserving valid input', async () => {
    const kernel = new HarnessKernel();
    const tool: ToolDefinition = {
      ...toolDefinition('tasks.set-priority'),
      inputSchema: {
        type: 'object',
        properties: {
          taskId: { type: 'string', minLength: 1 },
          priority: { type: 'integer', minimum: 1, maximum: 5 },
        },
        required: ['taskId', 'priority'],
        additionalProperties: false,
      },
    };
    await kernel.mount({ id: 'tools', setup: (context) => context.registerTool(tool) });

    expect(kernel.validateToolInput('missing', {})).toEqual({
      valid: false,
      error: 'Unknown tool: missing',
    });
    expect(kernel.validateToolInput(tool.name, [])).toEqual({
      valid: false,
      error: 'Tool input must be a JSON object',
    });
    expect(kernel.validateToolInput(tool.name, { taskId: 't-1' })).toMatchObject({
      valid: false,
    });
    expect(
      kernel.validateToolInput(tool.name, { taskId: 't-1', priority: 3, surprise: true }),
    ).toMatchObject({ valid: false });
    expect(kernel.validateToolInput(tool.name, { taskId: 't-1', priority: 9 })).toMatchObject({
      valid: false,
    });

    const input: JsonObject = { taskId: 't-1', priority: 3 };
    expect(kernel.validateToolInput(tool.name, input)).toEqual({ valid: true, input });
  });
});

describe('HarnessKernel canonical tool output boundary', () => {
  it.each([
    {
      name: 'circular',
      value: (): JsonValue => {
        const circular: Record<string, unknown> = {};
        circular.self = circular;
        return circular as unknown as JsonValue;
      },
    },
    {
      name: 'BigInt',
      value: (): JsonValue => ({ amount: 1n }) as unknown as JsonValue,
    },
  ])('rejects a $name result that cannot be represented as canonical JSON', async ({ name, value }) => {
    const kernel = new HarnessKernel();
    const tool: ToolDefinition = {
      ...toolDefinition(`output.${name}`),
      execute: async () => value(),
    };
    await kernel.mount({ id: `plugin.${name}`, setup: (context) => context.registerTool(tool) });

    await expect(kernel.executeTool(executionContext(), tool, {})).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'NON_JSON_TOOL_RESULT',
        message: 'Tool result is not lossless JSON',
      },
    });
  });

  it('rejects a canonical tool result larger than 512 KB', async () => {
    const kernel = new HarnessKernel();
    const tool: ToolDefinition = {
      ...toolDefinition('output.too-large'),
      execute: async () => ({ blob: 'x'.repeat(512_001) }),
    };
    await kernel.mount({ id: 'large-output', setup: (context) => context.registerTool(tool) });

    await expect(kernel.executeTool(executionContext(), tool, {})).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'TOOL_RESULT_TOO_LARGE',
        message: 'Tool result exceeds the 512 KB canonical limit',
      },
    });
  });

  it('validates successful results against outputSchema and preserves a conforming result', async () => {
    const kernel = new HarnessKernel();
    const outputSchema: JsonObject = {
      type: 'object',
      additionalProperties: false,
      properties: {
        status: { const: 'ok' },
        count: { type: 'integer', minimum: 0 },
      },
      required: ['status', 'count'],
    };
    const invalid: ToolDefinition = {
      ...toolDefinition('output.invalid-schema'),
      outputSchema,
      execute: async () => ({ status: 'ok', count: 'two' }),
    };
    const valid: ToolDefinition = {
      ...toolDefinition('output.valid-schema'),
      outputSchema,
      execute: async () => ({ status: 'ok', count: 2 }),
    };
    await kernel.mount({
      id: 'output-schemas',
      setup(context) {
        context.registerTool(invalid);
        context.registerTool(valid);
      },
    });

    await expect(kernel.executeTool(executionContext(), invalid, {})).resolves.toMatchObject({
      ok: false,
      error: { code: 'INVALID_TOOL_OUTPUT' },
    });
    await expect(kernel.executeTool(executionContext(), valid, {})).resolves.toMatchObject({
      ok: true,
      value: { status: 'ok', count: 2 },
    });
  });
});

describe('HarnessKernel bounded tool cancellation', () => {
  it('passes the timeout-linked signal to the tool and prevents a cooperative late effect', async () => {
    const kernel = new HarnessKernel();
    let receivedSignal: AbortSignal | undefined;
    let lateEffect = false;
    const tool: ToolDefinition = {
      ...toolDefinition('tools.cooperative-timeout'),
      timeoutMs: 10,
      execute: async (context) => new Promise<JsonValue>((resolve, reject) => {
        receivedSignal = context.signal;
        const effect = setTimeout(() => {
          lateEffect = true;
          resolve({ status: 'too-late' });
        }, 80);
        context.signal.addEventListener('abort', () => {
          clearTimeout(effect);
          reject(context.signal.reason);
        }, { once: true });
      }),
    };
    await kernel.mount({ id: 'cooperative-timeout', setup: (context) => context.registerTool(tool) });

    await expect(kernel.executeTool(executionContext(), tool, {})).resolves.toMatchObject({
      ok: false,
      error: { code: 'TOOL_TIMEOUT', message: 'Tool timed out after 10ms' },
    });
    expect(receivedSignal?.aborted).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(lateEffect).toBe(false);
  });

  it('returns an explicit ambiguous result when a tool ignores cancellation', async () => {
    const kernel = new HarnessKernel();
    let settle: (() => void) | undefined;
    let lateEffect = false;
    const tool: ToolDefinition = {
      ...toolDefinition('tools.non-cooperative-timeout'),
      idempotency: 'none',
      timeoutMs: 10,
      execute: async () => new Promise<JsonValue>((resolve) => {
        settle = () => {
          lateEffect = true;
          resolve({ status: 'completed-after-timeout' });
        };
      }),
    };
    await kernel.mount({ id: 'non-cooperative-timeout', setup: (context) => context.registerTool(tool) });

    await expect(kernel.executeTool(executionContext(), tool, {})).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'TOOL_EXECUTION_AMBIGUOUS',
        message: expect.stringContaining('effect may still complete'),
      },
    });
    expect(lateEffect).toBe(false);

    settle?.();
    await Promise.resolve();
    expect(lateEffect).toBe(true);
  });
});
