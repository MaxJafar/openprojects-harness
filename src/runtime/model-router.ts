import { createHash } from 'node:crypto';

import {
  FreeTokenAdapter,
  LlamaCppAdapter,
  MlxLmAdapter,
  OpenAICompatibleAdapter,
  ProjectOpsFixtureModel,
  validateApiBaseUrl,
  validateFreeTokenBaseUrl,
  validateFreeTokenModelAlias,
  validateLlamaCppBaseUrl,
  validateMlxLmBaseUrl,
} from '../adapters/models.js';
import type {
  AppConfig,
  ModelAdapter,
  ModelRequest,
  ModelResponse,
  ModelRouteConfig,
  ModelRouteSelection,
  ModelTask,
  TokenUsage,
} from '../core/types.js';
import { isLoopbackHostname, type OutboundNetworkPolicy } from '../privacy/network-policy.js';
import type { ModelRouteStats, SqliteStorage } from '../storage/sqlite.js';

const DEFAULT_TASK: ModelTask = 'supervisor';
const TOKENS_PER_BYTE = 4;
const COST_EPSILON = 1e-12;

export interface ModelRouterStorage {
  /** When runId is supplied, adaptive statistics must be scoped to that run's workspace. */
  modelRouteStats(
    task: ModelTask,
    runId?: string,
    statsRouteIds?: readonly string[],
  ): ModelRouteStats[];
  recordModelRouteCall(input: {
    runId: string;
    selection: ModelRouteSelection;
    /** Digest-bound adaptive identity; selection.routeId remains operator-readable. */
    statsRouteId?: string;
    success: boolean;
    costUsd: number;
    latencyMs: number;
  }): void;
  modelSpendSince(since: string): number;
}

export interface ModelRouterOptions {
  id?: string;
  routes: ModelRouteConfig[];
  storage: ModelRouterStorage;
  dailyBudgetUsd: number;
  explorationRate?: number;
  externalInference?: 'deny' | 'allow';
  preferLocal?: boolean;
  allowRemoteFallback?: boolean;
  adapters?: ReadonlyMap<string, ModelAdapter> | Readonly<Record<string, ModelAdapter>>;
  adapterFactory?: (route: ModelRouteConfig) => ModelAdapter;
  now?: () => Date;
  random?: () => number;
  onTelemetryError?: (error: unknown) => void;
  networkPolicy?: OutboundNetworkPolicy;
}

export interface RouteAttemptFailure {
  routeId: string;
  error: unknown;
}

export class ModelRoutingError extends Error {
  constructor(
    message: string,
    readonly failures: RouteAttemptFailure[] = [],
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ModelRoutingError';
  }
}

export class NoModelRouteError extends ModelRoutingError {
  constructor(message: string) {
    super(message);
    this.name = 'NoModelRouteError';
  }
}

export class ModelBudgetExceededError extends ModelRoutingError {
  constructor(
    readonly dailyBudgetUsd: number,
    readonly spentUsd: number,
    readonly leastEstimatedCostUsd: number,
  ) {
    super(
      `No model route fits the remaining daily budget: spent $${formatCost(spentUsd)} of `
        + `$${formatCost(dailyBudgetUsd)}; cheapest eligible request is `
        + `$${formatCost(leastEstimatedCostUsd)}`,
    );
    this.name = 'ModelBudgetExceededError';
  }
}

export class ModelAccountingError extends ModelRoutingError {
  constructor(cause?: unknown) {
    super('Paid model routing stopped because the spend ledger could not be updated', [], cause);
    this.name = 'ModelAccountingError';
  }
}

interface RankedRoute {
  route: ModelRouteConfig;
  estimatedInputTokens: number;
  estimatedCostUsd: number;
  score: number;
  quality: number;
  economy: number;
  reliability: number;
  learnedReward: number;
  latencyScore: number;
}

