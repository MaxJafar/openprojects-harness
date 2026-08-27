import { spawn } from 'node:child_process';
import { createHash, randomInt } from 'node:crypto';
import { constants as fsConstants, createReadStream } from 'node:fs';
import { access, lstat, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { arch, platform, totalmem } from 'node:os';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import YAML from 'yaml';

import { DeterministicHashEmbeddingAdapter, formatEmbeddingQuery } from '../adapters/embeddings.js';
import {
  validateFreeTokenBaseUrl,
  validateFreeTokenModelAlias,
  validateMlxLmBaseUrl,
} from '../adapters/models.js';
import { WhisperCppTranscriptionAdapter } from '../adapters/transcription.js';
import type { AppConfig, ModelRouteConfig } from '../core/types.js';
import {
  createNetworkPolicy,
  isLoopbackHostname,
  type OutboundNetworkPolicy,
} from '../privacy/network-policy.js';
import {
  executablePathCandidates,
  executableSearchDirectories,
  isShellFreeExecutablePath,
} from '../runtime/executable-path.js';
import { filesystemPathKey } from '../runtime/filesystem-path.js';

const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_PROCESS_OUTPUT_BYTES = 64 * 1024;
const MAX_MLX_SNAPSHOT_FILES = 64;
const MAX_MLX_SNAPSHOT_DIRECTORIES = 64;
const MAX_MLX_SNAPSHOT_BYTES = 64 * 1024 ** 3;
const MAX_MLX_INDEX_BYTES = 1024 * 1024;
const PROCESS_KILL_GRACE_MS = 500;
const DEFAULT_TIMEOUT_MS = 30_000;
const VISION_FIXTURES = [
  // Original programmatically generated solid-color PNG fixtures. They contain
  // no third-party artwork or embedded metadata.
  {
    expected: 'BLUE',
    bytes: 95,
    base64: 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAJklEQVR42u3NsQkAAAjAsP7/tF7hIASyp5pjAoFAIBAIBAKB4EmwOkv8Lom8x/sAAAAASUVORK5CYII=',
  },
  {
    expected: 'RED',
    bytes: 96,
    base64: 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAJ0lEQVR42u3NsQkAAAjAsP7/tF7hIASyp6lTCQQCgUAgEAgEgi/BAjLD/C5w/SM9AAAAAElFTkSuQmCC',
  },
] as const;

export type QualificationCapability = 'text' | 'vision' | 'embeddings' | 'transcription';
export type QualificationStage =
  | 'not_configured'
  | 'configured'
  | 'reachable'
  | 'capability_qualified'
  | 'qualified';

export interface QualificationArtifactPin {
  path: string;
  sha256: string;
}

export interface QualificationTargetPin {
  provider: string;
  model: string;
  /** Exact canonical default-model ID returned by preconfigured MLX /v1/models and chat responses. */
  servedModelId?: string;
  serviceDigest?: string;
  artifacts?: QualificationArtifactPin[];
  /** Operator-declared deployment limit; it is reported, not inferred from the service. */
  maxContextTokens?: number;
  /** Operator-declared deployment limit; the probe itself remains sequential. */
  maxConcurrency?: number;
  /**
   * Hash-bound evidence for the separately provisioned inference runtime.
   * This binds reviewed files and a version label. FreeToken additionally
   * must echo that exact version from /health, but this still does not prove
   * that the listening process was launched from the hashed files.
   */
  runtime?: QualificationRuntimeEvidence;
}

export interface QualificationRuntimeEvidence {
  implementation: string;
  version: string;
  artifacts: QualificationArtifactPin[];
}

export interface QualificationVisionService {
  provider: string;
  model: string;
  baseUrl: string;
  apiKeyEnv?: string;
}

export interface QualificationTranscriptionProbe {
  inputPath: string;
  expectedText: string;
}

export interface ApplianceQualificationManifest {
  schema: 'openprojects.appliance-qualification.v1';
  requiredCapabilities: QualificationCapability[];
  requirePins: boolean;
  /** Separate VLM lane. This qualifies the endpoint but does not enable product image ingestion. */
  visionService?: QualificationVisionService;
  pins?: Record<string, QualificationTargetPin>;
  transcriptionProbe?: QualificationTranscriptionProbe;
}

export interface QualificationArtifactIdentity {
  path: string;
  bytes: number;
  sha256: string;
}

export interface QualificationIdentity {
  expectedProvider: string;
  expectedModel: string;
  observedModel?: string;
  serviceDigest?: string;
  runtime?: string;
  artifacts?: QualificationArtifactIdentity[];
  runtimeEvidence?: {
    implementation: string;
    version: string;
    artifacts: QualificationArtifactIdentity[];
  };
}

export interface QualificationPinResult {
  required: boolean;
  declared: boolean;
  strong: boolean;
  servedModelId?: string;
  matched: boolean;
  detail: string;
}

export interface QualificationTargetReport {
  id: string;
  capability: QualificationCapability;
  required: boolean;
  configured: boolean;
  reachable: boolean;
  capabilityQualified: boolean;
  identityQualified: boolean;
  qualified: boolean;
  stage: QualificationStage;
  provider: string;
  model: string;
  endpoint?: string;
  identity: QualificationIdentity;
  pin: QualificationPinResult;
  detail: string;
  durationMs: number;
}

export interface ApplianceQualificationReport {
  schema: 'openprojects.appliance-qualification-report.v1';
  generatedAt: string;
  overall: 'qualified' | 'partial' | 'not_qualified';
  nonMutatingIntent: true;
  persistentHarnessStateWritesAttempted: false;
  downloadsAttempted: false;
  host: {
    platform: NodeJS.Platform;
    architecture: string;
    memoryGiB: number;
  };
  posture: {
    sealedLocal: boolean;
    localOnly: boolean;
    zeroAllowedOrigins: boolean;
    telegramDisabled: boolean;
    allInferenceLoopback: boolean;
    allEnabledRoutesDeclaredLocal: boolean;
  };
  requiredCapabilities: QualificationCapability[];
  caveats: string[];
  targets: QualificationTargetReport[];
}

export interface ApplianceQualificationOptions {
  manifest?: ApplianceQualificationManifest;
  /** Used to resolve relative paths in an in-memory manifest. */
  manifestDirectory?: string;
  requiredCapabilities?: QualificationCapability[];
  timeoutMs?: number;
  fetch?: typeof fetch;
  now?: () => Date;
  /** Test seam for fixture ordering; production uses cryptographic randomness. */
  random?: () => number;
}

interface TextTarget {
  id: string;
  provider: string;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  contextWindow?: number;
  declaredLocal?: boolean;
  credentialsConfigured?: boolean;
}

interface ServiceIdentity {
  model: string;
  digest?: string;
  runtime?: string;
}

interface SnapshotInventoryEntry {
  path: string;
  relativePath: string;
  bytes: number;
  device: number;
  inode: number;
  modifiedMs: number;
}

class QualificationStageError extends Error {
  constructor(
    readonly report: QualificationTargetReport,
    readonly qualificationCause: unknown,
  ) {
    super(qualificationCause instanceof Error ? qualificationCause.message : String(qualificationCause));
    this.name = 'QualificationStageError';
  }
}

/**
 * Runs sequential, bounded, non-mutating qualification probes. It never pulls,
 * installs, starts, stops, or rewrites a model or service. Local inference may
 * populate caches owned by the separately managed runtime.
 */
export async function runApplianceQualification(
  config: AppConfig,
  options: ApplianceQualificationOptions = {},
): Promise<ApplianceQualificationReport> {
  const timeoutMs = boundedTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const deadlineAt = performance.now() + timeoutMs;
  const request = options.fetch ?? fetch;
  const manifest = options.manifest
    ? resolveManifestPaths(validateManifest(options.manifest), options.manifestDirectory ?? process.cwd())
    : undefined;
  const requiredCapabilities = uniqueCapabilities(
    options.requiredCapabilities
      ?? manifest?.requiredCapabilities
      ?? defaultRequiredCapabilities(config),
  );
  const networkPolicy = createNetworkPolicy(config.privacy);
  const secrets = configuredSecrets(config, manifest);
  const reports: QualificationTargetReport[] = [];
  const textTargets = configuredTextTargets(config);
  const textRequired = requiredCapabilities.includes('text');

  for (const target of textTargets) {
    reports.push(textRequired
      ? await guardedProbe(
          () => qualifyTextTarget(target, {
            capability: 'text',
            required: true,
            ...(manifest?.pins?.[target.id] ? { pin: manifest.pins[target.id] } : {}),
            requirePins: manifest?.requirePins === true,
            timeoutMs,
            deadlineAt,
            request,
            networkPolicy,
          }),
          fallbackTarget(target, 'text', true, manifest),
          secrets,
        )
      : unprobedTarget(target, 'text'));
  }

  if (textTargets.length === 0 && textRequired) {
    reports.push(missingTarget('model', 'text', 'No non-mock text model is enabled'));
  }

  const embeddingsRequired = requiredCapabilities.includes('embeddings');
  reports.push(embeddingsRequired
    ? await guardedProbe(
        () => qualifyEmbeddings(config, {
          required: true,
          ...(manifest?.pins?.embeddings ? { pin: manifest.pins.embeddings } : {}),
          requirePins: manifest?.requirePins === true,
          timeoutMs,
          deadlineAt,
          request,
          networkPolicy,
        }),
        fallbackEmbeddingTarget(config, true, manifest),
        secrets,
      )
    : unprobedEmbeddingTarget(config));

  const transcriptionRequired = requiredCapabilities.includes('transcription');
  reports.push(transcriptionRequired
    ? await guardedProbe(
        () => qualifyTranscription(config, {
          required: true,
          ...(manifest?.pins?.transcription ? { pin: manifest.pins.transcription } : {}),
          requirePins: manifest?.requirePins === true,
          ...(manifest?.transcriptionProbe ? { probe: manifest.transcriptionProbe } : {}),
          timeoutMs,
          deadlineAt,
        }),
        fallbackTranscriptionTarget(config, true, manifest),
        secrets,
      )
    : unprobedTranscriptionTarget(config));

  const visionRequired = requiredCapabilities.includes('vision');
  if (visionRequired || manifest?.visionService) {
    if (!manifest?.visionService) {
      reports.push(missingTarget(
        'vision',
        'vision',
        'Vision qualification requires a manifest visionService; OpenProjects image ingestion remains unsupported',
      ));
    } else {
      const visionApiKey = manifest.visionService.apiKeyEnv
        ? process.env[manifest.visionService.apiKeyEnv]
        : undefined;
      const target: TextTarget = {
        id: 'vision',
        provider: manifest.visionService.provider,
        model: manifest.visionService.model,
        baseUrl: manifest.visionService.baseUrl,
        ...(visionApiKey ? { apiKey: visionApiKey } : {}),
        credentialsConfigured: Boolean(manifest.visionService.apiKeyEnv),
      };
      if (visionRequired && manifest.visionService.apiKeyEnv && !visionApiKey) {
        reports.push({
          ...fallbackTarget(target, 'vision', true, manifest),
          detail: `Vision credential environment variable ${manifest.visionService.apiKeyEnv} is not configured`,
        });
      } else {
        reports.push(visionRequired
          ? await guardedProbe(
            () => qualifyVisionTarget(target, {
              required: true,
              ...(manifest.pins?.vision ? { pin: manifest.pins.vision } : {}),
              requirePins: manifest.requirePins,
              timeoutMs,
              deadlineAt,
              request,
              networkPolicy,
            fixturePattern: chooseVisionFixturePattern(options.random),
            }),
            fallbackTarget(target, 'vision', true, manifest),
            secrets,
          )
          : unprobedTarget(target, 'vision'));
      }
    }
  }

  ensureRequiredCapabilityTargets(reports, requiredCapabilities);
  const posture = qualificationPosture(config, textTargets, manifest);
  const required = reports.filter((target) => target.required);
  const overall = posture.sealedLocal && required.length > 0 && required.every((target) => target.qualified)
    ? 'qualified'
    : reports.some((target) => target.reachable || target.capabilityQualified)
      ? 'partial'
      : 'not_qualified';
  const report: ApplianceQualificationReport = {
    schema: 'openprojects.appliance-qualification-report.v1',
    generatedAt: (options.now?.() ?? new Date()).toISOString(),
    overall,
    nonMutatingIntent: true,
    persistentHarnessStateWritesAttempted: false,
    downloadsAttempted: false,
    host: {
      platform: platform(),
      architecture: arch(),
      memoryGiB: Math.round((totalmem() / 1024 ** 3) * 10) / 10,
    },
    posture,
    requiredCapabilities,
    caveats: [
      'Qualification proves only this bounded probe on this host; it is not a model-quality or security certification.',
      'Vision directly probes the declared local VLM with a randomized three-request pattern over two embedded 95/96-byte PNGs; OpenProjects product image ingestion is not implemented.',
      'The qualifier issues no model pull, download, install, or promotion request. Run inference services offline-sealed because a runtime may otherwise lazily fetch, cache, or log.',
      'Whisper capability qualification creates and removes bounded temporary working files; no persistent OpenProjects state is written.',
      'A qualified private-appliance report additionally requires localOnly, zero allowlisted origins, Telegram disabled, loopback inference endpoints, and local:true on every enabled non-mock route.',
    ],
    targets: reports,
  };
  return report;
}

export async function loadQualificationManifest(path: string): Promise<ApplianceQualificationManifest> {
  const absolutePath = resolve(path);
  const info = await lstat(absolutePath);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error('Qualification manifest must be a regular non-symlink file');
  }
  if (info.size > MAX_MANIFEST_BYTES) {
    throw new Error(`Qualification manifest exceeds ${MAX_MANIFEST_BYTES} bytes`);
  }
  const source = await readFile(absolutePath, 'utf8');
  return parseQualificationManifest(source, absolutePath);
}

