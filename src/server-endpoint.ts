import {
  chmodSync,
  linkSync,
  lstatSync,
  realpathSync,
  unlinkSync,
  type Stats,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import { createConnection } from 'node:net';
import { basename, dirname, isAbsolute, join, normalize } from 'node:path';

const MAX_UNIX_SOCKET_PATH_BYTES = 100;
const PROTECTED_DIRECTORY_MODE = 0o700;
const PROTECTED_SOCKET_MODE = 0o600;
const DEFAULT_UNIX_SOCKET_PROBE_TIMEOUT_MS = 750;
const SOCKET_LEASE_ANCHOR_PREFIX = '.openprojects-socket-lease-';
const SOCKET_LEASE_ANCHOR_ATTEMPTS = 8;

export class UnixSocketEndpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnixSocketEndpointError';
  }
}

export class UnixSocketPathOccupiedError extends UnixSocketEndpointError {
  constructor() {
    super('The Unix control socket path is already occupied; explicit stale-socket recovery is required');
    this.name = 'UnixSocketPathOccupiedError';
  }
}

export class UnixSocketLiveEndpointError extends UnixSocketPathOccupiedError {
  constructor() {
    super();
    this.message = 'The protected Unix control socket is accepting connections; another service may already be active';
    this.name = 'UnixSocketLiveEndpointError';
  }
}

export class UnixSocketStaleCandidateError extends UnixSocketPathOccupiedError {
  constructor() {
    super();
    this.message = 'The protected Unix control socket is not accepting connections; explicit verified stale-socket recovery is required';
    this.name = 'UnixSocketStaleCandidateError';
  }
}

export interface UnixSocketProbeResult {
  readonly socketPath: string;
  readonly status: 'absent' | 'live' | 'unresponsive';
}

export interface UnixSocketLease {
  /** Canonical absolute socket path actually passed to Node. */
  readonly socketPath: string;
  /**
   * Removes only the socket inode created by this lease. A replacement at the same
   * pathname is refused, not unlinked.
   */
  cleanup(): void;
}

/**
 * Canonicalizes an absolute socket path through its existing parent directory.
 * The leaf must not already exist; callers must never infer that a socket is stale.
 */
export function resolveUnixSocketPath(socketPath: string): string {
  const resolved = canonicalUnixSocketPath(socketPath);
  try {
    lstatSync(resolved);
  } catch (error) {
    if (systemErrorCode(error) === 'ENOENT') return resolved;
    throw new UnixSocketEndpointError('The Unix control socket path could not be inspected');
  }
  throw new UnixSocketPathOccupiedError();
}

/**
 * Resolve and authenticate an existing Unix control socket for a local client.
 * The returned path uses the real parent directory; callers should repeat this
 * check immediately before connecting. A same-owner replacement remains inside
 * the local account trust boundary.
 */
export function resolveProtectedUnixSocketClientPath(socketPath: string): string {
  const resolved = canonicalUnixSocketPath(socketPath);
  let stats: Stats;
  try {
    stats = lstatSync(resolved);
  } catch {
    throw new UnixSocketEndpointError('The protected Unix control socket could not be inspected');
  }
  if (!stats.isSocket()) {
    throw new UnixSocketEndpointError('The Unix control socket path is occupied by a non-socket leaf');
  }
  assertOwnedByEffectiveUser(stats, 'Unix control socket');
  if (permissionBits(stats) !== PROTECTED_SOCKET_MODE) {
    throw new UnixSocketEndpointError('The existing Unix control socket must have mode 0600');
  }
  return resolved;
}

/**
 * Conservatively probes an existing protected socket without modifying it.
 * A successful connect proves only that a listener accepted the local
 * connection; an unresponsive result is evidence for the manual recovery
 * runbook, never authorization to unlink the pathname.
 */
