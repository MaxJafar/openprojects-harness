# Read-only provider sidecars

OpenProjects includes a first bounded polling sidecar for **Linear** and **Jira
Cloud**. It is a separate one-shot execution lane: provider code is loaded only
by `openprojects sidecars ...`, and neither the service nor a model receives a
provider token or provider tool.

This is implemented and deterministically testable. It is **not yet a live
qualification claim for any external tenant**. A live claim requires an exact
config/artifact/tenant/host report produced with real credentials and no fetch
test seam.

## Boundary

```text
fixed provider read/query
        |
        v
bounded normalization (untrusted evidence)
        |
        v
owner-only pending-page spool
        |
        v
POST /api/oracle/sync (ingest-only local principal)
        |
        v
current Oracle heads + retained revisions + checkpoint
```

The sidecar never mounts Linear or Jira operations as agent tools. The only
provider methods in v1 are identity reads and records reads. Linear uses
code-fixed GraphQL `query` documents and rejects an error envelope even when
HTTP returns 200. Jira verifies the expected `cloudId`, then uses the enhanced
JQL search endpoint with a code-fixed project/window query and field list. Jira
date bounds are emitted as unquoted Unix epoch milliseconds, which Atlassian
defines independently of the account timezone; every returned creation/update
pair is then checked against the exact UTC window before it can reach the
Oracle. A provider POST is therefore a read/query operation; provider mutations
are not present in the operation registry.

The local Oracle call is intentionally state-changing. Reports distinguish
`providerWritesAttempted: false` from `oracle.ingestionWritesAttempted: true`.
Every provider request row represents one actual wire attempt, so a bounded
retry appears as another identical redacted method/origin/path/operation row.

Oracle receipts also declare the embedding adapter's data boundary. `local`
means in-process or loopback-host placement, not proof that a sibling service
cannot proxy elsewhere; `external` means normalized provider evidence may
leave the host for embedding; and `unreported` preserves uncertainty for a
custom adapter that did not declare a boundary. `embeddingInvoked` says whether
that page attempted vectors, while the boundary is reported even for an
unchanged page. The sidecar report aggregates bounded unique model and boundary
values, stored/failed totals, and redacted error samples without record text.

## Lightweight execution

The connector is one-shot rather than resident. It adds no provider SDK, queue,
vector database, browser, or framework dependency. Node's bounded `fetch`, the
existing YAML/Ajv dependency, and the existing Oracle API are reused. A finite
`maxPagesPerRun` prevents one invocation from becoming an unbounded crawler; a
later scheduler invocation resumes the committed cursor.

Templates:

- [Linear](../examples/sidecars/linear-readonly.yaml)
- [Jira Cloud](../examples/sidecars/jira-readonly.yaml)

After copying a template into a protected deployment directory and replacing
every placeholder:

```bash
openprojects sidecars check --config /protected/linear-sidecar.yaml
openprojects sidecars probe --config /protected/linear-sidecar.yaml --json
openprojects sidecars sync --config /protected/linear-sidecar.yaml --json
```

`check` is offline and credential-free. `probe` performs pre/post provider
identity reads plus one bounded records read, but it never opens the Oracle or
reads the local ingest credential. `sync` additionally reads only that
principal's checkpoint and submits bounded pages. Use Task Scheduler, launchd,
or a systemd timer for repetition; do not overlap invocations.

A successful real command reports `ready`, never `qualified`. `ready` means
that this bounded invocation completed without a detected contract violation;
it does not assert the multi-run promotion evidence below. When `sync` stops at
`maxPagesPerRun`, `oracle.cycleComplete` remains false and the next invocation
must resume the committed continuation.

## Credentials and identity

Provider credential values live only in the configured environment variable.
The config contains the variable name; neither config nor report contains its
value. The Oracle credential is a protected file loaded through the same
symlink/hard-link/permission checks as other OpenProjects control clients. Give
that principal only:

```yaml
id: linear-connector
capabilities: [ingest]
workspaces: [local]
```

