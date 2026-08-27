# OpenProjects product roadmap

Status: evidence-driven product direction, last updated 2026-08-27.

## Product vision

OpenProjects is a lightweight private project-management colleague and
**Corporate Oracle** that runs on customer-controlled hardware. Its durable
core targets a 4 GiB total-system machine without making a learned model or
cloud LLM API a runtime dependency. It should build useful context over time
from two controlled planes: fresh, versioned evidence synchronized from task
trackers, CRM, ERP, email, messengers, calendars, and documents; and durable
organizational memory that becomes retrievable only through review. Local and
explicitly approved cloud LLMs consume the same scoped evidence and memory.

The product is not trying to become a general autonomous computer operator.
The host remains authoritative for identity, scope, tools, policy, approvals,
durability, and retention. Models propose or analyze; they do not acquire new
authority from prompts, retrieved content, images, connector metadata, or a
framework.

## Non-negotiable product invariants

Every roadmap stage must preserve these properties:

1. Private mode fails closed when its reviewed local dependency is unavailable.
2. Data leaves the machine only through an explicitly configured, reviewable
   boundary.
3. Tools are allowlisted and schema-bound; consequential effects still pass
   through the kernel's policy and exact approval records.
4. Runs bind content-addressed agent, tool, policy, model, and external-service
   commitments appropriate to the lane.
5. Crash recovery never converts an uncertain external effect into success or
   an automatic retry.
6. Product claims follow recorded evaluations on exact artifacts and hardware.
7. Learning means reviewed memory and offline datasets until a separate
   promotion suite justifies a model change.
8. Mutable corporate facts retain source/account/version/freshness provenance;
   synchronized content is untrusted evidence and cannot become instruction,
   policy, memory activation, or action authority.
9. Connector ingestion and external actions remain separate: ingest-only
   identities cannot search or act, while writes still require reviewed tools,
   policy, exact approval, and reconciliation.

## Delivered foundation — through v0.6

The current foundation includes the private local control plane and TUI,
single-owner SQLite durability, scoped service credentials, exact approvals,
reviewed memory, local model/embedding/transcription qualification, a compact
project-analyst lane, representative host and live-model evaluations,
content-addressed run commitments, and reviewed MCP/JSON API integrations.

The evidence currently supports the exact sequential specialist lanes recorded
in the M3 pilot. It does not qualify an authority-bearing local supervisor or a
vision product path.

The release harness is also being held to one portable software gate across
native Windows/macOS and hosted Windows/macOS/Linux runners. This establishes
core portability without broadening any model claim; MLX remains Apple-only and
the portable 4 GiB model promotion still requires the constrained Linux gate.

## Delivered foundation — temporal Corporate Oracle (Unreleased)

The generic Oracle foundation is implemented, but it is not yet a supported
provider-connector product claim. Schema v10 provides:

- normalized bounded ingestion for project, CRM, ERP, email, messaging,
  calendar, document, and other records;
- authenticated source identity plus required immutable provider
  `sourceAccountId`, with account drift rejected rather than tenant data merged;
- cheap mutable current heads and append-only retained revisions during normal
  synchronization;
- atomic source/stream cursor, watermark, page-digest, count, and success
  checkpoints with exact-replay and conflict detection;
- post-commit embeddings for changed current heads, with lexical fallback and
  lexical temporal search using provider `asOf`, server-owned `knownAt`, or
  both;
- workspace/project/source/domain scoping, freshness summaries, record history,
  citations, and explicit admin erasure; and
- exactly two read-only model tools, `oracle_search` and `oracle_sources`, with
  untrusted-evidence and no-action contracts.

Schema v11 hardens that core with an accepted-page replay ledger that prevents
old cursor retries from regressing the latest checkpoint; a predecessor-cursor
CAS fence for ordered pagination; Unicode-aware FTS5 candidate indexes;
path-only source URLs; replay-time and admin-bounded embedding repair; and a
session taint that forces exact approval for every post-search external-boundary
tool and local effect beyond read/draft, including later runs. The
generic supervisor still does not mechanically validate citations in final
prose.

