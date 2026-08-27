import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import YAML from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';
import {
  INTEGRATION_MANIFEST_SCHEMA,
  MAX_INTEGRATION_MANIFEST_BYTES,
  loadIntegrationManifest,
  loadIntegrationManifests,
  validateIntegrationManifest,
} from '../src/integrations/manifest.js';

const temporaryDirectories: string[] = [];
const fixtureExecutable = process.execPath;
const fixtureWorkingDirectory = dirname(process.execPath);
const fixtureServerPath = join(fixtureWorkingDirectory, 'server.mjs');

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0).reverse()) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('integration manifest loading', () => {
  it('loads a credential-free JSON API contract and hashes its exact bytes', () => {
    const directory = temporaryDirectory();
    const manifest = jsonApiManifest();
    const source = `${JSON.stringify(manifest, null, 2)}\n`;
    const path = join(directory, 'issues.json');
    writeFileSync(path, source, 'utf8');

    const loaded = loadIntegrationManifest(path);

    expect(loaded.path).toBe(resolve(path));
    expect(loaded.sha256).toBe(createHash('sha256').update(source).digest('hex'));
    expect(loaded.manifest).toEqual(manifest);
    expect(loaded.manifest.workspaces).toEqual(['atlas', 'private-lab']);
    if (loaded.manifest.transport.kind !== 'json-api') throw new Error('Expected JSON API manifest');
    expect(loaded.manifest.transport.auth).toEqual({ kind: 'bearer', tokenEnv: 'ISSUES_API_TOKEN' });
  });

  it('accepts strict YAML and immutable structured JSON body literals', () => {
    const directory = temporaryDirectory();
    const manifest = jsonApiManifest();
    const tool = manifest.tools[0]!;
    tool.method = 'POST';
    tool.effect = 'external_write';
    tool.idempotency = 'keyed';
    tool.pathTemplate = { template: '/issues', variables: {} };
    tool.body = {
      issue: { source: 'input', name: 'issue' },
      fields: {
        source: 'literal',
        value: { tenant: 'corp', labels: ['openprojects', 'reviewed'] },
      },
    };
    tool.idempotencyKeyHeader = 'Idempotency-Key';
    const path = join(directory, 'issues.yaml');
    writeFileSync(path, YAML.stringify(manifest), 'utf8');

    const loaded = loadIntegrationManifest(path);
    expect(loaded.manifest.transport.kind).toBe('json-api');
    expect(loaded.manifest.tools[0]!.idempotency).toBe('keyed');
  });

  it('loads reviewed MCP stdio configuration without reading source environment values', () => {
    const directory = temporaryDirectory();
    const manifest = mcpManifest();
    const path = writeManifest(directory, 'mcp.yaml', manifest);
    delete process.env.OPENPROJECTS_TEST_MCP_SECRET;

    const loaded = loadIntegrationManifest(path);

    expect(loaded.manifest.transport).toMatchObject({
      kind: 'mcp-stdio',
      command: fixtureExecutable,
      env: { MCP_TOKEN: 'OPENPROJECTS_TEST_MCP_SECRET' },
    });
  });

  it('rejects duplicate integration identities and local tool names across files', () => {
    const directory = temporaryDirectory();
    const first = jsonApiManifest();
    const second = jsonApiManifest();
    second.id = 'second';
    const firstPath = writeManifest(directory, 'first.json', first);
    const secondPath = writeManifest(directory, 'second.json', second);

    expect(() => loadIntegrationManifests([firstPath, firstPath])).toThrow(/Duplicate integration manifest path/u);
    second.id = first.id;
    writeManifest(directory, 'second.json', second);
    expect(() => loadIntegrationManifests([firstPath, secondPath])).toThrow(/Duplicate integration id/u);
    second.id = 'second';
    writeManifest(directory, 'second.json', second);
    expect(() => loadIntegrationManifests([firstPath, secondPath])).toThrow(/Duplicate integration tool name/u);
  });

  it('rejects unsafe files, YAML features, and oversized input before composition', () => {
    const directory = temporaryDirectory();
    const aliasPath = join(directory, 'alias.yaml');
    writeFileSync(aliasPath, 'schema: &schema openprojects.integration.v1\nid: *schema\n', 'utf8');
    const duplicateKeyPath = join(directory, 'duplicate.yaml');
    writeFileSync(duplicateKeyPath, 'schema: openprojects.integration.v1\nid: one\nid: two\n', 'utf8');
    const dangerousKeyPath = join(directory, 'dangerous.yaml');
    writeFileSync(dangerousKeyPath, 'schema: openprojects.integration.v1\nid: safe\n__proto__: polluted\n', 'utf8');
    const largePath = join(directory, 'large.yaml');
    writeFileSync(largePath, Buffer.alloc(MAX_INTEGRATION_MANIFEST_BYTES + 1, 0x20));

    expect(() => loadIntegrationManifest(aliasPath)).toThrow(/alias-free/u);
    expect(() => loadIntegrationManifest(duplicateKeyPath)).toThrow(/duplicate/u);
    expect(() => loadIntegrationManifest(dangerousKeyPath)).toThrow(/dangerous object key/u);
    expect(() => loadIntegrationManifest(largePath)).toThrow(/exceeds/u);
  });

  it.skipIf(process.platform === 'win32')('rejects symbolic-link integration manifest paths', () => {
    const directory = temporaryDirectory();
    const validPath = writeManifest(directory, 'valid.json', jsonApiManifest());
    const symlinkPath = join(directory, 'alias.json');
    symlinkSync(validPath, symlinkPath);

    expect(() => loadIntegrationManifest(symlinkPath)).toThrow(/symbolic link/u);
  });

  it('rejects unsafe URLs, headers, templates, mappings, schemas, and boundaries', () => {
    const directory = temporaryDirectory();
    const cases: Array<{ label: string; mutate: (manifest: ReturnType<typeof jsonApiManifest>) => void }> = [
      {
        label: 'origin path',
        mutate: (manifest) => { manifest.transport.baseUrl = 'https://issues.example.test/api'; },
      },
      {
        label: 'credential header',
        mutate: (manifest) => { manifest.transport.staticHeaders.Authorization = 'secret-in-file'; },
      },
      {
        label: 'disguised credential header',
        mutate: (manifest) => { manifest.transport.staticHeaders['X-Api-Key'] = 'secret-in-file'; },
      },
      {
        label: 'compacted credential header',
        mutate: (manifest) => { manifest.transport.staticHeaders['X-ApiKey'] = 'secret-in-file'; },
      },
      {
        label: 'credential query literal',
        mutate: (manifest) => {
          (manifest.tools[0]!.query as Record<string, unknown>).api_key = {
            source: 'literal', value: 'secret-in-file',
          };
        },
      },
      {
        label: 'unsafe integer literal',
        mutate: (manifest) => {
          (manifest.tools[0]!.query.channel as { value: unknown }).value = Number.MAX_SAFE_INTEGER + 1;
        },
      },
      {
        label: 'nested credential body literal',
        mutate: (manifest) => {
          manifest.tools[0]!.method = 'POST';
          manifest.tools[0]!.body = {
            envelope: {
              source: 'literal',
              value: { accessToken: 'secret-in-file' },
            },
            issue: { source: 'input', name: 'issue' },
          };
          manifest.tools[0]!.pathTemplate = { template: '/issues', variables: {} };
        },
      },
      {
        label: 'path traversal',
        mutate: (manifest) => { manifest.tools[0]!.pathTemplate.template = '/issues/../{issue}'; },
      },
      {
        label: 'missing variable',
        mutate: (manifest) => { manifest.tools[0]!.pathTemplate.variables = {}; },
      },
      {
        label: 'unknown input',
        mutate: (manifest) => { manifest.tools[0]!.pathTemplate.variables.issue = { source: 'input', name: 'missing' }; },
      },
      {
        label: 'object in URL',
        mutate: (manifest) => {
          manifest.tools[0]!.inputSchema.properties.issue = {
            type: 'object', additionalProperties: false, properties: {},
          };
        },
      },
      {
        label: 'optional mapped input',
        mutate: (manifest) => {
          delete (manifest.tools[0]!.inputSchema as Record<string, unknown>).required;
        },
      },
      {
        label: 'non-strict schema',
        mutate: (manifest) => { manifest.tools[0]!.outputSchema.additionalProperties = true; },
      },
      {
        label: 'local JSON boundary',
        mutate: (manifest) => { manifest.tools[0]!.dataBoundary = 'local'; },
      },
      {
        label: 'unbound keyed call',
        mutate: (manifest) => {
          manifest.tools[0]!.method = 'POST';
          manifest.tools[0]!.effect = 'external_write';
          manifest.tools[0]!.idempotency = 'keyed';
          manifest.tools[0]!.pathTemplate = { template: '/issues', variables: {} };
          manifest.tools[0]!.body = { issue: { source: 'input', name: 'issue' } };
        },
      },
    ];

    for (const [index, testCase] of cases.entries()) {
      const manifest = jsonApiManifest();
      testCase.mutate(manifest);
      const path = writeManifest(directory, `invalid-${index}.json`, manifest);
      expect(() => loadIntegrationManifest(path), testCase.label).toThrow();
    }
  });

  it('rejects MCP keyed replay semantics and relative process paths', () => {
    const directory = temporaryDirectory();
    const keyed = mcpManifest();
    keyed.tools[0]!.idempotency = 'keyed';
    const keyedPath = writeManifest(directory, 'keyed.json', keyed);
    expect(() => loadIntegrationManifest(keyedPath)).toThrow(/cannot declare keyed/u);

    const relative = mcpManifest();
    relative.transport.command = 'node';
    const relativePath = writeManifest(directory, 'relative.json', relative);
    expect(() => loadIntegrationManifest(relativePath)).toThrow(/absolute paths/u);
  });

  it('applies the lossless plain-JSON boundary to programmatic manifests', () => {
    const unsafeInteger = jsonApiManifest();
    (unsafeInteger.tools[0]!.query.channel as { value: unknown }).value = Number.MAX_SAFE_INTEGER + 1;

    const negativeZero = jsonApiManifest();
    (negativeZero.tools[0]!.query.channel as { value: unknown }).value = -0;

    const nonPlain = jsonApiManifest();
    nonPlain.transport.staticHeaders = Object.assign(
      Object.create({ inherited: 'not-reviewed' }) as Record<string, string>,
      { Accept: 'application/json' },
    );

    const decorated = jsonApiManifest();
    Object.defineProperty(decorated.tools[0]!.successStatuses, 'reviewNote', {
      value: 'hidden',
      enumerable: false,
    });

    const cyclic = jsonApiManifest();
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    (cyclic.tools[0]!.query.channel as { value: unknown }).value = cycle;

    expect(() => validateIntegrationManifest(unsafeInteger), 'unsafe integer').toThrow(/non-JSON value/u);
    expect(() => validateIntegrationManifest(negativeZero), 'negative zero').toThrow(/non-JSON value/u);
    expect(() => validateIntegrationManifest(nonPlain), 'non-plain record').toThrow(/non-plain object/u);
    expect(() => validateIntegrationManifest(decorated), 'decorated array').toThrow(/decorated array/u);
    expect(() => validateIntegrationManifest(cyclic), 'cyclic value').toThrow(/cycle/u);
  });

  it('allows credential-free MCP HTTP only on an exact loopback endpoint', () => {
    const directory = temporaryDirectory();
    const loopback = mcpManifest() as unknown as Record<string, unknown>;
    loopback.transport = {
      kind: 'mcp-http',
      endpoint: 'http://127.0.0.1:4319/mcp',
      protocol: 'legacy',
      expectedServerName: 'corp-projects',
      expectedServerVersion: '1.2.3',
      maxWireBytes: 16_384,
      startupTimeoutMs: 5_000,
      maxPendingRequests: 1,
    };
    expect(loadIntegrationManifest(writeManifest(directory, 'loopback.json', loopback)).manifest.id)
      .toBe('local-mcp');

    const remote = structuredClone(loopback);
    (remote.transport as Record<string, unknown>).endpoint = 'https://mcp.example.test/mcp';
    expect(() => loadIntegrationManifest(writeManifest(directory, 'remote.json', remote)))
      .toThrow(/require bearerTokenEnv/u);

    const mislabeled = structuredClone(remote);
    (mislabeled.transport as Record<string, unknown>).bearerTokenEnv = 'REMOTE_MCP_TOKEN';
    const tools = mislabeled.tools as Array<Record<string, unknown>>;
    tools[0]!.dataBoundary = 'local';
    expect(() => loadIntegrationManifest(writeManifest(directory, 'mislabeled.json', mislabeled)))
      .toThrow(/dataBoundary external/u);
  });

  it('binds hashes to byte-level formatting, not only parsed content', () => {
    const directory = temporaryDirectory();
    const manifest = jsonApiManifest();
    const compact = JSON.stringify(manifest);
    const pretty = JSON.stringify(manifest, null, 2);
    const compactPath = join(directory, 'compact.json');
    const prettyPath = join(directory, 'pretty.json');
    writeFileSync(compactPath, compact, 'utf8');
    writeFileSync(prettyPath, pretty, 'utf8');

    const first = loadIntegrationManifest(compactPath);
    const second = loadIntegrationManifest(prettyPath);
    expect(first.manifest).toEqual(second.manifest);
    expect(first.sha256).not.toBe(second.sha256);
  });
});

