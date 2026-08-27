import { createHash } from 'node:crypto';
import { chmod, link, mkdtemp, realpath, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import YAML from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';

import type { AppConfig, ModelRouteConfig } from '../src/core/types.js';
import {
  evaluateLocalFourGbArgvPosture,
  evaluateLocalFourGbEnvironmentNames,
  evaluateLocalFourGbEvidence,
  evaluateLocalFourGbQualificationBinding,
  LOCAL_4GB_BUDGETS,
  loadLocalFourGbDeploymentManifest,
  localFourGbContractSha256,
  parseLocalFourGbDeploymentManifest,
  runLocalFourGbEval,
  type LocalFourGbArtifactIdentity,
  type LocalFourGbDeploymentManifest,
  type LocalFourGbProbeResult,
  type LocalFourGbResourceObservation,
} from '../src/eval/local-4gb.js';
import type { ProjectAnalystEvalReport } from '../src/eval/project-analyst.js';
import type { ApplianceQualificationManifest } from '../src/qualification/index.js';
import { PROJECT_ANALYST_CONTRACT } from '../src/runtime/project-analyst.js';

const temporaryPaths = new Set<string>();
const fixtureRoot = resolve(tmpdir(), 'openprojects-local-4gb-static');
const fixtureRuntime = join(fixtureRoot, process.platform === 'win32' ? 'llama-server.exe' : 'llama-server');
const fixtureModel = join(fixtureRoot, 'granite.gguf');
const fixtureDeployment = join(fixtureRoot, 'deployment.json');
const fixtureOtherRuntime = join(fixtureRoot, process.platform === 'win32' ? 'other-server.exe' : 'other-server');
const fixtureOtherModel = join(fixtureRoot, 'other.gguf');
const fixtureShortModel = join(fixtureRoot, 'short-option.gguf');
const fixtureModelsDirectory = join(fixtureRoot, 'unreviewed-models');
const fixtureKeyFile = join(fixtureRoot, 'llama.key');

afterEach(async () => {
  for (const path of temporaryPaths) await rm(path, { recursive: true, force: true });
  temporaryPaths.clear();
});

describe('local 4 GB qualification gate', () => {
  it('pins the versioned certification contract digest', () => {
    expect(localFourGbContractSha256()).toBe('bada25a34b3fe81cbbd3437ed4d5184c53d61edeee34b2799f9013d358dd279b');
  });

  it('parses a strict content-addressed manifest and rejects duplicate or unknown keys', () => {
    const source = JSON.stringify(manifest(fixtureRuntime, fixtureModel));
    const parsed = parseLocalFourGbDeploymentManifest(source, fixtureDeployment);

    expect(parsed).toMatchObject({
      schema: 'openprojects.local-4gb-deployment.v1',
      evidenceMode: 'portable-4gb',
      routeId: 'granite-350m',
      endpoint: 'http://127.0.0.1:8080/v1',
      deployment: { slots: 1, maxConcurrentRequests: 1, contextTokens: 3072 },
    });
    expect(() => parseLocalFourGbDeploymentManifest(
      source.replace('"routeId"', '"routeId":"duplicate","routeId"'),
    )).toThrow('duplicate keys');
    expect(() => parseLocalFourGbDeploymentManifest(
      JSON.stringify({ ...manifest(fixtureRuntime, fixtureModel), download: true }),
    )).toThrow('unknown field download');
    expect(() => parseLocalFourGbDeploymentManifest(
      JSON.stringify(manifest(fixtureRuntime, fixtureRuntime)),
    )).toThrow('model and runtime artifact paths must be distinct');
  });

  it('requires the exact bounded llama.cpp argv posture', () => {
    const candidate = manifest(fixtureRuntime, fixtureModel);
    const route = candidateRoute();
    expect(evaluateLocalFourGbArgvPosture(candidate, route)).toEqual([]);

    const unsafe: LocalFourGbDeploymentManifest = {
      ...candidate,
      runtime: {
        ...candidate.runtime,
        argv: candidate.runtime.argv.filter((argument) => argument !== '--offline'),
      },
      deployment: { ...candidate.deployment, slots: 2 },
    };
    expect(evaluateLocalFourGbArgvPosture(unsafe, route)).toEqual(expect.arrayContaining([
      'deployment.slots must equal 1',
      'missing required runtime option --offline',
    ]));

    const conflicting: LocalFourGbDeploymentManifest = {
      ...candidate,
      runtime: {
        ...candidate.runtime,
        argv: [
          ...candidate.runtime.argv,
          '--parallel', '4',
          `--model=${fixtureOtherModel}`,
          '--alias', 'unreviewed-alias',
          '-m', fixtureShortModel,
          '--agent',
          '--tools=on',
          '--mcp-servers-json={}',
          '--ui-mcp-proxy',
          `--models-dir=${fixtureModelsDirectory}`,
          '--models-preset=router.json',
          '--models-autoload',
          '--docker-repo=unreviewed/image',
          '--mmproj-url=https://example.invalid/mmproj',
          '--hf-repo=unreviewed/model',
        ],
      },
    };
    expect(evaluateLocalFourGbArgvPosture(conflicting, route)).toEqual(expect.arrayContaining([
      'runtime option --model must appear exactly once',
      'runtime option --model must use the packaged separate-value form',
      'runtime option --alias must appear exactly once',
      'runtime option --parallel must appear exactly once',
      'runtime argv contains forbidden short option or stray value -m',
      `runtime argv contains forbidden short option or stray value ${fixtureShortModel}`,
      'runtime argv contains unknown option --agent',
      'runtime argv contains unknown option --tools',
      'runtime argv contains unknown option --mcp-servers-json',
      'runtime argv contains unknown option --ui-mcp-proxy',
      'runtime argv contains unknown option --models-dir',
      'runtime argv contains unknown option --models-preset',
      'runtime argv contains unknown option --models-autoload',
      'runtime argv contains unknown option --docker-repo',
      'runtime argv contains unknown option --mmproj-url',
      'runtime argv contains unknown option --hf-repo',
    ]));
    expect(evaluateLocalFourGbArgvPosture(conflicting, route)).toEqual(expect.arrayContaining([
      expect.stringMatching(/^packaged llama\.cpp argv must contain exactly 53 entries; observed \d+$/u),
    ]));
  });

  it('requires the qualification route pin to exactly match every deployment identity and limit', () => {
    const deployment = manifest(fixtureRuntime, fixtureModel);
    const route = candidateRoute();
    const reviewed = qualificationManifest(deployment, route);
    expect(evaluateLocalFourGbQualificationBinding(reviewed, deployment, route)).toEqual([]);

    const mismatched: ApplianceQualificationManifest = structuredClone(reviewed);
    const pin = mismatched.pins![`route:${route.id}`]!;
    pin.artifacts![0] = { path: fixtureOtherModel, sha256: 'c'.repeat(64) };
    pin.runtime!.implementation = 'other-runtime';
    pin.runtime!.version = 'other-version';
    pin.runtime!.artifacts[0] = { path: fixtureOtherRuntime, sha256: 'd'.repeat(64) };
    pin.maxContextTokens = 2_048;
    pin.maxConcurrency = 2;

    expect(evaluateLocalFourGbQualificationBinding(mismatched, deployment, route)).toEqual(expect.arrayContaining([
      'qualification model artifact path does not equal deployment path',
      'qualification model artifact SHA-256 does not equal deployment SHA-256',
      'qualification runtime implementation does not equal deployment runtime implementation',
      'qualification runtime version does not equal deployment runtime version',
      'qualification runtime artifact path does not equal deployment path',
      'qualification runtime artifact SHA-256 does not equal deployment SHA-256',
      'qualification maxContextTokens must exactly equal deployment contextTokens',
      'qualification maxConcurrency must exactly equal the one-request deployment limit',
    ]));
  });

  it('blocks generic OpenAI-compatible provider mutations in both pure posture helpers', () => {
    const deployment = manifest(fixtureRuntime, fixtureModel);
    const genericRoute = { ...candidateRoute(), provider: 'openai-compatible' };
    const qualification = qualificationManifest(deployment, genericRoute);

    expect(evaluateLocalFourGbQualificationBinding(qualification, deployment, genericRoute)).toContain(
      'candidate route provider must be exactly llama.cpp',
    );
    expect(evaluateLocalFourGbArgvPosture(deployment, genericRoute)).toContain(
      'candidate route provider must be exactly llama.cpp',
    );
  });

  it('certifies only complete production Linux cgroup evidence', () => {
    const candidate = manifest(fixtureRuntime, fixtureModel);
    const assertions = evaluateLocalFourGbEvidence({
      manifest: candidate,
      artifacts: { model: artifact('model'), runtime: artifact('runtime') },
      argvPostureBlockers: [],
      probe: passingProbe('linux'),
      testSeamsUsed: false,
    });

    expect(assertions.filter((item) => item.scope !== 'macos-app-budget').every((item) => item.passed)).toBe(true);
    expect(assertions.find((item) => item.id === 'macos_app_budget_observed')?.passed).toBe(false);

    const withoutCgroup = passingProbe('linux');
    const { cgroup: _discardedCgroup, ...resourceWithoutCgroup } = withoutCgroup.resources!;
    withoutCgroup.resources = resourceWithoutCgroup;
    const blocked = evaluateLocalFourGbEvidence({
      manifest: candidate,
      artifacts: { model: artifact('model'), runtime: artifact('runtime') },
      argvPostureBlockers: [],
      probe: withoutCgroup,
      testSeamsUsed: false,
    });
    expect(blocked.filter((item) => !item.passed).map((item) => item.id)).toEqual(expect.arrayContaining([
      'cgroup_v2_observed',
      'four_gib_hard_limit',
      'swap_growth',
    ]));
  });

  it('fails the pure gate when model and runtime identities name the same filesystem object', () => {
    const candidate = manifest(fixtureRuntime, fixtureModel);
    const modelIdentity = artifact('model');
    const runtimeIdentity = {
      ...artifact('runtime'),
      device: modelIdentity.device!,
      inode: modelIdentity.inode!,
    };
    const assertions = evaluateLocalFourGbEvidence({
      manifest: candidate,
      artifacts: { model: modelIdentity, runtime: runtimeIdentity },
      argvPostureBlockers: [],
      probe: passingProbe('linux'),
      testSeamsUsed: false,
    });

    expect(assertions.find((item) => item.id === 'artifact_identities_distinct')).toMatchObject({
      passed: false,
      actual: 1,
    });
    expect(assertions.find((item) => item.id === 'artifact_identities_distinct')?.detail).toContain(
      'same device/inode',
    );
  });

  it('uses kernel peak counters and a hard swap ceiling instead of sampled-current false greens', () => {
    const candidate = manifest(fixtureRuntime, fixtureModel);
    const probe = passingProbe('linux');
    probe.resources!.cgroup!.memoryCurrentPeakBytes = 512 * 1024 ** 2;
    probe.resources!.cgroup!.kernelMemoryPeakBytes = 4 * 1024 ** 3 - LOCAL_4GB_BUDGETS.minimumCgroupHeadroomBytes + 1;
    probe.resources!.cgroup!.swapInitialBytes = 0;
    probe.resources!.cgroup!.swapPeakBytes = 1;
    probe.resources!.cgroup!.swapFinalBytes = 0;
    probe.resources!.cgroup!.swapLimitBytes = LOCAL_4GB_BUDGETS.maximumSwapBytes + 1;
    probe.resources!.cgroup!.kernelSwapPeakBytes = LOCAL_4GB_BUDGETS.maximumSwapBytes + 1;

    const assertions = evaluateLocalFourGbEvidence({
      manifest: candidate,
      artifacts: { model: artifact('model'), runtime: artifact('runtime') },
      argvPostureBlockers: [],
      probe,
      testSeamsUsed: false,
    });
    expect(failedAssertionIds(assertions)).toEqual(expect.arrayContaining([
      'cgroup_peak',
      'cgroup_headroom',
      'swap_hard_limit',
      'kernel_swap_peak',
    ]));
    expect(assertions.find((item) => item.id === 'swap_growth')?.passed).toBe(true);
  });

  it('requires literal small-host evidence in addition to a bounded cgroup', () => {
    const candidate = manifest(fixtureRuntime, fixtureModel);
    const probe = passingProbe('linux');
    probe.resources!.hostTotalMemoryBytes = LOCAL_4GB_BUDGETS.maximumPortableHostMemoryBytes + 1;
    probe.resources!.hostAvailableMinimumBytes = LOCAL_4GB_BUDGETS.minimumHostAvailableBytes - 1;
    const assertions = evaluateLocalFourGbEvidence({
      manifest: candidate,
      artifacts: { model: artifact('model'), runtime: artifact('runtime') },
      argvPostureBlockers: [],
      probe,
      testSeamsUsed: false,
    });

    expect(failedAssertionIds(assertions)).toEqual(expect.arrayContaining([
      'portable_host_memory',
      'host_available_headroom',
    ]));
  });

  it('blocks incomplete, unstable, or sparsely sampled telemetry', () => {
    const candidate = manifest(fixtureRuntime, fixtureModel);
    const probe = passingProbe('linux');
    probe.resources!.telemetryError = 'one cgroup sample could not be parsed';
    probe.resources!.initialSampleDelayMs = LOCAL_4GB_BUDGETS.maximumEdgeSampleDelayMs + 1;
    probe.resources!.finalSampleAgeMs = LOCAL_4GB_BUDGETS.maximumEdgeSampleDelayMs + 1;
    probe.resources!.maximumSampleGapMs = LOCAL_4GB_BUDGETS.maximumResourceSampleGapMs + 1;
    probe.resources!.sampleCount = 1;
    probe.resources!.cgroup!.inodeStable = false;
    probe.resources!.cgroup!.limitStable = false;
    probe.resources!.cgroup!.swapLimitStable = false;

    const assertions = evaluateLocalFourGbEvidence({
      manifest: candidate,
      artifacts: { model: artifact('model'), runtime: artifact('runtime') },
      argvPostureBlockers: [],
      probe,
      testSeamsUsed: false,
    });
    expect(failedAssertionIds(assertions)).toEqual(expect.arrayContaining([
      'telemetry_complete',
      'cgroup_inode_stable',
      'cgroup_limits_stable',
      'telemetry_cadence',
      'telemetry_sample_coverage',
    ]));
  });

  it('rejects inference, proxy, accelerator, and loader environment overrides by name only', () => {
    expect(evaluateLocalFourGbEnvironmentNames([
      'PATH',
      'OPENPROJECTS_MODEL',
      'LLAMA_ARG_BATCH',
      'HF_TOKEN',
      'HTTPS_PROXY',
      'NO_PROXY',
      'CUDA_VISIBLE_DEVICES',
      'LD_PRELOAD',
      'HF_TOKEN',
    ])).toEqual([
      'CUDA_VISIBLE_DEVICES',
      'HF_TOKEN',
      'HTTPS_PROXY',
      'LD_PRELOAD',
      'LLAMA_ARG_BATCH',
      'NO_PROXY',
    ]);
  });

  it('does not treat declared authentication as proof that anonymous access is denied', () => {
    const candidate = manifest(fixtureRuntime, fixtureModel);
    const probe = passingProbe('linux');
    probe.process.authenticationVerified = false;
    probe.process.authenticationDetail = 'anonymous request returned 200';
    const assertions = evaluateLocalFourGbEvidence({
      manifest: candidate,
      artifacts: { model: artifact('model'), runtime: artifact('runtime') },
      argvPostureBlockers: [],
      probe,
      testSeamsUsed: false,
    });

    expect(assertions.find((item) => item.id === 'authentication_enforced')).toMatchObject({
      passed: false,
      detail: 'anonymous request returned 200',
    });
  });

  it('records macOS process-tree budget evidence without calling it 4 GiB certification', () => {
    const candidate = { ...manifest(fixtureRuntime, fixtureModel), evidenceMode: 'macos-app-budget' as const };
    const probe = passingProbe('darwin');
    probe.process = {
      platform: 'darwin',
      processId: 42,
      alive: true,
      executableVerified: false,
      argvVerified: false,
      verified: false,
      observedCommand: `${fixtureRuntime} ...`,
      sameCgroup: false,
      detail: 'diagnostic command text only',
    };
    const assertions = evaluateLocalFourGbEvidence({
      manifest: candidate,
      artifacts: { model: artifact('model'), runtime: artifact('runtime') },
      argvPostureBlockers: [],
      probe,
      testSeamsUsed: false,
    });

    expect(assertions.find((item) => item.id === 'macos_app_budget_observed')?.passed).toBe(true);
    expect(assertions.find((item) => item.id === 'macos_app_budget')?.passed).toBe(true);
    expect(assertions.find((item) => item.id === 'linux_platform')?.passed).toBe(false);
    expect(assertions.find((item) => item.id === 'process_identity')?.passed).toBe(false);
  });

  it('emits a versioned diagnostic report for injected evidence and never promotes test seams', async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'openprojects-local-4gb-')));
    temporaryPaths.add(directory);
    const runtimePath = join(directory, process.platform === 'win32' ? 'llama-server.exe' : 'llama-server');
    const modelPath = join(directory, 'granite.gguf');
    await writeFile(runtimePath, '#!/bin/sh\nexit 0\n');
    await chmod(runtimePath, 0o700);
    await writeFile(modelPath, 'test-only-model-bytes');
    const configPath = join(directory, 'openprojects.yaml');
    const qualificationPath = join(directory, 'qualification.json');
    const deploymentPath = join(directory, 'deployment.json');
    const deployment = manifest(runtimePath, modelPath);
    deployment.runtime.binary.sha256 = sha256('#!/bin/sh\nexit 0\n');
    deployment.model.sha256 = sha256('test-only-model-bytes');
    const configSource = YAML.stringify(config());
    const qualificationSource = JSON.stringify(qualificationManifest(deployment, candidateRoute()), null, 2);
    const deploymentSource = JSON.stringify(deployment, null, 2);
    await writeFile(configPath, configSource);
    await writeFile(qualificationPath, qualificationSource);
    await writeFile(deploymentPath, deploymentSource);

    const loaded = await loadLocalFourGbDeploymentManifest(deploymentPath);
    expect(loaded.runtime.binary.path).toBe(runtimePath);
    const report = await runLocalFourGbEval({
      configPath,
      qualificationManifestPath: qualificationPath,
      deploymentManifestPath: deploymentPath,
      soakMs: 0,
      now: () => new Date('2026-08-26T12:00:00.000Z'),
      probe: async (context) => {
        expect(context.configSourceText).toBe(configSource);
        expect(context.qualificationManifestSourceText).toBe(qualificationSource);
        expect(context.deploymentManifestSourceText).toBe(deploymentSource);
        return passingProbe('linux', {
          configSha256: sha256(context.configSourceText),
          manifestSha256: sha256(context.qualificationManifestSourceText),
          deploymentSha256: sha256(context.deploymentManifestSourceText),
        });
      },
    });

    expect(report).toMatchObject({
      schema: 'openprojects.local-4gb-eval-report.v1',
      generatedAt: '2026-08-26T12:00:00.000Z',
      overall: 'diagnostic',
      candidate: { routeId: 'granite-350m', provider: 'llama.cpp' },
      gate: {
        qualityPassed: true,
        posturePassed: true,
        promotionEligible: false,
        portableTrueFourGiB: { certified: false },
        macosAppBudget: { certification: false },
      },
      testSeamsUsed: { probe: true, clock: true, any: true },
      posture: {
        downloadsAttempted: false,
        processesStarted: false,
        processesStopped: false,
        promotionsAttempted: false,
      },
    });
    expect(report.identity.runtime.argv).toEqual(deployment.runtime.argv);
    expect(report.identity.runtime.argvSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(report.sourceBindings).toMatchObject({
      configSha256: sha256(configSource),
      qualificationManifestSha256: sha256(qualificationSource),
      deploymentManifestSha256: sha256(deploymentSource),
      stableAfterObservation: true,
      blockers: [],
    });
    expect(report.identity.qualificationBindingVerified).toBe(true);
    expect(report.assertions.find((item) => item.id === 'production_evidence')?.passed).toBe(false);
  });

  it('uses exact once-read source snapshots and fails closed when a source mutates during observation', async () => {
    const fixture = await localEvalFixture();
    let observedConfig = '';
    let observedQualification = '';
    const report = await runLocalFourGbEval({
      configPath: fixture.configPath,
      qualificationManifestPath: fixture.qualificationPath,
      deploymentManifestPath: fixture.deploymentPath,
      soakMs: 0,
      probe: async (context) => {
        observedConfig = context.configSourceText;
        observedQualification = context.qualificationManifestSourceText;
        await writeFile(fixture.qualificationPath, `${fixture.qualificationSource}\n`);
        return passingProbe('linux', {
          configSha256: sha256(context.configSourceText),
          manifestSha256: sha256(context.qualificationManifestSourceText),
          deploymentSha256: sha256(context.deploymentManifestSourceText),
        });
      },
    });

    expect(observedConfig).toBe(fixture.configSource);
    expect(observedQualification).toBe(fixture.qualificationSource);
    expect(report.sourceBindings.configSha256).toBe(sha256(fixture.configSource));
    expect(report.sourceBindings.qualificationManifestSha256).toBe(sha256(fixture.qualificationSource));
    expect(report.sourceBindings.deploymentManifestSha256).toBe(sha256(fixture.deploymentSource));
    expect(report.sourceBindings.stableAfterObservation).toBe(false);
    expect(report.sourceBindings.blockers).toEqual(expect.arrayContaining([
      expect.stringContaining('qualification manifest'),
    ]));
    expect(report.assertions.find((item) => item.id === 'source_snapshots_stable')?.passed).toBe(false);
    expect(report.gate.identityBound).toBe(false);
    expect(report.gate.promotionEligible).toBe(false);
  });

  it('rejects a generic provider and more than one enabled route before probing', async () => {
    const genericFixture = await localEvalFixture();
    const genericConfig = config();
    genericConfig.routing!.routes[0] = { ...candidateRoute(), provider: 'openai-compatible' };
    await writeFile(genericFixture.configPath, YAML.stringify(genericConfig));
    await expect(runLocalFourGbEval({
      configPath: genericFixture.configPath,
      qualificationManifestPath: genericFixture.qualificationPath,
      deploymentManifestPath: genericFixture.deploymentPath,
      soakMs: 0,
      probe: async () => passingProbe('linux'),
    })).rejects.toThrow('candidate provider must be exactly llama.cpp');

    const multiRouteFixture = await localEvalFixture();
    const multiRouteConfig = config();
    multiRouteConfig.routing!.routes.push({
      ...candidateRoute(),
      id: 'second-local-route',
      model: 'second-model',
    });
    await writeFile(multiRouteFixture.configPath, YAML.stringify(multiRouteConfig));
    await expect(runLocalFourGbEval({
      configPath: multiRouteFixture.configPath,
      qualificationManifestPath: multiRouteFixture.qualificationPath,
      deploymentManifestPath: multiRouteFixture.deploymentPath,
      soakMs: 0,
      probe: async () => passingProbe('linux'),
    })).rejects.toThrow('requires exactly one enabled route total; observed 2');
  });

  it('does not probe or promote hardlink aliases of one model/runtime filesystem object', async () => {
    const fixture = await localEvalFixture();
    await rm(fixture.modelPath);
    try {
      await link(fixture.runtimePath, fixture.modelPath);
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EOPNOTSUPP' || code === 'ENOSYS') return;
      throw cause;
    }
    const deployment = manifest(fixture.runtimePath, fixture.modelPath);
    const sharedSha256 = sha256(fixture.runtimeSource);
    deployment.runtime.binary.sha256 = sharedSha256;
    deployment.model.sha256 = sharedSha256;
    await writeFile(
      fixture.qualificationPath,
      JSON.stringify(qualificationManifest(deployment, candidateRoute()), null, 2),
    );
    await writeFile(fixture.deploymentPath, JSON.stringify(deployment, null, 2));
    let probed = false;

    const report = await runLocalFourGbEval({
      configPath: fixture.configPath,
      qualificationManifestPath: fixture.qualificationPath,
      deploymentManifestPath: fixture.deploymentPath,
      soakMs: 0,
      probe: async () => {
        probed = true;
        return passingProbe('linux');
      },
    });

    expect(probed).toBe(false);
    expect(report.identity.model.device).toBe(report.identity.runtime.device);
    expect(report.identity.model.inode).toBe(report.identity.runtime.inode);
    expect(report.identity.artifactsDistinct).toBe(false);
    expect(report.identity.artifactIdentityBlockers.join('; ')).toContain('same device/inode');
    expect(report.assertions.find((item) => item.id === 'artifact_identities_distinct')?.passed).toBe(false);
    expect(report.gate.identityBound).toBe(false);
    expect(report.gate.promotionEligible).toBe(false);
  });

  it('detects same-inode artifact mutation even when bytes and mtime are restored', async () => {
    const fixture = await localEvalFixture();
    const original = await stat(fixture.modelPath);
    const report = await runLocalFourGbEval({
      configPath: fixture.configPath,
      qualificationManifestPath: fixture.qualificationPath,
      deploymentManifestPath: fixture.deploymentPath,
      soakMs: 0,
      probe: async (context) => {
        await writeFile(fixture.modelPath, 'temporary-mutated-model');
        await writeFile(fixture.modelPath, fixture.modelSource);
        await utimes(fixture.modelPath, original.atime, original.mtime);
        return passingProbe('linux', {
          configSha256: sha256(context.configSourceText),
          manifestSha256: sha256(context.qualificationManifestSourceText),
          deploymentSha256: sha256(context.deploymentManifestSourceText),
        });
      },
    });

    expect(report.identity.model.observedSha256).toBe(sha256(fixture.modelSource));
    expect(report.identity.artifactsStableAfterObservation).toBe(false);
    expect(report.identity.artifactStabilityBlockers).toEqual(expect.arrayContaining([
      expect.stringContaining('model retained descriptor metadata changed'),
    ]));
    expect(report.assertions.find((item) => item.id === 'artifact_snapshots_stable')?.passed).toBe(false);
    expect(report.gate.identityBound).toBe(false);
  });

  it('detects pathname replacement even when the replacement has reviewed bytes', async () => {
    const fixture = await localEvalFixture();
    const displacedPath = `${fixture.modelPath}.displaced`;
    const report = await runLocalFourGbEval({
      configPath: fixture.configPath,
      qualificationManifestPath: fixture.qualificationPath,
      deploymentManifestPath: fixture.deploymentPath,
      soakMs: 0,
      probe: async (context) => {
        await rename(fixture.modelPath, displacedPath);
        await writeFile(fixture.modelPath, fixture.modelSource);
        return passingProbe('linux', {
          configSha256: sha256(context.configSourceText),
          manifestSha256: sha256(context.qualificationManifestSourceText),
          deploymentSha256: sha256(context.deploymentManifestSourceText),
        });
      },
    });

    expect(report.identity.artifactsStableAfterObservation).toBe(false);
    expect(report.identity.artifactStabilityBlockers.join('; ')).toMatch(/model .*metadata changed/u);
    expect(report.gate.identityBound).toBe(false);
  });
});

