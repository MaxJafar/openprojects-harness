# OpenProjects Harness architecture v0.6 + unreleased Corporate Oracle foundation

Status: implemented v0.6 contract plus an unreleased temporal Corporate Oracle
foundation plus isolated one-shot Linear/Jira polling sidecars; external-tenant
sidecar operation, a representative Oracle product evaluation, and the 4 GiB
Oracle workload remain unqualified. Vision readiness remains
separated from product ingestion. Last updated 2026-08-27.

OpenProjects is a single-process, lightweight private agent control plane for project operations. Its bounded core targets a 4 GiB total-system host without requiring a resident learned model; model inference, semantic embeddings, transcription, vision, Telegram, and integrations are separately enabled and qualified lanes. Larger private deployments can keep those processes on customer-controlled hardware, while hosted routes remain an explicit compatibility option rather than a dependency. The host combines a durable supervisor loop, schema-validated tools and approvals, task/cost-aware model routing, bounded specialist lanes, reviewed persistent memory, a temporal cross-system evidence ledger, deterministic notifications, and controlled learning-data export.

The live product remains a harness around inference models. It is **not** an online reinforcement-learning system and never changes or promotes weights. The optional Python training lab is a separate operator-invoked boundary. Execution uses only a pre-downloaded local snapshot and forces supported model libraries offline, but this application-level restriction is not an operating-system network sandbox.

## Version and compatibility boundary

- The application and main-agent version are `0.6.0`; unchanged specialist definitions retain their own `0.5.0` contract versions.
- The YAML configuration schema remains `version: 1`; integrations and newer server fields are optional, and the server remains backward-compatible with the legacy single-token shape.
- v0.6 retains the durability, colleague-learning, and v0.3 control-plane foundation: sessions, runs, append-only events, tool batches, scoped approvals, recovery, feedback, project state, plugin lifecycle, deterministic evaluation, opt-in observations, memory attribution/reinforcement, bounded delegation, notification state, local transcription, reviewed learning exports, protected Unix transport, scoped capabilities, and resumable run SSE.
- v0.5 carries forward the strict Apple-Silicon MLX route and qualification gates, compact one-tool project analyst, representative host/live split, content-addressed run commitments, macOS packaging, bounded notification/socket handling, and paged approvals. It adds reviewed manifest loading, an independent external-data policy, bounded MCP stdio/Streamable-HTTP clients, declarative JSON API operations, offline validation/live probing, and manifest/transport commitments on every granted integration tool.
- v0.6 adds a standalone, hash-bound local-VLM readiness evaluator and ephemeral media/adapter foundation. It does not add media to `StartRunInput`, model messages, SQLite, the API, TUI, Telegram, memory, or tools.
- Unreleased schema migration 10 adds the Corporate Oracle core: normalized
  account-bound connector pages, mutable current heads plus append-only retained
  source versions, atomic per-source/stream sync checkpoints, content-bound
  current embeddings, read-only cited Oracle tools, and a separate `ingest`
  control capability. Schema migration 11 adds an accepted-page replay ledger,
  Unicode FTS5 candidate indexes, replay-time embedding repair, cursor-chain
  compare-and-swap fencing, and the session-wide post-Oracle action guard.
  The schema remains provider-neutral; the one-shot Linear/Jira CLI sidecars
  use it but do not inherit a live-provider qualification from the migration.
- The active lightweight stage adds the optional `core-4g-v1` profile, aggregate retrieved-context limits, lazy integration loading, bounded model-response materialization, and a disposable harness footprint gate. This profile is a capability reduction; it does not claim that a local model runtime fits in 4 GiB.
- SQLite now has a numbered transactional migration history and a matching
  `PRAGMA user_version` gate. Event envelopes still have no per-event schema
  version; that remains hardening work before long-lived multi-version event
  consumers.

## Capability status

| Area | Implemented/default | Implemented/optional | Not implemented |
| --- | --- | --- | --- |
| Models | Deterministic mock route | Local or hosted OpenAI-compatible routes, strict loopback MLX-LM text/tools, including a compatible FreeToken server | Live weight updates, automatic checkpoint promotion |
| Learning | Opt-in observations, proposed memories, bounded feedback reinforcement | Local Ollama or explicitly external OpenAI-compatible embeddings | Autonomous policy/prompt mutation |
| Corporate Oracle | v10 versioned current/history ledger and atomic checkpoints; v11 accepted-page replay/CAS safety, Unicode candidate indexes, embedding repair, and post-search session taint | Authenticated ingestion API, configured embedding adapter, and one-shot Linear/Jira read sidecars | Live-qualified external tenants, Slack/email/CRM/ERP sidecars, generic prose citation validation, automatic source-to-memory promotion, 4 GiB Oracle claim |
| Offline SFT | Nothing runs automatically | Reviewed-export validation, grouped held-out split, guarded MLX QLoRA runner | Online RL, DPO, model upload/serving, promotion |
| Delegation | Three fixed advisory agents with hard bounds; the project analyst has one scoped read tool and the other two are tool-free | Separately gated configured model routes per task | Arbitrary agents, recursive workers, authority-bearing specialist tools |
| Notifications | Deterministic templates and durable delivery state | Telegram delivery | Quiet hours, per-user subscriptions, model-authored sends |
| Audio | Disabled adapter | Local `whisper.cpp` plus FFmpeg | Cloud transcription fallback, speaker diarization |
| Images/documents | No ingestion path | Bounded qualification probe for a separate pinned VLM endpoint | Local OCR/VLM media worker and multimodal product messages |
| Egress | Non-loopback harness HTTP origins blocked by default | Exact reviewed origin allowlist | OS firewalling or confinement of plugins/model servers |
| API | Protected POSIX Unix socket, local capability/workspace RBAC, JSON, resumable bounded durable run SSE | Loopback TCP and legacy single-admin/global token; unauthenticated legacy development config | Public/multi-tenant control plane, SSO/per-human identity, cancellation |
| Terminal UX | Deterministic setup wizard, plain fallback, service-attached full-screen TUI with approval-page traversal | Explicit standalone development mode and hybrid configuration | Cross-platform service lifecycle installer |
| Evaluation/provenance | Eight-case offline representative corpus; three redacted execution-contract commitments on each new run | Explicit pinned live analyst lane | Automated model/checkpoint promotion or signed build provenance |
| Integrations | Static local schemas/effects/grants plus workspace and external-data policy; generic Oracle ingest contract | Bounded MCP stdio/Streamable HTTP and declarative JSON API manifests; isolated Linear/Jira polling sidecars with externally managed credentials | Harness-owned OAuth, broad provider SDKs, dynamic MCP authority, generic fetch/OpenAPI, resources, tasks, sampling, or elicitation |
| Resource posture | `core-4g-v1` with bounded host tools/context/retrieval and optional resident features disabled | Separately qualified one-at-a-time learned sidecars on larger hosts | Model-name-based memory promises or unbounded co-residency |

`local` declares a route's data boundary and is validated against the URL for generic routes; it also participates in ranking. `privacy.localOnly` separately enforces loopback-or-exact-origin policy for model, embedding, enabled Telegram, MCP HTTP, and JSON API clients owned by the harness. It does not firewall plugins, an MCP stdio child, the local model server, or the host, and therefore does not by itself prove process isolation or data residency. The sealed corporate profile has only loopback inference/embedding endpoints and no hosted fallback, while the complete private claim depends on the controls in [private-deployment.md](./private-deployment.md).

## Component map

