# Reviewed integration examples

These examples are deliberately small integration contracts, not generic API
clients. Copy a manifest, replace every `REPLACE_...` value, narrow its
`workspaces`, review the token's server-side permissions, and add only its
local tool names to `agent.tools`.

The four JSON API manifests are deployable templates:

| Manifest | Fixed authority |
| --- | --- |
| [`github-issues-read.yaml`](./github-issues-read.yaml) | One fixed GitHub repository issues endpoint; GET only; 25 results maximum (GitHub can include pull requests in this response) |
| [`jira-project-search.yaml`](./jira-project-search.yaml) | One cloud ID, project key, enhanced-JQL document, field list, and 25-result cap |
| [`slack-bound-channel.yaml`](./slack-bound-channel.yaml) | At most 15 history messages and a plain-text notification for one channel; notification is an approval-controlled non-idempotent write |
| [`linear-team-read.yaml`](./linear-team-read.yaml) | One immutable GraphQL query and one reviewed team UUID; no model-authored GraphQL |

[`github-local-mcp.yaml`](./github-local-mcp.yaml) and
[`linear-readonly-mcp.yaml`](./linear-readonly-mcp.yaml) are qualification
templates. They pin the process/endpoint and required tool, but an operator
must replace exact server identity placeholders and confirm compatible object
`structuredContent` before deployment.

## Corporate Oracle ingestion fixture

[`oracle-sync.requests.ndjson`](./oracle-sync.requests.ndjson) contains five
synthetic request bodies: one task-tracker issue, CRM opportunity, ERP purchase
order, email, and messenger record. Each line is one complete JSON body for a
separate `POST /api/oracle/sync`; the NDJSON file itself is not a single API
request. The example domains map to `project`, `crm`, `erp`, `email`, and
`messaging` respectively.

Use the fixture to test the normalized handoff from a reviewed connector, not
as evidence that any named SaaS connector is installed. A connector must map
provider data into this bounded contract, preserve the provider's stable
`externalId` and monotonic `sourceUpdatedAt`, and set `sourceAccountId` to the
immutable tenant/account identity verified by the connector sidecar—not a
model-authored label or display name. Page with `cursor` and `sourceWatermark`,
and send an explicit `status: deleted` record for a known deletion. Replaying
an unchanged line is safe: the Oracle records it as unchanged rather than
creating a duplicate revision.

For a development server without control authentication, post one line as a
JSON body:

```bash
sed -n '1p' examples/integrations/oracle-sync.requests.ndjson \
  | curl --fail-with-body --silent --show-error \
      -H 'Content-Type: application/json' \
      --data-binary @- http://127.0.0.1:4310/api/oracle/sync
```

The equivalent PowerShell development call is:

```powershell
$body = Get-Content examples/integrations/oracle-sync.requests.ndjson | Select-Object -First 1
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:4310/api/oracle/sync `
  -ContentType application/json -Body $body