describe('integration config path handling', () => {
  it('keeps integrations disabled when absent and resolves explicit paths against the config directory', () => {
    const directory = temporaryDirectory();
    const configDirectory = join(directory, 'config');
    const configPath = writeConfig(configDirectory);
    expect(loadConfig(configPath).integrations).toBeUndefined();

    const source = readBaseConfig();
    source.integrations = {
      externalDataPolicy: 'ask',
      manifests: ['./integrations/issues.yaml', '../shared/mcp.json', resolve(tmpdir(), 'openprojects-corp.yaml')],
    };
    writeFileSync(configPath, YAML.stringify(source), 'utf8');
    expect(loadConfig(configPath).integrations).toEqual({
      externalDataPolicy: 'ask',
      manifests: [
        resolve(configDirectory, 'integrations/issues.yaml'),
        resolve(configDirectory, '../shared/mcp.json'),
        resolve(tmpdir(), 'openprojects-corp.yaml'),
      ],
    });
  });

  it('rejects globs, unknown keys, empty lists, and duplicate resolved paths', () => {
    const directory = temporaryDirectory();
    const invalidIntegrations: unknown[] = [
      { externalDataPolicy: 'ask', manifests: ['integrations/*.yaml'] },
      { externalDataPolicy: 'ask', manifests: [] },
      { externalDataPolicy: 'ask', manifests: ['a.yaml'], credentials: 'forbidden' },
      { externalDataPolicy: 'ask', manifests: ['./a.yaml', 'a.yaml'] },
    ];
    for (const [index, integrations] of invalidIntegrations.entries()) {
      const source = readBaseConfig();
      source.integrations = integrations;
      const path = join(directory, `invalid-config-${index}.yaml`);
      writeFileSync(path, YAML.stringify(source), 'utf8');
      expect(() => loadConfig(path)).toThrow();
    }
  });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'openprojects-integrations-'));
  temporaryDirectories.push(directory);
  return directory;
}

