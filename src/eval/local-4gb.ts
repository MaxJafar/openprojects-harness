import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { request as httpRequest } from 'node:http';
import {
  lstat,
  open,
  readFile,
  readlink,
  readdir,
  realpath,
  stat,
  statfs,
  type FileHandle,
} from 'node:fs/promises';
import { arch, freemem, platform, totalmem } from 'node:os';
import { dirname, extname, isAbsolute, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

import YAML from 'yaml';

import { loadConfig } from '../config.js';
import type { AppConfig, ModelRouteConfig } from '../core/types.js';
import {
  parseQualificationManifest,
  type ApplianceQualificationManifest,
  type QualificationTargetPin,
} from '../qualification/index.js';
import { OPENPROJECTS_VERSION } from '../version.js';
import {
  runProjectAnalystEval,
  type ProjectAnalystEvalReport,
} from './project-analyst.js';

const execFileAsync = promisify(execFile);
const MIB = 1024 * 1024;
const GIB = 1024 ** 3;
const MAX_MANIFEST_BYTES = MIB;
const MAX_MODEL_ARTIFACT_BYTES = GIB;
const MAX_ARG_COUNT = 128;
const MAX_ARG_BYTES = 4_096;
const RESOURCE_SAMPLE_INTERVAL_MS = 500;
const MAX_RESOURCE_SAMPLE_GAP_MS = 1_000;

function noFollowOpenFlags(): number {
  const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
  return fsConstants.O_RDONLY | noFollow;
}
const MAX_EDGE_SAMPLE_DELAY_MS = 1_000;
const AUTHENTICATION_PROBE_TIMEOUT_MS = 5_000;
const CGROUP2_SUPER_MAGIC = 0x63677270n;
const REQUIRED_LLAMA_CPP_BOOLEAN_FLAGS = [
  '--offline',
  '--no-ui',
  '--no-ui-mcp-proxy',
  '--no-agent',
  '--no-slots',
  '--no-mmproj',
  '--no-cont-batching',
  '--no-cache-idle-slots',
] as const;
const REQUIRED_LLAMA_CPP_VALUE_FLAGS = [
  '--model',
  '--alias',
  '--host',
  '--port',
  '--api-key-file',
  '--parallel',
  '--ctx-size',
  '--batch-size',
  '--ubatch-size',
  '--cache-type-k',
  '--cache-type-v',
  '--cache-ram',
  '--ctx-checkpoints',
  '--reasoning',
  '--n-predict',
  '--load-mode',
  '--fit',
  '--threads-http',
  '--timeout',
  '--sse-ping-interval',
  '--device',
  '--gpu-layers',
] as const;
const DANGEROUS_ENVIRONMENT_NAME = /^(?:LLAMA_|HF_|HUGGINGFACE_|HUGGING_FACE_|TRANSFORMERS_|(?:HTTP|HTTPS|ALL|FTP|NO|SOCKS)_PROXY$|GIT_PROXY_COMMAND$|CUDA_|ROCR_|HIP_|GGML_|SYCL_|ONEAPI_|ZE_|ZES_|VK_|VULKAN_|LD_PRELOAD$|LD_AUDIT$|LD_LIBRARY_PATH$|GLIBC_TUNABLES$|MALLOC_)/iu;

export const LOCAL_4GB_DEPLOYMENT_SCHEMA = 'openprojects.local-4gb-deployment.v1' as const;
export const LOCAL_4GB_REPORT_SCHEMA = 'openprojects.local-4gb-eval-report.v1' as const;
export const LOCAL_4GB_CONTRACT_VERSION = 'openprojects.local-4gb-gate.v1' as const;

export const LOCAL_4GB_BUDGETS = Object.freeze({
  hardEnvelopeBytes: 4 * GIB,
  maximumPortableHostMemoryBytes: Math.floor(4.5 * GIB),
  minimumHostAvailableBytes: 256 * MIB,
  cgroupPeakBytes: Math.floor(3.5 * GIB),
  minimumCgroupHeadroomBytes: 256 * MIB,
  combinedProcessTreePeakBytes: Math.floor(1.5 * GIB),
  swapGrowthBytes: 64 * MIB,
  maximumSwapBytes: 64 * MIB,
  minimumSoakMs: 30 * 60 * 1_000,
  resourceSampleIntervalMs: RESOURCE_SAMPLE_INTERVAL_MS,
  maximumResourceSampleGapMs: MAX_RESOURCE_SAMPLE_GAP_MS,
  maximumEdgeSampleDelayMs: MAX_EDGE_SAMPLE_DELAY_MS,
  minimumResourceSampleCoverageRatio: 0.95,
  macosAppBudgetBytes: 4 * GIB,
  maximumModelArtifactBytes: MAX_MODEL_ARTIFACT_BYTES,
  maximumContextTokens: 3_072,
  maximumOutputTokens: 512,
  maximumBatchTokens: 256,
  maximumMicroBatchTokens: 64,
  maximumRamCacheMiB: 64,
});

export interface LocalFourGbArtifactPin {
  path: string;
  sha256: string;
}

export interface LocalFourGbDeploymentManifest {
  schema: typeof LOCAL_4GB_DEPLOYMENT_SCHEMA;
  evidenceMode: 'portable-4gb' | 'macos-app-budget';
  routeId: string;
  processId: number;
  endpoint: string;
  model: LocalFourGbArtifactPin;
  runtime: {
    implementation: string;
    version: string;
    binary: LocalFourGbArtifactPin;
    argv: string[];
  };
  deployment: {
    slots: number;
    maxConcurrentRequests: number;
    contextTokens: number;
    maxOutputTokens: number;
    offline: boolean;
    authenticated: boolean;
    ui: boolean;
    builtInAgent: boolean;
    builtInTools: boolean;
    continuousBatching: boolean;
  };
}

export interface LocalFourGbArtifactIdentity extends LocalFourGbArtifactPin {
  kind: 'model' | 'runtime';
  exists: boolean;
  regularFile: boolean;
  symbolicLink: boolean;
  executable?: boolean;
  bytes?: number;
  device?: string;
  inode?: string;
  linkCount?: number;
  mode?: string;
  modifiedNanoseconds?: string;
  changedNanoseconds?: string;
  resolvedViewPath?: string;
  observedSha256?: string;
  matched: boolean;
  detail: string;
}

export interface LocalFourGbProcessIdentity {
  platform: NodeJS.Platform;
  processId: number;
  alive: boolean;
  executableVerified: boolean;
  argvVerified: boolean;
  networkNamespaceVerified?: boolean;
  cgroupNamespaceVerified?: boolean;
  mountNamespaceSame?: boolean;
  runtimeObjectVerified?: boolean;
  modelMappingVerified?: boolean;
  listenerVerified?: boolean;
  environmentVerified?: boolean;
  authenticationVerified?: boolean;
  authenticationDetail?: string;
  targetNetworkNamespace?: string;
  evaluatorNetworkNamespace?: string;
  targetCgroupNamespace?: string;
  evaluatorCgroupNamespace?: string;
  targetMountNamespace?: string;
  evaluatorMountNamespace?: string;
  runtimeDevice?: string;
  runtimeInode?: string;
  modelDevice?: string;
  modelInode?: string;
  listenerSocketInode?: string;
  processStartTimeTicks?: string;
  cgroupMountPath?: string;
  measurementCgroupDevice?: string;
  measurementCgroupInode?: string;
  dangerousEnvironmentNames?: string[];
  verified: boolean;
  observedExecutable?: string;
  observedArgv?: string[];
  observedCommand?: string;
  targetCgroupPath?: string;
  evaluatorCgroupPath?: string;
  /** Closest cgroup-v2 ancestor that contains both the evaluator and model. */
  measurementCgroupPath?: string;
  sameCgroup: boolean;
  detail: string;
}

export interface LocalFourGbCgroupObservation {
  version: 'v2';
  path: string;
  evaluatorAndTargetCovered: boolean;
  device: string;
  inode: string;
  inodeStable: boolean;
  limitBytes: number | null;
  limitStable: boolean;
  kernelMemoryPeakBytes: number;
  memoryCurrentInitialBytes: number;
  memoryCurrentPeakBytes: number;
  memoryCurrentFinalBytes: number;
  swapInitialBytes: number;
  swapPeakBytes: number;
  swapFinalBytes: number;
  swapLimitBytes: number | null;
  swapLimitStable: boolean;
  kernelSwapPeakBytes: number;
}

export interface LocalFourGbResourceObservation {
  platform: NodeJS.Platform;
  architecture: string;
  hostTotalMemoryBytes: number;
  durationMs: number;
  sampleCount: number;
  initialSampleDelayMs: number;
  finalSampleAgeMs: number;
  maximumSampleGapMs: number;
  targetAliveEverySample: boolean;
  combinedProcessTreeRssInitialBytes: number;
  combinedProcessTreeRssPeakBytes: number;
  combinedProcessTreeRssFinalBytes: number;
  hostAvailableInitialBytes: number;
  hostAvailableMinimumBytes: number;
  hostAvailableFinalBytes: number;
  cgroup?: LocalFourGbCgroupObservation;
  telemetryError?: string;
}

export interface LocalFourGbAssertion {
  id: string;
  scope: 'common' | 'portable-4gb' | 'macos-app-budget';
  passed: boolean;
  actual: number | string | boolean | null;
  limit?: number;
  detail: string;
}

export interface LocalFourGbProbeResult {
  process: LocalFourGbProcessIdentity;
  resources: LocalFourGbResourceObservation | null;
  quality: ProjectAnalystEvalReport | null;
  qualityError?: string;
}

export interface LocalFourGbProbeContext {
  configPath: string;
  qualificationManifestPath: string;
  configSourceText: string;
  qualificationManifestSourceText: string;
  deploymentManifestSourceText: string;
  manifest: LocalFourGbDeploymentManifest;
  qualificationManifest: ApplianceQualificationManifest;
  artifacts: {
    model: LocalFourGbArtifactIdentity;
    runtime: LocalFourGbArtifactIdentity;
  };
  targetRootArtifacts?: {
    model: LocalFourGbArtifactIdentity;
    runtime: LocalFourGbArtifactIdentity;
  };
  route: ModelRouteConfig;
  soakMs: number;
  timeoutMs: number;
}

export type LocalFourGbProbe = (context: LocalFourGbProbeContext) => Promise<LocalFourGbProbeResult>;

export interface LocalFourGbEvalOptions {
  configPath: string;
  qualificationManifestPath: string;
  deploymentManifestPath: string;
  /** Linux defaults to the 30-minute certification soak; other platforms collect diagnostic evidence only. */
  soakMs?: number;
  timeoutMs?: number;
  /** Deterministic test seam. Any use blocks portable certification. */
  probe?: LocalFourGbProbe;
  /** Deterministic test seam. Any use blocks portable certification. */
  now?: () => Date;
}

export interface LocalFourGbEvalReport {
  schema: typeof LOCAL_4GB_REPORT_SCHEMA;
  generatedAt: string;
  overall: 'passed' | 'failed' | 'diagnostic';
  evaluatorBuild: {
    openProjectsVersion: typeof OPENPROJECTS_VERSION;
    contractVersion: typeof LOCAL_4GB_CONTRACT_VERSION;
    contractSha256: string;
  };
  budgets: typeof LOCAL_4GB_BUDGETS;
  sourceBindings: {
    configSha256: string;
    qualificationManifestSha256: string;
    deploymentManifestSha256: string;
    stableAfterObservation: boolean;
    blockers: string[];
  };
  candidate: {
    routeId: string;
    provider: string;
    model: string;
    endpoint: string;
    evidenceMode: LocalFourGbDeploymentManifest['evidenceMode'];
  };
  declaredDeployment: LocalFourGbDeploymentManifest['deployment'];
  identity: {
    model: LocalFourGbArtifactIdentity;
    runtime: LocalFourGbArtifactIdentity & {
      implementation: string;
      version: string;
      argv: string[];
      argvSha256: string;
    };
    targetRootArtifacts?: {
      model: LocalFourGbArtifactIdentity;
      runtime: LocalFourGbArtifactIdentity;
    };
    argvPostureVerified: boolean;
    argvPostureBlockers: string[];
    qualificationBindingVerified: boolean;
    qualificationBindingBlockers: string[];
    artifactsStableAfterObservation: boolean;
    artifactStabilityBlockers: string[];
    artifactsDistinct: boolean;
    artifactIdentityBlockers: string[];
    process: LocalFourGbProcessIdentity | null;
  };
  quality: ProjectAnalystEvalReport | null;
  resources: LocalFourGbResourceObservation | null;
  assertions: LocalFourGbAssertion[];
  gate: {
    qualityPassed: boolean;
    identityBound: boolean;
    posturePassed: boolean;
    promotionEligible: boolean;
    portableTrueFourGiB: {
      certified: boolean;
      blockers: string[];
    };
    macosAppBudget: {
      evidenceCollected: boolean;
      withinBudget: boolean;
      qualityCorrelated: boolean;
      certification: false;
    };
  };
  testSeamsUsed: {
    probe: boolean;
    clock: boolean;
    any: boolean;
  };
  posture: {
    standaloneEvaluator: true;
    alreadyRunningEndpointRequired: true;
    downloadsAttempted: false;
    processesStarted: false;
    processesStopped: false;
    promotionsAttempted: false;
    oneRoute: true;
    oneSlotDeclared: boolean;
    narrowReadOnlyAnalystLane: true;
  };
  error?: string;
  caveats: string[];
}

export interface LocalFourGbGateInput {
  manifest: LocalFourGbDeploymentManifest;
  artifacts: { model: LocalFourGbArtifactIdentity; runtime: LocalFourGbArtifactIdentity };
  targetRootArtifacts?: { model: LocalFourGbArtifactIdentity; runtime: LocalFourGbArtifactIdentity };
  argvPostureBlockers: string[];
  qualificationBindingBlockers?: string[];
  sourceStabilityBlockers?: string[];
  artifactStabilityBlockers?: string[];
  probe: LocalFourGbProbeResult;
  testSeamsUsed: boolean;
}

interface EvidenceSourceSnapshot {
  path: string;
  sourceText: string;
  sha256: string;
  bytes: number;
  device: string;
  inode: string;
  modifiedNanoseconds: string;
  changedNanoseconds: string;
  mode: string;
}

class EvidenceSourceLease {
  constructor(
    readonly label: string,
    readonly snapshot: EvidenceSourceSnapshot,
    private readonly handle: FileHandle,
  ) {}

  async verifyUnchanged(): Promise<string[]> {
    const blockers: string[] = [];
    try {
      const before = await this.handle.stat({ bigint: true });
      const bytes = await readBoundedHandle(this.handle, Number(before.size), this.label);
      const after = await this.handle.stat({ bigint: true });
      blockers.push(...compareSourceMetadata(this.snapshot, before, `${this.label} retained descriptor before rehash`));
      blockers.push(...compareSourceMetadata(this.snapshot, after, `${this.label} retained descriptor after rehash`));
      if (sha256Bytes(bytes) !== this.snapshot.sha256) blockers.push(`${this.label} retained descriptor hash changed`);
    } catch (cause) {
      blockers.push(`${this.label} retained descriptor could not be reverified: ${message(cause)}`);
    }

    let reopened: FileHandle | undefined;
    try {
      reopened = await open(
        this.snapshot.path,
        noFollowOpenFlags(),
      );
      const before = await reopened.stat({ bigint: true });
      const bytes = await readBoundedHandle(reopened, Number(before.size), this.label);
      const after = await reopened.stat({ bigint: true });
      blockers.push(...compareSourceMetadata(this.snapshot, before, `${this.label} pathname before rehash`));
      blockers.push(...compareSourceMetadata(this.snapshot, after, `${this.label} pathname after rehash`));
      if (sha256Bytes(bytes) !== this.snapshot.sha256) blockers.push(`${this.label} pathname hash changed`);
    } catch (cause) {
      blockers.push(`${this.label} pathname could not be reverified: ${message(cause)}`);
    } finally {
      await reopened?.close().catch(() => undefined);
    }
    return blockers;
  }

  close(): Promise<void> {
    return this.handle.close();
  }
}

async function openEvidenceSourceLease(path: string, label: string): Promise<EvidenceSourceLease> {
  const absolutePath = resolve(path);
  const canonicalPath = await realpath(absolutePath);
  if (canonicalPath !== absolutePath) throw new Error(`${label} path must be canonical without symlink components`);
  const handle = await open(absolutePath, noFollowOpenFlags());
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n) throw new Error(`${label} must be a singly linked regular file`);
    if (before.size < 1n || before.size > BigInt(MAX_MANIFEST_BYTES)) {
      throw new Error(`${label} must contain 1-${MAX_MANIFEST_BYTES} bytes`);
    }
    const bytes = await readBoundedHandle(handle, Number(before.size), label);
    const after = await handle.stat({ bigint: true });
    if (!sameBigIntStat(before, after)) throw new Error(`${label} changed while its source snapshot was read`);
    const pathname = await lstat(absolutePath, { bigint: true });
    if (!pathname.isFile() || pathname.isSymbolicLink() || pathname.dev !== before.dev || pathname.ino !== before.ino) {
      throw new Error(`${label} pathname changed while its source snapshot was read`);
    }
    let sourceText: string;
    try {
      sourceText = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new Error(`${label} must contain valid UTF-8`);
    }
    if (sourceText.includes('\0')) throw new Error(`${label} must not contain NUL bytes`);
    return new EvidenceSourceLease(label, Object.freeze({
      path: absolutePath,
      sourceText,
      sha256: sha256Bytes(bytes),
      bytes: bytes.length,
      device: before.dev.toString(),
      inode: before.ino.toString(),
      modifiedNanoseconds: before.mtimeNs.toString(),
      changedNanoseconds: before.ctimeNs.toString(),
      mode: before.mode.toString(),
    }), handle);
  } catch (cause) {
    await handle.close().catch(() => undefined);
    throw cause;
  }
}