export async function probeUnixSocketPath(
  socketPath: string,
  timeoutMs = DEFAULT_UNIX_SOCKET_PROBE_TIMEOUT_MS,
): Promise<UnixSocketProbeResult> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 10_000) {
    throw new RangeError('Unix socket probe timeout must be an integer between 50 and 10000 milliseconds');
  }
  const resolved = canonicalUnixSocketPath(socketPath);
  let stats: Stats;
  try {
    stats = lstatSync(resolved);
  } catch (error) {
    if (systemErrorCode(error) === 'ENOENT') return { socketPath: resolved, status: 'absent' };
    throw new UnixSocketEndpointError('The Unix control socket path could not be inspected');
  }
  if (!stats.isSocket()) {
    throw new UnixSocketEndpointError('The Unix control socket path is occupied by a non-socket leaf');
  }
  assertOwnedByEffectiveUser(stats, 'Unix control socket');
  if (permissionBits(stats) !== PROTECTED_SOCKET_MODE) {
    throw new UnixSocketEndpointError('The existing Unix control socket must have mode 0600');
  }

  return new Promise<UnixSocketProbeResult>((resolve, reject) => {
    const connection = createConnection({ path: resolved });
    let complete = false;
    const finish = (result: UnixSocketProbeResult | UnixSocketEndpointError): void => {
      if (complete) return;
      complete = true;
      clearTimeout(timer);
      connection.removeAllListeners();
      connection.destroy();
      if (result instanceof UnixSocketEndpointError) reject(result);
      else resolve(result);
    };
    const timer = setTimeout(() => {
      finish({ socketPath: resolved, status: 'unresponsive' });
    }, timeoutMs);
    timer.unref?.();
    connection.once('connect', () => finish({ socketPath: resolved, status: 'live' }));
    connection.once('error', (error) => {
      const code = systemErrorCode(error);
      if (code === 'ENOENT') {
        finish({ socketPath: resolved, status: 'absent' });
      } else if (code === 'EACCES' || code === 'EPERM') {
        finish(new UnixSocketEndpointError('Permission to probe the Unix control socket was denied'));
      } else {
        finish({ socketPath: resolved, status: 'unresponsive' });
      }
    });
  });
}

/** Startup preflight that diagnoses occupancy but never removes a pathname. */
export async function assertUnixSocketPathAvailable(socketPath: string): Promise<string> {
  const result = await probeUnixSocketPath(socketPath);
  if (result.status === 'absent') return result.socketPath;
  if (result.status === 'live') throw new UnixSocketLiveEndpointError();
  throw new UnixSocketStaleCandidateError();
}

function canonicalUnixSocketPath(socketPath: string): string {
  assertPosix();
  if (!isAbsolute(socketPath) || socketPath.includes('\0') || normalize(socketPath) !== socketPath) {
    throw new UnixSocketEndpointError('The Unix control socket path must be normalized and absolute');
  }
  const leaf = basename(socketPath);
  if (!leaf || leaf === '.' || leaf === '..') {
    throw new UnixSocketEndpointError('The Unix control socket path must include a leaf name');
  }
  let parent: string;
  try {
    parent = realpathSync(dirname(socketPath));
  } catch {
    throw new UnixSocketEndpointError('The Unix control socket parent directory does not exist');
  }
  const resolved = join(parent, leaf);
  if (Buffer.byteLength(resolved) > MAX_UNIX_SOCKET_PATH_BYTES) {
    throw new UnixSocketEndpointError('The Unix control socket path is too long');
  }
  assertProtectedParent(parent);
  return resolved;
}

