import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import type { HarnessPlugin } from '../src/core/kernel.js';
import type {
  AppConfig,
  JsonObject,
  ModelAdapter,
  ModelRequest,
  ModelResponse,
  ToolCall,
} from '../src/core/types.js';
import { modelPlugin, STORAGE_SERVICE } from '../src/plugins/builtin.js';
import { SqliteStorage } from '../src/storage/sqlite.js';

const EFFECT_TOOL = 'atomic_effect';

interface EffectProbe {
  bodyExecutions: number;
  inputs: JsonObject[];
}

interface InvalidBatchFixture {
  name: string;
  calls: ToolCall[];
  expectedError: RegExp;
}

const INVALID_BATCHES: InvalidBatchFixture[] = [
  {
    name: 'a duplicate call ID',
    calls: [
      { id: 'duplicate-call', name: EFFECT_TOOL, arguments: '{"value":"first"}' },
      { id: 'duplicate-call', name: EFFECT_TOOL, arguments: '{"value":"second"}' },
    ],
    expectedError: /duplicate tool call ID/iu,
  },
  {
    name: 'a duplicate JSON key in the later call',
    calls: [
      { id: 'valid-call', name: EFFECT_TOOL, arguments: '{"value":"first"}' },
      {
        id: 'duplicate-key-call',
        name: EFFECT_TOOL,
        arguments: '{"value":"shadowed","value":"second"}',
      },
    ],
    expectedError: /duplicate JSON object member "value"/iu,
  },
];

class InvalidBatchAdapter implements ModelAdapter {
  readonly id = 'mock';
  #deliveredBatch = false;

  constructor(readonly calls: readonly ToolCall[]) {}

  async complete(_request: ModelRequest): Promise<ModelResponse> {
    if (this.#deliveredBatch) {
      return { message: { role: 'assistant', content: 'The batch was processed.' } };
    }
    this.#deliveredBatch = true;
    return {
      message: {
        role: 'assistant',
        content: null,
        toolCalls: this.calls.map((call) => ({ ...call })),
      },
    };
  }
}

describe('runtime tool-call batch atomicity', () => {
  it.each(INVALID_BATCHES)(
    'rejects an entire batch containing $name before persisting or executing any invocation',
    async ({ calls, expectedError }) => {
      const probe: EffectProbe = { bodyExecutions: 0, inputs: [] };
      const app = await createApp({
        config: atomicityConfig(),
        databasePath: ':memory:',
        skills: [],
        seedDemo: false,
        plugins: [effectProbePlugin(probe)],
      });

      try {
        await app.kernel.unmount('model:mock');
        await app.kernel.mount(modelPlugin(new InvalidBatchAdapter(calls)));

        const outcome = await app.runtime.start({
          message: 'Attempt the atomic write batch.',
          workspaceId: 'local',
          actorId: 'batch-atomicity-test',
        });

        expect.soft(outcome.run.status).toBe('failed');
        expect.soft(outcome.run.error).toMatch(expectedError);
        expect.soft(outcome.run.toolCalls).toBe(0);
        expect.soft(probe.bodyExecutions).toBe(0);
        expect.soft(probe.inputs).toEqual([]);
        expect.soft(app.storage.outboxCount()).toBe(0);
        expect.soft(outcome.approvals).toEqual([]);
        expect.soft(app.storage.listApprovals(outcome.run.id)).toEqual([]);
        expect.soft(app.storage.listToolInvocationsForRun(outcome.run.id)).toEqual([]);

        const effectEvents = outcome.events.filter((event) => [
          'approval.requested',
          'tool.execution.started',
          'tool.result',
        ].includes(event.type));
        expect.soft(effectEvents).toEqual([]);
      } finally {
        await app.close();
      }
    },
  );
});

function effectProbePlugin(probe: EffectProbe): HarnessPlugin {
  return {
    id: 'atomic-effect-probe',
    requires: ['storage'],
    setup(context) {
      const storage = context.service<SqliteStorage>(STORAGE_SERVICE);
      context.registerTool({
        name: EFFECT_TOOL,
        description: 'Record one durable internal effect for batch atomicity testing.',
        effect: 'internal_write',
        idempotency: 'keyed',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            value: { type: 'string', minLength: 1 },
          },
          required: ['value'],
        },
        async execute({ run, idempotencyKey }, input) {
          probe.bodyExecutions += 1;
          probe.inputs.push(input);
          return storage.enqueueOutbox({
            workspaceId: run.workspaceId,
            destination: 'atomicity-test',
            subject: 'atomicity effect probe',
            body: String(input.value),
            idempotencyKey,
          });
        },
      });
    },
  };
}

function atomicityConfig(): AppConfig {
  return {
    version: 1,
    agent: {
      id: 'batch-atomicity-agent',
      version: '1.0.0',
      name: 'Batch Atomicity Agent',
      system: 'Use only the granted test tool.',
      skills: [],
      tools: [EFFECT_TOOL],
      budgets: {
        maxSteps: 3,
        maxToolCalls: 4,
        maxWallTimeMs: 10_000,
        maxInputTokens: 4_096,
        reservedOutputTokens: 256,
      },
    },
    policy: {
      read: 'allow',
      draft: 'allow',
      memory_write: 'allow',
      internal_write: 'allow',
      external_write: 'ask',
      destructive: 'deny',
    },
    server: { host: '127.0.0.1', port: 4310 },
    storage: { database: ':memory:' },
    model: { provider: 'mock', model: 'batch-atomicity' },
    memory: { retrievalLimit: 2, maxContextCharacters: 1_000 },
  };
}