function manifest(runtimePath: string, modelPath: string): LocalFourGbDeploymentManifest {
  return {
    schema: 'openprojects.local-4gb-deployment.v1',
    evidenceMode: 'portable-4gb',
    routeId: 'granite-350m',
    processId: 42,
    endpoint: 'http://127.0.0.1:8080/v1',
    model: { path: modelPath, sha256: 'a'.repeat(64) },
    runtime: {
      implementation: 'llama.cpp',
      version: 'reviewed-test-build',
      binary: { path: runtimePath, sha256: 'b'.repeat(64) },
      argv: [
        runtimePath,
        '--model', modelPath,
        '--alias', 'granite-350m-q8',
        '--offline',
        '--host', '127.0.0.1',
        '--port', '8080',
        '--api-key-file', fixtureKeyFile,
        '--no-ui', '--no-ui-mcp-proxy', '--no-agent', '--no-slots', '--no-mmproj',
        '--parallel', '1',
        '--no-cont-batching',
        '--ctx-size', '3072',
        '--batch-size', '256',
        '--ubatch-size', '64',
        '--cache-type-k', 'f16',
        '--cache-type-v', 'f16',
        '--device', 'none',
        '--gpu-layers', '0',
        '--cache-ram', '64',
        '--ctx-checkpoints', '2',
        '--no-cache-idle-slots',
        '--reasoning', 'off',
        '--n-predict', '512',
        '--load-mode', 'mmap',
        '--fit', 'off',
        '--threads-http', '1',
        '--timeout', '60',
        '--sse-ping-interval', '-1',
      ],
    },
    deployment: {
      slots: 1,
      maxConcurrentRequests: 1,
      contextTokens: 3072,
      maxOutputTokens: 512,
      offline: true,
      authenticated: true,
      ui: false,
      builtInAgent: false,
      builtInTools: false,
      continuousBatching: false,
    },
  };
}

