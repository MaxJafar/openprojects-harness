import { createHash } from 'node:crypto';

import { createApp } from '../app.js';
import { loadConfig } from '../config.js';
import type { AppConfig, HarnessEvent, ModelRouteConfig } from '../core/types.js';
import {
  loadQualificationManifest,
  parseQualificationManifest,
  runApplianceQualification,
  type ApplianceQualificationManifest,
} from '../qualification/index.js';
import {
  parseProjectAnalystResult,
  PROJECT_ANALYST_CONTRACT,
  PROJECT_ANALYST_TOOL,
} from '../runtime/project-analyst.js';

const DEFAULT_PROMPTS = [
  'Assess the scoped project delivery risk using only the project snapshot.',
  'Identify the critical-path blocker, its impact, and the safest next action.',
  'Explain whether this project may miss its deadline and cite only supplied evidence IDs.',
] as const;

export interface ProjectAnalystEvalOptions {
  configPath: string;
  manifestPath: string;
  /** Already-read immutable source used by composed hash-bound evaluators. */
  configSourceText?: string;
  /** Already-read immutable source used by composed hash-bound evaluators. */
  manifestSourceText?: string;
  /** Optional composed deployment source bound into this report without reopening it. */
  deploymentSourceText?: string;
  routeId: string;
  attempts?: number;
  /** Exact reviewed prompts for a composed eligibility corpus. */
  prompts?: readonly string[];
  timeoutMs?: number;
}

export interface ProjectAnalystEvalAttempt {
  index: number;
  prompt: string;
  passed: boolean;
  runId?: string;
  routeId?: string;
  status: string;
  durationMs: number;
  toolCalls: string[];
  assertions: Array<{ name: string; passed: boolean; detail: string }>;
  error?: string;
}

export interface ProjectAnalystEvalReport {
  schema: 'openprojects.project-analyst-eval-report.v1';
  generatedAt: string;
  laneContract: typeof PROJECT_ANALYST_CONTRACT;
  candidate: {
    routeId: string;
    provider: string;
    model: string;
    tasks: string[];
    local: boolean;
  };
  bindings: {
    configSha256: string;
    manifestSha256: string;
    deploymentSha256?: string;
    pinDeclared: boolean;
  };
  preflightQualified: boolean;
  passed: boolean;
  passRate: number;
  statuses: {
    projectAnalysis: 'passed' | 'failed';
    supervisor: 'not_evaluated';
    semanticEmbeddings: 'not_evaluated';
    vision: 'not_evaluated';
  };
  attempts: ProjectAnalystEvalAttempt[];
}

export async function runProjectAnalystEval(
  options: ProjectAnalystEvalOptions,
): Promise<ProjectAnalystEvalReport> {
  const loaded = options.configSourceText !== undefined
    ? loadConfig(options.configPath, {
        sourceText: options.configSourceText,
        loadEnv: false,
        applyProcessEnvOverrides: false,
      })
    : loadConfig(options.configPath);
  const manifest = options.manifestSourceText !== undefined
    ? parseQualificationManifest(options.manifestSourceText, options.manifestPath)
    : await loadQualificationManifest(options.manifestPath);
  const candidate = selectCandidate(loaded, options.routeId);
  const config = isolatedCandidateConfig(loaded, candidate.id);
  const prompts = boundedPrompts(options.prompts ?? DEFAULT_PROMPTS);
  const attempts = boundedAttempts(options.attempts ?? prompts.length);
  if (options.prompts && attempts !== prompts.length) {
    throw new Error('Project analyst eval attempts must equal the number of explicit prompts');
  }
  const reportBase = {
    schema: 'openprojects.project-analyst-eval-report.v1' as const,
    generatedAt: new Date().toISOString(),
    laneContract: PROJECT_ANALYST_CONTRACT as typeof PROJECT_ANALYST_CONTRACT,
    candidate: {
      routeId: candidate.id,
      provider: candidate.provider,
      model: candidate.model,
      tasks: [...candidate.tasks],
      local: candidate.local,
    },
    bindings: {
      configSha256: options.configSourceText === undefined ? digest(loaded) : digestText(options.configSourceText),
      manifestSha256: options.manifestSourceText === undefined ? digest(manifest) : digestText(options.manifestSourceText),
      ...(options.deploymentSourceText === undefined
        ? {}
        : { deploymentSha256: digestText(options.deploymentSourceText) }),
      pinDeclared: Boolean(manifest.pins?.[`route:${candidate.id}`]),
    },
  };
  requireCandidatePin(manifest, candidate);
  const qualification = await runApplianceQualification(config, {
    manifest,
    requiredCapabilities: ['text'],
    timeoutMs: options.timeoutMs ?? 300_000,
  });
  if (qualification.overall !== 'qualified') {
    return {
      ...reportBase,
      preflightQualified: false,
      passed: false,
      passRate: 0,
      statuses: statusBlock(false),
      attempts: [],
    };
  }

  const app = await createApp({
    config,
    databasePath: ':memory:',
    seedDemo: true,
    skills: [],
    mode: 'project-analyst',
    integrationMode: 'offline',
  });
  const results: ProjectAnalystEvalAttempt[] = [];
  try {
    for (let index = 0; index < attempts; index += 1) {
      const prompt = prompts[index % prompts.length]!;
      const started = performance.now();
      try {
        const outcome = await app.projectAnalyst.start({
          message: prompt,
          workspaceId: 'local',
          actorId: 'project-analyst-eval',
          projectId: 'project-atlas',
          channel: 'eval:project-analyst',
          metadata: { evalAttempt: index + 1, candidateRouteId: candidate.id },
        });
        const toolCalls = calledTools(outcome.events);
        const selectedRouteId = routedId(outcome.events);
        const assertions = [
          check('terminal status', outcome.run.status === 'succeeded', `status=${outcome.run.status}`),
          check('exact route', selectedRouteId === candidate.id, `route=${selectedRouteId ?? 'none'}`),
          check('one scoped read tool', toolCalls.length === 1 && toolCalls[0] === PROJECT_ANALYST_TOOL, `tools=${toolCalls.join(',') || 'none'}`),
          check('no approvals', outcome.approvals.length === 0, `approvals=${outcome.approvals.length}`),
          check('no external effects', app.storage.outboxCount() === 0, `outbox=${app.storage.outboxCount()}`),
        ];
        if (outcome.run.output) {
          try {
            parseProjectAnalystResult(outcome.run.output);
            assertions.push(check('strict result schema', true, 'valid'));
          } catch (error) {
            assertions.push(check('strict result schema', false, message(error)));
          }
        } else {
          assertions.push(check('strict result schema', false, 'missing output'));
        }
        results.push({
          index: index + 1,
          prompt,
          passed: assertions.every((assertion) => assertion.passed),
          runId: outcome.run.id,
          ...(selectedRouteId ? { routeId: selectedRouteId } : {}),
          status: outcome.run.status,
          durationMs: Math.round(performance.now() - started),
          toolCalls,
          assertions,
          ...(outcome.run.error ? { error: outcome.run.error } : {}),
        });
      } catch (error) {
        results.push({
          index: index + 1,
          prompt,
          passed: false,
          status: 'failed_before_outcome',
          durationMs: Math.round(performance.now() - started),
          toolCalls: [],
          assertions: [],
          error: message(error),
        });
      }
    }
  } finally {
    await app.close();
  }
  const passRate = results.filter((result) => result.passed).length / results.length;
  const passed = passRate === 1;
  return {
    ...reportBase,
    preflightQualified: true,
    passed,
    passRate,
    statuses: statusBlock(passed),
    attempts: results,
  };
}

