import { createHash } from 'node:crypto';

import type { FeedbackRecord, RunRecord } from '../core/types.js';
import { SqliteStorage } from '../storage/sqlite.js';
import { redactObviousSecrets } from './memory-engine.js';

export type LearningDatasetKind = 'rewards' | 'sft' | 'preferences';

export interface LearningExportOptions {
  kinds?: LearningDatasetKind[];
  generatedAt?: string;
  includeComments?: boolean;
}

export interface LearningDatasetArtifact {
  kind: LearningDatasetKind;
  fileName: string;
  rowCount: number;
  sha256: string;
  jsonl: string;
}

export interface LearningDatasetManifestEntry {
  kind: LearningDatasetKind;
  fileName: string;
  rowCount: number;
  sha256: string;
}

export interface LearningExportManifest {
  schemaVersion: 'openprojects.learning-export.v1';
  generatedAt: string;
  redactionVersion: 'obvious-secrets-v1';
  sourceFeedbackCount: number;
  exportedRowCount: number;
  redactionCount: number;
  skipped: {
    rewardMissingResponse: number;
    sftMissingCorrection: number;
    preferenceInsufficient: number;
    duplicateRows: number;
  };
  datasets: LearningDatasetManifestEntry[];
  sha256: string;
}

export interface LearningDatasetExport {
  manifest: LearningExportManifest;
  datasets: LearningDatasetArtifact[];
}

export interface RewardDatasetRow {
  schema: 'openprojects.reward.v1';
  id: string;
  prompt: string;
  response: string;
  reward: number;
  dimensions: Record<string, number>;
  reaction?: string;
  comment?: string;
  correction?: string;
  run: {
    id: string;
    agentId: string;
    agentVersion: string;
  };
  feedbackId: string;
  createdAt: string;
}

export interface SftDatasetRow {
  schema: 'openprojects.sft.v1';
  id: string;
  prompt: string;
  response: string;
  source: {
    feedbackId: string;
    runId: string;
    agentId: string;
    agentVersion: string;
  };
  createdAt: string;
}

export interface PreferenceDatasetRow {
  schema: 'openprojects.preference.v1';
  id: string;
  prompt: string;
  chosen: string;
  rejected: string;
  source: {
    feedbackId: string;
    runId: string;
    agentId: string;
    agentVersion: string;
  };
  createdAt: string;
}

interface MutableExportStats {
  redactionCount: number;
  rewardMissingResponse: number;
  sftMissingCorrection: number;
  preferenceInsufficient: number;
  duplicateRows: number;
}

interface RedactedValue {
  value: string;
  count: number;
}

const DATASET_ORDER: LearningDatasetKind[] = ['rewards', 'sft', 'preferences'];
const MAX_DIMENSION_KEY_CHARACTERS = 64;
const RESERVED_DIMENSION_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Produces deterministic, reviewable artifacts. It intentionally performs no
 * training and makes no claim that scalar feedback is automatically a valid
 * preference pair.
 */