The sidecar config `id` must equal the principal ID. Every page binds the
reviewed immutable provider account identity; the live response must match it,
and the report exposes only its SHA-256. Linear verifies the organization ID.
Jira verifies the expected Cloud ID through Atlassian accessible resources and
requires the exact classic `read:jira-work` grant. Any missing, duplicate, or
additional scope—including `write:jira-work`—fails the live identity probe.

Linear can consume a restricted API key or a pre-issued OAuth Bearer token.
Jira v1 consumes a pre-issued read-scope OAuth Bearer token. This qualifies, at
most, static credential use. Authorization-code/PKCE state, consent, token
storage, refresh, rotation, revocation, account switching, and scope downgrade
are not implemented or qualified.

## Pagination, replay, and crash behavior

Provider cursors are used only inside a finite time window; they are not treated
as durable source truth. The Oracle cursor stores a compact connector-owned
window state bound to the canonical config digest. A completed window advances
`sourceWatermark`; the next window deliberately overlaps it to catch eventual
search visibility and equal-timestamp records.

Before every Oracle POST, the exact JSON body is synchronized to
`pending-page.json` in the owner-only state directory. The local page includes
the last Oracle cursor as `previousCursor`, so concurrent advancement fails as
a compare-and-swap conflict. If transport fails after the POST begins, the
pending file is retained. A successful HTTP response with an oversized,
non-JSON, malformed, or scope/count/cursor-mismatched receipt is also treated
as an ambiguous write outcome, because the service may have committed before
its acknowledgement became unusable. The next invocation accepts only these
states:

- Oracle is still at the staged predecessor; or
- Oracle already has the staged cursor because only its acknowledgement was
  lost.

It then replays the byte-identical body. It never refetches provider content to
reconstruct an ambiguous page. A different Oracle head fails closed.
Reports distinguish validated receipts (`pagesAcknowledged`) from the upper
bound that may have committed (`pagesPossiblyCommitted`). `lastWriteOutcome`
is `not_attempted`, `acknowledged`, `rejected`, or `ambiguous`; an ambiguous
in-flight POST adds one possible page, while a failure clearing the local spool
after a valid receipt remains acknowledged and keeps the pending body for safe
replay. Embedding counts and boundaries are receipt-observed evidence only, so
an ambiguous POST sets `invocationOutcome: unknown` rather than implying that
no external embedding disclosure occurred.

The sidecar also holds `sidecar-state.owner.lock`. An unclean process exit can
leave it behind. Stop scheduling, verify that no sidecar process is running,
inspect that exact regular file, and remove only
`sidecar-state.owner.lock`. Preserve `pending-page.json` for recovery.

After acquiring a new owner lock, startup reconciles at most 64 private spool
leaves whose names exactly match the PID plus canonical UUID forms
`.pending-<pid>-<uuid>.tmp` or `.pending-clear-<pid>-<uuid>.tmp`. Before any
candidate is removed, every candidate must be a bounded regular protected file,
must parse as the exact pending-page schema, must match its body commitment, and
must belong to the currently reviewed connector contract. Descriptors remain
open through the final identity check and unlink. A crash-left publication link
or clear claim can therefore be removed, while `pending-page.json` is never a
startup-cleanup target and remains available for exact replay. A malformed
lookalike is ignored. An exact-name candidate that is oversized, permissive,
special, symbolic, malformed, tampered, or bound to another contract blocks
startup and is preserved for operator inspection; startup never guesses that it
is safe to delete.

POSIX enforces directory/file modes; Windows requires an independent NTFS ACL
review. The state directory is canonicalized and inode-checked, and pending
files are read and cleared through identity-stable snapshots. The state
directory and every ancestor must still be owned/protected so an untrusted
local user cannot rename and swap path components between filesystem
operations.

## Initial projection

