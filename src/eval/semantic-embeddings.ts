import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { createEmbeddingAdapter, formatEmbeddingQuery } from '../adapters/embeddings.js';
import { loadConfig } from '../config.js';
import type { AppConfig } from '../core/types.js';
import { createNetworkPolicy } from '../privacy/network-policy.js';
import {
  loadQualificationManifest,
  runApplianceQualification,
  type ApplianceQualificationManifest,
  type QualificationTargetReport,
} from '../qualification/index.js';

const DEFAULT_BATCHES = 3;
const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_TIMEOUT_MS = 600_000;

export const SEMANTIC_EMBEDDING_CORPUS_VERSION = 'project-retrieval-en-ru-az.v1' as const;
export const SEMANTIC_EMBEDDING_THRESHOLDS = Object.freeze({
  recallAt1: 0.8,
  recallAt3: 1,
  meanReciprocalRank: 0.9,
  repeatedInputCosine: 0.999,
  driftCosine: 0.999,
});

export interface SemanticEmbeddingDocument {
  id: string;
  text: string;
}

export interface SemanticEmbeddingQuery {
  id: string;
  language: 'en' | 'ru' | 'az';
  text: string;
  expectedDocumentId: string;
}

/** Fixed, versioned project-domain retrieval set. Related documents are deliberate lexical hard negatives. */
export const SEMANTIC_EMBEDDING_CORPUS: Readonly<{
  documents: readonly SemanticEmbeddingDocument[];
  queries: readonly SemanticEmbeddingQuery[];
}> = Object.freeze({
  documents: Object.freeze([
    {
      id: 'atlas-production-credentials',
      text: 'Atlas production release is blocked because security approval for the live API credentials is still pending. Nigar owns the approval follow-up.',
    },
    {
      id: 'atlas-customer-demo',
      text: 'The Atlas customer demo remains scheduled for Friday. Its sandbox credential is valid, and the demo has no reported blocker.',
    },
    {
      id: 'mercury-checkout-crash',
      text: 'Mercury Android cannot ship until the checkout crash regression passes quality assurance. Pavel owns the crash fix.',
    },
    {
      id: 'mercury-test-device-budget',
      text: 'The Mercury budget review approved more Android test devices. Finance will review the device invoice next week.',
    },
    {
      id: 'orion-accessibility-signoff',
      text: 'The Orion website redesign is waiting for final accessibility sign-off from legal before release.',
    },
    {
      id: 'orion-marketing-assets',
      text: 'The Orion marketing campaign received its final design assets and is not waiting for legal review.',
    },
    {
      id: 'payments-migration-owner',
      text: 'Leyla owns the payment database migration. The cutover is due on 2 September after the backup verification.',
    },
    {
      id: 'payments-support-training',
      text: 'Leyla will lead payment support training after the database migration; the training session has no cutover responsibility.',
    },
    {
      id: 'search-v1-decision',
      text: 'The team decided to keep PostgreSQL full-text search for version one and postpone vector search until after launch.',
    },
    {
      id: 'search-vector-benchmark',
      text: 'The vector search experiment has a benchmark review next Tuesday, but it is not part of the version-one launch decision.',
    },
  ] satisfies SemanticEmbeddingDocument[]),
  queries: Object.freeze([
    {
      id: 'en-atlas-blocker',
      language: 'en',
      text: 'What is blocking the Atlas production API credentials?',
      expectedDocumentId: 'atlas-production-credentials',
    },
    {
      id: 'en-mercury-release',
      language: 'en',
      text: 'Which defect prevents the Mercury Android release from shipping?',
      expectedDocumentId: 'mercury-checkout-crash',
    },
    {
      id: 'en-payments-owner',
      language: 'en',
      text: 'Who owns the payment database migration and its cutover?',
      expectedDocumentId: 'payments-migration-owner',
    },
    {
      id: 'en-search-decision',
      language: 'en',
      text: 'What search technology did the team choose for version one?',
      expectedDocumentId: 'search-v1-decision',
    },
    {
      id: 'ru-atlas-blocker',
      language: 'ru',
      text: 'Что задерживает выдачу боевых API-ключей для проекта Atlas?',
      expectedDocumentId: 'atlas-production-credentials',
    },
    {
      id: 'ru-mercury-release',
      language: 'ru',
      text: 'Какой дефект мешает выпуску Android-приложения Mercury?',
      expectedDocumentId: 'mercury-checkout-crash',
    },
    {
      id: 'ru-payments-owner',
      language: 'ru',
      text: 'Кто отвечает за миграцию платежной базы данных и переключение?',
      expectedDocumentId: 'payments-migration-owner',
    },
    {
      id: 'ru-search-decision',
      language: 'ru',
      text: 'Какое решение по поиску команда приняла для первой версии?',
      expectedDocumentId: 'search-v1-decision',
    },
    {
      id: 'az-atlas-blocker',
      language: 'az',
      text: 'Atlas üçün istehsal API etimadnamələrinin verilməsini nə saxlayır?',
      expectedDocumentId: 'atlas-production-credentials',
    },
    {
      id: 'az-mercury-release',
      language: 'az',
      text: 'Mercury Android buraxılışına hansı problem mane olur?',
      expectedDocumentId: 'mercury-checkout-crash',
    },
    {
      id: 'az-payments-owner',
      language: 'az',
      text: 'Ödəniş verilənlər bazasının miqrasiyasına və keçidinə kim cavabdehdir?',
      expectedDocumentId: 'payments-migration-owner',
    },
    {
      id: 'az-search-decision',
      language: 'az',
      text: 'Axtarışın ilk versiyası üçün komanda hansı texnologiyanı seçdi?',
      expectedDocumentId: 'search-v1-decision',
    },
  ] satisfies SemanticEmbeddingQuery[]),
});

