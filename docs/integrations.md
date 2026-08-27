# Corporate Oracle ingestion, reviewed MCP, and JSON API integrations

OpenProjects integrations are operator-reviewed contracts compiled into
ordinary kernel tools. They do not create a second agent runtime or bypass
grants, policy, approvals, durability, recovery, output validation, or run
commitments.

The unreleased Corporate Oracle foundation adds a complementary **ingestion
plane**. It is not a model tool and it does not make provider payloads
authoritative instructions. A least-privilege connector sidecar normalizes
bounded source pages into a versioned local evidence ledger; the agent can only
search that ledger through read-only, cited Oracle tools. Provider-specific
sidecars and a 4 GiB Oracle deployment remain unqualified.

The design goal is intentionally narrower than a generic connector framework:
the model may choose among reviewed tools and fill reviewed input fields, but
it cannot choose an endpoint, executable, credential, HTTP method, header,
GraphQL/JQL document, remote tool name, effect, or retry policy.

Ready-to-copy templates are in [`examples/integrations/`](../examples/integrations/README.md).

Transport code is loaded on demand. A JSON API-only process does not import the
MCP client or SDK graph, and an MCP-only process does not import the JSON API
executor. This is a startup/RSS optimization only; both paths compile into the
same kernel, policy, canonical-argument, approval, recovery, and snapshot
authority.

## Two integration planes

| Plane | Direction | Intended use | Model authority |
| --- | --- | --- | --- |
| Corporate Oracle sync | Provider sidecar -> OpenProjects | Keep bounded task, CRM, ERP, email, messaging, calendar, and document evidence current over time | None during ingestion; agent receives only `oracle_search` and `oracle_sources` reads |
| Reviewed MCP/JSON tool | OpenProjects -> provider | Bounded ad hoc reads, drafts, and explicitly approved actions | Only the static local manifest grant, schema, effect, policy, and approval path |

Use the Oracle for cross-system state that should be searchable repeatedly and
auditable over time. Use a reviewed tool when a run needs a provider operation,
especially any external effect. Synchronizing a ticket does not grant authority
to update that ticket, send an email, post a message, or change an ERP record.

## Corporate Oracle ingestion plane

### Provider sidecar boundary

OpenProjects intentionally does not absorb every provider SDK and identity
flow into its lightweight process. A separately deployed sidecar owns:

- OAuth or service-account authorization, token refresh, and provider scopes;
- webhook verification or bounded polling, pagination, backoff, and rate limits;
- mapping provider-specific payloads into the normalized record contract; and
- its own secret storage, network policy, release pin, logging, and operational
  health.

The sidecar's OpenProjects credential should have only `ingest` and the exact
workspace it serves:

```yaml
server:
  auth:
    principals:
      - id: linear-production
        tokenFile: /var/lib/openprojects/linear-production.token
        capabilities: [ingest]
        workspaces: [atlas]
```

With control authentication enabled, that principal ID becomes the stored
`source`. A body-supplied `source` is optional and, if present, must match; a
sidecar cannot claim another connector's identity. Every sync page must also
carry `sourceAccountId`: the immutable tenant/account identifier obtained from
the provider's authenticated identity endpoint, not a friendly display name.
It is persisted on records and checkpoints; a later account change for the
same workspace/source/stream fails closed as provider-account drift. Its
credential can call only sync and its own checkpoint endpoint. It cannot search
evidence, start a run, inspect memory, approve an action, or erase data.
`admin` is required for source erasure.

No provider sidecar is bundled or live-qualified yet. OAuth and pagination are
therefore architectural sidecar responsibilities, not capabilities of the
current MCP/JSON clients or the Oracle API itself.

### Normalized page contract

`POST /api/oracle/sync` accepts one JSON page containing `workspaceId`, the
required immutable `sourceAccountId`, a safe `stream`, an optional opaque
`previousCursor`, an optional opaque `cursor`, an optional timestamp
`sourceWatermark`, and up to 100 records. The complete canonical page is
limited to 2,000,000 bytes. Each record contains:

```json
{
  "workspaceId": "atlas",
  "sourceAccountId": "linear-org-01JXYZ",
  "stream": "issues",
  "previousCursor": "opaque-provider-cursor-page-1",
  "cursor": "opaque-provider-cursor-page-2",
  "sourceWatermark": "2026-08-27T09:15:00.000Z",
  "records": []
}
```

A normalized record is shaped as follows:

```json
{
  "externalId": "ENG-142",
  "domain": "project",
  "recordType": "issue",
  "projectId": "atlas",
  "title": "Rotate production credentials",
  "content": "Blocked pending Security review.",
  "sourceUrl": "https://linear.app/example/issue/ENG-142",
  "sourceVersion": "provider-etag-or-revision",
  "occurredAt": "2026-08-27T08:30:00.000Z",
  "sourceUpdatedAt": "2026-08-27T09:15:00.000Z",
  "status": "active",
  "metadata": { "state": "blocked", "owner": "security" }
}
```

Supported domains are `project`, `crm`, `erp`, `email`, `messaging`,
`calendar`, `document`, and `other`. `externalId`, `recordType`, timestamps,
title, and content are mandatory for an active record. `projectId`, URL,
provider version, status, and bounded JSON metadata are optional. The connector
cannot supply `observedAt`; OpenProjects stamps it from the harness clock when
the page crosses the authenticated ingestion boundary.
`sourceUrl`, when present, must be an absolute credential-free HTTP(S) URL with
no query string or fragment. Use a canonical path-only record URL or omit it;
secret-bearing, tracking, and mutable URL tails are rejected.
A `deleted` record is a source tombstone: it becomes a retained revision but
is excluded from current search. The sidecar must send the provider's stable
record ID and monotonic update timestamp; polling time is not a substitute for
`sourceUpdatedAt`. Credential-shaped metadata keys are rejected, but this is
only a structural guard: the sidecar must still minimize text/metadata and
exclude secrets and unnecessary personal data. The page-level
`sourceAccountId` is not repeated inside each record.

One accepted page updates current heads, appends changed retained revisions,
and advances its `(workspace, source, sourceAccountId, stream)` bound checkpoint
in one SQLite transaction. The response records inserted, updated, unchanged,
and stale counts plus record digests, the account-bound checkpoint, and
embedding status. Sync never starts an agent run or chat completion, but the
post-commit embedding stage may call the configured local or explicitly
approved cloud embedding adapter. The receipt reports
`agentRunInvoked: false`, `chatModelInvoked: false`, and an accurate
`embeddingInvoked`; legacy `modelInvoked: false` means no agent/chat completion.

Resume with:

```text
GET /api/oracle/checkpoint?workspaceId=atlas&stream=issues
```

The authenticated principal supplies the source identity. Before producing
every cursor-bearing page after the first, the sidecar must read this endpoint
and copy its current checkpoint `cursor` into the page's `previousCursor`.
OpenProjects compares that predecessor inside the page transaction; a missing
or mismatched predecessor fails closed instead of letting a delayed or
concurrent page move the checkpoint backward. An exact repeat of an accepted
cursor page is idempotent and does not increment `recordsSeen`, but it must
preserve that page's original `previousCursor` rather than substitute the
latest checkpoint cursor. Reusing the cursor with different committed page
content, including a different predecessor, fails closed. Older
`sourceUpdatedAt` input is counted as stale and cannot replace the head.
Different content at the same source timestamp is a source conflict rather
than an arbitrary last-writer win. A checkpoint returned for a different
`sourceAccountId` must never be consumed, and a subsequent sync under a changed
account is rejected rather than merging tenants. `sourceWatermark` is retained
as connector resume evidence; the sidecar remains responsible for interpreting
its provider's watermark semantics.