/** Parses already-read evidence so callers can hash and validate the exact same bytes. */
export function parseQualificationManifest(
  source: string,
  path = 'appliance-qualification.json',
): ApplianceQualificationManifest {
  const absolutePath = resolve(path);
  const duplicateCheck = YAML.parseDocument(source, { uniqueKeys: true });
  if (duplicateCheck.errors.length > 0) {
    throw new Error(`Qualification manifest contains invalid or duplicate JSON keys: ${safeText(duplicateCheck.errors[0]!.message)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch (error) {
    throw new Error(`Qualification manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return resolveManifestPaths(validateManifest(parsed), dirname(absolutePath));
}

export function renderApplianceQualification(report: ApplianceQualificationReport): string {
  const lines = [
    `OpenProjects appliance qualification: ${report.overall.toUpperCase().replace('_', ' ')}`,
    `Host: ${report.host.platform}/${report.host.architecture}, ${report.host.memoryGiB.toFixed(1)} GiB`,
    `Required: ${report.requiredCapabilities.join(', ') || 'none'}; no persistent harness-state writes or pull/install requests issued`,
    `Private posture: ${report.posture.sealedLocal ? 'SEALED LOCAL' : 'NOT SEALED'} (loopback inference=${yesNo(report.posture.allInferenceLoopback)}, routes local=${yesNo(report.posture.allEnabledRoutesDeclaredLocal)})`,
  ];
  for (const target of report.targets) {
    const required = target.required ? 'required' : 'optional';
    lines.push(
      `${target.qualified ? '✓' : target.reachable ? '!' : '✗'} ${target.id} [${target.capability}; ${required}] `
        + `configured=${yesNo(target.configured)} reachable=${yesNo(target.reachable)} `
        + `capability-qualified=${yesNo(target.capabilityQualified)} identity-qualified=${yesNo(target.identityQualified)}`,
    );
    lines.push(`  ${target.provider}/${target.model}: ${target.detail}`);
    if (target.identity.serviceDigest) lines.push(`  service digest: ${target.identity.serviceDigest}`);
    for (const artifact of target.identity.artifacts ?? []) {
      lines.push(`  sha256 ${artifact.sha256}  ${artifact.path} (${artifact.bytes} bytes)`);
    }
    lines.push(`  pin: ${target.pin.detail}`);
  }
  for (const caveat of report.caveats) lines.push(`Note: ${caveat}`);
  return `${lines.join('\n')}\n`;
}

interface ServiceProbeOptions {
  capability: 'text';
  required: boolean;
  pin?: QualificationTargetPin;
  requirePins: boolean;
  timeoutMs: number;
  deadlineAt: number;
  request: typeof fetch;
  networkPolicy: OutboundNetworkPolicy;
}

async function qualifyTextTarget(
  target: TextTarget,
  options: ServiceProbeOptions,
): Promise<QualificationTargetReport> {
  const startedAt = performance.now();
  if (!target.baseUrl) throw new Error(`${target.id} has no baseUrl`);
  assertStrictRuntimeContract(target);
  assertPinMatchesConfiguration(target, options.pin);
  await validateMlxServedModelPath(target, options.pin);
  assertLoopbackTarget(target.baseUrl, target.id);
  options.networkPolicy.assertAllowed(target.baseUrl, `qualification target ${target.id}`);
  const endpoint = chatEndpoint(target.baseUrl);
  const serviceIdentity = await discoverServiceIdentity(target, options);
  try {
    const artifactIdentity = await hashQualifiedArtifacts(target, options.pin, options.deadlineAt);
    const pin = pinResult(options.pin, options.requirePins && options.required, serviceIdentity, artifactIdentity);
    const textResponse = await requestJson(options.request, endpoint, {
      method: 'POST',
      headers: requestHeaders(target.apiKey),
      body: JSON.stringify({
        ...requestModelField(target, options.pin),
        ...parallelToolControl(target.provider),
        messages: [{ role: 'user', content: 'Reply with one short non-empty readiness sentence.' }],
        tools: [],
        max_tokens: 32,
        stream: false,
      }),
      redirect: 'error',
      signal: AbortSignal.timeout(remainingTimeout(options.deadlineAt)),
    });
    validateTextOnlyTurn(textResponse, strictToolProviderLabel(target.provider), 'initial');
    validateInferenceModelIdentity(target, serviceIdentity, textResponse);
    const nonce = `OP_${createHash('sha256').update(`${target.id}:${Date.now()}`).digest('hex').slice(0, 16)}`;
    const response = await requestJson(options.request, endpoint, {
      method: 'POST',
      headers: requestHeaders(target.apiKey),
      body: JSON.stringify({
        ...requestModelField(target, options.pin),
        ...parallelToolControl(target.provider),
        messages: [{
          role: 'user',
          content: `Call qualification_echo exactly once with value ${nonce}. Do not answer in text.`,
        }],
        tools: [qualificationEchoTool()],
        ...(isMlxLmProvider(target.provider) ? {} : { tool_choice: 'auto' }),
        max_tokens: 64,
        stream: false,
      }),
      redirect: 'error',
      signal: AbortSignal.timeout(remainingTimeout(options.deadlineAt)),
    });
    validateInferenceModelIdentity(target, serviceIdentity, response);
    const toolCall = validateToolEcho(response, nonce, strictToolProviderLabel(target.provider));
    const finalResponse = await requestJson(options.request, endpoint, {
      method: 'POST',
      headers: requestHeaders(target.apiKey),
      body: JSON.stringify({
        ...requestModelField(target, options.pin),
        ...parallelToolControl(target.provider),
        messages: [
          {
            role: 'user',
            content: `Call qualification_echo exactly once with value ${nonce}. Do not answer in text.`,
          },
          {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: toolCall.id,
              type: 'function',
              function: { name: 'qualification_echo', arguments: JSON.stringify({ value: nonce }) },
            }],
          },
          {
            role: 'tool',
            tool_call_id: toolCall.id,
            name: 'qualification_echo',
            content: JSON.stringify({ ok: true, value: nonce }),
          },
        ],
        tools: [qualificationEchoTool()],
        ...(isMlxLmProvider(target.provider) ? {} : { tool_choice: 'auto' }),
        max_tokens: 32,
        stream: false,
      }),
      redirect: 'error',
      signal: AbortSignal.timeout(remainingTimeout(options.deadlineAt)),
    });
    validateTextOnlyTurn(finalResponse, strictToolProviderLabel(target.provider), 'final');
    validateInferenceModelIdentity(target, serviceIdentity, finalResponse);
    const identityQualified = serviceIdentityQualified(target, serviceIdentity, pin);
    return completedTarget({
      target,
      capability: options.capability,
      required: options.required,
      endpoint,
      serviceIdentity,
      artifactIdentity,
      ...(options.pin ? { targetPin: options.pin } : {}),
      pin,
      capabilityQualified: true,
      identityQualified,
      detail: `The listed model produced plain text, exactly one qualification_echo call, and final text after its tool result${target.contextWindow ? `; configured context ${target.contextWindow}` : ''}`,
      startedAt,
    });
  } catch (error) {
    throw reachableFailure(target, options.capability, options.required, endpoint, serviceIdentity, startedAt, error);
  }
}

interface VisionProbeOptions extends Omit<ServiceProbeOptions, 'capability'> {
  fixturePattern: number;
}

async function qualifyVisionTarget(
  target: TextTarget,
  options: VisionProbeOptions,
): Promise<QualificationTargetReport> {
  const startedAt = performance.now();
  if (!target.baseUrl) throw new Error('visionService has no baseUrl');
  assertStrictRuntimeContract(target);
  assertPinMatchesConfiguration(target, options.pin);
  await validateMlxServedModelPath(target, options.pin);
  assertLoopbackTarget(target.baseUrl, target.id);
  options.networkPolicy.assertAllowed(target.baseUrl, 'qualification target vision');
  const endpoint = chatEndpoint(target.baseUrl);
  const serviceIdentity = await discoverServiceIdentity(target, { ...options, capability: 'text' });
  try {
    const artifactIdentity = await hashQualifiedArtifacts(target, options.pin, options.deadlineAt);
    const pin = pinResult(options.pin, options.requirePins && options.required, serviceIdentity, artifactIdentity);
    const blue = VISION_FIXTURES[0];
    const red = VISION_FIXTURES[1];
    const patterns = [
      [blue, blue, red],
      [red, blue, blue],
      [red, red, blue],
      [blue, red, red],
    ] as const;
    const fixtures = patterns[options.fixturePattern];
    if (!fixtures) throw new Error('Vision fixture pattern is outside its bounded range');
    for (const fixture of fixtures) {
      const pngBytes = Buffer.from(fixture.base64, 'base64');
      if (pngBytes.length !== fixture.bytes) throw new Error('Bundled vision qualification fixture failed its byte bound');
      const response = await requestJson(options.request, endpoint, {
        method: 'POST',
        headers: requestHeaders(target.apiKey),
        body: JSON.stringify({
          ...requestModelField(target, options.pin),
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: 'Name the dominant color in the attached image using one uppercase English color word.' },
              { type: 'image_url', image_url: { url: `data:image/png;base64,${fixture.base64}` } },
            ],
          }],
          max_tokens: 16,
          temperature: 0,
          stream: false,
        }),
        redirect: 'error',
        signal: AbortSignal.timeout(remainingTimeout(options.deadlineAt)),
      });
      const content = responseContent(response).trim().replace(/[.!]+$/u, '').toLocaleUpperCase('en-US');
      if (content !== fixture.expected) throw new Error('VLM did not correctly identify both bounded local PNG fixtures');
      validateInferenceModelIdentity(target, serviceIdentity, response);
    }
    const identityQualified = serviceIdentityQualified(target, serviceIdentity, pin);
    return completedTarget({
      target,
      capability: 'vision',
      required: options.required,
      endpoint,
      serviceIdentity,
      artifactIdentity,
      ...(options.pin ? { targetPin: options.pin } : {}),
      pin,
      capabilityQualified: true,
      identityQualified,
      detail: 'Local VLM passed a randomized three-request pattern over two embedded 95/96-byte color PNGs; this does not enable OpenProjects image ingestion',
      startedAt,
    });
  } catch (error) {
    throw reachableFailure(target, 'vision', options.required, endpoint, serviceIdentity, startedAt, error);
  }
}