function writeManifest(directory: string, name: string, manifest: unknown): string {
  const path = join(directory, name);
  writeFileSync(path, name.endsWith('.json') ? JSON.stringify(manifest) : YAML.stringify(manifest), 'utf8');
  return path;
}

function writeConfig(directory: string): string {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'openprojects.yaml');
  writeFileSync(path, YAML.stringify(readBaseConfig()), 'utf8');
  return path;
}

function readBaseConfig(): Record<string, unknown> {
  const source = YAML.parse(readFileSync('openprojects.config.yaml', 'utf8')) as Record<string, unknown>;
  source.storage = { database: ':memory:' };
  return source;
}

interface MutableSchema {
  type: string;
  additionalProperties: boolean;
  properties: Record<string, unknown>;
}

function strictSchema(properties: Record<string, unknown> = {}): MutableSchema {
  return { type: 'object', additionalProperties: false, properties };
}

function jsonApiManifest() {
  return {
    schema: INTEGRATION_MANIFEST_SCHEMA,
    id: 'issues',
    workspaces: ['atlas', 'private-lab'],
    transport: {
      kind: 'json-api' as const,
      baseUrl: 'https://issues.example.test',
      auth: { kind: 'bearer' as const, tokenEnv: 'ISSUES_API_TOKEN' },
      staticHeaders: { Accept: 'application/json' } as Record<string, string>,
    },
    tools: [{
      name: 'issues_get',
      remoteName: 'get_issue',
      description: 'Read one issue from the reviewed corporate issue service.',
      inputSchema: {
        ...strictSchema({ issue: { type: 'string', minLength: 1 } }),
        required: ['issue'],
      },
      outputSchema: strictSchema({ id: { type: 'string' } }),
      effect: 'read' as 'read' | 'draft' | 'memory_write' | 'internal_write' | 'external_write' | 'destructive',
      idempotency: 'read' as 'read' | 'keyed' | 'none',
      dataBoundary: 'external' as 'local' | 'external',
      limits: {
        timeoutMs: 2_000,
        maxRequestBytes: 4_096,
        maxResponseBytes: 16_384,
        maxTextBytes: 8_192,
      },
      method: 'GET' as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
      pathTemplate: {
        template: '/issues/{issue}',
        variables: {
          issue: { source: 'input' as const, name: 'issue' },
        } as Record<string, { source: 'input'; name: string }>,
      },
      query: {
        channel: { source: 'literal' as const, value: 'bound-corporate' },
      },
      body: {} as Record<string, unknown>,
      successStatuses: [200],
      idempotencyKeyHeader: undefined as string | undefined,
    }],
  };
}