Schema v11 records accepted page identities instead of remembering only the
latest page. It seeds the v10 latest checkpoint during migration and tracks
newly accepted pages thereafter. Replaying an older accepted cursor is therefore
recognized without rewriting current heads or moving the latest checkpoint,
watermark, count, or success time backward. The compare-and-swap predecessor
fence protects the seeded v10 checkpoint even though pre-v11 older page
identities were never recorded. Cursorless pages remain available for webhook
or independently deduplicated event delivery: their page identity is the
canonical digest, exact digest replay is idempotent, and they neither supply
`previousCursor` nor claim an ordered pagination chain.

### Current heads, retained history, and embeddings

The ledger keeps two representations while data is retained:

```text
provider page
   -> mutable current head (fast current reads)
   -> append-only revision row when source content advances
   -> atomic source/stream checkpoint
   -> changed-current embedding after commit
```

The embedding step deliberately follows the source transaction. If the local
or explicitly approved cloud embedding adapter fails, synchronized records and
the checkpoint remain committed and search falls back to lexical matching.
Only active current heads carry vectors, keyed to both embedding-model identity
and content digest. A page replay automatically retries an absent vector or one
stale for the selected embedding model/content. An admin can also call
`POST /api/oracle/embeddings/backfill` with an optional source and a limit from
1 to 100; each call repairs only that bounded set of active candidates and does
not start an agent/chat completion. Every temporal search is lexical so an old version can
never reuse a current version's vector. `asOf` filters provider state by
`sourceUpdatedAt`; `knownAt` filters versions by the server-owned `observedAt`
to reconstruct what the harness had actually recorded by that host time. They
may be supplied independently or together—the combined query applies both
bounds before selecting the latest eligible revision. The same built-in 256-dimensional
adapter, separately qualified local semantic adapter, or independently
approved cloud adapter used by reviewed memory is reused here; the Oracle does
not require a vector database.

Schema v11 also maintains trigger-backed FTS5 indexes with the Unicode
`unicode61` tokenizer for current and historical title/content/record-type
candidate selection. The indexes reduce candidate materialization; existing
workspace/project/source/domain filters and lexical/semantic/freshness scoring
remain authoritative. This is not a learned semantic encoder or a new resident
vector database.

Administrative deletion through
`DELETE /api/oracle/sources/:source/data?workspaceId=...&stream=...` removes
the selected heads, retained revisions, embeddings, and checkpoints in one
storage transaction; schema v11 accepted-page identities are erased too.
“Append-only” therefore describes normal
retained source history, not an exemption from explicit deletion or retention
policy.

### Read-only Oracle surfaces

The control API exposes:

| Endpoint | Grant | Behavior |
| --- | --- | --- |
| `POST /api/oracle/sync` | `ingest` | Commit one normalized source page and checkpoint; no agent/chat model, with separately reported post-commit embedding activity |
| `GET /api/oracle/checkpoint` | `ingest` | Read only the authenticated connector source's stream checkpoint |
| `POST /api/oracle/embeddings/backfill` | `admin` | Repair 1-100 missing or selected-model/content-stale active embeddings, optionally by source; no agent/chat completion |
| `GET /api/oracle/search` | `read` | Current hybrid search, or lexical temporal search using provider `asOf`, harness `knownAt`, or both; scoped by workspace and optional project/source/domain |
| `GET /api/oracle/sources` | `read` | List stream counts and last observed/source-update/success freshness |
| `GET /api/oracle/records/:id/history` | `read` | Inspect up to 100 retained revisions for one workspace record |
| `DELETE /api/oracle/sources/:source/data` | `admin` | Explicitly erase one source or stream |

The agent receives an even narrower pair of tools:

- `oracle_search`: accepts optional `asOf` and/or `knownAt` bounds and returns bounded current or historical records with
  `[oracle:<id>]`, source, immutable source account, source timestamp, observed
  timestamp, revision, and optional provider URL/version;
- `oracle_sources`: reports stream coverage and freshness before the model
  relies on an answer.

