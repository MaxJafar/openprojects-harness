# Security policy

OpenProjects v0.6 is local-first software intended to run as a lightweight private control plane or a higher-memory corporate appliance. The strict [`core-4g-v1`](./docs/lightweight-4gb.md) profile targets the harness on a 4 GiB total-system host and deliberately disables learned/integration sidecars; it is not evidence that a local model also fits. The control API supports independent local Bearer principals with capabilities and optional workspace scopes; the setup wizard and sealed [private profile](./examples/openprojects.private.yaml) provision one unscoped `local-admin`. On POSIX that profile listens only on a protected Unix-domain socket. This is configuration-based local RBAC, not SSO, corporate-directory identity, proof of the individual human, CSRF protection, tenant isolation, or TLS. Hosted inference is optional and absent from the sealed profile.

## Reporting a vulnerability

Do not report a vulnerability in a public issue or pull request, and never send live credentials, private chats, audio, project data, database copies, or unredacted event/export rows.

Use this repository's private [Security → Report a vulnerability](https://github.com/MaxJafar/openprojects-harness/security/advisories/new) flow and provide only a minimal local reproduction plus a manually redacted trace. GitHub delivers the report privately to repository maintainers. Do not use a public issue as a fallback when the report contains sensitive details.

## Supported deployment boundary

