import { createHash } from 'node:crypto';

import { HarnessKernel, TOOL_EXECUTION_AMBIGUOUS_CODE } from '../core/kernel.js';
import type {
  AgentDefinition,
  AppConfig,
  FeedbackRecord,
  HarnessEvent,
  InboundEvent,
  JsonObject,
  JsonValue,
  MemoryRecord,
  ModelMessage,
  ModelRequest,
  ModelTask,
  RunOutcome,
  RunRecord,
  RunSnapshotSet,
  SkillDefinition,
  StartRunInput,
  ToolCall,
  ToolDefinition,
  ToolInvocationRecord,
  ToolResult,
} from '../core/types.js';
import { errorMessage } from '../core/types.js';
import { MemoryEngine } from '../learning/memory-engine.js';
import {
  SqliteStorage,
  type RecoverableRunCandidate,
  type ToolBatchRecord,
} from '../storage/sqlite.js';
import { captureRunSnapshots, runSnapshotDigests } from './run-snapshots.js';
import { RunAdmissionGovernor, type RunAdmissionLease } from './run-admission.js';
import { estimateRequestTokens } from './model-router.js';
import { parseJsonRejectingDuplicateKeys } from '../core/strict-json.js';
import {
  canonicalizeToolArguments,
  verifyCanonicalToolArguments,
} from './tool-arguments.js';
import { preflightToolCallBatch } from './tool-call-preflight.js';

export type RuntimeEventListener = (event: HarnessEvent) => void;

export interface StartedRun {
  /** The durable run after it has entered the running state. */
  run: RunRecord;
  /** Resolves when the bounded run reaches a terminal or approval-waiting state. */
  completion: Promise<RunOutcome>;
}

export interface StartedApprovalResolution {
  /** The durable run after the approval decision has been committed. */
  run: RunRecord;
  /** Resolves after the approved/rejected batch has continued to its next pause or terminal state. */
  completion: Promise<RunOutcome>;
}

export interface AgentRuntimeProfile {
  /** A separately versioned, least-privilege agent definition. */
  agent?: AgentDefinition;
  /** Router work class. It must never be inferred from the parent agent. */
  task?: ModelTask;
  /** Bypass the shared supervisor prompt for a compact specialist contract. */
  systemPrompt?: string | ((run: RunRecord) => string);
  /** Specialists may disable retrieval to keep context and trust boundaries small. */
  retrieveMemory?: boolean;
  /** Validate the complete durable trajectory before a run may succeed. */
  validateFinalOutput?: (context: AgentCompletionContext) => void;
  maxModelAttempts?: number;
}

export interface AgentCompletionContext {
  run: RunRecord;
  output: string;
  events: HarnessEvent[];
  invocations: ToolInvocationRecord[];
}

export interface RunExecutionOptions {
  signal?: AbortSignal;
}

interface NormalizedToolCallBase {
  id: string;
  name: string;
  index: number;
  arguments: string;
  argumentsDigest?: string;
}

type NormalizedToolCall =
  | (NormalizedToolCallBase & {
      valid: true;
      tool: ToolDefinition;
      input: JsonObject;
      argumentsDigest: string;
    })
  | (NormalizedToolCallBase & {
      valid: false;
      tool?: ToolDefinition;
      error: { code: 'UNKNOWN_TOOL' | 'INVALID_TOOL_INPUT'; message: string };
    });

const RECOVERY_PAGE_SIZE = 1_000;
const RUN_RECOVERY_UNKNOWN_OUTCOME_CODE = 'RUN_RECOVERY_UNKNOWN_OUTCOME';

type RecoveryFailureReason =
  | 'agent_version_mismatch'
  | 'snapshot_invalid'
  | 'snapshot_mismatch'
  | 'recovery_state_invalid'
  | 'recovery_unrecoverable';

class RunRecoveryError extends Error {
  constructor(
    readonly reason: RecoveryFailureReason,
    message: string,
  ) {
    super(message);
    this.name = 'RunRecoveryError';
  }
}

interface RecoveryInvocationRisk {
  priorRunningInvocationCount: number;
  externalOutcomeUnknown: boolean;
}

export class AgentRuntime {
  readonly #listeners = new Set<RuntimeEventListener>();
  readonly #activeRuns = new Set<string>();
  readonly #runSignals = new Map<string, AbortSignal>();
  readonly #agent: AgentDefinition;
  readonly #profile: AgentRuntimeProfile;
  readonly #admission: RunAdmissionGovernor;