```text
Setup wizard ──> reviewed YAML + protected local-admin token + Unix socket path
Service-attached TUI ──> owner-only Unix HTTP / workspace SSE ─┐
JSON / resumable per-run SSE ──────────────────────────────────┤
TCP compatibility dashboard/API ───────────────────────────────┼──> auth capability + workspace checks
Telegram explicit command ─────────────────────────────────────┘            │
                                                                             v
                                                                      AgentRuntime
                                                                        │  │  │
                        model endpoint <── ModelRouter <────────────────┘  │  └──> route telemetry
                                                                           ├──> tool policy / approvals
                                                                           ├──> bounded delegate_agent
                                                                           └──> MemoryEngine retrieval + attribution

Telegram opted-in passive message ──> MemoryEngine ──> proposed memory (no embedding)
admin activation ────────────────────────────────────> optional embedding index
Telegram voice ──> whisper.cpp ──────┘

reviewed manifests ──> workspace/external-data guard ──> tool policy / approvals
                              ├──> exact JSON origin + structural request
                              └──> pinned MCP stdio/HTTP peer + required tools

one-shot provider sidecar (fixed reads/pagination/rate limits)
   ──> ingest-only principal + normalized page
        ──> Corporate Oracle current heads + retained revisions + checkpoint
             ├──> current-content embedding (post-commit; lexical fallback)
             └──> read-only oracle_search / oracle_sources ──> AgentRuntime

confirmed tasks ──> deterministic planner ──> notification state ──> Telegram sender

Direct stateful CLI ──> runtime-owner lock ──> SQLite (service stopped)
All service projections/events ──> runtime-owner lock ─────────────> SQLite
feedback ──> memory/route updates + deterministic export candidates
                                            │
                                            └──> explicit row review + hashes
                                                   └──> offline MLX QLoRA lab
                                                        (manual execution; no promotion)
```

There are two intentionally different Telegram paths:

1. **Passive observation:** only after group-admin opt-in; deterministic redaction and salience; no LLM.
2. **Explicit assistance:** direct message, `/op`, `/openprojects_status`, mention, or reply; starts an ordinary routed agent run.

The setup wizard is kept outside the runtime authority path: it renders a deterministic plan and can publish a reviewed configuration plus a protected local control credential, but it never downloads a model, starts a daemon, requests provider secrets, or executes an agent. On POSIX its sealed/default plan emits an owner-only Unix socket plus one unscoped `local-admin`/`admin` principal; Windows keeps loopback TCP. Enabling Telegram in a hybrid plan removes `socketPath`, retains a loopback TCP listener, and emits an operator requirement for a reviewed TLS reverse proxy that exposes only the fixed webhook POST route. The wizard rejects Telegram plus an explicit Unix socket, and the service boundary independently rejects that combination for every configuration. The service is the sole production runtime/storage owner; the full-screen TUI attaches through the configured local transport using asynchronous run creation, workspace invalidations, and fresh snapshots. It does not consume the per-run replay stream. Its explicit `--standalone` mode is for development only. Other direct stateful CLI commands also own storage and therefore require the service to be stopped. The renderer sanitizes untrusted terminal content and falls back to finite plain text outside an interactive terminal. See [terminal-experience.md](./terminal-experience.md).

## Temporal Corporate Oracle foundation (Unreleased)

The Oracle is an evidence ledger for changing source facts, not a second agent,
workflow engine, vector database, or autonomous learning system. Provider
sidecars remain outside the resident service and own fixed provider reads,
polling, pagination, rate limiting, backoff, and normalization. Credential
authorization/refresh may be a separate operator or identity-broker concern.
The repository supplies the generic bounded ingestion/read path and isolated
Linear/Jira implementations, but no external tenant is live-qualified.

### Ingestion identity and transaction boundary

`POST /api/oracle/sync` requires a workspace-scoped control principal with the
new `ingest` capability. With auth configured, the principal ID is the
connector `source`; request data cannot impersonate another principal. Every
page also requires an immutable provider `sourceAccountId`, obtained from the
provider's authenticated tenant/account identity rather than display text. The
binding is persisted on records and checkpoints; attempting to reuse a source
and stream under a different account fails closed instead of merging tenants.

The page is normalized before persistence, bounded to 100 records and 2 MB,
and committed under one immediate SQLite transaction. That transaction:

1. inserts or advances cheap current heads;
2. appends a retained revision for every new source version;
3. rejects conflicting content at one `sourceUpdatedAt` and ignores older
   replays; and
4. compare-and-swaps and advances the `(workspace, source, sourceAccountId,
   stream)`-bound cursor,
   watermark, page digest, count, and success time.

Before every cursor-bearing page after the first, the sidecar reads its scoped
checkpoint and supplies its cursor as `previousCursor`. A new page commits only
when that predecessor equals the current checkpoint cursor, preventing delayed
or concurrent pagination from regressing state. An exact cursor/page-digest
replay is idempotent and retains the original `previousCursor`; changing either
the page or its predecessor is a conflict. Schema v11 records every newly
accepted page identity and seeds the prior latest checkpoint during migration.
Replaying an older accepted cursor is recognized without rewriting current
heads or regressing the latest checkpoint. The predecessor CAS protects a
migrated v10 checkpoint from older unrecorded pages. Cursorless webhook/event
pages remain digest-keyed and idempotent without `previousCursor`; they make no
ordered-pagination claim. The watermark is retained evidence, not a generic
interpretation of provider pagination; the sidecar owns those semantics.
Optional `sourceUrl` values must be absolute credential-free HTTP(S) paths;
queries and fragments are rejected to prevent secret-bearing or mutable URL
tails from entering evidence.

Embeddings are intentionally outside the source transaction. Changed active
heads are embedded afterward in batches, with vectors bound to the current
content digest and embedding identity. A replay also repairs an absent vector
or one stale for the selected model/content. An embedding failure leaves the
committed evidence/checkpoint intact and current search falls back lexically.
An admin-only control endpoint can backfill 1-100 missing/model/content-stale
active vectors per call, optionally by source. Neither sync nor backfill starts
an agent run or chat completion, but both may call the configured local or
explicitly approved cloud embedding adapter. Sync receipts distinguish
`agentRunInvoked`, `chatModelInvoked`, and `embeddingInvoked`; legacy
`modelInvoked: false` means no agent/chat completion.

### Current truth, temporal history, and deletion

`oracle_records` is the mutable current projection used for bounded current
search. `oracle_record_versions` is append-only during normal retention and
supports two explicit lexical time bounds. `asOf` filters provider state by
`sourceUpdatedAt`. `knownAt` filters by server-owned `observedAt`, which the
connector cannot supply, and therefore reconstructs what the harness had
recorded by that host time. Supplying both applies both bounds before choosing
the latest eligible revision. Historical versions do not reuse current
embeddings. A source tombstone is appended as a deleted
revision and removes that head from active search. Explicit admin erasure of a
source/stream deletes its heads, retained versions, vectors, accepted-page
ledger, and checkpoint, so
“append-only” is not a promise to defeat retention or deletion requirements.

Schema v11 maintains `unicode61` FTS5 indexes for current and historical title,
content, and record-type candidate selection. They reduce bounded candidate
materialization and preserve Unicode token handling; final ranking still uses
the existing scoped lexical/semantic/freshness scorer. They are local indexes,
not a learned semantic model or a separate vector service.

### Agent and control surfaces

The model receives exactly two Oracle tools:

- `oracle_search`, a bounded workspace/project-aware current hybrid or
  historical lexical search with optional provider `asOf` and harness
  `knownAt` bounds, returning `[oracle:<id>]` citations, source and observation
  freshness, revisions, and optional provider version/URL;
- `oracle_sources`, a workspace freshness/coverage inventory.

Both are read-only, return `actionTaken: false`, and label content
`untrusted-evidence` with no instruction authority. The prompt contract requires
the model to search before material cross-system claims, cite the record and
freshness, expose contradictions/stale or missing sources, and never claim an
external action from Oracle evidence. The generic supervisor does not yet
schema-validate citation presence in final prose.

A completed `oracle_search` durably taints the remainder of that session,
including later runs. A monotonic tool guard changes every later
external-boundary tool—including an external read—and every local effect beyond
`read` or `draft` to `ask`, so the ordinary canonical argument digest and exact
approval apply to each invocation. Approval does not clear the taint. Local
reads and drafts remain available; only a new session starts untainted.
`oracle_sources` alone does not taint the session. This
prevents an Oracle record from laundering an immediate action, but it does not
parse final prose or prove that the model included every requested citation.
Writes remain separately granted MCP/JSON/local tools under ordinary policy,
exact approval, durability, and unknown-outcome handling.

The control API separately exposes sync and own-checkpoint reads to `ingest`,
search/source/history reads to `read`, and bounded embedding backfill plus
explicit source erasure to `admin`.
An ingest-only sidecar cannot inspect Oracle contents, memory, runs, or
approvals. No agent/chat model is invoked while committing a sync page;
post-commit embeddings are a separate, explicitly reported model lane.

### Evidence versus reviewed memory

