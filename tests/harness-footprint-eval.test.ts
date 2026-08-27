import { describe, expect, it } from 'vitest';

import {
  HARNESS_FOOTPRINT_4GB_BUDGETS,
  parseDirectChildPids,
  runHarnessFootprintEval,
  type HarnessFootprintObservation,
} from '../src/eval/harness-footprint.js';

const MIB = 1024 * 1024;

describe('4 GB-tier harness footprint evaluation', () => {
  it('discovers only exact numeric direct children from bounded ps output', () => {
    const output = [
      '  112    12',
      '  114   312',
      '  113    12',
      '  112    12',
      'malformed',
    ].join('\n');

    expect(parseDirectChildPids(output, 12)).toEqual([112, 113]);
    expect(parseDirectChildPids(output, -1)).toEqual([]);
  });

  it('grades a healthy lifecycle while making injected evidence non-promotable', async () => {
    const report = await runHarnessFootprintEval({
      probe: async () => passingObservation(),
      now: () => new Date('2026-08-25T18:00:00.000Z'),
      environment: { PATH: '/usr/bin:/bin' },
    });

    expect(report).toMatchObject({
      schema: 'openprojects.harness-footprint-eval-report.v1',
      generatedAt: '2026-08-25T18:00:00.000Z',
      overall: 'diagnostic',
      tier: 'core-4gb',
      gate: { functionalPass: true, promotionEligible: false },
      testSeamsUsed: { probe: true, clock: true, environment: true, any: true },
      posture: {
        freshTemporaryDurableState: true,
        productionStateOpened: false,
        downloadsAttempted: false,
        externalModelRequestsAttempted: false,
        externalRequestsAttempted: false,
      },
    });
    expect(report.assertions.every((assertion) => assertion.passed)).toBe(true);
    expect(report.evaluatorBuild.contractSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('enforces every default resource ceiling without caller-overridable budgets', async () => {
    const observation = passingObservation();
    observation.startupMs = HARNESS_FOOTPRINT_4GB_BUDGETS.startupMs + 1;
    observation.idleRssBytes = HARNESS_FOOTPRINT_4GB_BUDGETS.idleRssBytes + 1;
    observation.lifecyclePeakRssBytes = HARNESS_FOOTPRINT_4GB_BUDGETS.lifecyclePeakRssBytes + 1;
    observation.postRunRssBytes = observation.lifecyclePeakRssBytes;
    observation.runLatencyMs = HARNESS_FOOTPRINT_4GB_BUDGETS.runLatencyMs + 1;
    observation.database.afterRun = database(HARNESS_FOOTPRINT_4GB_BUDGETS.liveDatabaseBytes + 1);
    observation.database.final = database(HARNESS_FOOTPRINT_4GB_BUDGETS.finalDatabaseBytes + 1);
    observation.shutdownMs = HARNESS_FOOTPRINT_4GB_BUDGETS.shutdownMs + 1;

    const report = await runHarnessFootprintEval({ probe: async () => observation });
    const failed = new Set(report.assertions.filter((assertion) => !assertion.passed).map((assertion) => assertion.id));

    expect(report.overall).toBe('failed');
    expect(report.gate).toEqual({ functionalPass: false, promotionEligible: false });
    expect(failed).toEqual(new Set([
      'startup_ms',
      'idle_rss_bytes',
      'lifecycle_peak_rss_bytes',
      'rss_growth_bytes',
      'run_latency_ms',
      'live_database_bytes',
      'final_database_bytes',
      'shutdown_ms',
    ]));
  });

  it('fails closed on identity, network, SQLite, and cleanup drift below the numeric budgets', async () => {
    const observation = passingObservation();
    observation.health.modelProvider = 'local-openai';
    (observation.isolation as { resourceProfile: string }).resourceProfile = 'unbounded';
    observation.run.toolCalls = 0;
    observation.database.integrity = 'corrupt';
    observation.isolation.socketProtectedWhileRunning = false;
    observation.isolation.internetDescriptorsAfterRun = 1;
    observation.shutdown.ownerLockRemoved = false;
    observation.shutdown.walRemoved = false;
    observation.isolation.temporaryDirectoryRemoved = false;

    const report = await runHarnessFootprintEval({ probe: async () => observation });
    const failed = new Set(report.assertions.filter((assertion) => !assertion.passed).map((assertion) => assertion.id));

    expect(failed).toEqual(new Set([
      'health_identity',
      'core_resource_profile',
      'representative_run',
      'sqlite_integrity',
      'protected_runtime_artifacts',
      'no_internet_descriptors',
      'clean_shutdown',
      'temporary_state_removed',
    ]));
    expect(report.gate.promotionEligible).toBe(false);
  });

  it('returns a versioned failed report when the disposable probe cannot complete', async () => {
    const report = await runHarnessFootprintEval({
      probe: async () => { throw new Error('synthetic launch failure'); },
    });

    expect(report).toMatchObject({
      schema: 'openprojects.harness-footprint-eval-report.v1',
      overall: 'failed',
      measurements: null,
      gate: { functionalPass: false, promotionEligible: false },
      error: 'synthetic launch failure',
    });
    expect(report.assertions).toEqual([expect.objectContaining({
      id: 'lifecycle_completed',
      passed: false,
    })]);
  });
});

function passingObservation(): HarnessFootprintObservation {
  return {
    host: { platform: 'darwin', architecture: 'arm64', nodeVersion: 'v24.18.1' },
    startupMs: 300,
    startupRssBytes: 118 * MIB,
    idleRssSamplesBytes: [120 * MIB, 121 * MIB, 120 * MIB],
    idleRssBytes: 121 * MIB,
    postRunRssBytes: 123 * MIB,
    settledPostRunRssBytes: 123 * MIB,
    sampledPeakRssBytes: 124 * MIB,
    lifecyclePeakRssBytes: 125 * MIB,
    runLatencyMs: 20,
    shutdownMs: 15,
    database: {
      beforeRun: database(750_000),
      afterRun: database(1_400_000),
      final: database(365_000),
      integrity: 'ok',
      runRows: 1,
      eventRows: 26,
    },
    health: {
      status: 'ok',
      modelProvider: 'mock',
      model: 'project-ops-v1',
      embeddings: 'builtin-hash-v1',
      transcription: 'disabled',
    },
    run: {
      httpStatus: 201,
      status: 'succeeded',
      eventCount: 26,
      toolCalls: 1,
    },
    shutdown: {
      exitCode: 143,
      signal: null,
      ownerLockRemoved: true,
      socketRemoved: true,
      walRemoved: true,
      shmRemoved: true,
      stderrEmpty: true,
    },
    isolation: {
      freshTemporaryDirectory: true,
      durableSqlite: true,
      unixSocketOnly: true,
      socketProtectedWhileRunning: true,
      ownerLockProtectedWhileRunning: true,
      model: 'mock/project-ops-v1',
      embeddings: 'builtin-hash-v1',
      transcription: 'disabled',
      telegram: 'disabled',
      integrations: 'removed',
      routing: 'removed',
      dotenvLoaded: false,
      processEnvironmentOverridesApplied: false,
      resourceProfile: 'core-4g-v1',
      internetDescriptorsBeforeRun: 0,
      internetDescriptorsAfterRun: 0,
      temporaryDirectoryRemoved: true,
    },
    bindings: {
      sourceConfigSha256: 'a'.repeat(64),
      effectiveConfigSha256: 'b'.repeat(64),
    },
  };
}

function database(totalBytes: number) {
  return {
    mainBytes: totalBytes,
    walBytes: 0,
    shmBytes: 0,
    totalBytes,
  };
}
