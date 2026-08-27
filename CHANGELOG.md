# Changelog

All notable project changes are documented here. The project follows semantic
versioning for its package version; the configuration schema is versioned
separately.

## Unreleased

### Added

- A strict `core-4g-v1` profile with small tool, step, context, retrieval, and
  wall-time limits; automatic selection on machines at or below 4.5 GiB; and an
  explicit `setup --core-4g` override.
- A versioned disposable harness footprint evaluator with fixed RSS, latency,
  SQLite, shutdown, isolation, and cleanup assertions.
- A standalone `eval-local-4gb` gate for an already-running, content-addressed
  one-slot model: descriptor-held source snapshots, cross-bound qualification
  pins, retained host and target-root artifact descriptors, exact
  binary/model/argv/PID identity, Linux namespace/listener/auth proof, physical
  target-host headroom, kernel cgroup-v2 memory/swap peaks, a 30-minute soak,
  and the compact analyst corpus.
- A strict authenticated `llama.cpp` adapter, a hash-checked systemd candidate,
  and fail-closed Granite 350M configuration/deployment manifest examples.
- A shared core run-admission governor with typed overload errors and HTTP 429,
  plus finite global SSE client ceilings.
- Strict duplicate-safe tool-argument parsing, deterministic canonical argument
  bytes, and SHA-256 bindings carried through invocations, approvals, events,
  operator review, restart recovery, and execution.
- A contiguous, transactional SQLite migration ledger through schema version 11,
  mirrored to `PRAGMA user_version`, plus agent-scoped keyset recovery pages that
  keep current-version work ahead of explicitly quarantined legacy runs.
- A shell-free `qualify:platform` evidence runner and immutable-action CI matrix
  for Ubuntu 24.04 x64, Windows Server 2025 x64, and macOS 15 arm64, with raw
  logs, native test reports, explicit exclusions, a SHA-256 manifest, and
  repository-level LF/binary attributes that keep content addresses stable
  across native clones. Its fail-closed corpus pins all 41 Vitest files, 123
  suites, 473 assertions, exact platform skips, and 38 zero-skip POSIX Python
  safety tests.
- Dependency-free OpenAI-compatible chat and embedding transports for explicitly
  approved cloud or local endpoints, with independent chat/embedding disclosure
  gates, environment-only credentials, immutable embedding/route generations,
  and the same SQLite memory engine on either side of the inference boundary.
- A native packed-install smoke gate that installs the generated tarball into an
  empty consumer, verifies package exports and CLI help, and proves setup dry-run
  creates no configuration or data files on macOS, Windows, and Linux CI lanes.
- A temporal Corporate Oracle ledger in SQLite schema version 10: bounded
  normalized corporate records, immutable provider-account binding, mutable
  current heads, append-only retained revisions during normal synchronization,
  current-content embeddings, and atomic source/stream resume checkpoints.
- Schema version 11 Corporate Oracle hardening: an accepted-page replay ledger
  that keeps old cursor retries from regressing the latest checkpoint,
  predecessor-cursor compare-and-swap fencing for ordered pagination,
  trigger-maintained Unicode-aware FTS5 candidate indexes, absolute
  credential-free HTTP(S) source URLs with query/fragment rejection, and
  replay-time embedding repair.
- A `POST /api/oracle/sync` boundary that launches no agent run or chat
  completion, with an ingest-only control
  capability, principal-bound connector identity, required `sourceAccountId`,
  required `previousCursor` chaining after the first cursor-bearing page, exact
  page-replay/conflict handling, stale-version rejection, post-commit
  embedding status, and connector-owned checkpoint reads. Post-commit embeddings
  may use the configured local or explicitly approved cloud embedding model; the
  receipt distinguishes `agentRunInvoked`, `chatModelInvoked`, and
  `embeddingInvoked` while retaining legacy `modelInvoked: false` for no
  agent/chat completion.
- An admin-scoped `POST /api/oracle/embeddings/backfill` endpoint for bounded
  1–100-record repair of missing or selected-model-stale active embeddings,
  optionally restricted to one source.
- Read-only `oracle_search` and `oracle_sources` agent tools plus scoped control
  endpoints for current/historical search, source freshness, retained record
  history, and explicit admin source erasure. Oracle results carry stable
  `[oracle:<id>]` citations, source/observation freshness, and no-action status.
