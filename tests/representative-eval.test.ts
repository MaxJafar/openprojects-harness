import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import YAML from 'yaml';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../src/config.js';
import type { AppConfig } from '../src/core/types.js';
import {
  parseRepresentativeCorpus,
  REPRESENTATIVE_CATEGORIES,
  runRepresentativeEval,
} from '../src/eval/representative.js';
import { runEvalSuite } from '../src/eval/runner.js';

const temporaryPaths = new Set<string>();

afterEach(async () => {
  vi.restoreAllMocks();
  for (const path of temporaryPaths) await rm(path, { recursive: true, force: true });
  temporaryPaths.clear();
});

describe('representative OpenProjects evaluation corpus', () => {
  it('covers every required category and passes the deterministic kernel lane without network access', async () => {
    const root = await temporaryDirectory();
    const configPath = join(root, 'openprojects.yaml');
    const source = hostileSourceConfig();
    await writeFile(configPath, YAML.stringify(source));
    const before = await readFile(configPath, 'utf8');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new Error('A deterministic evaluation attempted network access'),
    );

    const report = await runRepresentativeEval({
      configPath,
      corpusPath: resolve('evals/openprojects-representative.v1.json'),
    });

    expect(report.deterministic.cases.filter((item) => !item.passed)).toEqual([]);
    expect(report).toMatchObject({
      schema: 'openprojects.representative-eval-report.v1',
      passed: true,
      deterministic: { passed: true, passRate: 1 },
      live: { status: 'not_requested', passRate: null, routeId: null, cases: [] },
      isolation: {
        deterministic: true,
        model: 'mock/project-ops-v1',
        storage: 'memory',
        embeddings: 'builtin-hash-v1',
        modelRouting: 'removed',
        externalIntegrations: 'disabled',
      },
    });
    expect(report.deterministic.cases).toHaveLength(8);
    expect(report.deterministic.cases.every((item) => item.passed)).toBe(true);
    expect(report.coverage.map((item) => item.category)).toEqual(REPRESENTATIVE_CATEGORIES);
    expect(report.coverage.every((item) => item.caseCount > 0 && item.passedCount === item.caseCount)).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await readFile(configPath, 'utf8')).toBe(before);
  });

  it('rejects incomplete coverage and generic model-lane injection prompts', async () => {
    const path = resolve('evals/openprojects-representative.v1.json');
    const source = JSON.parse(await readFile(path, 'utf8')) as {
      cases: Array<{ category: string; live?: { prompt: string } }>;
    };
    const incomplete = structuredClone(source);
    incomplete.cases = incomplete.cases.filter((item) => item.category !== 'crash_recovery');
    expect(() => parseRepresentativeCorpus(incomplete)).toThrow(/missing required categories: crash_recovery/u);

    const genericInjection = structuredClone(source);
    const injection = genericInjection.cases.find((item) => item.category === 'prompt_injection' && item.live);
    expect(injection).toBeDefined();
    injection!.live!.prompt = 'Assess ordinary project risk using the scoped snapshot.';
    expect(() => parseRepresentativeCorpus(genericInjection)).toThrow(/recognized hostile instruction/u);
  });

  it('also strips remote embeddings and integrations from the legacy deterministic runner', async () => {
    const root = await temporaryDirectory();
    const configPath = join(root, 'openprojects.yaml');
    const suitePath = join(root, 'legacy-suite.json');
    await writeFile(configPath, YAML.stringify(hostileSourceConfig()));
    await writeFile(suitePath, JSON.stringify({
      id: 'legacy-hermetic',
      version: '1.0.0',
      description: 'Legacy deterministic egress regression.',
      gates: { minimumPassRate: 1, maximumAverageToolCalls: 1 },
      cases: [{
        id: 'risk',
        prompt: 'Assess Atlas delivery risk.',
        projectId: 'project-atlas',
        expect: {
          initialStatus: 'succeeded',
          finalStatus: 'succeeded',
          toolCalled: 'project_risk_report',
          outboxCount: 0,
        },
      }],
    }));
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network forbidden'));

    const report = await runEvalSuite(configPath, suitePath);

    expect(report).toMatchObject({ passed: true, passRate: 1 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

function hostileSourceConfig(): AppConfig {
  const source = loadConfig('openprojects.config.yaml');
  return {
    ...source,
    model: {
      provider: 'local-openai',
      model: 'must-not-be-contacted',
      baseUrl: 'http://127.0.0.1:9/v1',
    },
    routing: {
      dailyBudgetUsd: 10,
      explorationRate: 0.25,
      routes: [{
        id: 'must-not-be-contacted',
        provider: 'local-openai',
        model: 'must-not-be-contacted',
        tasks: ['supervisor'],
        baseUrl: 'http://127.0.0.1:9/v1',
        local: true,
        enabled: true,
        quality: 1,
        inputCostPerMillion: 0,
        outputCostPerMillion: 0,
        contextWindow: 8_192,
      }],
    },
    embeddings: {
      provider: 'ollama',
      model: 'must-not-be-contacted',
      baseUrl: 'http://127.0.0.1:9',
      serviceDigest: 'a'.repeat(64),
      dimensions: 1_024,
      timeoutMs: 1_000,
    },
    telegram: {
      enabled: true,
      apiBaseUrl: 'http://127.0.0.1:9',
    },
    notifications: {
      enabled: true,
      intervalMs: 5_000,
      lookaheadHours: 48,
    },
  };
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'openprojects-representative-eval-'));
  temporaryPaths.add(path);
  return path;
}