export function exportLearningDatasets(
  storage: SqliteStorage,
  options: LearningExportOptions = {},
): LearningDatasetExport {
  const selectedKinds = selectedDatasetKinds(options.kinds);
  const feedback = storage.listFeedback().sort(compareFeedback);
  const generatedAt = normalizedGeneratedAt(
    options.generatedAt ?? feedback.at(-1)?.createdAt ?? '1970-01-01T00:00:00.000Z',
  );
  const stats: MutableExportStats = {
    redactionCount: 0,
    rewardMissingResponse: 0,
    sftMissingCorrection: 0,
    preferenceInsufficient: 0,
    duplicateRows: 0,
  };

  const rewardRows: RewardDatasetRow[] = [];
  const sftRows: SftDatasetRow[] = [];
  const preferenceRows: PreferenceDatasetRow[] = [];
  const seenRewards = new Set<string>();
  const seenSft = new Set<string>();
  const seenPreferences = new Set<string>();

  for (const item of feedback) {
    const run = storage.getRun(item.runId);
    const prompt = redact(run.input, stats);
    const response = redact(run.output ?? '', stats);
    const correction = redact(item.correction ?? '', stats);

    if (response.value) {
      const rewardRow = rewardDatasetRow(run, item, prompt.value, response.value, correction.value, options, stats);
      const key = stableHash({
        prompt: rewardRow.prompt,
        response: rewardRow.response,
        feedbackId: rewardRow.feedbackId,
      });
      if (seenRewards.has(key)) {
        stats.duplicateRows += 1;
      } else {
        seenRewards.add(key);
        rewardRows.push(rewardRow);
      }
    } else {
      stats.rewardMissingResponse += 1;
    }

    if (correction.value) {
      const key = stableHash({ prompt: prompt.value, response: correction.value });
      if (seenSft.has(key)) {
        stats.duplicateRows += 1;
      } else {
        seenSft.add(key);
        sftRows.push({
          schema: 'openprojects.sft.v1',
          id: `sft-${key.slice(0, 24)}`,
          prompt: prompt.value,
          response: correction.value,
          source: sourceRecord(run, item),
          createdAt: item.createdAt,
        });
      }
    } else {
      stats.sftMissingCorrection += 1;
    }

    const preferenceIsSufficient =
      Boolean(response.value) &&
      Boolean(correction.value) &&
      normalizedForComparison(response.value) !== normalizedForComparison(correction.value) &&
      item.score < 0;
    if (preferenceIsSufficient) {
      const key = stableHash({
        prompt: prompt.value,
        chosen: correction.value,
        rejected: response.value,
      });
      if (seenPreferences.has(key)) {
        stats.duplicateRows += 1;
      } else {
        seenPreferences.add(key);
        preferenceRows.push({
          schema: 'openprojects.preference.v1',
          id: `preference-${key.slice(0, 24)}`,
          prompt: prompt.value,
          chosen: correction.value,
          rejected: response.value,
          source: sourceRecord(run, item),
          createdAt: item.createdAt,
        });
      }
    } else {
      stats.preferenceInsufficient += 1;
    }
  }

  rewardRows.sort(compareDatasetRows);
  sftRows.sort(compareDatasetRows);
  preferenceRows.sort(compareDatasetRows);
  const artifacts: LearningDatasetArtifact[] = [];
  for (const kind of selectedKinds) {
    if (kind === 'rewards') artifacts.push(createArtifact(kind, rewardRows));
    else if (kind === 'sft') artifacts.push(createArtifact(kind, sftRows));
    else artifacts.push(createArtifact(kind, preferenceRows));
  }

  const entries: LearningDatasetManifestEntry[] = artifacts.map(({ jsonl: _jsonl, ...entry }) => entry);
  const manifestCore = {
    schemaVersion: 'openprojects.learning-export.v1' as const,
    generatedAt,
    redactionVersion: 'obvious-secrets-v1' as const,
    sourceFeedbackCount: feedback.length,
    exportedRowCount: entries.reduce((total, entry) => total + entry.rowCount, 0),
    redactionCount: stats.redactionCount,
    skipped: {
      rewardMissingResponse: stats.rewardMissingResponse,
      sftMissingCorrection: stats.sftMissingCorrection,
      preferenceInsufficient: stats.preferenceInsufficient,
      duplicateRows: stats.duplicateRows,
    },
    datasets: entries,
  };
  const manifest: LearningExportManifest = {
    ...manifestCore,
    sha256: sha256(stableStringify(manifestCore)),
  };
  return { manifest, datasets: artifacts };
}

function rewardDatasetRow(
  run: RunRecord,
  feedback: FeedbackRecord,
  prompt: string,
  response: string,
  correction: string,
  options: LearningExportOptions,
  stats: MutableExportStats,
): RewardDatasetRow {
  const reaction = redactOptional(feedback.reaction, stats);
  const comment = options.includeComments === false ? undefined : redactOptional(feedback.comment, stats);
  return {
    schema: 'openprojects.reward.v1',
    id: `reward-${feedback.id}`,
    prompt,
    response,
    reward: clamp(feedback.score, -1, 1),
    dimensions: sortedFiniteDimensions(feedback.dimensions, stats),
    ...(reaction ? { reaction } : {}),
    ...(comment ? { comment } : {}),
    ...(correction ? { correction } : {}),
    run: {
      id: run.id,
      agentId: run.agentId,
      agentVersion: run.agentVersion,
    },
    feedbackId: feedback.id,
    createdAt: feedback.createdAt,
  };
}