async function readBoundedHandle(handle: FileHandle, size: number, label: string): Promise<Buffer> {
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_MANIFEST_BYTES) {
    throw new Error(`${label} changed outside its byte bound`);
  }
  const buffer = Buffer.allocUnsafe(size);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await handle.read(buffer, offset, size - offset, offset);
    if (bytesRead === 0) throw new Error(`${label} ended before its declared size`);
    offset += bytesRead;
  }
  return buffer;
}

function compareSourceMetadata(
  snapshot: EvidenceSourceSnapshot,
  value: Awaited<ReturnType<FileHandle['stat']>> & { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint; mode: bigint; nlink: bigint },
  label: string,
): string[] {
  const matched = value.isFile()
    && value.nlink === 1n
    && value.dev.toString() === snapshot.device
    && value.ino.toString() === snapshot.inode
    && value.size === BigInt(snapshot.bytes)
    && value.mtimeNs.toString() === snapshot.modifiedNanoseconds
    && value.ctimeNs.toString() === snapshot.changedNanoseconds
    && value.mode.toString() === snapshot.mode;
  return matched ? [] : [`${label} metadata changed`];
}

function sameBigIntStat(
  left: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint; mode: bigint; nlink: bigint },
  right: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint; mode: bigint; nlink: bigint },
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
    && left.mode === right.mode
    && left.nlink === right.nlink;
}

function artifactObjectDistinctnessBlockers(
  artifacts: { model: LocalFourGbArtifactIdentity; runtime: LocalFourGbArtifactIdentity },
  label: string,
): string[] {
  const modelDevice = artifacts.model.device;
  const modelInode = artifacts.model.inode;
  const runtimeDevice = artifacts.runtime.device;
  const runtimeInode = artifacts.runtime.inode;
  if (
    modelDevice === undefined
    || modelInode === undefined
    || runtimeDevice === undefined
    || runtimeInode === undefined
  ) {
    return [`${label} model/runtime device and inode identities were not both observed`];
  }
  return modelDevice === runtimeDevice && modelInode === runtimeInode
    ? [`${label} model and runtime resolve to the same device/inode ${modelDevice}:${modelInode}`]
    : [];
}

function artifactIdentityDistinctnessBlockers(
  manifest: LocalFourGbDeploymentManifest,
  artifacts: { model: LocalFourGbArtifactIdentity; runtime: LocalFourGbArtifactIdentity },
  targetRootArtifacts?: { model: LocalFourGbArtifactIdentity; runtime: LocalFourGbArtifactIdentity },
): string[] {
  const blockers = resolve(manifest.model.path) === resolve(manifest.runtime.binary.path)
    ? ['deployment model and runtime artifact paths must be distinct']
    : [];
  blockers.push(...artifactObjectDistinctnessBlockers(artifacts, 'evaluator-view'));
  if (targetRootArtifacts) {
    blockers.push(...artifactObjectDistinctnessBlockers(targetRootArtifacts, 'target-root'));
  }
  return blockers;
}

/**
 * Qualifies an explicitly provisioned, already-running local endpoint. This
 * function never installs, downloads, starts, stops, or promotes a runtime.
 */
export async function runLocalFourGbEval(options: LocalFourGbEvalOptions): Promise<LocalFourGbEvalReport> {
  const configPath = resolve(options.configPath);
  const qualificationManifestPath = resolve(options.qualificationManifestPath);
  const deploymentManifestPath = resolve(options.deploymentManifestPath);
  const sourceLeases: EvidenceSourceLease[] = [];
  const artifactLeases: ArtifactLease[] = [];
  try {
    const configLease = await openEvidenceSourceLease(configPath, 'configuration');
    sourceLeases.push(configLease);
    const qualificationLease = await openEvidenceSourceLease(qualificationManifestPath, 'qualification manifest');
    sourceLeases.push(qualificationLease);
    const deploymentLease = await openEvidenceSourceLease(deploymentManifestPath, 'deployment manifest');
    sourceLeases.push(deploymentLease);

    const config = loadConfig(configPath, {
      sourceText: configLease.snapshot.sourceText,
      loadEnv: false,
      applyProcessEnvOverrides: false,
    });
    const qualificationManifest = parseQualificationManifest(
      qualificationLease.snapshot.sourceText,
      qualificationManifestPath,
    );
    const manifest = parseLocalFourGbDeploymentManifest(
      deploymentLease.snapshot.sourceText,
      deploymentManifestPath,
    );
    const route = bindCandidate(config, manifest);
    const qualificationBindingBlockers = evaluateLocalFourGbQualificationBinding(
      qualificationManifest,
      manifest,
      route,
    );
    const [modelLease, runtimeLease] = await Promise.all([
      openArtifactLease(manifest.model, 'model'),
      openArtifactLease(manifest.runtime.binary, 'runtime'),
    ]);
    artifactLeases.push(modelLease, runtimeLease);
    const modelIdentity = modelLease.identity;
    const runtimeIdentity = runtimeLease.identity;
    let targetRootArtifacts: LocalFourGbProbeContext['targetRootArtifacts'];
    if (process.platform === 'linux' && options.probe === undefined) {
      const [targetModelLease, targetRuntimeLease] = await Promise.all([
        openArtifactLease(manifest.model, 'model', {
          label: 'target-root model',
          viewPath: `/proc/${manifest.processId}/root${manifest.model.path}`,
          requireCanonicalViewPath: false,
        }),
        openArtifactLease(manifest.runtime.binary, 'runtime', {
          label: 'target-root runtime',
          viewPath: `/proc/${manifest.processId}/root${manifest.runtime.binary.path}`,
          requireCanonicalViewPath: false,
        }),
      ]);
      artifactLeases.push(targetModelLease, targetRuntimeLease);
      targetRootArtifacts = {
        model: targetModelLease.identity,
        runtime: targetRuntimeLease.identity,
      };
    }
    const artifactIdentityBlockers = artifactIdentityDistinctnessBlockers(
      manifest,
      { model: modelIdentity, runtime: runtimeIdentity },
      targetRootArtifacts,
    );
    const argvPostureBlockers = evaluateLocalFourGbArgvPosture(manifest, route);
    const soakMs = boundedSoak(options.soakMs ?? (
      process.platform === 'linux' && manifest.evidenceMode === 'portable-4gb'
        ? LOCAL_4GB_BUDGETS.minimumSoakMs
        : 0
    ));
    const timeoutMs = boundedTimeout(options.timeoutMs ?? 300_000);
    const testSeamsUsed = {
      probe: options.probe !== undefined,
      clock: options.now !== undefined,
      any: options.probe !== undefined || options.now !== undefined,
    };
    let probe: LocalFourGbProbeResult = {
      process: unavailableProcessIdentity(manifest.processId, 'Live evidence was not collected'),
      resources: null,
      quality: null,
    };
    let error: string | undefined;

    const safeToProbe = modelIdentity.matched
      && runtimeIdentity.matched
      && (targetRootArtifacts === undefined
        || (targetRootArtifacts.model.matched && targetRootArtifacts.runtime.matched))
      && artifactIdentityBlockers.length === 0
      && argvPostureBlockers.length === 0
      && qualificationBindingBlockers.length === 0;
    if (safeToProbe) {
      try {
        probe = await (options.probe ?? runLiveProbe)({
          configPath,
          qualificationManifestPath,
          configSourceText: configLease.snapshot.sourceText,
          qualificationManifestSourceText: qualificationLease.snapshot.sourceText,
          deploymentManifestSourceText: deploymentLease.snapshot.sourceText,
          manifest,
          qualificationManifest,
          artifacts: { model: modelIdentity, runtime: runtimeIdentity },
          ...(targetRootArtifacts ? { targetRootArtifacts } : {}),
          route,
          soakMs,
          timeoutMs,
        });
      } catch (cause) {
        error = message(cause);
        probe = {
          process: unavailableProcessIdentity(manifest.processId, error),
          resources: null,
          quality: null,
          qualityError: error,
        };
      }
    } else {
      error = 'Live endpoint was not contacted because artifact identity, qualification binding, or reviewed argv posture failed';
    }

    const sourceStabilityBlockers = (await Promise.all(
      sourceLeases.map((lease) => lease.verifyUnchanged()),
    )).flat();
    const artifactStabilityBlockers = (await Promise.all(
      artifactLeases.map((lease) => lease.verifyUnchanged()),
    )).flat();
    if (
      probe.quality
      && (
        probe.quality.bindings.configSha256 !== configLease.snapshot.sha256
        || probe.quality.bindings.manifestSha256 !== qualificationLease.snapshot.sha256
        || probe.quality.bindings.deploymentSha256 !== deploymentLease.snapshot.sha256
      )
    ) {
      sourceStabilityBlockers.push('Project analyst report is not bound to the exact configuration, qualification, and deployment source hashes');
    }

    const assertions = evaluateLocalFourGbEvidence({
      manifest,
      artifacts: { model: modelIdentity, runtime: runtimeIdentity },
      ...(targetRootArtifacts ? { targetRootArtifacts } : {}),
      argvPostureBlockers,
      qualificationBindingBlockers,
      sourceStabilityBlockers,
      artifactStabilityBlockers,
      probe,
      testSeamsUsed: testSeamsUsed.any,
    });
    const commonPassed = assertions.filter((item) => item.scope === 'common').every((item) => item.passed);
    const portableAssertions = assertions.filter((item) => item.scope !== 'macos-app-budget');
    const certified = portableAssertions.every((item) => item.passed);
    const portableBlockers = portableAssertions.filter((item) => !item.passed).map((item) => item.id);
    const macAssertions = assertions.filter((item) => item.scope === 'macos-app-budget');
    const evidenceCollected = macAssertions.find((item) => item.id === 'macos_app_budget_observed')?.passed === true;
    const withinBudget = macAssertions.find((item) => item.id === 'macos_app_budget')?.passed === true;
    const qualityPassed = probe.quality?.passed === true;
    const identityBound = modelIdentity.matched
      && runtimeIdentity.matched
      && artifactIdentityBlockers.length === 0
      && probe.process.verified
      && qualificationBindingBlockers.length === 0
      && sourceStabilityBlockers.length === 0
      && artifactStabilityBlockers.length === 0;
    const posturePassed = argvPostureBlockers.length === 0 && qualificationBindingBlockers.length === 0;

    return {
      schema: LOCAL_4GB_REPORT_SCHEMA,
      generatedAt: (options.now?.() ?? new Date()).toISOString(),
      overall: certified ? 'passed' : commonPassed && qualityPassed ? 'diagnostic' : 'failed',
      evaluatorBuild: {
        openProjectsVersion: OPENPROJECTS_VERSION,
        contractVersion: LOCAL_4GB_CONTRACT_VERSION,
        contractSha256: localFourGbContractSha256(),
      },
      budgets: LOCAL_4GB_BUDGETS,
      sourceBindings: {
        configSha256: configLease.snapshot.sha256,
        qualificationManifestSha256: qualificationLease.snapshot.sha256,
        deploymentManifestSha256: deploymentLease.snapshot.sha256,
        stableAfterObservation: sourceStabilityBlockers.length === 0,
        blockers: sourceStabilityBlockers,
      },
      candidate: {
        routeId: route.id,
        provider: route.provider,
        model: route.model,
        endpoint: manifest.endpoint,
        evidenceMode: manifest.evidenceMode,
      },
      declaredDeployment: manifest.deployment,
      identity: {
        model: modelIdentity,
        runtime: {
          ...runtimeIdentity,
          implementation: manifest.runtime.implementation,
          version: manifest.runtime.version,
          argv: [...manifest.runtime.argv],
          argvSha256: digest(manifest.runtime.argv),
        },
        ...(targetRootArtifacts ? { targetRootArtifacts } : {}),
        argvPostureVerified: argvPostureBlockers.length === 0,
        argvPostureBlockers,
        qualificationBindingVerified: qualificationBindingBlockers.length === 0,
        qualificationBindingBlockers,
        artifactsStableAfterObservation: artifactStabilityBlockers.length === 0,
        artifactStabilityBlockers,
        artifactsDistinct: artifactIdentityBlockers.length === 0,
        artifactIdentityBlockers,
        process: probe.process,
      },
      quality: probe.quality,
      resources: probe.resources,
      assertions,
      gate: {
        qualityPassed,
        identityBound,
        posturePassed,
        promotionEligible: certified,
        portableTrueFourGiB: { certified, blockers: portableBlockers },
        macosAppBudget: {
          evidenceCollected,
          withinBudget,
          qualityCorrelated: evidenceCollected && qualityPassed,
          certification: false,
        },
      },
      testSeamsUsed,
      posture: {
        standaloneEvaluator: true,
        alreadyRunningEndpointRequired: true,
        downloadsAttempted: false,
        processesStarted: false,
        processesStopped: false,
        promotionsAttempted: false,
        oneRoute: true,
        oneSlotDeclared: manifest.deployment.slots === 1 && manifest.deployment.maxConcurrentRequests === 1,
        narrowReadOnlyAnalystLane: true,
      },
      ...(error || probe.qualityError ? { error: error ?? probe.qualityError } : {}),
      caveats: [
        'Portable 4 GiB certification requires a shared Linux cgroup namespace, a mountinfo-resolved cgroup v2 hierarchy, a finite identity-bound ancestor no larger than 4 GiB covering evaluator and model, and the complete 30-minute observation gate.',
        'macOS results are app-budget evidence on the observed Apple host, never proof that a 4 GiB Mac can run the workload.',
        'Linux binds namespace, executable inode, mapped model inode, exact listener ownership, environment posture, and exact argv to the live PID before and after observation.',
        'The quality corpus is the route-isolated project-analyst lane: one host-scoped read tool, no approvals, no external effects, and strict grounded JSON.',
        'No model, runtime, or artifact is downloaded or launched. Provision and supervise the endpoint separately, then pass its existing PID and reviewed manifests.',
        'Any injected clock or probe is recorded and blocks portable promotion.',
      ],
    };
  } finally {
    await Promise.all([
      ...sourceLeases.map((lease) => lease.close().catch(() => undefined)),
      ...artifactLeases.map((lease) => lease.close().catch(() => undefined)),
    ]);
  }
}

