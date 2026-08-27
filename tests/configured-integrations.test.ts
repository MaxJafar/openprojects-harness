import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { AppConfig, RunRecord } from '../src/core/types.js';
import { runIntegrationCheck } from '../src/integrations/check.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0).reverse()) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('configured integration lifecycle', () => {
  it('does not load the MCP client graph for JSON API-only manifests', () => {
    const { manifestPath } = fixture();
    const probe = transportImportProbe(manifestPath, 'mcp', ['https://api.github.com']);

    expect({ status: probe.status, stdout: probe.stdout, stderr: probe.stderr }).toEqual({
      status: 0,
      stdout: 'json-api',
      stderr: '',
    });
  });

  it('does not load the JSON API transport for MCP-only manifests', () => {
    const manifestPath = mcpFixture();
    const probe = transportImportProbe(manifestPath, 'json-api', []);

    expect({ status: probe.status, stdout: probe.stdout, stderr: probe.stderr }).toEqual({
      status: 0,
      stdout: 'mcp-stdio',
      stderr: '',
    });
  });

  it('registers exact contracts offline without credentials or network access', async () => {
    const { config, manifestPath } = fixture();
    delete process.env.OPENPROJECTS_TEST_GITHUB_TOKEN;

    const check = await runIntegrationCheck(config);
    expect(check).toMatchObject({
      overall: 'validated',
      probe: false,
      integrations: [{ id: 'github-project', kind: 'json-api' }],
    });

    const app = await createApp({
      config,
      databasePath: ':memory:',
      integrationMode: 'offline',
    });
    try {
      expect(app.integrations).toEqual([
        expect.objectContaining({ id: 'github-project', mode: 'offline' }),
      ]);
      const tool = app.kernel.tool('github_issues');
      expect(tool?.snapshotBinding).toMatchObject({
        protocol: 'mcp.tools-call.v1',
        dataBoundary: 'external',
        transportBinding: expect.objectContaining({
          schema: 'openprojects.integration-binding.v1',
          integrationId: 'github-project',
        }),
      });
      expect(await app.kernel.policyDecision({
        run: run('local'),
        tool: tool!,
        input: {},
      })).toBe('ask');
    } finally {
      await app.close();
    }

    expect(manifestPath).toContain('github.json');
  });

  it('fails a live probe closed when its declared credential is unavailable', async () => {
    const { config } = fixture();
    delete process.env.OPENPROJECTS_TEST_GITHUB_TOKEN;

    const report = await runIntegrationCheck(config, { probe: true });

    expect(report.overall).toBe('not_ready');
    expect(report.error).toBeTruthy();
    expect(JSON.stringify(report)).not.toContain('undefined');
  });
});

function transportImportProbe(
  manifestPath: string,
  blockedTransport: 'json-api' | 'mcp',
  allowedOrigins: string[],
) {
  return spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '--eval',
      `
        import { registerHooks } from 'node:module';
        const blockedTransport = process.argv[1];
        registerHooks({
          resolve(specifier, context, nextResolve) {
            const blockedMcp = blockedTransport === 'mcp'
              && (specifier === './mcp-client.js' || specifier === '@modelcontextprotocol/client');
            const blockedJsonApi = blockedTransport === 'json-api' && specifier === './json-api.js';
            if (blockedMcp || blockedJsonApi) {
              throw new Error('Preparation attempted to load an unconfigured transport module');
            }
            return nextResolve(specifier, context);
          },
        });
        const [
          { loadConfig },
          { createNetworkPolicy },
          { prepareConfiguredIntegrations },
        ] = await Promise.all([
          import('./src/config.ts'),
          import('./src/privacy/network-policy.ts'),
          import('./src/integrations/configured.ts'),
        ]);
        const base = loadConfig('openprojects.config.yaml', {
          loadEnv: false,
          applyProcessEnvOverrides: false,
        });
        const config = {
          ...base,
          integrations: { externalDataPolicy: 'ask', manifests: [process.argv[2]] },
          privacy: { localOnly: true, allowedOrigins: JSON.parse(process.argv[3]) },
        };
        const prepared = await prepareConfiguredIntegrations(
          config,
          createNetworkPolicy(config.privacy),
          { mode: 'offline' },
        );
        process.stdout.write(prepared.summaries.map((summary) => summary.kind).join(','));
      `,
      '--',
      blockedTransport,
      manifestPath,
      JSON.stringify(allowedOrigins),
    ],
    { cwd: process.cwd(), encoding: 'utf8' },
  );
}