interface EmbeddingProbeOptions {
  required: boolean;
  pin?: QualificationTargetPin;
  requirePins: boolean;
  timeoutMs: number;
  deadlineAt: number;
  request: typeof fetch;
  networkPolicy: OutboundNetworkPolicy;
}

async function qualifyEmbeddings(
  config: AppConfig,
  options: EmbeddingProbeOptions,
): Promise<QualificationTargetReport> {
  const startedAt = performance.now();
  const embedding = config.embeddings ?? {
    provider: 'builtin' as const,
    model: 'builtin-hash-v1',
    dimensions: 256,
    timeoutMs: 3_000,
  };
  const target: TextTarget = {
    id: 'embeddings',
    provider: embedding.provider,
    model: embedding.model,
    ...(embedding.baseUrl ? { baseUrl: embedding.baseUrl } : {}),
  };
  assertPinMatchesConfiguration(target, options.pin);
  let vectors: number[][];
  let serviceIdentity: ServiceIdentity;
  if (embedding.provider === 'builtin') {
    serviceIdentity = { model: embedding.model, runtime: 'in-process deterministic feature hashing' };
    try {
      vectors = await new DeterministicHashEmbeddingAdapter({
        id: embedding.model,
        dimensions: embedding.dimensions,
      }).embed(['OpenProjects deadline risk', 'OpenProjects credential blocker']);
    } catch (error) {
      throw reachableFailure(target, 'embeddings', options.required, undefined, serviceIdentity, startedAt, error);
    }
  } else {
    if (options.requirePins && options.required) {
      if (!embedding.serviceDigest) {
        throw new Error('Required Ollama semantic embeddings must configure serviceDigest at runtime');
      }
      if (options.pin?.serviceDigest !== embedding.serviceDigest) {
        throw new Error('Runtime embedding serviceDigest does not match the qualification manifest');
      }
    }
    const baseUrl = embedding.baseUrl ?? 'http://127.0.0.1:11434';
    assertLoopbackTarget(baseUrl, 'embeddings');
    options.networkPolicy.assertAllowed(baseUrl, 'qualification target embeddings');
    serviceIdentity = await discoverServiceIdentity(
      { ...target, baseUrl },
      {
        capability: 'text',
        required: options.required,
        ...(options.pin ? { pin: options.pin } : {}),
        requirePins: options.requirePins,
        timeoutMs: options.timeoutMs,
        deadlineAt: options.deadlineAt,
        request: options.request,
        networkPolicy: options.networkPolicy,
      },
    );
    try {
      const semanticInputs = embeddingSemanticInputs(embedding.model);
      const embeddingBody = await requestJson(options.request, ollamaEmbedEndpoint(baseUrl), {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({
          model: embedding.model,
          input: semanticInputs,
          dimensions: embedding.dimensions,
          truncate: false,
        }),
        redirect: 'error',
        signal: AbortSignal.timeout(Math.min(embedding.timeoutMs, remainingTimeout(options.deadlineAt))),
      });
      if (!isRecord(embeddingBody) || !Array.isArray(embeddingBody.embeddings)) {
        throw new Error('Ollama response does not contain an embeddings array');
      }
      if (typeof embeddingBody.model === 'string' && !modelIdentitiesMatch(embeddingBody.model, embedding.model)) {
        throw new Error('Ollama embedding response model does not match configured model');
      }
      vectors = embeddingBody.embeddings.map((value, index) => {
        if (!Array.isArray(value) || value.some((item) => typeof item !== 'number' || !Number.isFinite(item))) {
          throw new Error(`Ollama embedding ${index} is not a finite numeric vector`);
        }
        return value as number[];
      });
    } catch (error) {
      throw reachableFailure(target, 'embeddings', options.required, baseUrl, serviceIdentity, startedAt, error);
    }
  }
  validateEmbeddingVectors(vectors, embedding.dimensions, embedding.provider === 'builtin' ? 2 : 12);
  const semantic = embedding.provider === 'builtin' ? undefined : validateSemanticEmbeddingRanking(vectors);
  const artifactIdentity = await hashAllPinnedArtifacts(options.pin, options.deadlineAt);
  const pin = pinResult(options.pin, options.requirePins && options.required, serviceIdentity, artifactIdentity);
  const identityQualified = serviceIdentityQualified(target, serviceIdentity, pin);
  const semanticModelQualified = embedding.provider !== 'builtin';
  return completedTarget({
    target,
    capability: 'embeddings',
    required: options.required,
    ...(target.baseUrl ? { endpoint: target.baseUrl } : {}),
    serviceIdentity,
    artifactIdentity,
    ...(options.pin ? { targetPin: options.pin } : {}),
    pin,
    capabilityQualified: semanticModelQualified,
    identityQualified,
    detail: embedding.provider === 'builtin'
      ? `In-process feature hashing returned two distinct finite ${embedding.dimensions}-dimension vectors, but it does not qualify a semantic embedding model`
      : `Live local model passed four project-domain semantic ranking triplets (${embedding.dimensions} dimensions; minimum cosine margin ${semantic!.minimumMargin.toFixed(3)}, mean ${semantic!.meanMargin.toFixed(3)})`,
    startedAt,
  });
}

interface TranscriptionProbeOptions {
  required: boolean;
  pin?: QualificationTargetPin;
  requirePins: boolean;
  probe?: QualificationTranscriptionProbe;
  timeoutMs: number;
  deadlineAt: number;
}

async function qualifyTranscription(
  config: AppConfig,
  options: TranscriptionProbeOptions,
): Promise<QualificationTargetReport> {
  const startedAt = performance.now();
  const transcription = config.transcription;
  const target: TextTarget = {
    id: 'transcription',
    provider: transcription?.provider ?? 'disabled',
    model: transcription?.modelPath ?? 'none',
  };
  if (!transcription || transcription.provider === 'disabled') {
    return baseTarget({
      target,
      capability: 'transcription',
      required: options.required,
      configured: false,
      reachable: false,
      capabilityQualified: false,
      identityQualified: false,
      pin: undeclaredPin(options.requirePins && options.required),
      detail: 'Local transcription is disabled',
      startedAt,
    });
  }
  if (!transcription.modelPath) throw new Error('transcription.modelPath is not configured');
  assertPinMatchesConfiguration(target, options.pin);
  const command = await resolveExecutable(transcription.command);
  const ffmpeg = await resolveExecutable(transcription.ffmpegCommand);
  const [whisperVersion, ffmpegVersion] = await Promise.all([
    runVersion(command, ['--help'], remainingTimeout(options.deadlineAt)),
    runVersion(ffmpeg, ['-version'], remainingTimeout(options.deadlineAt)),
  ]);
  const modelIdentity = await hashArtifact({ path: transcription.modelPath, sha256: undefined }, options.deadlineAt);
  const pinnedArtifactIdentity = await hashAllPinnedArtifacts(options.pin, options.deadlineAt);
  const allArtifacts = mergeArtifacts([modelIdentity], pinnedArtifactIdentity);
  const serviceIdentity: ServiceIdentity = {
    model: transcription.modelPath,
    runtime: `${basename(command)} ${firstLine(whisperVersion)}; ${basename(ffmpeg)} ${firstLine(ffmpegVersion)}`,
  };
  const pin = pinResult(options.pin, options.requirePins && options.required, serviceIdentity, allArtifacts);
  let capabilityQualified = false;
  let detail = 'whisper.cpp, FFmpeg, and the configured model are readable, but no known-audio probe is declared';
  if (options.probe) {
    try {
      const input = await requireRegularFile(options.probe.inputPath, 'Transcription probe input');
      const adapter = new WhisperCppTranscriptionAdapter({
        command,
        modelPath: transcription.modelPath,
        ffmpegCommand: ffmpeg,
        timeoutMs: Math.min(transcription.timeoutMs, remainingTimeout(options.deadlineAt)),
        maxBytes: transcription.maxBytes,
        ...(transcription.language ? { language: transcription.language } : {}),
      });
      const result = await adapter.transcribe(input, AbortSignal.timeout(remainingTimeout(options.deadlineAt)));
      const expected = normalizeTranscript(options.probe.expectedText);
      const actual = normalizeTranscript(result.text);
      if (!expected || !actual.includes(expected)) {
        throw new Error('Whisper transcript did not contain the manifest expectedText');
      }
      capabilityQualified = true;
      detail = `Known-audio probe matched ${JSON.stringify(options.probe.expectedText)} using local whisper.cpp`;
    } catch (error) {
      throw reachableFailure(target, 'transcription', options.required, undefined, serviceIdentity, startedAt, error, allArtifacts, pin);
    }
  }
  const identityQualified = pin.matched;
  return completedTarget({
    target,
    capability: 'transcription',
    required: options.required,
    serviceIdentity,
    artifactIdentity: allArtifacts,
    ...(options.pin ? { targetPin: options.pin } : {}),
    pin,
    capabilityQualified,
    identityQualified,
    detail,
    startedAt,
  });
}

async function discoverServiceIdentity(
  target: TextTarget,
  options: ServiceProbeOptions,
): Promise<ServiceIdentity> {
  if (!target.baseUrl) throw new Error(`${target.id} has no baseUrl`);
  const provider = target.provider.toLocaleLowerCase('en-US');
  let freeTokenRuntime: string | undefined;
  if (isMlxProvider(target.provider)) {
    const health = healthEndpoint(target.baseUrl);
    options.networkPolicy.assertAllowed(health, `qualification health ${target.id}`);
    const healthBody = await requestJson(options.request, health, {
      method: 'GET',
      headers: requestHeaders(target.apiKey),
      redirect: 'error',
      signal: AbortSignal.timeout(remainingTimeout(options.deadlineAt)),
    });
    if (provider === 'mlx-vlm') {
      assertMlxVlmHealth(
        healthBody,
        options.pin?.servedModelId ?? target.model,
      );
    }
  }
  if (provider === 'freetoken') {
    const health = healthEndpoint(target.baseUrl);
    options.networkPolicy.assertAllowed(health, `qualification health ${target.id}`);
    const healthBody = await requestJson(options.request, health, {
      method: 'GET',
      headers: requestHeaders(target.apiKey),
      redirect: 'error',
      signal: AbortSignal.timeout(remainingTimeout(options.deadlineAt)),
    });
    freeTokenRuntime = assertFreeTokenHealth(healthBody, target.model, options.pin);
  }
  const endpoint = provider === 'ollama'
    ? ollamaTagsEndpoint(target.baseUrl)
    : modelsEndpoint(target.baseUrl);
  options.networkPolicy.assertAllowed(endpoint, `qualification identity ${target.id}`);
  const body = await requestJson(options.request, endpoint, {
    method: 'GET',
    headers: requestHeaders(target.apiKey),
    redirect: 'error',
    signal: AbortSignal.timeout(remainingTimeout(options.deadlineAt)),
  });
  if (provider === 'ollama') return ollamaIdentity(body, target.model);
  const exactSingleton = requiresExactSingletonInventory(target.provider);
  return openAiIdentity(
    body,
    isMlxProvider(target.provider)
      ? options.pin?.servedModelId ?? target.model
      : target.model,
    provider === 'mlx-lm'
      ? 'MLX-LM OpenAI server'
      : provider === 'mlx-vlm'
        ? 'MLX-VLM OpenAI server'
        : provider === 'freetoken'
          ? freeTokenRuntime
          : undefined,
    exactSingleton,
    provider === 'mlx-lm'
      ? 'MLX-LM'
      : provider === 'mlx-vlm'
        ? 'MLX-VLM'
        : provider === 'freetoken'
          ? 'FreeToken'
          : provider === 'llama.cpp'
            ? 'llama.cpp'
            : 'OpenAI-compatible service',
  );
}