function candidateRoute(): ModelRouteConfig {
  return {
    id: 'granite-350m',
    provider: 'llama.cpp',
    model: 'granite-350m-q8',
    tasks: ['project_analysis'],
    baseUrl: 'http://127.0.0.1:8080/v1',
    apiKey: 'local-test-key-00000000000000000000',
    local: true,
    enabled: true,
    quality: 0.55,
    inputCostPerMillion: 0,
    outputCostPerMillion: 0,
    contextWindow: 3072,
  };
}

function config(): AppConfig {
  return {
    version: 1,
    agent: {
      id: 'supervisor-test',
      version: '1.0.0',
      name: 'Supervisor Test',
      system: 'Test supervisor.',
      skills: [],
      tools: [],
      budgets: {
        maxSteps: 3,
        maxToolCalls: 4,
        maxWallTimeMs: 30_000,
        maxInputTokens: 2_048,
        reservedOutputTokens: 512,
      },
    },
    policy: {
      read: 'allow',
      draft: 'allow',
      memory_write: 'deny',
      internal_write: 'deny',
      external_write: 'deny',
      destructive: 'deny',
    },
    server: { host: '127.0.0.1', port: 4310 },
    storage: { database: ':memory:' },
    privacy: { localOnly: true, allowedOrigins: [] },
    telegram: { enabled: false, apiBaseUrl: 'https://api.telegram.org' },
    model: { provider: 'mock', model: 'fixture' },
    routing: { dailyBudgetUsd: 0, explorationRate: 0, routes: [candidateRoute()] },
    memory: { retrievalLimit: 2, maxContextCharacters: 1_024 },
    learning: {
      enabled: false,
      groupObservation: false,
      minimumSalience: 0.55,
      feedbackLearningRate: 0.2,
      retentionDays: 90,
    },
    embeddings: { provider: 'builtin', model: 'builtin-hash-v1', dimensions: 64, timeoutMs: 1_000 },
    transcription: {
      provider: 'disabled',
      command: 'whisper-cli',
      ffmpegCommand: 'ffmpeg',
      timeoutMs: 30_000,
      maxBytes: 1_000_000,
      maxDurationSeconds: 60,
    },
    notifications: { enabled: false, intervalMs: 60_000, lookaheadHours: 48 },
    subagents: { maxCallsPerRun: 0, maxParallel: 1, maxDepth: 0 },
  };
}