/**
 * Task-aware, budget-constrained ModelAdapter with learned route telemetry.
 *
 * Non-mock routes use an OpenAI-compatible HTTP boundary. Providers `mlx-lm`,
 * `llama.cpp`, and `freetoken` select stricter loopback-only adapters; all
 * other providers use the general compatible adapter.
 */
export class ModelRouter implements ModelAdapter {
  readonly id: string;
  readonly #routes: ModelRouteConfig[];
  readonly #storage: ModelRouterStorage;
  readonly #dailyBudgetUsd: number;
  readonly #explorationRate: number;
  readonly #preferLocal: boolean;
  readonly #allowRemoteFallback: boolean;
  readonly #injectedAdapters: ModelRouterOptions['adapters'];
  readonly #adapterFactory: (route: ModelRouteConfig) => ModelAdapter;
  readonly #adapterCache = new Map<string, ModelAdapter>();
  readonly #now: () => Date;
  readonly #random: () => number;
  readonly #onTelemetryError: ((error: unknown) => void) | undefined;
  #reservedCostUsd = 0;
  #accountingHealthy = true;

  constructor(options: ModelRouterOptions) {
    this.id = options.id ?? 'model-router';
    this.#routes = validateRoutes(options.routes, options.externalInference ?? 'deny');
    this.#storage = options.storage;
    this.#dailyBudgetUsd = nonNegativeFinite(options.dailyBudgetUsd, 'dailyBudgetUsd');
    this.#explorationRate = fraction(options.explorationRate ?? 0, 'explorationRate');
    this.#preferLocal = options.preferLocal ?? true;
    this.#allowRemoteFallback = options.allowRemoteFallback ?? false;
    this.#injectedAdapters = options.adapters;
    this.#adapterFactory = options.adapterFactory
      ?? ((route) => defaultAdapterFactory(route, options.networkPolicy));
    this.#now = options.now ?? (() => new Date());
    this.#random = options.random ?? Math.random;
    this.#onTelemetryError = options.onTelemetryError;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    throwIfAborted(request.signal);
    const task = request.task ?? DEFAULT_TASK;
    const eligible = this.#eligibleRoutes(request, task);
    if (eligible.length === 0) {
      throw new NoModelRouteError(
        `No enabled model route supports task ${task} within the estimated context requirement`,
      );
    }

    const spentAtStart = this.#spendToday();
    const availableAtStart = Math.max(
      0,
      this.#dailyBudgetUsd - spentAtStart - this.#reservedCostUsd,
    );
    const affordable = eligible.filter(
      (candidate) => candidate.estimatedCostUsd <= availableAtStart + COST_EPSILON,
    );
    if (affordable.length === 0) {
      throw new ModelBudgetExceededError(
        this.#dailyBudgetUsd,
        spentAtStart,
        Math.min(...eligible.map((candidate) => candidate.estimatedCostUsd)),
      );
    }

    const ordered = this.#orderForAttempt(affordable);
    const first = ordered[0];
    const attempts = first?.route.local && !this.#allowRemoteFallback
      ? ordered.filter((candidate) => candidate.route.local)
      : ordered;
    const primaryRouteId = attempts[0]?.route.id;
    const failures: RouteAttemptFailure[] = [];
    const budgetSkipped: number[] = [];

    for (const [index, candidate] of attempts.entries()) {
      throwIfAborted(request.signal);
      if (!this.#reserve(candidate.estimatedCostUsd)) {
        budgetSkipped.push(candidate.estimatedCostUsd);
        continue;
      }

      const selection = routeSelection(candidate, task, {
        explored: index === 0 && attempts[0] !== affordable[0],
        ...(index > 0 && primaryRouteId ? { fallbackFrom: primaryRouteId } : {}),
      });
      const startedAt = performance.now();
      try {
        const adapter = this.#adapter(candidate.route);
        let response: ModelResponse;
        try {
          response = await adapter.complete({
            ...request,
            provider: candidate.route.provider,
            model: candidate.route.model,
            task,
          });
        } catch (error) {
          const latencyMs = elapsedMilliseconds(startedAt);
          this.#record({
            runId: request.runId,
            selection: { ...selection, latencyMs },
            statsRouteId: modelRouteStatsIdentity(candidate.route),
            success: false,
            costUsd: candidate.estimatedCostUsd,
            latencyMs,
          }, candidate.estimatedCostUsd > COST_EPSILON);
          if (request.signal.aborted) throw abortReason(request.signal);
          failures.push({ routeId: candidate.route.id, error });
          if (!isRetryableModelFailure(error)) break;
          continue;
        }
        const latencyMs = elapsedMilliseconds(startedAt);
        const costUsd = responseCost(candidate.route, response, candidate.estimatedCostUsd);
        const completedSelection: ModelRouteSelection = { ...selection, latencyMs };
        this.#record({
          runId: request.runId,
          selection: completedSelection,
          statsRouteId: modelRouteStatsIdentity(candidate.route),
          success: true,
          costUsd,
          latencyMs,
        }, costUsd > COST_EPSILON);
        return {
          ...response,
          model: response.model ?? candidate.route.model,
          route: completedSelection,
        };
      } finally {
        this.#release(candidate.estimatedCostUsd);
      }
    }

    if (budgetSkipped.length > 0) {
      const spent = this.#spendToday();
      throw new ModelBudgetExceededError(
        this.#dailyBudgetUsd,
        spent,
        Math.min(...budgetSkipped),
      );
    }
    const cause = failures.at(-1)?.error;
    throw new ModelRoutingError(
      `All ${failures.length} attempted model routes failed for task ${task}: `
        + failures.map((failure) => failure.routeId).join(', '),
      failures,
      cause,
    );
  }

  #eligibleRoutes(request: ModelRequest, task: ModelTask): RankedRoute[] {
    const estimatedInputTokens = estimateRequestTokens(request);
    const taskRoutes = this.#routes.filter(
      (route) => route.enabled
        && route.tasks.includes(task)
        && route.quality >= minimumQuality(task)
        && estimatedInputTokens + request.maxOutputTokens <= route.contextWindow,
    );
    const statsRouteIds = new Map(
      taskRoutes.map((route) => [route.id, modelRouteStatsIdentity(route)]),
    );
    const stats = this.#routeStats(task, request.runId, [...statsRouteIds.values()]);
    const estimates = taskRoutes.map((route) => ({
      route,
      estimatedCostUsd: calculateUsageCostUsd(
        route,
        estimatedInputTokens,
        request.maxOutputTokens,
      ),
    }));
    const maximumCost = Math.max(0, ...estimates.map((entry) => entry.estimatedCostUsd));
    const averageLatencies = estimates.map(({ route }) => averageLatency(stats.get(statsRouteIds.get(route.id)!)));
    const maximumLatency = Math.max(0, ...averageLatencies);
    const weights = scoreWeights(task);

    const ranked = estimates
      .map(({ route, estimatedCostUsd }): RankedRoute => {
        const routeStats = stats.get(statsRouteIds.get(route.id)!);
        const reliability = routeStats && routeStats.attempts > 0
          ? clamp(routeStats.successes / routeStats.attempts, 0, 1)
          : 0.5;
        const learnedReward = routeStats && routeStats.rewardCount > 0
          ? clamp((routeStats.rewardSum / routeStats.rewardCount + 1) / 2, 0, 1)
          : 0.5;
        const economy = maximumCost === 0 ? 1 : 1 - estimatedCostUsd / maximumCost;
        const latency = averageLatency(routeStats);
        const latencyScore = maximumLatency === 0 || latency === 0
          ? 0.5
          : 1 - latency / maximumLatency;
        const quality = clamp(route.quality, 0, 1);
        const localBonus = route.local ? 0.015 : 0;
        const score = quality * weights.quality
          + economy * weights.economy
          + reliability * weights.reliability
          + learnedReward * weights.reward
          + latencyScore * weights.latency
          + localBonus;
        return {
          route,
          estimatedInputTokens,
          estimatedCostUsd,
          score,
          quality,
          economy,
          reliability,
          learnedReward,
          latencyScore,
        };
      })
      .sort((left, right) => right.score - left.score || compareAscii(left.route.id, right.route.id));
    if (!this.#preferLocal || !ranked.some((candidate) => candidate.route.local)) return ranked;
    return [
      ...ranked.filter((candidate) => candidate.route.local),
      ...ranked.filter((candidate) => !candidate.route.local),
    ];
  }

  #orderForAttempt(ranked: RankedRoute[]): RankedRoute[] {
    if (ranked.length < 2 || boundedRandom(this.#random) >= this.#explorationRate) {
      return [...ranked];
    }
    const primary = ranked[0];
    if (!primary) return [...ranked];
    // Exploration is a quality mechanism, never permission to cross the
    // loopback/external disclosure boundary.
    const alternates = ranked.slice(1).filter(
      (candidate) => candidate.route.local === primary.route.local,
    );
    if (alternates.length === 0) return [...ranked];
    const alternateIndex = Math.floor(boundedRandom(this.#random) * alternates.length);
    const explored = alternates[alternateIndex];
    if (!explored) return [...ranked];
    return [explored, ...ranked.filter((candidate) => candidate !== explored)];
  }

  #adapter(route: ModelRouteConfig): ModelAdapter {
    const cached = this.#adapterCache.get(route.id);
    if (cached) return cached;
    const injected = findInjectedAdapter(this.#injectedAdapters, route);
    const adapter = injected ?? this.#adapterFactory(route);
    this.#adapterCache.set(route.id, adapter);
    return adapter;
  }

  #routeStats(
    task: ModelTask,
    runId: string,
    statsRouteIds: readonly string[],
  ): Map<string, ModelRouteStats> {
    try {
      return new Map(
        this.#storage.modelRouteStats(task, runId, statsRouteIds)
          .map((stats) => [stats.routeId, stats]),
      );
    } catch (error) {
      this.#telemetryError(error);
      return new Map();
    }
  }

  #spendToday(): number {
    const current = this.#now();
    if (Number.isNaN(current.getTime())) throw new Error('Model router clock returned an invalid date');
    const since = new Date(Date.UTC(
      current.getUTCFullYear(),
      current.getUTCMonth(),
      current.getUTCDate(),
    )).toISOString();
    const spend = this.#storage.modelSpendSince(since);
    return nonNegativeFinite(spend, 'stored daily model spend');
  }

  #reserve(costUsd: number): boolean {
    // Once the paid budget is exhausted, genuinely free local routes remain
    // available because they cannot increase the recorded spend.
    if (costUsd <= COST_EPSILON) return true;
    if (!this.#accountingHealthy) throw new ModelAccountingError();
    const spent = this.#spendToday();
    if (spent + this.#reservedCostUsd + costUsd > this.#dailyBudgetUsd + COST_EPSILON) {
      return false;
    }
    this.#reservedCostUsd += costUsd;
    return true;
  }

  #release(costUsd: number): void {
    this.#reservedCostUsd = Math.max(0, this.#reservedCostUsd - costUsd);
  }

  #record(
    input: Parameters<ModelRouterStorage['recordModelRouteCall']>[0],
    accountingRequired: boolean,
  ): void {
    try {
      this.#storage.recordModelRouteCall(input);
    } catch (error) {
      this.#telemetryError(error);
      if (accountingRequired) {
        this.#accountingHealthy = false;
        throw new ModelAccountingError(error);
      }
    }
  }

  #telemetryError(error: unknown): void {
    try {
      this.#onTelemetryError?.(error);
    } catch {
      // Observability hooks must never change routing behavior.
    }
  }
}

