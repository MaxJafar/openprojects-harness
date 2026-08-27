import type { JsonObject } from '../../core/types.js';
import type { CorporateRecordInput } from '../../oracle/corporate-oracle.js';
import {
  BoundedProviderHttp,
  providerCredential,
  type SidecarProviderCredential,
} from '../bounded-http.js';
import type { LoadedSidecarConfig, LinearSidecarProvider, SidecarProviderPage } from '../types.js';
import {
  arrayValue,
  assertProviderReadWindow,
  boundedOptionalProviderText,
  boundedProviderText,
  finiteNumber,
  finalizeProviderRecords,
  jsonMetadata,
  normalizedProviderTimestamp,
  objectValue,
  optionalString,
  providerRecordWithinWindow,
  safeProviderUrl,
  stringValue,
} from './common.js';
import type {
  SidecarProviderAdapter,
  SidecarProviderDependencies,
  SidecarReadWindow,
} from './provider.js';

const LINEAR_ORIGIN = 'https://api.linear.app';
const LINEAR_WEB_ORIGIN = 'https://linear.app';
const IDENTITY_QUERY = 'query OpenProjectsLinearIdentity { organization { id } }';
const INITIAL_ISSUES_QUERY = `query OpenProjectsLinearIssues(
  $teamId: String!, $first: Int!, $after: String, $until: DateTimeOrDuration!
) {
  organization { id }
  team(id: $teamId) {
    id
    issues(
      first: $first
      after: $after
      orderBy: updatedAt
      filter: { updatedAt: { lte: $until } }
    ) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id identifier title priority createdAt updatedAt dueDate url
        state { id name type }
        assignee { id name }
        project { id name }
      }
    }
  }
}`;
const INCREMENTAL_ISSUES_QUERY = `query OpenProjectsLinearIssues(
  $teamId: String!, $first: Int!, $after: String,
  $from: DateTimeOrDuration!, $until: DateTimeOrDuration!
) {
  organization { id }
  team(id: $teamId) {
    id
    issues(
      first: $first
      after: $after
      orderBy: updatedAt
      filter: { updatedAt: { gte: $from, lte: $until } }
    ) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id identifier title priority createdAt updatedAt dueDate url
        state { id name type }
        assignee { id name }
        project { id name }
      }
    }
  }
}`;

export function createLinearSidecar(
  loaded: LoadedSidecarConfig,
  dependencies: SidecarProviderDependencies = {},
): SidecarProviderAdapter {
  if (loaded.config.provider.kind !== 'linear') throw new Error('Linear sidecar requires a Linear config');
  return new LinearSidecar(loaded, loaded.config.provider, dependencies);
}

class LinearSidecar implements SidecarProviderAdapter {
  readonly kind = 'linear' as const;
  readonly #loaded: LoadedSidecarConfig;
  readonly #provider: LinearSidecarProvider;
  readonly #http: BoundedProviderHttp;
  readonly #credential: SidecarProviderCredential;