function fixture(): { config: AppConfig; manifestPath: string } {
  const directory = mkdtempSync(join(tmpdir(), 'openprojects-configured-integrations-'));
  directories.push(directory);
  const manifestPath = join(directory, 'github.json');
  writeFileSync(manifestPath, `${JSON.stringify({
    schema: 'openprojects.integration.v1',
    id: 'github-project',
    workspaces: ['local'],
    transport: {
      kind: 'json-api',
      baseUrl: 'https://api.github.com',
      auth: { kind: 'bearer', tokenEnv: 'OPENPROJECTS_TEST_GITHUB_TOKEN' },
      staticHeaders: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2026-03-10',
      },
    },
    tools: [{
      name: 'github_issues',
      remoteName: 'issues.list',
      description: 'List reviewed repository issues.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      outputSchema: {
        type: 'object',
        properties: { items: { type: 'array', items: { type: 'string' } } },
        required: ['items'],
        additionalProperties: false,
      },
      effect: 'read',
      idempotency: 'read',
      dataBoundary: 'external',
      limits: {
        timeoutMs: 5_000,
        maxRequestBytes: 16_384,
        maxResponseBytes: 131_072,
        maxTextBytes: 0,
      },
      method: 'GET',
      pathTemplate: {
        template: '/repos/{owner}/{repo}/issues',
        variables: {
          owner: { source: 'literal', value: 'openprojects' },
          repo: { source: 'literal', value: 'harness' },
        },
      },
      query: {
        state: { source: 'literal', value: 'open' },
        per_page: { source: 'literal', value: 25 },
      },
      body: {},
      successStatuses: [200],
    }],
  }, null, 2)}\n`, 'utf8');

  const base = loadConfig('openprojects.config.yaml');
  return {
    manifestPath,
    config: {
      ...base,
      agent: { ...base.agent, tools: [...base.agent.tools, 'github_issues'] },
      integrations: { externalDataPolicy: 'ask', manifests: [manifestPath] },
      privacy: { localOnly: true, allowedOrigins: ['https://api.github.com'] },
      notifications: { ...base.notifications!, enabled: false },
    },
  };
}

function mcpFixture(): string {
  const directory = mkdtempSync(join(tmpdir(), 'openprojects-configured-mcp-'));
  directories.push(directory);
  const manifestPath = join(directory, 'local-mcp.json');
  writeFileSync(manifestPath, `${JSON.stringify({
    schema: 'openprojects.integration.v1',
    id: 'local-mcp',
    transport: {
      kind: 'mcp-stdio',
      command: process.execPath,
      argv: ['node', join(dirname(process.execPath), 'server.mjs')],
      cwd: dirname(process.execPath),
      env: {},
      protocol: 'auto',
      expectedServerName: 'corp-projects',
      expectedServerVersion: '1.2.3',
      maxWireBytes: 4_096,
      maxStderrBytes: 4_096,
      startupTimeoutMs: 5_000,
      shutdownTimeoutMs: 2_000,
      maxPendingRequests: 1,
    },
    tools: [{
      name: 'local_project_read',
      remoteName: 'project_read',
      description: 'Read one project from the reviewed local MCP server.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      outputSchema: { type: 'object', properties: {}, additionalProperties: false },
      effect: 'read',
      idempotency: 'read',
      dataBoundary: 'local',
      limits: {
        timeoutMs: 2_000,
        maxRequestBytes: 4_096,
        maxResponseBytes: 4_096,
        maxTextBytes: 1_024,
      },
    }],
  }, null, 2)}\n`, 'utf8');
  return manifestPath;
}

function run(workspaceId: string): RunRecord {
  const now = '2026-08-25T00:00:00.000Z';
  return {
    id: 'run-integration',
    sessionId: 'session-integration',
    workspaceId,
    actorId: 'operator',
    agentId: 'project-ops',
    agentVersion: '0.5.0',
    status: 'running',
    input: 'list project issues',
    step: 0,
    toolCalls: 0,
    activeMs: 0,
    createdAt: now,
    updatedAt: now,
    metadata: {},
  };
}
