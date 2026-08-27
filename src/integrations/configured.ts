import type { HarnessPlugin } from '../core/kernel.js';
import { ToolExecutionError } from '../core/kernel.js';
import type { AppConfig, JsonObject } from '../core/types.js';
import {
  mcpToolGatewayPlugin,
  type LocalMcpToolDeclaration,
  type McpCallToolOptions,
  type McpCallToolRequest,
  type McpCallToolTransport,
} from '../mcp/gateway.js';
import type { OutboundNetworkPolicy } from '../privacy/network-policy.js';
import {
  loadIntegrationManifests,
  type IntegrationManifest,
  type LoadedIntegrationManifest,
} from './manifest.js';
import { integrationPolicyPlugin } from './policy.js';

type JsonApiTransportFactory = typeof import('./json-api.js')['createJsonApiTransport'];
type McpClientTransportFactory = typeof import('./mcp-client.js')['createMcpClientTransport'];

interface IntegrationTransportFactories {
  readonly jsonApi?: JsonApiTransportFactory;
  readonly mcp?: McpClientTransportFactory;
}

export type IntegrationMode = 'live' | 'offline';

export interface ConfiguredIntegrationToolSummary {
  readonly name: string;
  readonly effect: LocalMcpToolDeclaration['effect'];
  readonly idempotency: LocalMcpToolDeclaration['idempotency'];
  readonly dataBoundary: NonNullable<LocalMcpToolDeclaration['dataBoundary']>;
}

export interface ConfiguredIntegrationSummary {
  readonly id: string;
  readonly kind: IntegrationManifest['transport']['kind'];
  readonly manifestSha256: string;
  /** Omitted means the reviewed connector is available to every workspace. */
  readonly workspaces?: readonly string[];
  readonly tools: readonly ConfiguredIntegrationToolSummary[];
  readonly mode: IntegrationMode;
}

export interface PreparedIntegrations {
  readonly manifests: readonly LoadedIntegrationManifest[];
  readonly plugins: readonly HarnessPlugin[];
  readonly summaries: readonly ConfiguredIntegrationSummary[];
}

export interface PrepareIntegrationsOptions {
  readonly mode?: IntegrationMode;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof fetch;
}

/**
 * Compile configured manifests into ordinary kernel plugins.
 *
 * `offline` preserves the exact local tool contracts for composition and
 * snapshot inspection, while making calls inert and performing no credential
 * reads, child-process spawning, or network requests.
 */
export async function prepareConfiguredIntegrations(
  config: AppConfig,
  networkPolicy: OutboundNetworkPolicy,
  options: PrepareIntegrationsOptions = {},
): Promise<PreparedIntegrations> {
  const integrationConfig = config.integrations;
  if (!integrationConfig) return { manifests: [], plugins: [], summaries: [] };

  const mode = options.mode ?? 'live';
  const manifests = loadIntegrationManifests(integrationConfig.manifests);
  const transportFactories = await loadTransportFactories(manifests);
  const plugins: HarnessPlugin[] = [];
  const summaries: ConfiguredIntegrationSummary[] = [];

  for (const loaded of manifests) {
    const manifest = loaded.manifest;
    if (manifest.transport.kind === 'json-api') {
      networkPolicy.assertAllowed(manifest.transport.baseUrl, `integration ${manifest.id}`);
    } else if (manifest.transport.kind === 'mcp-http') {
      networkPolicy.assertAllowed(manifest.transport.endpoint, `integration ${manifest.id}`);
    }
    const declarations = manifest.tools.map((tool): LocalMcpToolDeclaration => ({
      name: tool.name,
      remoteName: tool.remoteName,
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      effect: tool.effect,
      dataBoundary: tool.dataBoundary,
      idempotency: tool.idempotency,
      limits: tool.limits,
    }));
    // Compile the concrete transport in both modes so offline validation still
    // catches unsafe URLs, mappings, wire limits, and network-policy conflicts.
    // Constructors are required to perform no credential IO, spawning, or
    // network requests; only a live gateway mount calls start().
    const reviewedTransport = liveTransport(loaded, networkPolicy, options, transportFactories);
    const transport = bindManifestIdentity(
      mode === 'offline'
        ? new OfflineIntegrationTransport(manifest.id, reviewedTransport.snapshotBinding)
        : reviewedTransport,
      loaded,
      mode,
    );

    plugins.push(integrationPolicyPlugin({
      integrationId: manifest.id,
      manifestDigest: loaded.sha256,
      toolNames: declarations.map((tool) => tool.name),
      externalToolNames: declarations
        .filter((tool) => tool.dataBoundary === 'external')
        .map((tool) => tool.name),
      externalDataPolicy: integrationConfig.externalDataPolicy,
      ...(manifest.workspaces ? { workspaces: manifest.workspaces } : {}),
    }));
    plugins.push(mcpToolGatewayPlugin({
      id: `integration.${loaded.sha256.slice(0, 24)}`,
      transport,
      tools: declarations,
    }));
    summaries.push(Object.freeze({
      id: manifest.id,
      kind: manifest.transport.kind,
      manifestSha256: loaded.sha256,
      ...(manifest.workspaces ? { workspaces: Object.freeze([...manifest.workspaces]) } : {}),
      tools: Object.freeze(declarations.map((tool) => Object.freeze({
        name: tool.name,
        effect: tool.effect,
        idempotency: tool.idempotency,
        dataBoundary: tool.dataBoundary ?? 'local',
      }))),
      mode,
    }));
  }

  return {
    manifests: Object.freeze([...manifests]),
    plugins: Object.freeze(plugins),
    summaries: Object.freeze(summaries),
  };
}