- Dual lexical temporal search bounds: provider `asOf` uses
  `sourceUpdatedAt`, while harness `knownAt` uses server-owned `observedAt` that
  connectors cannot supply; callers may apply either bound or both.

### Changed

- Retrieved memory now has an aggregate profile-level character bound, model
  completion JSON is streamed with a 256 KiB cap, and integration machinery is
  loaded only when configured; JSON-only and MCP-only deployments also skip
  the unused transport module graph.
- Prompt and API storage reads now have finite validated ceilings, session
  inspection supports deterministic pagination, and post-compaction prompt
  history fails closed above its bounded materialization window.
- Product positioning now distinguishes the 4 GiB core harness from separately
  qualified local model, embedding, voice, and vision processes.
- The setup wizard now keeps deterministic 256-dimensional in-process embeddings
  as the lightweight default. Ollama semantic embeddings require an exact
  service digest; BGE-M3 remains a separately qualified higher-memory promotion.
- Memory retrieval is workspace/project/actor scoped, relevance-gated, cached
  per workspace, and attributed only when supplied to the final prompt. Feedback
  is first-write and exactly-once per actor/run, while full outbound input budgets
  include the system prompt, memory context, UTF-8 messages, and tool schemas.
- Native portability now covers Windows Python discovery, executable `PATHEXT`
  resolution, PowerShell-safe wizard instructions, Windows owner-lock cleanup,
  loopback-control signal handling, and cross-platform SQLite file-identity
  checks without misrepresenting POSIX modes as Windows ACL enforcement. Native
  Node transcription fixtures now launch through the Node executable on every
  OS, PowerShell llama.cpp commands use the call operator, and existing database
  aliases/hard links fail before publishing an unusable setup.
- The standard wizard grants the two read-only Oracle tools, while
  `core-4g-v1` keeps its four-tool surface unchanged. Reviewed memory remains a
  separate proposal/activation/reward plane; synchronized source facts do not
  receive memory reinforcement or activate themselves.
- Integration guidance now defines provider OAuth, token refresh, pagination,
  webhooks/polling, rate limiting, and proprietary normalization as pinned
  sidecar responsibilities. No provider sidecar or 4 GiB Oracle workload is
  represented as live-qualified.

### Security

- The dedicated `llama.cpp` boundary requires loopback `/v1`, a separate API
  key, a safe pinned `--alias`, strict structured tool calls, no parallel tool
  calls, and matching response identity. OpenProjects remains the only tool and
  approval authority.
- Portable 4 GiB evidence now fails closed unless the evaluator and target share
  network and cgroup namespaces, the target solely owns the reviewed listener,
  unauthenticated and wrong-Bearer requests are rejected before and after the
  quality run, and the resolved cgroup-v2 mount, limits, inode, kernel peaks,
  sampling cadence, model mapping, and source/artifact identities remain stable.
- The `llama.cpp` wizard path now emits exactly one `project_analysis` route and
  one absolute-path 53-argument CPU launch command; it hands off to the local
  gate and does not present the candidate as a supervisor-ready installation.
- `core-4g-v1` admits one active run across supervisor and specialist lanes and
  rejects overload before allocating durable work; approval decisions are not
  committed when capacity is unavailable.
- Complete tool-call batches are envelope- and strict-JSON-preflighted before
  batch allocation or any policy, approval, invocation, outbox, or tool effect.
  Duplicate keys—including nested and escape-equivalent names—fail the run.
- Approval actions echo the reviewed argument digest. SQLite transactionally
  cross-checks approval and invocation bytes/digests before approval; legacy
  unbound rows remain rejectable but can never be approved or executed.
- Telegram exposes an Approve action only when the complete canonical argument
  envelope and digest fit in one message; oversized reviews direct operators to
  the paginated local surface without truncating actionable content.
- SQLite startup rejects future, missing, non-contiguous, or mismatched migration
  histories before enabling WAL. Recovery failures are isolated per run:
  incompatible versions, changed/invalid snapshots, and malformed run rows are
  terminalized with a durable `run.recovery.failed` event without starting a
  tool during quarantine, while independent healthy rows and agent lanes
  continue. Any invocation already marked running is recorded as an unknown
  external outcome with a verify-before-retry warning.