/** Pure gate evaluation used by tests, audit tooling, and report generation. */
export function evaluateLocalFourGbEvidence(input: LocalFourGbGateInput): LocalFourGbAssertion[] {
  const { manifest, artifacts, argvPostureBlockers, probe } = input;
  const qualificationBindingBlockers = input.qualificationBindingBlockers ?? [];
  const sourceStabilityBlockers = input.sourceStabilityBlockers ?? [];
  const artifactStabilityBlockers = input.artifactStabilityBlockers ?? [];
  const artifactIdentityBlockers = artifactIdentityDistinctnessBlockers(
    manifest,
    artifacts,
    input.targetRootArtifacts,
  );
  const resource = probe.resources;
  const cgroup = resource?.cgroup;
  const swapGrowth = cgroup
    ? Math.max(0, cgroup.swapPeakBytes - cgroup.swapInitialBytes, cgroup.swapFinalBytes - cgroup.swapInitialBytes)
    : null;
  const oneSlot = manifest.deployment.slots === 1 && manifest.deployment.maxConcurrentRequests === 1;
  const narrow = manifest.deployment.contextTokens <= LOCAL_4GB_BUDGETS.maximumContextTokens
    && manifest.deployment.maxOutputTokens <= LOCAL_4GB_BUDGETS.maximumOutputTokens;
  const sealed = manifest.deployment.offline
    && manifest.deployment.authenticated
    && !manifest.deployment.ui
    && !manifest.deployment.builtInAgent
    && !manifest.deployment.builtInTools
    && !manifest.deployment.continuousBatching;
  const expectedSampleCount = resource
    ? Math.floor(resource.durationMs / LOCAL_4GB_BUDGETS.resourceSampleIntervalMs) + 1
    : 0;
  const sampleCoverage = resource && expectedSampleCount > 0
    ? resource.sampleCount / expectedSampleCount
    : 0;
  return [
    assertion('model_artifact_identity', 'common', artifacts.model.matched, artifacts.model.observedSha256 ?? null, undefined, artifacts.model.detail),
    assertion('runtime_artifact_identity', 'common', artifacts.runtime.matched, artifacts.runtime.observedSha256 ?? null, undefined, artifacts.runtime.detail),
    assertion('artifact_identities_distinct', 'common', artifactIdentityBlockers.length === 0, artifactIdentityBlockers.length, 0, artifactIdentityBlockers.join('; ') || 'Model and runtime have distinct literal paths and device/inode identities'),
    assertion('route_pin_deployment_binding', 'common', qualificationBindingBlockers.length === 0, qualificationBindingBlockers.length, 0, qualificationBindingBlockers.join('; ') || 'Qualification route pin exactly matches the deployment'),
    assertion('source_snapshots_stable', 'common', sourceStabilityBlockers.length === 0, sourceStabilityBlockers.length, 0, sourceStabilityBlockers.join('; ') || 'All source leases remained byte- and inode-stable'),
    assertion('artifact_snapshots_stable', 'common', artifactStabilityBlockers.length === 0, artifactStabilityBlockers.length, 0, artifactStabilityBlockers.join('; ') || 'Model and runtime remained byte- and inode-stable'),
    assertion('reviewed_argv_posture', 'common', argvPostureBlockers.length === 0, argvPostureBlockers.length, 0, argvPostureBlockers.join('; ') || 'Exact argv proves the reviewed bounded posture'),
    assertion('one_slot', 'common', oneSlot, `${manifest.deployment.slots}/${manifest.deployment.maxConcurrentRequests}`, undefined, 'slots/maxConcurrentRequests must both equal 1'),
    assertion('narrow_context', 'common', narrow, manifest.deployment.contextTokens, LOCAL_4GB_BUDGETS.maximumContextTokens, `maxOutputTokens=${manifest.deployment.maxOutputTokens}`),
    assertion('sealed_runtime', 'common', sealed, sealed, undefined, 'offline, authenticated, no UI/agent/tools, and no continuous batching are required'),
    assertion('process_identity', 'portable-4gb', probe.process.verified, probe.process.verified, undefined, probe.process.detail),
    assertion('network_namespace', 'portable-4gb', probe.process.networkNamespaceVerified === true, probe.process.networkNamespaceVerified ?? false, undefined, 'Evaluator and target must share the exact network namespace'),
    assertion('cgroup_namespace', 'portable-4gb', probe.process.cgroupNamespaceVerified === true, probe.process.cgroupNamespaceVerified ?? false, undefined, 'Evaluator and target must share the exact cgroup namespace so membership paths address the same hierarchy'),
    assertion('runtime_dev_inode', 'portable-4gb', probe.process.runtimeObjectVerified === true, probe.process.runtimeObjectVerified ?? false, undefined, 'Live executable must be the reviewed runtime device/inode'),
    assertion('model_mapping_identity', 'portable-4gb', probe.process.modelMappingVerified === true, probe.process.modelMappingVerified ?? false, undefined, 'The complete reviewed model must be mapped by the exact target PID'),
    assertion('loopback_listener_owned', 'portable-4gb', probe.process.listenerVerified === true, probe.process.listenerVerified ?? false, undefined, 'The target PID must own exactly the declared loopback listener and no additional TCP listeners'),
    assertion('environment_sealed', 'portable-4gb', probe.process.environmentVerified === true, probe.process.dangerousEnvironmentNames?.length ?? null, 0, 'Dangerous LLAMA/HF/proxy/GPU/loader environment overrides must be absent'),
    assertion('authentication_enforced', 'portable-4gb', probe.process.authenticationVerified === true, probe.process.authenticationVerified ?? false, undefined, probe.process.authenticationDetail ?? 'Unauthenticated and fixed-wrong-Bearer requests must both be rejected with HTTP 401 or 403'),
    assertion('project_analyst_quality', 'common', probe.quality?.passed === true, probe.quality?.passRate ?? 0, 1, probe.qualityError ?? 'All compact project-analyst cases must pass'),
    assertion('production_evidence', 'portable-4gb', !input.testSeamsUsed, input.testSeamsUsed, undefined, 'Injected probes or clocks are diagnostic only'),
    assertion('portable_evidence_mode', 'portable-4gb', manifest.evidenceMode === 'portable-4gb', manifest.evidenceMode, undefined, 'Portable certification requires an explicit portable-4gb deployment manifest'),
    assertion('linux_platform', 'portable-4gb', resource?.platform === 'linux', resource?.platform ?? platform(), undefined, 'Portable certification currently requires observable Linux cgroup v2 telemetry'),
    assertion('portable_host_memory', 'portable-4gb', (resource?.hostTotalMemoryBytes ?? Number.POSITIVE_INFINITY) <= LOCAL_4GB_BUDGETS.maximumPortableHostMemoryBytes, resource?.hostTotalMemoryBytes ?? null, LOCAL_4GB_BUDGETS.maximumPortableHostMemoryBytes, 'Portable true-4GB evidence requires an observed host with no more than 4.5 GiB total memory'),
    assertion('host_available_headroom', 'portable-4gb', (resource?.hostAvailableMinimumBytes ?? 0) >= LOCAL_4GB_BUDGETS.minimumHostAvailableBytes, resource?.hostAvailableMinimumBytes ?? null, LOCAL_4GB_BUDGETS.minimumHostAvailableBytes, 'Observed host available memory must remain at or above 256 MiB throughout the soak'),
    assertion('cgroup_v2_observed', 'portable-4gb', cgroup !== undefined, cgroup?.version ?? 'unobserved', undefined, 'memory.current, memory.max, and memory.swap.current must be readable'),
    assertion('shared_cgroup_envelope', 'portable-4gb', cgroup?.evaluatorAndTargetCovered === true, cgroup?.evaluatorAndTargetCovered ?? false, undefined, 'The measured cgroup must be a stable shared ancestor covering evaluator/OpenProjects and model PID'),
    assertion('telemetry_complete', 'portable-4gb', resource !== null && !resource.telemetryError, resource?.telemetryError ?? false, undefined, 'Any telemetry read, parse, or stability error blocks certification'),
    assertion('cgroup_inode_stable', 'portable-4gb', cgroup?.inodeStable === true, cgroup?.inodeStable ?? false, undefined, 'The measured cgroup device/inode must remain stable'),
    assertion('cgroup_limits_stable', 'portable-4gb', cgroup?.limitStable === true && cgroup.swapLimitStable === true, cgroup ? `${cgroup.limitStable}/${cgroup.swapLimitStable}` : false, undefined, 'memory.max and memory.swap.max must remain stable'),
    assertion(
      'four_gib_hard_limit',
      'portable-4gb',
      cgroup?.limitBytes !== null && cgroup?.limitBytes !== undefined && cgroup.limitBytes <= LOCAL_4GB_BUDGETS.hardEnvelopeBytes,
      cgroup?.limitBytes ?? null,
      LOCAL_4GB_BUDGETS.hardEnvelopeBytes,
      'A finite cgroup memory.max no larger than 4 GiB is required',
    ),
    assertion('minimum_soak', 'portable-4gb', (resource?.durationMs ?? 0) >= LOCAL_4GB_BUDGETS.minimumSoakMs, resource?.durationMs ?? 0, LOCAL_4GB_BUDGETS.minimumSoakMs, 'Resource observation must span at least 30 minutes'),
    assertion('target_liveness', 'portable-4gb', resource?.targetAliveEverySample === true, resource?.targetAliveEverySample ?? false, undefined, 'The exact target PID must remain alive for every resource sample'),
    assertion('cgroup_peak', 'portable-4gb', (cgroup?.kernelMemoryPeakBytes ?? Number.POSITIVE_INFINITY) <= LOCAL_4GB_BUDGETS.cgroupPeakBytes, cgroup?.kernelMemoryPeakBytes ?? null, LOCAL_4GB_BUDGETS.cgroupPeakBytes, 'Kernel memory.peak for the measured cgroup must stay at or below 3.5 GiB'),
    assertion(
      'cgroup_headroom',
      'portable-4gb',
      cgroup?.limitBytes !== null && cgroup?.limitBytes !== undefined
        && cgroup.limitBytes - cgroup.kernelMemoryPeakBytes >= LOCAL_4GB_BUDGETS.minimumCgroupHeadroomBytes,
      cgroup?.limitBytes === null || cgroup?.limitBytes === undefined ? null : cgroup.limitBytes - cgroup.kernelMemoryPeakBytes,
      LOCAL_4GB_BUDGETS.minimumCgroupHeadroomBytes,
      'Measured cgroup must retain at least 256 MiB at peak',
    ),
    assertion('combined_process_tree_peak', 'portable-4gb', (resource?.combinedProcessTreeRssPeakBytes ?? Number.POSITIVE_INFINITY) <= LOCAL_4GB_BUDGETS.combinedProcessTreePeakBytes, resource?.combinedProcessTreeRssPeakBytes ?? null, LOCAL_4GB_BUDGETS.combinedProcessTreePeakBytes, 'Evaluator/OpenProjects plus model process trees must stay within 1.5 GiB RSS'),
    assertion('swap_growth', 'portable-4gb', swapGrowth !== null && swapGrowth <= LOCAL_4GB_BUDGETS.swapGrowthBytes, swapGrowth, LOCAL_4GB_BUDGETS.swapGrowthBytes, 'Observed cgroup swap growth must stay within 64 MiB'),
    assertion('swap_hard_limit', 'portable-4gb', cgroup?.swapLimitBytes !== null && cgroup?.swapLimitBytes !== undefined && cgroup.swapLimitBytes <= LOCAL_4GB_BUDGETS.maximumSwapBytes, cgroup?.swapLimitBytes ?? null, LOCAL_4GB_BUDGETS.maximumSwapBytes, 'memory.swap.max must be finite and no larger than 64 MiB'),
    assertion('kernel_swap_peak', 'portable-4gb', (cgroup?.kernelSwapPeakBytes ?? Number.POSITIVE_INFINITY) <= LOCAL_4GB_BUDGETS.maximumSwapBytes, cgroup?.kernelSwapPeakBytes ?? null, LOCAL_4GB_BUDGETS.maximumSwapBytes, 'Absolute kernel memory.swap.peak must stay within 64 MiB'),
    assertion('telemetry_cadence', 'portable-4gb', resource !== null && resource.initialSampleDelayMs <= LOCAL_4GB_BUDGETS.maximumEdgeSampleDelayMs && resource.finalSampleAgeMs <= LOCAL_4GB_BUDGETS.maximumEdgeSampleDelayMs && resource.maximumSampleGapMs <= LOCAL_4GB_BUDGETS.maximumResourceSampleGapMs, resource?.maximumSampleGapMs ?? null, LOCAL_4GB_BUDGETS.maximumResourceSampleGapMs, 'Initial/final sample delay and maximum cadence gap must remain bounded'),
    assertion('telemetry_sample_coverage', 'portable-4gb', sampleCoverage >= LOCAL_4GB_BUDGETS.minimumResourceSampleCoverageRatio, sampleCoverage, LOCAL_4GB_BUDGETS.minimumResourceSampleCoverageRatio, 'At least 95% of the absolute 500 ms sampling schedule must be observed'),
    assertion('macos_app_budget_observed', 'macos-app-budget', manifest.evidenceMode === 'macos-app-budget' && resource?.platform === 'darwin' && resource.sampleCount > 0, resource?.platform ?? platform(), undefined, 'macOS app-budget evidence requires macos-app-budget mode and live Darwin process-tree samples'),
    assertion('macos_app_budget', 'macos-app-budget', manifest.evidenceMode === 'macos-app-budget' && resource?.platform === 'darwin' && resource.combinedProcessTreeRssPeakBytes <= LOCAL_4GB_BUDGETS.macosAppBudgetBytes, resource?.combinedProcessTreeRssPeakBytes ?? null, LOCAL_4GB_BUDGETS.macosAppBudgetBytes, 'This is an app budget on an observed Mac, not a 4 GiB machine certification'),
  ];
}