```

With control authentication enabled, provision one least-privilege principal
per connector with capability `ingest` and workspace `local`; its principal ID
must exactly equal the request's `source` (or the authenticated request may
omit `source`). Attach its Bearer credential using the deployment's protected
secret mechanism—never add it to this fixture. Consumers search the committed
evidence through `oracle_search` and check freshness with `oracle_sources`;
neither tool performs an external action.

Corporate records are untrusted evidence, not model instructions. Keep only
the minimum useful business text and metadata, respect source-system consent
and retention rules, and do not ingest passwords, tokens, private keys, or
unnecessary personal data. The fixture uses only fictional `.invalid` URLs and
synthetic facts.

## Installation sequence

1. Copy only the manifests you intend to use into a protected deployment
   directory. Do not point production configuration at a writable checkout.
2. Replace every placeholder. For JSON APIs, keep tenant, repository, project,
   query, channel, and team selectors as manifest literals unless there is a
   reviewed reason to expose one as bounded model input.
3. Create least-privilege provider credentials outside YAML. The examples
   reference these environment names:

   ```text
   OP_GITHUB_READ_TOKEN
   OP_JIRA_READ_OAUTH_TOKEN
   OP_SLACK_BOT_TOKEN
   OP_LINEAR_READ_OAUTH_TOKEN
   OP_GITHUB_MCP_READ_TOKEN
   OP_LINEAR_MCP_READ_TOKEN
   ```

   Values must never be committed, placed in command arguments, or copied into
   a manifest. The Jira and Linear JSON examples expect pre-issued read-scope
   OAuth access tokens because this transport emits `Authorization: Bearer
   ...`; OpenProjects does not run either provider's OAuth flow or refresh an
   expired token. Atlassian personal API tokens require Basic authentication,
   and Linear personal API keys use a different header form, so neither belongs
   in these Bearer examples.
4. Merge the relevant fields from [`config-snippet.yaml`](./config-snippet.yaml)
   into a complete OpenProjects config. The snippet is not a complete config.
   Relative manifest paths resolve from the config file's directory.
5. Validate without touching credentials, starting a child, or opening a
   network connection:

   ```bash
   openprojects integrations check --config /etc/openprojects/openprojects.yaml
   ```

6. In a staging identity and network boundary, resolve credentials and verify
   configured peers:

   ```bash
   openprojects integrations check --probe \
     --config /etc/openprojects/openprojects.yaml
   ```

   For JSON API manifests, `--probe` validates the exact origin and credential
   availability but sends no business request. For MCP it connects, checks the
   exact server name/version, and verifies every required remote tool. It does
   not execute a tool, prove response-schema compatibility, or prove provider
   permissions. Make a bounded non-production call before granting the tool to
   an agent.
7. Run the representative approval, prompt-injection, and crash-recovery gates
   with the final manifests and credentials before promotion.

## Policy and grant checklist

- `agent.tools` is the positive grant. A manifest does not grant its tools to
  an agent by itself.
- `policy` still controls the declared effect. Keep `external_write: ask` for
  `slack_channel_notify`; `deny` is safer until its approval flow is tested.
- `integrations.externalDataPolicy` independently controls whether arguments
  may cross the host boundary. `ask` is the recommended first deployment;
  even an effect-`read` API call can disclose its arguments.
- `workspaces` is an exact local workspace allowlist. Omission means every
  workspace, so the examples include `[local]` instead.
- Provider-side permissions remain authoritative too. Use repository-scoped
  GitHub credentials, Jira read scopes for the intended site, a Slack app
  limited to the bound channel and required history/write scopes, and a
  read-scope Linear token for the intended workspace.
- Treat every response as hostile content. Returned issues, messages, names,
  descriptions, and comments can contain prompt injection.

Policy decisions combine monotonically: any denial wins; otherwise any
`ask` wins. An external write can therefore be approval-gated by both its
effect and the external-data boundary without either check weakening the
other.

## Credential rotation

Credential values are read from the environment and are never included in run
snapshots. A token can therefore change while its environment-variable name
stays constant. Treat an account, tenant, or permission change as a contract
change: stop the service, reconcile or reject outstanding approvals, use a new
environment-variable name, update the manifest, validate and probe again, and
restart. This changes the manifest digest and prevents old run commitments
from silently representing a wider credential.

## Why the examples are narrow

The JSON transport accepts one exact origin, method, whole-segment path
template, structural query/body map, success-status set, output projection,
and byte/time bounds. It rejects redirects and does not supply ambient cookies,
proxy credentials, retries, arbitrary headers, arbitrary URLs, OpenAPI import,
model-authored GraphQL/JQL, uploads, or webhooks. Every declared input property
must be mapped exactly once or more into the reviewed request structure.

Top-level object responses are projected to only the keys named by the local
output schema. A top-level array is deterministically wrapped as `{data: [...]}`
and requires an explicit `data` output property; scalar JSON is rejected. The
complete local output schema is enforced after that projection/envelope. The
GitHub issue-list example demonstrates the array envelope.

MCP manifests are similarly static. OpenProjects uses bounded `tools/list`
only to verify the configured peer and required names; it never imports remote
schemas, annotations, effects, or grants. MCP keyed idempotency is unsupported,
and dynamic resources, prompts, tasks, sampling, elicitation, server-driven
headers, OAuth login/refresh, and automatic registry installation are outside
this lane.

## MCP compatibility notes

The GitHub local template invokes a staged native binary directly with
`shell: false`, an absolute working directory, an explicit minimal environment,
`--read-only`, and one enabled tool. Pin and verify the binary separately; the
manifest commits its path, arguments, identity, and limits, not the executable
bytes. Do not replace it with `npx`, a shell wrapper, an unpinned container tag,
or an installer command.

There is one current blocker: GitHub MCP Server v1.11.0 source at commit
[`822c877`](https://github.com/github/github-mcp-server/blob/822c87761f8587395b3e1a04b5386b2611252cd1/pkg/utils/result.go#L5-L13)
builds ordinary tool results with text content only. OpenProjects intentionally
requires object `structuredContent` and discards text, so the current official
binary can pass identity/tool verification but its ordinary calls fail closed.
Keep the manifest as a qualification template until a pinned upstream release
supports structured output or a separately reviewed, bounded local adapter is
introduced. Do not weaken the gateway to parse model-visible text.

Linear documents a Streamable HTTP read-only endpoint and permits a restricted
API key or OAuth token in a Bearer header. Its published documentation does not
pin the MCP initialize name/version or promise a stable local output schema, so
record those values with a separately reviewed staging client, replace the
template placeholders, run `--probe`, and test the exact `list_issues` result
before granting it. The JSON API example is the more deterministic Linear lane.

Provider references:

- [GitHub's official local and remote MCP server](https://github.com/github/github-mcp-server)
- [Linear MCP endpoint and read-only authentication](https://linear.app/docs/mcp)
- [GitHub REST list repository issues](https://docs.github.com/en/rest/issues/issues?apiVersion=2022-11-28#list-repository-issues)
- [Jira enhanced JQL search](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/)
- [Slack conversations.history](https://docs.slack.dev/reference/methods/conversations.history/) and [chat.postMessage](https://docs.slack.dev/reference/methods/chat.postMessage/)
- [Linear GraphQL endpoint and authentication](https://linear.app/developers/graphql)
