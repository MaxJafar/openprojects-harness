import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { createApp } from '../app.js';
import { loadConfig } from '../config.js';
import type { AppConfig, HarnessEvent, RunStatus } from '../core/types.js';

interface EvalSuite {
  id: string;
  version: string;
  description: string;
  gates: {
    minimumPassRate: number;
    maximumAverageToolCalls: number;
  };
  cases: EvalCase[];
}

interface EvalCase {
  id: string;
  prompt: string;
  projectId?: string;
  approve?: boolean;
  expect: {
    initialStatus: RunStatus;
    finalStatus: RunStatus;
    toolCalled?: string;
    approvalTool?: string;
    outputContains?: string[];
    outboxCount?: number;
  };
}

export interface EvalCaseResult {
  id: string;
  passed: boolean;
  assertions: Array<{ name: string; passed: boolean; expected: unknown; actual: unknown }>;
  durationMs: number;
  toolCalls: number;
  finalStatus: RunStatus;
  error?: string;
}

export interface EvalSuiteResult {
  suiteId: string;
  suiteVersion: string;
  passed: boolean;
  passRate: number;
  averageToolCalls: number;
  durationMs: number;
  cases: EvalCaseResult[];
  gates: EvalSuite['gates'];
}

export async function runEvalSuite(
  configPath = 'openprojects.config.yaml',
  suitePath = 'evals/project-ops.json',
): Promise<EvalSuiteResult> {
  const suite = JSON.parse(readFileSync(resolve(suitePath), 'utf8')) as EvalSuite;
  validateSuite(suite);
  const config = deterministicEvalConfig(loadConfig(configPath));
  const started = performance.now();
  const cases: EvalCaseResult[] = [];
  for (const evalCase of suite.cases) {
    const app = await createApp({
      config,
      databasePath: ':memory:',
      seedDemo: true,
      integrationMode: 'offline',
    });
    const caseStarted = performance.now();
    try {
      let outcome = await app.runtime.start({
        message: evalCase.prompt,
        workspaceId: 'local',
        actorId: 'eval-user',
        ...(evalCase.projectId ? { projectId: evalCase.projectId } : {}),
        channel: 'eval',
      });
      const initialStatus = outcome.run.status;
      const initialApprovals = outcome.approvals;
      if (typeof evalCase.approve === 'boolean') {
        for (const approval of initialApprovals.filter((item) => item.status === 'pending')) {
          outcome = await app.runtime.resolveApproval(
            approval.id,
            evalCase.approve ? 'approve' : 'reject',
            'eval-user',
            'eval fixture decision',
          );
        }
      }
      const assertions = [
        assertion('initial status', evalCase.expect.initialStatus, initialStatus),
        assertion('final status', evalCase.expect.finalStatus, outcome.run.status),
      ];
      if (evalCase.expect.toolCalled) {
        assertions.push(
          assertion(
            'tool called',
            evalCase.expect.toolCalled,
            calledTools(outcome.events).includes(evalCase.expect.toolCalled) ? evalCase.expect.toolCalled : calledTools(outcome.events),
          ),
        );
      }
      if (evalCase.expect.approvalTool) {
        assertions.push(
          assertion(
            'approval boundary',
            evalCase.expect.approvalTool,
            initialApprovals.find((item) => item.toolName === evalCase.expect.approvalTool)?.toolName,
          ),
        );
      }
      for (const text of evalCase.expect.outputContains ?? []) {
        assertions.push(
          assertion(
            `output contains ${text}`,
            true,
            outcome.run.output?.includes(text) ?? false,
          ),
        );
      }
      if (typeof evalCase.expect.outboxCount === 'number') {
        assertions.push(assertion('outbox count', evalCase.expect.outboxCount, app.storage.outboxCount()));
      }
      cases.push({
        id: evalCase.id,
        passed: assertions.every((item) => item.passed),
        assertions,
        durationMs: Math.round(performance.now() - caseStarted),
        toolCalls: outcome.run.toolCalls,
        finalStatus: outcome.run.status,
      });
    } catch (error) {
      cases.push({
        id: evalCase.id,
        passed: false,
        assertions: [],
        durationMs: Math.round(performance.now() - caseStarted),
        toolCalls: 0,
        finalStatus: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      await app.close();
    }
  }
  const passRate = cases.filter((item) => item.passed).length / Math.max(1, cases.length);
  const averageToolCalls = cases.reduce((sum, item) => sum + item.toolCalls, 0) / Math.max(1, cases.length);
  return {
    suiteId: suite.id,
    suiteVersion: suite.version,
    passed:
      passRate >= suite.gates.minimumPassRate &&
      averageToolCalls <= suite.gates.maximumAverageToolCalls,
    passRate,
    averageToolCalls,
    durationMs: Math.round(performance.now() - started),
    cases,
    gates: suite.gates,
  };
}

/**
 * Produces a hermetic configuration for deterministic evaluation. This is a
 * capability reduction, not a candidate configuration: every model route,
 * remote embedding provider, transcription process, Telegram integration, and
 * notification loop is removed before createApp sees the configuration.
 */
export function deterministicEvalConfig(config: AppConfig): AppConfig {
  const { routing: _routing, ...withoutRouting } = config;
  return {
    ...withoutRouting,
    agent: { ...config.agent, skills: [] },
    model: { provider: 'mock', model: 'project-ops-v1' },
    storage: { database: ':memory:' },
    privacy: { localOnly: true, allowedOrigins: [] },
    telegram: { enabled: false, apiBaseUrl: 'https://api.telegram.invalid' },
    embeddings: {
      provider: 'builtin',
      model: 'builtin-hash-v1',
      dimensions: 256,
      timeoutMs: 3_000,
    },
    transcription: {
      provider: 'disabled',
      command: 'whisper-cli',
      ffmpegCommand: 'ffmpeg',
      timeoutMs: 180_000,
      maxBytes: 25_000_000,
      maxDurationSeconds: 1_200,
    },
    notifications: {
      enabled: false,
      intervalMs: config.notifications?.intervalMs ?? 60_000,
      lookaheadHours: config.notifications?.lookaheadHours ?? 48,
    },
  };
}

function calledTools(events: HarnessEvent[]): string[] {
  return events
    .filter((event) => event.type === 'tool.call')
    .map((event) =>
      typeof event.data === 'object' && event.data !== null && !Array.isArray(event.data) && typeof event.data.name === 'string'
        ? event.data.name
        : '',
    )
    .filter(Boolean);
}

function assertion(name: string, expected: unknown, actual: unknown) {
  return { name, passed: JSON.stringify(expected) === JSON.stringify(actual), expected, actual };
}

function validateSuite(suite: EvalSuite): void {
  if (!suite.id || !suite.version || !Array.isArray(suite.cases) || suite.cases.length === 0) {
    throw new Error('Invalid eval suite');
  }
  if (suite.gates.minimumPassRate < 0 || suite.gates.minimumPassRate > 1) {
    throw new Error('minimumPassRate must be between 0 and 1');
  }
}