function minimumQuality(task: ModelTask): number {
  switch (task) {
    case 'supervisor': return 0.65;
    case 'project_analysis': return 0.55;
    case 'memory_curator': return 0.3;
    case 'summarization': return 0.25;
    case 'notification': return 0.2;
  }
}

export function createModelRouter(
  config: NonNullable<AppConfig['routing']>,
  storage: SqliteStorage,
  options: Omit<
    ModelRouterOptions,
    'routes' | 'storage' | 'dailyBudgetUsd' | 'explorationRate' | 'externalInference' | 'preferLocal' | 'allowRemoteFallback'
  > = {},
): ModelRouter {
  return new ModelRouter({
    ...options,
    routes: config.routes,
    storage,
    dailyBudgetUsd: config.dailyBudgetUsd,
    explorationRate: config.explorationRate,
    externalInference: config.externalInference ?? 'deny',
    preferLocal: config.preferLocal ?? true,
    allowRemoteFallback: config.allowRemoteFallback ?? false,
  });
}

/** Calculates provider cost from actual or estimated token counts. */
export function calculateUsageCostUsd(
  route: Pick<ModelRouteConfig, 'inputCostPerMillion' | 'outputCostPerMillion'>,
  inputTokens: number,
  outputTokens: number,
): number {
  const input = nonNegativeFinite(inputTokens, 'inputTokens');
  const output = nonNegativeFinite(outputTokens, 'outputTokens');
  const inputRate = nonNegativeFinite(route.inputCostPerMillion, 'inputCostPerMillion');
  const outputRate = nonNegativeFinite(route.outputCostPerMillion, 'outputCostPerMillion');
  return (input * inputRate + output * outputRate) / 1_000_000;
}