function qualificationManifest(
  deployment: LocalFourGbDeploymentManifest,
  route: ModelRouteConfig = candidateRoute(),
): ApplianceQualificationManifest {
  return {
    schema: 'openprojects.appliance-qualification.v1',
    requiredCapabilities: ['text'],
    requirePins: true,
    pins: {
      [`route:${route.id}`]: {
        provider: route.provider,
        model: route.model,
        artifacts: [{ ...deployment.model }],
        maxContextTokens: deployment.deployment.contextTokens,
        maxConcurrency: deployment.deployment.maxConcurrentRequests,
        runtime: {
          implementation: deployment.runtime.implementation,
          version: deployment.runtime.version,
          artifacts: [{ ...deployment.runtime.binary }],
        },
      },
    },
  };
}

async function localEvalFixture(): Promise<{
  configPath: string;
  qualificationPath: string;
  deploymentPath: string;
  runtimePath: string;
  modelPath: string;
  runtimeSource: string;
  modelSource: string;
  configSource: string;
  qualificationSource: string;
  deploymentSource: string;
}> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'openprojects-local-4gb-source-')));
  temporaryPaths.add(directory);
  const runtimePath = join(directory, process.platform === 'win32' ? 'llama-server.exe' : 'llama-server');
  const modelPath = join(directory, 'granite.gguf');
  const runtimeSource = '#!/bin/sh\nexit 0\n';
  const modelSource = 'test-only-model-bytes';
  await writeFile(runtimePath, runtimeSource);
  await chmod(runtimePath, 0o700);
  await writeFile(modelPath, modelSource);
  const deployment = manifest(runtimePath, modelPath);
  deployment.runtime.binary.sha256 = sha256(runtimeSource);
  deployment.model.sha256 = sha256(modelSource);
  const configPath = join(directory, 'openprojects.yaml');
  const qualificationPath = join(directory, 'qualification.json');
  const deploymentPath = join(directory, 'deployment.json');
  const configSource = YAML.stringify(config());
  const qualificationSource = JSON.stringify(qualificationManifest(deployment), null, 2);
  const deploymentSource = JSON.stringify(deployment, null, 2);
  await writeFile(configPath, configSource);
  await writeFile(qualificationPath, qualificationSource);
  await writeFile(deploymentPath, deploymentSource);
  return {
    configPath,
    qualificationPath,
    deploymentPath,
    runtimePath,
    modelPath,
    runtimeSource,
    modelSource,
    configSource,
    qualificationSource,
    deploymentSource,
  };
}