Provider OAuth lifecycle, webhooks, and broad vendor SDKs remain outside the
resident harness. The first pinned one-shot sidecar lane now implements Linear
and Jira identity reads, bounded polling/pagination, projection, and crash-safe
Oracle handoff without an SDK dependency. Neither provider has yet passed a
real-tenant live qualification, and the existing 4 GiB evidence does not cover
an Oracle dataset or connector process.

## Active gate — over-time PM and Oracle qualification

The next supported product slice is read-mostly and evidence-driven:

1. Qualify the exact Linear and Jira sidecar artifacts against disposable
   provider test data and a staging Oracle: force pagination, interruption,
   byte-identical pending replay, account stability, unchanged repeat, rate
   limits, and a request ledger with zero provider writes. Static token use is
   a separate claim from OAuth consent/refresh/rotation.
2. Add a representative temporal PM corpus covering deadline drift, ownership
   changes, blockers, dependencies, CRM-versus-ticket contradictions, missing
   source coverage, prompt injection inside records, “what source state was
   effective by this provider update time?”, and “what had the harness actually
   recorded by this host time?” questions. Evaluate `asOf` and `knownAt`
   independently and together.
3. Prove workspace/project/source/account isolation, stale and out-of-order
   delivery, exact resume, predecessor-CAS rejection of delayed/concurrent
   pages against native and migrated checkpoints, latest and old-page replay
   with the original predecessor and without checkpoint regression, cursorless
   webhook deduplication, page conflict behavior, embedding failure/replay
   repair/bounded admin backfill, Unicode retrieval, source-URL rejection, crash recovery,
   citation/freshness quality, deletion tombstones, and source erasure against
   that corpus.
4. Reuse the contract for Slack public allowlisted channels, a provider-specific
   read-only email API, and HubSpot companies. Generic IMAP is deferred unless
   its broader authorization grants are acceptable and separately documented.
5. Run the exact connector commit on the maintainer's physical Windows device,
   including loopback auth, restart/spool recovery, Task Scheduler identity,
   firewall posture, and independent NTFS ACL evidence. Hosted Windows CI is
   not a substitute.
6. Then qualify an open/self-hostable ERP lane before broader vendor coverage.
   A provider name enters supported documentation only after its exact sidecar
   version, tenant hash, scopes, and host pass staging evidence.
7. Measure realistic record counts, sync pages, index/database growth, query
   latency, peak RSS, and post-commit embedding cost. Only a target-host pass may
   establish a 4 GiB Oracle profile; until then `core-4g-v1` continues to omit
   Oracle tools from its advertised surface.
8. Evaluate over-time learning without conflation: source versions update
   corporate evidence, reviewed proposals update durable memory, and bounded
   feedback updates attributed memory/route reward exactly once. No source
   record automatically activates memory or changes model weights.
9. Keep the first action path separate. After `oracle_search`, every
   external-boundary tool and every local effect beyond read/draft already
   becomes `ask` for the rest of that session, across later runs and individual
   approvals until a new session; verify its exact approval, provider
   idempotency/status-check, and unknown-outcome behavior. Ticket/email/chat/ERP
   writes remain static reviewed MCP/JSON/local tools. Citation presence remains
   an explicit evaluation assertion until a strict final-output validator lands.

The first product claim after this gate should be narrow: a read-mostly PM
assistant that cites current and historical evidence from the qualified
sources, identifies contradictions and stale coverage, and proposes reviewed
next actions. “Connected to everything,” autonomous workflow execution, and
unqualified provider logos are explicitly not acceptance criteria.

## Parallel gate — lightweight 4 GiB core

The current stage turns the resource target into an enforceable product
contract. The distinction is explicit: the OpenProjects core targets a 4 GiB
total-system host; a local learned model remains a separate, optional lane with
its own process-tree budget and target-hardware gate.

This stage includes:

- a strict `core-4g-v1` configuration profile with small step, tool, context,
  retrieval, and wall-time limits;
- wizard refusal to represent a model with a larger minimum-memory declaration
  as eligible on a 4 GiB machine;
- deterministic built-in retrieval and no resident integrations, learning,
  Telegram, notifications, transcription, subagents, or vision;
- aggregate retrieved-context enforcement rather than a per-record-only cap;
- lazy optional integration loading and a streamed 256 KiB model-response cap;
- transport-specific integration loading, so JSON-only deployments do not
  import the MCP client/SDK and MCP-only deployments do not import JSON API;