Both tools are effect-`read`, report `actionTaken: false`, and treat every
record as `untrusted-evidence` with `instructionAuthority: none`. A project run
automatically scopes search to that project plus records with no project ID.
The prompt contract requires search for material cross-system state, citations
and freshness, and explicit treatment of contradictions, stale sources, and
missing coverage. No Oracle tool can synchronize, send, edit, delete, approve,
or create reviewed memory. These citation rules are prompt-level guidance in
the generic supervisor today; unlike the strict project-analyst result lane,
there is not yet a final-output schema validator that rejects an Oracle answer
for omitting a citation.

A completed `oracle_search` durably taints the rest of its session, including
later runs in that session. The Oracle's monotonic guard changes every later
external-boundary tool—including an effect-`read` call—and every local effect
other than `read` or `draft` to `ask`. The resulting approval is the ordinary
exact, canonical-argument-digest approval for that invocation; approving one
call does not clear the taint. Local reads and drafts remain allowed, and only
a new session starts untainted. `oracle_sources` alone does not taint a session.
This reduces action laundering from hostile records, but it does
not inspect the assistant's prose or enforce citation syntax in a generic final
answer.

### Oracle evidence is not reviewed memory

Changing source truth and durable organizational learning have different
lifecycles:

- Oracle records are updated by authenticated source versions. Feedback does
  not strengthen them, and source text cannot promote itself into a prompt,
  policy, skill, approval, or memory.
- Reviewed memory holds durable decisions, preferences, procedures, and lessons.
  Inferred entries start `proposed`; only active reviewed entries are retrieved
  and embedded, and only attributed active entries receive bounded exactly-once
  feedback reward.
- Route feedback can improve future local/cloud model selection without
  changing either evidence plane or any model weights.

This is the supported meaning of “learning over time”: fresh versioned business
evidence plus human-reviewed durable memory and bounded routing feedback. It is
not online reinforcement learning or autonomous self-training.

### Sidecar promotion gate

A provider sidecar is supported only after a pinned version passes a recorded
staging suite for authentication scope, pagination/resume, predecessor-CAS
failure under delayed/concurrent pages and migrated-v10 checkpoints, latest and
old-page replay without checkpoint regression, original-predecessor replay,
cursorless webhook deduplication, same-cursor conflict, stale delivery,
deletion tombstones, provider retries and rate limits, workspace/source
isolation, secret redaction, malicious content, source-URL rejection,
embedding failure/backfill, cross-run same-session post-search approval taint,
freshness/citation
quality, provider-time versus harness-known-time queries, restart recovery, and
explicit source erasure. Generic prose citation behavior remains an evaluation
assertion until a strict final-output contract exists. The
Oracle also needs a representative multi-source PM corpus covering conflicting
deadlines, renamed owners, CRM-versus-ticket disagreement, missing streams, and
historical “what source state was effective by this provider update time?”
questions.

The current repository implements the generic foundation only. It does not yet
claim a live Linear, Jira, GitHub, Salesforce, HubSpot, SAP, Odoo, Gmail,
Microsoft 365, Slack, Teams, or other provider connector, and the existing 4
GiB qualification did not exercise Oracle ingestion, retained history, or a
realistic multi-source index. The
[synthetic NDJSON fixture](../examples/integrations/oracle-sync.requests.ndjson)
covers five normalized domains for development handoff testing; it is not a
connector or live-provider qualification.

## Configuration

A complete application config may add:

```yaml
integrations:
  externalDataPolicy: ask
  manifests:
    - ./integrations/github-issues-read.yaml
    - ./integrations/slack-bound-channel.yaml

privacy:
  localOnly: true
  allowedOrigins:
    - https://api.github.com
    - https://slack.com

agent:
  tools:
    - github_issues_read
    - slack_channel_history_read
    - slack_channel_notify

policy:
  read: allow
  external_write: ask
```

