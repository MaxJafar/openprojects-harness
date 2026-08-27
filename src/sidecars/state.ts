import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type BigIntStats,
} from 'node:fs';
import { join, resolve } from 'node:path';

import {
  acquireRuntimeOwnerLock,
  type RuntimeOwnerLock,
} from '../runtime/owner-lock.js';
import type { LoadedSidecarConfig, PendingSidecarPage } from './types.js';

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_PENDING_BYTES = 2_200_000;
const MAX_STARTUP_ORPHANS = 64;
const PENDING_NAME = 'pending-page.json';
const LOCK_TARGET_NAME = 'sidecar-state';
const STARTUP_ORPHAN_NAME = /^\.pending-(?:clear-)?[1-9][0-9]{0,9}-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/u;

export interface SidecarState {
  readonly directory: string;
  readonly pendingPath: string;
  loadPending(): PendingSidecarPage | undefined;
  stage(body: string, createdAt: string): PendingSidecarPage;
  clear(expectedBodySha256: string): void;
  close(): void;
}

interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

interface ProtectedDirectory {
  readonly path: string;
  readonly identity: FileIdentity;
  readonly descriptor: number | undefined;
}

interface PendingSnapshot {
  readonly pending: PendingSidecarPage;
  readonly identity: FileIdentity;
}

interface OpenPendingSnapshot extends PendingSnapshot {
  readonly descriptor: number;
  readonly stats: BigIntStats;
}

export function openSidecarState(loaded: LoadedSidecarConfig): SidecarState {
  const directory = prepareDirectory(loaded.config.state.directory);
  let lock: RuntimeOwnerLock | undefined;
  try {
    assertDirectoryIdentity(directory);
    lock = acquireRuntimeOwnerLock(join(directory.path, LOCK_TARGET_NAME));
    assertDirectoryIdentity(directory);
    reconcileStartupOrphans(directory, loaded.contractSha256);
    return heldState(loaded, directory, lock);
  } catch (error) {
    try {
      lock?.release();
    } finally {
      closeProtectedDirectory(directory);
    }
    throw error;
  }
}

function heldState(
  loaded: LoadedSidecarConfig,
  directory: ProtectedDirectory,
  lock: RuntimeOwnerLock,
): SidecarState {
  const pendingPath = join(directory.path, PENDING_NAME);
  let closed = false;
  let validatedPending: OpenPendingSnapshot | undefined;
  const releaseValidatedPending = (): void => {
    const held = validatedPending;
    validatedPending = undefined;
    if (held) closeSync(held.descriptor);
  };
  return Object.freeze({
    directory: directory.path,
    pendingPath,
    loadPending(): PendingSidecarPage | undefined {
      assertOpen(closed);
      releaseValidatedPending();
      const snapshot = openPendingSnapshot(pendingPath, directory, loaded.contractSha256);
      validatedPending = snapshot;
      return snapshot?.pending;
    },
    stage(body: string, createdAt: string): PendingSidecarPage {
      assertOpen(closed);
      assertDirectoryIdentity(directory);
      if (pathExists(pendingPath)) {
        throw new Error('Sidecar cannot stage a new page while crash-recovery data is pending');
      }
      const pending: PendingSidecarPage = Object.freeze({
        schema: 'openprojects.sidecar-pending-page.v1',
        contractSha256: loaded.contractSha256,
        createdAt,
        bodySha256: sha256(body),
        body,
      });
      const serialized = `${JSON.stringify(pending)}\n`;
      if (Buffer.byteLength(serialized, 'utf8') > MAX_PENDING_BYTES) {
        throw new Error('Sidecar pending page exceeds its local spool limit');
      }
      releaseValidatedPending();
      validatedPending = atomicWrite(pendingPath, serialized, pending, directory);
      return pending;
    },
    clear(expectedBodySha256: string): void {
      assertOpen(closed);
      const snapshot = validatedPending
        ?? openPendingSnapshot(pendingPath, directory, loaded.contractSha256);
      if (!snapshot) {
        return;
      }
      validatedPending = snapshot;
      assertHeldPendingCurrent(
        pendingPath,
        snapshot,
        directory,
        'Sidecar pending page changed since it was last validated',
      );
      if (snapshot.pending.bodySha256 !== expectedBodySha256) {
        throw new Error('Sidecar refused to clear a different pending page');
      }
      claimAndClearPending(pendingPath, snapshot, directory);
      releaseValidatedPending();
      syncDirectory(directory);
    },
    close(): void {
      if (closed) return;
      closed = true;
      try {
        releaseValidatedPending();
      } finally {
        try {
          lock.release();
        } finally {
          closeProtectedDirectory(directory);
        }
      }
    },
  });
}