function artifact(kind: 'model' | 'runtime'): LocalFourGbArtifactIdentity {
  return {
    kind,
    path: kind === 'model' ? fixtureModel : fixtureRuntime,
    sha256: kind === 'model' ? 'a'.repeat(64) : 'b'.repeat(64),
    exists: true,
    regularFile: true,
    symbolicLink: false,
    ...(kind === 'runtime' ? { executable: true } : {}),
    bytes: kind === 'model' ? 378_138_016 : 10_000_000,
    device: kind === 'model' ? '41' : '42',
    inode: kind === 'model' ? '101' : '102',
    observedSha256: kind === 'model' ? 'a'.repeat(64) : 'b'.repeat(64),
    matched: true,
    detail: 'matched',
  };
}

function passingProbe(
  targetPlatform: 'linux' | 'darwin',
  bindings: { configSha256?: string; manifestSha256?: string; deploymentSha256?: string } = {},
): LocalFourGbProbeResult {
  const resource: LocalFourGbResourceObservation = {
    platform: targetPlatform,
    architecture: 'arm64',
    hostTotalMemoryBytes: 4 * 1024 ** 3,
    durationMs: LOCAL_4GB_BUDGETS.minimumSoakMs,
    sampleCount: 3_601,
    initialSampleDelayMs: 10,
    finalSampleAgeMs: 10,
    maximumSampleGapMs: LOCAL_4GB_BUDGETS.resourceSampleIntervalMs + 10,
    targetAliveEverySample: true,
    combinedProcessTreeRssInitialBytes: 900 * 1024 ** 2,
    combinedProcessTreeRssPeakBytes: 1024 ** 3,
    combinedProcessTreeRssFinalBytes: 950 * 1024 ** 2,
    hostAvailableInitialBytes: 900 * 1024 ** 2,
    hostAvailableMinimumBytes: 700 * 1024 ** 2,
    hostAvailableFinalBytes: 800 * 1024 ** 2,
    ...(targetPlatform === 'linux'
      ? {
          cgroup: {
            version: 'v2' as const,
            path: '/openprojects-test',
            evaluatorAndTargetCovered: true,
            device: '7',
            inode: '7001',
            inodeStable: true,
            limitBytes: 4 * 1024 ** 3,
            limitStable: true,
            kernelMemoryPeakBytes: 3 * 1024 ** 3,
            memoryCurrentInitialBytes: 2.5 * 1024 ** 3,
            memoryCurrentPeakBytes: 3 * 1024 ** 3,
            memoryCurrentFinalBytes: 2.6 * 1024 ** 3,
            swapInitialBytes: 0,
            swapPeakBytes: 32 * 1024 ** 2,
            swapFinalBytes: 16 * 1024 ** 2,
            swapLimitBytes: LOCAL_4GB_BUDGETS.maximumSwapBytes,
            swapLimitStable: true,
            kernelSwapPeakBytes: 32 * 1024 ** 2,
          },
        }
      : {}),
  };
  return {
    process: {
      platform: targetPlatform,
      processId: 42,
      alive: true,
      executableVerified: true,
      argvVerified: true,
      verified: true,
      observedExecutable: fixtureRuntime,
      observedArgv: manifest(fixtureRuntime, fixtureModel).runtime.argv,
      ...(targetPlatform === 'linux'
        ? {
            networkNamespaceVerified: true,
            cgroupNamespaceVerified: true,
            mountNamespaceSame: true,
            runtimeObjectVerified: true,
            modelMappingVerified: true,
            listenerVerified: true,
            environmentVerified: true,
            authenticationVerified: true,
            authenticationDetail: 'negative authentication probes rejected',
            targetNetworkNamespace: '1:1001',
            evaluatorNetworkNamespace: '1:1001',
            targetCgroupNamespace: '1:1501',
            evaluatorCgroupNamespace: '1:1501',
            targetMountNamespace: '1:2001',
            evaluatorMountNamespace: '1:2001',
            runtimeDevice: '42',
            runtimeInode: '102',
            modelDevice: '41',
            modelInode: '101',
            listenerSocketInode: '9001',
            processStartTimeTicks: '123456',
            cgroupMountPath: '/sys/fs/cgroup',
            measurementCgroupDevice: '7',
            measurementCgroupInode: '7001',
            dangerousEnvironmentNames: [],
            targetCgroupPath: '/openprojects-test/model.service',
            evaluatorCgroupPath: '/openprojects-test/evaluator.scope',
            measurementCgroupPath: '/openprojects-test',
            sameCgroup: false,
          }
        : { sameCgroup: false }),
      detail: 'matched',
    },
    resources: resource,
    quality: qualityReport(bindings),
  };
}