The two time-aware stores are complementary and intentionally non-conflated:

- corporate evidence changes only through authenticated source versions and is
  retrieved with provenance/freshness;
- durable organizational memory follows proposal, human activation, scoped
  retrieval, attribution, and exactly-once bounded reward; and
- route feedback influences future model selection but changes neither source
  facts nor model weights.

Oracle text can be used as evidence for a separately policy-checked memory
proposal, but it cannot activate itself as reviewed memory or modify prompts,
skills, policy, approvals, or tools. This is the current over-time learning
contract; there is no online RL or autonomous self-training.

The detailed normalized contract and provider-sidecar promotion gate are in
[integrations.md](./integrations.md#corporate-oracle-ingestion-plane).

## Durable agent foundation retained through v0.6

### `AgentRuntime`

The runtime remains the only product path that:

- creates sessions and runs;
- selects skills and retrieves active memories;
- drives model attempts and enforces step, tool, token, and active-time budgets;
- validates tool names and JSON against registered schemas;
- obtains a monotonic policy result before tool execution;
- creates and resolves one-shot approvals;
- flushes model-order tool results;
- emits the durable trajectory and terminal state;
- records run feedback and recovers eligible in-flight local work.

Run-state transitions and approval orchestration are not plugin callbacks. A model-proposed tool always enters through the same validation, policy, batch, and result path.

### `HarnessKernel`

The same-process plugin kernel owns reversible registrations for services, model adapters, tools, prompt sections, monotonic guards, execution middleware, result hooks, and listeners. A plugin setup failure unwinds its registrations; normal shutdown disposes plugins in reverse dependency order.

Policy combination is monotonic: any `deny` wins; otherwise any `ask` wins; only an all-allow/abstain path allows execution. Plugins are trusted Node.js code, not a sandbox. The model cannot install plugins or change policy.

### Runs, events, and ordering

The run-state union remains:

```text
queued | running | waiting_for_approval | succeeded | failed | cancelled
```

```text
queued -> running -> succeeded
             |
             +-> waiting_for_approval -> running
             +-> failed
             +-> cancelled
```

Events have strictly increasing sequence numbers per session, enforced by `UNIQUE(session_id, seq)`. Sequence, not wall-clock time, defines conversation order. Replay projects stored facts; it never re-executes old tools.

The stable event vocabulary includes run/turn/step boundaries, user and assistant messages, exact model request metadata, provider attempts, tool calls/results, approval requests/resolutions, tool telemetry, compaction, run transitions, feedback, and subagent events. Domain mutations add their own audit events. Only user messages, assistant messages, tool results, and deterministic compaction enter derived model history.

### Redacted execution-contract commitments

Every newly allocated run stores three `sha256:<hex>` bindings to canonical `openprojects.run-snapshot.v1` documents: `agent`, `tools`, and `policy`. Ordinary supervisor and subagent allocations capture their complete redacted effective contract. Direct storage-only bookkeeping/test allocations receive documents explicitly marked `capture: compatibility` and `complete: false`; pre-migration runs remain readable without bindings.

The agent document records identity, budgets, runtime profile, grants, and hashes of prompt/skill/validator text. The tool document records exact grants, static effects, idempotency, timeouts, and hashes of descriptions, schemas, and any transport binding. The policy document records the effect table, deny-ungranted posture, grants, and participating guard-plugin IDs. Bodies are intentionally not copied into these records. `run_snapshot_documents` stores each canonical document once; `runs` holds the three foreign-key addresses. Insert checks reject a digest that resolves to different canonical bytes, and ordinary recovery refuses a current contract whose three digests differ from the run.

The encoder is a strict deterministic JSON subset with recursive UTF-16 key ordering and fail-closed treatment of non-JSON/ambiguous structures. It is inspired by the content-addressing goal of [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785.html), but it is not advertised as full JCS conformance. The unsalted SHA-256 commitments are neither encryption nor signatures: likely source text can be guessed and compared, and the database remains sensitive. They also omit plugin code, dependency/runtime/build identity, model artifacts, and concrete transport code, so they are not a reconstructible or signed execution bundle. See [Evaluation and extension gates](./evaluation-extension-gates.md#redacted-content-addressed-run-commitments).

### Explicit run flow

1. Create/reuse a session and append a queued run.
2. Transition to `running`; append the turn and user message.
3. Retrieve scoped active memories, record which were used, select skills, and render ordered prompt sections.
4. Compact only at a safe completed-run boundary if the input budget is exceeded; raw events remain.
5. Send the request through the configured model adapter or router and record attempt, route, usage, latency, and estimated cost.
6. If the model returns text only, close the step and run.
7. If it returns tool calls, persist a batch in model order, validate each call, apply policy, and create any required approvals.
8. Pause durably while approvals remain pending. Approved calls execute with the stored invocation and stable idempotency key; denied calls get canonical errors.
9. Flush every batch result in original order and continue until terminal output or a budget/error stops the run.

Approval wait time is excluded from the active runtime budget. An approval is bound to the exact run, actor, invocation, arguments, effect, and decision; it is not a broad session permission.

## Task- and cost-aware model routing

`ModelRouter` implements the same `ModelAdapter` boundary as a single provider. Routes declare:

- provider/adapter, base URL, model, operator-managed generation, and optional API-key environment variable;
- supported task classes;
- local metadata, enabled state, estimated quality, and context window;
- input/output price estimates per million tokens.

The routing section separately declares the data boundary. External inference
is denied unless a reviewed profile sets `externalInference: allow`;
`preferLocal` defaults to true; and `allowRemoteFallback` defaults to false, so
a local failure cannot silently disclose the next request to a hosted route.
Remote generic routes must use HTTPS, declare `local: false`, resolve secrets
through `apiKeyEnv`, declare an immutable `generation`, and match any exact origin allowlist. Inline remote
credentials and locality claims that disagree with the URL are rejected.

Task classes are `supervisor`, `project_analysis`, `memory_curator`, `summarization`, and `notification`.

For each request the router:

1. estimates input size;
2. filters disabled routes and routes without the task, minimum quality, or context capacity;
3. estimates worst-case request cost from configured prices and output reservation;
4. excludes paid routes that do not fit the remaining estimated daily budget, including in-process reservations;
5. ranks local routes first by default, then scores quality, economy, empirical reliability, feedback reward, and latency;
6. optionally explores at a bounded configured rate without crossing the local/remote boundary;
7. attempts the ranked affordable routes, crossing from local to remote only when remote fallback is explicit and the failure is retryable, and records every success or failure.

Adaptive telemetry is stored under a SHA-256 identity derived from the route
ID, provider, model, normalized endpoint, local/external boundary, context,
task set, strict wire profile, and generation. Changing any of those inputs
starts a clean reliability/reward lane while the human-facing route ID remains
readable; operators must bump `generation` when a hosted alias changes behind
an otherwise identical endpoint and model name.

The budget is a local estimate, not an atomic provider billing limit. A provider may count tokens differently, and a crash/retry can duplicate provider cost. All non-mock routes use an OpenAI-compatible Chat Completions boundary implemented with bounded native HTTP; no vendor SDK is a core dependency. FreeToken, llama.cpp server, and other servers are integrations when they expose that boundary; OpenProjects does not grant them special authority. Provider `llama.cpp` selects a stricter adapter: exact loopback `/v1`, mandatory dedicated bearer key, safe pinned alias in every request and response, strict tool-call parsing, and `parallel_tool_calls: false`. Provider `freetoken` is also strict: exact loopback `/v1`, no unsupported API-key field, one safe `--served-model-name` alias, singleton qualification identity, exact response alias, strict tool parsing, and `parallel_tool_calls: false`.

In `core-4g-v1`, every runtime owned by one application shares a single
fail-fast admission permit. Waiting-for-approval runs release it; resumption
must reacquire it before the approval is durably changed. This bounds the
supervisor and project-analyst together and avoids an in-memory queue. The
service also caps active SSE clients globally (four in the core profile), while
each writer retains its existing frame/queue/drain bounds.

SQLite read methods enforce independent finite row ceilings. Runtime prompt
assembly uses only the complete post-compaction context and refuses to
materialize more than 512 events; inspection uses bounded newest tails or
cursor pages. The durable event log is not deleted by these read bounds.

Run feedback also updates aggregate route reward. Route reward is learned telemetry, not a policy permission and not a quality guarantee.

## Bounded specialist lanes

The allowlist is fixed in code:

| Agent | Task | Authority |
| --- | --- | --- |
| `project-analyst` | `project_analysis` | One project-scoped snapshot read, then strict grounded findings; cannot act |
| `memory-curator` | `memory_curator` | Text-only candidate facts; cannot activate memory |
| `notification-writer` | `notification` | Text-only draft; cannot send |

The supervisor can call the schema-validated `delegate_agent` tool. The coordinator enforces maximum calls per parent run, maximum global parallel calls, and maximum child depth. Each child gets a durable internal session/run and emits parent `subagent.started`/`subagent.completed` events. A child result is advisory untrusted evidence and grants no authorization.

`memory-curator` and `notification-writer` remain model-only: any tool call or empty output fails those children. `project-analyst` instead runs through `ProjectAnalystLane` v0.5.0 with no selected skills and no memory retrieval. Its only grant is `project_analysis_snapshot_v1`, a read/idempotent, no-argument tool. The host derives workspace and project scope from the durable run and returns a bounded, stable-ID snapshot; the model cannot provide or change that scope. The lane is capped at two steps, one tool call, 30 seconds, 4,096 input tokens, and 512 reserved output tokens.

Project-analyst completion requires exactly one successful snapshot call and one strict `openprojects.project-analysis-result.v1` JSON object. Its task/evidence references must be subsets of the returned snapshot, its `projectId` must equal the run scope, and `actionTaken` must be `false`. Unknown fields, prose, fenced JSON, invented IDs, another tool, a missing tool call, an approval, or a write fail closed. Agent-specific policy grants ensure the specialist does not inherit the supervisor catalog.

The separate `eval-project-analyst` command evaluates one strongly pinned local route whose only advertised task is `project_analysis`. It operates on an in-memory configuration copy, enables exactly the named candidate, sets exploration to zero, verifies text/tool protocol and snapshot identity first, and then requires every trial to use the exact route, make the one scoped read, return the strict result, and create neither approvals nor outbox records. Its report keeps `supervisor`, `semanticEmbeddings`, and `vision` explicitly `not_evaluated`; there is no automatic 1.7B-to-4B fallback or route promotion.

`eval-representative` adds a versioned eight-case host corpus for project risk, deadlines, group-memory review, approvals, prompt injection, and crash recovery. Its default lane removes live routing and external integrations and passed 8/8 with deterministic mock inference/in-memory state. Only explicit `--live` adds the three project-analyst-marked prompts through the existing route-isolated identity gate. The pinned 4B M3 lane passed 3/3 with one scoped read, strict results, and zero approvals/outbox records. The exact evidence, corpus SHA-256, and deterministic-versus-live limits are in [Evaluation and extension gates](./evaluation-extension-gates.md#representative-evaluation-corpus).

The delegation tool is classified as read/retryable for harness policy, but its provider request is not exactly-once. A process crash can repeat inference and cost. Subagents do not form an autonomous organization and cannot create arbitrary descendants.

The older deterministic `eval` command is intentionally different: it removes the loaded routing table before installing the in-memory mock adapter. This prevents a supposedly deterministic regression run from falling through to any configured live provider.

## Opt-in Telegram group learning

### Operational opt-in and visibility

An opted-in group has a durable `group_spaces` binding with workspace, optional project, learning flag, notification flag, provenance, and timestamps.

- `/openprojects_enable [project-id]` verifies the caller with Telegram `getChatMember`, enables observation and reminders, and posts a visible description.
- `/openprojects_disable` requires the same admin check and stops new observation/reminders.
- `/openprojects_privacy` reports the retention and inference boundary.
- Disabling collection does not delete historical records. The operator can call `DELETE /api/groups/:id/data` to remove observations, their derived memories, and non-sending notifications while retaining a disabled binding, or run retention purge. Sanitized inbound-event metadata and some learning/aggregate provenance can remain; v0.6 has no complete participant-erasure workflow.
- Telegram BotFather privacy mode must be disabled if the bot is expected to receive ordinary group messages. That transport setting does not bypass OpenProjects' per-group opt-in check.

Observation requires all three gates: global `learning.enabled`, global `learning.groupObservation`, and the persisted per-group `learning_enabled` flag. If either global flag is false, `/openprojects_enable` refuses to opt a group in and no passive observation occurs. The per-group binding is an operational observation opt-in; it is neither participant consent nor authorization for model training. `learning.enabled` also gates feedback reinforcement.

### Observation flow

For each ordinary message in an enabled group:

1. The webhook update is deduplicated by Telegram update ID and stores only sanitized ingress metadata.
2. The text or local transcript is heuristically redacted for obvious private keys, bearer/API tokens, credential assignments, and Telegram bot tokens.
3. A deterministic bilingual salience classifier rejects short acknowledgements, commands, and instruction-injection-like text, then scores decisions, commitments, deadlines, progress, preferences, and procedures. Non-salient content exits before any group-message or learning-signal row is written.
4. For salient content, the redacted group-message row stores source message ID, actor, transcript flag, and a salient flag; its learning-signal metadata stores the score, reasons, redaction count, memory ID, and provenance.
5. The inferred memory is stored as `proposed` with `group_observation` provenance. Procedures are also proposed; none are auto-active.
6. Embedding is attempted. An embedding outage does not discard the observation or memory.

Passive observation ends here and never calls a model.

### Confirmation

Only `active` memories participate in retrieval.

- A sufficiently salient non-admin `/remember <fact>` produces a proposed candidate and tells the group it awaits an administrator.
- A sufficiently salient administrator `/remember <fact>` activates that particular candidate after Telegram admin verification.
- Other inferred candidates can be activated or archived through `POST /api/memories/:id/status` by the trusted local operator.

With `server.auth` enabled, the local status API requires an `admin` principal authorized for the memory's workspace; legacy configs without auth remain a development-only boundary. “Admin confirmation” is a Telegram authorization check for the Telegram command or an authorized local action at that API—not a cryptographically signed field on the memory row.

## Hybrid retrieval and durable reinforcement

### Embeddings

The `EmbeddingAdapter` boundary supports:

- `builtin-hash-v1`: 256-dimensional default, deterministic, in-process and offline feature hashing; useful for the 4 GiB core and lexical-like similarity, not a learned semantic encoder;
- `ollama`: optional higher-memory batched `POST /api/embed` adapter with timeout, bounded response size, exact batch/dimension/model checks, finite nonzero unit-vector validation, and optional digest verification against the local tag inventory;
- `openai-compatible`: optional `POST /embeddings` adapter with bounded input and response sizes, strict count/index/model/dimension validation, local normalization, a hashed endpoint identity plus operator-managed immutable generation, HTTPS-only remote transport, environment-only credentials, and an independent `externalData: allow` gate.

Embedding selection is independent of the chat route. Local or hosted chat can
use built-in, local, or hosted embeddings while retaining the same scoped
memory rows, activation review, attribution, and feedback ledger. An external
embedding call sends the retrieval query—and text included in an explicit
backfill—outside the host; chat-route permission does not authorize that
separate disclosure.

Memory vectors are normalized and stored with adapter/model identity and dimensions. Backfill is explicit through `learning embed`. Models are not selected by reputation alone: the sealed M3 pilot's exact Qwen3-Embedding 0.6B Q8_0 artifact failed the unchanged minimum semantic-margin gate, while digest-pinned BGE-M3 F16 passed the bounded 1,024-dimension appliance gate, a 50-batch reliability soak, manual multilingual `MemoryEngine` thresholds, and the formal versioned semantic evaluator. That exact BGE artifact is qualified for the semantic embedding lane. Qualification does not change the configured default or re-embed stored memories; both require explicit operator action.

`eval-semantic-embeddings` binds an Ollama candidate to an exact runtime digest and strong manifest pin, repeats the fixed 10-document/12-query EN/RU/AZ corpus for 2–10 batches, and gates Recall@1, Recall@3, MRR, repeated-input consistency, cross-batch drift, errors, dimensions, and identity. Its report records config/manifest hashes plus a non-mutating posture: no persistent harness-state write, download, promotion, route mutation, or text-model request.

### Search

Search first embeds the query when possible and retrieves active, in-scope memory records. The hybrid score combines semantic similarity, lexical overlap, memory strength, and learned reward, then caps results by count and total context characters. If query embedding fails, semantic weight drops out and lexical retrieval continues.

Retrieved memories are rendered as untrusted evidence with no instruction authority. Workspace/project/actor scope remains enforced by storage queries.

### Attribution and feedback

Every retrieved memory actually supplied to a run is written to `run_memory_usage`. When run feedback arrives, the memory engine:

1. maps the feedback to a bounded reward;
2. identifies only memories attributed to that run;
3. inserts `(feedback_id, memory_id)` into `memory_feedback_applications`;
4. updates strength and reward with bounded learning-rate behavior only for newly inserted pairs.

This makes **memory reinforcement idempotent by feedback ID**. It does not rewrite memory content, approve proposed memories, change tool policy, or update model weights. Route statistics have a separate aggregate feedback update path and should not be described as feedback-ID idempotent.

## Deterministic notifications

Notification content and eligibility come from confirmed local task rows, not an LLM. The planner creates upcoming-deadline and blocked-task notices only for group bindings with notifications enabled.

The idempotency key contains group, task, kind, due date, and day bucket, yielding at most one row per notice category per day. The state flow is:

```text
planned -> sending -> sent
                  +-> failed

stranded sending on restart -> unknown_outcome
```

Rows are claimed immediately before Telegram send. A restart moves stranded `sending` rows to `unknown_outcome` and never retries them, avoiding a duplicate at the cost of possible non-delivery. Known `failed` rows are also not retried automatically.

The server scheduler starts only when Telegram delivery is configured and notifications are enabled. It runs an initial pass and then the configured interval/lookahead. The CLI `notify` command only plans; it never sends. `POST /api/notifications/tick` executes a delivery tick and can send. Routine server close first disables future scheduler ticks and gives the active tick/delivery a fixed settlement budget, then closes the Telegram adapter. A sender that exceeds the budget is durably moved to `unknown_outcome`, barred from late storage writes, and aborted; shutdown does not wait indefinitely or classify the ambiguity as an ordinary send failure.

There are no quiet hours, time-zone calendars, per-person subscriptions, escalation chains, or model-written delivery decisions in v0.6.

## Local voice transcription

The optional `WhisperCppTranscriber` is disabled by default. When enabled it:

- accepts only configured audio MIME types and enforces Telegram metadata size/duration limits;
- downloads through the Telegram API;
- writes into a unique temporary directory;
- invokes FFmpeg and `whisper-cli` with fixed arguments and `shell: false`;
- enforces timeouts, cancellation, and bounded child output;
- terminates child processes and removes the temporary directory in `finally`.

Raw downloaded/converted audio is transient. A resulting transcript can be retained as an opted-in group observation and follows normal redaction/retention rules. `whisper.cpp`, a local model file, and FFmpeg are external operator-installed dependencies. `faster-whisper` is researched but not implemented.

## JSONL export and mandatory manual-review boundary

The learning exporter reads stored run/feedback facts in deterministic order, redacts obvious secrets, constrains/redacts untrusted dimension keys, serializes stable JSONL, and calculates SHA-256 for every dataset plus a manifest digest. Preference rows require a strictly negative score, not a neutral zero.

| Dataset | Export-candidate predicate |
| --- | --- |
| `rewards` | Feedback and a recorded run output |
| `sft` | A non-empty human correction |
| `preferences` | Original output, distinct correction, and negative score |

The exporter can include comments unless explicitly disabled. It never trains, uploads, or deploys anything.

“Reviewed boundary” is an operator obligation: the current feedback schema has no separate consent/reviewer/approved-for-training field. Output rows are candidates. Before the optional training lab can consume them, a human must validate authorization, participants' expectations, private data, provenance, poisoning, licenses, duplicates, and train/eval leakage, then create a `model_training` review attestation that binds the export and explicit allowed row IDs.

The isolated `training/` lab has no SQLite/runtime import and accepts only an on-disk export bundle. It revalidates the canonical export manifest, row schema/order/bounds, per-file SHA-256, review digest bindings, all five review attestations, and an explicit approved-ID list; all security-sensitive JSON rejects duplicate keys. It keeps connected source-run/normalized-prompt components together, materializes a write-once-or-verify MLX training file, stores the sealed holdout outside MLX's data directory, and records content-addressed prepared/run manifests. These are workflow guards, not operating-system immutability. Planning is the default. Execution needs a snapshot matching the reviewed ten-file model lock, exact pinned MLX runtime versions, `mlx.enabled: true`, and `--execute`; it reproduces MLX completion formatting with the exact tokenizer/chat template, rejects truncating or undersupervised rows, and invokes the current interpreter as `python -I -m mlx_lm lora` using an argv array, trusted working directory, restricted offline environment, and no shell. Symlink components are rejected, and runtime/model/training identities are checked before and after the subprocess. Existing adapter directories are refused because MLX's weights-only warm start is not durable optimizer-state resume.

The example uses official `Qwen/Qwen3-1.7B-MLX-4bit` QLoRA settings sized conservatively for an M3/8 GB host. This is an experimental read-only-specialist lane, not a stability or quality claim. A zero-exit process produces only a `candidate_unverified` record after a bounded Safetensors parser proves exact tensor coverage and finite FP16/BF16/FP32/FP64 values and the adapter config matches the reviewed run. The lab does not read Telegram/SQLite directly, infer consent, perform DPO/RL, inspect the sealed holdout automatically, upload/fuse/serve weights, edit model routes, or promote an adapter. Static SHA-256 records prove content identity, not reviewer identity, upstream authenticity, generation quality, or an artifact signature; pre/post checks are also not protection against hostile same-privilege swap-and-restore. Full data and qualification gates are in [training-safety.md](./training-safety.md).

FreeToken remains an inference server and does not consume the export as a training pipeline.

## Data model

SQLite runs in WAL mode with foreign keys. Before WAL is enabled, startup applies
the expected contiguous migrations in one `BEGIN IMMEDIATE` transaction, records
each immutable version/name in `schema_migrations`, and advances the matching
`PRAGMA user_version`. A future version, missing ledger, gap/name mismatch, or
incomplete current schema fails closed and rolls the whole pending sequence back.
This is an in-process bounded startup step, not another resident service. The
current tables are:

| Table | Purpose |
| --- | --- |
| `schema_migrations` | Contiguous applied schema version/name/timestamp ledger, cross-checked with `PRAGMA user_version` |
| `sessions` | Conversation/channel identity; external-session deduplication |
| `runs` | Invocation status, scope, input/output/error, budgets, metadata |
| `run_snapshot_documents` | Deduplicated canonical redacted agent/tool/policy commitments, addressed by SHA-256 and bound to runs |
| `events` | Append-only run/session trajectory with session sequence |
| `tool_batches` | One model step's ordered call group |
| `tool_invocations` | Arguments, trusted effect, policy, idempotency, state, result |
| `approvals` | One pending/resolved decision per invocation |
| `memories` | Scoped semantic/episodic/procedural content, provenance, status, strength/reward |
| `memory_embeddings` | Model/version/dimension/vector for a memory |
| `run_memory_usage` | Run-to-memory retrieval attribution |
| `memory_feedback_applications` | Feedback-ID/memory-ID idempotency ledger |
| `learning_signals` | Durable learning signal records |
| `oracle_records` | Mutable active/deleted corporate source heads with immutable source/account identity, timestamps, content digest, and revision |
| `oracle_record_versions` | Append-only retained corporate revisions during normal source synchronization |
| `oracle_record_embeddings` | Current-head vectors bound to embedding identity and exact content digest |
| `oracle_sync_state` | Account-bound per-workspace/source/stream cursor, watermark, page digest, count, and last-success checkpoint |
| `oracle_sync_pages` | Accepted-page identities used to recognize historical cursor replays without regressing the latest checkpoint |
| `oracle_records_fts`, `oracle_record_versions_fts` | Trigger-maintained Unicode FTS5 candidate indexes for current and historical lexical search |
| `group_spaces` | Per-group operational observation opt-in, project, notification, and creator state |
| `group_messages` | Redacted salient observations, source and retention data; non-salient content is not retained here |
| `model_route_stats` | Aggregate attempts, success, latency, cost, and reward per route/task |
| `model_route_calls` | Per-run route attempt telemetry |
| `projects`, `tasks`, `evidence` | Project-operations domain state |
| `feedback` | Append-only reaction, score, dimensions, comment, correction |
| `inbound_events` | Workspace/source/key deduplication and attached run; control-API sources are principal-namespaced |
| `outbox` | Stable local representation of follow-up output |
| `notifications` | Planned/claimed/delivered/ambiguous reminder state |

Run projections and state-machine rows are mutable. Events and feedback are append-only. The log reconstructs agent-observed facts, not arbitrary external reality.

Before SQLite opens, every durable runtime exclusively creates and holds an adjacent owner lock. POSIX enforces mode `0600`; Windows retains exclusive creation and file/link identity checks but requires an independently reviewed NTFS ACL because Node mode bits cannot attest owner-only access. Startup refuses an existing regular file, symbolic link, or special file and never auto-breaks a presumed stale lock. Shutdown closes storage before releasing it, and an unclean-exit lock requires the manual proof-and-recovery procedure in [private-deployment.md](./private-deployment.md#runtime-owner-lock-and-manual-recovery). `:memory:` databases intentionally skip this guard.

## Tool policy, crash recovery, and external effects

Every trusted tool declares one static effect:

```text
read | draft | memory_write | internal_write | external_write | destructive
```

The sample policy allows read/draft/memory writes, asks for internal/external writes, and denies destructive tools. Unknown tools and invalid schema input never enter a tool body.

Tools also declare retry behavior: `read`, `keyed`, or `none`. Recovery reads one
agent lane at a time through indexed, bounded keyset pages. The opaque cursor
contains only a signed-int64 SQLite row locator and a SHA-256 binding to the exact
agent/version request; even malformed oversized text sort keys remain in SQLite.
Actionable rows for the active agent version come first, while unchanged pending
approval waits are filtered before materialization. Other versions remain visible
so they can be failed explicitly instead of starving current work. Each row is isolated: version
mismatch, invalid/changed run commitments, or a malformed run record is moved to
terminal failure with `run.recovery.failed`, and pending/running invocations are
settled without entering a tool body. A malformed row's original metadata and
snapshot bindings are preserved for inspection. Independent healthy rows and
agent lanes continue. A database/query failure that prevents safe row isolation
still fails startup.

If an invocation was already durable as `running` when recovery began, quarantine
does not claim that its prior external effect failed. The recovery event and run
failure record the count and `externalOutcomeUnknown: true`; the invocation gets
`RUN_RECOVERY_UNKNOWN_OUTCOME` and an explicit verify-before-retry warning.

Compatible recovery retries eligible read/keyed local work with the same
invocation key, keeps unresolved approvals paused, and fails ambiguous
non-idempotent executions. The kernel passes a timeout-linked `AbortSignal` into
the tool. A cooperative tool cancels on timeout; if a non-cooperative tool is
still unsettled after bounded grace, the runtime records
`TOOL_EXECUTION_AMBIGUOUS`, emits an audit event, and stops the run with a
verify-before-retry warning. A batch's ordered results and flushed state commit
together.

This is not a universal exactly-once guarantee. Remote provider inference can be repeated after a crash. Telegram notifications and non-idempotent integration writes use conservative unknown-outcome handling. Any payment, email, ticketing, chat, or other non-idempotent connector needs a provider idempotency/status-check contract or explicit reconciliation flow.

### Reviewed integration boundary

Each explicit manifest is loaded as two ordinary plugins: a monotonic workspace/external-data guard and a tool gateway. The gateway registers the exact local allowlist; local names, remote operation names, strict object schemas, effects, data boundaries, idempotency, timeout, request/response/text limits, and snapshot binding are operator-owned. Calls retain agent grants, effect policy, exact approval, cancellation/ambiguity handling, output-schema validation, and run commitments. The manifest's exact file SHA-256 is committed in both tool and policy identity. Credential environment names can be committed, but values never are.

MCP transports are lifecycle-owned direct stdio or exact Streamable HTTP clients. Stdio uses an absolute executable/cwd, literal argv, `shell: false`, an explicit minimal environment, bounded protocol/stderr buffers, pending-call caps, and deadline-bounded shutdown. HTTP uses an exact loopback-or-HTTPS endpoint, static environment-backed Bearer authentication, the common origin policy, redirect refusal, and bounded streamed bodies. Startup initialization and paged `tools/list` verify the exact configured server name/version and required tool names; remote schemas/annotations are ignored and no other discovered tool is registered. Calls accept only bounded text blocks plus required object `structuredContent`; text and standard result `_meta` are discarded after the complete response is bounded, and only the locally validated object crosses the gateway. There is no MCP keyed-idempotency claim, OAuth flow, resources, prompts, tasks, sampling, elicitation, or automatic registry installation.

The declarative JSON transport has one exact origin and environment-backed authentication. Each tool fixes its HTTP method, whole-segment path template, structural path/query/body sources, non-secret headers, success statuses, output projection, and retry semantics. Redirects, ambient credentials/cookies, generic URLs, arbitrary headers, OpenAPI import, and model-authored GraphQL/JQL are absent. Streaming bytes are bounded before JSON parsing. Object responses are projected to locally declared top-level fields; arrays receive the deterministic `{data: [...]}` envelope; scalar JSON is rejected; the normal kernel validates the complete local output schema.

Offline preparation compiles inert contracts without reading credentials, spawning children, or opening network connections. `integrations check --probe` explicitly resolves credentials and starts/verifies live peers, but it does not execute a business tool or replace representative evaluation. The complete operational and provider-compatibility contract is in [integrations.md](./integrations.md).

## HTTP and operator boundary

The native server exposes dashboard assets, JSON API, SSE events, external-event ingress, and the Telegram webhook described in [the README](../README.md#http-api). `server.socketPath` takes precedence over `host`/`port`: on POSIX the sealed profile calls Node's pathname listener and opens no TCP socket. TCP compatibility mode accepts loopback binds only. Both modes apply body limits and defensive headers. Telegram ingress is the fixed `POST /webhooks/telegram` route and authenticates only with `X-Telegram-Bot-Api-Secret-Token`; no secret appears in the URL, and update IDs deduplicate ingress. A Telegram-enabled deployment requires a reviewed TLS reverse proxy to the loopback listener that forwards exactly this method/path and nothing else—especially not `/api/*`, `/health`, or static/dashboard routes. Server startup rejects enabled Telegram with `server.socketPath` in every configuration because there is no separate webhook listener. `GET /api/meta` returns a public agent descriptor with `agent.system` and every subagent `system` removed (and skill metadata without instruction bodies), rather than exposing private prompts. Node's documented server/listener API is the transport primitive ([Node Net documentation](https://nodejs.org/api/net.html)); the TUI uses native HTTP `socketPath` requests ([Node HTTP documentation](https://nodejs.org/download/release/latest-v24.x/docs/api/http.html)).

Authenticated `GET /api/runs/:id` returns the run outcome plus the three verified redacted `snapshotDocuments` when bindings exist. This is an inspection surface for the commitments above, not a prompt-body, plugin-code, or model-artifact disclosure/reconstruction API.

Unix path validation is fail-closed: the path must be normalized and absolute, short enough for the supported pathname limit, and located in a real mode-`0700` directory owned by the effective service user. Any existing leaf—socket, file, or link—is refused. After listening, OpenProjects changes the socket to mode `0600`, verifies owner/type/mode, and records its device/inode. Graceful close removes only that exact inode; a replacement is never unlinked. A crash can leave the pathname, as Node's Unix-socket documentation notes, so recovery requires an operator to prove the service is stopped and explicitly remove only the inspected stale socket. Filesystem ownership controls which local OS identities can connect; the implementation does not claim application-level peer-credential verification or cryptographic server identity.

Startup acquires runtime ownership before opening SQLite. The selected listener can bind while durable recovery runs, but every request receives `503` until recovery completes; only then does the service become ready and start an eligible notification scheduler. Record-local recovery failures are durably quarantined and do not hold independent work or readiness hostage. A system-level migration, database, or recovery-query failure closes the listener and performs inode-guarded Unix-socket cleanup, and CLI startup cleanup closes SQLite before releasing runtime ownership.

`server.auth` has two schema-compatible forms:

```yaml
# Legacy: normalized to all capabilities and all workspaces.
auth: {operatorId: local-operator, tokenFile: /path/operator.token}

# Least privilege: independent token material for every principal.
auth:
  principals:
    - id: atlas-reader
      tokenFile: /path/atlas-reader.token
      capabilities: [read]
      workspaces: [atlas]
    - id: local-admin
      tokenFile: /path/admin.token
      capabilities: [admin]
```

Every `/api/*` endpoint and SSE stream requires one exact protected Bearer credential once auth is configured. Token loading rejects links and file-identity changes and retains only digests; POSIX additionally enforces owner-only mode, while Windows depends on an operator-reviewed NTFS ACL that Node cannot attest. Principal IDs, token paths, and token values must be independent. `admin` implies `read`, `run`, `ingest`, and `approve`; an omitted `workspaces` field means all workspaces, while a present list must be non-empty. This implements role/capability-based authorization and least-privilege scoping as those terms are defined in [NIST's RBAC glossary](https://csrc.nist.gov/glossary/term/role_based_access_control) and [NIST SP 800-171r3](https://nvlpubs.nist.gov/nistpubs/SpecialPublications/800-171r3/NIST.SP.800-171r3.html).

The route map enforces:

| Grant | Authority |
| --- | --- |
| `read` | Ordinary GETs, TUI snapshots, approvals inspection, and workspace/run SSE |
| `run` | Synchronous/asynchronous run creation, run feedback, and inbound events |
| `ingest` | Corporate Oracle sync plus that authenticated source principal's own account-bound stream checkpoint; no Oracle search or run authority |
| `approve` | Participates in exact approval resolution, which also requires `read` |
| `admin` | All grants plus memory/group/source-data mutation, purge, exports, and notification tick |

Workspace checks use the requested object or derive the workspace from a run, approval, group, or other stored record before acting. A global learning export, legacy feedback export, scheduler tick, retention purge without `workspaceId`, or bind/rebind of a provider-global `(source, externalId)` group identity additionally requires an admin whose `workspaces` is omitted. Existing external group identities cannot migrate across workspaces; subsequent list/delete remains scoped. Approval lists are filtered to the authenticated scope. Both synchronous and asynchronous exact approval resolution require `read` plus `approve` before loading/returning the run context; `admin` implies both. Mutation actor IDs are replaced with the authenticated principal. Legacy configs without `server.auth` retain an unauthenticated development path; it is not the private profile.

Control-API event ingress has a separate authority boundary. The request's `source` label is validated as data, base64url-encoded, and stored as `control-api/<encoded-principal>/<encoded-source>` (or the legacy-loopback principal namespace for unauthenticated development). A caller therefore cannot write into the verified `telegram` adapter namespace or collide with another control principal. Durable deduplication is `(workspaceId, namespacedSource, dedupeKey)`; the compatibility migration preserves old rows while adding the workspace boundary. If `projectId` is present, the runtime proves that project belongs to the requested workspace **before** inserting the dedupe row, so an invalid-scope attempt does not consume the key. The HTTP result is a minimal receipt containing `duplicate` and, when attached, `runId` plus relative status/event links. It deliberately omits `RunOutcome`, output, approvals, and trace events.

These principals are service credentials, not human identities. A token shared by two people cannot distinguish them, and anyone able to run the CLI as the service UID and read its configuration/token paths can choose any configured principal. A corporate deployment that needs individual accountability must pin the permitted principal and config path in its audited sudo/wrapper policy, or add a real identity broker; `--principal` alone is not that binding. The system has no SSO/directory binding, per-human proof, token expiry, or online rotation/revocation; token replacement is a coordinated protected-file change and service restart. The TUI refuses to guess among multiple principals and disables unsupported run/approval actions, but server enforcement is authoritative. TCP loopback does not authenticate the server/port holder to the client. Static assets and `/health` require no Bearer token on either transport; the private Unix socket is still protected by filesystem permissions and is not directly addressable by ordinary browsers.

`GET /api/events/stream` remains a live workspace-invalidation stream; clients refresh `GET /api/tui/snapshot` after connection, invalidation, or reconnect. It deliberately does not carry arbitrary durable event content or a replay cursor.

`GET /api/runs/:id/events/stream` is a durable resumable stream. Each durable frame carries `id: <event.seq>`. A non-negative `afterSeq` query or `Last-Event-ID` header resumes strictly after that sequence; if both are sent they must match, and future/malformed cursors are rejected before streaming. This adopts the standard SSE reconnect cursor ([WHATWG Server-Sent Events](https://html.spec.whatwg.org/dev/server-sent-events.html)). The server subscribes to live runtime events before capturing a replay fence, reads durable events in 128-row pages through the fence, buffers live events during replay, deduplicates by sequence, emits a compact `run.snapshot` containing run/approval state plus cursor, then hands off to live delivery. The client reconnects from its last validated sequence until terminal status, including after classified transient Unix transport reset, timeout, unavailable, or socket failures; malformed protocol, authentication/authorization, consumer-callback exceptions, and other non-retryable errors stop. Cursor and terminal state advance only after the consumer callback returns successfully, so failed delivery is never acknowledged internally. Missing or mismatched durable event IDs are protocol failures.

All SSE frames pass through a serialized bounded writer. It caps a frame, queued bytes, replay-race live-event count/bytes, and the time spent waiting for `drain`; a client exceeding a bound is disconnected. This follows Node's requirement to stop writing after `write()` returns false until `drain` ([Node stream backpressure documentation](https://nodejs.org/download/release/v24.1.0/docs/api/stream.html)). These bounds protect process memory; they do not promise delivery to an indefinitely slow or disconnected consumer, which must resume from durable sequence state.

## Security and privacy invariants

| Boundary | Treatment |
| --- | --- |
| Runtime, storage code, boot configuration | Trusted computing base |
| Local plugins and skill files | Trusted operator input with host-process authority |
| User/Telegram text, memories, project evidence, corporate source records, child-agent text, model output | Untrusted content |
| Provider sidecar | Separately trusted only to authenticate one reviewed source/account and normalize bounded records; its payload has no instruction or action authority |
| Configured model/embedding endpoint | External processor unless truly local and controlled |
| Local control API/SSE | Protected by independent credential capabilities/workspace scopes and, in the private profile, an owner-only Unix socket; unauthenticated legacy configs are development-only |
| Dashboard assets and `/health` | Unauthenticated on either transport; filesystem permissions gate the private Unix socket, and these endpoints are not its administration surface |

Implemented controls include bounded model/tool/subagent loops, AJV tool validation, static effects, monotonic policy, exact approvals, stable local idempotency keys, timeout-linked cooperative cancellation with fail-closed ambiguous execution handling, single-runtime database ownership, opt-in group bindings, passive no-LLM observation, heuristic secret redaction, retrieval provenance, webhook verification, local audio limits/cleanup, and no arbitrary shell/browser/fetch/package-install tool exposed to the model.

Heuristic redaction cannot guarantee secret removal. SQLite is not encrypted by OpenProjects. Local child processes and endpoints have the permissions/network of their host environment. See [SECURITY.md](../SECURITY.md).

## Explicit v0.6 non-goals and future hardening

Not implemented in v0.6:

- online RL, DPO/GRPO, unattended or runtime-triggered SFT/LoRA, automated evaluation-to-deployment, or live checkpoint promotion;
- automatic activation of inferred group memories;
- autonomous or unbounded multi-agent delegation;
- arbitrary execution, unrestricted browsing/fetch, remote MCP installation, or plugin marketplace;
- automatic background memory retention purge;
- public/multi-tenant hosting or encrypted local storage;
- outbound network enforcement based on a route's `local` flag;
- exactly-once external effects without provider cooperation;
- independent validation of vendor model/quantization claims;
- live-qualified task sidecars or implemented CRM/ERP/email/messenger sidecars,
  generic final-prose citation validation, autonomous source-to-memory
  activation, or a 4 GiB Oracle workload claim.

Hardening priorities are real-tenant Linear/Jira qualification, a representative
multi-source Oracle evaluation, and Slack/email/HubSpot sidecars; corporate
per-user identity/SSO bound to local
grants, credential expiry/rotation/revocation, and guidance for any future
networked TLS/CSRF boundary; per-event envelope version gates; signed
build/plugin/model/connector provenance beyond the current redacted run
commitments; argument-sensitive effect escalation; skill provenance/signing; a
durable training-consent/review/revocation ledger and scoped export v2;
near-duplicate contamination reports; a real base-versus-candidate promotion
runner; automatic retention jobs and group-visible delete workflows;
OS/process-wide egress enforcement beyond harness-owned exact-origin checks;
external-effect reconciliation; and repeated live-model safety/quality/cost
evaluation before route promotion.

There is deliberately no Restate or Temporal migration. A prototype is gated on a named SLO plus repeatable load/restart evidence that attributes at least three consecutive misses to the SQLite single-writer/owner or single-host recovery after ordinary tuning—not to inference, tools, or external services. It must also correspond to a real multi-host coordination/failover requirement and justify the added service/identity/backup/upgrade surface. Any spike remains outside production authority until it preserves the eight deterministic gates, exact approvals/policy/snapshots/recovery semantics, and demonstrates measured SLO improvement. The full evidence contract and primary [Restate](https://docs.restate.dev/references/architecture)/[Temporal](https://docs.temporal.io/) research links are in [Evaluation and extension gates](./evaluation-extension-gates.md#workflow-engine-migration-gate).

## v0.6 acceptance invariants

1. Group message content is not persisted as an observation unless both global learning gates and its group binding are enabled **and** the deterministic assessment is salient; sanitized webhook metadata can still be retained for ingress deduplication.
2. Passive observation never calls the model adapter.
3. Every inferred group memory starts proposed; only active memories are retrieved.
4. Proposed memory is not embedded; an activation-time embedding failure preserves the active memory and search falls back lexically.
5. A feedback ID changes each attributed memory at most once and never rewrites its content or status.
6. Model routing never selects an unsupported task/context/quality route or an estimated paid call beyond the configured remaining daily budget.
7. A specialist cannot exceed call/concurrency/depth limits and its result grants no authority; only `project-analyst` receives a tool, and that grant is exactly one host-scoped no-argument read.
8. Notification planning is deterministic; a stranded send becomes `unknown_outcome` and is not retried automatically.
9. Audio conversion/transcription uses fixed no-shell arguments, enforced limits, and temporary cleanup.
10. Export ordering and SHA-256 manifests are stable for identical stored facts; preference candidates require the original output, a distinct correction, and a negative score, but DPO qualification still requires an explicit reviewed same-prompt judgment under a rubric.
11. The complete tool-call envelope and strict JSON structure are validated before batch allocation or any member reaches policy, approval, persistence, or execution; unknown tools and schema-invalid arguments never enter a tool body, and batch results return in model order.
12. Restart retries only eligible read/keyed local invocations with their original idempotency key.
13. Raw events remain after context compaction and feedback/telemetry do not become conversation messages.
14. The deterministic no-key evaluation removes configured routing before using the mock adapter and remains available regardless of optional Telegram, Ollama, FreeToken, or Whisper setup.
15. The local training lab refuses an unreviewed, digest-mismatched, undersized, or single-run-group dataset; a dry run never starts MLX, and a completed adapter is never registered or promoted automatically.
16. One durable runtime owns a database at a time; an existing or unexpected owner-lock path fails closed and presumed stale locks require manual recovery.
17. A tool that ignores timeout cancellation cannot be reported as an ordinary timeout: after bounded grace its execution is recorded as ambiguous and the run stops for operator verification.
18. The POSIX sealed profile creates no TCP control listener; its Unix socket parent is owner-only mode `0700`, the live socket is `0600`, and an existing leaf is never automatically removed as “stale.”
19. Every authenticated API/SSE request is checked for its required capability and exact/derived workspace; exact approval resolution requires both `read` and `approve`, global export/tick/global-purge operations require an unscoped admin, and the legacy token shape maps to admin/all-workspaces for compatibility.
20. Durable run SSE resumes strictly after a validated sequence, pages replay through a post-subscription fence, deduplicates live/replay races, acknowledges cursor/terminal progress only after successful consumer delivery, treats callback exceptions as non-retryable, and disconnects rather than exceeding the configured frame, queue, or drain bounds.
21. Control-API event labels cannot claim a verified adapter namespace or collide across principals; project scope is validated before dedupe insertion, and the API returns a minimal receipt rather than a run outcome.
22. `/api/meta` excludes `agent.system` and every subagent `system`, and routine shutdown gives an active deadline delivery a fixed settlement budget before either completing it or durably marking it `unknown_outcome` and closing Telegram.
23. Every newly allocated run has all three content-addressed agent/tool/policy bindings; ordinary recovery verifies the stored documents and refuses a changed effective contract, while compatibility captures state explicitly that completeness is unknown.
24. The representative offline corpus covers every declared category and cannot contact a configured model; its live model lane is inert without explicit candidate identity inputs and never promotes that candidate.
25. An integration call cannot acquire effect, data boundary, idempotency, schema, grant, or approval authority from a remote peer; only the fixed local manifest declaration enters the existing kernel path.
26. Offline integration validation cannot read credential values, spawn an MCP child, or contact a peer; explicit probing still does not execute a business tool.
27. No workflow-engine dependency enters production on popularity alone; a spike requires the documented measured SQLite/single-owner trigger and invariant-parity exit gate.
28. Every executable tool invocation stores one canonical argument object and its `sha256:` identity; policy, approval display, submitted operator decision, restart recovery, and execution consume those same verified bytes. Legacy unbound approvals are reject-only.
29. SQLite migration history is contiguous, immutable by version/name, and equal to `PRAGMA user_version`; a future or inconsistent schema is rejected and a failed pending sequence leaves neither partial DDL nor ledger rows.
30. Recovery filters and keyset-pages by agent before its row bound, excludes unchanged current-version approval waits before materialization, prioritizes actionable active-version rows, and terminalizes each incompatible, invalid-snapshot, or malformed run independently with `run.recovery.failed` before quarantine can start a tool. A previously running invocation remains an explicit unknown external outcome.

## Unreleased Corporate Oracle acceptance invariants

1. Connector ingestion requires `ingest` and exact workspace scope; with auth
   enabled, request data cannot override the principal-derived source identity.
2. Every page carries an immutable `sourceAccountId`; account drift for an
   existing source/stream fails closed and cannot merge provider tenants.
3. A page and its resume checkpoint commit atomically before embeddings; sync
   starts no agent/chat completion, while separately reported post-commit
   embedding may use the configured local/approved-cloud adapter. An embedding
   outage leaves evidence durable and search available lexically.
4. Every cursor-bearing page after the first CAS-binds `previousCursor` to the
   current scoped checkpoint. Exact cursor/page replays preserve their original
   predecessor and are idempotent; same-cursor/different-page replays conflict,
   and delayed/concurrent pages cannot regress either a native-v11 or migrated
   v10 checkpoint. Cursorless webhook pages remain digest-idempotent without
   claiming pagination order. Older source timestamps cannot replace a head,
   and different content at one source timestamp is never resolved by
   last-writer-wins.
5. Current search uses active heads and content-bound current embeddings;
   temporal search uses retained versions lexically, with `asOf` bound to
   provider update time and `knownAt` bound to server-owned observation time.
   Either or both may be used, and no old content can receive a current vector.
6. `oracle_search` and `oracle_sources` are read-only and return untrusted,
   freshness-bearing evidence; neither can ingest, approve, mutate memory, or
   claim an external action.
7. After a completed `oracle_search`, every external-boundary tool and every
   local effect beyond read/draft becomes `ask` for exact approval throughout
   that session, including later runs; approvals do not clear the taint, and
   only a new session starts untainted. This guard does not validate citation
   presence in generic final prose.
8. Missing or selected-model/content-stale current embeddings can be repaired
   on page replay or by an admin-only 1-100 record backfill; repair never starts
   an agent/chat completion.
9. Corporate evidence and reviewed memory remain distinct: a source record can
   support a separately policy-checked proposal, but no source can activate a
   memory, mutate policy/prompts/tools, or train a model.
10. Linear/Jira sidecar source is implemented, but an external provider tenant
   and a 4 GiB Oracle deployment remain candidates until the pinned connector
   and representative multi-source promotion gates pass on target hardware.