export async function loadLocalFourGbDeploymentManifest(path: string): Promise<LocalFourGbDeploymentManifest> {
  const absolutePath = resolve(path);
  const info = await lstat(absolutePath);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error('Local 4 GB deployment manifest must be a regular non-symlink file');
  }
  if (info.size > MAX_MANIFEST_BYTES) throw new Error(`Local 4 GB deployment manifest exceeds ${MAX_MANIFEST_BYTES} bytes`);
  return parseLocalFourGbDeploymentManifest(await readFile(absolutePath, 'utf8'), absolutePath);
}

export function parseLocalFourGbDeploymentManifest(
  source: string,
  path = 'local-4gb-deployment.json',
): LocalFourGbDeploymentManifest {
  const duplicateCheck = YAML.parseDocument(source, { uniqueKeys: true });
  if (duplicateCheck.errors.length > 0) {
    throw new Error(`Local 4 GB deployment manifest contains invalid or duplicate keys: ${duplicateCheck.errors[0]!.message}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch (cause) {
    throw new Error(`Local 4 GB deployment manifest is not valid JSON: ${message(cause)}`);
  }
  const root = exactObject(value, 'manifest', [
    'schema', 'evidenceMode', 'routeId', 'processId', 'endpoint', 'model', 'runtime', 'deployment',
  ]);
  if (root.schema !== LOCAL_4GB_DEPLOYMENT_SCHEMA) throw new Error(`Local 4 GB deployment manifest schema must be ${LOCAL_4GB_DEPLOYMENT_SCHEMA}`);
  if (root.evidenceMode !== 'portable-4gb' && root.evidenceMode !== 'macos-app-budget') {
    throw new Error('Local 4 GB evidenceMode must be portable-4gb or macos-app-budget');
  }
  const directory = dirname(resolve(path));
  const model = artifactPin(root.model, 'model', directory);
  const runtime = exactObject(root.runtime, 'runtime', ['implementation', 'version', 'binary', 'argv']);
  const runtimeBinary = artifactPin(runtime.binary, 'runtime.binary', directory);
  if (model.path === runtimeBinary.path) {
    throw new Error('Local 4 GB deployment model and runtime artifact paths must be distinct');
  }
  const argv = stringArray(runtime.argv, 'runtime.argv');
  if (argv.length < 1 || argv.length > MAX_ARG_COUNT) throw new Error(`runtime.argv must contain 1 to ${MAX_ARG_COUNT} entries`);
  const deployment = exactObject(root.deployment, 'deployment', [
    'slots', 'maxConcurrentRequests', 'contextTokens', 'maxOutputTokens', 'offline', 'authenticated',
    'ui', 'builtInAgent', 'builtInTools', 'continuousBatching',
  ]);
  return {
    schema: LOCAL_4GB_DEPLOYMENT_SCHEMA,
    evidenceMode: root.evidenceMode,
    routeId: boundedString(root.routeId, 'routeId', 128),
    processId: boundedInteger(root.processId, 'processId', 1, 2 ** 31 - 1),
    endpoint: validatedEndpoint(root.endpoint),
    model,
    runtime: {
      implementation: boundedString(runtime.implementation, 'runtime.implementation', 128),
      version: boundedString(runtime.version, 'runtime.version', 256),
      binary: runtimeBinary,
      argv,
    },
    deployment: {
      slots: boundedInteger(deployment.slots, 'deployment.slots', 1, 64),
      maxConcurrentRequests: boundedInteger(deployment.maxConcurrentRequests, 'deployment.maxConcurrentRequests', 1, 64),
      contextTokens: boundedInteger(deployment.contextTokens, 'deployment.contextTokens', 512, 1_048_576),
      maxOutputTokens: boundedInteger(deployment.maxOutputTokens, 'deployment.maxOutputTokens', 1, 65_536),
      offline: booleanValue(deployment.offline, 'deployment.offline'),
      authenticated: booleanValue(deployment.authenticated, 'deployment.authenticated'),
      ui: booleanValue(deployment.ui, 'deployment.ui'),
      builtInAgent: booleanValue(deployment.builtInAgent, 'deployment.builtInAgent'),
      builtInTools: booleanValue(deployment.builtInTools, 'deployment.builtInTools'),
      continuousBatching: booleanValue(deployment.continuousBatching, 'deployment.continuousBatching'),
    },
  };
}

export function localFourGbContractSha256(): string {
  return digest({
    schema: LOCAL_4GB_REPORT_SCHEMA,
    contract: LOCAL_4GB_CONTRACT_VERSION,
    deploymentSchema: LOCAL_4GB_DEPLOYMENT_SCHEMA,
    budgets: LOCAL_4GB_BUDGETS,
    packagedArgv: {
      exactArgumentCount: 53,
      booleans: REQUIRED_LLAMA_CPP_BOOLEAN_FLAGS,
      scalars: REQUIRED_LLAMA_CPP_VALUE_FLAGS,
      scalarValues: {
        model: 'deployment.model.path',
        alias: 'route.model',
        host: 'endpoint.numeric-loopback-host',
        port: 'endpoint.explicit-port',
        apiKeyFile: 'absolute-path',
        parallel: '1',
        ctxSize: 'deployment.contextTokens',
        batchSize: '256',
        microBatchSize: '64',
        cacheTypeK: 'f16',
        cacheTypeV: 'f16',
        cacheRam: '64',
        contextCheckpoints: '2',
        reasoning: 'off',
        nPredict: 'deployment.maxOutputTokens',
        loadMode: 'mmap',
        fit: 'off',
        httpThreads: '1',
        timeoutSeconds: '60',
        ssePingInterval: '-1',
        device: 'none',
        gpuLayers: '0',
      },
      aliasesUnknownsEqualsAndDuplicates: 'rejected',
      cpuOnly: { device: 'none', gpuLayers: '0' },
    },
    dangerousEnvironmentPattern: {
      source: DANGEROUS_ENVIRONMENT_NAME.source,
      flags: DANGEROUS_ENVIRONMENT_NAME.flags,
    },
    routeIsolation: 'exactly one enabled route total; provider and runtime implementation both exactly llama.cpp',
    immutableEvidence: 'retained O_NOFOLLOW evaluator-view and target-root model/runtime FDs plus pathname reopen; exact dev+inode+size+hash+nlink+mode+mtime+ctime continuity; model/runtime literal paths and device/inode identities must be distinct',
    qualificationBinding: 'exact route provider/model/model artifact/runtime artifact/runtime implementation+version/context/concurrency',
    linuxProcessBinding: 'stable PID start time, network+cgroup namespaces, target-root artifact hashes, executable/model dev+inode, sole namespace-wide listener tuple owned before+after by target PID, sealed environment',
    authenticationProbe: {
      timing: 'before+after quality',
      method: 'GET',
      path: '/v1/models',
      credentials: ['none', 'fixed-wrong-bearer'],
      acceptedStatuses: [401, 403],
      timeoutMs: AUTHENTICATION_PROBE_TIMEOUT_MS,
      responseBody: 'destroyed-without-retention',
    },
    linuxEnvelope: 'mountinfo-resolved CGROUP2_SUPER_MAGIC hierarchy, identity-bound stable shared ancestor inode, finite stable memory+swap limits, kernel memory+swap peaks, absolute 500ms schedule with 95% coverage',
    portableHost: 'Linux host total memory <=4.5GiB and minimum available memory >=256MiB throughout observation',
    qualityContract: 'openprojects.project-analyst.v1 exact source-byte bindings',
    testSeams: 'diagnostic-only',
  });
}

async function runLiveProbe(context: LocalFourGbProbeContext): Promise<LocalFourGbProbeResult> {
  if (process.platform === 'linux' && !context.targetRootArtifacts) {
    throw new Error('Linux live qualification requires retained target-root artifact leases');
  }
  const initialObservedIdentity = await inspectProcessIdentity(
    context.manifest,
    context.artifacts,
    context.targetRootArtifacts,
  );
  if (process.platform === 'linux' && !initialObservedIdentity.verified) {
    return { process: initialObservedIdentity, resources: null, quality: null, qualityError: 'Linux live process identity did not match the reviewed manifest' };
  }
  const initialIdentity = process.platform === 'linux'
    ? bindAuthenticationEvidence(initialObservedIdentity, await inspectEndpointAuthentication(context.manifest.endpoint))
    : initialObservedIdentity;
  if (process.platform === 'linux' && !initialIdentity.verified) {
    return { process: initialIdentity, resources: null, quality: null, qualityError: 'The PID-bound endpoint did not reject unauthenticated access' };
  }
  const qualityOperation = () => runProjectAnalystEval({
    configPath: context.configPath,
    manifestPath: context.qualificationManifestPath,
    configSourceText: context.configSourceText,
    manifestSourceText: context.qualificationManifestSourceText,
    deploymentSourceText: context.deploymentManifestSourceText,
    routeId: context.route.id,
    attempts: 3,
    timeoutMs: context.timeoutMs,
  });
  const soakMs = await effectiveCertificationSoak(context, initialIdentity);
  const monitored = await monitorQualityOperation(context.manifest.processId, initialIdentity, soakMs, qualityOperation);
  const finalObservedIdentity = await inspectProcessIdentity(
    context.manifest,
    context.artifacts,
    context.targetRootArtifacts,
  );
  const finalIdentity = process.platform === 'linux' && finalObservedIdentity.verified
    ? bindAuthenticationEvidence(finalObservedIdentity, await inspectEndpointAuthentication(context.manifest.endpoint))
    : finalObservedIdentity;
  const processIdentity = combineProcessIdentity(initialIdentity, finalIdentity);
  return {
    process: processIdentity,
    resources: monitored.resources,
    quality: monitored.quality,
    ...(monitored.qualityError ? { qualityError: monitored.qualityError } : {}),
  };
}

interface AuthenticationEvidence {
  verified: boolean;
  unauthenticatedStatus: number | null;
  wrongBearerStatus: number | null;
  detail: string;
}

function bindAuthenticationEvidence(
  identity: LocalFourGbProcessIdentity,
  evidence: AuthenticationEvidence,
): LocalFourGbProcessIdentity {
  return {
    ...identity,
    authenticationVerified: evidence.verified,
    authenticationDetail: evidence.detail,
    verified: identity.verified && evidence.verified,
    detail: `${identity.detail}; ${evidence.detail}`,
  };
}

async function inspectEndpointAuthentication(endpointSource: string): Promise<AuthenticationEvidence> {
  const endpoint = new URL(endpointSource);
  endpoint.pathname = `${endpoint.pathname.replace(/\/$/u, '')}/models`;
  let unauthenticatedStatus: number | null = null;
  let wrongBearerStatus: number | null = null;
  try {
    unauthenticatedStatus = await negativeAuthenticationRequest(endpoint, undefined);
    wrongBearerStatus = await negativeAuthenticationRequest(
      endpoint,
      'Bearer openprojects-local-4gb-deliberately-wrong',
    );
    const rejected = (status: number | null): boolean => status === 401 || status === 403;
    const verified = rejected(unauthenticatedStatus) && rejected(wrongBearerStatus);
    return {
      verified,
      unauthenticatedStatus,
      wrongBearerStatus,
      detail: verified
        ? `Unauthenticated and wrong-Bearer requests were rejected (${unauthenticatedStatus}/${wrongBearerStatus})`
        : `Authentication rejection failed: unauthenticated=${unauthenticatedStatus}, wrongBearer=${wrongBearerStatus}`,
    };
  } catch (cause) {
    return {
      verified: false,
      unauthenticatedStatus,
      wrongBearerStatus,
      detail: `Authentication rejection could not be observed: ${message(cause)}`,
    };
  }
}

function negativeAuthenticationRequest(endpoint: URL, authorization: string | undefined): Promise<number> {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let deadline: ReturnType<typeof globalThis.setTimeout> | undefined;
    const finish = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      if (deadline !== undefined) globalThis.clearTimeout(deadline);
      operation();
    };
    const request = httpRequest(endpoint, {
      method: 'GET',
      agent: false,
      maxHeaderSize: 16 * 1024,
      headers: {
        accept: 'application/json',
        connection: 'close',
        ...(authorization ? { authorization } : {}),
      },
    }, (response) => {
      const status = response.statusCode;
      response.destroy();
      if (status === undefined) {
        finish(() => rejectPromise(new Error('Authentication probe response omitted an HTTP status')));
      } else {
        finish(() => resolvePromise(status));
      }
    });
    deadline = globalThis.setTimeout(() => {
      request.destroy(new Error(`Authentication probe exceeded ${AUTHENTICATION_PROBE_TIMEOUT_MS} ms`));
    }, AUTHENTICATION_PROBE_TIMEOUT_MS);
    request.once('error', (cause) => finish(() => rejectPromise(cause)));
    request.end();
  });
}

async function effectiveCertificationSoak(
  context: LocalFourGbProbeContext,
  identity: LocalFourGbProcessIdentity,
): Promise<number> {
  if (
    process.platform !== 'linux'
    || context.manifest.evidenceMode !== 'portable-4gb'
    || !identity.measurementCgroupPath
    || !identity.cgroupMountPath
  ) return 0;
  try {
    const directory = cgroupDirectory(identity.measurementCgroupPath, identity.cgroupMountPath);
    await verifyCgroup2Directory(directory);
    const before = await stat(directory, { bigint: true });
    const [limit, swapLimit] = await Promise.all([
      readCgroupNumber(`${directory}/memory.max`, true),
      readCgroupNumber(`${directory}/memory.swap.max`, true),
    ]);
    const after = await stat(directory, { bigint: true });
    const stable = before.dev === after.dev
      && before.ino === after.ino
      && before.dev.toString() === identity.measurementCgroupDevice
      && before.ino.toString() === identity.measurementCgroupInode;
    return stable
      && limit !== null
      && limit <= LOCAL_4GB_BUDGETS.hardEnvelopeBytes
      && swapLimit !== null
      && swapLimit <= LOCAL_4GB_BUDGETS.maximumSwapBytes
      ? context.soakMs
      : 0;
  } catch {
    return 0;
  }
}

async function monitorQualityOperation(
  targetPid: number,
  identity: LocalFourGbProcessIdentity,
  soakMs: number,
  operation: () => Promise<ProjectAnalystEvalReport>,
): Promise<{ resources: LocalFourGbResourceObservation | null; quality: ProjectAnalystEvalReport | null; qualityError?: string }> {
  const startedAt = performance.now();
  let quality: ProjectAnalystEvalReport | null = null;
  let qualityError: string | undefined;
  let settled = false;
  const qualityPromise = operation().then((result) => {
    quality = result;
    settled = true;
  }).catch((cause: unknown) => {
    qualityError = message(cause);
    settled = true;
  });
  const samples: RuntimeSample[] = [];
  let telemetryError: string | undefined;
  let nextSampleAt = startedAt;
  while (!settled || performance.now() - startedAt < soakMs) {
    try {
      samples.push(await sampleRuntime(targetPid, identity, startedAt));
    } catch (cause) {
      telemetryError ??= message(cause);
    }
    const remainingSoak = Math.max(0, soakMs - (performance.now() - startedAt));
    if (settled && remainingSoak === 0) break;
    nextSampleAt += RESOURCE_SAMPLE_INTERVAL_MS;
    const untilNextSample = Math.max(0, nextSampleAt - performance.now());
    await delay(Math.min(untilNextSample, remainingSoak || untilNextSample));
  }
  await qualityPromise;
  try {
    samples.push(await sampleRuntime(targetPid, identity, startedAt));
  } catch (cause) {
    telemetryError ??= message(cause);
  }
  const finishedAtMs = performance.now() - startedAt;
  const resources = samples.length > 0
    ? aggregateSamples(samples, finishedAtMs, identity, telemetryError)
    : unavailableResourceObservation(finishedAtMs, telemetryError ?? 'No complete telemetry sample was collected');
  return { resources, quality, ...(qualityError ? { qualityError } : {}) };
}

function unavailableResourceObservation(durationMs: number, telemetryError: string): LocalFourGbResourceObservation {
  return {
    platform: platform(),
    architecture: arch(),
    hostTotalMemoryBytes: totalmem(),
    durationMs: Math.round(durationMs),
    sampleCount: 0,
    initialSampleDelayMs: Math.round(durationMs),
    finalSampleAgeMs: Math.round(durationMs),
    maximumSampleGapMs: Math.round(durationMs),
    targetAliveEverySample: false,
    combinedProcessTreeRssInitialBytes: 0,
    combinedProcessTreeRssPeakBytes: 0,
    combinedProcessTreeRssFinalBytes: 0,
    hostAvailableInitialBytes: 0,
    hostAvailableMinimumBytes: 0,
    hostAvailableFinalBytes: 0,
    telemetryError,
  };
}

interface RuntimeSample {
  atMs: number;
  processTreeRssBytes: number;
  hostAvailableBytes: number;
  targetAlive: boolean;
  cgroup?: {
    device: string;
    inode: string;
    limitBytes: number | null;
    memoryCurrentBytes: number;
    memoryPeakBytes: number;
    swapCurrentBytes: number;
    swapLimitBytes: number | null;
    swapPeakBytes: number;
    covered: boolean;
  };
}

async function sampleRuntime(
  targetPid: number,
  identity: LocalFourGbProcessIdentity,
  startedAt: number,
): Promise<RuntimeSample> {
  if (process.platform === 'linux') {
    await verifyLightweightProcessIdentity(targetPid, identity);
  }
  const processTreeRssBytes = process.platform === 'linux'
    ? await linuxProcessTreeRss([process.pid, targetPid])
    : process.platform === 'darwin'
      ? await darwinProcessTreeRss([process.pid, targetPid])
      : process.memoryUsage().rss;
  const sample: RuntimeSample = {
    atMs: performance.now() - startedAt,
    processTreeRssBytes,
    hostAvailableBytes: freemem(),
    targetAlive: processIsAlive(targetPid),
  };
  if (process.platform === 'linux' && identity.measurementCgroupPath && identity.cgroupMountPath) {
    const directory = cgroupDirectory(identity.measurementCgroupPath, identity.cgroupMountPath);
    await verifyCgroup2Directory(directory);
    const before = await stat(directory, { bigint: true });
    if (
      before.dev.toString() !== identity.measurementCgroupDevice
      || before.ino.toString() !== identity.measurementCgroupInode
    ) {
      throw new Error('Measured cgroup does not match the identity-bound device/inode');
    }
    const [limit, current, peak, swap, swapLimit, swapPeak, targetPath, evaluatorPath] = await Promise.all([
      readCgroupNumber(`${directory}/memory.max`, true),
      readCgroupNumber(`${directory}/memory.current`, false),
      readCgroupNumber(`${directory}/memory.peak`, false),
      readCgroupNumber(`${directory}/memory.swap.current`, false),
      readCgroupNumber(`${directory}/memory.swap.max`, true),
      readCgroupNumber(`${directory}/memory.swap.peak`, false),
      readProcessCgroup(targetPid),
      readProcessCgroup(process.pid),
    ]);
    const after = await stat(directory, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino) {
      throw new Error('Measured cgroup device/inode changed during a telemetry sample');
    }
    sample.cgroup = {
      device: before.dev.toString(),
      inode: before.ino.toString(),
      limitBytes: limit,
      memoryCurrentBytes: current!,
      memoryPeakBytes: peak!,
      swapCurrentBytes: swap!,
      swapLimitBytes: swapLimit,
      swapPeakBytes: swapPeak!,
      covered: targetPath === identity.targetCgroupPath
        && evaluatorPath === identity.evaluatorCgroupPath
        && closestCommonCgroup(targetPath, evaluatorPath) === identity.measurementCgroupPath,
    };
  }
  sample.atMs = performance.now() - startedAt;
  return sample;
}

async function verifyLightweightProcessIdentity(
  pid: number,
  identity: LocalFourGbProcessIdentity,
): Promise<void> {
  const [startTime, executable, targetNetworkNamespace, evaluatorNetworkNamespace, targetCgroupNamespace, evaluatorCgroupNamespace, targetMountNamespace, evaluatorMountNamespace] = await Promise.all([
    readProcessStartTimeTicks(pid),
    stat(`/proc/${pid}/exe`, { bigint: true }),
    namespaceIdentity(`/proc/${pid}/ns/net`),
    namespaceIdentity(`/proc/${process.pid}/ns/net`),
    namespaceIdentity(`/proc/${pid}/ns/cgroup`),
    namespaceIdentity(`/proc/${process.pid}/ns/cgroup`),
    namespaceIdentity(`/proc/${pid}/ns/mnt`),
    namespaceIdentity(`/proc/${process.pid}/ns/mnt`),
  ]);
  const stable = identity.processStartTimeTicks === startTime
    && identity.runtimeDevice === executable.dev.toString()
    && identity.runtimeInode === executable.ino.toString()
    && identity.targetNetworkNamespace === targetNetworkNamespace
    && identity.evaluatorNetworkNamespace === evaluatorNetworkNamespace
    && identity.targetCgroupNamespace === targetCgroupNamespace
    && identity.evaluatorCgroupNamespace === evaluatorCgroupNamespace
    && identity.targetMountNamespace === targetMountNamespace
    && identity.evaluatorMountNamespace === evaluatorMountNamespace;
  if (!stable) throw new Error('Target PID, executable, or namespace identity changed during resource observation');
}

function aggregateSamples(
  samples: RuntimeSample[],
  durationMs: number,
  identity: LocalFourGbProcessIdentity,
  telemetryError?: string,
): LocalFourGbResourceObservation {
  const first = samples[0]!;
  const last = samples.at(-1)!;
  const cgroups = samples.flatMap((sample) => sample.cgroup ? [sample.cgroup] : []);
  const sampleGaps = samples.slice(1).map((sample, index) => sample.atMs - samples[index]!.atMs);
  const peakCountersMonotonic = cgroups.every((sample, index) => index === 0
    || (
      sample.memoryPeakBytes >= cgroups[index - 1]!.memoryPeakBytes
      && sample.swapPeakBytes >= cgroups[index - 1]!.swapPeakBytes
    ));
  const aggregateTelemetryError = [
    telemetryError,
    cgroups.length > 0 && !peakCountersMonotonic ? 'Kernel cgroup peak counters decreased during observation' : undefined,
  ].filter((value): value is string => value !== undefined).join('; ') || undefined;
  return {
    platform: platform(),
    architecture: arch(),
    hostTotalMemoryBytes: totalmem(),
    durationMs: Math.round(durationMs),
    sampleCount: samples.length,
    initialSampleDelayMs: Math.round(first.atMs),
    finalSampleAgeMs: Math.round(Math.max(0, durationMs - last.atMs)),
    maximumSampleGapMs: Math.round(sampleGaps.length > 0 ? Math.max(...sampleGaps) : 0),
    targetAliveEverySample: samples.every((sample) => sample.targetAlive),
    combinedProcessTreeRssInitialBytes: first.processTreeRssBytes,
    combinedProcessTreeRssPeakBytes: Math.max(...samples.map((sample) => sample.processTreeRssBytes)),
    combinedProcessTreeRssFinalBytes: last.processTreeRssBytes,
    hostAvailableInitialBytes: first.hostAvailableBytes,
    hostAvailableMinimumBytes: Math.min(...samples.map((sample) => sample.hostAvailableBytes)),
    hostAvailableFinalBytes: last.hostAvailableBytes,
    ...(cgroups.length > 0 && identity.measurementCgroupPath
      ? {
          cgroup: {
            version: 'v2',
            path: identity.measurementCgroupPath,
            evaluatorAndTargetCovered: cgroups.length === samples.length
              && cgroups.every((sample) => sample.covered),
            device: cgroups[0]!.device,
            inode: cgroups[0]!.inode,
            inodeStable: cgroups.every((sample) => sample.device === cgroups[0]!.device && sample.inode === cgroups[0]!.inode),
            limitBytes: cgroups[0]!.limitBytes,
            limitStable: cgroups.every((sample) => sample.limitBytes === cgroups[0]!.limitBytes),
            kernelMemoryPeakBytes: Math.max(...cgroups.map((sample) => sample.memoryPeakBytes)),
            memoryCurrentInitialBytes: cgroups[0]!.memoryCurrentBytes,
            memoryCurrentPeakBytes: Math.max(...cgroups.map((sample) => sample.memoryCurrentBytes)),
            memoryCurrentFinalBytes: cgroups.at(-1)!.memoryCurrentBytes,
            swapInitialBytes: cgroups[0]!.swapCurrentBytes,
            swapPeakBytes: Math.max(...cgroups.map((sample) => sample.swapCurrentBytes)),
            swapFinalBytes: cgroups.at(-1)!.swapCurrentBytes,
            swapLimitBytes: cgroups[0]!.swapLimitBytes,
            swapLimitStable: cgroups.every((sample) => sample.swapLimitBytes === cgroups[0]!.swapLimitBytes),
            kernelSwapPeakBytes: Math.max(...cgroups.map((sample) => sample.swapPeakBytes)),
          },
        }
      : {}),
    ...(aggregateTelemetryError ? { telemetryError: aggregateTelemetryError } : {}),
  };
}

function combineProcessIdentity(
  initial: LocalFourGbProcessIdentity,
  final: LocalFourGbProcessIdentity,
): LocalFourGbProcessIdentity {
  const verified = initial.verified && final.verified;
  const cgroupStable = initial.targetCgroupPath === final.targetCgroupPath
    && initial.evaluatorCgroupPath === final.evaluatorCgroupPath
    && initial.measurementCgroupPath === final.measurementCgroupPath;
  const processInstanceStable = initial.processStartTimeTicks !== undefined
    && initial.processStartTimeTicks === final.processStartTimeTicks;
  const namespaceStable = initial.targetNetworkNamespace === final.targetNetworkNamespace
    && initial.evaluatorNetworkNamespace === final.evaluatorNetworkNamespace
    && initial.targetCgroupNamespace === final.targetCgroupNamespace
    && initial.evaluatorCgroupNamespace === final.evaluatorCgroupNamespace
    && initial.targetMountNamespace === final.targetMountNamespace
    && initial.evaluatorMountNamespace === final.evaluatorMountNamespace
    && initial.cgroupMountPath === final.cgroupMountPath;
  const objectsStable = initial.runtimeDevice === final.runtimeDevice
    && initial.runtimeInode === final.runtimeInode
    && initial.modelDevice === final.modelDevice
    && initial.modelInode === final.modelInode
    && initial.listenerSocketInode === final.listenerSocketInode
    && initial.measurementCgroupDevice === final.measurementCgroupDevice
    && initial.measurementCgroupInode === final.measurementCgroupInode;
  const stableVerified = verified && (
    initial.platform !== 'linux'
    || (cgroupStable && processInstanceStable && namespaceStable && objectsStable)
  );
  const dangerousEnvironmentNames = [...new Set([
    ...(initial.dangerousEnvironmentNames ?? []),
    ...(final.dangerousEnvironmentNames ?? []),
  ])].sort();
  return {
    ...final,
    alive: initial.alive && final.alive,
    executableVerified: initial.executableVerified && final.executableVerified,
    argvVerified: initial.argvVerified && final.argvVerified,
    networkNamespaceVerified: initial.networkNamespaceVerified === true && final.networkNamespaceVerified === true,
    cgroupNamespaceVerified: initial.cgroupNamespaceVerified === true && final.cgroupNamespaceVerified === true,
    mountNamespaceSame: initial.mountNamespaceSame === true && final.mountNamespaceSame === true,
    runtimeObjectVerified: initial.runtimeObjectVerified === true && final.runtimeObjectVerified === true,
    modelMappingVerified: initial.modelMappingVerified === true && final.modelMappingVerified === true,
    listenerVerified: initial.listenerVerified === true && final.listenerVerified === true,
    environmentVerified: initial.environmentVerified === true && final.environmentVerified === true,
    authenticationVerified: initial.authenticationVerified === true && final.authenticationVerified === true,
    authenticationDetail: initial.authenticationVerified === true && final.authenticationVerified === true
      ? 'Unauthenticated and fixed-wrong-Bearer requests were rejected before and after quality observation'
      : `Authentication enforcement was incomplete; initial: ${initial.authenticationDetail ?? 'unobserved'}; final: ${final.authenticationDetail ?? 'unobserved'}`,
    dangerousEnvironmentNames,
    verified: stableVerified,
    sameCgroup: initial.sameCgroup && final.sameCgroup,
    detail: stableVerified
      ? 'The same live PID instance retained exact argv, namespaces, artifacts, listener ownership, sealed environment, and cgroup membership across observation'
      : `Process identity evidence was incomplete or unstable; initial: ${initial.detail}; final: ${final.detail}`,
  };
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function inspectProcessIdentity(
  manifest: LocalFourGbDeploymentManifest,
  artifacts: LocalFourGbProbeContext['artifacts'],
  targetRootArtifacts: LocalFourGbProbeContext['targetRootArtifacts'],
): Promise<LocalFourGbProcessIdentity> {
  try {
    process.kill(manifest.processId, 0);
  } catch (cause) {
    return unavailableProcessIdentity(manifest.processId, `PID is not alive or observable: ${message(cause)}`);
  }
  if (process.platform === 'linux') {
    try {
      const startTimeBefore = await readProcessStartTimeTicks(manifest.processId);
      const [observedExecutable, commandLine, targetCgroupPath, evaluatorCgroupPath, targetNetworkNamespace, evaluatorNetworkNamespace, targetCgroupNamespace, evaluatorCgroupNamespace, targetMountNamespace, evaluatorMountNamespace, cgroupMountPath, environment] = await Promise.all([
        readlink(`/proc/${manifest.processId}/exe`),
        readFile(`/proc/${manifest.processId}/cmdline`),
        readProcessCgroup(manifest.processId),
        readProcessCgroup(process.pid),
        namespaceIdentity(`/proc/${manifest.processId}/ns/net`),
        namespaceIdentity(`/proc/${process.pid}/ns/net`),
        namespaceIdentity(`/proc/${manifest.processId}/ns/cgroup`),
        namespaceIdentity(`/proc/${process.pid}/ns/cgroup`),
        namespaceIdentity(`/proc/${manifest.processId}/ns/mnt`),
        namespaceIdentity(`/proc/${process.pid}/ns/mnt`),
        resolveCgroup2Mount(),
        readFile(`/proc/${manifest.processId}/environ`),
      ]);
      const observedArgv = parseNulVector(commandLine, 'target argv', false);
      const argvVerified = arraysEqual(observedArgv, manifest.runtime.argv);
      const dangerousEnvironmentNames = evaluateLocalFourGbEnvironmentNames(parseEnvironmentNames(environment));
      const environmentVerified = dangerousEnvironmentNames.length === 0;
      const networkNamespaceVerified = targetNetworkNamespace === evaluatorNetworkNamespace;
      const cgroupNamespaceVerified = targetCgroupNamespace === evaluatorCgroupNamespace;
      const mountNamespaceSame = targetMountNamespace === evaluatorMountNamespace;
      const runtimeAtTargetRoot = requiredTargetRootArtifact(targetRootArtifacts?.runtime, 'runtime');
      const modelAtTargetRoot = requiredTargetRootArtifact(targetRootArtifacts?.model, 'model');
      const liveExecutable = await stat(`/proc/${manifest.processId}/exe`, { bigint: true });
      const runtimeMatchesHostWhenShared = !mountNamespaceSame || (
        runtimeAtTargetRoot.device === artifacts.runtime.device
        && runtimeAtTargetRoot.inode === artifacts.runtime.inode
      );
      const modelMatchesHostWhenShared = !mountNamespaceSame || (
        modelAtTargetRoot.device === artifacts.model.device
        && modelAtTargetRoot.inode === artifacts.model.inode
      );
      const runtimeObjectVerified = runtimeAtTargetRoot.sha256 === manifest.runtime.binary.sha256
        && runtimeAtTargetRoot.device === liveExecutable.dev.toString()
        && runtimeAtTargetRoot.inode === liveExecutable.ino.toString()
        && runtimeMatchesHostWhenShared;
      const modelMappingVerified = modelAtTargetRoot.sha256 === manifest.model.sha256
        && modelMatchesHostWhenShared
        && await completeModelMappingVerified(manifest.processId, modelAtTargetRoot);
      const listener = await inspectOwnedLoopbackListener(manifest.processId, manifest.endpoint);
      const sameCgroup = targetCgroupPath === evaluatorCgroupPath;
      const measurementCgroupPath = closestCommonCgroup(targetCgroupPath, evaluatorCgroupPath);
      const measurementCgroupDirectory = cgroupDirectory(measurementCgroupPath, cgroupMountPath);
      await verifyCgroup2Directory(measurementCgroupDirectory);
      const measurementCgroupInfo = await stat(measurementCgroupDirectory, { bigint: true });
      const startTimeAfter = await readProcessStartTimeTicks(manifest.processId);
      const processInstanceStable = startTimeBefore === startTimeAfter;
      const verified = processInstanceStable
        && argvVerified
        && networkNamespaceVerified
        && cgroupNamespaceVerified
        && runtimeObjectVerified
        && modelMappingVerified
        && listener.verified
        && environmentVerified;
      return {
        platform: 'linux',
        processId: manifest.processId,
        alive: true,
        executableVerified: runtimeObjectVerified,
        argvVerified,
        networkNamespaceVerified,
        cgroupNamespaceVerified,
        mountNamespaceSame,
        runtimeObjectVerified,
        modelMappingVerified,
        listenerVerified: listener.verified,
        environmentVerified,
        targetNetworkNamespace,
        evaluatorNetworkNamespace,
        targetCgroupNamespace,
        evaluatorCgroupNamespace,
        targetMountNamespace,
        evaluatorMountNamespace,
        runtimeDevice: runtimeAtTargetRoot.device,
        runtimeInode: runtimeAtTargetRoot.inode,
        modelDevice: modelAtTargetRoot.device,
        modelInode: modelAtTargetRoot.inode,
        ...(listener.inode ? { listenerSocketInode: listener.inode } : {}),
        processStartTimeTicks: startTimeAfter,
        cgroupMountPath,
        measurementCgroupDevice: measurementCgroupInfo.dev.toString(),
        measurementCgroupInode: measurementCgroupInfo.ino.toString(),
        dangerousEnvironmentNames,
        verified,
        observedExecutable,
        observedArgv,
        targetCgroupPath,
        evaluatorCgroupPath,
        measurementCgroupPath,
        sameCgroup,
        detail: verified
          ? `Live PID instance matched exact argv and reviewed target-root artifacts; mount namespaces ${mountNamespaceSame ? 'match' : 'differ but are artifact-bound'}`
          : `Linux proof failed: pidStable=${processInstanceStable}, argv=${argvVerified}, netns=${networkNamespaceVerified}, cgroupns=${cgroupNamespaceVerified}, runtime=${runtimeObjectVerified}, model=${modelMappingVerified}, listener=${listener.verified}, environment=${environmentVerified}`,
      };
    } catch (cause) {
      return unavailableProcessIdentity(manifest.processId, `Linux process identity could not be observed: ${message(cause)}`);
    }
  }
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await execFileAsync('/bin/ps', ['-ww', '-p', String(manifest.processId), '-o', 'command='], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024,
      });
      const observedCommand = stdout.trim();
      return {
        platform: 'darwin',
        processId: manifest.processId,
        alive: observedCommand.length > 0,
        executableVerified: false,
        argvVerified: false,
        verified: false,
        observedCommand,
        sameCgroup: false,
        detail: 'Darwin ps command text is diagnostic only; it cannot prove exact executable plus NUL-delimited argv identity',
      };
    } catch (cause) {
      return unavailableProcessIdentity(manifest.processId, `Darwin process identity could not be observed: ${message(cause)}`);
    }
  }
  return unavailableProcessIdentity(manifest.processId, `Exact live process identity is unsupported on ${process.platform}`);
}

function unavailableProcessIdentity(processId: number, detail: string): LocalFourGbProcessIdentity {
  return {
    platform: platform(),
    processId,
    alive: false,
    executableVerified: false,
    argvVerified: false,
    verified: false,
    sameCgroup: false,
    detail,
  };
}

interface TargetRootArtifactIdentity {
  device: string;
  inode: string;
  bytes: number;
  sha256: string;
}

function requiredTargetRootArtifact(
  identity: LocalFourGbArtifactIdentity | undefined,
  label: string,
): TargetRootArtifactIdentity {
  if (
    !identity?.matched
    || identity.device === undefined
    || identity.inode === undefined
    || identity.bytes === undefined
    || identity.observedSha256 === undefined
    || identity.linkCount !== 1
    || identity.mode === undefined
    || identity.modifiedNanoseconds === undefined
    || identity.changedNanoseconds === undefined
  ) {
    throw new Error(`Retained target-root ${label} artifact identity is incomplete`);
  }
  return {
    device: identity.device,
    inode: identity.inode,
    bytes: identity.bytes,
    sha256: identity.observedSha256,
  };
}

async function completeModelMappingVerified(
  pid: number,
  model: TargetRootArtifactIdentity,
): Promise<boolean> {
  const source = await readFile(`/proc/${pid}/maps`, 'utf8');
  if (Buffer.byteLength(source) > 16 * MIB) throw new Error('Target memory map exceeds the inspection bound');
  const expectedDevice = linuxDeviceComponents(BigInt(model.device));
  const intervals: Array<{ start: bigint; end: bigint }> = [];
  for (const line of source.split('\n')) {
    if (!line) continue;
    const match = /^([0-9a-f]+)-([0-9a-f]+)\s+([rwxps-]{4})\s+([0-9a-f]+)\s+([0-9a-f]+):([0-9a-f]+)\s+(\d+)(?:\s+.*)?$/iu.exec(line);
    if (!match) throw new Error('Target memory map contains an unparseable record');
    if (
      BigInt(match[7]!) !== BigInt(model.inode)
      || BigInt(`0x${match[5]!}`) !== expectedDevice.major
      || BigInt(`0x${match[6]!}`) !== expectedDevice.minor
    ) continue;
    const rangeStart = BigInt(`0x${match[1]!}`);
    const rangeEnd = BigInt(`0x${match[2]!}`);
    const permissions = match[3]!;
    const offset = BigInt(`0x${match[4]!}`);
    if (rangeEnd <= rangeStart) throw new Error('Target model mapping has an invalid virtual address range');
    if (permissions[0] !== 'r' || permissions[1] === 'w') {
      throw new Error('Target model mapping must be readable and non-writable');
    }
    const mappedObject = await stat(`/proc/${pid}/map_files/${match[1]}-${match[2]}`, { bigint: true });
    if (mappedObject.dev.toString() !== model.device || mappedObject.ino.toString() !== model.inode) {
      throw new Error('Target model mapping device/inode does not match the reviewed target-root artifact');
    }
    intervals.push({ start: offset, end: offset + (rangeEnd - rangeStart) });
  }
  if (intervals.length === 0) return false;
  intervals.sort((left, right) => left.start < right.start ? -1 : left.start > right.start ? 1 : 0);
  let coveredUntil = 0n;
  for (const interval of intervals) {
    if (interval.start > coveredUntil) return false;
    if (interval.end > coveredUntil) coveredUntil = interval.end;
  }
  return coveredUntil >= BigInt(model.bytes);
}

function linuxDeviceComponents(device: bigint): { major: bigint; minor: bigint } {
  return {
    major: ((device >> 8n) & 0xfffn) | ((device >> 32n) & 0xfffff000n),
    minor: (device & 0xffn) | ((device >> 12n) & 0xffffff00n),
  };
}

async function inspectOwnedLoopbackListener(
  pid: number,
  endpointSource: string,
): Promise<{ verified: boolean; inode?: string }> {
  const endpoint = new URL(endpointSource);
  if (!endpoint.port) return { verified: false };
  const expectedPort = Number(endpoint.port);
  const expectedHost = endpoint.hostname;
  const ownedBefore = await readProcessSocketInodes(pid);
  const [tcp, tcp6] = await Promise.all([
    readFile(`/proc/${pid}/net/tcp`, 'utf8'),
    readFile(`/proc/${pid}/net/tcp6`, 'utf8'),
  ]);
  const ownedAfter = await readProcessSocketInodes(pid);
  const listeners = [
    ...parseProcTcpListeners(tcp, 'tcp'),
    ...parseProcTcpListeners(tcp6, 'tcp6'),
  ];
  const ownedListenersBefore = listeners.filter((item) => ownedBefore.has(item.inode));
  const ownedListenersAfter = listeners.filter((item) => ownedAfter.has(item.inode));
  const exact = listeners.filter((item) => item.port === expectedPort && (
    (expectedHost === '127.0.0.1' && item.protocol === 'tcp' && item.address === '0100007F')
    || (expectedHost === '[::1]' && item.protocol === 'tcp6' && item.address === '00000000000000000000000001000000')
  ));
  const samePortListeners = listeners.filter((item) => item.port === expectedPort);
  const exactInode = exact[0]?.inode;
  const verified = exact.length === 1
    && samePortListeners.length === 1
    && exactInode !== undefined
    && ownedBefore.has(exactInode)
    && ownedAfter.has(exactInode)
    && ownedListenersBefore.length === 1
    && ownedListenersAfter.length === 1;
  return exact[0]?.inode ? { verified, inode: exact[0].inode } : { verified };
}

async function readProcessSocketInodes(pid: number): Promise<Set<string>> {
  const fdNames = await readdir(`/proc/${pid}/fd`);
  const socketInodes = new Set<string>();
  for (const name of fdNames) {
    if (!/^\d+$/u.test(name)) throw new Error('Target file-descriptor directory contains an invalid entry');
    const target = await readlink(`/proc/${pid}/fd/${name}`);
    const match = /^socket:\[(\d+)\]$/u.exec(target);
    if (match) socketInodes.add(match[1]!);
  }
  return socketInodes;
}

interface ProcTcpListener {
  protocol: 'tcp' | 'tcp6';
  address: string;
  port: number;
  inode: string;
}

function parseProcTcpListeners(source: string, protocol: ProcTcpListener['protocol']): ProcTcpListener[] {
  if (Buffer.byteLength(source) > 16 * MIB) throw new Error(`${protocol} socket table exceeds the inspection bound`);
  const listeners: ProcTcpListener[] = [];
  for (const line of source.trim().split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/u);
    if (fields.length < 10) throw new Error(`${protocol} socket table contains an unparseable record`);
    if (fields[3] !== '0A') continue;
    const local = /^([0-9A-F]+):([0-9A-F]{4})$/u.exec(fields[1]!);
    const remote = /^([0-9A-F]+):([0-9A-F]{4})$/u.exec(fields[2]!);
    if (!local || !remote || !/^0+$/u.test(remote[1]!) || remote[2] !== '0000' || !/^\d+$/u.test(fields[9]!)) {
      throw new Error(`${protocol} listener table contains an invalid endpoint or inode`);
    }
    listeners.push({
      protocol,
      address: local[1]!,
      port: Number.parseInt(local[2]!, 16),
      inode: fields[9]!,
    });
  }
  return listeners;
}

async function namespaceIdentity(path: string): Promise<string> {
  const info = await stat(path, { bigint: true });
  return `${info.dev}:${info.ino}`;
}

function parseNulVector(source: Buffer, label: string, allowEmpty: boolean): string[] {
  if (source.length === 0) {
    if (allowEmpty) return [];
    throw new Error(`${label} is empty`);
  }
  if (source.length > MAX_ARG_COUNT * MAX_ARG_BYTES) throw new Error(`${label} exceeds the inspection bound`);
  if (source.at(-1) !== 0) throw new Error(`${label} is not terminal-NUL delimited`);
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(source);
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
  const values = decoded.split('\0');
  values.pop();
  if (values.length > MAX_ARG_COUNT || values.some((value) => value.length === 0 || value.length > MAX_ARG_BYTES)) {
    throw new Error(`${label} contains an empty, oversized, or excess entry`);
  }
  return values;
}

function parseEnvironmentNames(source: Buffer): string[] {
  if (source.length === 0) return [];
  const entries = parseNulVector(source, 'target environment', true);
  const names: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const equalsAt = entry.indexOf('=');
    const name = equalsAt > 0 ? entry.slice(0, equalsAt) : '';
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) || seen.has(name)) {
      throw new Error('Target environment contains an invalid or duplicate variable name');
    }
    seen.add(name);
    names.push(name);
  }
  return names;
}

export function evaluateLocalFourGbEnvironmentNames(names: readonly string[]): string[] {
  return [...new Set(names.filter((name) => DANGEROUS_ENVIRONMENT_NAME.test(name)))].sort();
}

async function readProcessStartTimeTicks(pid: number): Promise<string> {
  const source = await readFile(`/proc/${pid}/stat`, 'utf8');
  const close = source.lastIndexOf(')');
  if (close < 0) throw new Error('Target process stat record is malformed');
  const fields = source.slice(close + 2).trim().split(/\s+/u);
  const state = fields[0];
  const startTime = fields[19];
  if (!state || state === 'Z' || state === 'X' || !startTime || !/^\d+$/u.test(startTime)) {
    throw new Error('Target process is dead or its start time is unobservable');
  }
  return startTime;
}

async function readProcessCgroup(pid: number): Promise<string> {
  const lines = (await readFile(`/proc/${pid}/cgroup`, 'utf8')).trim().split('\n');
  const unified = lines.find((line) => line.startsWith('0::'));
  if (!unified) throw new Error('Unified cgroup v2 membership was not found');
  const value = unified.slice(3);
  if (!value.startsWith('/') || value.includes('\0')) throw new Error('Invalid cgroup v2 path');
  return value;
}

async function resolveCgroup2Mount(): Promise<string> {
  const source = await readFile('/proc/self/mountinfo', 'utf8');
  if (Buffer.byteLength(source) > MIB) throw new Error('mountinfo exceeds the inspection bound');
  const candidates: string[] = [];
  for (const line of source.trim().split('\n')) {
    const fields = line.split(' ');
    const separator = fields.indexOf('-');
    if (separator < 6 || fields[separator + 1] !== 'cgroup2') continue;
    const mountRoot = decodeMountInfoField(fields[3]!);
    const mountPoint = decodeMountInfoField(fields[4]!);
    if (mountRoot !== '/') continue;
    if (!isAbsolute(mountPoint) || resolve(mountPoint) !== mountPoint || mountPoint.includes('\0')) {
      throw new Error('cgroup2 mountinfo contains an unsafe mount point');
    }
    candidates.push(await realpath(mountPoint));
  }
  if (candidates.length === 0) throw new Error('A root-addressable cgroup2 mount was not found in evaluator mountinfo');
  const unique = [...new Set(candidates)].sort((left, right) => left.length - right.length || left.localeCompare(right));
  const selected = unique[0]!;
  await verifyCgroup2Directory(selected);
  return selected;
}

function decodeMountInfoField(value: string): string {
  return value.replace(/\\([0-7]{3})/gu, (_match, octal: string) => String.fromCodePoint(Number.parseInt(octal, 8)));
}

async function verifyCgroup2Directory(path: string): Promise<void> {
  const [filesystem, info] = await Promise.all([
    statfs(path, { bigint: true }),
    stat(path, { bigint: true }),
  ]);
  if (filesystem.type !== CGROUP2_SUPER_MAGIC || !info.isDirectory()) {
    throw new Error('Measured resource directory is not on a cgroup v2 filesystem');
  }
}

function cgroupDirectory(path: string, root: string): string {
  const directory = resolve(root, `.${path}`);
  if (directory !== root && !directory.startsWith(`${root}/`)) throw new Error('Cgroup path escaped the verified cgroup2 mount');
  return directory;
}

function closestCommonCgroup(left: string, right: string): string {
  const leftParts = left.split('/').filter(Boolean);
  const rightParts = right.split('/').filter(Boolean);
  const shared: string[] = [];
  for (let index = 0; index < Math.min(leftParts.length, rightParts.length); index += 1) {
    if (leftParts[index] !== rightParts[index]) break;
    shared.push(leftParts[index]!);
  }
  return shared.length === 0 ? '/' : `/${shared.join('/')}`;
}

async function readCgroupNumber(path: string, allowMax: boolean): Promise<number | null> {
  const value = (await readFile(path, 'utf8')).trim();
  if (allowMax && value === 'max') return null;
  if (!/^\d+$/u.test(value)) throw new Error(`Invalid cgroup counter in ${path}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`Cgroup counter is outside the safe integer range in ${path}`);
  return parsed;
}

async function linuxProcessTreeRss(roots: number[]): Promise<number> {
  const table = new Map<number, { parent: number; rssBytes: number }>();
  for (const entry of await readdir('/proc', { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) continue;
    const pid = Number(entry.name);
    try {
      const [statSource, statusSource] = await Promise.all([
        readFile(`/proc/${pid}/stat`, 'utf8'),
        readFile(`/proc/${pid}/status`, 'utf8'),
      ]);
      const close = statSource.lastIndexOf(')');
      if (close < 0) continue;
      const fields = statSource.slice(close + 2).trim().split(/\s+/u);
      const parent = Number(fields[1]);
      const rssMatch = /^VmRSS:\s+(\d+)\s+kB$/mu.exec(statusSource);
      if (!Number.isSafeInteger(parent) || !rssMatch) continue;
      const rssBytes = Number(rssMatch[1]) * 1024;
      if (!Number.isSafeInteger(rssBytes)) continue;
      table.set(pid, { parent, rssBytes });
    } catch {
      // Processes can exit between /proc enumeration and inspection.
    }
  }
  for (const root of roots) {
    if (!table.has(root)) throw new Error(`Required process-tree root ${root} was not fully observable`);
  }
  return descendantRss(table, roots);
}

async function darwinProcessTreeRss(roots: number[]): Promise<number> {
  const { stdout } = await execFileAsync('/bin/ps', ['-axo', 'pid=,ppid=,rss='], {
    encoding: 'utf8',
    maxBuffer: 8 * MIB,
  });
  const table = new Map<number, { parent: number; rssBytes: number }>();
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/u.exec(line);
    if (!match) continue;
    table.set(Number(match[1]), { parent: Number(match[2]), rssBytes: Number(match[3]) * 1024 });
  }
  return descendantRss(table, roots);
}

function descendantRss(table: Map<number, { parent: number; rssBytes: number }>, roots: number[]): number {
  const included = new Set(roots);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, item] of table) {
      if (!included.has(pid) && included.has(item.parent)) {
        included.add(pid);
        changed = true;
      }
    }
  }
  return [...included].reduce((total, pid) => total + (table.get(pid)?.rssBytes ?? 0), 0);
}