  constructor(
    loaded: LoadedSidecarConfig,
    provider: LinearSidecarProvider,
    dependencies: SidecarProviderDependencies,
  ) {
    this.#loaded = loaded;
    this.#provider = provider;
    const environment = dependencies.environment ?? process.env;
    const credential = providerCredential(
      provider.tokenEnv,
      environment,
      provider.authorization === 'oauth-bearer' ? 'bearer' : 'raw',
    );
    assertCredentialSeparated(credential, loaded, provider);
    this.#credential = credential;
    this.#http = new BoundedProviderHttp({
      origin: LINEAR_ORIGIN,
      authorizationHeader: credential.authorizationHeader(),
      responseStringRedactor: credential.redactResponseString,
      timeoutMs: loaded.config.limits.timeoutMs,
      maxResponseBytes: loaded.config.limits.maxResponseBytes,
      ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
      ...(dependencies.delay ? { delay: dependencies.delay } : {}),
    });
  }

  evidence(): ReturnType<BoundedProviderHttp['evidence']> {
    return this.#http.evidence();
  }

  assertCredentialAbsent(value: string): void {
    this.#credential.assertJsonAbsent(value, 'staged Linear Oracle body');
  }

  async probeIdentity(signal?: AbortSignal): Promise<{
    accountId: string;
    requests: ReturnType<BoundedProviderHttp['evidence']>;
  }> {
    const start = this.#http.evidence().length;
    const envelope = await this.#graphql(IDENTITY_QUERY, {}, 'identity-read', signal);
    const accountId = stringValue(
      objectValue(envelope.data, 'Linear identity data').organization
        ? objectValue(objectValue(envelope.data, 'Linear identity data').organization, 'Linear organization').id
        : undefined,
      'Linear organization id',
    );
    assertExpectedAccount(accountId, this.#provider.expectedAccountId);
    return { accountId, requests: this.#http.evidence().slice(start) };
  }

  async fetchPage(window: SidecarReadWindow, signal?: AbortSignal): Promise<SidecarProviderPage> {
    assertProviderReadWindow(window, 'Linear');
    const start = this.#http.evidence().length;
    const query = window.from ? INCREMENTAL_ISSUES_QUERY : INITIAL_ISSUES_QUERY;
    assertReadOnlyGraphql(query);
    const envelope = await this.#graphql(query, {
      teamId: this.#provider.teamId,
      first: this.#loaded.config.limits.pageSize,
      after: window.cursor ?? null,
      ...(window.from ? { from: window.from } : {}),
      until: window.until,
    }, 'records-read', signal);
    const data = objectValue(envelope.data, 'Linear issues data');
    const organization = objectValue(data.organization, 'Linear organization');
    const accountId = stringValue(organization.id, 'Linear organization id');
    assertExpectedAccount(accountId, this.#provider.expectedAccountId);
    const team = objectValue(data.team, 'Linear team');
    if (stringValue(team.id, 'Linear team id') !== this.#provider.teamId) {
      throw new Error('Linear response team identity does not match the reviewed scope');
    }
    const issues = objectValue(team.issues, 'Linear issues connection');
    const pageInfo = objectValue(issues.pageInfo, 'Linear pageInfo');
    const nodes = arrayValue(issues.nodes, 'Linear issue nodes');
    if (nodes.length > this.#loaded.config.limits.pageSize) {
      throw new Error('Linear returned more records than the reviewed page size');
    }
    if (
      typeof pageInfo.hasNextPage !== 'boolean'
      || !Object.prototype.hasOwnProperty.call(pageInfo, 'endCursor')
      || (pageInfo.endCursor !== null && typeof pageInfo.endCursor !== 'string')
    ) {
      throw new Error('Linear pagination returned an invalid continuation envelope');
    }
    const hasNextPage = pageInfo.hasNextPage;
    const endCursor = optionalString(pageInfo.endCursor);
    if (hasNextPage && !endCursor) throw new Error('Linear pagination omitted its required end cursor');
    const records = finalizeProviderRecords(nodes.map((value) => {
      const record = this.#record(value);
      if (!providerRecordWithinWindow(record, window, 'Linear')) {
        throw new Error('Linear returned an issue outside the reviewed sync window');
      }
      return record;
    }), 'Linear');
    const page: SidecarProviderPage = {
      accountId,
      records,
      ...(hasNextPage ? { nextCursor: endCursor! } : {}),
      requests: this.#http.evidence().slice(start),
    };
    this.#credential.assertJsonAbsent(JSON.stringify(page), 'normalized Linear page');
    return page;
  }

  async #graphql(
    query: string,
    variables: JsonObject,
    operation: 'identity-read' | 'records-read',
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    assertReadOnlyGraphql(query);
    const response = objectValue(await this.#http.json({
      method: 'POST',
      path: '/graphql',
      operation,
      body: { query, variables },
      ...(signal ? { signal } : {}),
    }), 'Linear GraphQL response');
    if (Object.prototype.hasOwnProperty.call(response, 'errors')) {
      throw new Error('Linear GraphQL read returned an error envelope');
    }
    return response;
  }

  #record(value: unknown): CorporateRecordInput {
    const issue = objectValue(value, 'Linear issue');
    const externalId = stringValue(issue.id, 'Linear issue id');
    const identifier = boundedProviderText(
      stringValue(issue.identifier, 'Linear issue identifier'),
      256,
    );
    const title = boundedProviderText(stringValue(issue.title, 'Linear issue title'), 4_096);
    const createdAt = normalizedProviderTimestamp(issue.createdAt, 'Linear issue createdAt');
    const updatedAt = normalizedProviderTimestamp(issue.updatedAt, 'Linear issue updatedAt');
    const state = issue.state ? objectValue(issue.state, 'Linear issue state') : undefined;
    const assignee = issue.assignee ? objectValue(issue.assignee, 'Linear issue assignee') : undefined;
    const project = issue.project ? objectValue(issue.project, 'Linear issue project') : undefined;
    const stateId = boundedOptionalProviderText(state?.id, 256);
    const stateName = boundedOptionalProviderText(state?.name, 512);
    const stateType = boundedOptionalProviderText(state?.type, 128);
    const assigneeId = boundedOptionalProviderText(assignee?.id, 256);
    const assigneeName = boundedOptionalProviderText(assignee?.name, 512);
    const providerProjectId = boundedOptionalProviderText(project?.id, 256);
    const projectName = boundedOptionalProviderText(project?.name, 512);
    const dueDate = boundedOptionalProviderText(issue.dueDate, 64);
    const lines = [
      `Identifier: ${identifier}`,
      stateName ? `State: ${stateName}` : undefined,
      assigneeName ? `Assignee: ${assigneeName}` : undefined,
      projectName ? `Project: ${projectName}` : undefined,
      dueDate ? `Due: ${dueDate}` : undefined,
    ].filter((line): line is string => Boolean(line));
    const sourceUrl = safeProviderUrl(issue.url, LINEAR_WEB_ORIGIN);
    return {
      externalId,
      domain: 'project',
      recordType: 'issue',
      ...(this.#loaded.config.localProjectId ? { projectId: this.#loaded.config.localProjectId } : {}),
      title,
      content: boundedProviderText(lines.join('\n'), 8_192, true),
      ...(sourceUrl ? { sourceUrl } : {}),
      sourceVersion: updatedAt,
      occurredAt: createdAt,
      sourceUpdatedAt: updatedAt,
      metadata: jsonMetadata({
        identifier,
        teamId: this.#provider.teamId,
        stateId,
        stateName,
        stateType,
        assigneeId,
        providerProjectId,
        dueDate,
        priority: finiteNumber(issue.priority),
      }),
    };
  }
}

function assertCredentialSeparated(
  credential: ReturnType<typeof providerCredential>,
  loaded: LoadedSidecarConfig,
  provider: LinearSidecarProvider,
): void {
  for (const [context, value] of [
    ['sidecar id', loaded.config.id],
    ['workspace id', loaded.config.workspaceId],
    ['stream id', loaded.config.stream],
    ['local project id', loaded.config.localProjectId],
    ['expected Linear account id', provider.expectedAccountId],
    ['Linear team id', provider.teamId],
  ] as const) {
    if (value !== undefined) credential.assertAbsent(value, context);
  }
}

function assertReadOnlyGraphql(query: string): void {
  if (!/^\s*query\b/u.test(query) || /\bmutation\b/iu.test(query)) {
    throw new Error('Linear sidecar permits only code-fixed GraphQL query documents');
  }
}

function assertExpectedAccount(actual: string, expected: string): void {
  if (actual !== expected) throw new Error('Linear organization identity does not match the reviewed account');
}