/** Conservative token estimate used only for budget and context checks. */
export function estimateRequestTokens(request: Pick<ModelRequest, 'messages' | 'tools'>): number {
  const payloadBytes = Buffer.byteLength(JSON.stringify({
    messages: request.messages,
    tools: request.tools,
  }), 'utf8');
  const structuralTokens = request.messages.length * 8 + request.tools.length * 24;
  return Math.max(1, Math.ceil(payloadBytes / TOKENS_PER_BYTE) + structuralTokens);
}

/**
 * Adaptive statistics identity. Human-facing route IDs remain stable, while a
 * provider/model/endpoint or operator generation change starts a clean lane.
 */
export function modelRouteStatsIdentity(route: ModelRouteConfig): string {
  const endpoint = route.baseUrl
    ? new URL(route.baseUrl).toString().replace(/\/$/u, '')
    : null;
  const identity = JSON.stringify({
    schema: 'openprojects.model-route-stats-identity.v1',
    id: route.id,
    provider: route.provider,
    model: route.model,
    generation: route.generation ?? null,
    endpoint,
    local: route.local,
    contextWindow: route.contextWindow,
    tasks: [...route.tasks].sort(compareAscii),
    wireProfile: routeWireProfile(route.provider),
  });
  return `${route.id}@sha256:${createHash('sha256').update(identity).digest('hex')}`;
}

