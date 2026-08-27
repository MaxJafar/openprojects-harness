import { createHash, timingSafeEqual } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  type Stats,
} from 'node:fs';
import { resolve } from 'node:path';

import type {
  ControlCapability,
  ControlPrincipalConfig,
  PrincipalsServerAuthConfig,
  ServerAuthConfig,
} from '../core/types.js';

const MIN_TOKEN_LENGTH = 32;
const MAX_TOKEN_LENGTH = 512;
const MAX_TOKEN_FILE_BYTES = MAX_TOKEN_LENGTH + 2;
const MAX_PRINCIPALS = 64;
const TOKEN_PATTERN = /^[A-Za-z0-9._~+/-]+=*$/u;
const PRINCIPAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/u;
const WORKSPACE_ID_PATTERN = PRINCIPAL_ID_PATTERN;
const ALL_CAPABILITIES = Object.freeze<readonly ControlCapability[]>([
  'read',
  'run',
  'ingest',
  'approve',
  'admin',
]);
const CAPABILITY_SET = new Set<ControlCapability>(ALL_CAPABILITIES);

export interface ControlPrincipal {
  readonly id: string;
  /** Explicit grants. `admin` is interpreted as granting every capability. */
  readonly capabilities: readonly ControlCapability[];
  /** Omitted means all workspaces; a configured scope is always non-empty. */
  readonly workspaces?: readonly string[];
}

export interface ControlAuthenticator {
  /** Backwards-compatible singular identity; undefined when more than one principal is configured. */
  readonly principalId: string | undefined;
  /** Safe configured identities; token material and paths are never exposed. */
  readonly principalIds: readonly string[];
  /** Returns a frozen principal only for an exact valid Bearer credential. */
  authenticate(authorization: string | readonly string[] | undefined): ControlPrincipal | undefined;
}

export interface ControlClientCredential {
  /** Produces the request header on demand without exposing a token property. */
  authorizationHeader(): string;
}

export interface SelectedControlClientPrincipal {
  readonly id: string;
  readonly tokenFile: string;
}

interface LoadedPrincipal {
  readonly principal: ControlPrincipal;
  readonly digest: Buffer;
}

export class ControlAuthConfigurationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ControlAuthConfigurationError';
  }
}

/**
 * Loads every configured local credential once at service startup. Raw tokens
 * are immediately reduced to fixed-size digests and are never exposed by the
 * returned authenticator. Every candidate is compared with every digest so a
 * failed or successful request does not reveal which configured token matched.
 */