async function loadTransportFactories(
  manifests: readonly LoadedIntegrationManifest[],
): Promise<IntegrationTransportFactories> {
  const needsJsonApi = manifests.some((loaded) => loaded.manifest.transport.kind === 'json-api');
  const needsMcp = manifests.some((loaded) => loaded.manifest.transport.kind !== 'json-api');
  const [jsonApiModule, mcpModule] = await Promise.all([
    needsJsonApi ? import('./json-api.js') : Promise.resolve(undefined),
    needsMcp ? import('./mcp-client.js') : Promise.resolve(undefined),
  ]);
  return {
    ...(jsonApiModule ? { jsonApi: jsonApiModule.createJsonApiTransport } : {}),
    ...(mcpModule ? { mcp: mcpModule.createMcpClientTransport } : {}),
  };
}

function liveTransport(
  loaded: LoadedIntegrationManifest,
  networkPolicy: OutboundNetworkPolicy,
  options: PrepareIntegrationsOptions,
  factories: IntegrationTransportFactories,
): McpCallToolTransport {
  const dependencies = {
    networkPolicy,
    ...(options.environment ? { environment: options.environment } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  };
  if (loaded.manifest.transport.kind === 'json-api') {
    if (!factories.jsonApi) throw new Error('JSON API transport module was not loaded');
    return factories.jsonApi(loaded.manifest, { ...dependencies, manifestSha256: loaded.sha256 });
  }
  if (!factories.mcp) throw new Error('MCP transport module was not loaded');
  return factories.mcp(loaded.manifest, dependencies);
}

function bindManifestIdentity(
  transport: McpCallToolTransport,
  loaded: LoadedIntegrationManifest,
  mode: IntegrationMode,
): McpCallToolTransport {
  const binding: JsonObject = {
    schema: 'openprojects.integration-binding.v1',
    integrationId: loaded.manifest.id,
    manifestSha256: loaded.sha256,
    mode,
    transportId: transport.id,
    ...(transport.snapshotBinding ? { transport: transport.snapshotBinding } : {}),
  };
  return {
    id: `integration:${loaded.manifest.id}:${loaded.sha256.slice(0, 16)}`,
    snapshotBinding: binding,
    ...(transport.start ? { start: () => transport.start!() } : {}),
    ...(transport.close ? { close: () => transport.close!() } : {}),
    callTool(request, options) {
      return transport.callTool(request, options);
    },
  };
}

class OfflineIntegrationTransport implements McpCallToolTransport {
  readonly id: string;
  readonly snapshotBinding: JsonObject;

  constructor(integrationId: string, reviewedBinding: JsonObject | undefined) {
    this.id = `offline:${integrationId}`;
    this.snapshotBinding = {
      schema: 'openprojects.integration-offline.v1',
      inert: true,
      ...(reviewedBinding ? { reviewedTransport: reviewedBinding } : {}),
    };
  }

  callTool(_request: McpCallToolRequest, _options: McpCallToolOptions): Promise<never> {
    return Promise.reject(new ToolExecutionError(
      'INTEGRATION_OFFLINE',
      'Configured integrations are disabled in this process mode',
    ));
  }
}
