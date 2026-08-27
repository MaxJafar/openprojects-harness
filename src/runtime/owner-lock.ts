import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { resolve } from 'node:path';

const LOCK_SUFFIX = '.owner.lock';
const LOCK_MODE = 0o600;

export interface RuntimeOwnerLock {
  /** Undefined for the in-memory database, which needs no cross-process lock. */
  readonly path: string | undefined;
  /** Releases this process's lock. Safe to call more than once. */
  release(): void;
}

export class RuntimeOwnerLockError extends Error {
  readonly lockPath: string;

  constructor(message: string, lockPath: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RuntimeOwnerLockError';
    this.lockPath = lockPath;
  }
}

/** Returns the adjacent lock path, or undefined for SQLite's in-memory target. */
export function runtimeOwnerLockPath(databasePath: string): string | undefined {
  if (databasePath === ':memory:') return undefined;
  const absolute = resolve(databasePath);
  let canonical = absolute;
  try {
    // Expand existing case aliases and Windows 8.3 names before deriving the
    // cooperative lock. A database that does not exist yet cannot have an
    // alternate filesystem identity, so its resolved lexical path is stable.
    canonical = realpathSync.native(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return `${canonical}${LOCK_SUFFIX}`;
}

/**
 * Acquires exclusive runtime ownership for a durable SQLite database.
 *
 * The caller must acquire this before opening SQLite and hold it until storage
 * is closed. Existing locks are never inspected for process liveness or broken
 * automatically: recovery is an explicit operator decision.
 */
export function acquireRuntimeOwnerLock(databasePath: string): RuntimeOwnerLock {
  const lockPath = runtimeOwnerLockPath(databasePath);
  if (!lockPath) return memoryOwnerLock();

  let descriptor: number | undefined;
  let identity: FileIdentity | undefined;
  try {
    descriptor = openSync(
      lockPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollowFlag(),
      LOCK_MODE,
    );
    identity = fileIdentity(fstatSync(descriptor));
    if (process.platform !== 'win32') fchmodSync(descriptor, LOCK_MODE);
    writeFileSync(descriptor, ownerMetadata(), { encoding: 'ascii' });
    fsyncSync(descriptor);
    return heldOwnerLock(lockPath, descriptor, identity);
  } catch (error) {
    const cleanupError = descriptor === undefined
      ? undefined
      : releaseLockResources(lockPath, descriptor, identity);
    throw acquisitionError(lockPath, error, cleanupError);
  }
}

interface FileIdentity {
  dev: number;
  ino: number;
}

function memoryOwnerLock(): RuntimeOwnerLock {
  return Object.freeze({
    path: undefined,
    release(): void {
      // An in-memory database cannot be shared by another process.
    },
  });
}

function heldOwnerLock(lockPath: string, descriptor: number, identity: FileIdentity): RuntimeOwnerLock {
  let released = false;
  return Object.freeze({
    path: lockPath,
    release(): void {
      if (released) return;
      released = true;
      const releaseError = releaseLockResources(lockPath, descriptor, identity);
      if (releaseError) {
        throw new RuntimeOwnerLockError(
          `OpenProjects could not safely release runtime ownership at ${lockPath}. `
            + 'Verify that no OpenProjects process is using the database before removing the lock manually.',
          lockPath,
          { cause: releaseError },
        );
      }
    },
  });
}

/**
 * Windows does not provide POSIX unlink-while-open semantics consistently.
 * Close the owned handle first there, while the still-present O_EXCL leaf bars
 * another cooperative owner, then identity-check and remove it. POSIX keeps
 * unlink-before-close so ownership never has a pathname gap.
 */
function releaseLockResources(
  lockPath: string,
  descriptor: number,
  identity: FileIdentity | undefined,
): unknown | undefined {
  let firstError: unknown;
  const closeDescriptor = (): boolean => {
    try {
      closeSync(descriptor);
      return true;
    } catch (error) {
      firstError ??= error;
      return false;
    }
  };
  const removePath = (): void => {
    try {
      removeIfHeld(lockPath, identity);
    } catch (error) {
      firstError ??= error;
    }
  };

  if (process.platform === 'win32') {
    if (closeDescriptor()) removePath();
  } else {
    removePath();
    closeDescriptor();
  }
  return firstError;
}

function removeIfHeld(lockPath: string, identity: FileIdentity | undefined): void {
  if (!identity) return;
  let current: Stats;
  try {
    current = lstatSync(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (!sameFile(identity, fileIdentity(current))) return;
  unlinkSync(lockPath);
}

function fileIdentity(stats: Stats): FileIdentity {
  return { dev: stats.dev, ino: stats.ino };
}

function sameFile(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function ownerMetadata(): string {
  return `${JSON.stringify({
    schema: 'openprojects.runtime-owner.v1',
    pid: process.pid,
    startedAt: new Date().toISOString(),
  })}\n`;
}

function acquisitionError(
  lockPath: string,
  cause: unknown,
  cleanupError: unknown | undefined,
): RuntimeOwnerLockError {
  if (cleanupError) {
    return new RuntimeOwnerLockError(
      `OpenProjects could not initialize runtime ownership at ${lockPath}, and its newly created lock could not be `
        + 'removed safely. Verify that no OpenProjects process is using the database before removing the lock manually.',
      lockPath,
      { cause: new AggregateError([cause, cleanupError], 'Runtime-owner acquisition and cleanup failed') },
    );
  }
  const code = (cause as NodeJS.ErrnoException).code;
  if (code === 'EEXIST' || code === 'ELOOP') {
    const kind = existingPathKind(lockPath);
    return new RuntimeOwnerLockError(
      `OpenProjects runtime ownership is unavailable because ${kind} exists at ${lockPath}. `
        + 'Another process may own this database. Verify that no OpenProjects process is using it, then remove '
        + 'the lock manually; stale locks are never broken automatically.',
      lockPath,
      { cause },
    );
  }
  const detail = code === 'ENOENT'
    ? 'The database directory does not exist; provision it before starting OpenProjects.'
    : code === 'EACCES' || code === 'EPERM'
      ? 'The service identity cannot create the owner lock in the database directory.'
      : 'The owner lock could not be created and synchronized safely.';
  return new RuntimeOwnerLockError(
    `OpenProjects could not acquire runtime ownership at ${lockPath}. ${detail}`,
    lockPath,
    { cause },
  );
}

function existingPathKind(lockPath: string): string {
  try {
    const stats = lstatSync(lockPath);
    if (stats.isSymbolicLink()) return 'a symbolic-link owner lock';
    if (stats.isFile()) return 'an owner lock';
    return 'a special-file owner lock';
  } catch {
    return 'an existing or concurrently created owner lock';
  }
}

function noFollowFlag(): number {
  return typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
}