/** Listen, restrict the socket to its owner, and return an inode-pinned cleanup lease. */
export async function listenOnUnixSocket(server: Server, socketPath: string): Promise<UnixSocketLease> {
  const resolved = await assertUnixSocketPathAvailable(socketPath);
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      reject(sanitizedListenError(error));
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    try {
      server.listen({ path: resolved, exclusive: true });
    } catch (error) {
      server.off('error', onError);
      server.off('listening', onListening);
      reject(sanitizedListenError(error));
    }
  });

  let identity: Pick<Stats, 'dev' | 'ino'> | undefined;
  let anchorPath: string | undefined;
  try {
    const initial = lstatSync(resolved);
    if (!initial.isSocket()) throw new UnixSocketEndpointError('The control endpoint leaf is not a Unix socket');
    identity = { dev: initial.dev, ino: initial.ino };
    chmodSync(resolved, PROTECTED_SOCKET_MODE);
    const secured = lstatSync(resolved);
    assertOwnedByEffectiveUser(secured, 'Unix control socket');
    if (!secured.isSocket() || permissionBits(secured) !== PROTECTED_SOCKET_MODE) {
      throw new UnixSocketEndpointError('The Unix control socket permissions could not be secured');
    }
    identity = { dev: secured.dev, ino: secured.ino };
    anchorPath = createSocketLeaseAnchor(resolved, identity);
  } catch (error) {
    await closeServerAfterFailedListen(server);
    if (identity) safeUnlinkKnownSocket(resolved, identity);
    if (identity && anchorPath) safeUnlinkKnownSocket(anchorPath, identity);
    if (error instanceof UnixSocketEndpointError) throw error;
    throw new UnixSocketEndpointError('The Unix control socket could not be secured');
  }

  let cleaned = false;
  return {
    socketPath: resolved,
    cleanup(): void {
      if (cleaned) return;
      if (!identity || !anchorPath) {
        throw new UnixSocketEndpointError('The Unix control socket lease identity is unavailable');
      }

      let anchor: Stats;
      try {
        anchor = lstatSync(anchorPath);
      } catch (error) {
        if (systemErrorCode(error) === 'ENOENT') {
          try {
            lstatSync(resolved);
          } catch (pathError) {
            if (systemErrorCode(pathError) === 'ENOENT') {
              cleaned = true;
              return;
            }
          }
          throw new UnixSocketEndpointError(
            'The Unix control socket lease anchor disappeared; refusing to unlink the endpoint',
          );
        }
        throw new UnixSocketEndpointError('The Unix control socket lease anchor could not be inspected');
      }
      if (!sameSocketIdentity(anchor, identity)) {
        throw new UnixSocketEndpointError(
          'The Unix control socket lease anchor identity changed; refusing to unlink the endpoint',
        );
      }

      let current: Stats;
      try {
        current = lstatSync(resolved);
      } catch (error) {
        if (systemErrorCode(error) === 'ENOENT') {
          removeSocketLeaseAnchor(anchorPath, identity);
          cleaned = true;
          return;
        }
        throw new UnixSocketEndpointError('The Unix control socket could not be inspected during cleanup');
      }
      if (!sameSocketIdentity(current, identity)) {
        removeSocketLeaseAnchor(anchorPath, identity);
        cleaned = true;
        throw new UnixSocketEndpointError('The Unix control socket identity changed; refusing to unlink it');
      }
      try {
        unlinkSync(resolved);
      } catch {
        throw new UnixSocketEndpointError('The Unix control socket could not be removed');
      }
      removeSocketLeaseAnchor(anchorPath, identity);
      cleaned = true;
    },
  };
}

/** Close a server and then remove only the socket inode held by its lease. */
export async function closeUnixSocketServer(server: Server, lease: UnixSocketLease): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (
      error
        ? reject(new UnixSocketEndpointError('The Unix control server could not be closed'))
        : resolve()
    ));
  });
  lease.cleanup();
}

function assertProtectedParent(parent: string): void {
  let stats: Stats;
  try {
    stats = lstatSync(parent);
  } catch {
    throw new UnixSocketEndpointError('The Unix control socket parent directory could not be inspected');
  }
  if (!stats.isDirectory()) {
    throw new UnixSocketEndpointError('The Unix control socket parent is not a directory');
  }
  assertOwnedByEffectiveUser(stats, 'Unix control socket parent');
  if (permissionBits(stats) !== PROTECTED_DIRECTORY_MODE) {
    throw new UnixSocketEndpointError('The Unix control socket parent must have mode 0700');
  }
}