function prepareDirectory(value: string): ProtectedDirectory {
  const requested = resolve(value);
  mkdirSync(requested, { recursive: true, mode: DIRECTORY_MODE });
  const requestedStats = lstatSync(requested, { bigint: true });
  if (!requestedStats.isDirectory() || requestedStats.isSymbolicLink()) {
    throw new Error('Sidecar state path must be a real directory');
  }

  const directory = realpathSync.native(requested);
  if (process.platform === 'win32') {
    const stats = lstatSync(directory, { bigint: true });
    assertProtectedDirectoryStats(stats);
    if (!sameFile(fileIdentity(requestedStats), fileIdentity(stats))) {
      throw new Error('Sidecar state directory identity changed during initialization');
    }
    return Object.freeze({
      path: directory,
      identity: fileIdentity(stats),
      descriptor: undefined,
    });
  }

  const descriptor = openSync(
    directory,
    constants.O_RDONLY | directoryFlag() | noFollowFlag(),
  );
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    assertProtectedDirectoryStats(opened);
    if (!sameFile(fileIdentity(requestedStats), fileIdentity(opened))) {
      throw new Error('Sidecar state directory identity changed during initialization');
    }
    const current = lstatSync(directory, { bigint: true });
    if (current.isSymbolicLink() || !sameFile(fileIdentity(opened), fileIdentity(current))) {
      throw new Error('Sidecar state directory identity changed');
    }
    fchmodSync(descriptor, DIRECTORY_MODE);
    const protectedStats = fstatSync(descriptor, { bigint: true });
    assertProtectedDirectoryStats(protectedStats);
    if ((protectedStats.mode & 0o077n) !== 0n) {
      throw new Error('Sidecar state directory must not be accessible by group or other users');
    }
    return Object.freeze({
      path: directory,
      identity: fileIdentity(protectedStats),
      descriptor,
    });
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

function openPendingSnapshot(
  path: string,
  directory: ProtectedDirectory,
  contractSha256: string,
): OpenPendingSnapshot | undefined {
  assertDirectoryIdentity(directory);
  let leafBeforeOpen: BigIntStats;
  try {
    leafBeforeOpen = lstatSync(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  // This preflight is required on platforms where O_NOFOLLOW is unavailable;
  // the descriptor and post-open identity checks remain authoritative.
  assertPendingStats(leafBeforeOpen);
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | noFollowFlag());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('Sidecar pending page changed while it was being opened', { cause: error });
    }
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new Error('Sidecar pending page is not a bounded regular file', { cause: error });
    }
    throw error;
  }

  try {
    const before = fstatSync(descriptor, { bigint: true });
    assertPendingStats(before);
    if (!sameFile(fileIdentity(leafBeforeOpen), fileIdentity(before))) {
      throw new Error('Sidecar pending page changed while it was being opened');
    }
    const text = readExactBoundedFile(descriptor, Number(before.size));
    const after = fstatSync(descriptor, { bigint: true });
    if (!sameStableSnapshot(before, after)) {
      throw new Error('Sidecar pending page changed while it was being read');
    }
    const current = lstatSync(path, { bigint: true });
    if (
      current.isSymbolicLink()
      || !sameStableSnapshot(after, current)
    ) {
      throw new Error('Sidecar pending page changed while it was being read');
    }
    assertDirectoryIdentity(directory);
    const pending = parsePending(text);
    if (pending.contractSha256 !== contractSha256) {
      throw new Error('Sidecar pending page belongs to a different reviewed connector contract');
    }
    return Object.freeze({
      pending,
      identity: fileIdentity(after),
      descriptor,
      stats: after,
    });
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

function reconcileStartupOrphans(
  directory: ProtectedDirectory,
  contractSha256: string,
): void {
  assertDirectoryIdentity(directory);
  const names = readdirSync(directory.path)
    .filter((name) => STARTUP_ORPHAN_NAME.test(name))
    .sort();
  assertDirectoryIdentity(directory);
  if (names.length > MAX_STARTUP_ORPHANS) {
    throw new Error('Sidecar state contains too many startup spool orphans to reconcile safely');
  }

  const opened: Array<OpenPendingSnapshot & { path: string }> = [];
  try {
    // Validate every candidate before removing any of them. Keeping each file
    // descriptor open pins its inode until the final identity-checked unlink.
    for (const name of names) {
      const path = join(directory.path, name);
      const snapshot = openPendingSnapshot(path, directory, contractSha256);
      if (snapshot) opened.push(Object.freeze({ ...snapshot, path }));
    }

    for (const snapshot of opened) {
      assertDirectoryIdentity(directory);
      const held = fstatSync(snapshot.descriptor, { bigint: true });
      if (!sameStableSnapshot(snapshot.stats, held)) {
        throw new Error('Sidecar startup spool orphan changed after validation');
      }
      const current = lstatSync(snapshot.path, { bigint: true });
      assertPendingStats(current);
      if (!sameStableSnapshot(held, current)) {
        throw new Error('Sidecar startup spool orphan was replaced before reconciliation');
      }
      unlinkIfHeld(snapshot.path, snapshot.identity);
      syncDirectory(directory);
    }
  } finally {
    for (const snapshot of opened) closeSync(snapshot.descriptor);
  }
}

function readExactBoundedFile(descriptor: number, size: number): string {
  const contents = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const count = readSync(descriptor, contents, offset, size - offset, offset);
    if (count === 0) {
      throw new Error('Sidecar pending page changed while it was being read');
    }
    offset += count;
  }
  const overflowProbe = Buffer.allocUnsafe(1);
  if (readSync(descriptor, overflowProbe, 0, 1, size) !== 0) {
    throw new Error('Sidecar pending page changed while it was being read');
  }
  return contents.toString('utf8');
}