function assertFreeTokenHealth(
  value: unknown,
  expectedModel: string,
  pin: QualificationTargetPin | undefined,
): string {
  if (
    !isRecord(value)
    || value.status !== 'ok'
    || value.model !== expectedModel
    || value.maintenance !== 'serving'
    || typeof value.instance_id !== 'string'
    || !value.instance_id
    || value.instance_id.length > 256
    || typeof value.version !== 'string'
    || !value.version
    || value.version.length > 128
  ) {
    throw new Error(
      'FreeToken /health must report status ok, maintenance serving, the exact model alias, instance_id, and version',
    );
  }
  if (pin?.runtime && pin.runtime.version !== value.version) {
    throw new Error('FreeToken /health version does not match the pinned runtime version');
  }
  return `FreeToken@${value.version}`;
}

function assertMlxVlmHealth(value: unknown, expectedModel: string): void {
  if (
    !isRecord(value)
    || value.status !== 'healthy'
    || value.loaded_model !== expectedModel
  ) {
    throw new Error('MLX-VLM /health must report status healthy and the exact canonical loaded_model');
  }
}

function ollamaIdentity(value: unknown, expectedModel: string): ServiceIdentity {
  if (!isRecord(value) || !Array.isArray(value.models)) {
    throw new Error('Ollama /api/tags did not return a models array');
  }
  for (const item of value.models) {
    if (!isRecord(item)) continue;
    const model = typeof item.model === 'string'
      ? item.model
      : typeof item.name === 'string'
        ? item.name
        : undefined;
    if (!model || !modelIdentitiesMatch(model, expectedModel)) continue;
    return {
      model,
      ...(typeof item.digest === 'string' ? { digest: item.digest } : {}),
      runtime: 'Ollama',
    };
  }
  throw new Error(`Ollama does not list configured model ${safeText(expectedModel)}; qualification never pulls it`);
}

function openAiIdentity(
  value: unknown,
  expectedModel: string,
  runtime?: string,
  requireExactSingleton = false,
  runtimeLabel = 'OpenAI-compatible service',
): ServiceIdentity {
  if (!isRecord(value) || !Array.isArray(value.data)) {
    throw new Error('OpenAI-compatible /models did not return a data array');
  }
  if (requireExactSingleton) {
    if (value.data.length !== 1
        || !isRecord(value.data[0])
        || value.data[0].id !== expectedModel) {
      throw new Error(`${runtimeLabel} /models must list exactly one canonical servedModelId`);
    }
    return { model: expectedModel, ...(runtime ? { runtime } : {}) };
  }
  for (const item of value.data) {
    if (!isRecord(item) || typeof item.id !== 'string') continue;
    if (modelIdentitiesMatch(item.id, expectedModel)) {
      return { model: item.id, ...(runtime ? { runtime } : {}) };
    }
  }
  throw new Error(`Service does not list configured model ${safeText(expectedModel)}`);
}

function configuredTextTargets(config: AppConfig): TextTarget[] {
  if (config.routing?.routes.length) {
    return config.routing.routes
      .filter((route) => route.enabled && route.provider !== 'mock')
      .map(routeTarget);
  }
  if (config.model.provider === 'mock') return [];
  return [{
    id: 'model',
    provider: config.model.provider,
    model: config.model.model,
    ...(config.model.baseUrl ? { baseUrl: config.model.baseUrl } : {}),
    ...(config.model.apiKey ? { apiKey: config.model.apiKey } : {}),
    credentialsConfigured: Boolean(config.model.apiKey),
  }];
}

function routeTarget(route: ModelRouteConfig): TextTarget {
  const apiKey = route.apiKey ?? (route.apiKeyEnv ? process.env[route.apiKeyEnv] : undefined);
  return {
    id: `route:${route.id}`,
    provider: route.provider,
    model: route.model,
    ...(route.baseUrl ? { baseUrl: route.baseUrl } : {}),
    ...(apiKey ? { apiKey } : {}),
    contextWindow: route.contextWindow,
    declaredLocal: route.local,
    credentialsConfigured: Boolean(route.apiKey || route.apiKeyEnv),
  };
}

function completedTarget(input: {
  target: TextTarget;
  capability: QualificationCapability;
  required: boolean;
  endpoint?: string;
  serviceIdentity: ServiceIdentity;
  artifactIdentity: QualificationArtifactIdentity[];
  targetPin?: QualificationTargetPin;
  pin: QualificationPinResult;
  capabilityQualified: boolean;
  identityQualified: boolean;
  detail: string;
  startedAt: number;
}): QualificationTargetReport {
  return baseTarget({
    target: input.target,
    capability: input.capability,
    required: input.required,
    configured: true,
    reachable: true,
    capabilityQualified: input.capabilityQualified,
    identityQualified: input.identityQualified,
    ...(input.endpoint ? { endpoint: publicEndpoint(input.endpoint) } : {}),
    identity: {
      expectedProvider: input.target.provider,
      expectedModel: input.target.model,
      observedModel: input.serviceIdentity.model,
      ...(input.serviceIdentity.digest ? { serviceDigest: input.serviceIdentity.digest } : {}),
      ...(input.serviceIdentity.runtime ? { runtime: input.serviceIdentity.runtime } : {}),
      ...(input.artifactIdentity.length ? { artifacts: input.artifactIdentity } : {}),
      ...runtimeIdentity(input.targetPin, input.artifactIdentity),
    },
    pin: input.pin,
    detail: input.detail,
    startedAt: input.startedAt,
  });
}

function baseTarget(input: {
  target: TextTarget;
  capability: QualificationCapability;
  required: boolean;
  configured: boolean;
  reachable: boolean;
  capabilityQualified: boolean;
  identityQualified: boolean;
  endpoint?: string;
  identity?: QualificationIdentity;
  pin: QualificationPinResult;
  detail: string;
  startedAt: number;
}): QualificationTargetReport {
  const qualified = input.configured
    && input.reachable
    && input.capabilityQualified
    && input.identityQualified;
  const stage: QualificationStage = qualified
    ? 'qualified'
    : input.capabilityQualified
      ? 'capability_qualified'
      : input.reachable
        ? 'reachable'
        : input.configured
          ? 'configured'
          : 'not_configured';
  return {
    id: input.target.id,
    capability: input.capability,
    required: input.required,
    configured: input.configured,
    reachable: input.reachable,
    capabilityQualified: input.capabilityQualified,
    identityQualified: input.identityQualified,
    qualified,
    stage,
    provider: input.target.provider,
    model: input.target.model,
    ...(input.endpoint ? { endpoint: input.endpoint } : {}),
    identity: input.identity ?? {
      expectedProvider: input.target.provider,
      expectedModel: input.target.model,
    },
    pin: input.pin,
    detail: input.detail,
    durationMs: elapsed(input.startedAt),
  };
}

async function guardedProbe(
  operation: () => Promise<QualificationTargetReport>,
  fallback: QualificationTargetReport,
  secrets: string[],
): Promise<QualificationTargetReport> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof QualificationStageError) {
      return {
        ...error.report,
        detail: redactError(error.qualificationCause, secrets),
      };
    }
    return {
      ...fallback,
      detail: redactError(error, secrets),
      durationMs: Math.max(1, fallback.durationMs),
    };
  }
}

function reachableFailure(
  target: TextTarget,
  capability: QualificationCapability,
  required: boolean,
  endpoint: string | undefined,
  serviceIdentity: ServiceIdentity,
  startedAt: number,
  cause: unknown,
  artifacts: QualificationArtifactIdentity[] = [],
  pin: QualificationPinResult = undeclaredPin(false),
): QualificationStageError {
  return new QualificationStageError(baseTarget({
    target,
    capability,
    required,
    configured: true,
    reachable: true,
    capabilityQualified: false,
    identityQualified: false,
    ...(endpoint ? { endpoint: publicEndpoint(endpoint) } : {}),
    identity: {
      expectedProvider: target.provider,
      expectedModel: target.model,
      observedModel: serviceIdentity.model,
      ...(serviceIdentity.digest ? { serviceDigest: serviceIdentity.digest } : {}),
      ...(serviceIdentity.runtime ? { runtime: serviceIdentity.runtime } : {}),
      ...(artifacts.length ? { artifacts } : {}),
    },
    pin,
    detail: 'Capability probe failed after the target became reachable',
    startedAt,
  }), cause);
}

function fallbackTarget(
  target: TextTarget,
  capability: QualificationCapability,
  required: boolean,
  manifest?: ApplianceQualificationManifest,
): QualificationTargetReport {
  return baseTarget({
    target,
    capability,
    required,
    configured: Boolean(target.baseUrl),
    reachable: false,
    capabilityQualified: false,
    identityQualified: false,
    ...(target.baseUrl ? { endpoint: publicEndpoint(target.baseUrl) } : {}),
    pin: undeclaredPin(manifest?.requirePins === true && required),
    detail: 'Probe failed',
    startedAt: performance.now(),
  });
}

function unprobedTarget(
  target: TextTarget,
  capability: QualificationCapability,
): QualificationTargetReport {
  return baseTarget({
    target,
    capability,
    required: false,
    configured: Boolean(target.baseUrl),
    reachable: false,
    capabilityQualified: false,
    identityQualified: false,
    ...(target.baseUrl ? { endpoint: publicEndpoint(target.baseUrl) } : {}),
    pin: undeclaredPin(false),
    detail: 'Configured but not contacted in this selected qualification lane',
    startedAt: performance.now(),
  });
}

function unprobedEmbeddingTarget(config: AppConfig): QualificationTargetReport {
  const embedding = config.embeddings ?? {
    provider: 'builtin' as const,
    model: 'builtin-hash-v1',
    dimensions: 256,
    timeoutMs: 3_000,
  };
  return baseTarget({
    target: {
      id: 'embeddings',
      provider: embedding.provider,
      model: embedding.model,
      ...(embedding.baseUrl ? { baseUrl: embedding.baseUrl } : {}),
    },
    capability: 'embeddings',
    required: false,
    configured: true,
    reachable: false,
    capabilityQualified: false,
    identityQualified: false,
    ...(embedding.baseUrl ? { endpoint: publicEndpoint(embedding.baseUrl) } : {}),
    pin: undeclaredPin(false),
    detail: 'Configured but not contacted in this selected qualification lane',
    startedAt: performance.now(),
  });
}

function unprobedTranscriptionTarget(config: AppConfig): QualificationTargetReport {
  const transcription = config.transcription;
  const configured = transcription?.provider === 'whisper-cpp';
  return baseTarget({
    target: {
      id: 'transcription',
      provider: transcription?.provider ?? 'disabled',
      model: transcription?.modelPath ?? 'none',
    },
    capability: 'transcription',
    required: false,
    configured,
    reachable: false,
    capabilityQualified: false,
    identityQualified: false,
    pin: undeclaredPin(false),
    detail: configured
      ? 'Configured but not executed in this selected qualification lane'
      : 'Local transcription is disabled',
    startedAt: performance.now(),
  });
}

function qualificationPosture(
  config: AppConfig,
  textTargets: TextTarget[],
  manifest?: ApplianceQualificationManifest,
): ApplianceQualificationReport['posture'] {
  const localOnly = config.privacy?.localOnly ?? true;
  const zeroAllowedOrigins = (config.privacy?.allowedOrigins.length ?? 0) === 0;
  const telegramDisabled = config.telegram?.enabled !== true;
  const endpointValues = [
    ...textTargets.map((target) => target.baseUrl),
    config.embeddings?.provider === 'ollama'
      ? config.embeddings.baseUrl ?? 'http://127.0.0.1:11434'
      : undefined,
    manifest?.visionService?.baseUrl,
  ].filter((value): value is string => Boolean(value));
  const allInferenceLoopback = endpointValues.every(isLoopbackUrl);
  const allEnabledRoutesDeclaredLocal = (config.routing?.routes ?? [])
    .filter((route) => route.enabled && route.provider !== 'mock')
    .every((route) => route.local === true);
  return {
    sealedLocal: localOnly
      && zeroAllowedOrigins
      && telegramDisabled
      && allInferenceLoopback
      && allEnabledRoutesDeclaredLocal,
    localOnly,
    zeroAllowedOrigins,
    telegramDisabled,
    allInferenceLoopback,
    allEnabledRoutesDeclaredLocal,
  };
}