function bindCandidate(config: AppConfig, manifest: LocalFourGbDeploymentManifest): ModelRouteConfig {
  const enabledRoutes = config.routing?.routes.filter((item) => item.enabled) ?? [];
  if (enabledRoutes.length !== 1) {
    throw new Error(`Local 4 GB qualification requires exactly one enabled route total; observed ${enabledRoutes.length}`);
  }
  const route = enabledRoutes[0]?.id === manifest.routeId ? enabledRoutes[0] : undefined;
  if (!route) throw new Error(`Local 4 GB candidate route not found: ${manifest.routeId}`);
  if (route.provider !== 'llama.cpp') {
    throw new Error('Local 4 GB candidate provider must be exactly llama.cpp');
  }
  if (!route.local || route.tasks.length !== 1 || route.tasks[0] !== 'project_analysis') {
    throw new Error('Local 4 GB candidate must be one enabled local project_analysis-only route');
  }
  if (!route.baseUrl || normalizedUrl(route.baseUrl) !== normalizedUrl(manifest.endpoint)) {
    throw new Error('Local 4 GB deployment endpoint must exactly match the candidate route baseUrl');
  }
  if (route.inputCostPerMillion !== 0 || route.outputCostPerMillion !== 0) {
    throw new Error('Local 4 GB candidate must declare zero provider cost');
  }
  if (route.contextWindow !== manifest.deployment.contextTokens) {
    throw new Error('Candidate route contextWindow must equal deployment.contextTokens');
  }
  if (route.model.trim() === '' || route.provider.trim() === '') throw new Error('Candidate model identity is empty');
  return route;
}