function parsePending(text: string): PendingSidecarPage {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new Error('Sidecar pending page is not valid JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Sidecar pending page is not an object');
  }
  const entry = value as Record<string, unknown>;
  if (
    Object.keys(entry).sort().join(',') !== 'body,bodySha256,contractSha256,createdAt,schema'
    || entry.schema !== 'openprojects.sidecar-pending-page.v1'
    || typeof entry.contractSha256 !== 'string'
    || !/^[a-f0-9]{64}$/u.test(entry.contractSha256)
    || typeof entry.createdAt !== 'string'
    || !Number.isFinite(Date.parse(entry.createdAt))
    || typeof entry.bodySha256 !== 'string'
    || !/^[a-f0-9]{64}$/u.test(entry.bodySha256)
    || typeof entry.body !== 'string'
    || sha256(entry.body) !== entry.bodySha256
  ) {
    throw new Error('Sidecar pending page failed its schema or content commitment');
  }
  return Object.freeze(entry as unknown as PendingSidecarPage);
}

function atomicWrite(
  path: string,
  contents: string,
  pending: PendingSidecarPage,
  directory: ProtectedDirectory,
): OpenPendingSnapshot {
  const temporary = join(directory.path, `.pending-${process.pid}-${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  let temporaryIdentity: FileIdentity | undefined;
  try {
    assertDirectoryIdentity(directory);
    descriptor = openSync(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollowFlag(),
      FILE_MODE,
    );
    if (process.platform !== 'win32') fchmodSync(descriptor, FILE_MODE);
    writeFileSync(descriptor, contents, 'utf8');
    fsyncSync(descriptor);
    const written = fstatSync(descriptor, { bigint: true });
    assertPendingStats(written);
    temporaryIdentity = fileIdentity(written);
    assertDirectoryIdentity(directory);
    const temporaryStats = lstatSync(temporary, { bigint: true });
    if (!sameFile(temporaryIdentity, fileIdentity(temporaryStats))) {
      throw new Error('Sidecar temporary page identity changed before publication');
    }
    try {
      // A same-directory hard link publishes the fully synchronized inode
      // without rename's replace-existing behavior.
      linkSync(temporary, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error(
          'Sidecar cannot stage a new page while crash-recovery data is pending',
          { cause: error },
        );
      }
      throw error;
    }
    const published = lstatSync(path, { bigint: true });
    if (!sameFile(temporaryIdentity, fileIdentity(published))) {
      throw new Error('Sidecar pending page identity changed during publication');
    }
    unlinkIfHeld(temporary, temporaryIdentity);
    syncDirectory(directory);
    const held = fstatSync(descriptor, { bigint: true });
    const current = lstatSync(path, { bigint: true });
    assertPendingStats(held);
    assertPendingStats(current);
    if (!sameStableSnapshot(held, current)) {
      throw new Error('Sidecar pending page changed immediately after publication');
    }
    const heldDescriptor = descriptor;
    descriptor = undefined;
    return Object.freeze({
      pending,
      identity: fileIdentity(held),
      descriptor: heldDescriptor,
      stats: held,
    });
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      if (temporaryIdentity) unlinkIfHeld(temporary, temporaryIdentity);
    } catch {
      // Preserve the original publication error.
    }
    throw error;
  }
}

function claimAndClearPending(
  path: string,
  snapshot: OpenPendingSnapshot,
  directory: ProtectedDirectory,
): void {
  const heldBeforeClaim = assertHeldPendingCurrent(
    path,
    snapshot,
    directory,
    'Sidecar pending page changed before it could be cleared',
  );

  // Moving the validated leaf to an unpredictable private name first means a
  // concurrently installed replacement at the public pathname is never the
  // object that clear() unlinks.
  const claimed = join(directory.path, `.pending-clear-${process.pid}-${randomUUID()}.tmp`);
  renameSync(path, claimed);
  const claimedStats = lstatSync(claimed, { bigint: true });
  const heldAfterClaim = fstatSync(snapshot.descriptor, { bigint: true });
  if (
    claimedStats.isSymbolicLink()
    || !claimedStats.isFile()
    // Some filesystems update ctime when the directory entry is renamed. The
    // open descriptor pins the inode, while size/mode/mtime still detect a
    // concurrent content or permission change across the claim.
    || !sameClaimTransition(heldBeforeClaim, heldAfterClaim)
    || !sameStableSnapshot(heldAfterClaim, claimedStats)
  ) {
    throw new Error('Sidecar pending page changed while it was being claimed for clearing');
  }
  assertDirectoryIdentity(directory);
  unlinkIfHeld(claimed, snapshot.identity);
}

function assertHeldPendingCurrent(
  path: string,
  snapshot: OpenPendingSnapshot,
  directory: ProtectedDirectory,
  errorMessage: string,
): BigIntStats {
  assertDirectoryIdentity(directory);
  let held: BigIntStats;
  let current: BigIntStats;
  try {
    held = fstatSync(snapshot.descriptor, { bigint: true });
    current = lstatSync(path, { bigint: true });
  } catch (error) {
    throw new Error(errorMessage, { cause: error });
  }
  assertPendingStats(held);
  assertPendingStats(current);
  if (
    current.isSymbolicLink()
    || !sameStableSnapshot(snapshot.stats, held)
    || !sameStableSnapshot(held, current)
  ) {
    throw new Error(errorMessage);
  }
  assertDirectoryIdentity(directory);
  return held;
}

function syncDirectory(directory: ProtectedDirectory): void {
  assertDirectoryIdentity(directory);
  if (directory.descriptor === undefined) return;
  fsyncSync(directory.descriptor);
  assertDirectoryIdentity(directory);
}

function assertDirectoryIdentity(directory: ProtectedDirectory): void {
  let current: BigIntStats;
  try {
    current = lstatSync(directory.path, { bigint: true });
  } catch (error) {
    throw new Error('Sidecar state directory identity changed', { cause: error });
  }
  if (
    current.isSymbolicLink()
    || !current.isDirectory()
    || !sameFile(directory.identity, fileIdentity(current))
  ) {
    throw new Error('Sidecar state directory identity changed');
  }
  if (process.platform !== 'win32' && (current.mode & 0o077n) !== 0n) {
    throw new Error('Sidecar state directory must not be accessible by group or other users');
  }
  if (directory.descriptor !== undefined) {
    const opened = fstatSync(directory.descriptor, { bigint: true });
    if (!opened.isDirectory() || !sameFile(directory.identity, fileIdentity(opened))) {
      throw new Error('Sidecar state directory identity changed');
    }
  }
}

function assertProtectedDirectoryStats(stats: BigIntStats): void {
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error('Sidecar state path must be a real directory');
  }
}

function assertPendingStats(stats: BigIntStats): void {
  if (
    !stats.isFile()
    || stats.isSymbolicLink()
    || stats.size < 0n
    || stats.size > BigInt(MAX_PENDING_BYTES)
  ) {
    throw new Error('Sidecar pending page is not a bounded regular file');
  }
  if (process.platform !== 'win32' && (stats.mode & 0o077n) !== 0n) {
    throw new Error('Sidecar pending page must not be readable by group or other users');
  }
}

function fileIdentity(stats: BigIntStats): FileIdentity {
  return Object.freeze({ dev: stats.dev, ino: stats.ino });
}

function sameFile(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameStableSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return sameFile(fileIdentity(left), fileIdentity(right))
    && left.size === right.size
    && left.mode === right.mode
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function sameClaimTransition(left: BigIntStats, right: BigIntStats): boolean {
  return sameFile(fileIdentity(left), fileIdentity(right))
    && left.size === right.size
    && left.mode === right.mode
    && left.mtimeNs === right.mtimeNs;
}

function unlinkIfHeld(path: string, expectedIdentity: FileIdentity): void {
  const current = lstatSync(path, { bigint: true });
  if (
    current.isSymbolicLink()
    || !current.isFile()
    || !sameFile(expectedIdentity, fileIdentity(current))
  ) {
    throw new Error('Sidecar refused to unlink a replaced state file');
  }
  unlinkSync(path);
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function closeProtectedDirectory(directory: ProtectedDirectory): void {
  if (directory.descriptor !== undefined) closeSync(directory.descriptor);
}

function directoryFlag(): number {
  return typeof constants.O_DIRECTORY === 'number' ? constants.O_DIRECTORY : 0;
}

function noFollowFlag(): number {
  return typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function assertOpen(closed: boolean): void {
  if (closed) throw new Error('Sidecar state is closed');
}
