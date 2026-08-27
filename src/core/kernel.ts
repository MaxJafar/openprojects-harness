import { Ajv, type ValidateFunction } from 'ajv';

import type {
  JsonObject,
  JsonValue,
  ModelAdapter,
  PolicyDecision,
  RunRecord,
  SkillDefinition,
  ToolDefinition,
  ToolExecutionContext,
  ToolResult,
} from './types.js';

export const TOOL_EXECUTION_AMBIGUOUS_CODE = 'TOOL_EXECUTION_AMBIGUOUS';

const TOOL_TIMEOUT_CODE = 'TOOL_TIMEOUT';
const TOOL_CANCELLATION_GRACE_MS = 250;

export interface PromptContext {
  run: RunRecord;
  currentInput: string;
  memories: JsonValue[];
  skills: SkillDefinition[];
}

export interface PromptSection {
  id: string;
  priority: number;
  render(context: PromptContext): string | undefined | Promise<string | undefined>;
}

export interface ToolGuardContext {
  run: RunRecord;
  tool: ToolDefinition;
  input: JsonObject;
}

export type ToolGuardResult = PolicyDecision | 'abstain';
export type ToolGuard = (context: ToolGuardContext) => ToolGuardResult | Promise<ToolGuardResult>;

export type ToolExecutor = (
  context: ToolExecutionContext,
  tool: ToolDefinition,
  input: JsonObject,
) => Promise<ToolResult>;

export type ToolMiddleware = (next: ToolExecutor) => ToolExecutor;
export type ToolResultHook = (
  result: ToolResult,
  context: ToolExecutionContext,
  tool: ToolDefinition,
) => ToolResult | Promise<ToolResult>;

export interface KernelEvent {
  type: string;
  data: JsonValue;
  at: string;
}

export type KernelEventListener = (event: KernelEvent) => void | Promise<void>;

export interface HarnessPlugin {
  id: string;
  requires?: string[];
  setup(context: PluginContext): void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>;
}

interface MountedPlugin {
  plugin: HarnessPlugin;
  disposers: Array<() => void | Promise<void>>;
}

export interface PluginContext {
  readonly pluginId: string;
  provide<T>(id: string, service: T): void;
  service<T>(id: string): T;
  registerTool(tool: ToolDefinition): void;
  registerModel(adapter: ModelAdapter): void;
  registerPromptSection(section: PromptSection): void;
  registerToolGuard(guard: ToolGuard): void;
  registerToolMiddleware(middleware: ToolMiddleware): void;
  registerToolResultHook(hook: ToolResultHook): void;
  onEvent(listener: KernelEventListener): void;
}

export class HarnessKernel {
  readonly #ajv = new Ajv({ allErrors: true, strict: false });
  readonly #mounted = new Map<string, MountedPlugin>();
  readonly #tools = new Map<string, ToolDefinition>();
  readonly #toolValidators = new Map<string, ValidateFunction>();
  readonly #toolOutputValidators = new Map<string, ValidateFunction>();
  readonly #models = new Map<string, ModelAdapter>();
  readonly #services = new Map<string, { owner: string; value: unknown }>();
  readonly #promptSections = new Map<string, { owner: string; section: PromptSection }>();
  readonly #guards: Array<{ owner: string; guard: ToolGuard }> = [];
  readonly #middlewares: Array<{ owner: string; middleware: ToolMiddleware }> = [];
  readonly #resultHooks: Array<{ owner: string; hook: ToolResultHook }> = [];
  readonly #eventListeners: Array<{ owner: string; listener: KernelEventListener }> = [];