function responseCost(
  route: ModelRouteConfig,
  response: ModelResponse,
  estimatedCostUsd: number,
): number {
  const usage = validUsage(response.usage);
  if (!usage) return estimatedCostUsd;
  const inputTokens = usage.inputTokens;
  const outputTokens = usage.outputTokens;
  return calculateUsageCostUsd(route, inputTokens, outputTokens);
}

function validUsage(usage: TokenUsage | undefined): TokenUsage | undefined {
  if (!usage) return undefined;
  if (![usage.inputTokens, usage.outputTokens, usage.totalTokens].every(
    (value) => Number.isSafeInteger(value) && value >= 0,
  )) return undefined;
  if (usage.totalTokens === 0 || usage.totalTokens !== usage.inputTokens + usage.outputTokens) {
    return undefined;
  }
  return usage;
}

function routeSelection(
  candidate: RankedRoute,
  task: ModelTask,
  options: { explored: boolean; fallbackFrom?: string },
): ModelRouteSelection {
  const reason = [
    options.explored ? 'exploration' : options.fallbackFrom ? 'fallback' : 'ranked selection',
    `task=${task}`,
    `score=${candidate.score.toFixed(3)}`,
    `quality=${candidate.quality.toFixed(2)}`,
    `economy=${candidate.economy.toFixed(2)}`,
    `reliability=${candidate.reliability.toFixed(2)}`,
    `reward=${candidate.learnedReward.toFixed(2)}`,
    `latency=${candidate.latencyScore.toFixed(2)}`,
  ].join('; ');
  return {
    routeId: candidate.route.id,
    provider: candidate.route.provider,
    model: candidate.route.model,
    local: candidate.route.local,
    task,
    reason,
    estimatedCostUsd: candidate.estimatedCostUsd,
    ...(options.fallbackFrom ? { fallbackFrom: options.fallbackFrom } : {}),
  };
}