Manifest paths are explicit—no directories or globs—and relative paths resolve
from the application config's directory. Each file must be a stable regular,
non-symlink file no larger than 1 MiB with unique YAML/JSON keys, no aliases,
and plain JSON-compatible data. The loader records SHA-256 over the exact file
bytes and rejects duplicate integration IDs or local tool names across files.

`agent.tools` remains the positive tool grant. Merely loading a manifest does
not grant its tools to any agent. In particular, do not widen the separately
evaluated `project-analyst` lane with integration tools without a new lane
evaluation.

## Two monotonic policy dimensions

Every tool declares an ordinary effect:

```text
read | draft | memory_write | internal_write | external_write | destructive
```

The existing `policy` section decides whether that effect is allowed, denied,
or requires approval. An integration adds an independent data-boundary check:

- `dataBoundary: local` says the call is not expected to disclose its
  arguments outside the controlled host boundary;
- `dataBoundary: external` says it can disclose arguments to another process
  or service;
- `integrations.externalDataPolicy` decides `allow`, `ask`, or `deny` for every
  external-boundary call;
- optional manifest `workspaces` is an exact local workspace allowlist;
  omission means all workspaces.

The decisions combine monotonically: a denial wins, otherwise an `ask` wins.
An effect-`read` tool can still require approval because it sends a project
identifier, query, or other argument to an external processor. An
`external_write` can require approval from both dimensions, but one exact
durable approval still binds the stored invocation and arguments.

## JSON API manifest contract

A `json-api` transport declares:

- one exact `baseUrl` origin—HTTPS, or HTTP only for an exact loopback host;
- `none`, environment-backed Bearer, or one reviewed environment-backed custom
  header authentication mode;
- a small set of non-secret static headers; credential, cookie, host, proxy,
  forwarding, origin, and hop-by-hop headers are forbidden;
- one or more static tools, each with an exact method, whole-segment path
  template, structural query/body map, accepted 2xx statuses, effect,
  idempotency, strict local schemas, and time/byte limits.

Path and query values can be immutable JSON primitives or named top-level tool
inputs. Body values can additionally be immutable nested JSON. Every input
property must participate in the reviewed structural mapping; there is no raw
URL interpolation or model-authored JSON string. Path inputs are percent
encoded as one segment and cannot contain a slash, backslash, percent escape,
dot traversal, control character, query, or fragment.

The client uses no ambient cookies, no referrer, no cache, and no retry, and it
rejects redirects and undeclared status/content types. Response bytes are
bounded while streaming and decoded as strict UTF-8 JSON. For an object
response, only top-level properties declared by the local output schema are
retained. A top-level array is deterministically exposed as `{data: [...]}` and
requires a declared `data` output property. Scalar JSON is rejected. The
ordinary kernel then validates the complete projected object against the local
output schema before the model can receive it.

This is not OpenAPI import. It deliberately has no arbitrary URLs, arbitrary
headers, model-authored GraphQL or JQL, redirects, automatic pagination,
webhooks, multipart uploads, streaming downloads, or automatic retries. Add a
new reviewed static operation instead of exposing a generic `fetch` tool.

For a write, use `idempotency: keyed` only when the provider documents and
honors the exact declared `idempotencyKeyHeader`. Otherwise use
`idempotency: none`. Every declared model input is required; optional request
fields need a separate reviewed operation rather than implicit omit-if-absent
semantics. If any write fails after a send is attempted, including a keyed
write whose response cannot be validated, OpenProjects records an unknown
outcome and requires operator reconciliation instead of inviting a fresh
model call with a different key. The provider key still protects crash replay
of that same durable invocation; it does not deduplicate a semantically
repeated model call.

## MCP manifest contract

MCP is limited to synchronous `tools/call` behind the same local tool gateway.
OpenProjects owns the local name, remote name, strict schemas, effect,
idempotency, data boundary, timeouts, and byte limits. Remote descriptions,
annotations, schemas, read-only hints, and destructive hints never become
authority.