  constructor(
    readonly config: AppConfig,
    readonly kernel: HarnessKernel,
    readonly storage: SqliteStorage,
    readonly skills: SkillDefinition[],
    readonly memoryEngine?: MemoryEngine,
    profile: AgentRuntimeProfile = {},
    admission: RunAdmissionGovernor = new RunAdmissionGovernor(
      config.resources?.profile === 'core-4g-v1' ? 1 : undefined,
    ),
  ) {
    this.#profile = profile;
    this.#admission = admission;
    this.#agent = profile.agent ?? {
      ...config.agent,
      system: config.agent.system ?? '',
    };
  }

  get agent(): AgentDefinition {
    return this.#agent;
  }

  subscribe(listener: RuntimeEventListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async start(input: StartRunInput, execution: RunExecutionOptions = {}): Promise<RunOutcome> {
    return this.startAsync(input, execution).completion;
  }

  /**
   * Durably allocates a run and starts bounded execution without waiting for the
   * model/tool loop. This is the hand-off used by transports that must return a
   * run identifier before completion (HTTP/SSE, Telegram acknowledgement, etc.).
   */
  startAsync(input: StartRunInput, execution: RunExecutionOptions = {}): StartedRun {
    const workspaceId = input.workspaceId ?? 'local';
    const actorId = input.actorId ?? 'local-user';
    const channel = input.channel ?? 'web';
    if (input.projectId && !this.storage.getProject(input.projectId, workspaceId)) {
      throw new Error('Project scope does not belong to the requested workspace');
    }
    const admission = this.#admission.acquire();
    try {
      const session = input.sessionId
        ? this.storage.getSession(input.sessionId)
        : this.storage.createSession({
            workspaceId,
            actorId,
            channel,
            ...(input.externalSessionId ? { externalId: input.externalSessionId } : {}),
            title: compactTitle(input.message),
            metadata: input.metadata ?? {},
          });
      if (session.workspaceId !== workspaceId || session.actorId !== actorId) {
        throw new Error('Session scope does not match the requested workspace and actor');
      }
      const snapshots = this.captureSnapshots();
      const run = this.storage.createRun({
        sessionId: session.id,
        workspaceId,
        actorId,
        ...(input.projectId ? { projectId: input.projectId } : {}),
        agentId: this.#agent.id,
        agentVersion: this.#agent.version,
        input: input.message,
        metadata: input.metadata ?? {},
        snapshots,
      });
      if (execution.signal) this.#runSignals.set(run.id, execution.signal);
      this.emit(run, 'run.created', {
        status: 'queued',
        input: input.message,
        agent: { id: this.#agent.id, version: this.#agent.version },
        budgets: asJson(this.#agent.budgets),
        snapshots: asJson(run.snapshots!),
      });
      const running = this.transitionWithEvent(run.id, ['queued'], 'running', 'run.started', { status: 'running' });
      this.emit(running, 'turn.started', { turn: 1 });
      this.emit(running, 'user.message', {
        message: { role: 'user', content: input.message },
        source: channel,
      });
      return {
        run: running,
        completion: this.drive(run.id, admission),
      };
    } catch (error) {
      admission.release();
      throw error;
    }
  }

  resolveApproval(
    approvalId: string,
    decision: 'approve' | 'reject',
    actorId: string,
    reason?: string,
    authorization?: { trustedOperator?: boolean },
    expectedArgumentsDigest?: string,
  ): Promise<RunOutcome> {
    return this.resolveApprovalAsync(
      approvalId,
      decision,
      actorId,
      reason,
      authorization,
      expectedArgumentsDigest,
    ).completion;
  }

  /**
   * Synchronously validates authority and commits the one-shot decision before
   * returning. Transports may therefore acknowledge the accepted decision and
   * continue the bounded tool/run work in the background without reporting a
   * rejected preflight as accepted.
   */
  resolveApprovalAsync(
    approvalId: string,
    decision: 'approve' | 'reject',
    actorId: string,
    reason?: string,
    authorization?: { trustedOperator?: boolean },
    expectedArgumentsDigest?: string,
  ): StartedApprovalResolution {
    const before = this.storage.approvalWithInvocation(approvalId);
    const run = this.storage.getRun(before.approval.runId);
    this.assertSnapshotBinding(run);
    if (before.approval.status === 'pending' && terminalRun(run.status)) {
      throw new Error('A pending approval cannot be resolved after its run has reached a terminal state');
    }
    const configuredOperator = this.config.server.auth?.operatorId;
    if (
      run.actorId !== actorId
      && actorId !== 'local-user'
      && actorId !== configuredOperator
      && authorization?.trustedOperator !== true
    ) {
      throw new Error('Approval actor is not authorized for this local workspace');
    }
    const admission = before.approval.status === 'pending' ? this.#admission.acquire() : undefined;
    try {
      const resolved = this.storage.resolveApproval(
        approvalId,
        decision,
        actorId,
        reason,
        expectedArgumentsDigest,
      );
      if (!resolved.changed) {
        admission?.release();
        return {
          run: this.storage.getRun(run.id),
          completion: Promise.resolve(this.outcome(run.id)),
        };
      }

      if (resolved.event) {
        for (const listener of this.#listeners) listener(resolved.event);
      }

      if (decision === 'reject') {
        this.storage.finishToolInvocation(
          resolved.invocation.id,
          'denied',
          failedToolResult(
            resolved.invocation.callId,
            resolved.invocation.toolName,
            'APPROVAL_REJECTED',
            reason ?? 'The user rejected this action.',
          ),
        );
      }

      return {
        run: this.storage.getRun(run.id),
        completion: this.continueApprovalResolution(run, resolved.invocation, decision, admission!),
      };
    } catch (error) {
      admission?.release();
      throw error;
    }
  }

  private async continueApprovalResolution(
    run: RunRecord,
    invocation: ToolInvocationRecord,
    decision: 'approve' | 'reject',
    admission: RunAdmissionLease,
  ): Promise<RunOutcome> {
    try {
      if (decision === 'approve') {
        const result = await this.executeInvocation(run, invocation);
        if (isAmbiguousToolResult(result)) {
          return this.stopForAmbiguousExecution(run.id, invocation.toolName, result);
        }
      }

      const batch = this.storage.getToolBatch(invocation.batchId);
      if (this.batchHasPendingApproval(batch)) return this.outcome(run.id);
      if (this.storage.getRun(run.id).status === 'waiting_for_approval') {
        this.transitionWithEvent(
          run.id,
          ['waiting_for_approval'],
          'running',
          'run.resumed',
          { reason: 'approval_batch_resolved' },
        );
      }
      await this.flushBatch(batch);
      return await this.drive(run.id, admission);
    } finally {
      admission.release();
    }
  }

  addFeedback(
    runId: string,
    input: {
      actorId: string;
      reaction?: string;
      score?: number;
      dimensions?: Record<string, number>;
      comment?: string;
      correction?: string;
    },
  ): FeedbackRecord {
    const run = this.storage.getRun(runId);
    if (!['succeeded', 'failed', 'cancelled'].includes(run.status)) {
      throw new Error('Feedback can only target a terminal run');
    }
    const mapped = rewardForReaction(input.reaction);
    const feedback = this.storage.addFeedback({
      runId,
      actorId: input.actorId,
      ...(input.reaction ? { reaction: input.reaction } : {}),
      score: input.score ?? mapped.score,
      dimensions: input.dimensions ?? mapped.dimensions,
      ...(input.comment ? { comment: input.comment } : {}),
      ...(input.correction ? { correction: input.correction } : {}),
    });
    if (!this.storage.hasFeedbackLifecycleEvent(runId, 'feedback.recorded', feedback.id)) {
      this.emit(run, 'feedback.recorded', asJson(feedback));
    }
    if (this.config.learning?.enabled !== false) {
      const learningRate = this.config.learning?.feedbackLearningRate ?? 0.2;
      const memoryIds = this.memoryEngine
        ? this.memoryEngine.applyFeedback(feedback.id, learningRate).appliedMemoryIds
        : this.storage
            .reinforceRunMemories(runId, run.workspaceId, feedback.score, learningRate, feedback.id)
            .map((memory) => memory.id);
      const routes = this.storage.reinforceRunRoutes(
        runId,
        run.workspaceId,
        feedback.score,
        feedback.id,
      );
      if (!this.storage.hasFeedbackLifecycleEvent(runId, 'learning.updated', feedback.id)) {
        this.emit(run, 'learning.updated', {
          feedbackId: feedback.id,
          algorithm: 'bounded-retrieval-and-route-reward-v1',
          reward: feedback.score,
          memoryIds,
          routeIds: routes,
          contentRewritten: false,
        });
      }
    }
    return feedback;
  }

  async ingestEvent(input: InboundEvent): Promise<{ duplicate: boolean; outcome?: RunOutcome }> {
    // Validate the scope before consuming the durable deduplication key. If the
    // project is invalid, a corrected retry with the same key must still run.
    if (input.projectId && !this.storage.getProject(input.projectId, input.workspaceId)) {
      throw new Error('Project scope does not belong to the requested workspace');
    }
    const recorded = this.storage.recordInboundEvent({
      source: input.source,
      dedupeKey: input.dedupeKey,
      type: input.type,
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      payload: input.payload,
      occurredAt: input.occurredAt ?? new Date().toISOString(),
    });
    if (recorded.duplicate) {
      if (!recorded.runId) return { duplicate: true };
      const outcome = this.outcome(recorded.runId);
      if (outcome.run.workspaceId !== input.workspaceId) {
        throw new Error('Inbound event deduplication crossed a workspace boundary');
      }
      return { duplicate: true, outcome };
    }
    const outcome = await this.start({
      message: eventPrompt(input),
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      channel: `event:${input.source}`,
      metadata: { inboundEventId: recorded.id, eventType: input.type },
    });
    this.storage.attachInboundRun(recorded.id, outcome.run.id);
    return { duplicate: false, outcome };
  }

  outcome(runId: string): RunOutcome {
    const run = this.storage.getRun(runId);
    return {
      run,
      approvals: this.storage.listApprovals(runId),
      events: this.storage.eventsForRun(runId),
    };
  }

  async recover(): Promise<RunOutcome[]> {
    const outcomes: RunOutcome[] = [];
    let cursor: string | undefined;
    do {
      const page = this.storage.listRecoverableRunsForAgentPage(
        this.#agent.id,
        this.#agent.version,
        {
          limit: RECOVERY_PAGE_SIZE,
          ...(cursor ? { cursor } : {}),
        },
      );
      for (const candidate of page.candidates) {
        if (!candidate.ok) {
          this.quarantineCorruptRecoveryCandidate(candidate);
          continue;
        }
        const outcome = await this.recoverOne(candidate.run);
        if (outcome) outcomes.push(outcome);
      }
      cursor = page.nextCursor;
    } while (cursor);
    return outcomes;
  }

  private async recoverOne(run: RunRecord): Promise<RunOutcome | undefined> {
    try {
      this.assertRecoveryCompatibility(run);
    } catch (error) {
      return this.quarantineRecoveryFailure(run, error);
    }

    const admission = this.#admission.acquire();
    let toolExecutionResumed = false;
    try {
      const batch = this.storage.unflushedBatchForRun(run.id);
      if (!batch && run.status === 'waiting_for_approval') {
        return this.quarantineRecoveryFailure(
          run,
          new RunRecoveryError(
            'recovery_state_invalid',
            'Run is waiting for approval without an unflushed tool batch',
          ),
        );
      }
      if (batch) {
        const invocations = this.storage.listToolInvocations(batch.id);
        if (
          invocations.some((invocation) => invocation.status === 'pending_approval')
          && invocations.every((invocation) => invocation.status !== 'running')
        ) {
          if (run.status === 'running') {
            this.transitionWithEvent(
              run.id,
              ['running'],
              'waiting_for_approval',
              'run.waiting_for_approval',
              {
                reason: 'restart_pending_approval_reconciled',
                approvalIds: this.storage.listApprovals(run.id, 'pending').map((approval) => approval.id),
              },
            );
            return this.outcome(run.id);
          }
          // An unchanged approval wait is not a recovered outcome. In
          // particular, do not materialize its full event/approval history.
          return undefined;
        }
        const ambiguous = invocations
          .filter((invocation) => invocation.status === 'running')
          .find((invocation) => this.kernel.tool(invocation.toolName)?.idempotency === 'none');
        if (ambiguous) {
          return this.stopForAmbiguousExecution(
            run.id,
            ambiguous.toolName,
            failedToolResult(
              ambiguous.callId,
              ambiguous.toolName,
              TOOL_EXECUTION_AMBIGUOUS_CODE,
              'A non-idempotent tool was still running when the previous process stopped',
            ),
          );
        }
        let ambiguousResult: ToolResult | undefined;
        let ambiguousToolName: string | undefined;
        for (const invocation of invocations) {
          if (invocation.status !== 'running') continue;
          toolExecutionResumed = true;
          const result = await this.executeInvocation(run, invocation);
          if (isAmbiguousToolResult(result)) {
            ambiguousResult = result;
            ambiguousToolName = invocation.toolName;
            break;
          }
        }
        if (ambiguousResult && ambiguousToolName) {
          return this.stopForAmbiguousExecution(run.id, ambiguousToolName, ambiguousResult);
        }
        if (this.batchHasPendingApproval(batch)) return this.outcome(run.id);
        if (this.storage.getRun(run.id).status === 'waiting_for_approval') {
          this.transitionWithEvent(
            run.id,
            ['waiting_for_approval'],
            'running',
            'run.resumed',
            { reason: 'restart_after_resolved_approval' },
          );
        }
        await this.flushBatch(batch);
      }
      return await this.drive(run.id, admission);
    } catch (error) {
      return this.quarantineRecoveryFailure(run, error, toolExecutionResumed);
    } finally {
      admission.release();
    }
  }

  private async drive(runId: string, admission: RunAdmissionLease): Promise<RunOutcome> {
    let activated = false;
    try {
      if (this.#activeRuns.has(runId)) throw new Error(`Run is already active: ${runId}`);
      this.#activeRuns.add(runId);
      activated = true;
      let run = this.storage.getRun(runId);
      this.assertSnapshotBinding(run);
      if (run.status === 'waiting_for_approval') return this.outcome(runId);
      if (run.status !== 'running') return this.outcome(runId);
      let memorySearchCache: {
        memories: MemoryRecord[];
        mode: 'disabled' | 'hybrid' | 'lexical_fallback';
        embeddingError?: string;
      } | undefined;
      let memoryContextCache: ReturnType<typeof boundedMemoryContext> | undefined;

      while (run.status === 'running') {
        this.enforceBudget(run);
        const step = run.step + 1;
        const selectedSkills = this.skills.filter((skill) => this.#agent.skills.includes(skill.id));
        const memoryScope = {
          workspaceId: run.workspaceId,
          ...(run.projectId ? { projectId: run.projectId } : {}),
          actorId: run.actorId,
        };
        if (!memorySearchCache) {
          const retrievalDisabled = this.#profile.retrieveMemory === false
            || this.config.memory.retrievalLimit === 0
            || this.config.memory.maxContextCharacters === 0
            || this.config.resources?.maxRetrievedContextCharacters === 0;
          memorySearchCache = retrievalDisabled
            ? { memories: [], mode: 'disabled' as const }
            : this.memoryEngine
            ? await this.memoryEngine.search(memoryScope, run.input, {
                limit: this.config.memory.retrievalLimit,
              })
            : {
                memories: this.storage.searchMemories(memoryScope, run.input, this.config.memory.retrievalLimit),
                mode: 'lexical_fallback' as const,
              };
          memoryContextCache = boundedMemoryContext(
            memorySearchCache.memories,
            this.config.memory.maxContextCharacters,
            this.config.resources?.maxRetrievedContextCharacters
              ?? this.config.memory.retrievalLimit * this.config.memory.maxContextCharacters,
          );
        }
        const memorySearch = memorySearchCache;
        const retrievedMemories = memorySearch.memories;
        const memories = memoryContextCache ?? [];
        const system = this.#profile.systemPrompt === undefined
          ? await this.kernel.renderSystemPrompt({
              run,
              currentInput: run.input,
              memories,
              skills: selectedSkills,
            })
          : typeof this.#profile.systemPrompt === 'function'
            ? this.#profile.systemPrompt(run)
            : this.#profile.systemPrompt;
        const tools = this.#agent.tools
          .map((name) => this.kernel.tool(name))
          .filter((tool): tool is ToolDefinition => Boolean(tool))
          .map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          }));
        let messages = this.deriveMessages(run.sessionId);
        messages = this.compactIfNeeded(run, messages, system, tools);

        this.emit(run, 'step.started', { step });
        this.emit(run, 'memory.retrieved', {
          step,
          cached: step > 1,
          algorithm: memorySearch.mode,
          embeddingError: 'embeddingError' in memorySearch ? memorySearch.embeddingError ?? null : null,
          memories: retrievedMemories
            .filter((memory) => memories.some((supplied) => supplied.id === memory.id))
            .map((memory, index) => ({
            id: memory.id,
            rank: index + 1,
            strength: memory.strength,
            reward: memory.reward,
            source: { type: memory.sourceType, id: memory.sourceId },
            })),
        });
        this.emit(run, 'model.request', {
          step,
          route: { provider: this.config.model.provider, model: this.config.model.model },
          agent: { id: this.#agent.id, version: this.#agent.version },
          skills: selectedSkills.map((skill) => ({ id: skill.id, version: skill.version })),
          systemDigest: digest(system),
          systemCharacters: system.length,
          memoryIds: memories.map((memory) => memory.id),
          tools: tools as unknown as JsonValue,
          messageCount: messages.length,
          messagesDigest: digest(messages),
        });

        const controller = new AbortController();
        const externalSignal = this.#runSignals.get(runId);
        const abortFromExternal = (): void => controller.abort(externalSignal?.reason);
        if (externalSignal?.aborted) abortFromExternal();
        else externalSignal?.addEventListener('abort', abortFromExternal, { once: true });
        const remaining = remainingWallTime(run, this.#agent.budgets.maxWallTimeMs);
        const timeout = setTimeout(() => controller.abort(new Error('Run wall-time budget exceeded')), remaining);
        let response;
        try {
          const suppliedIds = memories.map((memory) => memory.id);
          if (suppliedIds.length) {
            if (this.memoryEngine) this.memoryEngine.recordUsage(run.id, suppliedIds);
            else this.storage.recordMemoryUsage(run.id, suppliedIds);
          }
          response = await this.completeWithAttempts(run, step, {
            runId,
            provider: this.config.model.provider,
            model: this.config.model.model,
            task: this.#profile.task ?? 'supervisor',
            messages: [{ role: 'system', content: system }, ...messages],
            tools,
            maxOutputTokens: this.#agent.budgets.reservedOutputTokens,
            signal: controller.signal,
          });
        } catch (error) {
          clearTimeout(timeout);
          externalSignal?.removeEventListener('abort', abortFromExternal);
          return this.failRun(runId, `Model request failed: ${errorMessage(error)}`);
        }
        clearTimeout(timeout);
        externalSignal?.removeEventListener('abort', abortFromExternal);

        if (response.route) {
          this.emit(run, 'model.routed', asJson(response.route));
        }

        this.emit(run, 'assistant.message', {
          step,
          message: asJson(response.message),
          usage: response.usage ? asJson(response.usage) : null,
          model: response.model ?? this.config.model.model,
          finishReason: response.rawFinishReason ?? null,
          route: response.route ? asJson(response.route) : null,
        });

        const calls = response.message.toolCalls ?? [];
        if (!calls.length) {
          const output = response.message.content?.trim();
          if (!output) return this.failRun(runId, 'Model returned neither text nor tool calls');
          this.#profile.validateFinalOutput?.({
            run,
            output,
            events: this.storage.eventsForRun(runId),
            invocations: this.storage.listToolInvocationsForRun(runId),
          });
          this.emit(run, 'step.ended', { step, reason: 'completed' });
          this.emit(run, 'turn.ended', { turn: 1, reason: 'completed' });
          run = this.transitionWithEvent(
            runId,
            ['running'],
            'succeeded',
            'run.succeeded',
            { output, step, toolCalls: run.toolCalls },
            { output, step },
          );
          return this.outcome(runId);
        }

        if (run.toolCalls + calls.length > this.#agent.budgets.maxToolCalls) {
          return this.failRun(runId, 'Tool-call budget exceeded');
        }
        preflightToolCallBatch(calls);
        // Complete strict parsing, schema validation, and canonical binding for
        // the entire batch before any member can request approval or execute.
        const normalizedCalls = calls.map((call, index) => this.normalizeToolCall(call, index));
        const batch = this.storage.createToolBatch(runId, step);
        let preparedCalls = 0;
        let ambiguousResult: ToolResult | undefined;
        let ambiguousToolName: string | undefined;
        for (const call of normalizedCalls) {
          this.emit(run, 'tool.call', {
            step,
            batchId: batch.id,
            callId: call.id,
            index: call.index,
            name: call.name,
            arguments: call.arguments,
            argumentsDigest: call.argumentsDigest ?? null,
          });
          const result = await this.prepareInvocation(run, batch, call);
          preparedCalls += 1;
          if (result && isAmbiguousToolResult(result)) {
            ambiguousResult = result;
            ambiguousToolName = call.name;
            break;
          }
        }
        run = this.storage.updateRunCounters(runId, step, run.toolCalls + preparedCalls);
        if (ambiguousResult && ambiguousToolName) {
          return this.stopForAmbiguousExecution(runId, ambiguousToolName, ambiguousResult);
        }
        if (this.batchHasPendingApproval(batch)) {
          run = this.transitionWithEvent(
            runId,
            ['running'],
            'waiting_for_approval',
            'run.waiting_for_approval',
            { approvalIds: this.storage.listApprovals(runId, 'pending').map((approval) => approval.id) },
          );
          return this.outcome(runId);
        }
        await this.flushBatch(batch);
        run = this.storage.getRun(runId);
      }
      return this.outcome(runId);
    } catch (error) {
      return this.failRun(runId, errorMessage(error));
    } finally {
      if (activated) {
        this.#activeRuns.delete(runId);
        this.#runSignals.delete(runId);
      }
      admission.release();
    }
  }

  private async completeWithAttempts(
    run: RunRecord,
    step: number,
    request: Parameters<ReturnType<HarnessKernel['model']>['complete']>[0],
  ) {
    const adapter = this.kernel.model(this.config.model.provider);
    const maxAttempts = this.#profile.maxModelAttempts ?? 2;
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const started = performance.now();
      this.emit(run, 'model.attempt.started', { step, attempt });
      try {
        const response = await adapter.complete(request);
        this.emit(run, 'model.attempt.finished', {
          step,
          attempt,
          durationMs: Math.round(performance.now() - started),
          usage: response.usage ? asJson(response.usage) : null,
        });
        return response;
      } catch (error) {
        lastError = error;
        const retryable = isRetryable(error);
        this.emit(run, 'model.attempt.failed', {
          step,
          attempt,
          durationMs: Math.round(performance.now() - started),
          retryable,
          error: errorMessage(error),
        });
        if (!retryable || attempt === maxAttempts || request.signal.aborted) throw error;
      }
    }
    throw lastError;
  }

  private normalizeToolCall(call: ToolCall, index: number): NormalizedToolCall {
    const tool = this.kernel.tool(call.name);
    const parsed = parseJsonRejectingDuplicateKeys(call.arguments);
    if (!isObject(parsed)) {
      throw new Error(`Tool ${call.name} input must be a JSON object`);
    }
    // Canonical encoding failures are structural failures for the complete
    // response batch. Let them abort this all-calls map before a batch, policy
    // decision, approval, or execution can be created.
    const canonical = canonicalizeToolArguments(parsed);
    if (!tool) {
      return invalidNormalizedToolCall(
        call,
        index,
        undefined,
        canonical.arguments,
        `Unknown or unavailable tool: ${call.name}`,
        canonical.argumentsDigest,
        'UNKNOWN_TOOL',
      );
    }
    const validation = this.kernel.validateToolInput(call.name, parsed);
    if (!validation.valid) {
      return invalidNormalizedToolCall(
        call,
        index,
        tool,
        canonical.arguments,
        validation.error,
        canonical.argumentsDigest,
      );
    }
    return {
      valid: true,
      id: call.id,
      name: call.name,
      index,
      tool,
      input: canonical.input,
      arguments: canonical.arguments,
      argumentsDigest: canonical.argumentsDigest,
    };
  }

  private async prepareInvocation(
    run: RunRecord,
    batch: ToolBatchRecord,
    call: NormalizedToolCall,
  ): Promise<ToolResult | undefined> {
    if (!call.valid) {
      const invocation = this.storage.createToolInvocation({
        batchId: batch.id,
        runId: run.id,
        callId: call.id,
        callIndex: call.index,
        toolName: call.name,
        arguments: call.arguments,
        ...(call.argumentsDigest ? { argumentsDigest: call.argumentsDigest } : {}),
        ...(call.tool ? { effect: call.tool.effect } : {}),
        policyDecision: 'deny',
        status: 'failed',
        idempotencyKey: invocationKey(run.id, call.id),
      });
      const result = failedToolResult(call.id, call.name, call.error.code, call.error.message);
      this.storage.finishToolInvocation(invocation.id, 'failed', result);
      return result;
    }
    const policyDecision = await this.kernel.policyDecision({ run, tool: call.tool, input: call.input });
    const status = policyDecision === 'allow' ? 'running' : policyDecision === 'ask' ? 'pending_approval' : 'denied';
    const invocation = this.storage.createToolInvocation({
      batchId: batch.id,
      runId: run.id,
      callId: call.id,
      callIndex: call.index,
      toolName: call.name,
      arguments: call.arguments,
      argumentsDigest: call.argumentsDigest,
      effect: call.tool.effect,
      policyDecision,
      status,
      idempotencyKey: invocationKey(run.id, call.id),
    });
    if (policyDecision === 'allow') {
      return this.executeInvocation(run, invocation);
    } else if (policyDecision === 'deny') {
      const result = failedToolResult(
        call.id,
        call.name,
        'POLICY_DENIED',
        `Policy denied ${call.tool.effect} tool ${call.name}`,
      );
      this.storage.finishToolInvocation(
        invocation.id,
        'denied',
        result,
      );
      this.emit(run, 'tool.denied', {
        callId: call.id,
        toolName: call.name,
        effect: call.tool.effect,
        argumentsDigest: call.argumentsDigest,
      });
      return result;
    } else {
      const approval = this.storage.createApproval(invocation);
      this.emit(run, 'approval.requested', {
        approvalId: approval.id,
        invocationId: invocation.id,
        callId: call.id,
        toolName: call.name,
        effect: call.tool.effect,
        arguments: call.arguments,
        argumentsDigest: call.argumentsDigest,
        scope: 'once',
      });
    }
    return undefined;
  }

  private async executeInvocation(run: RunRecord, invocation: ToolInvocationRecord): Promise<ToolResult> {
    let parsed: JsonObject;
    try {
      if (!invocation.argumentsDigest) throw new Error('Tool invocation has no bound argument digest');
      parsed = verifyCanonicalToolArguments(invocation.arguments, invocation.argumentsDigest);
    } catch (error) {
      const result = failedToolResult(
        invocation.callId,
        invocation.toolName,
        'TOOL_ARGUMENT_INTEGRITY_ERROR',
        errorMessage(error),
      );
      this.storage.finishToolInvocation(invocation.id, 'failed', result);
      return result;
    }
    const tool = this.kernel.tool(invocation.toolName);
    if (!tool) {
      const result = failedToolResult(
        invocation.callId,
        invocation.toolName,
        'TOOL_UNAVAILABLE',
        'Tool is no longer mounted',
      );
      this.storage.finishToolInvocation(
        invocation.id,
        'failed',
        result,
      );
      return result;
    }
    const validation = this.kernel.validateToolInput(tool.name, parsed);
    if (!validation.valid) {
      const result = failedToolResult(invocation.callId, tool.name, 'INVALID_TOOL_INPUT', validation.error);
      this.storage.finishToolInvocation(
        invocation.id,
        'failed',
        result,
      );
      return result;
    }
    const controller = new AbortController();
    const result = await this.kernel.executeTool(
      {
        run,
        callId: invocation.callId,
        idempotencyKey: invocation.idempotencyKey,
        argumentsDigest: invocation.argumentsDigest,
        signal: controller.signal,
        emit: (type, data) => this.emit(run, type, data),
      },
      tool,
      validation.input,
    );
    this.storage.finishToolInvocation(invocation.id, result.ok ? 'completed' : 'failed', result);
    if (isAmbiguousToolResult(result)) {
      this.emit(run, 'tool.execution.ambiguous', {
        callId: invocation.callId,
        tool: invocation.toolName,
        effect: tool.effect,
        idempotency: tool.idempotency,
        argumentsDigest: invocation.argumentsDigest ?? null,
        error: result.error?.message ?? 'Tool execution did not settle after cancellation',
      });
    }
    return result;
  }

  private async flushBatch(batch: ToolBatchRecord): Promise<void> {
    if (batch.status === 'flushed') return;
    const invocations = this.storage.listToolInvocations(batch.id);
    if (invocations.some((invocation) => invocation.status === 'pending_approval' || invocation.status === 'running')) {
      return;
    }
    const events = this.storage.flushToolBatch(batch.id);
    for (const event of events) {
      for (const listener of this.#listeners) listener(event);
    }
  }

  private batchHasPendingApproval(batch: ToolBatchRecord): boolean {
    return this.storage
      .listToolInvocations(batch.id)
      .some((invocation) => invocation.status === 'pending_approval');
  }

  private deriveMessages(sessionId: string): ModelMessage[] {
    const events = this.storage.contextEventsForSession(sessionId);
    const lastCompaction = [...events].reverse().find((event) => event.type === 'context.compacted');
    const throughSeq = lastCompaction && isObject(lastCompaction.data) && typeof lastCompaction.data.throughSeq === 'number'
      ? lastCompaction.data.throughSeq
      : -1;
    const messages: ModelMessage[] = [];
    if (lastCompaction && isObject(lastCompaction.data) && typeof lastCompaction.data.summary === 'string') {
      messages.push({
        role: 'user',
        content: `<conversation_summary trust="derived" through_seq="${throughSeq}">${lastCompaction.data.summary}</conversation_summary>`,
      });
    }
    for (const event of events) {
      if (event.seq <= throughSeq) continue;
      if (!isObject(event.data)) continue;
      if (event.type === 'user.message' && isObject(event.data.message) && typeof event.data.message.content === 'string') {
        messages.push({ role: 'user', content: event.data.message.content });
      } else if (event.type === 'assistant.message' && isObject(event.data.message)) {
        const content = typeof event.data.message.content === 'string' ? event.data.message.content : null;
        const rawCalls = event.data.message.toolCalls;
        const toolCalls = Array.isArray(rawCalls)
          ? rawCalls
              .filter(isObject)
              .filter((call) => typeof call.id === 'string' && typeof call.name === 'string' && typeof call.arguments === 'string')
              .map((call) => ({ id: String(call.id), name: String(call.name), arguments: String(call.arguments) }))
          : [];
        messages.push({ role: 'assistant', content, ...(toolCalls.length ? { toolCalls } : {}) });
      } else if (event.type === 'tool.result') {
        if (typeof event.data.callId !== 'string' || typeof event.data.name !== 'string') continue;
        messages.push({
          role: 'tool',
          toolCallId: event.data.callId,
          name: event.data.name,
          content: JSON.stringify(event.data.result ?? null),
        });
      }
    }
    return messages;
  }

  private compactIfNeeded(
    run: RunRecord,
    messages: ModelMessage[],
    system: string,
    tools: ModelRequest['tools'],
  ): ModelMessage[] {
    const requestTokens = (candidate: ModelMessage[]): number => estimateRequestTokens({
      messages: [{ role: 'system', content: system }, ...candidate],
      tools,
    });
    if (requestTokens(messages) <= this.#agent.budgets.maxInputTokens) return messages;
    const events = this.storage.contextEventsForSession(run.sessionId);
    const completedRuns = events.filter(
      (event) =>
        event.runId !== run.id &&
        (event.type === 'run.succeeded' || event.type === 'run.failed' || event.type === 'run.cancelled'),
    );
    const boundary = completedRuns.at(-1);
    if (!boundary) throw new Error('Context budget exceeded within the active run; refusing to split a tool boundary');
    const oldEvents = events.filter((event) => event.seq <= boundary.seq);
    const summary = summarizeEvents(oldEvents);
    this.emit(run, 'context.compacted', {
      throughSeq: boundary.seq,
      summary,
      algorithm: 'deterministic-v1',
      rawEventsRetained: true,
    });
    const compacted = this.deriveMessages(run.sessionId);
    if (requestTokens(compacted) > this.#agent.budgets.maxInputTokens) {
      throw new Error('Context remains over budget after deterministic compaction');
    }
    return compacted;
  }

  private enforceBudget(run: RunRecord): void {
    if (run.step >= this.#agent.budgets.maxSteps) {
      throw new Error(`Step budget exceeded (${this.#agent.budgets.maxSteps})`);
    }
    // Reaching the tool budget must still permit one final model turn that
    // summarizes the completed tool result. Additional calls are rejected at
    // the response boundary before any invocation is prepared.
    if (remainingWallTime(run, this.#agent.budgets.maxWallTimeMs) <= 0) {
      throw new Error('Run wall-time budget exceeded');
    }
  }

  private captureSnapshots(): RunSnapshotSet {
    return captureRunSnapshots({
      agent: this.#agent,
      systemPromptCommitment: this.#profile.systemPrompt === undefined
        ? `static:${this.#agent.system}`
        : typeof this.#profile.systemPrompt === 'string'
          ? `static:${this.#profile.systemPrompt}`
          : `function:${Function.prototype.toString.call(this.#profile.systemPrompt)}`,
      runtimeProfile: {
        task: this.#profile.task ?? 'supervisor',
        retrieveMemory: this.#profile.retrieveMemory !== false,
        maxModelAttempts: this.#profile.maxModelAttempts ?? 2,
        ...(this.#profile.validateFinalOutput
          ? {
              finalOutputValidatorCommitment:
                `function:${Function.prototype.toString.call(this.#profile.validateFinalOutput)}`,
            }
          : {}),
      },
      skills: this.skills,
      tools: this.#agent.tools.map((name) => {
        const tool = this.kernel.tool(name);
        if (!tool) throw new Error(`Cannot allocate run with unresolved agent tool: ${name}`);
        return tool;
      }),
      policy: this.config.policy,
      policyGuards: this.kernel.listToolGuardPlugins(),
    });
  }

  private assertSnapshotBinding(run: RunRecord): void {
    // Pre-migration runs remain recoverable. Every newly allocated run has all
    // three bindings and must resume only under the exact committed contract.
    if (!run.snapshots) return;
    this.storage.getRunSnapshots(run.id);
    const current = runSnapshotDigests(this.captureSnapshots());
    for (const kind of ['agent', 'tools', 'policy'] as const) {
      if (run.snapshots[kind] !== current[kind]) {
        throw new Error(`Run ${kind} snapshot does not match the active runtime`);
      }
    }
  }

  private assertRecoveryCompatibility(run: RunRecord): void {
    if (run.agentVersion !== this.#agent.version) {
      throw new RunRecoveryError(
        'agent_version_mismatch',
        `Run agent version ${run.agentVersion} does not match active version ${this.#agent.version}`,
      );
    }
    if (!run.snapshots) return;
    try {
      this.storage.getRunSnapshots(run.id);
    } catch (error) {
      throw new RunRecoveryError('snapshot_invalid', errorMessage(error));
    }
    let current: ReturnType<typeof runSnapshotDigests>;
    try {
      current = runSnapshotDigests(this.captureSnapshots());
    } catch (error) {
      throw new RunRecoveryError('snapshot_invalid', errorMessage(error));
    }
    for (const kind of ['agent', 'tools', 'policy'] as const) {
      if (run.snapshots[kind] !== current[kind]) {
        throw new RunRecoveryError(
          'snapshot_mismatch',
          `Run ${kind} snapshot does not match the active runtime`,
        );
      }
    }
  }

  private quarantineRecoveryFailure(
    run: RunRecord,
    error: unknown,
    toolExecutionResumed = false,
  ): RunOutcome | undefined {
    const reason = error instanceof RunRecoveryError ? error.reason : 'recovery_unrecoverable';
    const detail = truncate(errorMessage(error), 500);
    const invocationRisk = this.recoveryInvocationRisk(run.id);
    const message = `Recovery failed closed [${reason}]: ${detail}${recoveryRiskMessage(invocationRisk)}`;
    let failed: RunRecord;
    try {
      const current = this.storage.getRun(run.id);
      if (terminalRun(current.status)) return undefined;
      const transition = this.storage.transitionRunAndAppend(
        run.id,
        ['running', 'waiting_for_approval'],
        'failed',
        'run.recovery.failed',
        {
          reason,
          error: detail,
          expectedAgentVersion: this.#agent.version,
          actualAgentVersion: run.agentVersion,
          toolExecutionResumed,
          priorRunningInvocationCount: invocationRisk.priorRunningInvocationCount,
          externalOutcomeUnknown: invocationRisk.externalOutcomeUnknown,
        },
        { error: message },
      );
      failed = transition.run;
      for (const listener of this.#listeners) {
        try {
          listener(transition.event);
        } catch {
          // Listener delivery is best-effort after the atomic terminal commit.
        }
      }
    } catch {
      return undefined;
    }

    try {
      this.settleQuarantinedInvocations(run.id, message);
    } catch {
      // The run is already terminal, so cleanup failure cannot resume a tool.
    }
    try {
      this.emit(failed, 'run.failed', {
        reason: 'recovery_failed',
        recoveryReason: reason,
        priorRunningInvocationCount: invocationRisk.priorRunningInvocationCount,
        externalOutcomeUnknown: invocationRisk.externalOutcomeUnknown,
        error: message,
      });
    } catch {
      // The atomic recovery-failure transition above is the durable safety
      // boundary. A listener or follow-up event failure cannot reopen the run.
    }
    try {
      return this.outcome(run.id);
    } catch {
      return undefined;
    }
  }

  private quarantineCorruptRecoveryCandidate(
    candidate: Extract<RecoverableRunCandidate, { ok: false }>,
  ): void {
    const detail = truncate(candidate.error, 500);
    const invocationRisk = this.recoveryInvocationRisk(candidate.id);
    const message = `Recovery failed closed [corrupt_run_record]: ${detail}${recoveryRiskMessage(invocationRisk)}`;
    let quarantined: ReturnType<SqliteStorage['quarantineCorruptRecoverableRun']>;
    try {
      quarantined = this.storage.quarantineCorruptRecoverableRun(
        candidate.id,
        candidate.agentId,
        this.#agent.version,
        detail,
      );
    } catch {
      return;
    }
    if (!quarantined.changed) return;
    if (quarantined.event) {
      for (const listener of this.#listeners) {
        try {
          listener(quarantined.event);
        } catch {
          // Listener delivery is best-effort after the atomic terminal commit.
        }
      }
    }
    try {
      this.settleQuarantinedInvocations(candidate.id, message);
    } catch {
      // Raw row quarantine is already durable and prevents tool recovery.
    }
  }

  private settleQuarantinedInvocations(runId: string, message: string): void {
    for (const approval of this.storage.listApprovals(runId, 'pending')) {
      try {
        const resolved = this.storage.resolveApproval(
          approval.id,
          'reject',
          'openprojects-recovery',
          message,
          approval.argumentsDigest,
        );
        this.storage.finishToolInvocation(
          resolved.invocation.id,
          'denied',
          failedToolResult(
            resolved.invocation.callId,
            resolved.invocation.toolName,
            'RUN_RECOVERY_FAILED',
            message,
          ),
        );
        if (resolved.event) {
          for (const listener of this.#listeners) listener(resolved.event);
        }
      } catch {
        // The run is already terminal, so even a corrupt approval cannot be
        // recovered into execution. Continue settling any independent rows.
      }
    }
    let invocations: ToolInvocationRecord[];
    try {
      invocations = this.storage.listToolInvocationsForRun(runId);
    } catch {
      return;
    }
    for (const invocation of invocations) {
      if (invocation.status !== 'running') continue;
      try {
        this.storage.finishToolInvocation(
          invocation.id,
          'failed',
          failedToolResult(
            invocation.callId,
            invocation.toolName,
            RUN_RECOVERY_UNKNOWN_OUTCOME_CODE,
            message,
          ),
        );
      } catch {
        // The terminal run remains the fail-closed boundary.
      }
    }
  }

  private recoveryInvocationRisk(runId: string): RecoveryInvocationRisk {
    try {
      const running = this.storage
        .listToolInvocationsForRun(runId)
        .filter((invocation) => invocation.status === 'running');
      if (running.length === 0) return noRecoveryInvocationRisk();
      return {
        priorRunningInvocationCount: running.length,
        externalOutcomeUnknown: true,
      };
    } catch {
      return {
        priorRunningInvocationCount: 0,
        externalOutcomeUnknown: true,
      };
    }
  }

  private failRun(runId: string, message: string): RunOutcome {
    const current = this.storage.getRun(runId);
    if (current.status === 'failed') return this.outcome(runId);
    if (['succeeded', 'cancelled'].includes(current.status)) return this.outcome(runId);
    const failed = this.transitionWithEvent(
      runId,
      ['queued', 'running', 'waiting_for_approval'],
      'failed',
      'turn.ended',
      { turn: 1, reason: 'failed', error: message },
      { error: message },
    );
    this.emit(failed, 'run.failed', { error: message });
    return this.outcome(runId);
  }

  private stopForAmbiguousExecution(runId: string, toolName: string, result: ToolResult): RunOutcome {
    const message = ambiguousRunFailure(toolName, result);
    for (const approval of this.storage.listApprovals(runId, 'pending')) {
      const resolved = this.storage.resolveApproval(
        approval.id,
        'reject',
        'openprojects-runtime',
        'Run stopped after an ambiguous tool execution',
      );
      this.storage.finishToolInvocation(
        resolved.invocation.id,
        'denied',
        failedToolResult(
          resolved.invocation.callId,
          resolved.invocation.toolName,
          'RUN_STOPPED_AFTER_AMBIGUOUS_TOOL',
          'The run stopped before this pending action could execute',
        ),
      );
      if (resolved.event) {
        for (const listener of this.#listeners) listener(resolved.event);
      }
    }
    return this.failRun(runId, message);
  }

  private transitionWithEvent(
    runId: string,
    allowedFrom: RunRecord['status'][],
    status: RunRecord['status'],
    eventType: string,
    eventData: JsonValue,
    patch: Partial<Pick<RunRecord, 'output' | 'error' | 'step' | 'toolCalls'>> = {},
  ): RunRecord {
    const { run, event } = this.storage.transitionRunAndAppend(
      runId,
      allowedFrom,
      status,
      eventType,
      eventData,
      patch,
    );
    for (const listener of this.#listeners) listener(event);
    return run;
  }

  private emit(run: RunRecord, type: string, data: JsonValue): HarnessEvent {
    const event = this.storage.appendEvent(run.sessionId, run.id, type, data);
    for (const listener of this.#listeners) listener(event);
    return event;
  }
}

function failedToolResult(callId: string, name: string, code: string, message: string): ToolResult {
  return { callId, name, ok: false, error: { code, message }, durationMs: 0 };
}

function invalidNormalizedToolCall(
  call: ToolCall,
  index: number,
  tool: ToolDefinition | undefined,
  argumentsJson: string,
  message: string,
  argumentsDigest?: string,
  code: 'UNKNOWN_TOOL' | 'INVALID_TOOL_INPUT' = 'INVALID_TOOL_INPUT',
): NormalizedToolCall {
  return {
    valid: false,
    id: call.id,
    name: call.name,
    index,
    arguments: argumentsJson,
    ...(argumentsDigest ? { argumentsDigest } : {}),
    ...(tool ? { tool } : {}),
    error: { code, message },
  };
}

function isAmbiguousToolResult(result: ToolResult): boolean {
  return result.ok === false && result.error?.code === TOOL_EXECUTION_AMBIGUOUS_CODE;
}

function ambiguousRunFailure(toolName: string, result: ToolResult): string {
  return `Ambiguous tool execution for ${toolName}: ${result.error?.message ?? 'the tool did not settle after cancellation'}. `
    + 'The run stopped; verify the effect before retrying.';
}

function terminalRun(status: RunRecord['status']): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

function noRecoveryInvocationRisk(): RecoveryInvocationRisk {
  return {
    priorRunningInvocationCount: 0,
    externalOutcomeUnknown: false,
  };
}

function recoveryRiskMessage(risk: RecoveryInvocationRisk): string {
  return risk.externalOutcomeUnknown
    ? ' One or more tool invocations were already marked running before recovery; their external outcome is unknown. Verify the effect before retrying.'
    : '';
}

function rewardForReaction(reaction?: string): { score: number; dimensions: Record<string, number> } {
  const key = reaction?.toLowerCase();
  if (key === '😂' || key === 'laugh') return { score: 1, dimensions: { humor: 1, style: 0.5 } };
  if (key === '❤️' || key === 'heart') return { score: 1, dimensions: { empathy: 1, style: 0.5 } };
  if (key === '👍' || key === 'up') return { score: 1, dimensions: { helpfulness: 1, accuracy: 0.5 } };
  if (key === '👎' || key === 'down') return { score: -1, dimensions: { helpfulness: -1 } };
  if (key === '💀' || key === 'skull') return { score: -1, dimensions: { style: -1, cringe: 1 } };
  return { score: 0, dimensions: {} };
}

function invocationKey(runId: string, callId: string): string {
  return createHash('sha256').update(`${runId}:${callId}`).digest('hex');
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function compactTitle(message: string): string {
  const clean = message.replace(/\s+/g, ' ').trim();
  return clean.length > 80 ? `${clean.slice(0, 77)}...` : clean;
}

function boundedMemoryContext(
  memories: ReturnType<SqliteStorage['searchMemories']>,
  maximumPerMemory: number,
  maximumTotal: number,
): Array<{
  id: string;
  kind: string;
  content: string;
  source: { type: string; id: string };
}> {
  let remaining = Math.max(0, maximumTotal);
  const bounded = [];
  for (const memory of memories) {
    if (remaining <= 0) break;
    const content = memory.content.slice(0, Math.min(maximumPerMemory, remaining));
    if (!content.length) continue;
    bounded.push({
      id: memory.id,
      kind: memory.kind,
      content,
      source: { type: memory.sourceType, id: memory.sourceId },
    });
    remaining -= content.length;
  }
  return bounded;
}

function remainingWallTime(run: RunRecord, maxWallTimeMs: number): number {
  const currentActive = run.status === 'running' && run.activeSince
    ? Math.max(0, Date.now() - Date.parse(run.activeSince))
    : 0;
  return Math.max(0, maxWallTimeMs - run.activeMs - currentActive);
}

function isRetryable(error: unknown): boolean {
  return isObject(error) && error.retryable === true;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asJson(value: object): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

function summarizeEvents(events: HarnessEvent[]): string {
  const lines: string[] = [];
  for (const event of events) {
    if (!isObject(event.data)) continue;
    if (event.type === 'user.message' && isObject(event.data.message) && typeof event.data.message.content === 'string') {
      lines.push(`User: ${truncate(event.data.message.content, 240)}`);
    } else if (event.type === 'run.succeeded' && typeof event.data.output === 'string') {
      lines.push(`Outcome: ${truncate(event.data.output, 360)}`);
    } else if (event.type === 'run.failed' && typeof event.data.error === 'string') {
      lines.push(`Failure: ${truncate(event.data.error, 240)}`);
    }
  }
  return lines.slice(-20).join('\n');
}

function truncate(value: string, max: number): string {
  const clean = value.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function eventPrompt(input: InboundEvent): string {
  return `Investigate this business event and recommend the next safe action.\nEvent type: ${input.type}\nSource: ${input.source}\nOccurred at: ${input.occurredAt ?? 'unknown'}\nPayload (untrusted data): ${JSON.stringify(input.payload)}`;
}