function scoreWeights(task: ModelTask): {
  quality: number;
  economy: number;
  reliability: number;
  reward: number;
  latency: number;
} {
  switch (task) {
    case 'supervisor':
    case 'project_analysis':
      return { quality: 0.48, economy: 0.12, reliability: 0.22, reward: 0.12, latency: 0.06 };
    case 'memory_curator':
      return { quality: 0.30, economy: 0.30, reliability: 0.18, reward: 0.16, latency: 0.06 };
    case 'summarization':
      return { quality: 0.32, economy: 0.34, reliability: 0.16, reward: 0.10, latency: 0.08 };
    case 'notification':
      return { quality: 0.22, economy: 0.36, reliability: 0.18, reward: 0.08, latency: 0.16 };
  }
}

function defaultAdapterFactory(
  route: ModelRouteConfig,
  networkPolicy?: OutboundNetworkPolicy,
): ModelAdapter {
  if (route.provider === 'mock') return new ProjectOpsFixtureModel();
  if (!route.baseUrl) {
    throw new Error(`Model route ${route.id} requires an OpenAI-compatible baseUrl`);
  }
  if (route.provider === 'mlx-lm') {
    if (!route.local) throw new Error(`MLX-LM route ${route.id} must declare local: true`);
    if (route.apiKey || route.apiKeyEnv) {
      throw new Error(`MLX-LM route ${route.id} must not configure an API key`);
    }
    return new MlxLmAdapter({
      id: route.id,
      baseUrl: route.baseUrl,
      ...(networkPolicy ? { networkPolicy } : {}),
    });
  }
  if (route.provider === 'llama.cpp') {
    if (!route.local) throw new Error(`llama.cpp route ${route.id} must declare local: true`);
    const apiKey = route.apiKey ?? (route.apiKeyEnv ? process.env[route.apiKeyEnv] : undefined);
    if (!apiKey) {
      throw new Error(`llama.cpp route ${route.id} requires a dedicated API key`);
    }
    return new LlamaCppAdapter({
      id: route.id,
      baseUrl: route.baseUrl,
      apiKey,
      modelAlias: route.model,
      ...(networkPolicy ? { networkPolicy } : {}),
    });
  }
  if (route.provider === 'freetoken') {
    if (!route.local) throw new Error(`FreeToken route ${route.id} must declare local: true`);
    if (route.apiKey || route.apiKeyEnv) {
      throw new Error(`FreeToken route ${route.id} must not configure an API key`);
    }
    return new FreeTokenAdapter({
      id: route.id,
      baseUrl: route.baseUrl,
      modelAlias: route.model,
      ...(networkPolicy ? { networkPolicy } : {}),
    });
  }
  const normalizedBaseUrl = validateApiBaseUrl(route.baseUrl, `Model route ${route.id}`);
  const loopback = isLoopbackUrl(normalizedBaseUrl);
  if (route.local !== loopback) {
    throw new Error(
      `Model route ${route.id} local=${String(route.local)} does not match its baseUrl boundary`,
    );
  }
  if (!loopback && route.apiKey) {
    throw new Error(`Model route ${route.id} must use apiKeyEnv instead of an inline external API key`);
  }
  if (route.apiKeyEnv && !isEnvironmentName(route.apiKeyEnv)) {
    throw new Error(`Model route ${route.id} apiKeyEnv must match [A-Z_][A-Z0-9_]*`);
  }
  const apiKey = route.apiKey ?? (route.apiKeyEnv ? process.env[route.apiKeyEnv] : undefined);
  if (!apiKey && !loopback) {
    throw new Error(`Model route ${route.id} requires an API key outside loopback`);
  }
  return new OpenAICompatibleAdapter({
    id: route.id,
    baseUrl: normalizedBaseUrl,
    ...(apiKey ? { apiKey } : {}),
    ...(networkPolicy ? { networkPolicy } : {}),
  });
}