At startup the client performs bounded initialization and `tools/list` paging
only to verify the exact configured server name/version and presence of every
required remote tool. It does not dynamically register discovered tools. A
call accepts only text content blocks plus required object
`structuredContent`; text and standard result `_meta` are bounded and
discarded, embedded resources and other content types are rejected, and only
the local-schema-validated object reaches the model. A cancellation after a
non-idempotent call is dispatched is recorded as ambiguous even when the local
deadline or operator abort fires at the same time.

### Stdio

`mcp-stdio` requires an absolute executable and working directory. The process
is spawned directly with `shell: false`; arguments are literal, stdout is the
protocol stream, stderr is drained with a retention bound, pending requests
are capped, and shutdown has a deadline. The child inherits none of the ambient
environment. Its manifest maps explicit child variable names to explicit host
environment-variable names.

This is lifecycle control, not process isolation. A child still has the OS
identity, filesystem access, and network access granted by the host. Use a
dedicated service identity, staged read-only executable, restricted directory,
resource controls, and independent egress policy. The manifest commits the
path and arguments, not the binary's bytes; verify the artifact separately.

### Streamable HTTP

`mcp-http` requires one exact endpoint. A credential-free endpoint is allowed
only on loopback; every remote endpoint requires HTTPS plus an
environment-backed static Bearer credential.
Redirects are rejected, request/response bytes are bounded, identity and tools
are verified, and concurrent calls are capped.

OAuth authorization-code flows, refresh, dynamic client registration, Basic
auth, arbitrary provider headers, certificate pinning, DNS pinning, and a
credential broker are not implemented. If a provider requires those features,
its hosted MCP endpoint is not currently compatible even if another client can
connect to it.

### Deliberate omissions

The MCP lane does not expose prompts, resources, tasks, roots, sampling,
elicitation, server-driven header injection, UI/apps, automatic registry
installation, or remote policy. MCP has no reviewed standard idempotency-key
contract here, so manifests cannot declare `keyed`; read calls use `read`, and
side effects must use `none` with unknown-outcome reconciliation.

## Validation, probing, and promotion

Offline validation is safe to run during review or CI:

```bash
openprojects integrations check --config openprojects.config.yaml
openprojects integrations check --config openprojects.config.yaml --json
```

It parses and validates every manifest and compiles inert tool contracts. It
does not read integration credential values, spawn a child, or use the network.
Other deterministic/evaluation/maintenance commands also use inert configured
integrations so a manifest cannot make an offline command contact a provider.

An explicit probe resolves credentials and starts live transports:

```bash
openprojects integrations check --probe --config openprojects.config.yaml
```

For JSON API, the probe validates the exact origin against `privacy` and checks
credential availability without sending a business request. For MCP, it
connects and verifies the configured protocol/peer identity/required tool
names. A probe does not execute a tool, prove server-side authorization, prove
the response schema, or qualify content against prompt injection. Promotion
still requires a bounded staging call and the representative policy,
approval, hostile-content, and crash-recovery corpus.

## Credentials and snapshots

Manifests store environment-variable names, never values. Credential values
are resolved at startup (and for JSON calls, again per call), are not retained
in integration summaries, and are not written to run snapshots.

Each run's tool commitment includes the exact manifest SHA-256, integration
ID, live/offline mode, redacted transport binding, local/remote tool identity,
data boundary, schemas by digest, effect, idempotency, and limits. The policy
commitment includes the manifest digest, external-data decision, and workspace
scope. Recovery rejects a changed effective contract. These hashes are
identity commitments, not signatures, executable attestation, encryption, or
proof of a provider account.

Because the secret value is deliberately absent, rotating a credential under
the same environment name does not by itself change a snapshot. For account,
tenant, or permission changes: stop the runtime, reconcile/reject outstanding
approvals, choose a new environment-variable name, update the manifest, probe
and evaluate it, and restart. A normal same-scope secret refresh still requires
the provider's revocation/rotation procedure and a service restart where the
provider/client requires one.

## Popular official MCP endpoints