export function loadControlAuthenticator(config: ServerAuthConfig): ControlAuthenticator {
  const configured = normalizedPrincipalConfigs(config);
  const loaded: LoadedPrincipal[] = [];
  const digests = new Set<string>();

  for (const principalConfig of configured) {
    const digest = digestToken(readProtectedToken(principalConfig.tokenFile));
    const encodedDigest = digest.toString('hex');
    if (digests.has(encodedDigest)) {
      throw new ControlAuthConfigurationError('Control principals must not share the same Bearer token');
    }
    digests.add(encodedDigest);
    loaded.push({ digest, principal: freezePrincipal(principalConfig) });
  }

  const principalId = loaded.length === 1 ? loaded[0]?.principal.id : undefined;
  const principalIds = Object.freeze(loaded.map((entry) => entry.principal.id));
  const authenticator = {
    principalId,
    authenticate(authorization: string | readonly string[] | undefined): ControlPrincipal | undefined {
      const candidate = bearerToken(authorization);
      if (!candidate) return undefined;
      const candidateDigest = digestToken(candidate);
      let matched: ControlPrincipal | undefined;
      for (const entry of loaded) {
        if (timingSafeEqual(entry.digest, candidateDigest)) matched = entry.principal;
      }
      return matched;
    },
  } as ControlAuthenticator;
  // Keep the original serialized surface stable while exposing safe identity
  // metadata to readiness and operator-selection code.
  Object.defineProperty(authenticator, 'principalIds', {
    value: principalIds,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return Object.freeze(authenticator);
}

/**
 * Selects a local client identity without guessing among multiple principals.
 * Legacy auth and a one-principal configuration are safe defaults; a
 * multi-principal configuration requires an explicit principal ID.
 */
export function selectControlClientPrincipal(
  config: ServerAuthConfig,
  requestedPrincipalId?: string,
): SelectedControlClientPrincipal {
  const principals = normalizedPrincipalConfigs(config);
  if (requestedPrincipalId !== undefined) {
    validatePrincipalId(requestedPrincipalId, 'Requested control principal ID');
    const selected = principals.find((principal) => principal.id === requestedPrincipalId);
    if (!selected) {
      throw new ControlAuthConfigurationError(
        `Requested control principal ${requestedPrincipalId} is not configured`,
      );
    }
    return Object.freeze({ id: selected.id, tokenFile: selected.tokenFile });
  }
  if (principals.length !== 1) {
    throw new ControlAuthConfigurationError(
      'Multiple control principals are configured; select one explicitly by ID',
    );
  }
  const selected = principals[0];
  if (!selected) throw new ControlAuthConfigurationError('At least one control principal is required');
  return Object.freeze({ id: selected.id, tokenFile: selected.tokenFile });
}

/** Returns true when a principal has the requested grant; `admin` grants all. */
export function hasControlCapability(
  principal: ControlPrincipal,
  capability: ControlCapability,
): boolean {
  return principal.capabilities.includes('admin') || principal.capabilities.includes(capability);
}

/** Returns true for an unrestricted principal or an exact workspace match. */
export function isControlWorkspaceAllowed(
  principal: ControlPrincipal,
  workspaceId: string,
): boolean {
  return principal.workspaces === undefined || principal.workspaces.includes(workspaceId);
}

/**
 * Loads the protected token format for a local control-plane client. The
 * returned object has no serializable state; callers can only request the
 * complete Authorization header when constructing an HTTP request.
 */
export function loadControlClientCredential(
  config: { readonly tokenFile: string },
): ControlClientCredential {
  const token = readProtectedToken(config.tokenFile);
  return Object.freeze({
    authorizationHeader(): string {
      return `Bearer ${token}`;
    },
  });
}

function normalizedPrincipalConfigs(config: ServerAuthConfig): readonly ControlPrincipalConfig[] {
  const source: readonly ControlPrincipalConfig[] = isPrincipalsAuth(config)
    ? config.principals
    : [{
        id: config.operatorId,
        tokenFile: config.tokenFile,
        capabilities: [...ALL_CAPABILITIES],
      }];
  if (source.length < 1 || source.length > MAX_PRINCIPALS) {
    throw new ControlAuthConfigurationError(`Control auth must define 1-${MAX_PRINCIPALS} principals`);
  }

  const ids = new Set<string>();
  const tokenPaths = new Set<string>();
  return Object.freeze(source.map((principal) => {
    validatePrincipalConfig(principal);
    if (ids.has(principal.id)) {
      throw new ControlAuthConfigurationError(`Duplicate control principal ID: ${principal.id}`);
    }
    ids.add(principal.id);
    const canonicalPath = resolve(principal.tokenFile);
    if (tokenPaths.has(canonicalPath)) {
      throw new ControlAuthConfigurationError('Control principals must use unique token file paths');
    }
    tokenPaths.add(canonicalPath);
    return {
      id: principal.id,
      tokenFile: principal.tokenFile,
      capabilities: [...principal.capabilities],
      ...(principal.workspaces === undefined ? {} : { workspaces: [...principal.workspaces] }),
    };
  }));
}

function isPrincipalsAuth(config: ServerAuthConfig): config is PrincipalsServerAuthConfig {
  return Array.isArray(config.principals);
}

function validatePrincipalConfig(principal: ControlPrincipalConfig): void {
  validatePrincipalId(principal.id, 'Control principal ID');
  if (
    typeof principal.tokenFile !== 'string'
    || principal.tokenFile.length < 1
    || principal.tokenFile.length > 4096
  ) {
    throw new ControlAuthConfigurationError('Control token file path must contain 1-4096 characters');
  }
  if (
    !Array.isArray(principal.capabilities)
    || principal.capabilities.length < 1
    || principal.capabilities.some((capability) => !CAPABILITY_SET.has(capability))
  ) {
    throw new ControlAuthConfigurationError(
      'Control principal capabilities must be a non-empty subset of read, run, ingest, approve, and admin',
    );
  }
  if (new Set(principal.capabilities).size !== principal.capabilities.length) {
    throw new ControlAuthConfigurationError('Control principal capabilities must not contain duplicates');
  }
  if (principal.workspaces !== undefined) {
    if (
      !Array.isArray(principal.workspaces)
      || principal.workspaces.length < 1
      || principal.workspaces.length > 128
    ) {
      throw new ControlAuthConfigurationError(
        'Control principal workspaces must be omitted for all access or contain 1-128 workspaces',
      );
    }
    if (principal.workspaces.some(
      (workspace) => typeof workspace !== 'string' || !WORKSPACE_ID_PATTERN.test(workspace),
    )) {
      throw new ControlAuthConfigurationError(
        'Control principal workspace IDs must be 1-128 safe ASCII characters',
      );
    }
    if (new Set(principal.workspaces).size !== principal.workspaces.length) {
      throw new ControlAuthConfigurationError('Control principal workspaces must not contain duplicates');
    }
  }
}

function freezePrincipal(config: ControlPrincipalConfig): ControlPrincipal {
  const capabilities = Object.freeze([...config.capabilities]);
  const workspaces = config.workspaces === undefined
    ? undefined
    : Object.freeze([...config.workspaces]);
  return Object.freeze({
    id: config.id,
    capabilities,
    ...(workspaces === undefined ? {} : { workspaces }),
  });
}

function readProtectedToken(path: string): string {
  if (!path) throw new ControlAuthConfigurationError('Control token file path must not be empty');
  let descriptor: number | undefined;
  try {
    const before = lstatSync(path);
    if (before.isSymbolicLink()) {
      throw new ControlAuthConfigurationError(`Invalid control token file ${path}: symbolic links are not allowed`);
    }
    const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
    descriptor = openSync(path, constants.O_RDONLY | noFollow);
    const info = fstatSync(descriptor);
    if (!sameFileSnapshot(before, info)) {
      throw new ControlAuthConfigurationError(`Invalid control token file ${path}: file changed while being opened`);
    }
    validateTokenFile(info, path);
    const source = readFileSync(descriptor, 'utf8');
    return parseTokenFile(source, path);
  } catch (error) {
    if (error instanceof ControlAuthConfigurationError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    const detail = code === 'ELOOP'
      ? 'symbolic links are not allowed'
      : code === 'ENOENT'
        ? 'file does not exist'
        : code === 'EACCES' || code === 'EPERM'
          ? 'file is not readable by the service identity'
          : 'file could not be opened safely';
    throw new ControlAuthConfigurationError(`Invalid control token file ${path}: ${detail}`, { cause: error });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function sameFileSnapshot(before: Stats, after: Stats): boolean {
  return before.dev === after.dev
    && before.ino === after.ino
    && before.size === after.size
    && before.mtimeMs === after.mtimeMs
    && before.birthtimeMs === after.birthtimeMs;
}

function validateTokenFile(info: Stats, path: string): void {
  if (!info.isFile()) {
    throw new ControlAuthConfigurationError(`Invalid control token file ${path}: expected a regular file`);
  }
  if (info.nlink !== 1) {
    throw new ControlAuthConfigurationError(`Invalid control token file ${path}: hard links are not allowed`);
  }
  if (info.size < MIN_TOKEN_LENGTH || info.size > MAX_TOKEN_FILE_BYTES) {
    throw new ControlAuthConfigurationError(
      `Invalid control token file ${path}: token must be ${MIN_TOKEN_LENGTH}-${MAX_TOKEN_LENGTH} characters`,
    );
  }
  if (process.platform !== 'win32') {
    const mode = info.mode & 0o7777;
    if ((mode & 0o077) !== 0 || (mode & 0o111) !== 0 || (mode & 0o7000) !== 0) {
      throw new ControlAuthConfigurationError(
        `Invalid control token file ${path}: permissions must be owner-only 0400 or 0600`,
      );
    }
    if ((mode & 0o400) === 0) {
      throw new ControlAuthConfigurationError(
        `Invalid control token file ${path}: owner read permission is required`,
      );
    }
    const effectiveUid = process.geteuid?.();
    if (effectiveUid !== undefined && info.uid !== effectiveUid) {
      throw new ControlAuthConfigurationError(
        `Invalid control token file ${path}: file must be owned by the service identity`,
      );
    }
  }
}

function parseTokenFile(source: string, path: string): string {
  const token = source.endsWith('\r\n')
    ? source.slice(0, -2)
    : source.endsWith('\n')
      ? source.slice(0, -1)
      : source;
  if (
    token.length < MIN_TOKEN_LENGTH
    || token.length > MAX_TOKEN_LENGTH
    || token.length !== Buffer.byteLength(token, 'utf8')
    || !TOKEN_PATTERN.test(token)
  ) {
    throw new ControlAuthConfigurationError(
      `Invalid control token file ${path}: expected one ${MIN_TOKEN_LENGTH}-${MAX_TOKEN_LENGTH} character Bearer token`,
    );
  }
  return token;
}

function bearerToken(authorization: string | readonly string[] | undefined): string | undefined {
  if (typeof authorization !== 'string' || authorization.length > MAX_TOKEN_LENGTH + 16) return undefined;
  const match = /^Bearer[ \t]+([A-Za-z0-9._~+/-]+=*)$/iu.exec(authorization.trim());
  const token = match?.[1];
  return token && token.length >= MIN_TOKEN_LENGTH && token.length <= MAX_TOKEN_LENGTH
    ? token
    : undefined;
}

function digestToken(token: string): Buffer {
  return createHash('sha256').update(token, 'ascii').digest();
}

function validatePrincipalId(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !PRINCIPAL_ID_PATTERN.test(value)) {
    throw new ControlAuthConfigurationError(
      `${label} must be 1-128 safe ASCII characters beginning with a letter or number`,
    );
  }
}