- one shared active-run permit, a four-client core SSE ceiling, and no
  unbounded overload queue;
- duplicate-safe whole-batch tool preflight plus canonical, digest-bound
  approval semantics across storage, recovery, API, TUI, and Telegram;
- a numbered transactional SQLite schema ledger with future-version refusal,
  plus indexed agent-scoped recovery that quarantines bad records without
  blocking healthy runs;
- bounded prompt/history and collection materialization with deterministic
  event pagination;
- a versioned disposable harness footprint evaluator with conservative RSS,
  startup, SQLite, latency, shutdown, socket, and cleanup gates; and
- explicit separation between true 4 GiB total-system support and a later
  one-lane-at-a-time local-AI child budget on a larger host.

See [Lightweight 4 GB product profile](./lightweight-4gb.md). The remaining
promotion gate is empirical: provision the exact reviewed Granite 350M Q8 plus
llama.cpp candidate on a 4 GiB Linux cgroup, then pass the new content-addressed
`eval-local-4gb` source/pin, PID/namespace/listener/auth, read-only model mapping,
physical-host headroom, kernel cgroup/swap, cadence, quality, and 30-minute soak
contract. A pass promotes only the compact analyst lane, never supervisor
authority. Apple MLX remains a separate non-portable application-budget lane.

## Delivered lab — local vision readiness

v0.6 implements this readiness gate without enabling product ingestion. No real
VLM has passed it, and the 4 GiB pivot keeps vision disabled by default.

The active roadmap stage builds evidence before ingestion:

- accept only committed synthetic PNG evaluation fixtures; the parser also
  validates JPEG structure, but service-level JPEG decoding is not qualified;
- validate media signatures, dimensions, pixel count, byte size, and hashes;
- require an exact loopback VLM endpoint and complete model/runtime identity;
- run one image at a time with fixed prompts and strict structured output;
- cover synthetic project status/deadline cards, multilingual text,
  unsupported claims, category-specific image-dependence, and visual prompt
  injection; the v1 corpus does not yet qualify ambiguous-image behavior;
- construct no application runtime or SQLite database during evaluation;
- perform no download, promotion, tool call, approval, outbox write, or memory
  mutation; and
- report latency, failures, identity evidence, and explicit non-evaluated
  product capabilities.

A color-recognition probe is only transport evidence. The vision gate passes
only when the exact pinned candidate passes the versioned representative corpus,
including same-prompt/different-image counterfactuals, and a reliability soak on
target hardware.

## Later product slice — read-only vision analyst

This slice opens only after the lightweight core and a local VLM both pass their
independent gates. Its first supported surface is intentionally small:

- authenticated local control API and CLI/TUI operator input;
- exactly one PNG or JPEG screenshot/photo;
- bounded streaming intake and low-privilege decoding;
- one local, pinned VLM call with no tools and no retrieved memory;
- a strict advisory result marked as untrusted visual evidence;
- durable provenance only by default: digest, media type, size, dimensions,
  model identity, prompt-contract digest, and outcome status; and
- no replay after a crash when ephemeral media is unavailable—the operator
  must resubmit it.

Telegram images, PDF parsing, OCR pipelines, remote image URLs, multi-image
chat, image storage, automatic memory creation, and actions derived directly
from pixels remain outside that first slice.

## Later horizons

The order after read-only vision remains evidence-driven rather than tied to a
calendar:

1. Internal corporate chat plus per-human identity and accountability.
2. Reviewed document ingestion with isolated parsing, explicit retention, and
   page-level provenance.
3. A qualified local supervisor on hardware that can meet the representative
   safety and quality gates without unsafe co-residency pressure.
4. Signed release/model/integration provenance and stronger host isolation.
5. A workflow-engine prototype only after repeatable measurements show that
   tuned SQLite plus the single owner cannot meet a named production SLO.
6. Fine-tuning only after enough clean, consented examples exist and a
   base-versus-candidate promotion suite can detect regressions.

## Definition of roadmap progress

A stage is complete only when source, adversarial tests, operator documentation,
and a reproducible evaluation report agree. A feature that is merely configured,
reachable, or demonstrated once remains a candidate—not a supported product
capability.