function fallbackEmbeddingTarget(
  config: AppConfig,
  required: boolean,
  manifest?: ApplianceQualificationManifest,
): QualificationTargetReport {
  const embedding = config.embeddings ?? {
    provider: 'builtin' as const,
    model: 'builtin-hash-v1',
    dimensions: 256,
    timeoutMs: 3_000,
  };
  return fallbackTarget({
    id: 'embeddings',
    provider: embedding.provider,
    model: embedding.model,
    ...(embedding.baseUrl ? { baseUrl: embedding.baseUrl } : {}),
  }, 'embeddings', required, manifest);
}

function fallbackTranscriptionTarget(
  config: AppConfig,
  required: boolean,
  manifest?: ApplianceQualificationManifest,
): QualificationTargetReport {
  const transcription = config.transcription;
  const target = {
    id: 'transcription',
    provider: transcription?.provider ?? 'disabled',
    model: transcription?.modelPath ?? 'none',
  };
  return baseTarget({
    target,
    capability: 'transcription',
    required,
    configured: transcription?.provider === 'whisper-cpp',
    reachable: false,
    capabilityQualified: false,
    identityQualified: false,
    pin: undeclaredPin(manifest?.requirePins === true && required),
    detail: 'Probe failed',
    startedAt: performance.now(),
  });
}

function missingTarget(id: string, capability: QualificationCapability, detail: string): QualificationTargetReport {
  return baseTarget({
    target: { id, provider: 'none', model: 'none' },
    capability,
    required: true,
    configured: false,
    reachable: false,
    capabilityQualified: false,
    identityQualified: false,
    pin: undeclaredPin(false),
    detail,
    startedAt: performance.now(),
  });
}

function ensureRequiredCapabilityTargets(
  reports: QualificationTargetReport[],
  requiredCapabilities: QualificationCapability[],
): void {
  for (const capability of requiredCapabilities) {
    if (!reports.some((target) => target.capability === capability && target.required)) {
      reports.push(missingTarget(capability, capability, `No ${capability} target is configured`));
    }
  }
}

function validateManifest(value: unknown): ApplianceQualificationManifest {
  if (!isRecord(value)) throw new Error('Qualification manifest must be an object');
  assertKeys(value, ['schema', 'requiredCapabilities', 'requirePins', 'visionService', 'pins', 'transcriptionProbe'], 'manifest');
  if (value.schema !== 'openprojects.appliance-qualification.v1') {
    throw new Error('Qualification manifest schema must be openprojects.appliance-qualification.v1');
  }
  if (!Array.isArray(value.requiredCapabilities)) {
    throw new Error('Qualification manifest requiredCapabilities must be an array');
  }
  const requiredCapabilities = uniqueCapabilities(value.requiredCapabilities);
  if (typeof value.requirePins !== 'boolean') throw new Error('Qualification manifest requirePins must be boolean');
  const visionService = value.visionService === undefined
    ? undefined
    : validateVisionService(value.visionService);
  const pins = value.pins === undefined ? undefined : validatePins(value.pins);
  const transcriptionProbe = value.transcriptionProbe === undefined
    ? undefined
    : validateTranscriptionProbe(value.transcriptionProbe);
  return {
    schema: value.schema,
    requiredCapabilities,
    requirePins: value.requirePins,
    ...(visionService ? { visionService } : {}),
    ...(pins ? { pins } : {}),
    ...(transcriptionProbe ? { transcriptionProbe } : {}),
  };
}

function validateVisionService(value: unknown): QualificationVisionService {
  if (!isRecord(value)) throw new Error('manifest.visionService must be an object');
  assertKeys(value, ['provider', 'model', 'baseUrl', 'apiKeyEnv'], 'manifest.visionService');
  const provider = boundedText(value.provider, 'manifest.visionService.provider', 128);
  if (provider !== 'mlx-vlm') {
    throw new Error('manifest.visionService.provider must be mlx-vlm for the private vision qualification lane');
  }
  const model = boundedText(value.model, 'manifest.visionService.model', 512);
  const baseUrl = validateMlxVlmBaseUrl(boundedText(value.baseUrl, 'manifest.visionService.baseUrl', 4096));
  const apiKeyEnv = value.apiKeyEnv === undefined
    ? undefined
    : environmentName(value.apiKeyEnv, 'manifest.visionService.apiKeyEnv');
  return { provider, model, baseUrl, ...(apiKeyEnv ? { apiKeyEnv } : {}) };
}

function validatePins(value: unknown): Record<string, QualificationTargetPin> {
  if (!isRecord(value)) throw new Error('manifest.pins must be an object');
  const pins = Object.create(null) as Record<string, QualificationTargetPin>;
  for (const [id, raw] of Object.entries(value)) {
    if (!/^(?:model|vision|embeddings|transcription|route:[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127})$/u.test(id)) {
      throw new Error(`manifest pin ID is not a supported target: ${safeText(id)}`);
    }
    if (!isRecord(raw)) throw new Error(`manifest.pins.${id} must be an object`);
    assertKeys(raw, ['provider', 'model', 'servedModelId', 'serviceDigest', 'artifacts', 'maxContextTokens', 'maxConcurrency', 'runtime'], `manifest.pins.${id}`);
    const provider = boundedText(raw.provider, `manifest.pins.${id}.provider`, 128);
    const model = boundedText(raw.model, `manifest.pins.${id}.model`, 4096);
    const servedModelId = raw.servedModelId === undefined
      ? undefined
      : boundedText(raw.servedModelId, `manifest.pins.${id}.servedModelId`, 4096);
    const serviceDigest = raw.serviceDigest === undefined
      ? undefined
      : boundedText(raw.serviceDigest, `manifest.pins.${id}.serviceDigest`, 256);
    if (id === 'embeddings' && provider === 'ollama' && serviceDigest && !/^[a-f0-9]{64}$/u.test(serviceDigest)) {
      throw new Error('manifest.pins.embeddings.serviceDigest must be a bare lowercase SHA-256 digest');
    }
    const artifacts = raw.artifacts === undefined
      ? undefined
      : validateArtifactPins(raw.artifacts, id);
    const maxContextTokens = raw.maxContextTokens === undefined
      ? undefined
      : positiveInteger(raw.maxContextTokens, `manifest.pins.${id}.maxContextTokens`, 1_000_000);
    const maxConcurrency = raw.maxConcurrency === undefined
      ? undefined
      : positiveInteger(raw.maxConcurrency, `manifest.pins.${id}.maxConcurrency`, 128);
    const runtime = raw.runtime === undefined
      ? undefined
      : validateRuntimeEvidence(raw.runtime, id);
    pins[id] = {
      provider,
      model,
      ...(servedModelId ? { servedModelId } : {}),
      ...(serviceDigest ? { serviceDigest } : {}),
      ...(artifacts ? { artifacts } : {}),
      ...(maxContextTokens ? { maxContextTokens } : {}),
      ...(maxConcurrency ? { maxConcurrency } : {}),
      ...(runtime ? { runtime } : {}),
    };
  }
  return pins;
}

function validateRuntimeEvidence(value: unknown, id: string): QualificationRuntimeEvidence {
  if (!isRecord(value)) throw new Error(`manifest.pins.${id}.runtime must be an object`);
  assertKeys(value, ['implementation', 'version', 'artifacts'], `manifest.pins.${id}.runtime`);
  return {
    implementation: boundedText(value.implementation, `manifest.pins.${id}.runtime.implementation`, 128),
    version: boundedText(value.version, `manifest.pins.${id}.runtime.version`, 128),
    artifacts: validateArtifactPins(value.artifacts, id, 'runtime.artifacts', 16),
  };
}

function validateArtifactPins(
  value: unknown,
  id: string,
  field = 'artifacts',
  maximum = 64,
): QualificationArtifactPin[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximum) {
    throw new Error(`manifest.pins.${id}.${field} must contain 1-${maximum} entries`);
  }
  const seen = new Set<string>();
  return value.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`manifest.pins.${id}.${field}[${index}] must be an object`);
    assertKeys(entry, ['path', 'sha256'], `manifest.pins.${id}.${field}[${index}]`);
    const path = boundedText(entry.path, `manifest.pins.${id}.${field}[${index}].path`, 4096);
    if (seen.has(path)) throw new Error(`manifest.pins.${id}.${field} contains duplicate path: ${path}`);
    seen.add(path);
    const sha256 = boundedText(entry.sha256, `manifest.pins.${id}.${field}[${index}].sha256`, 64).toLocaleLowerCase('en-US');
    if (!/^[a-f0-9]{64}$/u.test(sha256)) throw new Error(`manifest.pins.${id}.${field}[${index}].sha256 must be 64 lowercase hexadecimal characters`);
    return { path, sha256 };
  });
}

function validateTranscriptionProbe(value: unknown): QualificationTranscriptionProbe {
  if (!isRecord(value)) throw new Error('manifest.transcriptionProbe must be an object');
  assertKeys(value, ['inputPath', 'expectedText'], 'manifest.transcriptionProbe');
  return {
    inputPath: boundedText(value.inputPath, 'manifest.transcriptionProbe.inputPath', 4096),
    expectedText: boundedText(value.expectedText, 'manifest.transcriptionProbe.expectedText', 256),
  };
}

function resolveManifestPaths(
  manifest: ApplianceQualificationManifest,
  directory: string,
): ApplianceQualificationManifest {
  const absolute = (path: string): string => isAbsolute(path) ? path : resolve(directory, path);
  return {
    ...manifest,
    ...(manifest.pins
      ? {
          pins: Object.fromEntries(Object.entries(manifest.pins).map(([id, pin]) => [
            id,
            {
              ...pin,
              ...(pin.artifacts
                ? { artifacts: resolveArtifactPaths(pin.artifacts, absolute, id) }
                : {}),
              ...(pin.runtime
                ? {
                    runtime: {
                      ...pin.runtime,
                      artifacts: resolveArtifactPaths(pin.runtime.artifacts, absolute, id, 'runtime.artifacts'),
                    },
                  }
                : {}),
            },
          ])),
        }
      : {}),
    ...(manifest.transcriptionProbe
      ? { transcriptionProbe: { ...manifest.transcriptionProbe, inputPath: absolute(manifest.transcriptionProbe.inputPath) } }
      : {}),
  };
}

function resolveArtifactPaths(
  artifacts: QualificationArtifactPin[],
  absolute: (path: string) => string,
  id: string,
  field = 'artifacts',
): QualificationArtifactPin[] {
  const seen = new Set<string>();
  return artifacts.map((artifact) => {
    const path = absolute(artifact.path);
    const comparisonKey = filesystemPathKey(path);
    if (seen.has(comparisonKey)) throw new Error(`manifest.pins.${id}.${field} resolves duplicate path: ${path}`);
    seen.add(comparisonKey);
    return { ...artifact, path };
  });
}

function assertPinMatchesConfiguration(target: TextTarget, pin?: QualificationTargetPin): void {
  if (!pin) return;
  if (pin.provider !== target.provider) {
    throw new Error(`Manifest pins provider ${safeText(pin.provider)} but configuration uses ${safeText(target.provider)}`);
  }
  if (pin.model !== target.model) {
    throw new Error(`Manifest pins model ${safeText(pin.model)} but configuration uses ${safeText(target.model)}`);
  }
  if (isMlxProvider(target.provider)) {
    if (!pin.servedModelId) {
      throw new Error('MLX qualification requires a manifest servedModelId to prevent request-time model loading');
    }
    if (!isAbsolute(pin.servedModelId) || resolve(pin.servedModelId) !== pin.servedModelId) {
      throw new Error('MLX servedModelId must be an absolute normalized local snapshot path');
    }
  }
  if (target.provider === 'freetoken') {
    if (!pin.runtime || pin.runtime.implementation !== 'freetoken') {
      throw new Error('FreeToken qualification requires freetoken runtime evidence');
    }
  }
  if (pin.maxContextTokens !== undefined && target.contextWindow !== undefined && target.contextWindow > pin.maxContextTokens) {
    throw new Error(`Configured context ${target.contextWindow} exceeds manifest limit ${pin.maxContextTokens}`);
  }
}