- Recovery cursors are bounded rowid locators SHA-256-bound to the exact
  agent/version scope; oversized raw sort keys stay inside SQLite. Current-version
  inert approval waits are filtered before page materialization, keeping large
  approval backlogs out of startup memory.
- External inference is denied by default. Enabled hosted routes require HTTPS,
  exact origin permission, a live environment credential, an immutable
  generation, explicit zero-price review when applicable, and separate consent
  before local failure may fall back across the disclosure boundary. Redirects,
  malformed/truncated responses, and paid calls whose accounting cannot be
  committed fail closed.
- SQLite migration 9 adds idempotent route-feedback applications and scoped
  accounting indexes. Adaptive route telemetry is keyed by a SHA-256 identity so
  provider, model, endpoint, task, context, wire-profile, or generation changes
  cannot inherit stale rewards or reliability.
- Corporate ingestion is workspace-scoped and source identity comes from the
  authenticated control principal. Provider `sourceAccountId` is persisted on
  records/checkpoints and account drift fails closed, preventing a connector
  credential or changed tenant from silently merging corporate histories.
  Observation time is stamped by the harness rather than trusted from a
  connector payload.
- Corporate records are always untrusted evidence with no instruction
  authority. Oracle tools are read-only, and the prompt instructs the model to
  cite records and freshness; the generic supervisor does not yet schema-enforce
  citation presence. Oracle tools cannot synchronize data, activate memory,
  approve, or claim an external effect; writes continue through separately
  reviewed policy/approval tools.
- A successfully completed `oracle_search` durably taints its entire session:
  every later external-boundary tool and every local effect beyond read/draft,
  including calls in later runs, requires an exact digest-bound approval.
  Approval does not clear the taint; only a new session does.
  `oracle_sources` alone does not taint a session, and generic final-prose
  citation validation remains an evaluation requirement rather than an
  enforced output contract.
- Cursor-bearing sync pages use the current checkpoint cursor as a
  compare-and-swap predecessor after the first page. Exact replay retains its
  original predecessor, protecting native and migrated-v10 checkpoints from
  delayed or concurrent regression; cursorless webhook pages remain
  digest-keyed and idempotent without an ordered-pagination claim.

## 0.6.0 - 2026-08-25

### Added

- A standalone, no-database `eval-vision` gate with hash-bound synthetic PNG
  fixtures, strict structured grading, image-dependence counterfactuals, exact
  model/runtime evidence, and a minimum 50-attempt promotion threshold.
- Strict ephemeral PNG/JPEG container validation and a loopback-only local VLM
  adapter for evaluation. This does not expose product image ingestion.

### Security

- Vision qualification now requires healthy exact loaded-model identity,
  singleton model discovery, resolved configured credentials, complete model
  inventory, and hash-bound runtime evidence before corpus requests begin.
- The evaluator constructs no application runtime, opens no SQLite database,
  persists no media or model description, performs no download or promotion,
  and keeps product vision and supervisor status explicitly unevaluated.

## 0.5.0 - 2026-08-25

### Added

- MIT licensing, third-party notices, contribution and governance policies,
  community templates, CI, and a fail-closed source/package release audit.
- Reviewed, content-addressed MCP and JSON API manifests with exact tool
  allowlists, workspace scopes, external-data policy, and safe operator checks.
- Bounded MCP stdio/Streamable HTTP clients and a structural JSON API executor
  with environment-only credentials, no redirects or automatic write retries.
- Ready-to-review connector examples for common project systems while keeping
  the existing policy, approval, ambiguity, and run-snapshot kernel authoritative.

## 0.4.0 - 2026-08-25

### Added

- Private-appliance profiles, local model qualification, and Apple Silicon MLX
  integration boundaries.
- Durable approvals, run recovery, content-addressed agent/tool/policy
  commitments, bounded event streams, and a local control TUI.
- Reviewed group memory, feedback reinforcement, offline dataset export, and a
  separately gated local training lab.
- Representative harness evaluations, a compact project-analyst lane, semantic
  embedding evaluation, and a call-only MCP tool gateway.

### Security

- Fail-closed local network policy, protected Unix control transport,
  capability/workspace-scoped credentials, exact approval binding, bounded
  tool execution, and conservative ambiguous-outcome handling.