export function evaluateLocalFourGbQualificationBinding(
  qualification: ApplianceQualificationManifest,
  deployment: LocalFourGbDeploymentManifest,
  route: ModelRouteConfig,
): string[] {
  const blockers: string[] = [];
  if (route.provider !== 'llama.cpp') blockers.push('candidate route provider must be exactly llama.cpp');
  if (deployment.runtime.implementation !== 'llama.cpp') blockers.push('deployment runtime implementation must be exactly llama.cpp');
  if (qualification.requirePins !== true) blockers.push('qualification manifest must require strong pins');
  const pin = qualification.pins?.[`route:${route.id}`];
  if (!pin) return [...blockers, `qualification manifest is missing route:${route.id}`];
  if (pin.provider !== route.provider) blockers.push('qualification provider does not equal candidate provider');
  if (pin.model !== route.model) blockers.push('qualification model does not equal candidate model alias');
  bindExactArtifactList(pin.artifacts, deployment.model, 'model', blockers);
  if (!pin.runtime) {
    blockers.push('qualification runtime evidence is missing');
  } else {
    if (pin.runtime.implementation !== deployment.runtime.implementation) {
      blockers.push('qualification runtime implementation does not equal deployment runtime implementation');
    }
    if (pin.runtime.version !== deployment.runtime.version) {
      blockers.push('qualification runtime version does not equal deployment runtime version');
    }
    bindExactArtifactList(pin.runtime.artifacts, deployment.runtime.binary, 'runtime', blockers);
  }
  if (pin.maxContextTokens !== deployment.deployment.contextTokens) {
    blockers.push('qualification maxContextTokens must exactly equal deployment contextTokens');
  }
  if (pin.maxConcurrency !== deployment.deployment.maxConcurrentRequests || pin.maxConcurrency !== 1) {
    blockers.push('qualification maxConcurrency must exactly equal the one-request deployment limit');
  }
  return blockers;
}