export interface SemanticEmbeddingEvalOptions {
  configPath: string;
  manifestPath: string;
  batches?: number;
  /** Total preflight plus live-evaluation deadline. */
  timeoutMs?: number;
  now?: () => Date;
}

export interface SemanticEmbeddingQueryRank {
  id: string;
  language: SemanticEmbeddingQuery['language'];
  expectedDocumentId: string;
  rank: number;
  topDocumentIds: string[];
}

export interface SemanticEmbeddingBatchReport {
  index: number;
  passed: boolean;
  durationMs: number;
  observedDimensions?: number;
  repeatedInputCosine?: number;
  driftMinimumCosine?: number;
  metrics?: SemanticEmbeddingMetrics;
  queries: SemanticEmbeddingQueryRank[];
  error?: string;
}

export interface SemanticEmbeddingMetrics {
  recallAt1: number;
  recallAt3: number;
  meanReciprocalRank: number;
}

export interface SemanticEmbeddingAggregateQuery {
  id: string;
  language: SemanticEmbeddingQuery['language'];
  expectedDocumentId: string;
  ranks: Array<number | null>;
  worstRank: number | null;
}

export interface SemanticEmbeddingEvalReport {
  schema: 'openprojects.semantic-embedding-eval-report.v1';
  generatedAt: string;
  corpus: {
    version: typeof SEMANTIC_EMBEDDING_CORPUS_VERSION;
    documents: number;
    queries: number;
    languages: ['en', 'ru', 'az'];
  };
  candidate: {
    provider: 'ollama';
    model: string;
    adapterId: string;
    configuredDimensions: number;
    configuredServiceDigest: string;
  };
  identity: {
    observedModel?: string;
    observedServiceDigest?: string;
    exactModel: boolean;
    exactServiceDigest: boolean;
    exactDimensions: boolean;
  };
  bindings: {
    configSha256: string;
    manifestSha256: string;
    pinDeclared: boolean;
    sourceConfigUnmodified: boolean;
    sourceManifestUnmodified: boolean;
  };
  preflight: {
    qualified: boolean;
    overall: 'qualified' | 'partial' | 'not_qualified';
    detail: string;
  };
  thresholds: typeof SEMANTIC_EMBEDDING_THRESHOLDS;
  requestedBatches: number;
  successfulBatches: number;
  errorCount: number;
  latencyMs: { p50: number | null; p95: number | null };
  minimumRepeatedInputCosine: number | null;
  minimumDriftCosine: number | null;
  metrics: SemanticEmbeddingMetrics;
  queries: SemanticEmbeddingAggregateQuery[];
  batches: SemanticEmbeddingBatchReport[];
  passed: boolean;
  statuses: {
    semanticEmbeddings: 'passed' | 'failed';
    projectAnalysis: 'not_evaluated';
    supervisor: 'not_evaluated';
    vision: 'not_evaluated';
  };
  posture: {
    nonMutatingIntent: true;
    persistentHarnessStateWritesAttempted: false;
    downloadsAttempted: false;
    promotionsAttempted: false;
    modelRoutesMutated: false;
    textModelRequestsAttempted: false;
  };
}