function selectCandidate(config: AppConfig, routeId: string): ModelRouteConfig {
  const route = config.routing?.routes.find((item) => item.id === routeId);
  if (!route) throw new Error(`Project analyst candidate route not found: ${routeId}`);
  if (route.tasks.length !== 1 || route.tasks[0] !== 'project_analysis') {
    throw new Error('Project analyst candidate must advertise only project_analysis; supervisor promotion is separate');
  }
  if (!route.local) throw new Error('Project analyst candidate must be local');
  if (route.inputCostPerMillion !== 0 || route.outputCostPerMillion !== 0) {
    throw new Error('Private local project analyst candidate must declare zero provider cost');
  }
  if (route.quality < 0.55) throw new Error('Project analyst candidate quality must be at least 0.55');
  return route;
}

function isolatedCandidateConfig(config: AppConfig, routeId: string): AppConfig {
  if (!config.routing) throw new Error('Project analyst evaluation requires an explicit model routing table');
  return {
    ...config,
    routing: {
      ...config.routing,
      explorationRate: 0,
      routes: config.routing.routes.map((route) => ({ ...route, enabled: route.id === routeId })),
    },
  };
}

function requireCandidatePin(manifest: ApplianceQualificationManifest, route: ModelRouteConfig): void {
  if (manifest.requirePins !== true) throw new Error('Project analyst evaluation requires strong manifest pins');
  const pin = manifest.pins?.[`route:${route.id}`];
  if (!pin) throw new Error(`Qualification manifest is missing route:${route.id}`);
  if (pin.provider !== route.provider || pin.model !== route.model) {
    throw new Error(`Qualification pin route:${route.id} does not match the candidate route`);
  }
  if (!pin.serviceDigest && !pin.artifacts?.length) {
    throw new Error(`Qualification pin route:${route.id} has no strong identity material`);
  }
}

function calledTools(events: HarnessEvent[]): string[] {
  return events.flatMap((event) => event.type === 'tool.call' && isObject(event.data) && typeof event.data.name === 'string'
    ? [event.data.name]
    : []);
}

function routedId(events: HarnessEvent[]): string | undefined {
  const event = [...events].reverse().find((item) => item.type === 'model.routed');
  return event && isObject(event.data) && typeof event.data.routeId === 'string' ? event.data.routeId : undefined;
}

function statusBlock(passed: boolean): ProjectAnalystEvalReport['statuses'] {
  return {
    projectAnalysis: passed ? 'passed' : 'failed',
    supervisor: 'not_evaluated',
    semanticEmbeddings: 'not_evaluated',
    vision: 'not_evaluated',
  };
}

function check(name: string, passed: boolean, detail: string) {
  return { name, passed, detail };
}

function boundedAttempts(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 10) {
    throw new Error('Project analyst eval attempts must be an integer from 1 to 10');
  }
  return value;
}

function boundedPrompts(values: readonly string[]): string[] {
  if (!Array.isArray(values) || values.length < 1 || values.length > 10) {
    throw new Error('Project analyst eval prompts must contain 1 to 10 entries');
  }
  return values.map((value, index) => {
    if (typeof value !== 'string' || !value.trim() || value.length > 4_000) {
      throw new Error(`Project analyst eval prompt ${index + 1} must contain 1 to 4000 characters`);
    }
    return value.trim();
  });
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function digestText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
