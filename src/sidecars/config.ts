import { createHash } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

import { Ajv } from 'ajv';
import YAML from 'yaml';

import { isLoopbackHostname } from '../privacy/network-policy.js';
import {
  SIDECAR_CONFIG_SCHEMA,
  type LoadedSidecarConfig,
  type SidecarConfig,
} from './types.js';

const MAX_CONFIG_BYTES = 1_048_576;
const SAFE_ID_PATTERN = '^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,127}$';
const SAFE_ACCOUNT_PATTERN = '^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$';
const ENV_PATTERN = '^[A-Za-z_][A-Za-z0-9_]*$';
const UUID_LIKE_PATTERN = '^[A-Za-z0-9][A-Za-z0-9-]{0,127}$';
const PROJECT_KEY_PATTERN = '^[A-Z][A-Z0-9_]{0,63}$';

const commonProviderProperties = {
  tokenEnv: { type: 'string', pattern: ENV_PATTERN },
  expectedAccountId: { type: 'string', pattern: SAFE_ACCOUNT_PATTERN },
} as const;

const schema = {
  type: 'object',
  additionalProperties: false,
  required: ['schema', 'id', 'workspaceId', 'stream', 'oracle', 'state', 'provider', 'limits'],
  properties: {
    schema: { const: SIDECAR_CONFIG_SCHEMA },
    id: { type: 'string', pattern: SAFE_ID_PATTERN },
    workspaceId: { type: 'string', pattern: SAFE_ID_PATTERN },
    stream: { type: 'string', pattern: SAFE_ID_PATTERN },
    localProjectId: { type: 'string', pattern: SAFE_ID_PATTERN },
    oracle: {
      type: 'object',
      additionalProperties: false,
      required: ['baseUrl', 'tokenFile'],
      properties: {
        baseUrl: { type: 'string', minLength: 1, maxLength: 2048 },
        socketPath: { type: 'string', minLength: 1, maxLength: 4096 },
        tokenFile: { type: 'string', minLength: 1, maxLength: 4096 },
      },
    },
    state: {
      type: 'object',
      additionalProperties: false,
      required: ['directory'],
      properties: {
        directory: { type: 'string', minLength: 1, maxLength: 4096 },
      },
    },
    provider: {
      oneOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'tokenEnv', 'authorization', 'expectedAccountId', 'teamId'],
          properties: {
            kind: { const: 'linear' },
            ...commonProviderProperties,
            authorization: { enum: ['api-key', 'oauth-bearer'] },
            teamId: { type: 'string', pattern: UUID_LIKE_PATTERN },
          },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'tokenEnv', 'expectedAccountId', 'projectKey'],
          properties: {
            kind: { const: 'jira' },
            ...commonProviderProperties,
            projectKey: { type: 'string', pattern: PROJECT_KEY_PATTERN },
          },
        },
      ],
    },
    limits: {
      type: 'object',
      additionalProperties: false,
      required: ['pageSize', 'timeoutMs', 'maxResponseBytes', 'overlapSeconds', 'maxPagesPerRun'],
      properties: {
        pageSize: { type: 'integer', minimum: 1, maximum: 100 },
        timeoutMs: { type: 'integer', minimum: 1000, maximum: 30000 },
        maxResponseBytes: { type: 'integer', minimum: 1024, maximum: 2097152 },
        overlapSeconds: { type: 'integer', minimum: 0, maximum: 3600 },
        maxPagesPerRun: { type: 'integer', minimum: 1, maximum: 100 },
      },
    },
  },
} as const;

const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);

