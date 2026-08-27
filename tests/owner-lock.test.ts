import {
  chmodSync,
  existsSync,
  lstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { SqliteStorage } from '../src/storage/sqlite.js';
import {
  acquireRuntimeOwnerLock,
  RuntimeOwnerLockError,
  runtimeOwnerLockPath,
} from '../src/runtime/owner-lock.js';

const temporaryDirectories = new Set<string>();

afterEach(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
  temporaryDirectories.clear();
});

describe('durable database runtime-owner lock', () => {
  it('excludes a second owner and writes only bounded process metadata', () => {
    const databasePath = temporaryDatabasePath();
    const first = acquireRuntimeOwnerLock(databasePath);
    try {
      expect(first.path).toBe(runtimeOwnerLockPath(databasePath));
      if (process.platform !== 'win32') expect(lstatSync(first.path!).mode & 0o777).toBe(0o600);
      const metadata = JSON.parse(readFileSync(first.path!, 'ascii')) as Record<string, unknown>;
      expect(metadata).toEqual({
        schema: 'openprojects.runtime-owner.v1',
        pid: process.pid,
        startedAt: expect.any(String),
      });
      expect(new Date(String(metadata.startedAt)).toISOString()).toBe(metadata.startedAt);
      expect(() => acquireRuntimeOwnerLock(databasePath)).toThrow(RuntimeOwnerLockError);
      expect(() => acquireRuntimeOwnerLock(databasePath)).toThrow(/remove the lock manually/u);
    } finally {
      first.release();
    }
  });

  it('releases idempotently and permits a later owner to acquire', () => {
    const databasePath = temporaryDatabasePath();
    const first = acquireRuntimeOwnerLock(databasePath);

    first.release();
    first.release();
    expect(existsSync(runtimeOwnerLockPath(databasePath)!)).toBe(false);

    const second = acquireRuntimeOwnerLock(databasePath);
    expect(existsSync(second.path!)).toBe(true);
    second.release();
  });

  it('is held by the composed app until storage closes', async () => {
    const databasePath = temporaryDatabasePath();
    const config = loadConfig(join(process.cwd(), 'openprojects.config.yaml'));
    config.storage.database = databasePath;
    const first = await createApp({ config, seedDemo: false });
    try {
      await expect(createApp({ config, seedDemo: false })).rejects.toThrow(RuntimeOwnerLockError);
    } finally {
      await first.close();
    }
    const later = await createApp({ config, seedDemo: false });
    try {
      expect(later.storage.listRuns('local')).toEqual([]);
    } finally {
      await later.close();
    }
  });

  it('uses an idempotent no-op for an in-memory database', () => {
    const lock = acquireRuntimeOwnerLock(':memory:');

    expect(lock.path).toBeUndefined();
    expect(runtimeOwnerLockPath(':memory:')).toBeUndefined();
    expect(() => {
      lock.release();
      lock.release();
    }).not.toThrow();
  });

  it('canonicalizes aliases of an existing database before deriving its lock path', () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, 'MixedCase.db');
    writeFileSync(databasePath, 'fixture', { mode: 0o600 });
    const caseAlias = join(directory, 'mixedcase.DB');

    // Case-sensitive Linux filesystems have no alias to compare. Default
    // Windows and macOS filesystems enter the assertion below.
    if (existsSync(caseAlias)) {
      expect(runtimeOwnerLockPath(caseAlias)).toBe(runtimeOwnerLockPath(databasePath));
    }
  });

  it('hardens durable SQLite files and refuses hard-linked aliases', () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, 'openprojects.db');
    const database = new SqliteStorage(databasePath);
    database.close();
    if (process.platform !== 'win32') expect(lstatSync(databasePath).mode & 0o777).toBe(0o600);

    const hardLink = join(directory, 'hard-link.db');
    linkSync(databasePath, hardLink);
    expect(() => new SqliteStorage(hardLink)).toThrow('single-link regular non-symlink file');
  });

  it.skipIf(process.platform === 'win32')('refuses a symbolic-link SQLite alias', () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, 'openprojects.db');
    const database = new SqliteStorage(databasePath);
    database.close();
    const alias = join(directory, 'alias.db');
    symlinkSync(databasePath, alias);

    expect(() => new SqliteStorage(alias)).toThrow('single-link regular non-symlink file');
  });

  it('refuses preexisting regular and special paths', () => {
    const databasePath = temporaryDatabasePath();
    const lockPath = runtimeOwnerLockPath(databasePath)!;

    writeFileSync(lockPath, 'preexisting', { mode: 0o600 });
    expectRefusal(databasePath, /an owner lock/u);
    unlinkSync(lockPath);

    mkdirSync(lockPath);
    expectRefusal(databasePath, /special-file owner lock/u);
  });

  it.skipIf(process.platform === 'win32')('refuses a symbolic-link lock without following it', () => {
    const databasePath = temporaryDatabasePath();
    const lockPath = runtimeOwnerLockPath(databasePath)!;
    const target = join(temporaryDirectory(), 'symlink-target');
    writeFileSync(target, 'not a credential', { mode: 0o600 });
    symlinkSync(target, lockPath);

    expectRefusal(databasePath, /symbolic-link owner lock/u);
    expect(readFileSync(target, 'utf8')).toBe('not a credential');
  });

  it.skipIf(process.platform === 'win32')('does not unlink a replacement that is not the held file', () => {
    const databasePath = temporaryDatabasePath();
    const lock = acquireRuntimeOwnerLock(databasePath);
    const lockPath = lock.path!;
    unlinkSync(lockPath);
    writeFileSync(lockPath, 'replacement\n', { mode: 0o600 });
    chmodSync(lockPath, 0o600);

    lock.release();

    expect(readFileSync(lockPath, 'utf8')).toBe('replacement\n');
    expect(() => acquireRuntimeOwnerLock(databasePath)).toThrow(/never broken automatically/u);
  });
});

function temporaryDatabasePath(): string {
  return join(temporaryDirectory(), 'openprojects.db');
}

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'openprojects-owner-lock-'));
  temporaryDirectories.add(directory);
  return directory;
}

function expectRefusal(databasePath: string, kind: RegExp): void {
  try {
    acquireRuntimeOwnerLock(databasePath);
    throw new Error('expected runtime-owner acquisition to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(RuntimeOwnerLockError);
    expect((error as Error).message).toMatch(kind);
    expect((error as Error).message).toMatch(/remove the lock manually/u);
  }
}
