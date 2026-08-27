import { chmod, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import YAML from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ControlAuthConfigurationError,
  hasControlCapability,
  isControlWorkspaceAllowed,
  loadControlAuthenticator,
  loadControlClientCredential,
  selectControlClientPrincipal,
} from '../src/auth/control-auth.js';
import { loadConfig } from '../src/config.js';
import type { ServerAuthConfig } from '../src/core/types.js';

const TOKEN = '8xjRB2u70c9n6fE4bP1aVzWDt5mYqKs3G_hLiNoC';
const TOKEN_2 = '2Cw9JeQz7_Ui4Gx3skT6ypRoMfV1nHdL8aPb5KAt';
const TOKEN_3 = 'j7FaC_1oWM8Kb2Ezx6YPH5u4NsgVqL3t9DrAi0Re';
const temporaryDirectories = new Set<string>();

afterEach(async () => {
  for (const directory of temporaryDirectories) await rm(directory, { recursive: true, force: true });
  temporaryDirectories.clear();
});

describe('local control-token authentication', () => {
  it('authenticates an exact Bearer token without exposing credential material', async () => {
    const directory = await temporaryDirectory();
    const tokenFile = join(directory, 'control.token');
    await writeFile(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
    await chmod(tokenFile, 0o600);

    const authenticator = loadControlAuthenticator({ tokenFile, operatorId: 'local-operator' });

    expect(authenticator.principalId).toBe('local-operator');
    expect(authenticator.authenticate(`Bearer ${TOKEN}`)).toEqual({
      id: 'local-operator',
      capabilities: ['read', 'run', 'ingest', 'approve', 'admin'],
    });
    expect(authenticator.authenticate(`bearer ${TOKEN}`)?.id).toBe('local-operator');
    expect(Object.isFrozen(authenticator.authenticate(`Bearer ${TOKEN}`))).toBe(true);
    expect(Object.isFrozen(authenticator.authenticate(`Bearer ${TOKEN}`)?.capabilities)).toBe(true);
    expect(authenticator.authenticate(undefined)).toBeUndefined();
    expect(authenticator.authenticate(['Bearer duplicate', `Bearer ${TOKEN}`])).toBeUndefined();
    expect(authenticator.authenticate(`Basic ${TOKEN}`)).toBeUndefined();
    expect(authenticator.authenticate(`Bearer ${'x'.repeat(TOKEN.length)}`)).toBeUndefined();
    expect(authenticator.authenticate(`Bearer ${TOKEN} trailing`)).toBeUndefined();

    const serialized = JSON.stringify(authenticator);
    expect(serialized).toBe('{"principalId":"local-operator"}');
    expect(serialized).not.toContain(TOKEN);
  });

  it('loads an encapsulated client credential with no serializable token state', async () => {
    const directory = await temporaryDirectory();
    const tokenFile = join(directory, 'control.token');
    await writeFile(tokenFile, `${TOKEN}\r\n`, { mode: 0o600 });
    await chmod(tokenFile, 0o600);

    const credential = loadControlClientCredential({ tokenFile });

    expect(credential.authorizationHeader()).toBe(`Bearer ${TOKEN}`);
    expect(JSON.stringify(credential)).toBe('{}');
    expect(Object.keys(credential)).toEqual(['authorizationHeader']);
  });

  it.skipIf(process.platform === 'win32')('rejects group- or world-readable credentials', async () => {
    const directory = await temporaryDirectory();
    const tokenFile = join(directory, 'control.token');
    await writeFile(tokenFile, TOKEN, { mode: 0o600 });
    await chmod(tokenFile, 0o640);

    expect(() => loadControlAuthenticator({ tokenFile, operatorId: 'operator' }))
      .toThrow(/permissions must be owner-only/u);
  });

  it.skipIf(process.platform === 'win32')('refuses symbolic links even when their target is protected', async () => {
    const directory = await temporaryDirectory();
    const target = join(directory, 'target.token');
    const tokenFile = join(directory, 'control.token');
    await writeFile(target, TOKEN, { mode: 0o600 });
    await chmod(target, 0o600);
    await symlink(target, tokenFile);

    expect(() => loadControlAuthenticator({ tokenFile, operatorId: 'operator' }))
      .toThrow(ControlAuthConfigurationError);
  });

  it('refuses hard-linked credentials', async () => {
    const directory = await temporaryDirectory();
    const target = join(directory, 'target.token');
    const tokenFile = join(directory, 'control.token');
    await writeFile(target, TOKEN, { mode: 0o600 });
    await chmod(target, 0o600);
    await link(target, tokenFile);

    expect(() => loadControlAuthenticator({ tokenFile, operatorId: 'operator' }))
      .toThrow(/hard links are not allowed/u);
  });

  it('rejects directories, weak tokens, hidden whitespace, and unsafe operator IDs', async () => {
    const directory = await temporaryDirectory();
    const tokenFile = join(directory, 'control.token');

    expect(() => loadControlAuthenticator({ tokenFile: directory, operatorId: 'operator' }))
      .toThrow(/regular file/u);

    await writeFile(tokenFile, 'too-short', { mode: 0o600 });
    await chmod(tokenFile, 0o600);
    expect(() => loadControlAuthenticator({ tokenFile, operatorId: 'operator' }))
      .toThrow(/32-512/u);

    await writeFile(tokenFile, `${TOKEN} \n`, { mode: 0o600 });
    await chmod(tokenFile, 0o600);
    expect(() => loadControlAuthenticator({ tokenFile, operatorId: 'operator' }))
      .toThrow(/expected one/u);

    await writeFile(tokenFile, TOKEN, { mode: 0o600 });
    await chmod(tokenFile, 0o600);
    expect(() => loadControlAuthenticator({ tokenFile, operatorId: '../operator' }))
      .toThrow(/principal ID/u);
  });

  it('authenticates independent principals with capabilities and workspace scope', async () => {
    const directory = await temporaryDirectory();
    const readerToken = await protectedToken(join(directory, 'reader.token'), TOKEN);
    const runnerToken = await protectedToken(join(directory, 'runner.token'), TOKEN_2);
    const adminToken = await protectedToken(join(directory, 'admin.token'), TOKEN_3);
    const authenticator = loadControlAuthenticator({
      principals: [
        { id: 'reader', tokenFile: readerToken, capabilities: ['read'], workspaces: ['atlas'] },
        { id: 'runner', tokenFile: runnerToken, capabilities: ['run'] },
        { id: 'administrator', tokenFile: adminToken, capabilities: ['admin'], workspaces: ['north'] },
      ],
    });

    expect(authenticator.principalId).toBeUndefined();
    const reader = authenticator.authenticate(`Bearer ${TOKEN}`);
    const runner = authenticator.authenticate(`Bearer ${TOKEN_2}`);
    const administrator = authenticator.authenticate(`Bearer ${TOKEN_3}`);

    expect(reader).toEqual({ id: 'reader', capabilities: ['read'], workspaces: ['atlas'] });
    expect(hasControlCapability(reader!, 'read')).toBe(true);
    expect(hasControlCapability(reader!, 'run')).toBe(false);
    expect(isControlWorkspaceAllowed(reader!, 'atlas')).toBe(true);
    expect(isControlWorkspaceAllowed(reader!, 'other')).toBe(false);
    expect(isControlWorkspaceAllowed(runner!, 'any-workspace')).toBe(true);
    expect(hasControlCapability(administrator!, 'read')).toBe(true);
    expect(hasControlCapability(administrator!, 'run')).toBe(true);
    expect(hasControlCapability(administrator!, 'ingest')).toBe(true);
    expect(hasControlCapability(administrator!, 'approve')).toBe(true);
    expect(Object.isFrozen(reader?.workspaces)).toBe(true);
    expect(Object.isFrozen(administrator?.capabilities)).toBe(true);
  });

  it('rejects duplicate principal IDs, paths, and credential material', async () => {
    const directory = await temporaryDirectory();
    const first = await protectedToken(join(directory, 'first.token'), TOKEN);
    const sameDigest = await protectedToken(join(directory, 'same-digest.token'), TOKEN);

    expect(() => loadControlAuthenticator({
      principals: [
        { id: 'duplicate', tokenFile: first, capabilities: ['read'] },
        { id: 'duplicate', tokenFile: sameDigest, capabilities: ['run'] },
      ],
    })).toThrow(/Duplicate control principal ID/u);

    expect(() => loadControlAuthenticator({
      principals: [
        { id: 'one', tokenFile: first, capabilities: ['read'] },
        { id: 'two', tokenFile: join(directory, '.', 'first.token'), capabilities: ['run'] },
      ],
    })).toThrow(/unique token file paths/u);

    expect(() => loadControlAuthenticator({
      principals: [
        { id: 'one', tokenFile: first, capabilities: ['read'] },
        { id: 'two', tokenFile: sameDigest, capabilities: ['run'] },
      ],
    })).toThrow(/must not share the same Bearer token/u);
  });

  it('rejects empty or duplicate permissions and ambiguous workspace scopes', () => {
    const invalid = (principal: Record<string, unknown>) => () => loadControlAuthenticator({
      principals: [principal],
    } as unknown as ServerAuthConfig);

    expect(invalid({ id: 'empty', tokenFile: '/missing', capabilities: [] }))
      .toThrow(/capabilities must be a non-empty subset/u);
    expect(invalid({ id: 'duplicate', tokenFile: '/missing', capabilities: ['read', 'read'] }))
      .toThrow(/capabilities must not contain duplicates/u);
    expect(invalid({ id: 'empty-scope', tokenFile: '/missing', capabilities: ['read'], workspaces: [] }))
      .toThrow(/workspaces must be omitted/u);
    expect(invalid({
      id: 'duplicate-scope',
      tokenFile: '/missing',
      capabilities: ['read'],
      workspaces: ['atlas', 'atlas'],
    })).toThrow(/workspaces must not contain duplicates/u);
  });

  it('selects a client identity only when selection is unambiguous', () => {
    const legacy: ServerAuthConfig = { tokenFile: '/legacy.token', operatorId: 'legacy' };
    expect(selectControlClientPrincipal(legacy)).toEqual({ id: 'legacy', tokenFile: '/legacy.token' });

    const multiple: ServerAuthConfig = {
      principals: [
        { id: 'reader', tokenFile: '/reader.token', capabilities: ['read'] },
        { id: 'operator', tokenFile: '/operator.token', capabilities: ['run', 'approve'] },
      ],
    };
    expect(() => selectControlClientPrincipal(multiple)).toThrow(/select one explicitly/u);
    expect(selectControlClientPrincipal(multiple, 'operator')).toEqual({
      id: 'operator',
      tokenFile: '/operator.token',
    });
    expect(() => selectControlClientPrincipal(multiple, 'unknown')).toThrow(/is not configured/u);
  });
});

describe('control authentication configuration', () => {
  it('resolves a relative token path against the configuration directory', async () => {
    const directory = await temporaryDirectory();
    const secrets = join(directory, 'secrets');
    await mkdir(secrets, { recursive: true });
    const configPath = await writeConfig(directory, {
      tokenFile: './secrets/control.token',
      operatorId: 'corp.operator@example.com',
    });

    expect(loadConfig(configPath).server.auth).toEqual({
      tokenFile: resolve(directory, 'secrets/control.token'),
      operatorId: 'corp.operator@example.com',
    });
  });

  it('resolves every multi-principal token path and preserves least-privilege scope', async () => {
    const directory = await temporaryDirectory();
    const configPath = await writeConfig(directory, {
      principals: [
        {
          id: 'atlas-reader',
          tokenFile: './secrets/reader.token',
          capabilities: ['read'],
          workspaces: ['atlas'],
        },
        {
          id: 'operator',
          tokenFile: './secrets/operator.token',
          capabilities: ['run', 'approve'],
        },
      ],
    });

    expect(loadConfig(configPath).server.auth).toEqual({
      principals: [
        {
          id: 'atlas-reader',
          tokenFile: resolve(directory, 'secrets/reader.token'),
          capabilities: ['read'],
          workspaces: ['atlas'],
        },
        {
          id: 'operator',
          tokenFile: resolve(directory, 'secrets/operator.token'),
          capabilities: ['run', 'approve'],
        },
      ],
    });
  });

  it('resolves a relative Unix control socket against the configuration directory', async () => {
    const directory = await temporaryDirectory();
    const configPath = await writeConfig(directory, undefined, './state/control.sock');
    expect(loadConfig(configPath).server.socketPath).toBe(resolve(directory, 'state/control.sock'));
  });

  it('preserves legacy configurations without an authentication block', async () => {
    const directory = await temporaryDirectory();
    const configPath = await writeConfig(directory);

    expect(loadConfig(configPath).server).toMatchObject({ host: '127.0.0.1', port: 4310 });
    expect(loadConfig(configPath).server.auth).toBeUndefined();
  });

  it('rejects incomplete or unsafe authentication configuration', async () => {
    const directory = await temporaryDirectory();
    const source = YAML.parse(await readFile('openprojects.config.yaml', 'utf8')) as Record<string, unknown>;
    source.storage = { database: ':memory:' };
    source.server = {
      host: '127.0.0.1',
      port: 4310,
      auth: { tokenFile: './control.token', operatorId: '../impersonator' },
    };
    const configPath = join(directory, 'invalid.yaml');
    await writeFile(configPath, YAML.stringify(source), 'utf8');

    expect(() => loadConfig(configPath)).toThrow(/Invalid config/u);
  });

  it('rejects mixed legacy/multi auth, empty scopes, and duplicate grants in YAML', async () => {
    const directory = await temporaryDirectory();
    const invalidAuth: unknown[] = [
      {
        tokenFile: './legacy.token',
        operatorId: 'legacy',
        principals: [{ id: 'reader', tokenFile: './reader.token', capabilities: ['read'] }],
      },
      { principals: [{ id: 'reader', tokenFile: './reader.token', capabilities: ['read'], workspaces: [] }] },
      { principals: [{ id: 'reader', tokenFile: './reader.token', capabilities: ['read', 'read'] }] },
      {
        principals: [{
          id: 'reader',
          tokenFile: './reader.token',
          capabilities: ['read'],
          workspaces: ['atlas', 'atlas'],
        }],
      },
    ];

    for (const auth of invalidAuth) {
      const source = YAML.parse(await readFile('openprojects.config.yaml', 'utf8')) as Record<string, unknown>;
      source.storage = { database: ':memory:' };
      source.server = { host: '127.0.0.1', port: 4310, auth };
      const configPath = join(directory, `invalid-${invalidAuth.indexOf(auth)}.yaml`);
      await writeFile(configPath, YAML.stringify(source), 'utf8');
      expect(() => loadConfig(configPath)).toThrow(/Invalid config/u);
    }
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'openprojects-control-auth-'));
  temporaryDirectories.add(directory);
  return directory;
}

async function writeConfig(
  directory: string,
  auth?: ServerAuthConfig,
  socketPath?: string,
): Promise<string> {
  const source = YAML.parse(await readFile('openprojects.config.yaml', 'utf8')) as Record<string, unknown>;
  source.storage = { database: ':memory:' };
  source.server = {
    host: '127.0.0.1',
    port: 4310,
    ...(socketPath ? { socketPath } : {}),
    ...(auth ? { auth } : {}),
  };
  const configPath = join(directory, 'openprojects.yaml');
  await writeFile(configPath, YAML.stringify(source), 'utf8');
  return configPath;
}

async function protectedToken(path: string, token: string): Promise<string> {
  await writeFile(path, token, { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}