- For the POSIX sealed profile, keep `/var/lib/openprojects` owned by the service identity at mode `0700` and the live `control.sock` at mode `0600`. No TCP control listener is opened.
- For the sealed profile, keep every enabled model and embedding endpoint on loopback, omit hosted fallbacks and model API keys, deny external writes, and enforce default-deny egress independently of OpenProjects.
- Do not expose the process directly to an untrusted LAN or the public internet.
- Administer the service through a protected host session such as SSH and a narrowly audited service-account transition. TCP compatibility mode refuses non-loopback binds; there is no public-bind override.
- Keep every configured control token owner-only and use a distinct token file and token value per principal. Enforce mode `0400` or `0600` on POSIX; on Windows, place it on NTFS and verify an ACL restricted to the service identity with `Get-Acl`/`icacls`, because Node mode checks do not prove owner-only access. Tokens have no expiry or online rotation/revocation endpoint, so replacement requires a coordinated protected-file update and service restart. A principal ID identifies configured credential material, not the individual human holding it.
- OpenProjects refuses any existing Unix socket leaf instead of guessing it is stale. Startup and `doctor` perform a bounded connect-only liveness probe after verifying the socket type, owner, mode, and protected parent; a live or unresponsive result is diagnostic only and never triggers deletion. While running, a random mode-`0600` `.openprojects-socket-lease-*` hard link inside the owner-only parent pins the created inode against immediate identity reuse. Normal shutdown removes only the socket inode and private anchor it created; after a crash, follow the [manual socket recovery runbook](./docs/private-deployment.md#unix-control-socket-and-manual-recovery) and explicitly inspect/remove only the exact expected socket and anchor after proving that no service process survives. Node documents pathname Unix listeners and the possibility of a filesystem socket remaining after a crash ([Node Net documentation](https://nodejs.org/api/net.html)).
- Unix-socket access is enforced by pathname ownership and permissions, not by an application-level peer-credential assertion or cryptographic server identity. TCP loopback remains a development/compatibility mode and does not authenticate the process holding the port back to the client; another local process that binds it during downtime could capture a reconnecting token.
- Treat the SQLite database, configuration, environment, local model/embedding servers, Whisper model, plugins, and skill files as sensitive operator assets.
- Run the process as a low-privilege OS user. Restrict filesystem permissions on the database, `.env`, models, and logs; OpenProjects does not encrypt SQLite at rest.
- SQLite schema upgrades are an in-process, numbered transaction. The migration
  ledger must be contiguous and equal `PRAGMA user_version`; a newer or
  inconsistent database is rejected before WAL is enabled, and a failed pending
  sequence is rolled back. This detects contract mismatch, not a malicious
  same-privilege rewrite of a coherent database. Back up and test the exact
  database before upgrading; never hand-edit the ledger or `user_version`.
- Keep provider-side budget/rate limits enabled. The local router's daily budget is an estimate, not an atomic billing control.

The word “private” is not established by `local: true`, a loopback URL, or the absence of an API key. A private deployment additionally needs controlled host identity, encrypted storage/backups, reviewed model-serving configuration, access restrictions, patching, and tested network policy. An air-gapped claim additionally excludes Telegram and requires an audited offline import/export process. Use the controls and acceptance checklist in [docs/private-deployment.md](./docs/private-deployment.md).

## Trust boundaries

| Input or component | Security treatment |
| --- | --- |
| Runtime/storage code and boot configuration | Trusted computing base |
| Locally installed plugins | Trusted executable JavaScript with ordinary Node.js host authority; not sandboxed |
| Skill files | Trusted operator-installed instruction data, not executable authority |
| Integration manifests | Trusted reviewed configuration; exact file bytes are hashed, but a hash is not a signature or approval record |
| MCP stdio child or remote integration peer | External processor with its own process/account/network authority; all returned content remains untrusted |
| Provider-specific Corporate Oracle sidecar | External processor that owns provider OAuth/service credentials, pagination, webhooks, and normalization; its `ingest` principal is source- and workspace-scoped and grants no search or run authority |
| Corporate Oracle records and search results | Untrusted evidence with no instruction authority; optional post-commit embedding discloses normalized evidence to the configured local or approved-cloud embedding endpoint |
| User, Telegram, project, memory, tool-result, and model text | Untrusted content |
| Advisory subagent output | Untrusted evidence; never authorization |
| Configured model or embedding endpoint | External processor unless actually local and controlled |
| `local: true` model-route flag | Scoring metadata only; not an egress or residency guarantee |
| `/api/*` and SSE | Require a configured control credential and enforce its capability/workspace scope; legacy configs without `server.auth` are development-only |
| Unix control endpoint | Owner-only path inside an owner-only directory; still relies on OS account and filesystem integrity |
| Dashboard assets and `/health` | Do not require a Bearer token on either transport; Unix filesystem permissions still gate the private socket, which ordinary browsers cannot address |
| Run snapshot documents | Sensitive redacted identity commitments; authenticated readers can inspect them, but hashes are neither encryption nor signatures |

## Run commitment limits

Every newly allocated run receives agent, tool, and policy content addresses. Ordinary runtime captures bind the agent/version/budgets/grants/runtime profile, exact tool effects/idempotency/timeouts, schemas by digest, and the effect policy/guard IDs. Direct storage-only compatibility allocations say that their capture is incomplete rather than inventing unknown authority. Recovery verifies each stored canonical document and refuses to resume an ordinary run under a changed effective contract. Authenticated `GET /api/runs/:id` includes the three verified redacted `snapshotDocuments` when present.

The addresses are unsalted SHA-256 over a strict deterministic JSON subset. Prompt, skill, description, and schema bodies are hashed rather than copied into the document, but this is not encryption: likely text can be guessed offline and compared. Protect the database and API response accordingly. Hashes prove byte identity only; they do not prove reviewer identity, origin, integrity against a same-privilege database attacker, or freshness. They are not digital signatures. They also omit plugin code, dependency/runtime/build identity, model artifact/runtime identity, and the concrete code behind any external transport. Keep model manifests, runtime locks, software provenance, filesystem controls, and reviewed deployment records as separate security evidence. The deterministic encoder is intentionally not a claim of full [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785.html) conformance.

## Terminal surfaces and installer

The setup wizard is a deterministic configuration generator, not a package installer. It does not download model artifacts, invoke a shell, start services, change network policy, or request provider credential values. After interactive confirmation it generates one local control token for the unscoped `local-admin`/`admin` principal, creates it exclusively, and references only its path from YAML. On POSIX it validates the token as owner-only and the sealed/default plan also configures an owner-only Unix socket. Windows uses loopback TCP and emits an explicit NTFS ACL review requirement; the wizard cannot attest owner-only Windows access through Node mode bits. A Telegram-enabled hybrid plan instead removes the socket, uses loopback TCP, and requires a reviewed TLS reverse proxy that exposes only `POST /webhooks/telegram`. The wizard rejects an explicit Telegram-plus-socket plan, and service startup independently rejects that combination in every configuration. Hosted authentication is represented only by a validated environment-variable name. Headless defaults are restricted to dry-run planning.

On POSIX, config publication uses a complete same-directory temporary file at mode `0600`; data/token directories are mode `0700`, and the token is mode `0600`. The control token is separately created at its final path with exclusive-create semantics, written and synced before setup completes, and then validated as an owner-only regular non-symlink file; it is not published through a temporary rename. Windows retains the exclusive-create, regular-file/link-identity, file-sync, and atomic-publication checks, but directory `fsync` and POSIX mode guarantees do not apply; an operator must establish and verify restrictive NTFS ACLs. Existing paths are not overwritten by default. `--force` accepts only a regular config, refuses symbolic links and non-files, creates a backup, and retains an already valid token instead of rotating it. These controls do not replace directory ownership and permission checks by the operator.

The TUI treats all model, project, memory, tool, and error text as untrusted terminal input. Ordinary rendering removes terminal control sequences, C0/C1 controls, and bidirectional/format controls before layout. Approval decisions are bound to the durable stored invocation and canonical argument SHA-256; their complete arguments remain inspectable, with unsafe code points rendered as visible Unicode escapes and every long-input page reviewed before confirmation. Confirmation stores both approval ID and reviewed digest, and the service transactionally rejects a stale digest. Approval and invocation records are compared before display. `NO_COLOR`, `TERM=dumb`, and non-TTY output do not weaken policy and never make an approval automatic. In service-attached mode the service performs startup recovery; explicit plain/screen-reader and implicit non-TTY TUI summaries only read a snapshot. In standalone mode those summaries skip recovery, so status inspection does not resume work.

Startup recovery is bounded and agent-scoped. A run from another version, a
changed/invalid run commitment, or a malformed run row is failed independently
with a durable `run.recovery.failed` event before quarantine starts a tool;
pending actions are rejected where their own records remain valid. A tool already
marked running before restart is not reclassified as a known failure: its event
sets `externalOutcomeUnknown`, its invocation receives
`RUN_RECOVERY_UNKNOWN_OUTCOME`, and the operator is told to verify before retrying.
Healthy rows and the other fixed agent lane continue. Corrupt-row quarantine
preserves the original metadata and snapshot fields but changes lifecycle
status/error and appends an audit event, so take a forensic copy before startup
when investigating suspected tampering. SQLite/query failures that prevent safe
isolation still fail startup.

The service is the sole production runtime and SQLite owner; the default POSIX TUI is a Unix-socket API client that loads one selected protected credential. If multiple principals are configured, `tui --principal <id>` is mandatory. This is service-credential RBAC, not human identity: anyone permitted to run as the service UID and read the configuration/token paths can select any available principal unless an audited sudo rule or fixed wrapper pins the principal and config path. The TUI exposes the authenticated identity and disables run/approval controls without the required grants, but server-side checks remain authoritative. `tui --standalone` and `tui --demo` directly own storage for development. Other direct commands—including `chat`, `learning` commands, `notify`, and `export-feedback`—also open the configured database rather than going through the authenticated API. Stop `serve` before using any of them against a durable deployment. Terminal, configuration, and token-file access are operator boundaries, so protect SSH/console identity and the host account.

## Control authorization and event streams

`server.auth` accepts either the backward-compatible `{tokenFile, operatorId}` form, which maps to one all-workspace principal with every capability, or `principals: [{id, tokenFile, capabilities, workspaces?}]`. Capabilities must be a non-empty subset of `read`, `run`, `ingest`, `approve`, and `admin`; `admin` implies all capabilities. A present workspace allowlist must be non-empty; omission means all workspaces. Ordinary GET/SSE inspection requires `read`; run creation, feedback, and inbound events require `run`; Oracle connector pages plus that principal's own checkpoint require `ingest`, which grants neither Oracle search nor run authority; exact approval resolution requires both `read` and `approve`, preventing an approve-only credential from using the response as a run-context/output side channel; sensitive memory/group/source-data mutation, purge, exports, and notification delivery require `admin`. Global exports, a notification tick, a purge without a workspace, and binding/rebinding a provider-global external group identity require an unscoped admin. Group list/delete remains workspace-scoped and cross-workspace group migration is refused. This is a least-privilege control-plane design consistent with [NIST's RBAC definition](https://csrc.nist.gov/glossary/term/role_based_access_control) and [NIST least-privilege guidance](https://nvlpubs.nist.gov/nistpubs/SpecialPublications/800-171r3/NIST.SP.800-171r3.html), but it does not supply corporate identity or credential lifecycle management.

Authenticated `POST /api/events` treats the claimed `source` as untrusted data. It stores `control-api/<encoded-principal>/<encoded-source>`, with each component base64url-encoded, separate from verified adapter namespaces such as `telegram` and from every other principal. Deduplication covers workspace, this namespaced source, and key. A requested project must exist in that workspace before the durable dedupe key is consumed, so a rejected attempt cannot poison a corrected retry. The response exposes only `duplicate`, optional `runId`, and relative status/event links—not the full run, output, approvals, or event trace. `/api/meta` similarly omits the private `agent.system` prompt and every subagent `system` prompt.

Durable run events are emitted with SSE `id` equal to the stored sequence. `afterSeq` and `Last-Event-ID` resume strictly after that sequence; replay is paged, the live subscription is installed before its replay fence, and sequence deduplication closes the replay/live race. The client reconnects after classified transient Unix-socket reset, timeout, unavailable, and socket errors, while protocol/authentication/non-retryable failures stop. A consumer-callback exception is non-retryable, and the client commits neither the cursor nor terminal state until that callback returns successfully. The resume shape follows the standard `Last-Event-ID` behavior ([WHATWG Server-Sent Events](https://html.spec.whatwg.org/dev/server-sent-events.html)). Server writers honor Node backpressure, bound frames and queued bytes/live events, impose a drain deadline, and disconnect a slow consumer instead of growing memory without bound ([Node stream backpressure documentation](https://nodejs.org/download/release/v24.1.0/docs/api/stream.html)). A process-wide admission limit caps active event streams at 16 by default and 4 under `core-4g-v1`; excess clients receive `429` before stream state is allocated. Workspace SSE deliberately carries invalidations only; consumers fetch a fresh scoped snapshot.

Run admission is also process-wide. The `core-4g-v1` profile permits one active supervisor or project-analyst execution across initial starts, approval continuations, and recovery; overload fails fast before a durable run is allocated. It does not maintain an unbounded in-memory wait queue. SQLite collection reads and prompt reconstruction use explicit finite page/tail limits, with the full post-compaction session context capped at 512 events. These are resource controls, not tenant fairness or denial-of-service protection.

## Runtime ownership and stale locks

Before opening a durable SQLite database, every application process exclusively creates the adjacent `<database>.owner.lock`, writes and syncs non-secret PID/start metadata, and holds its descriptor until after storage closes. POSIX enforces mode `0600`; Windows still enforces exclusive creation and file/link identity but requires an independently reviewed NTFS ACL. Existing regular files, symbolic links, and special files all cause startup to fail closed. The lock is a single-process ownership guard, not a substitute for OS identity, filesystem permissions, or host process isolation.

An unclean exit can leave a stale lock. OpenProjects deliberately does not trust PID metadata enough to break it automatically. Never delete a lock merely because startup calls it stale or because the recorded PID is absent: first stop the service/restart loop, verify through the service manager and host process inspection that no OpenProjects process is using the database, inspect the exact lock path without following links, and remove only that one expected regular file. The complete operator procedure is in [Private corporate deployment](./docs/private-deployment.md#runtime-owner-lock-and-manual-recovery).

## Read-only provider sidecars

The Linear/Jira Oracle sidecar is a separate one-shot process. Provider tokens
are read only from the configured environment variable and must be scoped and
injected by the host secret manager. They must never appear in YAML, argv,
logs, reports, Oracle records, pending pages, or model context. The Oracle token
uses the protected control-token loader and should identify a principal with
only `ingest` for one exact workspace.

Provider requests are restricted in code to exact HTTPS origins and fixed
identity/read-query operations. Redirects, cookies, ambient credentials,
arbitrary URLs, user-authored GraphQL/JQL, comments, descriptions,
attachments, worklogs, and provider mutations are absent from v1. Linear/Jira
responses are hostile input: every decoded response string is first scrubbed
of the exact configured credential value, account/team/cloud identity and
structural bounds are checked before records are normalized, creation must not
postdate update, and every update timestamp must remain inside the exact
connector window. The same exact-secret guard is applied again to every new or
replayed Oracle request body before it can be submitted. Jira
uses timezone-independent epoch-millisecond JQL bounds and rejects any grant
other than the exact classic `read:jira-work` scope. The resulting text remains
untrusted Oracle evidence with no instruction authority.

Provider request evidence counts actual wire attempts, including retries; it
contains only the fixed method, origin, redacted path, and operation class.
After Oracle commit, normalized provider text can still cross the configured
embedding boundary. Sync receipts and sidecar reports expose `local`,
`external`, or `unreported` boundary evidence plus bounded model/count/error
evidence. An ambiguous acknowledgement records embedding
`invocationOutcome: unknown`; empty receipt-observed counts must not be read as
proof that no embedding disclosure occurred. `local` is declared placement,
not proof that a loopback model server cannot proxy or egress. Do not promote a
report with an unexpected external, unreported, or unknown outcome.

`pending-page.json` can contain provider-derived business metadata. The POSIX
state directory is forced owner-only and the pending file is synchronized
before the local Oracle POST. The implementation retains and rechecks directory
and pending-file identities, but the canonical state path and every ancestor
must still be protected from untrusted rename/write access; Node does not expose
portable dirfd-relative publication and unlink primitives. Windows mode bits are not an ACL attestation;
restrict the state directory and both credentials to the Task Scheduler/service
identity on NTFS before use. A transport failure after POST leaves the exact
page in place. Do not edit or delete it to “fix” a conflict. After verifying
that no sidecar process exists, remove only a stale
`sidecar-state.owner.lock`; the next run validates and replays the committed
body or fails closed on checkpoint drift.

On POSIX, the Oracle socket parent is resolved and required to be an owner-only
`0700` directory; the endpoint must be an owner-owned Unix socket with mode
`0600`. The client repeats that validation immediately before each request and
uses the canonical parent path. This prevents another local account from
substituting a listener in the reviewed directory, but every ancestor and the
same OS account remain part of the deployment trust boundary. Plaintext
loopback TCP is rejected because the Bearer token authenticates only the client;
native Windows therefore requires CA-authenticated loopback HTTPS or another
separately reviewed protected IPC transport.

Static API-key or pre-issued Bearer consumption does not implement OAuth.
Consent/PKCE state, refresh, rotation, revocation, tenant switching, scope
downgrade, deletion/archive reconciliation, physical Windows deployment, Linux
CI and target Linux deployment, and the complete 4 GB Oracle workload require
separate evidence. See
[Read-only provider sidecars](./docs/provider-sidecars.md).

## Telegram consent and privacy

Telegram webhook requests use one fixed `POST /webhooks/telegram` route and authenticate only with `X-Telegram-Bot-Api-Secret-Token`; the secret is not placed in the URL. Update IDs are deduplicated. The stored inbound webhook payload contains sanitized metadata rather than raw message text. Metadata can still be identifying and must be protected. Because the current process has no separate webhook listener, a Telegram-enabled hybrid profile uses loopback TCP behind a reviewed TLS reverse proxy. That proxy must publish exactly the fixed POST route and must not forward `/api/*`, `/health`, dashboard/static paths, or arbitrary methods. Telegram with `server.socketPath` is rejected rather than silently making the private socket network-reachable.

Group content observation requires all of:

1. global `learning.enabled`;
2. global `learning.groupObservation`;
3. a persisted group binding enabled through `/openprojects_enable` by a user in `TELEGRAM_ALLOWED_USER_IDS` who is also a Telegram administrator, or by the trusted local operator API.

`TELEGRAM_ALLOWED_USER_IDS` is a comma-separated operator allowlist. It is fail-closed: missing, empty, malformed, zero, and negative IDs grant no access. The allowlist gates direct messages, group enable/disable, and shared-memory activation. Enable, disable, and activation additionally require Telegram administrator status. Once a group is bound and enabled, ordinary participants may be observed and may explicitly run the bot. Unbound or disabled groups cannot start runs, even through `/op` or `/openprojects_status`. Commands addressed to a different `@bot_username` are ignored.

The Telegram binding command checks administrator status with Telegram and posts a visible notice. Disabling Telegram BotFather privacy mode may be required for transport delivery of ordinary messages, but it does not bypass OpenProjects' gates.

Passive opted-in group observation performs deterministic local redaction/salience and does not invoke an LLM. Non-salient content is discarded before a group-message or learning-signal row is written. Allowlisted-operator direct messages plus `/op`, `/openprojects_status`, mentions, and replies in an enabled group are explicit runs and can send selected context to the configured model route. Tell participants which routes are local or hosted.

Obvious credentials and private-key shapes are redacted heuristically before group observation and learning export. This is not semantic data-loss prevention and can miss secrets or damage benign text. Participants must not send secrets to the bot.

Inferred group memories start `proposed` and are excluded from retrieval. Telegram activation through `/remember` requires both operator allowlisting and group-administrator status; the local memory-status API requires an authorized `admin` principal in that memory's workspace when `server.auth` is configured and otherwise inherits the legacy development-only boundary.

`/openprojects_disable` stops future collection/reminders but does not erase retained data. Retention purge is manual. `DELETE /api/groups/:id/data` deletes group observations, group-derived memories, and non-sending notifications, then retains the binding disabled. A notification already in `sending` is deliberately not deleted because its remote outcome may be ambiguous. Sanitized inbound-event metadata and some learning/aggregate provenance can remain, so this endpoint is not a complete participant-erasure guarantee.

## Models, embeddings, and data egress

- The recommended private configuration has one customer-controlled local inference route and no remote fallback. If that endpoint fails, inference should fail closed.
- With `privacy.localOnly: true`, HTTP clients owned by the harness reject non-loopback origins unless the exact scheme/host/port origin appears in `privacy.allowedOrigins`; model, embedding, MCP HTTP, and JSON integration requests reject redirects. This guard does not cover arbitrary trusted plugins, egress initiated by an MCP stdio child, or the separately managed inference server.
- Put API keys only in owner-readable credential files or environment variables referenced by reviewed config/manifest environment names; never commit values to YAML, prompts, skills, tool arguments, feedback, or export rows. The example `llama.cpp` service reads its server credential from a protected owner-only key file while OpenProjects receives the matching value through its protected service environment.
- The router refuses a non-loopback OpenAI-compatible route without an API key, but that check does not authenticate the remote server, validate its retention policy, or pin TLS.
- A loopback endpoint can still proxy data elsewhere. Review the actual server and its configuration.
- Local FreeToken, llama.cpp, Ollama, and similar servers run outside the OpenProjects trust boundary. Patch and isolate them, bind them narrowly, and do not assume their model output or tool JSON is safe.
- The dedicated `llama.cpp` route accepts only exact loopback HTTP `/v1`, a visible-ASCII bearer credential, and a fixed safe model alias. It sends one structured request at a time, disables parallel tool calls, and rejects response-model drift. The packaged worker is CPU-only and disables its UI, built-in agent/tool/MCP surfaces, model downloads, multimodal projection, slot inspection, continuous batching, and request-selectable model routing. OpenProjects remains the only tool and approval authority. The standalone 4 GiB gate holds and rechecks exact config/manifest snapshots plus host and target-root artifact descriptors, cross-binds qualification and deployment pins, and binds the only enabled route, runtime/model hashes, PID instance, namespaces, complete argv, read-only model mapping, sole listener, negative auth, sealed environment, resource envelope, soak, and compact analyst result. macOS app-budget evidence is explicitly non-certifying; Linux promotion also requires a host no larger than 4.5 GiB with at least 256 MiB continuously available, a verified cgroup-v2 mount, and stable finite memory/swap limits, inode, kernel peaks, and sampling cadence under a shared ancestor no larger than 4 GiB.
- The experimental `freetoken` route accepts only exact loopback HTTP `/v1`, forbids unsupported API-key configuration, and sends only a fixed safe `--served-model-name` alias. It disables parallel tool calls, rejects malformed or unoffered tool calls and response-model drift, and requires a singleton model inventory during qualification. FreeToken remains an externally supervised NVIDIA runtime with no documented model-server authentication; never expose its port or treat its process/model artifacts as part of the 4 GiB core.
- The optional MLX-LM route is a supervised loopback dependency, not an embedded sandbox. Its upstream HTTP server is unauthenticated development software: use it only on a dedicated/trusted Apple host, pin the runtime and complete model snapshot, deny egress independently, and run `openprojects qualify` against a reviewed manifest before accepting a lane. Qualification is bounded evidence for one artifact/runtime/configuration; it is not a security proof, quality guarantee, or permission to expose the MLX port to other users.
- The default feature-hash embedding stays in process. Optional Ollama embeddings disclose memory/query text to that configured endpoint; vectors themselves can reveal semantic information. Concrete embedding adapters declare `local` or `external`; custom adapters without a declaration remain `unreported` in Oracle/sidecar evidence. `local` includes loopback placement and does not prove the sibling service cannot proxy data elsewhere.
- A routed subagent has no tools, but its task text is still disclosed to the selected inference endpoint and a crash can repeat provider cost.
- Telegram is an external processor even when inference is local. Telegram messages/files reach Telegram infrastructure, and admin checks, audio download, responses, and notifications require network egress. A Telegram-connected deployment may claim local model inference, not that all data remains on the corporate machine.

## Image and document input

v0.6 still has text-only product model messages and local audio transcription, with no Telegram image ingestion, local OCR, image/document tool, or multimodal agent-run payload. Its standalone readiness path validates bounded PNG/JPEG containers in memory and can send one inline image to one exact loopback VLM without constructing the application or opening SQLite. The bundled live corpus is PNG-only; JPEG service decoding is not qualified. Image bytes and model descriptions are intentionally absent from the report, and every returned observation remains untrusted. This evaluator does not add the missing product data path or make the VLM server a sandbox: product promotion still requires isolated decoding, host egress denial, non-retention/crash semantics, and the exact live model/hardware gate.

## Prompt injection and tool authority

Prompt injection is expected, not considered solved by filtering. Retrieved memories, Corporate Oracle/project evidence, Telegram messages, transcripts, tool results, and model text carry no instruction authority.

Host code enforces:

- an allowlisted tool registry and AJV input validation;
- a trusted static effect for each tool;
- monotonic `deny`/`ask`/`allow` policy combination;
- one approval bound to the exact stored invocation, actor, canonical arguments,
  argument SHA-256, and effect;
- step, tool, result-size, output-token, and active-time limits;
- a timeout-linked `AbortSignal` for each tool plus bounded-grace detection when a tool ignores cancellation;
- stable idempotency keys for eligible local writes;
- durable same-session Oracle taint: after a completed `oracle_search`, every
  later external-boundary call or non-read/non-draft effect requires an exact
  approval until a new session starts; and
- fixed allowlisted subagents with no tools and bounded calls, parallelism, depth, and output.

A cooperative tool aborts when its timeout signal fires. If a non-cooperative tool remains unsettled after bounded grace, OpenProjects records `TOOL_EXECUTION_AMBIGUOUS`, emits a durable audit event, and stops the run with a verify-before-retry warning; it does not claim the external outcome is known. A model cannot add a tool, lower its effect, widen policy, activate a memory, authorize a notification, install a plugin, or approve its own call. Plugins remain trusted same-process code; reversible registration is lifecycle management, not isolation.

The runtime rejects malformed, non-object, over-limit, or duplicate-key JSON
across the complete returned tool-call batch before allocating its durable batch
or evaluating any member. Duplicate names are compared after JSON escape
decoding at every nesting level. Schema-valid input is then encoded with the
same strict deterministic JSON subset used for content addressing. Approval
resolution holds a SQLite immediate transaction while comparing the submitted
review digest, approval row, invocation row, recomputed digest, canonical
bytes, tool, and run identity. A pre-migration row without a digest can be
rejected to clear it, but cannot be approved or recovered into execution.

Telegram approval buttons carry a compact 128-bit review token derived from
the full SHA-256; the handler verifies that token against the current row and
passes the full digest into the transactional check. An Approve button appears
only when the complete canonical arguments and full digest fit in one Telegram
message. Oversized approvals receive a non-actionable notice pointing to the
paginated local TUI or authenticated API; actionable content is never silently
truncated.

The reviewed integration layer does not change that rule. MCP and JSON API manifests accept only a fixed local tool allowlist whose names, strict schemas, effects, data boundaries, idempotency, timeouts, byte limits, process/origin, and request structure are operator-owned. Remote MCP annotations and schemas are never authority; bounded discovery verifies only the configured peer identity and required tool names. Stdio uses an absolute executable, literal argv, `shell: false`, and an explicit minimal environment. Streamable HTTP and JSON API clients use an exact loopback-or-HTTPS destination, enforce the harness network policy, reject redirects, and bound bytes while streaming. JSON operations cannot expose a generic URL/header/method, OpenAPI document, or model-authored GraphQL/JQL. Only projected local-schema-validated JSON, or MCP object `structuredContent`, becomes the result; peer and transport error text is replaced.

These controls are not a sandbox or credential broker. An MCP stdio child keeps the service identity's OS/network authority, exact HTTPS origins are not DNS/certificate pinning, and static environment-backed credentials have no built-in expiry, refresh, or revocation. OAuth, dynamic client registration, resources, prompts, tasks, sampling, elicitation, and automatic MCP installation are absent. Credential account/scope rotation under the same environment name is not committed; stop the service, reconcile outstanding approvals, change the manifest/environment reference, probe/evaluate again, and restart when authority changes. The stable MCP specification describes tools as model-controlled and remote annotations as untrusted unless their server is trusted ([MCP tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)). See the full [integration security contract](./docs/integrations.md).

Before adding arbitrary filesystem, subprocess, browser, fetch, remote MCP, or model-written code tools, add OS/process isolation, project-root confinement, independent network egress controls, resource quotas, secret brokering, and fail-closed enforcement tests.

The representative evaluation corpus passed 8/8 deterministic host cases, including rejected/one-shot approvals, hostile group/retrieved text, and post-approval crash recovery. Its live pinned-Qwen lane passed only three read-only analyst cases. These are regression gates, not proof that prompt injection is solved; supervisor and vision are still unqualified, and model/tool/plugin changes require the same gates again. See [Evaluation and extension gates](./docs/evaluation-extension-gates.md).

## Local Whisper subprocess safety

Transcription is disabled by default. When `whisper-cpp` is enabled, OpenProjects validates declared Telegram audio type, size, and duration; uses a unique temporary directory; invokes FFmpeg and `whisper-cli` with fixed arguments and `shell: false`; bounds time and child output; terminates aborted processes; and removes temporary audio in `finally`.

These controls do not make FFmpeg, whisper.cpp, their model files, or the host media stack trusted. Install reviewed builds, patch them, run with low privilege, and retain the configured size/duration limits. A transcript is untrusted text and can be retained under the same opted-in group policy even though raw temporary audio is removed.

## Notifications and external outcomes

Notifications use deterministic templates from confirmed tasks, not model-authored text. The scheduler persists a row before Telegram delivery and claims it immediately before sending.

If the process stops after a claim, restart marks that row `unknown_outcome` and does not retry it. Routine shutdown gives the active sender a fixed settlement budget; on timeout it atomically marks that exact claimed row `UNKNOWN_OUTCOME_AFTER_SHUTDOWN_TIMEOUT`, disables any late storage write from the detached operation, and then aborts the sender. This avoids an automatic duplicate but can lose a message. Known failed rows are also not automatically retried. Operators should inspect notification state rather than resetting ambiguous rows blindly.

The `serve` signal handler also has a 30-second outer process budget. It closes SQLite only after service teardown proves its tracked work settled; otherwise it forces process exit without closing storage underneath live work and prints the owner-lock/socket recovery requirement. Treat that path as an unclean stop and perform the documented inspection before restart.

The CLI `notify` command only plans. `POST /api/notifications/tick` can send and therefore must be treated as an external-effect endpoint on the protected local API. On routine service shutdown, OpenProjects first stops new scheduler ticks and gives an active tick/delivery its fixed settlement budget before closing the Telegram adapter. A delivery that exceeds that budget is durably classified `unknown_outcome` and aborted as described above; shutdown never waits indefinitely or converts that ambiguity into an ordinary send failure.

## Feedback, reinforcement, and training export

Feedback-ID idempotency applies to bounded updates of memories attributed to that run. Feedback cannot change memory content/status, tool policy, prompt authority, or model weights. Aggregate route reward is only a routing signal.

Learning export is deterministic, applies obvious-secret redaction, and constrains/redacts feedback dimension keys, but it is not proof of anonymity, participant consent, or review. Preference pairs require a strictly negative score. The schema has no `review_status` or approved-for-training flag. Comments are included unless disabled; legacy reward-export aliases omit them. Before any external training system receives JSONL, a human must review:

- authorization and participants' expectations;
- secrets, personal data, and confidential project material;
- poisoning and malicious corrections;
- provenance, licensing, duplication, and train/eval leakage;
- the SHA-256 manifest and intended dataset scope.

The live OpenProjects process does not train, fine-tune, upload, or promote checkpoints. The optional [`training/`](./training/README.md) lab is a separate local operator workflow and accepts SFT rows only after a `model_training` review file names every approved ID and binds the canonical source manifest and dataset SHA-256 values. It revalidates row schemas and bounds, rejects duplicate JSON keys, keeps connected source-run/prompt components together, writes content-addressed files with write-once-or-verify behavior inside the workflow, keeps the pilot holdout outside MLX's data directory, and defaults to planning. Execution requires an exact reviewed model-file lock, the pinned MLX runtime, an enabled config, explicit `--execute`, and an exact tokenizer/chat-template preflight before invoking the current interpreter as `python -I -m mlx_lm lora` with an argv array, trusted working directory, and `shell=False`. It rejects symlinked artifact paths, rechecks runtime/model/training identities before and after the attempt, and requires a finite, structurally valid adapter postflight before recording even an unqualified candidate. These files are not OS-immutable or signed. Any future promotion suite must include the representative corpus, but its 8 deterministic host cases and 3 compact-analyst prompts are necessary regression evidence rather than sufficient checkpoint-quality evidence.

Those checks are not a durable consent ledger, cryptographic reviewer signature, semantic privacy scanner, near-duplicate detector, chronological split, validation set, or production qualification. The current database has no purpose-specific training consent/revocation fields; group-observation opt-in is not permission to train. A supervised learnability pilot requires every contributor to be authorized plus the example's 100-train/50-held-out minimum. Promotion requires the separate 500/100/200 data gate and the external contamination, chronological split, real candidate-versus-base eval, canary, and rollback controls in [docs/training-safety.md](./docs/training-safety.md); the lab does not implement those promotion gates. It never auto-serves or registers an adapter, and weights never enforce policy.

The lab is separated from the live runtime. The operator downloads a commit-pinned model snapshot as an explicit earlier step; `--execute` refuses Hub IDs and any snapshot that differs from the reviewed file lock, removes proxy and implicit-token access from the child environment, and forces Hugging Face/Transformers offline mode. This is an application-level network restriction, not an operating-system sandbox. Pre/post hashes detect ordinary concurrent changes but cannot defeat a same-privilege process that swaps and restores bytes between checks; stronger deployment needs an attempt-private read-only snapshot or privilege separation. FreeToken is an inference engine, not the training boundary.

## Recovery and exactly-once limits

SQLite transactions and stable keys make current local writes recoverable, but they cannot atomically commit a remote effect. Provider inference can repeat after a crash and incur duplicate cost. Telegram delivery and a non-idempotent JSON/MCP write can become `unknown_outcome`. Any email, payment, ticketing, chat, or other external connector needs a provider idempotency/status-check contract or a durable human reconciliation state before automatic retry.

## Known limitations

v0.6 does not provide SSO, a corporate-directory binding, proof that a named human holds a configured principal, credential expiry or online rotation/revocation, a credential broker or OAuth flow, public/multi-tenant authorization, rate limiting, encrypted storage, signed run/build provenance, plugin/process sandboxing, product image ingestion, dynamic MCP features, OS/process-wide egress or destination enforcement beyond the harness clients' exact-origin policy, certificate/DNS pinning, semantic secret detection, automatic retention scheduling, per-event signatures, automatic participant-level deletion workflows, or a Restate/Temporal workflow backend. Review [docs/architecture.md](./docs/architecture.md), [the integration contract](./docs/integrations.md), and [the measured extension gates](./docs/evaluation-extension-gates.md) for the full current/future boundary.