This matrix was checked against provider documentation on 2026-08-25. An
endpoint being official does not make it compatible or approved; authentication,
server identity, tools, schemas, scopes, and output shape still need review.

| Provider | Official current endpoint or distribution | Provider authentication | OpenProjects status |
| --- | --- | --- | --- |
| GitHub | Remote `https://api.githubcopilot.com/mcp/`; official local `github/github-mcp-server` binary/container | Remote OAuth or PAT; local OAuth, PAT, or GitHub App | Static Bearer HTTP is structurally possible but unqualified. The local qualification template is currently blocked because ordinary v1.11.0 results are text-only; use the reviewed JSON API example. [GitHub docs](https://docs.github.com/en/copilot/how-tos/provide-context/use-mcp-in-your-ide/extend-copilot-chat-with-mcp) |
| Linear | `https://mcp.linear.app/mcp`; read-only `https://mcp.linear.app/mcp/readonly` | OAuth 2.1, OAuth access token, or API key in Bearer header | Static Bearer read-only qualification template included; exact initialize identity and output schema must be recorded and tested. [Linear docs](https://linear.app/docs/mcp) |
| Slack | `https://mcp.slack.com/mcp` | Registered Slack app and confidential OAuth | OAuth/client identity flow is not implemented; use the fixed-channel JSON API example instead. [Slack docs](https://docs.slack.dev/ai/slack-mcp-server/) |
| Atlassian | `https://mcp.atlassian.com/v1/mcp/authv2` | OAuth 2.1; API-token Basic or service-account Bearer where enabled | OAuth and Basic are unsupported; static service-account Bearer still needs exact peer/schema qualification. The fixed enhanced-JQL JSON example is narrower. [Atlassian docs](https://support.atlassian.com/atlassian-ai-gateway/docs/configure-authentication-via-api-token/) |
| Notion | `https://mcp.notion.com/mcp` | Provider-managed OAuth connection | Hosted OAuth is not implemented; no bundled manifest. [Notion security guidance](https://developers.notion.com/guides/mcp/mcp-security-best-practices) |
| GitLab | `https://<instance>/api/v4/mcp` (beta) | OAuth 2.0 Dynamic Client Registration | Dynamic OAuth is not implemented; no bundled manifest. A self-managed deployment still needs endpoint/peer/tool/output review. [GitLab docs](https://docs.gitlab.com/user/model_context_protocol/mcp_server/) |
| Google Workspace | Product-specific endpoints such as `https://drivemcp.googleapis.com/mcp/v1` (Developer Preview) | OAuth 2.0 | OAuth and preview-specific client setup are not implemented; no bundled manifest. [Google docs](https://developers.google.com/workspace/guides/configure-mcp-servers) |

Treat the public MCP registry as a discovery index only. Never auto-install a
server or accept its current metadata as a grant. Pin the chosen source or
binary, review dependencies and license terms, stage it outside the model's
write authority, and create an explicit local manifest.

## Known interoperability limits

- GitHub MCP Server v1.11.0 commit
  [`822c877`](https://github.com/github/github-mcp-server/blob/822c87761f8587395b3e1a04b5386b2611252cd1/pkg/utils/result.go#L5-L13)
  emits ordinary tool results as text only. It therefore cannot yet cross the
  required structured-output boundary without an upstream change or separately
  audited adapter.
- Provider MCP names, versions, tools, and schemas can change independently of
  this project. Exact identity verification intentionally converts that drift
  into a startup failure.
- An exact HTTPS origin is not DNS or certificate pinning, and the harness
  cannot constrain egress initiated inside a trusted stdio child. Corporate
  deployments need host/network controls.
- JSON object projection is shallow by design; nested validation belongs in the
  strict local output schema. There is no declarative response transformation,
  pagination loop, or field-language interpreter. Oracle sidecars may implement
  provider pagination outside the harness, but no such sidecar is bundled or
  qualified yet.
- External systems do not share a transaction with SQLite. Non-idempotent
  failures remain `unknown_outcome` until an operator verifies external state.