export async function runSemanticEmbeddingEval(
  options: SemanticEmbeddingEvalOptions,
): Promise<SemanticEmbeddingEvalReport> {
  const requestedBatches = boundedBatches(options.batches ?? DEFAULT_BATCHES);
  const timeoutMs = boundedTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const deadlineAt = performance.now() + timeoutMs;
  const [configSource, manifestSource] = await Promise.all([
    readFile(options.configPath),
    readFile(options.manifestPath),
  ]);
  const configSha256 = sha256(configSource);
  const manifestSha256 = sha256(manifestSource);
  const config = loadConfig(options.configPath);
  const manifest = await loadQualificationManifest(options.manifestPath);
  const embedding = requireCandidate(config, manifest);
  const adapter = createEmbeddingAdapter(embedding, createNetworkPolicy(config.privacy));
  const reportBase = {
    schema: 'openprojects.semantic-embedding-eval-report.v1' as const,
    generatedAt: (options.now?.() ?? new Date()).toISOString(),
    corpus: {
      version: SEMANTIC_EMBEDDING_CORPUS_VERSION,
      documents: SEMANTIC_EMBEDDING_CORPUS.documents.length,
      queries: SEMANTIC_EMBEDDING_CORPUS.queries.length,
      languages: ['en', 'ru', 'az'] as ['en', 'ru', 'az'],
    },
    candidate: {
      provider: 'ollama' as const,
      model: embedding.model,
      adapterId: adapter.id,
      configuredDimensions: embedding.dimensions,
      configuredServiceDigest: embedding.serviceDigest,
    },
    thresholds: SEMANTIC_EMBEDDING_THRESHOLDS,
    requestedBatches,
    posture: posture(),
  };

  const qualification = await runApplianceQualification(config, {
    manifest,
    requiredCapabilities: ['embeddings'],
    timeoutMs: remainingTimeout(deadlineAt),
  });
  const target = qualification.targets.find((item) => item.id === 'embeddings');
  const exactModel = target?.identity.observedModel === embedding.model;
  const exactServiceDigest = target?.identity.serviceDigest === embedding.serviceDigest;
  const preflightQualified = qualification.overall === 'qualified'
    && target?.qualified === true
    && exactModel
    && exactServiceDigest;

  if (!preflightQualified) {
    return finishReport({
      ...reportBase,
      configPath: options.configPath,
      manifestPath: options.manifestPath,
      configSha256,
      manifestSha256,
      target,
      qualificationOverall: qualification.overall,
      preflightQualified: false,
      exactModel,
      exactServiceDigest,
      exactDimensions: false,
      batches: [],
    });
  }

  const documents = SEMANTIC_EMBEDDING_CORPUS.documents;
  const queries = SEMANTIC_EMBEDDING_CORPUS.queries;
  const formattedQueries = queries.map((query) => formatEmbeddingQuery(embedding.model, query.text));
  const repeated = formattedQueries[0]!;
  const inputs = [
    ...documents.map((document) => document.text),
    ...formattedQueries,
    repeated,
    repeated,
  ];
  const batchReports: SemanticEmbeddingBatchReport[] = [];
  let baseline: number[][] | undefined;
  for (let index = 0; index < requestedBatches; index += 1) {
    const startedAt = performance.now();
    try {
      const vectors = await adapter.embed(inputs, AbortSignal.timeout(remainingTimeout(deadlineAt)));
      assertVectorBatch(vectors, inputs.length, embedding.dimensions);
      const documentVectors = vectors.slice(0, documents.length);
      const queryVectors = vectors.slice(documents.length, documents.length + queries.length);
      const repeatedInputCosine = cosine(vectors.at(-2)!, vectors.at(-1)!);
      const driftMinimumCosine = baseline ? minimumPairwiseCosine(baseline, vectors) : 1;
      const queryRanks = rankQueries(documentVectors, queryVectors);
      const metrics = metricsForRanks(queryRanks.map((item) => item.rank));
      const passed = metricsMeetThresholds(metrics)
        && repeatedInputCosine >= SEMANTIC_EMBEDDING_THRESHOLDS.repeatedInputCosine
        && driftMinimumCosine >= SEMANTIC_EMBEDDING_THRESHOLDS.driftCosine;
      batchReports.push({
        index: index + 1,
        passed,
        durationMs: Math.round(performance.now() - startedAt),
        observedDimensions: vectors[0]!.length,
        repeatedInputCosine,
        driftMinimumCosine,
        metrics,
        queries: queryRanks,
      });
      baseline ??= vectors.map((vector) => [...vector]);
    } catch (error) {
      batchReports.push({
        index: index + 1,
        passed: false,
        durationMs: Math.round(performance.now() - startedAt),
        queries: [],
        error: errorMessage(error),
      });
    }
  }

  const successful = batchReports.filter((batch) => batch.error === undefined);
  const exactDimensions = successful.length === requestedBatches
    && successful.every((batch) => batch.observedDimensions === embedding.dimensions);
  return finishReport({
    ...reportBase,
    configPath: options.configPath,
    manifestPath: options.manifestPath,
    configSha256,
    manifestSha256,
    target,
    qualificationOverall: qualification.overall,
    preflightQualified: true,
    exactModel,
    exactServiceDigest,
    exactDimensions,
    batches: batchReports,
  });
}