function mcpManifest() {
  return {
    schema: INTEGRATION_MANIFEST_SCHEMA,
    id: 'local-mcp',
    transport: {
      kind: 'mcp-stdio' as const,
      command: fixtureExecutable,
      argv: ['node', fixtureServerPath],
      cwd: fixtureWorkingDirectory,
      env: { MCP_TOKEN: 'OPENPROJECTS_TEST_MCP_SECRET' },
      protocol: 'auto' as const,
      expectedServerName: 'corp-projects',
      expectedServerVersion: '1.2.3',
      maxWireBytes: 262_144,
      maxStderrBytes: 16_384,
      startupTimeoutMs: 5_000,
      shutdownTimeoutMs: 2_000,
      maxPendingRequests: 4,
    },
    tools: [{
      name: 'local_task_create',
      remoteName: 'task_create',
      description: 'Create one local task through the reviewed MCP server.',
      inputSchema: strictSchema({ title: { type: 'string' } }),
      outputSchema: strictSchema({ id: { type: 'string' } }),
      effect: 'internal_write' as const,
      idempotency: 'none' as 'read' | 'keyed' | 'none',
      dataBoundary: 'local' as const,
      limits: {
        timeoutMs: 2_000,
        maxRequestBytes: 4_096,
        maxResponseBytes: 16_384,
        maxTextBytes: 8_192,
      },
    }],
  };
}
