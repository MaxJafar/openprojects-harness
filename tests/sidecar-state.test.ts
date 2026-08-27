import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { RuntimeOwnerLockError } from '../src/runtime/owner-lock.js';
import {
  openSidecarState,
  type SidecarState,
} from '../src/sidecars/state.js';
import type { LoadedSidecarConfig, PendingSidecarPage } from '../src/sidecars/types.js';

const temporaryDirectories = new Set<string>();
const openStates = new Set<SidecarState>();

afterEach(() => {
  for (const state of openStates) {
    try {
      state.close();
    } catch {
      // A failed assertion must not hide the original failure during cleanup.
    }
  }
  openStates.clear();
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  temporaryDirectories.clear();
});

describe('sidecar crash-recovery state', () => {
  it('creates a protected directory and atomically stages a content-committed spool', () => {
    const root = temporaryDirectory();
    const directory = join(root, 'state');
    const state = openState(loadedConfig(directory));
    const body = '{"schema":"fixture","records":["π"]}';
    const createdAt = '2026-08-27T10:11:12.000Z';

    const pending = state.stage(body, createdAt);

    expect(pending).toEqual({
      schema: 'openprojects.sidecar-pending-page.v1',
      contractSha256: 'a'.repeat(64),
      createdAt,
      bodySha256: sha256(body),
      body,
    });
    expect(Object.isFrozen(pending)).toBe(true);
    expect(state.loadPending()).toEqual(pending);
    expect(readFileSync(state.pendingPath, 'utf8')).toBe(`${JSON.stringify(pending)}\n`);
    expect(directoryEntriesWithoutLock(directory)).toEqual(['pending-page.json']);
    if (process.platform !== 'win32') {
      expect(lstatSync(directory).mode & 0o777).toBe(0o700);
      expect(lstatSync(state.pendingPath).mode & 0o777).toBe(0o600);
    }
  });

  it('recovers the exact pending page after restart and refuses to overwrite it', () => {
    const directory = join(temporaryDirectory(), 'state');
    const loaded = loadedConfig(directory);
    const first = openState(loaded);
    const original = first.stage('{"records":[1]}', '2026-08-27T10:11:12.000Z');
    first.close();

    const recovered = openState(loaded);
    expect(recovered.loadPending()).toEqual(original);
    expect(() => recovered.stage('{"records":[2]}', '2026-08-27T10:12:12.000Z')).toThrow(
      'crash-recovery data is pending',
    );
    expect(recovered.loadPending()).toEqual(original);
  });

  it('acquires ownership before reconciling exact committed startup orphans', () => {
    const directory = join(temporaryDirectory(), 'state');
    const loaded = loadedConfig(directory);
    const first = openState(loaded);
    const publicPending = first.stage('{"records":[1]}', '2026-08-27T10:11:12.000Z');
    const stagedOrphan = join(directory, startupOrphanName('stage', 1));
    const clearOrphan = join(directory, startupOrphanName('clear', 2));
    const malformedLookalike = join(
      directory,
      '.pending-0-00000000-0000-4000-8000-000000000003.tmp',
    );
    linkSync(first.pendingPath, stagedOrphan);
    writePendingPath(clearOrphan, pendingPage('{"records":[2]}'));
    writePendingPath(malformedLookalike, pendingPage('{"records":[3]}'));

    expect(() => openSidecarState(loaded)).toThrow(RuntimeOwnerLockError);
    expect(existsSync(stagedOrphan)).toBe(true);
    expect(existsSync(clearOrphan)).toBe(true);
    first.close();

    const recovered = openState(loaded);
    expect(existsSync(stagedOrphan)).toBe(false);
    expect(existsSync(clearOrphan)).toBe(false);
    expect(existsSync(malformedLookalike)).toBe(true);
    expect(recovered.loadPending()).toEqual(publicPending);
    expect(directoryEntriesWithoutLock(directory)).toEqual([
      '.pending-0-00000000-0000-4000-8000-000000000003.tmp',
      'pending-page.json',
    ]);
  });

  it('preserves exact-name orphans unless size, protection, commitment, and contract validate', () => {
    const directory = join(temporaryDirectory(), 'state');
    const loaded = loadedConfig(directory);
    openState(loaded).close();

    const candidate = join(directory, startupOrphanName('stage', 4));
    writePendingPath(candidate, { ...pendingPage(), body: '{"tampered":true}' });
    expect(() => openSidecarState(loaded)).toThrow('schema or content commitment');
    expect(existsSync(candidate)).toBe(true);
    rmSync(candidate, { force: true });

    writePendingPath(candidate, { ...pendingPage(), contractSha256: 'b'.repeat(64) });
    expect(() => openSidecarState(loaded)).toThrow('different reviewed connector contract');
    expect(existsSync(candidate)).toBe(true);
    rmSync(candidate, { force: true });

    writeFileSync(candidate, Buffer.alloc(2_200_001, 0x20), { mode: 0o600 });
    expect(() => openSidecarState(loaded)).toThrow('not a bounded regular file');
    expect(existsSync(candidate)).toBe(true);
    rmSync(candidate, { force: true });

    mkdirSync(candidate, { mode: 0o700 });
    expect(() => openSidecarState(loaded)).toThrow('not a bounded regular file');
    expect(lstatSync(candidate).isDirectory()).toBe(true);
    rmSync(candidate, { recursive: true, force: true });

    if (process.platform !== 'win32') {
      writePendingPath(candidate, pendingPage());
      chmodSync(candidate, 0o644);
      expect(() => openSidecarState(loaded)).toThrow(
        'must not be readable by group or other users',
      );
      expect(existsSync(candidate)).toBe(true);
    }

    rmSync(candidate, { force: true });
    const excessive = Array.from({ length: 65 }, (_, index) => (
      join(directory, startupOrphanName('stage', 100 + index))
    ));
    for (const path of excessive) writePendingPath(path, pendingPage());
    expect(() => openSidecarState(loaded)).toThrow('too many startup spool orphans');
    expect(excessive.every((path) => existsSync(path))).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('never follows or deletes a symbolic-link startup orphan', () => {
    const root = temporaryDirectory();
    const directory = join(root, 'state');
    const loaded = loadedConfig(directory);
    openState(loaded).close();
    const target = join(root, 'preserve.json');
    const candidate = join(directory, startupOrphanName('clear', 5));
    writePendingPath(target, pendingPage());
    symlinkSync(target, candidate);

    expect(() => openSidecarState(loaded)).toThrow('not a bounded regular file');
    expect(lstatSync(candidate).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe(`${JSON.stringify(pendingPage())}\n`);
  });

  it('clears only the expected committed body and persists that decision', () => {
    const directory = join(temporaryDirectory(), 'state');
    const loaded = loadedConfig(directory);
    const state = openState(loaded);
    const pending = state.stage('{"records":[1]}', '2026-08-27T10:11:12.000Z');

    expect(() => state.clear('b'.repeat(64))).toThrow('different pending page');
    expect(state.loadPending()).toEqual(pending);

    // Recreating even a byte-identical page changes its filesystem identity.
    // A clear authorized against the previously validated inode must preserve
    // that replacement until it has itself been reviewed.
    rmSync(state.pendingPath, { force: true });
    writePending(state, pending);
    expect(() => state.clear(pending.bodySha256)).toThrow('changed since it was last validated');
    expect(state.loadPending()).toEqual(pending);
    state.clear(pending.bodySha256);
    expect(state.loadPending()).toBeUndefined();
    expect(existsSync(state.pendingPath)).toBe(false);
    expect(() => state.clear(pending.bodySha256)).not.toThrow();
    state.close();

    const reopened = openState(loaded);
    expect(reopened.loadPending()).toBeUndefined();
  });

  it('holds exclusive state ownership until close and releases idempotently', () => {
    const directory = join(temporaryDirectory(), 'state');
    const loaded = loadedConfig(directory);
    const first = openState(loaded);

    expect(() => openSidecarState(loaded)).toThrow(RuntimeOwnerLockError);
    first.close();
    first.close();

    const second = openState(loaded);
    expect(second.directory).toBe(realpathSync.native(directory));
  });

  it('rejects use after close without recreating recovery state', () => {
    const directory = join(temporaryDirectory(), 'state');
    const state = openState(loadedConfig(directory));
    state.close();

    expect(() => state.loadPending()).toThrow('Sidecar state is closed');
    expect(() => state.stage('{}', '2026-08-27T10:11:12.000Z')).toThrow('Sidecar state is closed');
    expect(() => state.clear('a'.repeat(64))).toThrow('Sidecar state is closed');
    expect(existsSync(state.pendingPath)).toBe(false);
  });

  it('rejects body-digest tampering and unexpected spool fields', () => {
    const directory = join(temporaryDirectory(), 'state');
    const state = openState(loadedConfig(directory));
    const valid = pendingPage();

    writePending(state, { ...valid, body: '{"tampered":true}' });
    expect(() => state.loadPending()).toThrow('schema or content commitment');

    writePending(state, { ...valid, unreviewed: true });
    expect(() => state.loadPending()).toThrow('schema or content commitment');
  });

  it('rejects malformed, invalid-date, and wrong-contract recovery files', () => {
    const directory = join(temporaryDirectory(), 'state');
    const state = openState(loadedConfig(directory));

    writeFileSync(state.pendingPath, '{broken', { encoding: 'utf8', mode: 0o600 });
    expect(() => state.loadPending()).toThrow('not valid JSON');

    writePending(state, { ...pendingPage(), createdAt: 'not-a-date' });
    expect(() => state.loadPending()).toThrow('schema or content commitment');

    writePending(state, { ...pendingPage(), contractSha256: 'b'.repeat(64) });
    expect(() => state.loadPending()).toThrow('different reviewed connector contract');
  });

  it('rejects an over-limit staged body without publishing a partial file', () => {
    const directory = join(temporaryDirectory(), 'state');
    const state = openState(loadedConfig(directory));

    expect(() => state.stage('x'.repeat(2_200_000), '2026-08-27T10:11:12.000Z')).toThrow(
      'local spool limit',
    );
    expect(existsSync(state.pendingPath)).toBe(false);
    expect(directoryEntriesWithoutLock(directory)).toEqual([]);
  });

  it('rejects over-limit and overly permissive recovery files', () => {
    const directory = join(temporaryDirectory(), 'state');
    const state = openState(loadedConfig(directory));

    writeFileSync(state.pendingPath, Buffer.alloc(2_200_001, 0x20), { mode: 0o600 });
    expect(() => state.loadPending()).toThrow('not a bounded regular file');

    if (process.platform !== 'win32') {
      writePending(state, pendingPage());
      chmodSync(state.pendingPath, 0o644);
      expect(() => state.loadPending()).toThrow('must not be readable by group or other users');
    }
  });

  it.skipIf(process.platform === 'win32')('refuses a symbolic-link pending page without reading its target', () => {
    const root = temporaryDirectory();
    const directory = join(root, 'state');
    const state = openState(loadedConfig(directory));
    const target = join(root, 'credential.txt');
    writeFileSync(target, 'do-not-read-or-modify', { encoding: 'utf8', mode: 0o600 });
    symlinkSync(target, state.pendingPath);

    expect(() => state.loadPending()).toThrow('not a bounded regular file');
    expect(readFileSync(target, 'utf8')).toBe('do-not-read-or-modify');
  });

  it.skipIf(process.platform === 'win32')('refuses a symbolic-link state directory', () => {
    const root = temporaryDirectory();
    const target = join(root, 'actual-state');
    const alias = join(root, 'state-alias');
    mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, alias);

    expect(() => openSidecarState(loadedConfig(alias))).toThrow('must be a real directory');

    const parent = join(root, 'actual-parent');
    const parentAlias = join(root, 'parent-alias');
    mkdirSync(parent, { mode: 0o700 });
    symlinkSync(parent, parentAlias);
    const nestedState = openState(loadedConfig(join(parentAlias, 'nested-state')));
    expect(nestedState.directory).toBe(realpathSync.native(join(parent, 'nested-state')));
  });

  it('hardens an existing state directory before acquiring its owner lock', () => {
    const root = temporaryDirectory();
    const directory = join(root, 'state');
    mkdirSync(directory, { mode: 0o777 });
    if (process.platform !== 'win32') chmodSync(directory, 0o777);

    const state = openState(loadedConfig(directory));

    if (process.platform !== 'win32') {
      expect(lstatSync(directory).mode & 0o777).toBe(0o700);

      const moved = join(root, 'moved-state');
      renameSync(directory, moved);
      mkdirSync(directory, { mode: 0o700 });
      expect(() => state.stage('{}', '2026-08-27T10:11:12.000Z')).toThrow(
        'state directory identity changed',
      );
      expect(existsSync(join(directory, 'pending-page.json'))).toBe(false);
    }
  });
});

function openState(loaded: LoadedSidecarConfig): SidecarState {
  const state = openSidecarState(loaded);
  openStates.add(state);
  return state;
}

function loadedConfig(directory: string): LoadedSidecarConfig {
  return {
    path: join(directory, 'sidecar.json'),
    sha256: 'f'.repeat(64),
    contractSha256: 'a'.repeat(64),
    config: {
      schema: 'openprojects.sidecar.v1',
      id: 'linear-primary',
      workspaceId: 'workspace-main',
      stream: 'issues',
      oracle: {
        baseUrl: 'http://127.0.0.1:4310',
        tokenFile: join(directory, 'ingest.token'),
      },
      state: { directory },
      provider: {
        kind: 'linear',
        tokenEnv: 'OPENPROJECTS_TEST_LINEAR_TOKEN',
        authorization: 'api-key',
        expectedAccountId: 'linear-account-1',
        teamId: '4f7319c0-9a76-4ea0-b22f-0060c3195433',
      },
      limits: {
        pageSize: 50,
        timeoutMs: 5_000,
        maxResponseBytes: 131_072,
        overlapSeconds: 120,
        maxPagesPerRun: 10,
      },
    },
  };
}

function pendingPage(body = '{"records":[1]}'): PendingSidecarPage {
  return {
    schema: 'openprojects.sidecar-pending-page.v1',
    contractSha256: 'a'.repeat(64),
    createdAt: '2026-08-27T10:11:12.000Z',
    bodySha256: sha256(body),
    body,
  };
}

function writePending(state: SidecarState, value: unknown): void {
  writePendingPath(state.pendingPath, value);
}

function writePendingPath(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 });
  if (process.platform !== 'win32') chmodSync(path, 0o600);
}

function startupOrphanName(kind: 'stage' | 'clear', suffix: number): string {
  const operation = kind === 'clear' ? 'clear-' : '';
  return `.pending-${operation}123-00000000-0000-4000-8000-${suffix.toString().padStart(12, '0')}.tmp`;
}

function directoryEntriesWithoutLock(directory: string): string[] {
  return readdirSync(directory)
    .filter((entry) => entry !== 'sidecar-state.owner.lock')
    .sort();
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'openprojects-sidecar-state-'));
  temporaryDirectories.add(directory);
  return directory;
}