function bindExactArtifactList(
  artifacts: QualificationTargetPin['artifacts'] | undefined,
  expected: LocalFourGbArtifactPin,
  label: string,
  blockers: string[],
): void {
  if (!artifacts || artifacts.length !== 1) {
    blockers.push(`qualification ${label} artifacts must contain exactly one entry`);
    return;
  }
  const artifact = artifacts[0]!;
  if (artifact.path !== expected.path) blockers.push(`qualification ${label} artifact path does not equal deployment path`);
  if (artifact.sha256 !== expected.sha256) blockers.push(`qualification ${label} artifact SHA-256 does not equal deployment SHA-256`);
}

export function evaluateLocalFourGbArgvPosture(
  manifest: LocalFourGbDeploymentManifest,
  route: ModelRouteConfig,
): string[] {
  const blockers: string[] = [];
  const deployment = manifest.deployment;
  if (route.provider !== 'llama.cpp') blockers.push('candidate route provider must be exactly llama.cpp');
  if (deployment.slots !== 1) blockers.push('deployment.slots must equal 1');
  if (deployment.maxConcurrentRequests !== 1) blockers.push('deployment.maxConcurrentRequests must equal 1');
  if (deployment.contextTokens > LOCAL_4GB_BUDGETS.maximumContextTokens) blockers.push('contextTokens exceeds 3072');
  if (deployment.maxOutputTokens !== 512) blockers.push('maxOutputTokens must equal the project-analyst 512-token contract');
  if (!deployment.offline) blockers.push('offline must be true');
  if (!deployment.authenticated) blockers.push('authenticated must be true');
  if (deployment.ui || deployment.builtInAgent || deployment.builtInTools || deployment.continuousBatching) {
    blockers.push('UI, built-in agent/tools, and continuous batching must be disabled');
  }
  if (manifest.runtime.argv[0] !== manifest.runtime.binary.path) blockers.push('runtime.argv[0] must be the exact absolute runtime binary path');
  if (manifest.runtime.implementation !== 'llama.cpp') {
    blockers.push('portable reviewed argv enforcement currently supports only llama.cpp; other runtimes remain diagnostic');
    return blockers;
  }
  const argv = manifest.runtime.argv;
  const endpoint = new URL(manifest.endpoint);
  if (!endpoint.port) blockers.push('portable llama.cpp endpoint must declare an explicit port');
  if (!['127.0.0.1', '[::1]'].includes(endpoint.hostname)) {
    blockers.push('portable llama.cpp endpoint must use a numeric loopback host, not localhost or a wildcard');
  }
  const expectedValues = new Map<string, string>([
    ['--model', manifest.model.path],
    ['--alias', route.model],
    ['--host', stripIpv6Brackets(endpoint.hostname)],
    ['--port', endpoint.port],
    ['--api-key-file', '__ABSOLUTE_PATH__'],
    ['--parallel', '1'],
    ['--ctx-size', String(deployment.contextTokens)],
    ['--batch-size', '256'],
    ['--ubatch-size', '64'],
    ['--cache-type-k', 'f16'],
    ['--cache-type-v', 'f16'],
    ['--cache-ram', '64'],
    ['--ctx-checkpoints', '2'],
    ['--reasoning', 'off'],
    ['--n-predict', String(deployment.maxOutputTokens)],
    ['--load-mode', 'mmap'],
    ['--fit', 'off'],
    ['--threads-http', '1'],
    ['--timeout', '60'],
    ['--sse-ping-interval', '-1'],
    ['--device', 'none'],
    ['--gpu-layers', '0'],
  ]);
  const booleanFlags = new Set<string>(REQUIRED_LLAMA_CPP_BOOLEAN_FLAGS);
  const valueFlags = new Set<string>(REQUIRED_LLAMA_CPP_VALUE_FLAGS);
  const seen = new Set<string>();
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index]!;
    const equalsAt = argument.indexOf('=');
    const option = equalsAt < 0 ? argument : argument.slice(0, equalsAt);
    if (!argument.startsWith('--')) {
      blockers.push(`runtime argv contains forbidden short option or stray value ${argument || '<empty>'}`);
      continue;
    }
    if (!booleanFlags.has(option) && !valueFlags.has(option)) {
      blockers.push(`runtime argv contains unknown option ${option}`);
      continue;
    }
    if (seen.has(option)) blockers.push(`runtime option ${option} must appear exactly once`);
    seen.add(option);
    if (booleanFlags.has(option)) {
      if (equalsAt >= 0) blockers.push(`boolean runtime option ${option} must not use an equals value`);
      continue;
    }
    if (equalsAt >= 0) {
      blockers.push(`runtime option ${option} must use the packaged separate-value form`);
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.length === 0) {
      blockers.push(`runtime option ${option} is missing its value`);
      continue;
    }
    index += 1;
    const expected = expectedValues.get(option)!;
    if (expected === '__ABSOLUTE_PATH__') {
      if (!isAbsolute(value)) blockers.push('--api-key-file must use an explicit absolute path');
    } else if (value !== expected) {
      blockers.push(`runtime option ${option} must equal ${expected}; observed ${value}`);
    }
  }
  for (const flag of [...REQUIRED_LLAMA_CPP_BOOLEAN_FLAGS, ...REQUIRED_LLAMA_CPP_VALUE_FLAGS]) {
    if (!seen.has(flag)) blockers.push(`missing required runtime option ${flag}`);
  }
  if (argv.length !== 53) blockers.push(`packaged llama.cpp argv must contain exactly 53 entries; observed ${argv.length}`);
  return blockers;
}