function qualityReport(
  bindings: { configSha256?: string; manifestSha256?: string; deploymentSha256?: string } = {},
): ProjectAnalystEvalReport {
  return {
    schema: 'openprojects.project-analyst-eval-report.v1',
    generatedAt: '2026-08-26T12:00:00.000Z',
    laneContract: PROJECT_ANALYST_CONTRACT,
    candidate: {
      routeId: 'granite-350m',
      provider: 'llama.cpp',
      model: 'granite-350m-q8',
      tasks: ['project_analysis'],
      local: true,
    },
    bindings: {
      configSha256: bindings.configSha256 ?? 'c'.repeat(64),
      manifestSha256: bindings.manifestSha256 ?? 'd'.repeat(64),
      ...(bindings.deploymentSha256 ? { deploymentSha256: bindings.deploymentSha256 } : {}),
      pinDeclared: true,
    },
    preflightQualified: true,
    passed: true,
    passRate: 1,
    statuses: {
      projectAnalysis: 'passed',
      supervisor: 'not_evaluated',
      semanticEmbeddings: 'not_evaluated',
      vision: 'not_evaluated',
    },
    attempts: [],
  };
}

function failedAssertionIds(assertions: ReturnType<typeof evaluateLocalFourGbEvidence>): string[] {
  return assertions.filter((item) => !item.passed).map((item) => item.id);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