interface FinishInput {
  schema: SemanticEmbeddingEvalReport['schema'];
  generatedAt: string;
  corpus: SemanticEmbeddingEvalReport['corpus'];
  candidate: SemanticEmbeddingEvalReport['candidate'];
  thresholds: typeof SEMANTIC_EMBEDDING_THRESHOLDS;
  requestedBatches: number;
  posture: SemanticEmbeddingEvalReport['posture'];
  configPath: string;
  manifestPath: string;
  configSha256: string;
  manifestSha256: string;
  target: QualificationTargetReport | undefined;
  qualificationOverall: SemanticEmbeddingEvalReport['preflight']['overall'];
  preflightQualified: boolean;
  exactModel: boolean;
  exactServiceDigest: boolean;
  exactDimensions: boolean;
  batches: SemanticEmbeddingBatchReport[];
}

async function finishReport(input: FinishInput): Promise<SemanticEmbeddingEvalReport> {
  const [configAfter, manifestAfter] = await Promise.all([
    readFile(input.configPath),
    readFile(input.manifestPath),
  ]);
  const sourceConfigUnmodified = sha256(configAfter) === input.configSha256;
  const sourceManifestUnmodified = sha256(manifestAfter) === input.manifestSha256;
  const successful = input.batches.filter((batch) => batch.error === undefined);
  const errorCount = input.batches.length - successful.length;
  const completeRanks = input.batches.length === input.requestedBatches
    ? aggregateQueries(input.batches)
    : emptyAggregateQueries(input.requestedBatches);
  const allRanksPresent = completeRanks.every((query) => query.worstRank !== null);
  const metrics = allRanksPresent
    ? metricsForRanks(completeRanks.map((query) => query.worstRank!))
    : zeroMetrics();
  const repeatedCosines = successful.flatMap((batch) => batch.repeatedInputCosine === undefined ? [] : [batch.repeatedInputCosine]);
  const driftCosines = successful.flatMap((batch) => batch.driftMinimumCosine === undefined ? [] : [batch.driftMinimumCosine]);
  const durations = successful.map((batch) => batch.durationMs);
  const minimumRepeatedInputCosine = repeatedCosines.length ? Math.min(...repeatedCosines) : null;
  const minimumDriftCosine = driftCosines.length ? Math.min(...driftCosines) : null;
  const passed = input.preflightQualified
    && input.exactModel
    && input.exactServiceDigest
    && input.exactDimensions
    && sourceConfigUnmodified
    && sourceManifestUnmodified
    && errorCount === 0
    && input.batches.length === input.requestedBatches
    && input.batches.every((batch) => batch.passed)
    && metricsMeetThresholds(metrics)
    && minimumRepeatedInputCosine !== null
    && minimumRepeatedInputCosine >= SEMANTIC_EMBEDDING_THRESHOLDS.repeatedInputCosine
    && minimumDriftCosine !== null
    && minimumDriftCosine >= SEMANTIC_EMBEDDING_THRESHOLDS.driftCosine;
  return {
    schema: input.schema,
    generatedAt: input.generatedAt,
    corpus: input.corpus,
    candidate: input.candidate,
    identity: {
      ...(input.target?.identity.observedModel ? { observedModel: input.target.identity.observedModel } : {}),
      ...(input.target?.identity.serviceDigest ? { observedServiceDigest: input.target.identity.serviceDigest } : {}),
      exactModel: input.exactModel,
      exactServiceDigest: input.exactServiceDigest,
      exactDimensions: input.exactDimensions,
    },
    bindings: {
      configSha256: input.configSha256,
      manifestSha256: input.manifestSha256,
      pinDeclared: input.target?.pin.declared === true,
      sourceConfigUnmodified,
      sourceManifestUnmodified,
    },
    preflight: {
      qualified: input.preflightQualified,
      overall: input.qualificationOverall,
      detail: input.target?.detail ?? 'Embedding target missing from qualification report',
    },
    thresholds: input.thresholds,
    requestedBatches: input.requestedBatches,
    successfulBatches: successful.length,
    errorCount,
    latencyMs: {
      p50: percentile(durations, 0.5),
      p95: percentile(durations, 0.95),
    },
    minimumRepeatedInputCosine,
    minimumDriftCosine,
    metrics,
    queries: completeRanks,
    batches: input.batches,
    passed,
    statuses: {
      semanticEmbeddings: passed ? 'passed' : 'failed',
      projectAnalysis: 'not_evaluated',
      supervisor: 'not_evaluated',
      vision: 'not_evaluated',
    },
    posture: input.posture,
  };
}