function assertStrictRuntimeContract(target: TextTarget): void {
  if (target.provider === 'mlx-vlm') {
    if (!target.baseUrl) throw new Error('MLX-VLM requires a baseUrl');
    validateMlxVlmBaseUrl(target.baseUrl);
    return;
  }
  if (isMlxLmProvider(target.provider)) {
    if (!target.baseUrl) throw new Error('MLX-LM requires a baseUrl');
    validateMlxLmBaseUrl(target.baseUrl);
    if (target.id.startsWith('route:') && target.declaredLocal !== true) {
      throw new Error('MLX-LM routed qualification requires local: true, matching the runtime router');
    }
    if (target.credentialsConfigured || target.apiKey) {
      throw new Error('MLX-LM qualification forbids API keys, matching the runtime adapter');
    }
    return;
  }
  if (target.provider === 'freetoken') {
    if (!target.baseUrl) throw new Error('FreeToken requires a baseUrl');
    validateFreeTokenBaseUrl(target.baseUrl);
    validateFreeTokenModelAlias(target.model);
    if (target.id.startsWith('route:') && target.declaredLocal !== true) {
      throw new Error('FreeToken routed qualification requires local: true, matching the runtime router');
    }
    if (target.credentialsConfigured || target.apiKey) {
      throw new Error('FreeToken qualification forbids API keys, matching the runtime adapter');
    }
  }
}

async function validateMlxServedModelPath(
  target: TextTarget,
  pin: QualificationTargetPin | undefined,
): Promise<void> {
  if (!isMlxProvider(target.provider)) return;
  const servedModelId = pin?.servedModelId;
  if (!servedModelId) throw new Error('MLX qualification requires manifest servedModelId');
  const canonical = await realpath(servedModelId);
  if (canonical !== servedModelId) throw new Error('MLX servedModelId must already be its canonical local path');
  const info = await stat(canonical);
  if (!info.isDirectory()) throw new Error('MLX servedModelId must identify a local snapshot directory');
}

function pinResult(
  pin: QualificationTargetPin | undefined,
  required: boolean,
  service: ServiceIdentity,
  artifacts: QualificationArtifactIdentity[],
): QualificationPinResult {
  if (!pin) return undeclaredPin(required);
  const hasStrongPin = Boolean(pin.serviceDigest || pin.artifacts?.length);
  if (required && !hasStrongPin) {
    return { required, declared: true, strong: false, matched: false, detail: 'required pin has no serviceDigest or artifact SHA-256' };
  }
  if (pin.serviceDigest && pin.serviceDigest !== service.digest) {
    return {
      required,
      declared: true,
      strong: hasStrongPin,
      ...(pin.servedModelId ? { servedModelId: pin.servedModelId } : {}),
      matched: false,
      detail: service.digest ? 'service digest does not match manifest' : 'service did not report the required digest',
    };
  }
  for (const expected of pin.artifacts ?? []) {
    const expectedKey = filesystemPathKey(expected.path);
    const observed = artifacts.find((artifact) => filesystemPathKey(artifact.path) === expectedKey);
    if (!observed || observed.sha256 !== expected.sha256) {
      return {
        required,
        declared: true,
        strong: hasStrongPin,
        ...(pin.servedModelId ? { servedModelId: pin.servedModelId } : {}),
        matched: false,
        detail: `artifact SHA-256 mismatch: ${expected.path}`,
      };
    }
  }
  for (const expected of pin.runtime?.artifacts ?? []) {
    const expectedKey = filesystemPathKey(expected.path);
    const observed = artifacts.find((artifact) => filesystemPathKey(artifact.path) === expectedKey);
    if (!observed || observed.sha256 !== expected.sha256) {
      return {
        required,
        declared: true,
        strong: hasStrongPin,
        ...(pin.servedModelId ? { servedModelId: pin.servedModelId } : {}),
        matched: false,
        detail: `runtime artifact SHA-256 mismatch: ${expected.path}`,
      };
    }
  }
  if (pin.servedModelId && isAbsolute(pin.servedModelId)) {
    const escaped = (pin.artifacts ?? []).find((artifact) => {
      const pathFromSnapshot = relative(pin.servedModelId!, artifact.path);
      return pathFromSnapshot === '..' || pathFromSnapshot.startsWith(`..${sep}`) || isAbsolute(pathFromSnapshot);
    });
    if (escaped) {
      return {
        required,
        declared: true,
        strong: hasStrongPin,
        ...(pin.servedModelId ? { servedModelId: pin.servedModelId } : {}),
        matched: false,
        detail: `pinned artifact is outside servedModelId: ${escaped.path}`,
      };
    }
  }
  const limits = [
    pin.maxConcurrency ? `maxConcurrency=${pin.maxConcurrency} (declared, not service-verified)` : undefined,
    pin.maxContextTokens ? `maxContextTokens=${pin.maxContextTokens} (declared, not service-verified)` : undefined,
  ].filter((item): item is string => Boolean(item));
  return {
    required,
    declared: true,
    strong: hasStrongPin,
    ...(pin.servedModelId ? { servedModelId: pin.servedModelId } : {}),
    matched: true,
    detail: `manifest identity${hasStrongPin ? ' and strong pin' : ''} matched${pin.runtime ? `; runtime=${pin.runtime.implementation}@${pin.runtime.version}` : ''}${limits.length ? `; ${limits.join(', ')}` : ''}`,
  };
}

function undeclaredPin(required: boolean): QualificationPinResult {
  return {
    required,
    declared: false,
    strong: false,
    matched: !required,
    detail: required ? 'a manifest serviceDigest or artifact SHA-256 is required' : 'no strong pin required',
  };
}

async function hashQualifiedArtifacts(
  target: TextTarget,
  pin: QualificationTargetPin | undefined,
  deadlineAt: number,
): Promise<QualificationArtifactIdentity[]> {
  if (!isMlxProvider(target.provider)) return hashAllPinnedArtifacts(pin, deadlineAt);
  if (!pin?.servedModelId) throw new Error('MLX qualification requires manifest servedModelId');
  const before = await inventoryMlxSnapshot(pin.servedModelId, deadlineAt);
  await validateMlxSnapshotCoverage(target, pin, before, deadlineAt);
  const identities = await hashAllPinnedArtifacts(pin, deadlineAt);
  const after = await inventoryMlxSnapshot(pin.servedModelId, deadlineAt);
  if (snapshotInventorySignature(before) !== snapshotInventorySignature(after)) {
    throw new Error('MLX snapshot changed while qualification evidence was collected');
  }
  return identities;
}

async function inventoryMlxSnapshot(
  servedModelId: string,
  deadlineAt: number,
): Promise<SnapshotInventoryEntry[]> {
  const pending = [servedModelId];
  const files: SnapshotInventoryEntry[] = [];
  let directories = 0;
  let totalBytes = 0;
  while (pending.length > 0) {
    remainingTimeout(deadlineAt);
    const directory = pending.pop()!;
    directories += 1;
    if (directories > MAX_MLX_SNAPSHOT_DIRECTORIES) {
      throw new Error(`MLX snapshot exceeds ${MAX_MLX_SNAPSHOT_DIRECTORIES} directories`);
    }
    const entries = await readdir(directory, { withFileTypes: true });
    remainingTimeout(deadlineAt);
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en-US'));
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      const canonical = await realpath(path);
      if (canonical !== path || entry.isSymbolicLink()) {
        throw new Error(`MLX snapshot entries must use canonical paths without symlinks: ${path}`);
      }
      const info = await lstat(path);
      if (entry.isDirectory() && info.isDirectory()) {
        pending.push(path);
        continue;
      }
      if (!entry.isFile() || !info.isFile()) {
        throw new Error(`MLX snapshot contains an unsupported non-regular entry: ${path}`);
      }
      if (info.nlink !== 1) {
        throw new Error(`MLX snapshot files must not be hard-linked: ${path}`);
      }
      files.push({
        path,
        relativePath: relative(servedModelId, path),
        bytes: info.size,
        device: info.dev,
        inode: info.ino,
        modifiedMs: info.mtimeMs,
      });
      totalBytes += info.size;
      if (files.length > MAX_MLX_SNAPSHOT_FILES) {
        throw new Error(`MLX snapshot exceeds ${MAX_MLX_SNAPSHOT_FILES} files`);
      }
      if (totalBytes > MAX_MLX_SNAPSHOT_BYTES) {
        throw new Error(`MLX snapshot exceeds ${MAX_MLX_SNAPSHOT_BYTES} bytes`);
      }
      remainingTimeout(deadlineAt);
    }
  }
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'en-US'));
  if (files.length === 0) throw new Error('MLX snapshot contains no files');
  return files;
}

async function validateMlxSnapshotCoverage(
  target: TextTarget,
  pin: QualificationTargetPin,
  inventory: SnapshotInventoryEntry[],
  deadlineAt: number,
): Promise<void> {
  const artifacts = pin.artifacts ?? [];
  const inventoryPaths = new Set(inventory.map((entry) => filesystemPathKey(entry.path)));
  const pinnedPaths = new Set<string>();
  for (const artifact of artifacts) {
    const path = resolve(artifact.path);
    const comparisonKey = filesystemPathKey(path);
    if (pinnedPaths.has(comparisonKey)) throw new Error(`MLX artifact is pinned more than once: ${path}`);
    pinnedPaths.add(comparisonKey);
    const canonical = await realpath(path);
    if (canonical !== path) throw new Error(`MLX artifact path must already be canonical: ${path}`);
    if (!inventoryPaths.has(comparisonKey)) throw new Error(`MLX artifact is not a file in servedModelId: ${path}`);
  }
  if (pinnedPaths.size !== inventoryPaths.size || [...inventoryPaths].some((path) => !pinnedPaths.has(path))) {
    throw new Error(`MLX identity requires an exact SHA-256 inventory of all ${inventoryPaths.size} snapshot files`);
  }

  const relativePaths = new Set(inventory.map((entry) => entry.relativePath));
  for (const required of ['config.json', 'tokenizer_config.json']) {
    if (!relativePaths.has(required)) throw new Error(`MLX snapshot identity requires ${required}`);
  }
  if (!relativePaths.has('tokenizer.json') && !relativePaths.has('tokenizer.model')) {
    throw new Error('MLX snapshot identity requires tokenizer.json or tokenizer.model');
  }
  if (target.provider === 'mlx-vlm'
      && !relativePaths.has('processor_config.json')
      && !relativePaths.has('preprocessor_config.json')) {
    throw new Error('MLX-VLM snapshot identity requires processor_config.json or preprocessor_config.json');
  }

  const weights = inventory
    .map((entry) => entry.relativePath)
    .filter((path) => !path.includes(sep) && /^model(?:-\d{5}-of-\d{5})?\.safetensors$/u.test(path));
  if (weights.length === 0) throw new Error('MLX snapshot identity supports only top-level model*.safetensors weights');
  const indexPath = resolve(pin.servedModelId!, 'model.safetensors.index.json');
  if (weights.length === 1 && weights[0] === 'model.safetensors' && !relativePaths.has('model.safetensors.index.json')) {
    return;
  }
  if (!relativePaths.has('model.safetensors.index.json')) {
    throw new Error('Sharded MLX weights require model.safetensors.index.json');
  }
  const index = await readStrictJsonFile(indexPath, MAX_MLX_INDEX_BYTES, deadlineAt);
  if (!isRecord(index) || !isRecord(index.weight_map)) {
    throw new Error('model.safetensors.index.json must contain a weight_map object');
  }
  const referenced = new Set<string>();
  for (const value of Object.values(index.weight_map)) {
    if (typeof value !== 'string' || !/^model(?:-\d{5}-of-\d{5})?\.safetensors$/u.test(value)) {
      throw new Error('MLX weight index references an unsupported or non-top-level shard');
    }
    referenced.add(value);
  }
  if (referenced.size === 0
      || weights.some((path) => !referenced.has(path))
      || [...referenced].some((path) => !relativePaths.has(path))) {
    throw new Error('MLX weight index and snapshot shard inventory do not match exactly');
  }
}