  listPlugins(): string[] {
    return [...this.#mounted.keys()];
  }

  listTools(): ToolDefinition[] {
    return [...this.#tools.values()];
  }

  /** Stable plugin identities whose guards contribute to the policy decision. */
  listToolGuardPlugins(): string[] {
    return [...new Set(this.#guards.map((entry) => entry.owner))].sort();
  }

  listModels(): string[] {
    return [...this.#models.keys()];
  }

  tool(name: string): ToolDefinition | undefined {
    return this.#tools.get(name);
  }

  model(id: string): ModelAdapter {
    const adapter = this.#models.get(id);
    if (!adapter) {
      throw new Error(`Model adapter not registered: ${id}`);
    }
    return adapter;
  }

  service<T>(id: string): T {
    const entry = this.#services.get(id);
    if (!entry) {
      throw new Error(`Service not registered: ${id}`);
    }
    return entry.value as T;
  }

  async mount(plugin: HarnessPlugin): Promise<void> {
    if (this.#mounted.has(plugin.id)) {
      throw new Error(`Plugin already mounted: ${plugin.id}`);
    }
    for (const dependency of plugin.requires ?? []) {
      if (!this.#mounted.has(dependency)) {
        throw new Error(`Plugin ${plugin.id} requires ${dependency}`);
      }
    }

    const mounted: MountedPlugin = { plugin, disposers: [] };
    this.#mounted.set(plugin.id, mounted);
    const own = (disposer: () => void | Promise<void>): void => {
      mounted.disposers.push(disposer);
    };

    const context: PluginContext = {
      pluginId: plugin.id,
      provide: <T>(id: string, service: T) => {
        if (this.#services.has(id)) throw new Error(`Service already registered: ${id}`);
        this.#services.set(id, { owner: plugin.id, value: service });
        own(() => {
          this.#services.delete(id);
        });
      },
      service: <T>(id: string) => this.service<T>(id),
      registerTool: (tool) => {
        if (this.#tools.has(tool.name)) throw new Error(`Tool already registered: ${tool.name}`);
        const validator = this.#ajv.compile(tool.inputSchema);
        const outputValidator = tool.outputSchema ? this.#ajv.compile(tool.outputSchema) : undefined;
        this.#tools.set(tool.name, tool);
        this.#toolValidators.set(tool.name, validator);
        if (outputValidator) this.#toolOutputValidators.set(tool.name, outputValidator);
        own(() => {
          this.#tools.delete(tool.name);
          this.#toolValidators.delete(tool.name);
          this.#toolOutputValidators.delete(tool.name);
        });
      },
      registerModel: (adapter) => {
        if (this.#models.has(adapter.id)) throw new Error(`Model already registered: ${adapter.id}`);
        this.#models.set(adapter.id, adapter);
        own(() => {
          this.#models.delete(adapter.id);
        });
      },
      registerPromptSection: (section) => {
        if (this.#promptSections.has(section.id)) {
          throw new Error(`Prompt section already registered: ${section.id}`);
        }
        this.#promptSections.set(section.id, { owner: plugin.id, section });
        own(() => {
          this.#promptSections.delete(section.id);
        });
      },
      registerToolGuard: (guard) => {
        const entry = { owner: plugin.id, guard };
        this.#guards.push(entry);
        own(() => removeEntry(this.#guards, entry));
      },
      registerToolMiddleware: (middleware) => {
        const entry = { owner: plugin.id, middleware };
        this.#middlewares.push(entry);
        own(() => removeEntry(this.#middlewares, entry));
      },
      registerToolResultHook: (hook) => {
        const entry = { owner: plugin.id, hook };
        this.#resultHooks.push(entry);
        own(() => removeEntry(this.#resultHooks, entry));
      },
      onEvent: (listener) => {
        const entry = { owner: plugin.id, listener };
        this.#eventListeners.push(entry);
        own(() => removeEntry(this.#eventListeners, entry));
      },
    };

    try {
      const dispose = await plugin.setup(context);
      if (dispose) own(dispose);
    } catch (error) {
      await this.unmount(plugin.id, true);
      throw error;
    }
  }

  async unmount(pluginId: string, force = false): Promise<void> {
    const mounted = this.#mounted.get(pluginId);
    if (!mounted) return;
    if (!force) {
      const dependent = [...this.#mounted.values()].find((entry) =>
        entry.plugin.requires?.includes(pluginId),
      );
      if (dependent) {
        throw new Error(`Cannot unmount ${pluginId}; required by ${dependent.plugin.id}`);
      }
    }
    for (const dispose of [...mounted.disposers].reverse()) {
      await dispose();
    }
    this.#mounted.delete(pluginId);
  }

  async dispose(): Promise<void> {
    for (const pluginId of [...this.#mounted.keys()].reverse()) {
      await this.unmount(pluginId, true);
    }
  }

  validateToolInput(toolName: string, input: unknown): { valid: true; input: JsonObject } | { valid: false; error: string } {
    if (!isObject(input)) return { valid: false, error: 'Tool input must be a JSON object' };
    const validator = this.#toolValidators.get(toolName);
    if (!validator) return { valid: false, error: `Unknown tool: ${toolName}` };
    if (!validator(input)) {
      return {
        valid: false,
        error: this.#ajv.errorsText(validator.errors, { separator: '; ' }),
      };
    }
    return { valid: true, input: input as JsonObject };
  }

  async policyDecision(context: ToolGuardContext): Promise<PolicyDecision> {
    let decision: PolicyDecision = 'allow';
    for (const { guard } of this.#guards) {
      const next = await guard(context);
      if (next === 'deny') return 'deny';
      if (next === 'ask') decision = 'ask';
    }
    return decision;
  }

  async renderSystemPrompt(context: PromptContext): Promise<string> {
    const sections = [...this.#promptSections.values()]
      .map((entry) => entry.section)
      .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id));
    const rendered: string[] = [];
    for (const section of sections) {
      const value = await section.render(context);
      if (value?.trim()) rendered.push(value.trim());
    }
    return rendered.join('\n\n');
  }

  async executeTool(
    context: ToolExecutionContext,
    tool: ToolDefinition,
    input: JsonObject,
  ): Promise<ToolResult> {
    const base: ToolExecutor = async (executionContext, definition, args) => {
      const started = performance.now();
      try {
        const value = await withTimeout(
          (signal) => definition.execute({ ...executionContext, signal }, args),
          definition.timeoutMs ?? 30_000,
          executionContext.signal,
          definition.name,
        );
        return {
          callId: executionContext.callId,
          name: definition.name,
          ok: true,
          value,
          durationMs: Math.round(performance.now() - started),
        };
      } catch (error) {
        return {
          callId: executionContext.callId,
          name: definition.name,
          ok: false,
          error: {
            code: error instanceof ToolExecutionError ? error.code : 'TOOL_EXECUTION_ERROR',
            message: error instanceof Error ? error.message : String(error),
          },
          durationMs: Math.round(performance.now() - started),
        };
      }
    };
    const execute = [...this.#middlewares]
      .reverse()
      .reduce<ToolExecutor>((next, entry) => entry.middleware(next), base);
    let result = await execute(context, tool, input);
    for (const { hook } of this.#resultHooks) {
      result = await hook(result, context, tool);
    }
    if (result.ok) {
      const outputValidator = this.#toolOutputValidators.get(tool.name);
      if (outputValidator && !outputValidator(result.value)) {
        result = {
          callId: context.callId,
          name: tool.name,
          ok: false,
          error: {
            code: 'INVALID_TOOL_OUTPUT',
            message: this.#ajv.errorsText(outputValidator.errors, { separator: '; ' }),
          },
          durationMs: result.durationMs,
        };
      }
    }
    try {
      const canonical = JSON.stringify(result);
      if (Buffer.byteLength(canonical, 'utf8') > 512_000) {
        return {
          callId: context.callId,
          name: tool.name,
          ok: false,
          error: { code: 'TOOL_RESULT_TOO_LARGE', message: 'Tool result exceeds the 512 KB canonical limit' },
          durationMs: result.durationMs,
        };
      }
      return JSON.parse(canonical) as ToolResult;
    } catch {
      return {
        callId: context.callId,
        name: tool.name,
        ok: false,
        error: { code: 'NON_JSON_TOOL_RESULT', message: 'Tool result is not lossless JSON' },
        durationMs: result.durationMs,
      };
    }
  }

  async emit(type: string, data: JsonValue): Promise<void> {
    const event: KernelEvent = { type, data, at: new Date().toISOString() };
    for (const { listener } of this.#eventListeners) {
      await listener(event);
    }
  }
}

export class ToolExecutionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ToolExecutionError';
  }
}

function removeEntry<T>(entries: T[], entry: T): void {
  const index = entries.indexOf(entry);
  if (index >= 0) entries.splice(index, 1);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type PromiseSettlement<T> =
  | { status: 'fulfilled'; value: T }
  | { status: 'rejected'; reason: unknown };

const ABORTED = Symbol('aborted');
const STILL_RUNNING = Symbol('still-running');

async function withTimeout<T>(
  execute: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  parentSignal: AbortSignal,
  toolName: string,
): Promise<T> {
  const controller = new AbortController();
  const timeoutError = new ToolExecutionError(TOOL_TIMEOUT_CODE, `Tool timed out after ${timeoutMs}ms`);
  const timeout = setTimeout(() => controller.abort(timeoutError), timeoutMs);
  const onAbort = (): void => controller.abort(parentSignal.reason);
  if (parentSignal.aborted) onAbort();
  else parentSignal.addEventListener('abort', onAbort, { once: true });
  const operation = Promise.resolve().then(() => execute(controller.signal));
  // Always consume the underlying settlement. A non-cooperative tool may keep
  // running after the bounded caller returns an explicit ambiguous outcome.
  const settlement: Promise<PromiseSettlement<T>> = operation.then(
    (value) => ({ status: 'fulfilled', value }),
    (reason: unknown) => ({ status: 'rejected', reason }),
  );
  try {
    const first = await Promise.race([settlement, aborted(controller.signal)]);
    if (first !== ABORTED) return settledValue(first);

    // Give a cooperative implementation a bounded opportunity to observe the
    // signal and settle. If it resolves during cancellation, preserve the real
    // result instead of falsely reporting that its effect failed.
    const afterAbort = await Promise.race([
      settlement,
      delay(TOOL_CANCELLATION_GRACE_MS).then(() => STILL_RUNNING),
    ]);
    if (typeof afterAbort !== 'symbol') {
      if (afterAbort.status === 'fulfilled') return afterAbort.value;
      throw abortReason(controller.signal, afterAbort.reason);
    }

    throw new ToolExecutionError(
      TOOL_EXECUTION_AMBIGUOUS_CODE,
      `Tool ${toolName} did not settle within ${TOOL_CANCELLATION_GRACE_MS}ms after cancellation; `
        + 'its effect may still complete',
    );
  } finally {
    clearTimeout(timeout);
    parentSignal.removeEventListener('abort', onAbort);
  }
}

function aborted(signal: AbortSignal): Promise<typeof ABORTED> {
  if (signal.aborted) return Promise.resolve(ABORTED);
  return new Promise((resolve) => signal.addEventListener('abort', () => resolve(ABORTED), { once: true }));
}

function settledValue<T>(settlement: PromiseSettlement<T>): T {
  if (settlement.status === 'fulfilled') return settlement.value;
  throw settlement.reason;
}

function abortReason(signal: AbortSignal, fallback: unknown): unknown {
  // A transport can establish that a dispatched non-idempotent call has an
  // unknown outcome while responding to cancellation. Preserve that stronger
  // durable classification instead of replacing it with the local timeout or
  // operator-abort reason.
  if (
    fallback instanceof ToolExecutionError
    && fallback.code === TOOL_EXECUTION_AMBIGUOUS_CODE
  ) {
    return fallback;
  }
  return signal.reason ?? fallback ?? new Error('Tool aborted');
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