function requireCandidate(
  config: AppConfig,
  manifest: ApplianceQualificationManifest,
): Required<Pick<NonNullable<AppConfig['embeddings']>, 'provider' | 'model' | 'serviceDigest' | 'dimensions' | 'timeoutMs'>>
  & Pick<NonNullable<AppConfig['embeddings']>, 'baseUrl'> {
  const embedding = config.embeddings;
  if (!embedding || embedding.provider !== 'ollama') {
    throw new Error('Semantic embedding evaluation requires a configured Ollama semantic model');
  }
  if (!embedding.serviceDigest) {
    throw new Error('Semantic embedding evaluation requires a runtime serviceDigest');
  }
  if (manifest.requirePins !== true) {
    throw new Error('Semantic embedding evaluation requires strong manifest pins');
  }
  const pin = manifest.pins?.embeddings;
  if (!pin) throw new Error('Qualification manifest is missing the embeddings pin');
  if (pin.provider !== embedding.provider
      || pin.model !== embedding.model
      || pin.serviceDigest !== embedding.serviceDigest) {
    throw new Error('Qualification manifest embeddings pin does not exactly match the configured candidate');
  }
  return embedding as ReturnType<typeof requireCandidate>;
}

function rankQueries(documentVectors: number[][], queryVectors: number[][]): SemanticEmbeddingQueryRank[] {
  return SEMANTIC_EMBEDDING_CORPUS.queries.map((query, queryIndex) => {
    const ranked = SEMANTIC_EMBEDDING_CORPUS.documents.map((document, documentIndex) => ({
      id: document.id,
      score: cosine(queryVectors[queryIndex]!, documentVectors[documentIndex]!),
      order: documentIndex,
    })).sort((left, right) => right.score - left.score || left.order - right.order);
    return {
      id: query.id,
      language: query.language,
      expectedDocumentId: query.expectedDocumentId,
      rank: ranked.findIndex((document) => document.id === query.expectedDocumentId) + 1,
      topDocumentIds: ranked.slice(0, 3).map((document) => document.id),
    };
  });
}