function isLoopbackUrl(value: string): boolean {
  try {
    return isLoopbackHostname(new URL(value).hostname);
  } catch {
    return false;
  }
}

function findInjectedAdapter(
  adapters: ModelRouterOptions['adapters'],
  route: ModelRouteConfig,
): ModelAdapter | undefined {
  if (!adapters) return undefined;
  const maybeMap = adapters as ReadonlyMap<string, ModelAdapter>;
  if (typeof maybeMap.get === 'function') {
    return maybeMap.get(route.id) ?? maybeMap.get(route.provider) ?? maybeMap.get(route.model);
  }
  const record = adapters as Readonly<Record<string, ModelAdapter>>;
  return record[route.id] ?? record[route.provider] ?? record[route.model];
}

function validateRoutes(
  routes: ModelRouteConfig[],
  externalInference: 'deny' | 'allow',
): ModelRouteConfig[] {
  const ids = new Set<string>();
  return routes.map((route) => {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/u.test(route.id)) {
      throw new Error('Model route id must be 1-128 safe ASCII identifier characters');
    }
    if (ids.has(route.id)) throw new Error(`Duplicate model route id: ${route.id}`);
    ids.add(route.id);
    if (!route.provider.trim()) throw new Error(`Model route ${route.id} provider must not be empty`);
    if (!route.model.trim()) throw new Error(`Model route ${route.id} model must not be empty`);
    if (route.provider === 'mlx-lm') {
      if (!route.local) throw new Error(`MLX-LM route ${route.id} must declare local: true`);
      if (!route.baseUrl) throw new Error(`MLX-LM route ${route.id} requires baseUrl`);
      if (route.apiKey || route.apiKeyEnv) {
        throw new Error(`MLX-LM route ${route.id} must not configure an API key`);
      }
      validateMlxLmBaseUrl(route.baseUrl);
    }
    if (route.provider === 'llama.cpp') {
      if (!route.local) throw new Error(`llama.cpp route ${route.id} must declare local: true`);
      if (!route.baseUrl) throw new Error(`llama.cpp route ${route.id} requires baseUrl`);
      if (!route.apiKey && !route.apiKeyEnv) {
        throw new Error(`llama.cpp route ${route.id} requires a dedicated API key`);
      }
      validateLlamaCppBaseUrl(route.baseUrl);
    }
    if (route.provider === 'freetoken') {
      if (!route.local) throw new Error(`FreeToken route ${route.id} must declare local: true`);
      if (!route.baseUrl) throw new Error(`FreeToken route ${route.id} requires baseUrl`);
      if (route.apiKey || route.apiKeyEnv) {
        throw new Error(`FreeToken route ${route.id} must not configure an API key`);
      }
      validateFreeTokenBaseUrl(route.baseUrl);
      validateFreeTokenModelAlias(route.model);
    }
    if (route.apiKeyEnv && !isEnvironmentName(route.apiKeyEnv)) {
      throw new Error(`Model route ${route.id} apiKeyEnv must match [A-Z_][A-Z0-9_]*`);
    }
    if (route.generation !== undefined
      && !/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/u.test(route.generation)) {
      throw new Error(`Model route ${route.id} generation must be a 1-128 character safe identifier`);
    }
    if (route.baseUrl && !['mlx-lm', 'llama.cpp', 'freetoken'].includes(route.provider)) {
      const normalizedBaseUrl = validateApiBaseUrl(route.baseUrl, `Model route ${route.id}`);
      const loopback = isLoopbackUrl(normalizedBaseUrl);
      if (route.local !== loopback) {
        throw new Error(
          `Model route ${route.id} local=${String(route.local)} does not match its baseUrl boundary`,
        );
      }
      if (!loopback && route.apiKey) {
        throw new Error(`Model route ${route.id} must use apiKeyEnv instead of an inline external API key`);
      }
      if (!loopback && !route.apiKeyEnv) {
        throw new Error(`Model route ${route.id} requires apiKeyEnv outside loopback`);
      }
    }
    if (route.tasks.length === 0) throw new Error(`Model route ${route.id} must support at least one task`);
    fraction(route.quality, `Model route ${route.id} quality`);
    nonNegativeFinite(route.inputCostPerMillion, `Model route ${route.id} input cost`);
    nonNegativeFinite(route.outputCostPerMillion, `Model route ${route.id} output cost`);
    if (route.unmetered === true
      && (route.inputCostPerMillion > 0 || route.outputCostPerMillion > 0)) {
      throw new Error(`Model route ${route.id} cannot be unmetered with non-zero prices`);
    }
    if (!route.local && route.inputCostPerMillion === 0 && route.outputCostPerMillion === 0
      && route.unmetered !== true) {
      throw new Error(`External model route ${route.id} requires reviewed prices or unmetered: true`);
    }
    if (route.enabled && !route.local && externalInference !== 'allow') {
      throw new Error(`External model route ${route.id} requires externalInference: allow`);
    }
    if (route.enabled && !route.local && route.provider !== 'mock' && !route.generation) {
      throw new Error(`External model route ${route.id} requires an immutable generation identifier`);
    }
    if (!Number.isSafeInteger(route.contextWindow) || route.contextWindow <= 0) {
      throw new Error(`Model route ${route.id} contextWindow must be a positive integer`);
    }
    return { ...route, tasks: [...route.tasks] };
  });
}

