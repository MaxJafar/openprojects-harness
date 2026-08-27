import type { CorporateRecordInput } from '../../oracle/corporate-oracle.js';
import {
  BoundedProviderHttp,
  providerCredential,
  type SidecarProviderCredential,
} from '../bounded-http.js';
import type { JiraSidecarProvider, LoadedSidecarConfig, SidecarProviderPage } from '../types.js';
import {
  arrayValue,
  assertProviderReadWindow,
  boundedOptionalProviderText,
  boundedProviderText,
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

const ATLASSIAN_ORIGIN = 'https://api.atlassian.com';
const JIRA_READ_ONLY_SCOPES = Object.freeze(['read:jira-work']);
const JIRA_FIELDS = Object.freeze([
  'summary',
  'issuetype',
  'status',
  'priority',
  'project',
  'assignee',
  'created',
  'updated',
  'duedate',
  'labels',
]);

interface JiraResource {
  readonly id: string;
  readonly url: string;
  readonly scopes: readonly string[];
}

export function createJiraSidecar(
  loaded: LoadedSidecarConfig,
  dependencies: SidecarProviderDependencies = {},
): SidecarProviderAdapter {
  if (loaded.config.provider.kind !== 'jira') throw new Error('Jira sidecar requires a Jira config');
  return new JiraSidecar(loaded, loaded.config.provider, dependencies);
}

class JiraSidecar implements SidecarProviderAdapter {
  readonly kind = 'jira' as const;
  readonly #loaded: LoadedSidecarConfig;
  readonly #provider: JiraSidecarProvider;
  readonly #http: BoundedProviderHttp;
  readonly #credential: SidecarProviderCredential;
  #siteOrigin: string | undefined;

  constructor(
    loaded: LoadedSidecarConfig,
    provider: JiraSidecarProvider,
    dependencies: SidecarProviderDependencies,
  ) {
    this.#loaded = loaded;
    this.#provider = provider;
    const credential = providerCredential(
      provider.tokenEnv,
      dependencies.environment ?? process.env,
      'bearer',
    );
    assertCredentialSeparated(credential, loaded, provider);
    this.#credential = credential;
    this.#http = new BoundedProviderHttp({
      origin: ATLASSIAN_ORIGIN,
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
    this.#credential.assertJsonAbsent(value, 'staged Jira Oracle body');
  }

  async probeIdentity(signal?: AbortSignal): Promise<{
    accountId: string;
    requests: ReturnType<BoundedProviderHttp['evidence']>;
  }> {
    const start = this.#http.evidence().length;
    const resources = arrayValue(await this.#http.json({
      method: 'GET',
      path: '/oauth/token/accessible-resources',
      operation: 'identity-read',
      ...(signal ? { signal } : {}),
    }), 'Atlassian accessible resources');
    const matches = resources
      .map(jiraResource)
      .filter((item) => item.id === this.#provider.expectedAccountId);
    if (matches.length !== 1) {
      throw new Error('Jira cloud identity is not uniquely available to the reviewed credential');
    }
    const resource = matches[0]!;
    assertExactReadOnlyScopes(resource.scopes);
    this.#siteOrigin = atlassianSiteOrigin(resource.url);
    if (!this.#siteOrigin) throw new Error('Jira resource URL is outside the reviewed Atlassian site boundary');
    return {
      accountId: resource.id,
      requests: this.#http.evidence().slice(start),
    };
  }

  async fetchPage(window: SidecarReadWindow, signal?: AbortSignal): Promise<SidecarProviderPage> {
    assertProviderReadWindow(window, 'Jira');
    const start = this.#http.evidence().length;
    const path = `/ex/jira/${encodeURIComponent(this.#provider.expectedAccountId)}/rest/api/3/search/jql`;
    const response = objectValue(await this.#http.json({
      method: 'POST',
      path,
      evidencePath: '/ex/jira/{cloudId}/rest/api/3/search/jql',
      operation: 'records-read',
      body: {
        jql: fixedJql(this.#provider.projectKey, window.from, window.until),
        fields: JIRA_FIELDS,
        maxResults: this.#loaded.config.limits.pageSize,
        ...(window.cursor ? { nextPageToken: window.cursor } : {}),
      },
      ...(signal ? { signal } : {}),
    }), 'Jira enhanced search response');
    const issues = arrayValue(response.issues, 'Jira issues');
    if (issues.length > this.#loaded.config.limits.pageSize) {
      throw new Error('Jira returned more records than the reviewed page size');
    }
    if (
      typeof response.isLast !== 'boolean'
      || (
        Object.prototype.hasOwnProperty.call(response, 'nextPageToken')
        && response.nextPageToken !== null
        && typeof response.nextPageToken !== 'string'
      )
    ) {
      throw new Error('Jira pagination returned an invalid continuation envelope');
    }
    const nextPageToken = optionalString(response.nextPageToken);
    if (!response.isLast && !nextPageToken) {
      throw new Error('Jira pagination omitted its required next-page token');
    }
    if (response.isLast && nextPageToken) {
      throw new Error('Jira pagination returned a continuation token for a terminal page');
    }
    const records = finalizeProviderRecords(issues.map((value) => {
      const record = this.#record(value);
      if (!providerRecordWithinWindow(record, window, 'Jira')) {
        throw new Error('Jira returned an issue outside the reviewed sync window');
      }
      return record;
    }), 'Jira');
    const page: SidecarProviderPage = {
      accountId: this.#provider.expectedAccountId,
      records,
      ...(nextPageToken ? { nextCursor: nextPageToken } : {}),
      requests: this.#http.evidence().slice(start),
    };
    this.#credential.assertJsonAbsent(JSON.stringify(page), 'normalized Jira page');
    return page;
  }

  #record(value: unknown): CorporateRecordInput {
    const issue = objectValue(value, 'Jira issue');
    const fields = objectValue(issue.fields, 'Jira issue fields');
    const externalId = stringValue(issue.id, 'Jira issue id');
    const key = boundedProviderText(stringValue(issue.key, 'Jira issue key'), 128);
    const title = boundedProviderText(stringValue(fields.summary, 'Jira issue summary'), 4_096);
    const createdAt = normalizedProviderTimestamp(fields.created, 'Jira issue created');
    const updatedAt = normalizedProviderTimestamp(fields.updated, 'Jira issue updated');
    const status = fields.status ? objectValue(fields.status, 'Jira issue status') : undefined;
    const assignee = fields.assignee ? objectValue(fields.assignee, 'Jira issue assignee') : undefined;
    const priority = fields.priority ? objectValue(fields.priority, 'Jira issue priority') : undefined;
    const project = objectValue(fields.project, 'Jira issue project');
    const projectKey = stringValue(project.key, 'Jira issue project key');
    if (projectKey !== this.#provider.projectKey) {
      throw new Error('Jira response project identity does not match the reviewed scope');
    }
    const issueType = fields.issuetype ? objectValue(fields.issuetype, 'Jira issue type') : undefined;
    const labels = Array.isArray(fields.labels)
      ? fields.labels
          .filter((label): label is string => typeof label === 'string' && Boolean(label))
          .slice(0, 50)
          .map((label) => boundedProviderText(label, 128))
      : [];
    const statusId = boundedOptionalProviderText(status?.id, 256);
    const statusName = boundedOptionalProviderText(status?.name, 512);
    const assigneeAccountId = boundedOptionalProviderText(assignee?.accountId, 256);
    const assigneeName = boundedOptionalProviderText(assignee?.displayName, 512);
    const priorityId = boundedOptionalProviderText(priority?.id, 256);
    const priorityName = boundedOptionalProviderText(priority?.name, 256);
    const providerProjectId = boundedOptionalProviderText(project.id, 256);
    const issueTypeId = boundedOptionalProviderText(issueType?.id, 256);
    const issueTypeName = boundedOptionalProviderText(issueType?.name, 512);
    const dueDate = boundedOptionalProviderText(fields.duedate, 64);
    const lines = [
      `Key: ${key}`,
      statusName ? `Status: ${statusName}` : undefined,
      assigneeName ? `Assignee: ${assigneeName}` : undefined,
      priorityName ? `Priority: ${priorityName}` : undefined,
      dueDate ? `Due: ${dueDate}` : undefined,
      labels.length ? `Labels: ${boundedProviderText(labels.join(', '), 1_024)}` : undefined,
    ].filter((line): line is string => Boolean(line));
    const sourceUrl = key && this.#siteOrigin
      ? safeProviderUrl(`${this.#siteOrigin}/browse/${encodeURIComponent(key)}`, this.#siteOrigin)
      : safeProviderUrl(issue.self, ATLASSIAN_ORIGIN);
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
        key,
        projectKey,
        providerProjectId,
        issueTypeId,
        issueTypeName,
        statusId,
        statusName,
        assigneeAccountId,
        priorityId,
        priorityName,
        dueDate,
        labels,
      }),
    };
  }
}