function aggregateQueries(batches: SemanticEmbeddingBatchReport[]): SemanticEmbeddingAggregateQuery[] {
  return SEMANTIC_EMBEDDING_CORPUS.queries.map((query) => {
    const ranks = batches.map((batch) => batch.queries.find((item) => item.id === query.id)?.rank ?? null);
    return {
      id: query.id,
      language: query.language,
      expectedDocumentId: query.expectedDocumentId,
      ranks,
      worstRank: ranks.every((rank): rank is number => rank !== null) ? Math.max(...ranks) : null,
    };
  });
}

function emptyAggregateQueries(batches: number): SemanticEmbeddingAggregateQuery[] {
  return SEMANTIC_EMBEDDING_CORPUS.queries.map((query) => ({
    id: query.id,
    language: query.language,
    expectedDocumentId: query.expectedDocumentId,
    ranks: Array.from({ length: batches }, () => null),
    worstRank: null,
  }));
}

function metricsForRanks(ranks: number[]): SemanticEmbeddingMetrics {
  if (ranks.length === 0) return zeroMetrics();
  return {
    recallAt1: ranks.filter((rank) => rank <= 1).length / ranks.length,
    recallAt3: ranks.filter((rank) => rank <= 3).length / ranks.length,
    meanReciprocalRank: ranks.reduce((sum, rank) => sum + 1 / rank, 0) / ranks.length,
  };
}

function zeroMetrics(): SemanticEmbeddingMetrics {
  return { recallAt1: 0, recallAt3: 0, meanReciprocalRank: 0 };
}

function metricsMeetThresholds(metrics: SemanticEmbeddingMetrics): boolean {
  return metrics.recallAt1 >= SEMANTIC_EMBEDDING_THRESHOLDS.recallAt1
    && metrics.recallAt3 >= SEMANTIC_EMBEDDING_THRESHOLDS.recallAt3
    && metrics.meanReciprocalRank >= SEMANTIC_EMBEDDING_THRESHOLDS.meanReciprocalRank;
}

function assertVectorBatch(vectors: number[][], count: number, dimensions: number): void {
  if (vectors.length !== count) throw new Error(`Embedding adapter returned ${vectors.length} vectors; expected ${count}`);
  for (const [index, vector] of vectors.entries()) {
    if (vector.length !== dimensions) {
      throw new Error(`Embedding vector ${index} has ${vector.length} dimensions; expected ${dimensions}`);
    }
    if (vector.some((value) => !Number.isFinite(value))) {
      throw new Error(`Embedding vector ${index} is not finite`);
    }
  }
}

function minimumPairwiseCosine(left: number[][], right: number[][]): number {
  if (left.length !== right.length) throw new Error('Embedding batch size drifted between sequential runs');
  return Math.min(...left.map((vector, index) => cosine(vector, right[index]!)));
}

function cosine(left: number[], right: number[]): number {
  if (left.length !== right.length || left.length === 0) throw new Error('Cannot compare embedding vectors with different dimensions');
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index]! * right[index]!;
    leftNorm += left[index]! * left[index]!;
    rightNorm += right[index]! * right[index]!;
  }
  if (leftNorm === 0 || rightNorm === 0) throw new Error('Cannot compare a zero embedding vector');
  return dot / Math.sqrt(leftNorm * rightNorm);
}

function percentile(values: number[], quantile: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)]!;
}

function boundedBatches(value: number): number {
  if (!Number.isSafeInteger(value) || value < 2 || value > 10) {
    throw new Error('Semantic embedding eval batches must be an integer from 2 to 10');
  }
  return value;
}

function boundedTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 5_000 || value > MAX_TIMEOUT_MS) {
    throw new Error(`Semantic embedding eval timeout must be an integer from 5000 to ${MAX_TIMEOUT_MS}`);
  }
  return value;
}

function remainingTimeout(deadlineAt: number): number {
  return Math.max(1, Math.ceil(deadlineAt - performance.now()));
}

function posture(): SemanticEmbeddingEvalReport['posture'] {
  return {
    nonMutatingIntent: true,
    persistentHarnessStateWritesAttempted: false,
    downloadsAttempted: false,
    promotionsAttempted: false,
    modelRoutesMutated: false,
    textModelRequestsAttempted: false,
  };
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