function averageLatency(stats: ModelRouteStats | undefined): number {
  return stats && stats.attempts > 0 ? Math.max(0, stats.latencyMs / stats.attempts) : 0;
}

function elapsedMilliseconds(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

function boundedRandom(random: () => number): number {
  const value = random();
  return Number.isFinite(value) ? clamp(value, 0, 1 - Number.EPSILON) : 0;
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function routeWireProfile(provider: string): string {
  if (provider === 'mlx-lm') return 'mlx-lm-strict-v1';
  if (provider === 'llama.cpp') return 'llama-cpp-strict-v1';
  if (provider === 'freetoken') return 'freetoken-strict-v1';
  if (provider === 'mock') return 'mock-v1';
  return 'openai-compatible-strict-v1';
}

function fraction(value: number, name: string): number {
  const finite = nonNegativeFinite(value, name);
  if (finite > 1) throw new Error(`${name} must be between 0 and 1`);
  return finite;
}

function nonNegativeFinite(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a finite non-negative number`);
  return value;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function isEnvironmentName(value: string): boolean {
  return /^[A-Z_][A-Z0-9_]*$/u.test(value);
}

function isRetryableModelFailure(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && 'retryable' in error && error.retryable === true;
}

function formatCost(value: number): string {
  return value.toFixed(value >= 1 ? 2 : 6);
}

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error('Operation aborted');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}
