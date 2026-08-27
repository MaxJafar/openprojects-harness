import { createHash } from 'node:crypto';

import type { HarnessPlugin } from '../core/kernel.js';
import type { PolicyDecision } from '../core/types.js';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;

export interface IntegrationPolicyOptions {
  readonly integrationId: string;
  readonly manifestDigest: string;
  readonly toolNames: readonly string[];
  readonly externalToolNames: readonly string[];
  readonly externalDataPolicy: PolicyDecision;
  /** Omitted means every workspace; a configured list is an exact allowlist. */
  readonly workspaces?: readonly string[];
}

/**
 * Adds a second, monotonic authority check for configured integrations.
 *
 * Tool effects still flow through the ordinary effect policy. This guard only
 * answers two questions that an effect cannot express: may this workspace use
 * the connector, and may arguments leave the host? A deny/ask can only make
 * the aggregate kernel decision stricter.
 */
export function integrationPolicyPlugin(options: IntegrationPolicyOptions): HarnessPlugin {
  validate(options);
  const toolNames = new Set(options.toolNames);
  const externalNames = new Set(options.externalToolNames);
  const workspaces = options.workspaces ? new Set(options.workspaces) : undefined;
  const commitment = createHash('sha256')
    .update(JSON.stringify({
      integrationId: options.integrationId,
      manifestDigest: options.manifestDigest,
      toolNames: [...toolNames].sort(),
      externalToolNames: [...externalNames].sort(),
      externalDataPolicy: options.externalDataPolicy,
      workspaces: workspaces ? [...workspaces].sort() : null,
    }))
    .digest('hex')
    .slice(0, 16);

  return {
    id: `integration-policy:${options.integrationId}:${commitment}`,
    setup(context) {
      context.registerToolGuard(({ run, tool }) => {
        if (!toolNames.has(tool.name)) return 'abstain';
        if (workspaces && !workspaces.has(run.workspaceId)) return 'deny';
        return externalNames.has(tool.name) ? options.externalDataPolicy : 'abstain';
      });
    },
  };
}

function validate(options: IntegrationPolicyOptions): void {
  if (!SAFE_ID.test(options.integrationId)) throw new Error('Invalid integration policy id');
  if (!DIGEST.test(options.manifestDigest)) throw new Error('Invalid integration manifest digest');
  if (!['allow', 'ask', 'deny'].includes(options.externalDataPolicy)) {
    throw new Error('Invalid integration external-data policy');
  }
  if (!options.toolNames.length || new Set(options.toolNames).size !== options.toolNames.length) {
    throw new Error('Integration policy requires unique tool names');
  }
  for (const name of options.toolNames) {
    if (!SAFE_ID.test(name)) throw new Error(`Invalid integration tool name: ${name}`);
  }
  for (const name of options.externalToolNames) {
    if (!options.toolNames.includes(name)) {
      throw new Error(`External integration tool is not in the integration tool set: ${name}`);
    }
  }
  if (options.workspaces) {
    if (!options.workspaces.length || new Set(options.workspaces).size !== options.workspaces.length) {
      throw new Error('Integration workspaces must be a non-empty unique allowlist');
    }
    for (const workspace of options.workspaces) {
      if (!SAFE_ID.test(workspace)) throw new Error(`Invalid integration workspace id: ${workspace}`);
    }
  }
}