async function readStrictJsonFile(path: string, maxBytes: number, deadlineAt: number): Promise<unknown> {
  remainingTimeout(deadlineAt);
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) {
    throw new Error(`JSON evidence must be a regular non-symlink file of at most ${maxBytes} bytes: ${path}`);
  }
  const source = await readFile(path, 'utf8');
  remainingTimeout(deadlineAt);
  const duplicateCheck = YAML.parseDocument(source, { uniqueKeys: true });
  if (duplicateCheck.errors.length > 0) throw new Error(`JSON evidence has duplicate or invalid keys: ${path}`);
  try {
    return JSON.parse(source) as unknown;
  } catch {
    throw new Error(`JSON evidence is invalid: ${path}`);
  }
}

function snapshotInventorySignature(inventory: SnapshotInventoryEntry[]): string {
  return inventory
    .map((entry) => `${entry.path}\0${entry.bytes}\0${entry.device}\0${entry.inode}\0${entry.modifiedMs}`)
    .join('\n');
}

async function hashPinnedArtifacts(
  pin: QualificationTargetPin | undefined,
  deadlineAt: number,
): Promise<QualificationArtifactIdentity[]> {
  const identities: QualificationArtifactIdentity[] = [];
  for (const artifact of pin?.artifacts ?? []) identities.push(await hashArtifact(artifact, deadlineAt));
  return identities;
}

async function hashAllPinnedArtifacts(
  pin: QualificationTargetPin | undefined,
  deadlineAt: number,
): Promise<QualificationArtifactIdentity[]> {
  const modelPaths = new Set((pin?.artifacts ?? []).map((artifact) => filesystemPathKey(resolve(artifact.path))));
  const modelFileIdentities = new Set<string>();
  for (const artifact of pin?.artifacts ?? []) {
    modelFileIdentities.add(await artifactFileIdentity(resolve(artifact.path)));
  }
  for (const artifact of pin?.runtime?.artifacts ?? []) {
    const runtimePath = resolve(artifact.path);
    if (modelPaths.has(filesystemPathKey(runtimePath))) {
      throw new Error(`Runtime evidence duplicates a model artifact path: ${resolve(artifact.path)}`);
    }
    if (modelFileIdentities.has(await artifactFileIdentity(runtimePath))) {
      throw new Error(`Runtime evidence duplicates a model artifact file identity: ${runtimePath}`);
    }
  }
  const model = await hashPinnedArtifacts(pin, deadlineAt);
  const runtime = await hashRuntimeArtifacts(pin, deadlineAt);
  return [...model, ...runtime];
}

async function hashRuntimeArtifacts(
  pin: QualificationTargetPin | undefined,
  deadlineAt: number,
): Promise<QualificationArtifactIdentity[]> {
  const identities: QualificationArtifactIdentity[] = [];
  for (const artifact of pin?.runtime?.artifacts ?? []) identities.push(await hashArtifact(artifact, deadlineAt));
  return identities;
}

function runtimeIdentity(
  pin: QualificationTargetPin | undefined,
  identities: QualificationArtifactIdentity[],
): Pick<QualificationIdentity, 'runtimeEvidence'> | Record<string, never> {
  if (!pin?.runtime) return {};
  const runtimePaths = new Set(pin.runtime.artifacts.map((artifact) => filesystemPathKey(artifact.path)));
  return {
    runtimeEvidence: {
      implementation: pin.runtime.implementation,
      version: pin.runtime.version,
      artifacts: identities.filter((identity) => runtimePaths.has(filesystemPathKey(identity.path))),
    },
  };
}

async function hashArtifact(
  artifact: { path: string; sha256: string | undefined },
  deadlineAt: number,
): Promise<QualificationArtifactIdentity> {
  const path = resolve(artifact.path);
  const canonical = await realpath(path);
  if (canonical !== path) throw new Error(`Pinned artifact path must already be canonical: ${path}`);
  const before = await lstat(path);
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error(`Pinned artifact must be a regular non-symlink file: ${path}`);
  }
  if (before.nlink !== 1) throw new Error(`Pinned artifact must not be hard-linked: ${path}`);
  await access(path, fsConstants.R_OK);
  const signal = AbortSignal.timeout(remainingTimeout(deadlineAt));
  const hash = createHash('sha256');
  const stream = createReadStream(path, { signal });
  for await (const chunk of stream) hash.update(chunk as Buffer);
  const after = await lstat(path);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    throw new Error(`Pinned artifact changed while hashing: ${path}`);
  }
  const sha256 = hash.digest('hex');
  return { path, bytes: before.size, sha256 };
}

function mergeArtifacts(
  first: QualificationArtifactIdentity[],
  second: QualificationArtifactIdentity[],
): QualificationArtifactIdentity[] {
  const merged = new Map<string, QualificationArtifactIdentity>();
  for (const artifact of [...first, ...second]) merged.set(filesystemPathKey(artifact.path), artifact);
  return [...merged.values()];
}

async function artifactFileIdentity(path: string): Promise<string> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`Pinned artifact must be a regular non-symlink file: ${path}`);
  }
  return `${info.dev}:${info.ino}`;
}

async function requestJson(request: typeof fetch, url: string, init: RequestInit): Promise<unknown> {
  const response = await request(url, init);
  const text = await boundedResponseText(response);
  let body: unknown;
  if (text) {
    const duplicateCheck = YAML.parseDocument(text, { uniqueKeys: true });
    if (duplicateCheck.errors.some((error) => error.code === 'DUPLICATE_KEY')) {
      throw new Error(`Service returned invalid or duplicate JSON keys from ${publicEndpoint(url)}`);
    }
  }
  try {
    body = text ? JSON.parse(text) as unknown : {};
  } catch {
    throw new Error(`Service returned invalid JSON from ${publicEndpoint(url)}`);
  }
  if (!response.ok) {
    throw new Error(`Service returned HTTP ${response.status} from ${publicEndpoint(url)}: ${responseMessage(body) ?? 'no safe error detail'}`);
  }
  return body;
}

async function boundedResponseText(response: Response): Promise<string> {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error(`Service response exceeds ${MAX_RESPONSE_BYTES} bytes`);
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error(`Service response exceeds ${MAX_RESPONSE_BYTES} bytes`);
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
}

function validateToolEcho(value: unknown, nonce: string, strictProvider?: string): { id: string } {
  if (!isRecord(value) || !Array.isArray(value.choices) || value.choices.length !== 1) {
    throw new Error('Model response must contain exactly one choice');
  }
  const choice = value.choices[0];
  if (!isRecord(choice) || !isRecord(choice.message) || !Array.isArray(choice.message.tool_calls)) {
    throw new Error('Model did not return a tool call');
  }
  if (strictProvider && choice.finish_reason !== 'tool_calls') {
    throw new Error(`${strictProvider} tool response requires finish_reason tool_calls, got ${safeText(String(choice.finish_reason ?? 'missing'))}`);
  }
  if (choice.message.tool_calls.length !== 1) {
    throw new Error('Model must return exactly one tool call without extras');
  }
  if (choice.message.content !== null && choice.message.content !== '' && choice.message.content !== undefined) {
    throw new Error('Tool-call turn must not contain extra assistant text');
  }
  const tool = choice.message.tool_calls[0];
  if (!isRecord(tool)
      || tool.type !== 'function'
      || typeof tool.id !== 'string'
      || !tool.id
      || tool.id.length > 256
      || !isRecord(tool.function)) {
    throw new Error('Model tool call has no stable ID or function');
  }
  if (tool.function.name !== 'qualification_echo' || typeof tool.function.arguments !== 'string') {
    throw new Error('Model returned an unexpected tool function');
  }
  let args: unknown;
  try {
    args = JSON.parse(tool.function.arguments) as unknown;
  } catch {
    throw new Error('Model tool arguments are not valid JSON');
  }
  if (!isRecord(args) || Object.keys(args).length !== 1 || args.value !== nonce) {
    throw new Error('Model did not return the exact qualification_echo nonce without extra arguments');
  }
  return { id: tool.id };
}

function validateTextOnlyTurn(
  value: unknown,
  strictProvider: string | undefined,
  turn: 'initial' | 'final',
): void {
  if (!isRecord(value) || !Array.isArray(value.choices) || value.choices.length !== 1) {
    throw new Error(`${turn} model response must contain exactly one choice`);
  }
  const choice = value.choices[0];
  if (!isRecord(choice) || !isRecord(choice.message)) throw new Error(`${turn} model response has no message`);
  if (choice.message.tool_calls !== undefined
      && (!Array.isArray(choice.message.tool_calls) || choice.message.tool_calls.length > 0)) {
    throw new Error(`${turn} model response contained an unexpected or malformed tool call`);
  }
  if (strictProvider && choice.finish_reason === 'tool_calls') {
    throw new Error(`${strictProvider} ${turn} response reported tool_calls without a structured tool call`);
  }
  if (typeof choice.message.content !== 'string' || !choice.message.content.trim()) {
    throw new Error(`Model did not produce non-empty ${turn} assistant text`);
  }
}

function qualificationEchoTool(): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: 'qualification_echo',
      description: 'Read-only appliance qualification echo.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['value'],
        properties: { value: { type: 'string' } },
      },
    },
  };
}

function validateEmbeddingVectors(vectors: number[][], dimensions: number, expectedCount: number): void {
  if (vectors.length !== expectedCount) throw new Error(`Embedding provider did not return ${expectedCount} vectors`);
  for (const vector of vectors) {
    if (vector.length !== dimensions || vector.some((value) => !Number.isFinite(value))) {
      throw new Error(`Embedding provider did not return finite ${dimensions}-dimension vectors`);
    }
    if (vector.every((value) => value === 0)) throw new Error('Embedding provider returned an all-zero vector');
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    if (Math.abs(norm - 1) > 0.02) throw new Error('Embedding provider returned a vector that is not unit-normalized');
  }
  if (expectedCount === 2 && vectors[0]?.every((value, index) => value === vectors[1]?.[index])) {
    throw new Error('Embedding provider returned identical vectors for distinct inputs');
  }
}

function embeddingSemanticInputs(model: string): string[] {
  const triplets = [
    [
      'Which issue is blocking the production credentials for Atlas?',
      'Security approval is blocking production API credentials.',
      'The customer demo remains scheduled for Friday.',
    ],
    [
      'Что мешает команде завершить запуск проекта в срок?',
      'A blocked credentials task prevents integration and QA from starting.',
      'The office lunch menu was updated for next week.',
    ],
    [
      'Layihənin son tarixini hansı asılılıq riskə atır?',
      'Dependent launch work cannot proceed until the API credential blocker is resolved.',
      'A new logo was selected for the marketing website.',
    ],
    [
      'Find a critical-path delay caused by blocked dependent work.',
      'Regression testing is delayed because an upstream delivery task is blocked.',
      'The team archived a generic deadline-risk template with no active blocker.',
    ],
  ] as const;
  return triplets.flatMap(([query, positive, negative]) => [
    formatEmbeddingQuery(model, query),
    positive,
    negative,
  ]);
}

function validateSemanticEmbeddingRanking(vectors: number[][]): { minimumMargin: number; meanMargin: number } {
  const margins: number[] = [];
  for (let index = 0; index < vectors.length; index += 3) {
    const query = vectors[index]!;
    const positive = vectors[index + 1]!;
    const negative = vectors[index + 2]!;
    margins.push(dot(query, positive) - dot(query, negative));
  }
  const minimumMargin = Math.min(...margins);
  const meanMargin = margins.reduce((sum, margin) => sum + margin, 0) / margins.length;
  if (minimumMargin < 0.05 || meanMargin < 0.10) {
    throw new Error(`Semantic embedding ranking margin is too small (minimum ${minimumMargin.toFixed(3)}, mean ${meanMargin.toFixed(3)})`);
  }
  return { minimumMargin, meanMargin };
}