The first lane deliberately excludes comments, attachments, files, worklogs,
descriptions, and message bodies. It retains stable issue ID, display key,
summary/title, state/status, assignee identity/name, project identity, priority,
due date, labels, creation/update timestamps, and a credential-free provider
URL when one can be constructed safely. Provider text remains
`untrusted-evidence` after ingestion and gains no instruction authority.
Before this projection, every decoded provider-response string is scrubbed of
the exact current provider credential. If that replacement makes a required
stable identifier invalid, the page fails closed instead of persisting it. A
second exact-secret guard covers the complete normalized page and cursor before
the runner may stage it. If the fixed redaction marker itself overlaps an
unusual credential value, the response fails closed rather than retaining that
credential through the replacement.

Linear uses `(organization ID, issue.id)` and Jira uses `(cloud ID, issue.id)`
as the stable source identity. Linear identifiers and Jira issue keys are kept
only as mutable display metadata.

Deletion/archive reconciliation is absent in this first polling lane. A
partial or completed v1 run therefore never invents tombstones. Do not claim
that permission loss, deleted issues, moved tenants, or archived records are
fully reconciled.

## Promotion gate

Default tests may use injected fetch and a temporary local Oracle. Their report
is always `not_ready` for live promotion because `testSeam: true`. A live pass
must use the exact HTTPS provider, exact tenant hash, protected static
credential mode, and a disposable/staging Oracle, and must record:

1. config, contract, source tree/package, and query document commitments;
2. stable provider identity before and after the run;
3. a forced multi-page window and bounded per-wire-attempt request ledger;
4. crash/restart replay and unchanged repeat behavior;
5. zero provider writes and actual Oracle ingestion writes;
6. explicit embedding model/boundary/count/error evidence, with external or
   unreported boundaries accepted only under the reviewed deployment policy;
7. separate Oracle verification with a read credential unavailable to the
   sidecar; and
8. host OS/architecture plus the evidence-manifest SHA-256.

The one-shot CLI deliberately cannot mint that qualification by itself. The
operator must bind the reports and independent verification above into the
retained promotion artifact.

Passing that gate supports only a statement such as: “Linear polling sidecar
live-read qualified for this artifact, tenant hash, stream, static credential
mode, and host.” It does not qualify OAuth, every Linear/Jira feature, another
tenant, or a 4 GB deployment.

## Provider references

- Linear: [GraphQL](https://linear.app/developers/graphql),
  [pagination](https://linear.app/developers/pagination),
  [rate limits](https://linear.app/developers/rate-limiting), and
  [OAuth](https://linear.app/developers/oauth-2-0-authentication)
- Jira Cloud: [enhanced issue search](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/),
  [JQL date/epoch semantics](https://support.atlassian.com/jira-service-management-cloud/docs/jql-fields/),
  [OAuth 3LO](https://developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/),
  [read scopes](https://developer.atlassian.com/cloud/jira/platform/scopes-for-oauth-2-3LO-and-forge-apps/), and
  [rate limiting](https://developer.atlassian.com/cloud/jira/platform/rate-limiting/)

## Explicitly next, not implied complete

After real Linear/Jira staging evidence, the next adapters are Slack public
allowlisted channels, provider-specific read-only email, and HubSpot companies.
Generic IMAP is not automatically least-privilege: Gmail and Microsoft IMAP
OAuth grants can carry broader mailbox authority even if the process uses only
`EXAMINE` and `BODY.PEEK`. Provider-specific Gmail or Microsoft Graph APIs may
be safer when authorization-layer read-only scopes are required.

Physical Windows qualification follows the live provider gate and must first
provide CA-authenticated loopback HTTPS (or an equivalent protected local
transport); plaintext loopback TCP is rejected for sidecar sync because it
does not authenticate the Oracle server. The gate must also cover state/restart
behavior, Task Scheduler identity, firewall posture, and reviewed NTFS ACLs.
Hosted Windows CI is useful software evidence but is not that device/deployment
proof. Linux CI and target Linux VM deployment, the complete Oracle workload
inside 4 GB, provider OAuth lifecycle, live VLM readiness, and product vision
remain unevaluated.
