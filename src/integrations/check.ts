import { HarnessKernel } from '../core/kernel.js';
import type { AppConfig } from '../core/types.js';
import { createNetworkPolicy } from '../privacy/network-policy.js';
import {
  prepareConfiguredIntegrations,
  type ConfiguredIntegrationSummary,
} from './configured.js';

export const INTEGRATION_CHECK_SCHEMA = 'openprojects.integration-check.v1' as const;

export interface IntegrationCheckReport {
  readonly schema: typeof INTEGRATION_CHECK_SCHEMA;
  readonly overall: 'validated' | 'probed' | 'not_ready';
  readonly probe: boolean;
  readonly integrations: readonly IntegrationCheckSummary[];
  readonly error?: string;
}

export interface IntegrationCheckSummary extends Omit<ConfiguredIntegrationSummary, 'mode' | 'tools'> {
  readonly tools: readonly (ConfiguredIntegrationSummary['tools'][number] & {
    /** Whether the current supervisor agent grant exposes this installed tool. */
    readonly granted: boolean;
  })[];
}

export interface IntegrationCheckOptions {
  readonly probe?: boolean;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof fetch;
}

/** Validate manifests without IO, or explicitly start and identify every peer. */
export async function runIntegrationCheck(
  config: AppConfig,
  options: IntegrationCheckOptions = {},
): Promise<IntegrationCheckReport> {
  const probe = options.probe === true;
  const kernel = new HarnessKernel();
  let summaries: readonly ConfiguredIntegrationSummary[] = [];
  let failure: unknown;
  try {
    const networkPolicy = createNetworkPolicy(config.privacy);
    const prepared = await prepareConfiguredIntegrations(config, networkPolicy, {
      mode: probe ? 'live' : 'offline',
      ...(options.environment ? { environment: options.environment } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    summaries = prepared.summaries;
    if (probe) {
      for (const plugin of prepared.plugins) await kernel.mount(plugin);
    }
  } catch (error) {
    failure = error;
  } finally {
    try {
      await kernel.dispose();
    } catch (error) {
      failure ??= error;
    }
  }

  const grants = new Set(config.agent.tools);
  const integrations = summaries.map(({ mode: _mode, ...summary }): IntegrationCheckSummary => ({
    ...summary,
    tools: summary.tools.map((tool) => ({ ...tool, granted: grants.has(tool.name) })),
  }));
  if (failure) {
    return {
      schema: INTEGRATION_CHECK_SCHEMA,
      overall: 'not_ready',
      probe,
      integrations,
      error: safeError(failure),
    };
  }
  return {
    schema: INTEGRATION_CHECK_SCHEMA,
    overall: probe ? 'probed' : 'validated',
    probe,
    integrations,
  };
}

export function renderIntegrationCheck(report: IntegrationCheckReport): string {
  const lines = [
    `Integration check: ${report.overall.toUpperCase()}`,
    `Mode: ${report.probe ? 'live peer probe' : 'offline manifest validation'}`,
  ];
  if (report.integrations.length === 0) lines.push('No integrations configured.');
  for (const integration of report.integrations) {
    lines.push(
      `- ${integration.id} [${integration.kind}] ${integration.manifestSha256.slice(0, 12)} `
      + `(${integration.tools.length} tool${integration.tools.length === 1 ? '' : 's'})`,
    );
    for (const tool of integration.tools) {
      lines.push(
        `  - ${tool.name}: ${tool.effect}, ${tool.dataBoundary}, ${tool.idempotency}, `
        + (tool.granted ? 'granted' : 'not granted'),
      );
    }
  }
  if (report.error) lines.push(`Error: ${report.error}`);
  return `${lines.join('\n')}\n`;
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Integration check failed';
  return message
    .replace(/Bearer\s+\S+/giu, 'Bearer [REDACTED]')
    .replace(/[\r\n\u0000-\u001f\u007f]+/gu, ' ')
    .slice(0, 1_024);
}