function dot(left: number[], right: number[]): number {
  return left.reduce((sum, value, index) => sum + value * (right[index] ?? 0), 0);
}

function responseContent(value: unknown): string {
  if (!isRecord(value) || !Array.isArray(value.choices) || value.choices.length !== 1) {
    throw new Error('Model response must contain exactly one choice');
  }
  const choice = value.choices[0];
  if (!isRecord(choice) || !isRecord(choice.message) || typeof choice.message.content !== 'string') {
    throw new Error('Model response has no text content');
  }
  return choice.message.content;
}

function modelFromResponse(value: unknown): string | undefined {
  return isRecord(value) && typeof value.model === 'string' ? value.model : undefined;
}

function requestHeaders(apiKey?: string): Record<string, string> {
  return {
    accept: 'application/json',
    'content-type': 'application/json',
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
  };
}

function chatEndpoint(baseUrl: string): string {
  return appendEndpoint(baseUrl, 'chat/completions');
}

function modelsEndpoint(baseUrl: string): string {
  return appendEndpoint(baseUrl, 'models');
}

function ollamaTagsEndpoint(baseUrl: string): string {
  const url = new URL(httpUrl(baseUrl, 'Ollama base URL'));
  url.pathname = `${url.pathname.replace(/\/(?:v1|api)\/?$/u, '').replace(/\/$/u, '')}/api/tags`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

function ollamaEmbedEndpoint(baseUrl: string): string {
  const url = new URL(httpUrl(baseUrl, 'Ollama base URL'));
  url.pathname = `${url.pathname.replace(/\/(?:v1|api)\/?$/u, '').replace(/\/$/u, '')}/api/embed`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

function healthEndpoint(baseUrl: string): string {
  const url = new URL(httpUrl(baseUrl, 'local inference base URL'));
  url.pathname = `${url.pathname.replace(/\/v1\/?$/u, '').replace(/\/$/u, '')}/health`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

function appendEndpoint(baseUrl: string, suffix: string): string {
  const url = new URL(httpUrl(baseUrl, 'service base URL'));
  url.pathname = `${url.pathname.replace(/\/$/u, '')}/${suffix}`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

function publicEndpoint(value: string): string {
  const url = new URL(value);
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  return url.toString();
}

async function resolveExecutable(command: string): Promise<string> {
  if (isAbsolute(command) || command.includes('/') || command.includes('\\')) {
    return requireExecutable(command);
  }
  for (const directory of executableSearchDirectories()) {
    for (const candidate of executablePathCandidates(directory, command)) {
      try {
        return await requireExecutable(candidate);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof Error && error.message.includes('not executable'))) {
          throw error;
        }
      }
    }
  }
  throw new Error(`Executable is not available on PATH: ${safeText(command)}`);
}

async function requireExecutable(path: string): Promise<string> {
  if (!isShellFreeExecutablePath(path)) {
    throw new Error('Windows shell-free execution accepts only native .exe or .com executable paths');
  }
  const canonical = await realpath(path);
  const info = await stat(canonical);
  if (!info.isFile()) throw new Error(`Executable is not a regular file: ${canonical}`);
  await access(canonical, fsConstants.X_OK | fsConstants.R_OK);
  return canonical;
}

async function requireRegularFile(path: string, label: string): Promise<string> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`${label} must be a regular non-symlink file`);
  await access(path, fsConstants.R_OK);
  return path;
}

function runVersion(command: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let terminalError: Error | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => terminate(new Error(`${basename(command)} version probe timed out`)), timeoutMs);
    timer.unref();
    const terminate = (error: Error): void => {
      terminalError ??= error;
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        killTimer ??= setTimeout(() => child.kill('SIGKILL'), PROCESS_KILL_GRACE_MS);
        killTimer.unref();
      }
    };
    const append = (value: Buffer | string): void => {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      bytes += chunk.length;
      if (bytes > MAX_PROCESS_OUTPUT_BYTES) {
        terminate(new Error(`${basename(command)} version output exceeded ${MAX_PROCESS_OUTPUT_BYTES} bytes`));
        return;
      }
      chunks.push(chunk);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.once('error', (error) => { terminalError ??= error; });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (terminalError) reject(terminalError);
      else if (code !== 0) reject(new Error(`${basename(command)} version probe exited with code ${code ?? 'unknown'}`));
      else resolvePromise(Buffer.concat(chunks).toString('utf8').trim());
    });
  });
}

function defaultRequiredCapabilities(config: AppConfig): QualificationCapability[] {
  void config;
  return ['text'];
}

function chooseVisionFixturePattern(random?: () => number): number {
  if (!random) return randomInt(4);
  const value = random();
  if (!Number.isFinite(value) || value < 0 || value >= 1) {
    throw new Error('Qualification random test seam must return a number in [0, 1)');
  }
  return Math.floor(value * 4);
}

function uniqueCapabilities(values: unknown[]): QualificationCapability[] {
  const allowed = new Set<QualificationCapability>(['text', 'vision', 'embeddings', 'transcription']);
  const result: QualificationCapability[] = [];
  for (const value of values) {
    if (typeof value !== 'string' || !allowed.has(value as QualificationCapability)) {
      throw new Error(`Unknown qualification capability: ${safeText(String(value))}`);
    }
    const capability = value as QualificationCapability;
    if (!result.includes(capability)) result.push(capability);
  }
  return result;
}

function configuredSecrets(config: AppConfig, manifest?: ApplianceQualificationManifest): string[] {
  const values = [
    config.model.apiKey,
    ...((config.routing?.routes ?? []).map((route) => route.apiKey ?? (route.apiKeyEnv ? process.env[route.apiKeyEnv] : undefined))),
    manifest?.visionService?.apiKeyEnv ? process.env[manifest.visionService.apiKeyEnv] : undefined,
  ];
  return values.filter((value): value is string => typeof value === 'string' && value.length > 0);
}

function redactError(error: unknown, secrets: string[]): string {
  let detail = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) {
    if (secret.length >= 4) {
      detail = detail.split(secret).join('[REDACTED]');
      continue;
    }
    const escaped = secret.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    detail = detail.replace(new RegExp(`(^|[^A-Za-z0-9])${escaped}(?=$|[^A-Za-z0-9])`, 'gu'), '$1[REDACTED]');
  }
  detail = detail.replace(/Bearer\s+[^\s,;]+/giu, 'Bearer [REDACTED]');
  return safeText(detail, 1024);
}

function modelIdentitiesMatch(observed: string, expected: string): boolean {
  return observed === expected;
}

function serviceIdentityQualified(
  target: TextTarget,
  service: ServiceIdentity,
  pin: QualificationPinResult,
): boolean {
  if (isMlxProvider(target.provider)) {
    return pin.matched
      && pin.strong
      && pin.servedModelId !== undefined
      && pin.servedModelId === service.model;
  }
  return pin.matched && modelIdentitiesMatch(service.model, target.model);
}

function isMlxLmProvider(provider: string): boolean {
  return provider === 'mlx-lm';
}

function isMlxProvider(provider: string): boolean {
  return provider === 'mlx-lm' || provider === 'mlx-vlm';
}

function requiresExactSingletonInventory(provider: string): boolean {
  return isMlxProvider(provider) || provider === 'freetoken' || provider === 'llama.cpp';
}

function strictToolProviderLabel(provider: string): string | undefined {
  if (provider === 'mlx-lm') return 'MLX-LM';
  if (provider === 'freetoken') return 'FreeToken';
  if (provider === 'llama.cpp') return 'llama.cpp';
  return undefined;
}

function validateInferenceModelIdentity(
  target: TextTarget,
  service: ServiceIdentity,
  response: unknown,
): void {
  const returnedModel = modelFromResponse(response);
  if (isMlxLmProvider(target.provider)) {
    if (returnedModel !== 'default_model') {
      throw new Error('MLX-LM omitted-model response must use the documented default_model sentinel');
    }
    return;
  }
  if (target.provider === 'mlx-vlm') {
    if (returnedModel !== service.model) {
      throw new Error('MLX-VLM response model does not match its exact pinned /models identity');
    }
    return;
  }
  if (!returnedModel || !modelIdentitiesMatch(returnedModel, target.model)) {
    throw new Error(`Inference returned model ${safeText(returnedModel ?? '(missing)')} instead of ${safeText(target.model)}`);
  }
}

function requestModelField(
  target: TextTarget,
  pin: QualificationTargetPin | undefined,
): { model?: string } {
  if (isMlxLmProvider(target.provider)) return {};
  if (target.provider === 'mlx-vlm') return { model: pin?.servedModelId ?? target.model };
  return { model: target.model };
}

function parallelToolControl(provider: string): { parallel_tool_calls?: false } {
  return provider === 'freetoken' || provider === 'llama.cpp'
    ? { parallel_tool_calls: false }
    : {};
}

function responseMessage(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.message === 'string') return safeText(value.message, 512);
  if (typeof value.error === 'string') return safeText(value.error, 512);
  if (isRecord(value.error) && typeof value.error.message === 'string') return safeText(value.error.message, 512);
  return undefined;
}

function normalizeTranscript(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('en-US').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function firstLine(value: string): string {
  return safeText(value.split(/\r?\n/u)[0] || 'version unavailable', 160);
}

function boundedTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 250 || value > 300_000) {
    throw new Error('Qualification timeout must be an integer from 250 to 300000 milliseconds');
  }
  return value;
}

function remainingTimeout(deadlineAt: number): number {
  const remaining = Math.floor(deadlineAt - performance.now());
  if (remaining < 1) throw new Error('Qualification exceeded its total timeout budget');
  return remaining;
}

function positiveInteger(value: unknown, label: string, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${label} must be an integer from 1 to ${maximum}`);
  }
  return value;
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value, 'utf8') > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${label} must be non-empty control-free text up to ${maximum} UTF-8 bytes`);
  }
  return value;
}

function environmentName(value: unknown, label: string): string {
  const name = boundedText(value, label, 128);
  if (!/^[A-Z_][A-Z0-9_]*$/u.test(name)) throw new Error(`${label} must be an uppercase environment variable name`);
  return name;
}

function httpUrl(value: unknown, label: string): string {
  const text = boundedText(value, label, 4096);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`${label} must use http or https`);
  if (url.username || url.password || url.search || url.hash) throw new Error(`${label} must not contain credentials, query, or fragment`);
  return url.toString().replace(/\/$/u, '');
}

/** Strict local API root used by the separately managed MLX-VLM service. */
export function validateMlxVlmBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('MLX-VLM baseUrl must be a valid absolute URL');
  }
  if (url.protocol !== 'http:') {
    throw new Error('MLX-VLM baseUrl must use loopback HTTP');
  }
  if (!isLoopbackHostname(url.hostname)) {
    throw new Error('MLX-VLM baseUrl must use a loopback host');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('MLX-VLM baseUrl must not contain credentials, a query, or a fragment');
  }
  const pathname = url.pathname.replace(/\/+$/u, '') || '/';
  if (pathname !== '/v1') throw new Error('MLX-VLM baseUrl path must be /v1');
  url.pathname = '/v1';
  return url.toString().replace(/\/$/u, '');
}

function isLoopbackUrl(value: string): boolean {
  try {
    return isLoopbackHostname(new URL(value).hostname);
  } catch {
    return false;
  }
}

function assertLoopbackTarget(value: string, id: string): void {
  if (!isLoopbackUrl(value)) {
    throw new Error(`Private-appliance qualification refuses non-loopback target ${safeText(id)}`);
  }
}

function assertKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new Error(`${label} contains unsupported keys: ${unknown.join(', ')}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeText(value: string, maximum = 512): string {
  const clean = value.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim();
  return clean.length <= maximum ? clean : `${clean.slice(0, maximum)}…`;
}

function yesNo(value: boolean): string {
  return value ? 'yes' : 'no';
}

function elapsed(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}