function assertCredentialSeparated(
  credential: ReturnType<typeof providerCredential>,
  loaded: LoadedSidecarConfig,
  provider: JiraSidecarProvider,
): void {
  for (const [context, value] of [
    ['sidecar id', loaded.config.id],
    ['workspace id', loaded.config.workspaceId],
    ['stream id', loaded.config.stream],
    ['local project id', loaded.config.localProjectId],
    ['expected Jira account id', provider.expectedAccountId],
    ['Jira project key', provider.projectKey],
  ] as const) {
    if (value !== undefined) credential.assertAbsent(value, context);
  }
}

function jiraResource(value: unknown): JiraResource {
  const resource = objectValue(value, 'Atlassian accessible resource');
  const url = stringValue(resource.url, 'Atlassian resource URL');
  const scopes = arrayValue(resource.scopes, 'Atlassian resource scopes').map((scope) => (
    stringValue(scope, 'Atlassian resource scope')
  ));
  return {
    id: stringValue(resource.id, 'Atlassian cloud id'),
    url,
    scopes: Object.freeze(scopes),
  };
}

function atlassianSiteOrigin(value: unknown): string | undefined {
  const site = safeProviderUrl(value);
  if (!site) return undefined;
  const url = new URL(site);
  if (url.hostname !== 'atlassian.net' && !url.hostname.endsWith('.atlassian.net')) return undefined;
  return url.origin;
}

function fixedJql(
  projectKey: string,
  from: string | undefined,
  until: string,
): string {
  const clauses = [`project = "${projectKey}"`];
  if (from) clauses.push(`updated >= ${jiraDate(from)}`);
  clauses.push(`updated <= ${jiraDate(until)}`);
  return `${clauses.join(' AND ')} ORDER BY updated ASC, id ASC`;
}

function jiraDate(value: string): string {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error('Jira sync window contains an invalid timestamp');
  return String(milliseconds);
}

function assertExactReadOnlyScopes(scopes: readonly string[]): void {
  const normalized = [...new Set(scopes)].sort();
  if (
    normalized.length !== scopes.length
    || normalized.join('\n') !== [...JIRA_READ_ONLY_SCOPES].sort().join('\n')
  ) {
    throw new Error('Jira credential scopes do not match the exact reviewed read-only grant');
  }
}
