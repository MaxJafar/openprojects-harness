import { describe, expect, it } from 'vitest';

import { SidecarHttpError } from '../src/sidecars/bounded-http.js';
import { createJiraSidecar } from '../src/sidecars/providers/jira.js';
import { createLinearSidecar } from '../src/sidecars/providers/linear.js';
import type {
  LoadedSidecarConfig,
  SidecarLimits,
  SidecarProvider,
} from '../src/sidecars/types.js';

const LINEAR_ACCOUNT_ID = 'linear-org-1';
const LINEAR_TEAM_ID = 'linear-team-1';
const LINEAR_TOKEN = 'linear-restricted-token';
const JIRA_CLOUD_ID = 'jira-cloud-1';
const JIRA_TOKEN = 'jira-read-token';
const JIRA_SCOPES = ['read:jira-work'] as const;

const LINEAR_IDENTITY_QUERY = 'query OpenProjectsLinearIdentity { organization { id } }';
const LINEAR_INITIAL_ISSUES_QUERY = `query OpenProjectsLinearIssues(
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
const LINEAR_INCREMENTAL_ISSUES_QUERY = `query OpenProjectsLinearIssues(
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
const JIRA_FIELDS = [
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
] as const;

interface CapturedRequest {
  readonly url: string;
  readonly init: RequestInit;
  readonly rawBody?: string;
  readonly body?: unknown;
}

describe('Linear read-only sidecar provider', () => {
  it('probes the reviewed organization with the exact fixed read query and no mutation surface', async () => {
    const transport = captureFetch(() => jsonResponse({
      data: { organization: { id: LINEAR_ACCOUNT_ID } },
    }));
    const provider = createLinearSidecar(linearLoaded(), {
      environment: { LINEAR_TEST_TOKEN: LINEAR_TOKEN },
      fetch: transport.fetch,
    });

    const result = await provider.probeIdentity();

    expect(provider.kind).toBe('linear');
    expect(result).toEqual({
      accountId: LINEAR_ACCOUNT_ID,
      requests: [{
        method: 'POST',
        origin: 'https://api.linear.app',
        path: '/graphql',
        operation: 'identity-read',
      }],
    });
    expect(Object.isFrozen(result.requests[0])).toBe(true);
    expect(transport.requests).toHaveLength(1);
    const request = transport.requests[0]!;
    expectJsonPost(request, 'https://api.linear.app/graphql', LINEAR_TOKEN);
    expect(request.rawBody).toBe(JSON.stringify({
      query: LINEAR_IDENTITY_QUERY,
      variables: {},
    }));
    expectReadOnlyLinearQuery(request.body);
  });

  it('maps and minimizes one initial issue page while preserving the reviewed account, team, and cursor', async () => {
    const remoteOnlyText = 'REMOTE DESCRIPTION MUST NOT BE INGESTED';
    const response = {
      data: {
        organization: { id: LINEAR_ACCOUNT_ID, name: 'Remote organization name' },
        team: {
          id: LINEAR_TEAM_ID,
          name: 'Remote team name',
          issues: {
            pageInfo: { hasNextPage: true, endCursor: 'linear-page-2', remoteTotal: 99 },
            nodes: [{
              id: 'linear-issue-7',
              identifier: 'OPS-7',
              title: `Qualify the ${LINEAR_TOKEN} sidecar`,
              priority: 2,
              createdAt: '2026-08-25T10:30:00+02:00',
              updatedAt: '2026-08-26T15:45:30+02:00',
              dueDate: '2026-09-01',
              url: 'https://linear.app/acme/issue/OPS-7/qualify-sidecar',
              state: {
                id: 'state-started',
                name: 'In Progress',
                type: 'started',
                remoteOnlyText,
              },
              assignee: {
                id: 'user-ada',
                name: 'Ada Lovelace',
                email: 'ada-private@example.test',
              },
              project: {
                id: 'linear-project-4',
                name: 'OpenProjects',
                description: remoteOnlyText,
              },
              description: remoteOnlyText,
              comments: [{ body: remoteOnlyText }],
            }],
          },
        },
      },
    };
    const transport = captureFetch(() => jsonResponse(response));
    const provider = createLinearSidecar(linearLoaded(), {
      environment: { LINEAR_TEST_TOKEN: LINEAR_TOKEN },
      fetch: transport.fetch,
    });
    const window = deepFreeze({ until: '2026-08-27T12:34:56.789Z' });

    const page = await provider.fetchPage(window);

    expect(page).toEqual({
      accountId: LINEAR_ACCOUNT_ID,
      nextCursor: 'linear-page-2',
      records: [{
        externalId: 'linear-issue-7',
        domain: 'project',
        recordType: 'issue',
        projectId: 'local-project-1',
        title: 'Qualify the [REDACTED:PROVIDER_CREDENTIAL] sidecar',
        content: [
          'Identifier: OPS-7',
          'State: In Progress',
          'Assignee: Ada Lovelace',
          'Project: OpenProjects',
          'Due: 2026-09-01',
        ].join('\n'),
        sourceUrl: 'https://linear.app/acme/issue/OPS-7/qualify-sidecar',
        sourceVersion: '2026-08-26T13:45:30.000Z',
        occurredAt: '2026-08-25T08:30:00.000Z',
        sourceUpdatedAt: '2026-08-26T13:45:30.000Z',
        metadata: {
          identifier: 'OPS-7',
          teamId: LINEAR_TEAM_ID,
          stateId: 'state-started',
          stateName: 'In Progress',
          stateType: 'started',
          assigneeId: 'user-ada',
          providerProjectId: 'linear-project-4',
          dueDate: '2026-09-01',
          priority: 2,
        },
      }],
      requests: [{
        method: 'POST',
        origin: 'https://api.linear.app',
        path: '/graphql',
        operation: 'records-read',
      }],
    });
    expect(Object.isFrozen(page.records)).toBe(true);
    expect(JSON.stringify(page)).not.toContain(remoteOnlyText);
    expect(JSON.stringify(page)).not.toContain('ada-private@example.test');
    expect(JSON.stringify(page)).not.toContain(LINEAR_TOKEN);
    expect(Object.keys(page.records[0]!).sort()).toEqual([
      'content',
      'domain',
      'externalId',
      'metadata',
      'occurredAt',
      'projectId',
      'recordType',
      'sourceUpdatedAt',
      'sourceUrl',
      'sourceVersion',
      'title',
    ]);

    const request = transport.requests[0]!;
    expectJsonPost(request, 'https://api.linear.app/graphql', LINEAR_TOKEN);
    expect(request.rawBody).toBe(JSON.stringify({
      query: LINEAR_INITIAL_ISSUES_QUERY,
      variables: {
        teamId: LINEAR_TEAM_ID,
        first: 2,
        after: null,
        until: window.until,
      },
    }));
    expectReadOnlyLinearQuery(request.body);
    expect(window).toEqual({ until: '2026-08-27T12:34:56.789Z' });
  });

  it('passes only the reviewed incremental window and cursor and closes on hasNextPage false', async () => {
    const transport = captureFetch(() => jsonResponse(linearPageEnvelope({
      hasNextPage: false,
      endCursor: 'ignored-terminal-cursor',
      nodes: [],
    })));
    const provider = createLinearSidecar(linearLoaded(), {
      environment: { LINEAR_TEST_TOKEN: LINEAR_TOKEN },
      fetch: transport.fetch,
    });
    const window = deepFreeze({
      from: '2026-08-25T01:02:03.004Z',
      until: '2026-08-27T03:04:05.006Z',
      cursor: 'linear-page-9',
    });

    const page = await provider.fetchPage(window);

    expect(page).toEqual({
      accountId: LINEAR_ACCOUNT_ID,
      records: [],
      requests: [{
        method: 'POST',
        origin: 'https://api.linear.app',
        path: '/graphql',
        operation: 'records-read',
      }],
    });
    expect(page).not.toHaveProperty('nextCursor');
    const request = transport.requests[0]!;
    expect(request.rawBody).toBe(JSON.stringify({
      query: LINEAR_INCREMENTAL_ISSUES_QUERY,
      variables: {
        teamId: LINEAR_TEAM_ID,
        first: 2,
        after: 'linear-page-9',
        from: window.from,
        until: window.until,
      },
    }));
    expectReadOnlyLinearQuery(request.body);
    expect(window).toEqual({
      from: '2026-08-25T01:02:03.004Z',
      until: '2026-08-27T03:04:05.006Z',
      cursor: 'linear-page-9',
    });

    const invertedTransport = captureFetch(() => jsonResponse(linearPageEnvelope({
      hasNextPage: false,
      endCursor: null,
      nodes: [],
    })));
    const inverted = createLinearSidecar(linearLoaded(), {
      environment: { LINEAR_TEST_TOKEN: LINEAR_TOKEN },
      fetch: invertedTransport.fetch,
    });
    await expect(inverted.fetchPage({
      from: '2026-08-28T00:00:00.000Z',
      until: '2026-08-27T00:00:00.000Z',
    })).rejects.toThrow('sync window begins after it ends');
    expect(invertedTransport.requests).toEqual([]);
  });

  it('rejects GraphQL errors without surfacing the remote envelope', async () => {
    const remoteError = 'REMOTE GRAPHQL SECRET DETAIL';
    const transport = captureFetch(() => jsonResponse({
      data: { organization: { id: LINEAR_ACCOUNT_ID } },
      errors: [{ message: remoteError, extensions: { authorization: 'secret' } }],
    }));
    const provider = createLinearSidecar(linearLoaded(), {
      environment: { LINEAR_TEST_TOKEN: LINEAR_TOKEN },
      fetch: transport.fetch,
    });

    const rejection = provider.probeIdentity();
    await expect(rejection).rejects.toThrow('Linear GraphQL read returned an error envelope');
    await expect(rejection).rejects.not.toThrow(remoteError);
    expectReadOnlyLinearQuery(transport.requests[0]!.body);

    const malformedErrors = createLinearSidecar(linearLoaded(), {
      environment: { LINEAR_TEST_TOKEN: LINEAR_TOKEN },
      fetch: captureFetch(() => jsonResponse({
        data: { organization: { id: LINEAR_ACCOUNT_ID } },
        errors: { message: remoteError },
      })).fetch,
    });
    await expect(malformedErrors.probeIdentity()).rejects.toThrow(
      'Linear GraphQL read returned an error envelope',
    );
  });

  it('rejects organization drift, team drift, and an incomplete continuation envelope', async () => {
    const organizationDrift = createLinearSidecar(linearLoaded(), {
      environment: { LINEAR_TEST_TOKEN: LINEAR_TOKEN },
      fetch: captureFetch(() => jsonResponse({
        data: { organization: { id: 'another-linear-org' } },
      })).fetch,
    });
    await expect(organizationDrift.probeIdentity()).rejects.toThrow(
      'Linear organization identity does not match the reviewed account',
    );

    const teamDrift = createLinearSidecar(linearLoaded(), {
      environment: { LINEAR_TEST_TOKEN: LINEAR_TOKEN },
      fetch: captureFetch(() => jsonResponse({
        data: {
          organization: { id: LINEAR_ACCOUNT_ID },
          team: {
            id: 'another-linear-team',
            issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
          },
        },
      })).fetch,
    });
    await expect(teamDrift.fetchPage({ until: '2026-08-27T00:00:00.000Z' })).rejects.toThrow(
      'Linear response team identity does not match the reviewed scope',
    );

    const missingCursor = createLinearSidecar(linearLoaded(), {
      environment: { LINEAR_TEST_TOKEN: LINEAR_TOKEN },
      fetch: captureFetch(() => jsonResponse(linearPageEnvelope({
        hasNextPage: true,
        endCursor: null,
        nodes: [],
      }))).fetch,
    });
    await expect(missingCursor.fetchPage({ until: '2026-08-27T00:00:00.000Z' })).rejects.toThrow(
      'Linear pagination omitted its required end cursor',
    );

    const invalidTerminalFlag = createLinearSidecar(linearLoaded(), {
      environment: { LINEAR_TEST_TOKEN: LINEAR_TOKEN },
      fetch: captureFetch(() => jsonResponse(linearPageEnvelope({
        hasNextPage: null,
        endCursor: null,
        nodes: [],
      }))).fetch,
    });
    await expect(invalidTerminalFlag.fetchPage({ until: '2026-08-27T00:00:00.000Z' })).rejects.toThrow(
      'Linear pagination returned an invalid continuation envelope',
    );

    const duplicateIssues = createLinearSidecar(linearLoaded(), {
      environment: { LINEAR_TEST_TOKEN: LINEAR_TOKEN },
      fetch: captureFetch(() => jsonResponse(linearPageEnvelope({
        hasNextPage: false,
        endCursor: null,
        nodes: [linearIssue({ id: 'duplicate-id' }), linearIssue({ id: 'duplicate-id' })],
      }))).fetch,
    });
    await expect(duplicateIssues.fetchPage({ until: '2026-08-27T00:00:00.000Z' })).rejects.toThrow(
      'Linear returned a duplicate issue identity in one page',
    );

    const invalidOracleRecord = createLinearSidecar(linearLoaded(), {
      environment: { LINEAR_TEST_TOKEN: LINEAR_TOKEN },
      fetch: captureFetch(() => jsonResponse(linearPageEnvelope({
        hasNextPage: false,
        endCursor: null,
        nodes: [linearIssue({ id: 'invalid issue id' })],
      }))).fetch,
    });
    await expect(invalidOracleRecord.fetchPage({ until: '2026-08-27T00:00:00.000Z' })).rejects.toThrow(
      'Linear issue identity is outside the Oracle identifier contract',
    );

    const injectedControl = createLinearSidecar(linearLoaded(), {
      environment: { LINEAR_TEST_TOKEN: LINEAR_TOKEN },
      fetch: captureFetch(() => jsonResponse(linearPageEnvelope({
        hasNextPage: false,
        endCursor: null,
        nodes: [linearIssue({ title: `unsafe${String.fromCharCode(0)}title` })],
      }))).fetch,
    });
    await expect(injectedControl.fetchPage({ until: '2026-08-27T00:00:00.000Z' })).rejects.toThrow(
      'Provider text contains forbidden control characters',
    );

    const outsideWindow = createLinearSidecar(linearLoaded(), {
      environment: { LINEAR_TEST_TOKEN: LINEAR_TOKEN },
      fetch: captureFetch(() => jsonResponse(linearPageEnvelope({
        hasNextPage: false,
        endCursor: null,
        nodes: [linearIssue({ updatedAt: '2099-01-01T00:00:00.000Z' })],
      }))).fetch,
    });
    await expect(outsideWindow.fetchPage({ until: '2026-08-27T00:00:00.000Z' })).rejects.toThrow(
      'outside the reviewed sync window',
    );

    const invalidChronology = createLinearSidecar(linearLoaded(), {
      environment: { LINEAR_TEST_TOKEN: LINEAR_TOKEN },
      fetch: captureFetch(() => jsonResponse(linearPageEnvelope({
        hasNextPage: false,
        endCursor: null,
        nodes: [linearIssue({
          createdAt: '2026-08-27T10:00:00.000Z',
          updatedAt: '2026-08-26T10:00:00.000Z',
        })],
      }))).fetch,
    });
    await expect(invalidChronology.fetchPage({ until: '2026-08-27T00:00:00.000Z' })).rejects.toThrow(
      'creation time is later than its update time',
    );

    const timezoneLessTimestamp = createLinearSidecar(linearLoaded(), {
      environment: { LINEAR_TEST_TOKEN: LINEAR_TOKEN },
      fetch: captureFetch(() => jsonResponse(linearPageEnvelope({
        hasNextPage: false,
        endCursor: null,
        nodes: [linearIssue({ updatedAt: '2026-08-26T10:00:00' })],
      }))).fetch,
    });
    await expect(timezoneLessTimestamp.fetchPage({ until: '2026-08-27T00:00:00.000Z' })).rejects.toThrow(
      'explicit UTC offset',
    );
  });
});

describe('Jira read-only sidecar provider', () => {
  it('probes the exact Atlassian resource endpoint and selects only the reviewed cloud identity', async () => {
    const responses = [jsonResponse([
      { id: 'another-cloud', url: 'https://other.atlassian.net', scopes: JIRA_SCOPES },
      {
        id: JIRA_CLOUD_ID,
        url: 'https://acme.atlassian.net/projects/OPS',
        name: 'Acme Jira',
        scopes: JIRA_SCOPES,
      },
    ])];
    const transport = captureFetch((_request, index) => responses[index]!);
    const provider = createJiraSidecar(jiraLoaded(), {
      environment: { JIRA_TEST_TOKEN: JIRA_TOKEN },
      fetch: transport.fetch,
    });

    const result = await provider.probeIdentity();

    expect(provider.kind).toBe('jira');
    expect(result).toEqual({
      accountId: JIRA_CLOUD_ID,
      requests: [{
        method: 'GET',
        origin: 'https://api.atlassian.com',
        path: '/oauth/token/accessible-resources',
        operation: 'identity-read',
      }],
    });
    expect(transport.requests).toHaveLength(1);
    expectJsonGet(
      transport.requests[0]!,
      'https://api.atlassian.com/oauth/token/accessible-resources',
      `Bearer ${JIRA_TOKEN}`,
    );
  });

  it('uses fixed Jira fields and JQL, maps only approved issue data, and returns the provider cursor', async () => {
    const remoteOnlyText = 'REMOTE JIRA DESCRIPTION MUST NOT BE INGESTED';
    const allLabels = [
      `reflected-${JIRA_TOKEN}`,
      ...Array.from({ length: 54 }, (_, index) => `label-${String(index + 1).padStart(2, '0')}`),
    ];
    const acceptedLabels = allLabels.slice(0, 50).map((label) => (
      label.replaceAll(JIRA_TOKEN, '[REDACTED:PROVIDER_CREDENTIAL]')
    ));
    const responses = [
      jsonResponse([{
        id: JIRA_CLOUD_ID,
        url: 'https://acme.atlassian.net/projects/OPS',
        scopes: JIRA_SCOPES,
      }]),
      jsonResponse({
        nextPageToken: 'jira-page-2',
        isLast: false,
        issues: [{
          id: '10042',
          key: 'OPS-42',
          self: 'https://api.atlassian.com/ex/jira/jira-cloud-1/rest/api/3/issue/10042',
          fields: {
            summary: 'Qualify the Jira sidecar',
            issuetype: { id: '10001', name: 'Task', description: remoteOnlyText },
            status: { id: '3', name: 'In Progress', statusCategory: { name: remoteOnlyText } },
            priority: { id: '2', name: 'High', iconUrl: remoteOnlyText },
            project: { id: '10000', key: 'OPS', name: 'Operations', avatarUrls: { leak: remoteOnlyText } },
            assignee: {
              accountId: 'jira-user-ada',
              displayName: 'Ada Lovelace',
              emailAddress: 'ada-private@example.test',
            },
            created: '2026-08-25T07:08:09.123+0400',
            updated: '2026-08-26T17:18:19.000+0400',
            duedate: '2026-09-02',
            labels: [...allLabels, 7, null],
            description: remoteOnlyText,
            comment: { comments: [{ body: remoteOnlyText }] },
          },
          changelog: { histories: [remoteOnlyText] },
        }],
      }),
    ];
    const transport = captureFetch((_request, index) => responses[index]!);
    const provider = createJiraSidecar(jiraLoaded(), {
      environment: { JIRA_TEST_TOKEN: JIRA_TOKEN },
      fetch: transport.fetch,
    });
    await provider.probeIdentity();
    const window = deepFreeze({ until: '2026-08-27T12:34:56.789Z' });

    const page = await provider.fetchPage(window);

    expect(page).toEqual({
      accountId: JIRA_CLOUD_ID,
      nextCursor: 'jira-page-2',
      records: [{
        externalId: '10042',
        domain: 'project',
        recordType: 'issue',
        projectId: 'local-project-1',
        title: 'Qualify the Jira sidecar',
        content: [
          'Key: OPS-42',
          'Status: In Progress',
          'Assignee: Ada Lovelace',
          'Priority: High',
          'Due: 2026-09-02',
          `Labels: ${acceptedLabels.join(', ')}`,
        ].join('\n'),
        sourceUrl: 'https://acme.atlassian.net/browse/OPS-42',
        sourceVersion: '2026-08-26T13:18:19.000Z',
        occurredAt: '2026-08-25T03:08:09.123Z',
        sourceUpdatedAt: '2026-08-26T13:18:19.000Z',
        metadata: {
          key: 'OPS-42',
          projectKey: 'OPS',
          providerProjectId: '10000',
          issueTypeId: '10001',
          issueTypeName: 'Task',
          statusId: '3',
          statusName: 'In Progress',
          assigneeAccountId: 'jira-user-ada',
          priorityId: '2',
          priorityName: 'High',
          dueDate: '2026-09-02',
          labels: acceptedLabels,
        },
      }],
      requests: [{
        method: 'POST',
        origin: 'https://api.atlassian.com',
        path: '/ex/jira/{cloudId}/rest/api/3/search/jql',
        operation: 'records-read',
      }],
    });
    expect(JSON.stringify(page)).not.toContain(remoteOnlyText);
    expect(JSON.stringify(page)).not.toContain('ada-private@example.test');
    expect(JSON.stringify(page)).not.toContain(JIRA_TOKEN);
    expect(Object.keys(page.records[0]!.metadata ?? {}).sort()).toEqual([
      'assigneeAccountId',
      'dueDate',
      'issueTypeId',
      'issueTypeName',
      'key',
      'labels',
      'priorityId',
      'priorityName',
      'projectKey',
      'providerProjectId',
      'statusId',
      'statusName',
    ]);

    const request = transport.requests[1]!;
    expectJsonPost(
      request,
      'https://api.atlassian.com/ex/jira/jira-cloud-1/rest/api/3/search/jql',
      `Bearer ${JIRA_TOKEN}`,
    );
    expect(request.rawBody).toBe(JSON.stringify({
      jql: 'project = "OPS" AND updated <= 1787834096789 ORDER BY updated ASC, id ASC',
      fields: JIRA_FIELDS,
      maxResults: 2,
    }));
    expect(Object.keys(request.body as Record<string, unknown>).sort()).toEqual([
      'fields',
      'jql',
      'maxResults',
    ]);
    expect(window).toEqual({ until: '2026-08-27T12:34:56.789Z' });
  });

  it('uses both fixed timestamp bounds, passes a cursor once, and omits an empty terminal cursor', async () => {
    const transport = captureFetch(() => jsonResponse({
      issues: [],
      isLast: true,
      nextPageToken: null,
    }));
    const provider = createJiraSidecar(jiraLoaded(), {
      environment: { JIRA_TEST_TOKEN: JIRA_TOKEN },
      fetch: transport.fetch,
    });
    const window = deepFreeze({
      from: '2026-08-25T01:02:59.999Z',
      until: '2026-08-27T03:04:59.999Z',
      cursor: 'jira-page-9',
    });

    const page = await provider.fetchPage(window);

    expect(page).toEqual({
      accountId: JIRA_CLOUD_ID,
      records: [],
      requests: [{
        method: 'POST',
        origin: 'https://api.atlassian.com',
        path: '/ex/jira/{cloudId}/rest/api/3/search/jql',
        operation: 'records-read',
      }],
    });
    expect(page).not.toHaveProperty('nextCursor');
    const request = transport.requests[0]!;
    expect(request.rawBody).toBe(JSON.stringify({
      jql: 'project = "OPS" AND updated >= 1787619779999 AND updated <= 1787799899999 ORDER BY updated ASC, id ASC',
      fields: JIRA_FIELDS,
      maxResults: 2,
      nextPageToken: 'jira-page-9',
    }));
    expect(window).toEqual({
      from: '2026-08-25T01:02:59.999Z',
      until: '2026-08-27T03:04:59.999Z',
      cursor: 'jira-page-9',
    });

    const invertedTransport = captureFetch(() => jsonResponse({ issues: [], isLast: true }));
    const inverted = createJiraSidecar(jiraLoaded(), {
      environment: { JIRA_TEST_TOKEN: JIRA_TOKEN },
      fetch: invertedTransport.fetch,
    });
    await expect(inverted.fetchPage({
      from: '2026-08-28T00:00:00.000Z',
      until: '2026-08-27T00:00:00.000Z',
    })).rejects.toThrow('sync window begins after it ends');
    expect(invertedTransport.requests).toEqual([]);
  });

  it('rejects credentials that cannot access the reviewed Jira cloud identity', async () => {
    const provider = createJiraSidecar(jiraLoaded(), {
      environment: { JIRA_TEST_TOKEN: JIRA_TOKEN },
      fetch: captureFetch(() => jsonResponse([
        { id: 'another-cloud', url: 'https://other.atlassian.net', scopes: JIRA_SCOPES },
      ])).fetch,
    });

    await expect(provider.probeIdentity()).rejects.toThrow(
      'Jira cloud identity is not uniquely available to the reviewed credential',
    );

    const overScopedResponses = [
      jsonResponse([{
        id: JIRA_CLOUD_ID,
        url: 'https://acme.atlassian.net',
        scopes: [...JIRA_SCOPES, 'write:jira-work'],
      }]),
    ];
    const overScoped = createJiraSidecar(jiraLoaded(), {
      environment: { JIRA_TEST_TOKEN: JIRA_TOKEN },
      fetch: captureFetch((_request, index) => overScopedResponses[index]!).fetch,
    });
    await expect(overScoped.probeIdentity()).rejects.toThrow(
      'exact reviewed read-only grant',
    );

    const missingContinuation = createJiraSidecar(jiraLoaded(), {
      environment: { JIRA_TEST_TOKEN: JIRA_TOKEN },
      fetch: captureFetch(() => jsonResponse({ issues: [], isLast: false })).fetch,
    });
    await expect(missingContinuation.fetchPage({ until: '2026-08-27T00:00:00.000Z' })).rejects.toThrow(
      'Jira pagination omitted its required next-page token',
    );

    const wrongProject = createJiraSidecar(jiraLoaded(), {
      environment: { JIRA_TEST_TOKEN: JIRA_TOKEN },
      fetch: captureFetch(() => jsonResponse({
        issues: [jiraIssue({ projectKey: 'OTHER' })],
        isLast: true,
      })).fetch,
    });
    await expect(wrongProject.fetchPage({ until: '2026-08-27T00:00:00.000Z' })).rejects.toThrow(
      'Jira response project identity does not match the reviewed scope',
    );

    const invalidChronology = createJiraSidecar(jiraLoaded(), {
      environment: { JIRA_TEST_TOKEN: JIRA_TOKEN },
      fetch: captureFetch(() => jsonResponse({
        issues: [jiraIssue({
          created: '2026-08-27T10:00:00.000+0000',
          updated: '2026-08-26T10:00:00.000+0000',
        })],
        isLast: true,
      })).fetch,
    });
    await expect(invalidChronology.fetchPage({ until: '2026-08-27T00:00:00.000Z' })).rejects.toThrow(
      'creation time is later than its update time',
    );
  });
});

describe('provider response bounds', () => {
  it('enforces the decoded HTTP response-byte limit before provider mapping', async () => {
    const transport = captureFetch(() => new Response(JSON.stringify({
      padding: 'x'.repeat(1_100),
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const provider = createLinearSidecar(linearLoaded({ maxResponseBytes: 1_024 }), {
      environment: { LINEAR_TEST_TOKEN: LINEAR_TOKEN },
      fetch: transport.fetch,
    });

    await expect(provider.probeIdentity()).rejects.toMatchObject({
      name: 'SidecarHttpError',
      code: 'PROVIDER_RESPONSE_TOO_LARGE',
    } satisfies Partial<SidecarHttpError>);
    expect(transport.requests).toHaveLength(1);
  });

  it('rejects provider pages larger than the reviewed record count for both adapters', async () => {
    const linear = createLinearSidecar(linearLoaded(), {
      environment: { LINEAR_TEST_TOKEN: LINEAR_TOKEN },
      fetch: captureFetch(() => jsonResponse(linearPageEnvelope({
        hasNextPage: false,
        endCursor: null,
        nodes: [{}, {}, {}],
      }))).fetch,
    });
    await expect(linear.fetchPage({ until: '2026-08-27T00:00:00.000Z' })).rejects.toThrow(
      'Linear returned more records than the reviewed page size',
    );

    const jira = createJiraSidecar(jiraLoaded(), {
      environment: { JIRA_TEST_TOKEN: JIRA_TOKEN },
      fetch: captureFetch(() => jsonResponse({ issues: [{}, {}, {}] })).fetch,
    });
    await expect(jira.fetchPage({ until: '2026-08-27T00:00:00.000Z' })).rejects.toThrow(
      'Jira returned more records than the reviewed page size',
    );
  });
});

function linearLoaded(limitOverrides: Partial<SidecarLimits> = {}): LoadedSidecarConfig {
  return loaded({
    kind: 'linear',
    tokenEnv: 'LINEAR_TEST_TOKEN',
    authorization: 'api-key',
    expectedAccountId: LINEAR_ACCOUNT_ID,
    teamId: LINEAR_TEAM_ID,
  }, limitOverrides);
}

function jiraLoaded(limitOverrides: Partial<SidecarLimits> = {}): LoadedSidecarConfig {
  return loaded({
    kind: 'jira',
    tokenEnv: 'JIRA_TEST_TOKEN',
    expectedAccountId: JIRA_CLOUD_ID,
    projectKey: 'OPS',
  }, limitOverrides);
}

function loaded(
  provider: SidecarProvider,
  limitOverrides: Partial<SidecarLimits>,
): LoadedSidecarConfig {
  return deepFreeze({
    path: `/reviewed/${provider.kind}-sidecar.yaml`,
    sha256: 'a'.repeat(64),
    contractSha256: 'b'.repeat(64),
    config: {
      schema: 'openprojects.sidecar.v1',
      id: `${provider.kind}-sidecar`,
      workspaceId: 'workspace-1',
      stream: 'issues',
      localProjectId: 'local-project-1',
      oracle: {
        baseUrl: 'http://127.0.0.1:4310',
        tokenFile: '/reviewed/oracle.token',
      },
      state: { directory: '/reviewed/state' },
      provider,
      limits: {
        pageSize: 2,
        timeoutMs: 1_000,
        maxResponseBytes: 8_192,
        overlapSeconds: 30,
        maxPagesPerRun: 3,
        ...limitOverrides,
      },
    },
  });
}

function linearPageEnvelope(options: {
  readonly hasNextPage: unknown;
  readonly endCursor: unknown;
  readonly nodes: unknown[];
}): Record<string, unknown> {
  return {
    data: {
      organization: { id: LINEAR_ACCOUNT_ID },
      team: {
        id: LINEAR_TEAM_ID,
        issues: {
          pageInfo: {
            hasNextPage: options.hasNextPage,
            endCursor: options.endCursor,
          },
          nodes: options.nodes,
        },
      },
    },
  };
}

function linearIssue(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'linear-issue-1',
    identifier: 'OPS-1',
    title: 'Provider issue',
    createdAt: '2026-08-25T10:00:00.000Z',
    updatedAt: '2026-08-26T10:00:00.000Z',
    ...overrides,
  };
}

function jiraIssue(options: {
  readonly projectKey?: string;
  readonly id?: string;
  readonly created?: string;
  readonly updated?: string;
} = {}): Record<string, unknown> {
  const projectKey = options.projectKey ?? 'OPS';
  return {
    id: options.id ?? '10001',
    key: `${projectKey}-1`,
    fields: {
      summary: 'Provider issue',
      project: { id: '10000', key: projectKey },
      created: options.created ?? '2026-08-25T10:00:00.000+0000',
      updated: options.updated ?? '2026-08-26T10:00:00.000+0000',
      labels: [],
    },
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function captureFetch(
  respond: (request: CapturedRequest, index: number) => Response | Promise<Response>,
): { readonly fetch: typeof globalThis.fetch; readonly requests: CapturedRequest[] } {
  const requests: CapturedRequest[] = [];
  const fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const requestInit = init ?? {};
    const rawBody = requestInit.body === undefined ? undefined : String(requestInit.body);
    const request: CapturedRequest = {
      url: String(input),
      init: requestInit,
      ...(rawBody === undefined ? {} : {
        rawBody,
        body: JSON.parse(rawBody) as unknown,
      }),
    };
    requests.push(request);
    return await respond(request, requests.length - 1);
  }) as typeof globalThis.fetch;
  return { fetch, requests };
}

function expectJsonPost(request: CapturedRequest, url: string, authorization: string): void {
  expect(request.url).toBe(url);
  expect(request.init).toMatchObject({
    method: 'POST',
    redirect: 'error',
    credentials: 'omit',
    cache: 'no-store',
    referrerPolicy: 'no-referrer',
  });
  expect(Object.keys(request.init).sort()).toEqual([
    'body',
    'cache',
    'credentials',
    'headers',
    'method',
    'redirect',
    'referrerPolicy',
    'signal',
  ]);
  expect(headerRecord(request.init.headers)).toEqual({
    accept: 'application/json',
    authorization,
    'content-type': 'application/json',
  });
  expect(request.init.signal).toBeInstanceOf(AbortSignal);
}

function expectJsonGet(request: CapturedRequest, url: string, authorization: string): void {
  expect(request.url).toBe(url);
  expect(request.init).toMatchObject({
    method: 'GET',
    redirect: 'error',
    credentials: 'omit',
    cache: 'no-store',
    referrerPolicy: 'no-referrer',
  });
  expect(Object.keys(request.init).sort()).toEqual([
    'cache',
    'credentials',
    'headers',
    'method',
    'redirect',
    'referrerPolicy',
    'signal',
  ]);
  expect(headerRecord(request.init.headers)).toEqual({
    accept: 'application/json',
    authorization,
  });
  expect(request.init.body).toBeUndefined();
  expect(request.rawBody).toBeUndefined();
  expect(request.init.signal).toBeInstanceOf(AbortSignal);
}

function expectReadOnlyLinearQuery(value: unknown): void {
  expect(value).toBeTruthy();
  const body = value as Record<string, unknown>;
  expect(Object.keys(body).sort()).toEqual(['query', 'variables']);
  expect(body.query).toEqual(expect.any(String));
  expect(body.query as string).toMatch(/^query\b/u);
  expect(body.query as string).not.toMatch(/\bmutation\b/iu);
}

function headerRecord(value: HeadersInit | undefined): Record<string, string> {
  const output: Record<string, string> = {};
  new Headers(value).forEach((item, key) => {
    output[key] = item;
  });
  return output;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
