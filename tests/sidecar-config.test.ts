import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  loadSidecarConfig,
  sidecarConfigSummary,
} from '../src/sidecars/config.js';

const temporaryDirectories = new Set<string>();

afterEach(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  temporaryDirectories.clear();
});

describe('sidecar config', () => {
  it('loads a strict Linear contract, resolves local paths, and freezes the result', () => {
    const directory = temporaryDirectory();
    const path = writeConfig(directory, linearConfig());

    const loaded = loadSidecarConfig(path);

    expect(loaded).toMatchObject({
      path: resolve(path),
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      contractSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      config: {
        schema: 'openprojects.sidecar.v1',
        id: 'linear-primary',
        oracle: {
          baseUrl: 'http://127.0.0.1:4310',
          tokenFile: join(directory, 'secrets', 'ingest.token'),
          ...(process.platform === 'win32'
            ? {}
            : { socketPath: join(directory, 'run', 'openprojects.sock') }),
        },
        state: { directory: join(directory, 'state') },
        provider: { kind: 'linear', authorization: 'api-key' },
      },
    });
    expect(isAbsolute(loaded.config.oracle.tokenFile)).toBe(true);
    expect(isAbsolute(loaded.config.state.directory)).toBe(true);
    expect(Object.isFrozen(loaded)).toBe(true);
    expect(Object.isFrozen(loaded.config)).toBe(true);
    expect(Object.isFrozen(loaded.config.provider)).toBe(true);
    expect(Object.isFrozen(loaded.config.limits)).toBe(true);
  });

  it('separates the exact source digest from the canonical reviewed contract digest', () => {
    const directory = temporaryDirectory();
    const config = linearConfig();
    const compactPath = writeConfig(directory, config, 'compact.json');
    const prettyPath = writeConfig(directory, config, 'pretty.json', true);

    const compact = loadSidecarConfig(compactPath);
    const pretty = loadSidecarConfig(prettyPath);

    expect(compact.sha256).not.toBe(pretty.sha256);
    expect(compact.contractSha256).toBe(pretty.contractSha256);
    expect(compact.config).toEqual(pretty.config);
  });

  it('accepts the exact Jira shape while rejecting provider-shape ambiguity', () => {
    const directory = temporaryDirectory();
    const validPath = writeConfig(directory, jiraConfig(), 'jira.json');
    expect(loadSidecarConfig(validPath).config.provider).toEqual({
      kind: 'jira',
      tokenEnv: 'OPENPROJECTS_TEST_JIRA_TOKEN',
      expectedAccountId: 'cloud-account-1',
      projectKey: 'OPS_2',
    });

    const ambiguous = jiraConfig();
    Object.assign(ambiguous.provider, { authorization: 'oauth-bearer' });
    const ambiguousPath = writeConfig(directory, ambiguous, 'ambiguous.json');
    expect(() => loadSidecarConfig(ambiguousPath)).toThrow(/additional properties/u);
  });

  it.each([
    ['top-level field', (config: ConfigRecord) => { config.unreviewed = true; }],
    ['oracle field', (config: ConfigRecord) => { config.oracle.unreviewed = true; }],
    ['state field', (config: ConfigRecord) => { config.state.unreviewed = true; }],
    ['provider field', (config: ConfigRecord) => { config.provider.unreviewed = true; }],
    ['limits field', (config: ConfigRecord) => { config.limits.unreviewed = true; }],
  ])('rejects every unknown %s', (_label, mutate) => {
    const directory = temporaryDirectory();
    const config = linearConfig();
    mutate(config);

    expect(() => loadSidecarConfig(writeConfig(directory, config))).toThrow(/additional properties/u);
  });

  it.each([
    ['schema', (config: ConfigRecord) => { config.schema = 'openprojects.sidecar.v2'; }],
    ['unsafe identifier', (config: ConfigRecord) => { config.id = '../escape'; }],
    ['environment name', (config: ConfigRecord) => { config.provider.tokenEnv = 'TOKEN-NAME'; }],
    ['Linear authorization', (config: ConfigRecord) => { config.provider.authorization = 'basic'; }],
    ['page size', (config: ConfigRecord) => { config.limits.pageSize = 101; }],
    ['timeout', (config: ConfigRecord) => { config.limits.timeoutMs = 999; }],
    ['response bytes', (config: ConfigRecord) => { config.limits.maxResponseBytes = 1_023; }],
    ['overlap', (config: ConfigRecord) => { config.limits.overlapSeconds = -1; }],
    ['page budget', (config: ConfigRecord) => { config.limits.maxPagesPerRun = 0; }],
  ])('rejects an invalid %s value', (_label, mutate) => {
    const directory = temporaryDirectory();
    const config = linearConfig();
    mutate(config);

    expect(() => loadSidecarConfig(writeConfig(directory, config))).toThrow('Sidecar config is invalid');
  });

  it('rejects duplicate YAML/JSON mapping keys before schema validation', () => {
    const directory = temporaryDirectory();
    const path = join(directory, 'duplicate.json');
    const text = JSON.stringify(linearConfig()).replace(
      '"id":"linear-primary"',
      '"id":"linear-primary","id":"shadow-contract"',
    );
    writeFileSync(path, text, 'utf8');

    expect(() => loadSidecarConfig(path)).toThrow(/not valid YAML or JSON.*unique/u);
  });

  it.each([
    'https://oracle.example.test',
    'http://127.0.0.1:4310/',
    'http://user:secret@127.0.0.1:4310',
    'http://127.0.0.1:4310/api',
    'http://127.0.0.1:4310?mode=ingest',
    'file:///tmp/openprojects.sock',
    'not-a-url',
  ])('rejects a non-exact or non-loopback Oracle origin: %s', (baseUrl) => {
    const directory = temporaryDirectory();
    const config = linearConfig();
    config.oracle.baseUrl = baseUrl;

    expect(() => loadSidecarConfig(writeConfig(directory, config))).toThrow(
      /exact loopback HTTP\(S\) origin/u,
    );
  });

  it('requires an HTTP virtual origin for the POSIX Unix-socket transport', () => {
    const directory = temporaryDirectory();
    const config = linearConfig();
    config.oracle.baseUrl = 'https://127.0.0.1:4310';
    config.oracle.socketPath = './run/openprojects.sock';

    expect(() => loadSidecarConfig(writeConfig(directory, config))).toThrow(
      process.platform === 'win32'
        ? 'oracle.socketPath is POSIX-only'
        : 'oracle.socketPath requires an exact loopback HTTP origin',
    );
  });

  it.skipIf(process.platform === 'win32')('refuses a symbolic-link config without following it', () => {
    const directory = temporaryDirectory();
    const target = writeConfig(directory, linearConfig(), 'target.json');
    const alias = join(directory, 'alias.json');
    symlinkSync(target, alias);

    expect(() => loadSidecarConfig(alias)).toThrow('not a symbolic link');
  });

  it('refuses non-regular and over-limit config inputs', () => {
    const directory = temporaryDirectory();
    const nestedDirectory = join(directory, 'not-a-file');
    mkdirSync(nestedDirectory);
    expect(() => loadSidecarConfig(nestedDirectory)).toThrow('regular file');

    const oversized = join(directory, 'oversized.yaml');
    writeFileSync(oversized, Buffer.alloc(1_048_577, 0x20));
    expect(() => loadSidecarConfig(oversized)).toThrow('no larger than 1048576 bytes');
  });

  it('summarizes the reviewed contract without reading or disclosing provider credentials', () => {
    const directory = temporaryDirectory();
    const config = linearConfig();
    config.oracle.tokenFile = './missing-secret-that-must-not-be-read';
    const secret = 'provider-secret-that-must-not-appear';
    const previous = process.env.OPENPROJECTS_TEST_LINEAR_TOKEN;
    process.env.OPENPROJECTS_TEST_LINEAR_TOKEN = secret;
    try {
      const loaded = loadSidecarConfig(writeConfig(directory, config));
      const summary = sidecarConfigSummary(loaded);
      const serialized = JSON.stringify(summary);

      expect(summary).toEqual({
        schema: 'openprojects.sidecar.v1',
        id: 'linear-primary',
        path: loaded.path,
        sha256: loaded.sha256,
        contractSha256: loaded.contractSha256,
        workspaceId: 'workspace-main',
        stream: 'issues',
        provider: 'linear',
        expectedAccountSha256: createHash('sha256').update('linear-account-1').digest('hex'),
        readOnly: true,
        providerWrites: 0,
        credentialLifecycle: 'externally-managed',
        oauthFlowInvoked: false,
      });
      expect(serialized).not.toContain(secret);
      expect(serialized).not.toContain('linear-account-1');
      expect(serialized).not.toContain('missing-secret-that-must-not-be-read');
      expect(serialized).not.toContain('OPENPROJECTS_TEST_LINEAR_TOKEN');
    } finally {
      if (previous === undefined) delete process.env.OPENPROJECTS_TEST_LINEAR_TOKEN;
      else process.env.OPENPROJECTS_TEST_LINEAR_TOKEN = previous;
    }
  });
});