interface ArtifactLeaseMetadata {
  dev: bigint;
  ino: bigint;
  size: bigint;
  nlink: bigint;
  mode: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

class ArtifactLease {
  constructor(
    readonly label: string,
    readonly identity: LocalFourGbArtifactIdentity,
    private readonly viewPath: string,
    private readonly initialResolvedViewPath: string | undefined,
    private readonly initial: ArtifactLeaseMetadata | undefined,
    private readonly handle: FileHandle | undefined,
    private readonly requireCanonicalViewPath: boolean,
  ) {}

  async verifyUnchanged(): Promise<string[]> {
    if (!this.handle || !this.initial || !this.initialResolvedViewPath || !this.identity.observedSha256) {
      return [`${this.label} artifact did not establish a retained descriptor identity`];
    }
    const blockers: string[] = [];
    blockers.push(...await verifyArtifactHandleContinuity(
      this.handle,
      this.initial,
      this.identity.observedSha256,
      `${this.label} retained descriptor`,
    ));

    let reopened: FileHandle | undefined;
    try {
      const resolvedViewPath = await realpath(this.viewPath);
      if (resolvedViewPath !== this.initialResolvedViewPath) {
        blockers.push(`${this.label} artifact pathname resolved to a different object`);
      }
      if (this.requireCanonicalViewPath && resolvedViewPath !== this.viewPath) {
        blockers.push(`${this.label} artifact pathname gained a symlink component`);
      }
      reopened = await open(this.viewPath, noFollowOpenFlags());
      blockers.push(...await verifyArtifactHandleContinuity(
        reopened,
        this.initial,
        this.identity.observedSha256,
        `${this.label} reopened pathname`,
      ));
      const pathname = await lstat(this.viewPath, { bigint: true });
      if (pathname.isSymbolicLink() || !sameBigIntStat(this.initial, pathname)) {
        blockers.push(`${this.label} artifact pathname metadata changed`);
      }
    } catch (cause) {
      blockers.push(`${this.label} artifact pathname could not be reverified: ${message(cause)}`);
    } finally {
      await reopened?.close().catch(() => undefined);
    }
    return [...new Set(blockers)];
  }

  close(): Promise<void> {
    return this.handle?.close() ?? Promise.resolve();
  }
}

async function openArtifactLease(
  pin: LocalFourGbArtifactPin,
  kind: 'model' | 'runtime',
  options: {
    label?: string;
    viewPath?: string;
    requireCanonicalViewPath?: boolean;
  } = {},
): Promise<ArtifactLease> {
  const label = options.label ?? kind;
  const artifactPath = resolve(pin.path);
  const viewPath = options.viewPath ?? artifactPath;
  const requireCanonicalViewPath = options.requireCanonicalViewPath ?? options.viewPath === undefined;
  let handle: FileHandle | undefined;
  try {
    const resolvedViewPath = await realpath(viewPath);
    if (requireCanonicalViewPath && resolvedViewPath !== viewPath) {
      throw new Error('artifact path contains a symlink component');
    }
    handle = await open(viewPath, noFollowOpenFlags());
    const before = await handle.stat({ bigint: true });
    const regularFile = before.isFile();
    const executable = kind === 'runtime'
      ? process.platform === 'win32'
        ? ['.exe', '.com'].includes(extname(viewPath).toLowerCase())
        : (before.mode & 0o111n) !== 0n
      : undefined;
    const bytes = Number(before.size);
    const sizeAllowed = Number.isSafeInteger(bytes)
      && bytes > 0
      && bytes <= MAX_MODEL_ARTIFACT_BYTES;
    const observedSha256 = regularFile && sizeAllowed
      ? await sha256FileHandle(handle, bytes, `${label} artifact`)
      : undefined;
    const after = await handle.stat({ bigint: true });
    const pathname = await lstat(viewPath, { bigint: true });
    const stable = sameBigIntStat(before, after)
      && sameBigIntStat(before, pathname)
      && !pathname.isSymbolicLink();
    const matched = regularFile
      && before.nlink === 1n
      && stable
      && observedSha256 === pin.sha256
      && sizeAllowed
      && (kind !== 'runtime' || executable === true);
    const identity: LocalFourGbArtifactIdentity = {
      ...pin,
      kind,
      exists: true,
      regularFile,
      symbolicLink: false,
      ...(executable !== undefined ? { executable } : {}),
      bytes,
      device: before.dev.toString(),
      inode: before.ino.toString(),
      linkCount: Number(before.nlink),
      mode: before.mode.toString(),
      modifiedNanoseconds: before.mtimeNs.toString(),
      changedNanoseconds: before.ctimeNs.toString(),
      resolvedViewPath,
      ...(observedSha256 ? { observedSha256 } : {}),
      matched,
      detail: before.nlink !== 1n
        ? 'Artifact must not have hard links'
        : !stable
          ? 'Artifact changed while its retained descriptor was established'
          : observedSha256 !== pin.sha256
            ? 'Observed SHA-256 does not match the reviewed pin'
            : !sizeAllowed
              ? `Artifact exceeds the ${MAX_MODEL_ARTIFACT_BYTES}-byte local 4 GB bound`
              : kind === 'runtime' && executable !== true
                ? 'Runtime artifact is not executable'
                : 'Retained regular artifact descriptor matches the reviewed SHA-256 pin',
    };
    return new ArtifactLease(label, identity, viewPath, resolvedViewPath, before, handle, requireCanonicalViewPath);
  } catch (cause) {
    await handle?.close().catch(() => undefined);
    return new ArtifactLease(label, {
      ...pin,
      kind,
      exists: false,
      regularFile: false,
      symbolicLink: false,
      ...(kind === 'runtime' ? { executable: false } : {}),
      matched: false,
      detail: `Artifact lease could not be established: ${message(cause)}`,
    }, viewPath, undefined, undefined, undefined, requireCanonicalViewPath);
  }
}

async function verifyArtifactHandleContinuity(
  handle: FileHandle,
  initial: ArtifactLeaseMetadata,
  initialSha256: string,
  label: string,
): Promise<string[]> {
  const blockers: string[] = [];
  try {
    const before = await handle.stat({ bigint: true });
    if (!sameBigIntStat(initial, before)) blockers.push(`${label} metadata changed before rehash`);
    const bytes = Number(initial.size);
    if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAX_MODEL_ARTIFACT_BYTES) {
      blockers.push(`${label} size is outside the artifact bound`);
      return blockers;
    }
    const observedSha256 = await sha256FileHandle(handle, bytes, label);
    const after = await handle.stat({ bigint: true });
    if (!sameBigIntStat(initial, after)) blockers.push(`${label} metadata changed after rehash`);
    if (observedSha256 !== initialSha256) blockers.push(`${label} SHA-256 changed`);
  } catch (cause) {
    blockers.push(`${label} could not be reverified: ${message(cause)}`);
  }
  return blockers;
}

async function sha256FileHandle(handle: FileHandle, expectedBytes: number, label: string): Promise<string> {
  const hash = createHash('sha256');
  let bytes = 0;
  const stream = handle.createReadStream({ autoClose: false, start: 0 });
  for await (const chunk of stream) {
    bytes += chunk.length;
    if (bytes > expectedBytes) throw new Error(`${label} grew while hashing`);
    hash.update(chunk);
  }
  if (bytes !== expectedBytes) throw new Error(`${label} size changed while hashing`);
  return hash.digest('hex');
}

function artifactPin(value: unknown, label: string, directory: string): LocalFourGbArtifactPin {
  const record = exactObject(value, label, ['path', 'sha256']);
  const path = boundedString(record.path, `${label}.path`, 4_096);
  const sha256 = boundedString(record.sha256, `${label}.sha256`, 64).toLocaleLowerCase('en-US');
  if (!/^[a-f0-9]{64}$/u.test(sha256)) throw new Error(`${label}.sha256 must contain exactly 64 hexadecimal characters`);
  return { path: resolve(directory, path), sha256 };
}

function exactObject(value: unknown, label: string, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const record = value as Record<string, unknown>;
  const allowed = new Set(keys);
  const unknown = Object.keys(record).find((key) => !allowed.has(key));
  const missing = keys.find((key) => !Object.hasOwn(record, key));
  if (unknown) throw new Error(`${label} contains unknown field ${unknown}`);
  if (missing) throw new Error(`${label} is missing field ${missing}`);
  return record;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((item, index) => boundedString(item, `${label}[${index}]`, MAX_ARG_BYTES, true));
}

function boundedString(value: unknown, label: string, maximum: number, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > maximum || value.includes('\0') || (!allowEmpty && (!value || value.trim() !== value))) {
    throw new Error(`${label} must be ${allowEmpty ? '' : 'a trimmed non-empty '}string of at most ${maximum} characters without NUL bytes`);
  }
  return value;
}

function boundedInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return value as number;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} must be boolean`);
  return value;
}

function validatedEndpoint(value: unknown): string {
  const source = boundedString(value, 'endpoint', 2_048);
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    throw new Error('endpoint must be an absolute URL');
  }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('endpoint must use loopback HTTP');
  }
  if (url.username || url.password || url.search || url.hash || url.pathname.replace(/\/$/u, '') !== '/v1') {
    throw new Error('endpoint must be a credential-free /v1 base URL without query or fragment');
  }
  return normalizedUrl(url.toString());
}

function normalizedUrl(value: string): string {
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/$/u, '');
  return url.toString().replace(/\/$/u, '');
}

function stripIpv6Brackets(value: string): string {
  return value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
}

function boundedSoak(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 2 * 60 * 60 * 1_000) {
    throw new Error('Local 4 GB soak must be an integer from 0 to 7200000 milliseconds');
  }
  return value;
}

function boundedTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 30 * 60 * 1_000) {
    throw new Error('Local 4 GB quality timeout must be an integer from 1000 to 1800000 milliseconds');
  }
  return value;
}

function assertion(
  id: string,
  scope: LocalFourGbAssertion['scope'],
  passed: boolean,
  actual: LocalFourGbAssertion['actual'],
  limit: number | undefined,
  detail: string,
): LocalFourGbAssertion {
  return { id, scope, passed, actual, ...(limit !== undefined ? { limit } : {}), detail };
}

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function sha256Bytes(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
