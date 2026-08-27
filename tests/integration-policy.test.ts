import { describe, expect, it } from 'vitest';

import { HarnessKernel } from '../src/core/kernel.js';
import type { RunRecord, ToolDefinition } from '../src/core/types.js';
import { integrationPolicyPlugin } from '../src/integrations/policy.js';

const digest = 'a'.repeat(64);

describe('configured integration authority guard', () => {
  it('asks before external disclosure while leaving local tools to effect policy', async () => {
    const kernel = new HarnessKernel();
    await kernel.mount(integrationPolicyPlugin({
      integrationId: 'github',
      manifestDigest: digest,
      toolNames: ['github_read', 'local_read'],
      externalToolNames: ['github_read'],
      externalDataPolicy: 'ask',
    }));

    expect(await kernel.policyDecision(context('github_read', 'local'))).toBe('ask');
    expect(await kernel.policyDecision(context('local_read', 'local'))).toBe('allow');
    await kernel.dispose();
  });

  it('denies a connector outside its exact workspace scope', async () => {
    const kernel = new HarnessKernel();
    await kernel.mount(integrationPolicyPlugin({
      integrationId: 'jira',
      manifestDigest: digest,
      toolNames: ['jira_search'],
      externalToolNames: ['jira_search'],
      externalDataPolicy: 'allow',
      workspaces: ['product'],
    }));

    expect(await kernel.policyDecision(context('jira_search', 'product'))).toBe('allow');
    expect(await kernel.policyDecision(context('jira_search', 'finance'))).toBe('deny');
    await kernel.dispose();
  });
});

function context(name: string, workspaceId: string) {
  return {
    run: run(workspaceId),
    tool: tool(name),
    input: {},
  };
}

function tool(name: string): ToolDefinition {
  return {
    name,
    description: name,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    effect: 'read',
    idempotency: 'read',
    async execute() {
      return {};
    },
  };
}

function run(workspaceId: string): RunRecord {
  const now = '2026-08-25T00:00:00.000Z';
  return {
    id: 'run-1',
    sessionId: 'session-1',
    workspaceId,
    actorId: 'actor-1',
    agentId: 'agent-1',
    agentVersion: '1',
    status: 'running',
    input: 'test',
    step: 0,
    toolCalls: 0,
    activeMs: 0,
    createdAt: now,
    updatedAt: now,
    metadata: {},
  };
}