interface ConfigRecord extends Record<string, unknown> {
  schema: string;
  id: string;
  workspaceId: string;
  stream: string;
  localProjectId: string;
  oracle: Record<string, unknown> & { baseUrl: string; tokenFile: string; socketPath?: string };
  state: Record<string, unknown> & { directory: string };
  provider: Record<string, unknown> & {
    kind: string;
    tokenEnv: string;
    authorization?: string;
    expectedAccountId: string;
    teamId?: string;
    projectKey?: string;
  };
  limits: Record<string, unknown> & {
    pageSize: number;
    timeoutMs: number;
    maxResponseBytes: number;
    overlapSeconds: number;
    maxPagesPerRun: number;
  };
}

function linearConfig(): ConfigRecord {
  return {
    schema: 'openprojects.sidecar.v1',
    id: 'linear-primary',
    workspaceId: 'workspace-main',
    stream: 'issues',
    localProjectId: 'local-project',
    oracle: {
      baseUrl: 'http://127.0.0.1:4310',
      ...(process.platform === 'win32'
        ? {}
        : { socketPath: './run/openprojects.sock' }),
      tokenFile: './secrets/ingest.token',
    },
    state: { directory: './state' },
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
  };
}

function jiraConfig(): ConfigRecord {
  const config = linearConfig();
  config.id = 'jira-primary';
  config.provider = {
    kind: 'jira',
    tokenEnv: 'OPENPROJECTS_TEST_JIRA_TOKEN',
    expectedAccountId: 'cloud-account-1',
    projectKey: 'OPS_2',
  };
  return config;
}

function writeConfig(
  directory: string,
  config: ConfigRecord,
  name = 'sidecar.json',
  pretty = false,
): string {
  const path = join(directory, name);
  writeFileSync(path, `${JSON.stringify(config, null, pretty ? 2 : undefined)}\n`, 'utf8');
  return path;
}

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'openprojects-sidecar-config-'));
  temporaryDirectories.add(directory);
  return directory;
}