function assertOwnedByEffectiveUser(stats: Stats, label: string): void {
  const uid = process.geteuid?.();
  if (uid === undefined || stats.uid !== uid) {
    throw new UnixSocketEndpointError(`${label} must be owned by the effective service user`);
  }
}

function permissionBits(stats: Stats): number {
  return stats.mode & 0o7777;
}

async function closeServerAfterFailedListen(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function createSocketLeaseAnchor(
  socketPath: string,
  identity: Pick<Stats, 'dev' | 'ino'>,
): string {
  // Keep the original inode allocated even after Node removes the bound path on
  // close. This prevents an ABA replacement from reusing the same dev/ino pair;
  // timestamp fields alone are not a portable filesystem generation counter.
  for (let attempt = 0; attempt < SOCKET_LEASE_ANCHOR_ATTEMPTS; attempt += 1) {
    const candidate = join(
      dirname(socketPath),
      `${SOCKET_LEASE_ANCHOR_PREFIX}${randomBytes(12).toString('hex')}`,
    );
    try {
      linkSync(socketPath, candidate);
    } catch (error) {
      if (systemErrorCode(error) === 'EEXIST') continue;
      throw new UnixSocketEndpointError('The Unix control socket identity could not be pinned');
    }

    try {
      const current = lstatSync(socketPath);
      const anchor = lstatSync(candidate);
      if (!sameSocketIdentity(current, identity) || !sameSocketIdentity(anchor, identity)) {
        safeUnlinkKnownSocket(candidate, identity);
        throw new UnixSocketEndpointError('The Unix control socket identity changed while it was being pinned');
      }
      return candidate;
    } catch (error) {
      safeUnlinkKnownSocket(candidate, identity);
      if (error instanceof UnixSocketEndpointError) throw error;
      throw new UnixSocketEndpointError('The Unix control socket identity could not be verified after pinning');
    }
  }
  throw new UnixSocketEndpointError('A unique Unix control socket lease anchor could not be allocated');
}

function removeSocketLeaseAnchor(
  anchorPath: string,
  identity: Pick<Stats, 'dev' | 'ino'>,
): void {
  let anchor: Stats;
  try {
    anchor = lstatSync(anchorPath);
  } catch {
    throw new UnixSocketEndpointError('The Unix control socket lease anchor could not be removed');
  }
  if (!sameSocketIdentity(anchor, identity)) {
    throw new UnixSocketEndpointError('The Unix control socket lease anchor identity changed');
  }
  try {
    unlinkSync(anchorPath);
  } catch {
    throw new UnixSocketEndpointError('The Unix control socket lease anchor could not be removed');
  }
}

function sameSocketIdentity(stats: Stats, identity: Pick<Stats, 'dev' | 'ino'>): boolean {
  return stats.isSocket() && stats.dev === identity.dev && stats.ino === identity.ino;
}

function safeUnlinkKnownSocket(socketPath: string, identity: Pick<Stats, 'dev' | 'ino'>): void {
  try {
    const current = lstatSync(socketPath);
    if (sameSocketIdentity(current, identity)) {
      unlinkSync(socketPath);
    }
  } catch {
    // Best effort is limited to the exact socket inode created by this listen attempt.
  }
}

function sanitizedListenError(error: unknown): UnixSocketEndpointError {
  const code = systemErrorCode(error);
  if (code === 'EADDRINUSE') return new UnixSocketPathOccupiedError();
  if (code === 'EACCES' || code === 'EPERM') {
    return new UnixSocketEndpointError('Permission to create the Unix control socket was denied');
  }
  return new UnixSocketEndpointError('The Unix control socket could not be opened');
}

function assertPosix(): void {
  if (process.platform === 'win32' || process.geteuid === undefined) {
    throw new UnixSocketEndpointError('Unix control sockets are unavailable on this platform');
  }
}

function systemErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}