function sourceRecord(run: RunRecord, feedback: FeedbackRecord): SftDatasetRow['source'] {
  return {
    feedbackId: feedback.id,
    runId: run.id,
    agentId: run.agentId,
    agentVersion: run.agentVersion,
  };
}

function createArtifact(
  kind: LearningDatasetKind,
  rows: Array<RewardDatasetRow | SftDatasetRow | PreferenceDatasetRow>,
): LearningDatasetArtifact {
  const jsonl = rows.length ? `${rows.map((row) => stableStringify(row)).join('\n')}\n` : '';
  return {
    kind,
    fileName: `${kind}.jsonl`,
    rowCount: rows.length,
    sha256: sha256(jsonl),
    jsonl,
  };
}

function selectedDatasetKinds(input?: LearningDatasetKind[]): LearningDatasetKind[] {
  if (!input) return [...DATASET_ORDER];
  const requested = new Set(input);
  for (const kind of requested) {
    if (!DATASET_ORDER.includes(kind)) throw new Error(`Unknown learning dataset kind: ${kind}`);
  }
  return DATASET_ORDER.filter((kind) => requested.has(kind));
}

function redact(value: string, stats: MutableExportStats): RedactedValue {
  const redacted = redactObviousSecrets(value);
  stats.redactionCount += redacted.redactions;
  return { value: redacted.text, count: redacted.redactions };
}

function redactOptional(value: string | undefined, stats: MutableExportStats): string | undefined {
  if (!value) return undefined;
  const redacted = redact(value, stats).value.trim();
  return redacted || undefined;
}

function sortedFiniteDimensions(
  dimensions: Record<string, number>,
  stats: MutableExportStats,
): Record<string, number> {
  const used = new Set<string>();
  const entries: Array<[string, number]> = [];
  const sourceEntries = Object.entries(dimensions)
    .filter((entry): entry is [string, number] => Number.isFinite(entry[1]))
    .sort(([left], [right]) => left.localeCompare(right));
  for (const [sourceKey, value] of sourceEntries) {
    const redacted = redact(sourceKey, stats).value.normalize('NFKC').trim();
    let key = redacted
      .replace(/[^A-Za-z0-9_.:-]+/gu, '_')
      .replace(/^_+|_+$/gu, '');
    if (!key || RESERVED_DIMENSION_KEYS.has(key)) {
      key = `dimension.${sha256(sourceKey).slice(0, 12)}`;
    }
    key = boundedDimensionKey(key);
    if (used.has(key)) {
      const suffix = `.${sha256(sourceKey).slice(0, 12)}`;
      key = `${key.slice(0, MAX_DIMENSION_KEY_CHARACTERS - suffix.length)}${suffix}`;
    }
    used.add(key);
    entries.push([key, value]);
  }
  entries.sort(([left], [right]) => left.localeCompare(right));
  return Object.fromEntries(entries);
}

function boundedDimensionKey(value: string): string {
  if (value.length <= MAX_DIMENSION_KEY_CHARACTERS) return value;
  const suffix = `.${sha256(value).slice(0, 12)}`;
  return `${value.slice(0, MAX_DIMENSION_KEY_CHARACTERS - suffix.length)}${suffix}`;
}

function compareFeedback(left: FeedbackRecord, right: FeedbackRecord): number {
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

function compareDatasetRows(
  left: RewardDatasetRow | SftDatasetRow | PreferenceDatasetRow,
  right: RewardDatasetRow | SftDatasetRow | PreferenceDatasetRow,
): number {
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

function normalizedForComparison(value: string): string {
  return value.replace(/\s+/gu, ' ').trim().toLocaleLowerCase('en-US');
}

function normalizedGeneratedAt(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error('generatedAt must be an ISO timestamp');
  return new Date(parsed).toISOString();
}

function stableHash(value: unknown): string {
  return sha256(stableStringify(value));
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entryValue]) => [key, sortJson(entryValue)]),
  );
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(minimum, Math.min(maximum, value));
}