export function loadSidecarConfig(path: string): LoadedSidecarConfig {
  const absolutePath = resolve(path);
  const bytes = readBoundedRegularFile(absolutePath);
  let parsed: unknown;
  try {
    parsed = YAML.parse(bytes.toString('utf8'), { uniqueKeys: true, maxAliasCount: 0 });
  } catch (error) {
    throw new Error(`Sidecar config is not valid YAML or JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!validate(parsed)) {
    const detail = validate.errors?.map((error) => `${error.instancePath || '/'} ${error.message}`).join('; ');
    throw new Error(`Sidecar config is invalid${detail ? `: ${detail}` : ''}`);
  }
  assertNoPlaceholders(parsed);
  const config = parsed as SidecarConfig;
  const baseUrl = normalizeOracleOrigin(config.oracle.baseUrl);
  if (config.oracle.socketPath && process.platform === 'win32') {
    throw new Error(
      'Sidecar oracle.socketPath is POSIX-only; native Windows requires CA-authenticated loopback HTTPS or equivalent protected IPC',
    );
  }
  if (config.oracle.socketPath && new URL(baseUrl).protocol !== 'http:') {
    throw new Error('Sidecar oracle.socketPath requires an exact loopback HTTP origin');
  }
  const configDirectory = dirname(absolutePath);
  const normalized: SidecarConfig = {
    ...config,
    oracle: {
      ...config.oracle,
      baseUrl,
      tokenFile: absoluteFrom(config.oracle.tokenFile, configDirectory),
      ...(config.oracle.socketPath
        ? { socketPath: absoluteFrom(config.oracle.socketPath, configDirectory) }
        : {}),
    },
    state: {
      directory: absoluteFrom(config.state.directory, configDirectory),
    },
  };
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const contractSha256 = createHash('sha256')
    .update(canonicalJson(normalized))
    .digest('hex');
  return Object.freeze({
    path: absolutePath,
    sha256,
    contractSha256,
    config: deepFreeze(normalized),
  });
}

export function sidecarConfigSummary(loaded: LoadedSidecarConfig): Record<string, unknown> {
  return {
    schema: loaded.config.schema,
    id: loaded.config.id,
    path: loaded.path,
    sha256: loaded.sha256,
    contractSha256: loaded.contractSha256,
    workspaceId: loaded.config.workspaceId,
    stream: loaded.config.stream,
    provider: loaded.config.provider.kind,
    expectedAccountSha256: createHash('sha256')
      .update(loaded.config.provider.expectedAccountId)
      .digest('hex'),
    readOnly: true,
    providerWrites: 0,
    credentialLifecycle: 'externally-managed',
    oauthFlowInvoked: false,
  };
}

function normalizeOracleOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Sidecar oracle.baseUrl must be an exact loopback HTTP(S) origin');
  }
  if (
    value !== url.origin
    || (url.protocol !== 'http:' && url.protocol !== 'https:')
    || !isLoopbackHostname(url.hostname)
    || url.username
    || url.password
    || url.pathname !== '/'
    || url.search
    || url.hash
  ) {
    throw new Error('Sidecar oracle.baseUrl must be an exact loopback HTTP(S) origin without credentials or a path');
  }
  return url.origin;
}

function absoluteFrom(value: string, base: string): string {
  return isAbsolute(value) ? resolve(value) : resolve(base, value);
}

function readBoundedRegularFile(path: string): Buffer {
  const noFollow = process.platform === 'win32' ? 0 : fsConstants.O_NOFOLLOW;
  let descriptor: number | undefined;
  try {
    const pathStats = lstatSync(path);
    if (!pathStats.isFile() || pathStats.isSymbolicLink()) {
      throw new Error('Sidecar config must be a regular file and not a symbolic link');
    }
    descriptor = openSync(path, fsConstants.O_RDONLY | noFollow);
    const before = fstatSync(descriptor);
    // POSIX exposes a stable inode identity across lstat/open. Native Windows
    // reparse-point and DACL isolation remains a deployment qualification gate.
    if (
      process.platform !== 'win32'
      && (pathStats.dev !== before.dev || pathStats.ino !== before.ino)
    ) {
      throw new Error('Sidecar config changed while it was being opened');
    }
    if (!before.isFile() || before.size > MAX_CONFIG_BYTES) {
      throw new Error(`Sidecar config must be a regular file no larger than ${MAX_CONFIG_BYTES} bytes`);
    }
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    const after = fstatSync(descriptor);
    if (offset !== bytes.length || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size) {
      throw new Error('Sidecar config changed while it was being read');
    }
    return bytes;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right, 'en'))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
  }
  return value;
}

function assertNoPlaceholders(value: unknown, path = 'config'): void {
  if (typeof value === 'string') {
    if (/(?:REPLACE(?:_WITH)?|CHANGE_ME|CHANGEME|YOUR_[A-Z0-9_]+)/u.test(value)) {
      throw new Error(`Sidecar ${path} contains an unresolved placeholder`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoPlaceholders(item, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      assertNoPlaceholders(item, `${path}.${key}`);
    }
  }
}
