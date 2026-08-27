<p align="center">
  <img src="./docs/assets/openprojects-cover.png" alt="OpenProjects" width="100%">
</p>

# OpenProjects Harness

[MIT License](./LICENSE) · [Contributing](./CONTRIBUTING.md) · [Security](./SECURITY.md) · [Code of Conduct](./CODE_OF_CONDUCT.md)

OpenProjects is a **lightweight private agent control plane first**. Its durable core targets a 4 GiB total-system machine; project state, policy, exact approvals, reviewed memory, recovery, and the private control plane do not require a resident learned model or hosted API. Model inference, semantic embeddings, voice, vision, and integrations are replaceable, separately qualified lanes rather than permanent baseline services. See the [Lightweight 4 GB product profile](./docs/lightweight-4gb.md).

On larger customer-controlled hardware, those optional lanes can still run without a hosted model API. OpenProjects provides a project colleague that can answer questions with reviewed tools, observe an explicitly opted-in group, propose durable memories for review, ask bounded advisory subagents, send deterministic deadline notices, and prepare an explicitly reviewed local LoRA experiment for a small read-only specialist. Hosted routes remain optional and must be an explicit deployment decision.

The unreleased **Corporate Oracle foundation** adds a second, deliberately
separate temporal plane for changing business facts. Authenticated connector
sidecars can normalize bounded pages from task trackers, CRM, ERP, email,
messaging, calendar, and document systems into a versioned local evidence
ledger. Every page binds an immutable provider `sourceAccountId`; tenant drift
fails closed instead of merging histories. The harness keeps cheap current
heads, append-only source versions while retained, atomic resume checkpoints,
an accepted-page replay ledger, Unicode-aware full-text candidate indexes, and
repairable current-record embeddings. The
agent receives only the read-only `oracle_search` and `oracle_sources` tools;
source text is untrusted evidence, and the prompt instructs the agent to attach
`[oracle:<id>]` citations and freshness to material claims. The generic
supervisor does not yet enforce citation presence in its final-output schema.
After a completed `oracle_search`, every external-boundary tool and every local
effect beyond read/draft is forced through exact approval for the rest of that
session, including later runs; only a new session starts untainted. No
provider sidecar or 4 GiB Oracle workload has yet been live-qualified.

The product direction includes local image/document vision under the same on-prem boundary. v0.6 adds a standalone, no-database local-VLM readiness evaluator and a strict ephemeral media/adapter foundation. The product still does not ingest images, persist visual results, or send multimodal messages through an agent run, so vision is not advertised as implemented.

The current implementation is **v0.6.0**. The configuration schema intentionally remains `version: 1` for backward compatibility with existing deployments.

## What is implemented

| Capability | Current behavior | Default |
| --- | --- | --- |
| Telegram groups | Telegram must first be explicitly enabled as an external origin; then an allowlisted operator who is also a Telegram administrator must run `/openprojects_enable` and the bot posts a visible notice | Globally disabled and off per group |
| Group learning | Redacts and scores before persistence; stores only salient observations and creates their inferred memories as `proposed` | On only after group opt-in |
| Memory approval | Inferred memories are excluded from retrieval until an allowlisted operator who is also a group admin activates them | Human-reviewed |
| Retrieval | Selected embedding plus lexical/strength/reward scoring; lexical fallback if embedding fails | In-process 256-dimensional feature-hash embedding |
| Reviewed feedback learning | Applies bounded feedback updates only to active memories actually supplied to the run; idempotent by feedback ID and never changes model weights | Enabled |
| Corporate Oracle foundation | Schema v10 stores normalized, account-bound current heads, retained revisions, and atomic checkpoints; v11 adds accepted-page replay history, Unicode FTS candidate indexes, and bounded embedding repair | Ingestion is API-only; no provider sidecar is bundled or live-qualified |
| Oracle agent tools | `oracle_search` returns workspace/project-scoped, cited, freshness-bearing untrusted evidence and taints later same-session actions/external calls into exact approval; `oracle_sources` reports stream coverage and freshness | Read-only and included by the standard wizard, omitted from `core-4g-v1`; a new session clears the taint, while generic prose citation validation is not implemented |
| Model routing | Filters by task, quality, context, and paid daily budget, then scores cost, quality, reliability, latency, and learned reward | One zero-cost mock local route in the sample config |
| Specialist lanes | Three fixed advisory roles with depth, call, and concurrency limits; `project-analyst` has one host-scoped read tool, while the other two remain tool-free | Enabled when a separately eligible route is usable |
| Notifications | Deterministic task reminders and blocked-task notices with durable delivery state | Planning enabled; delivery disabled unless Telegram is explicitly enabled |
| Voice | Local `whisper.cpp` adapter with FFmpeg conversion, limits, timeout, and temporary-file cleanup | Disabled |
| Apple Silicon inference | Supervised, loopback-only MLX-LM provider with strict response/tool validation and no harness-owned install, download, or process spawning | Wizard default on Apple Silicon; service/model staged separately |
| 4 GiB core profile | Strict `core-4g-v1` limits tools, steps, context, retrieval, and optional resident features; machines at or below 4.5 GiB receive it automatically | Built-in retrieval, deterministic model fixture, no live route |
| Lightweight admission/history | One shared active run and four SSE clients in `core-4g-v1`; overload fails before durable allocation; prompt and collection reads have finite ceilings | Automatic in the core profile |
| Harness footprint gate | Disposable built-CLI/SQLite/Unix-socket lifecycle with fixed RSS, latency, database, shutdown, isolation, and cleanup ceilings | Manual; measures OpenProjects, never model-runtime memory |
| Local 4 GiB model gate | Exact model/runtime/argv/PID identity, compact analyst quality, process-tree/cgroup/swap sampling, and 30-minute Linux soak; macOS is explicitly non-certifying app-budget evidence | Manual; already-running endpoint only, no pulls or process management |
| Appliance qualification | Bounded, no-pull capability probes with complete model/runtime identity evidence for text/tools, optional separate VLM, semantic embeddings, and known-audio transcription | Manual; exits nonzero unless every selected lane and sealed-local posture qualify |
| Representative evaluation | Eight deterministic risk/deadline/memory/approval/injection/recovery cases, plus three explicitly opt-in live project-analyst prompts | Offline deterministic lane by default; live model lane requires an exact route and manifest |
| Run contract provenance | Every new run receives content-addressed redacted agent/tool/policy commitments; ordinary recovery refuses a changed contract | Automatic; hashes are identity records, not signatures or encryption |
| Schema and recovery durability | Numbered transactional SQLite migrations reject future/inconsistent histories; bounded agent-scoped keyset recovery quarantines incompatible or malformed rows without executing their tools | Automatic; no migration daemon or workflow service |
| Cross-platform software gate | One evidence-producing release command exercises clean install, TypeScript/SQLite/runtime tests, build, MIT boundary, and production audit on pinned Ubuntu, Windows, and Apple-Silicon macOS runners; the 38-test POSIX Python/MLX safety lane runs on Ubuntu/macOS and is explicitly N/A on native Windows | CI plus native operator runs; explicitly not a model or 4 GiB hardware claim |
| Reviewed integrations | Static MCP `tools/call` and declarative JSON API operations become ordinary policy/approval-controlled kernel tools | None configured; bounded stdio/Streamable HTTP and JSON transports are optional, with no dynamic tools or OAuth flow |
| Image/document vision | Strict ephemeral PNG/JPEG validation and a loopback-only VLM adapter exist for standalone evaluation; the current corpus qualifies PNG only and there is no agent/API/TUI ingestion path | Product capability disabled |
| Training export | Deterministic, redacted JSONL for rewards, corrections, and preference pairs, with SHA-256 manifests | Manual; review is required outside the code |
| Local SFT lab | Validates a row-level review attestation and every digest, prepares a grouped held-out split, and can launch guarded MLX QLoRA | Disabled; never promotes a model |
| Private control plane | Owner-only Unix socket, local least-privilege principals, workspace scoping, and a permission-aware TUI | POSIX private profile uses one `local-admin` principal; no TCP listener |

“Local” on a model route is routing metadata, not a network sandbox. A route is private only when its endpoint, model server, host, storage, and network policy are actually under your control and independently verified.

## Lightweight 4 GB quick start

The 4 GiB claim applies to the bounded OpenProjects core, not to a co-resident
27B model. On a machine with at most 4.5 GiB detected memory, the setup wizard
automatically generates `core-4g-v1`: four read-only host tools, deterministic
built-in retrieval, no live model route, and no optional resident services.
The reviewable static equivalent is
[examples/openprojects.core-4g.yaml](./examples/openprojects.core-4g.yaml).

```bash
npm ci
npm run build
npm run setup -- --core-4g --defaults --dry-run
npm run eval:harness-footprint -- --config openprojects.config.yaml --json
npm run demo
```

The footprint evaluator currently uses macOS process accounting and must be run
from the built CLI. Its report separates harness readiness from model
eligibility. A true 4 GiB deployment should retain that target-host report;
results from the M3 8 GiB development machine demonstrate headroom but do not
silently certify another host class. Small local text, embedding, voice, and
vision candidates are one-at-a-time experiments until their exact artifacts
pass independent quality and process-tree/swap gates.

The first portable experiment is fully wired but intentionally unpromoted: an
authenticated one-slot `llama.cpp` worker with the official Granite 4.0 350M
Q8 GGUF. Review the [candidate config](./examples/openprojects.local-4gb-candidate.yaml),
[capability manifest](./examples/appliance-qualification.llama-cpp.example.json),
[deployment manifest](./examples/local-4gb-deployment.llama-cpp.example.json),
and [bounded service unit](./deploy/systemd/openprojects-llama-server.service.example).
Replace the runtime hash/PID placeholders and run `eval-local-4gb` with the
model and evaluator beneath the target finite Linux cgroup/slice; the repository
does not silently download or launch either file. A portable pass additionally
proves the exact source snapshots and qualification pins, target PID and
read-only model mapping, sole loopback-listener ownership, negative auth,
network/cgroup namespace identity, finite cgroup-v2 memory and swap limits,
kernel peaks, bounded telemetry cadence, and a 30-minute soak on an observed
host with at most 4.5 GiB total memory and at least 256 MiB continuously
available.

The current built-core gate passed on that M3 with 80.86 MiB settled idle RSS,
81.86 MiB lifecycle peak, 189.95 ms startup, a 23.91 ms durable mock run, and
16.94 ms shutdown. It observed no Internet descriptors and removed the owner
lock, Unix socket, WAL, and SHM. The JSON still records
`targetFourGiBHostCertified: false` because the host has 8 GiB.

## Private appliance quick start

The higher-memory appliance profile starts with [the sealed corporate profile](./examples/openprojects.private.yaml): one local Qwen route through Ollama, optional local BGE-M3 semantic embeddings, an authenticated owner-only Unix-domain control socket and service-attached TUI, no hosted fallback, external writes denied, and Telegram disabled. It requires no model API key and opens no TCP control listener. This profile is not the 4 GiB baseline.

OpenProjects still talks to the local inference runtime through an OpenAI-compatible HTTP interface on loopback. “No model API required” means no external/vendor model service or credential is required, not that the processes exchange no API calls.

```bash
ollama pull qwen3.5:9b
ollama pull bge-m3
npm ci
npm run build
sudo install -d -o "$(id -un)" -g "$(id -gn)" -m 0700 /var/lib/openprojects
sudo -u "$(id -un)" /bin/sh -c \
  'umask 077; set -C; openssl rand -base64 48 > /var/lib/openprojects/control.token'
sudo chmod 0600 /var/lib/openprojects/control.token
node dist/src/cli.js doctor --probe --config examples/openprojects.private.yaml
node dist/src/cli.js eval --config examples/openprojects.private.yaml --suite evals/project-ops.json
node dist/src/cli.js serve --config examples/openprojects.private.yaml
# In another terminal:
node dist/src/cli.js tui --config examples/openprojects.private.yaml
```

The example stores SQLite, its mode-`0600` control token, and `/var/lib/openprojects/control.sock` under a mode-`0700` directory owned by the service identity; use that eventual identity as owner, or change all paths for a workstation trial. The live socket is restricted to mode `0600`. `doctor --probe` makes one bounded live model and embedding request and inspects local storage/Whisper prerequisites. It is a connectivity/readiness smoke test and cannot prove model quality or host egress isolation. `eval` deliberately substitutes the deterministic mock model and in-memory storage, so it tests harness behavior rather than the configured model. Qualify the exact local model and quantization with separate project/tool evaluations before use. The optional BGE-M3 lane needs materially more memory than the 4 GiB core and should run sequentially with other learned lanes on constrained hardware.

For the production topology, systemd profile, egress verification checklist, Telegram boundary, and current vision limitation, see [Private corporate deployment](./docs/private-deployment.md). Apple Silicon pilots additionally have a [reviewed MLX integration](./docs/mlx-apple-silicon.md), [macOS appliance/qualification runbook](./docs/macos-appliance.md), and an evidence-backed [Apple M3 8 GB live pilot report](./docs/macos-m3-live-pilot.md).

## Quick start

Requirements: Node.js 24+, npm, and a writable directory for SQLite.

```bash
npm install
npm run doctor
npm run demo
```

Useful development commands:

```bash
npm test
npm run typecheck
npm run chat
npm run serve
```

`npm run demo` works without a paid key. The sample route uses a deterministic mock adapter, so it validates the harness rather than model quality.

This demo is a development fixture. It is not the private production profile and it does not exercise a real local model.

## Guided setup and terminal mission control

For a real local configuration, run the review-first wizard and then open the full-screen operations console:

```bash
npm install
npm run setup
npm run doctor -- --probe --config openprojects.local.yaml
npm run serve -- --config openprojects.local.yaml
# In another terminal:
npm run tui -- --config openprojects.local.yaml
```

The wizard defaults to a sealed profile: loopback inference, an Apple-Silicon MLX-LM recommendation or hardware-sized local Qwen alternative, Telegram disabled, no hosted fallback, and external writes denied. On POSIX it configures an owner-only Unix control socket and one unscoped `local-admin` principal with the `admin` capability; Windows retains loopback TCP. A Telegram-enabled hybrid plan instead removes `socketPath`, keeps TCP on loopback, and requires a reviewed TLS reverse proxy that forwards **only** `POST /webhooks/telegram`; explicit Telegram-plus-socket plans are rejected. After confirmation, POSIX setup creates mode-`0700` data directories, creates a new control credential exclusively at its final mode-`0600` path and syncs it, then atomically publishes the synced config from a same-directory temporary file. Windows retains exclusive file creation and synced publication but does not claim that Node mode bits establish owner-only access; setup emits an explicit NTFS ACL review step for the config, token, and data paths. It never asks for or serializes a model-provider secret, downloads a model, or starts a daemon. Existing configs are preserved unless `--force` is explicit; forced replacement retains the existing control credential and creates a backup, with mode `0600` enforced only on POSIX and NTFS ACL verification required on Windows.

To inspect exactly what the defaults would generate without prompts or filesystem changes:

```bash
npx tsx src/cli.ts setup --defaults --dry-run
```

Selecting the explicit `llama.cpp` backend is different from the general
defaults: it emits one narrow `project_analysis` qualification route, an exact
CPU-only 53-argument launch command with absolute artifact paths, and the
`eval-local-4gb` handoff. It deliberately does not print the normal
`serve`/`tui` promotion steps or claim supervisor eligibility.

The TUI provides Overview, Runs, Approvals, Memory, and Projects pages, plus an in-place task composer. Its bounded approval queue uses `[`/`]` or PageUp/PageDown to traverse opaque server pages, so older consequential actions do not disappear behind the first snapshot. Approval review displays the canonical argument SHA-256, binds confirmation to that digest, and requires every long-argument page to be reviewed. It honors `NO_COLOR`; `--plain`, `--screen-reader`, redirected streams, and `TERM=dumb` receive a finite read-only summary with no terminal escapes or recovery side effects. TUI content is treated as untrusted and sanitized before rendering. See [Terminal experience](./docs/terminal-experience.md) for the layout, key map, installer invariants, and accessibility behavior.

The service is the sole production runtime and SQLite owner. In the POSIX private profile, `tui` connects through the configured Unix socket; Node's native HTTP client supports `socketPath`, so the same bounded HTTP protocol is carried without opening TCP ([Node HTTP documentation](https://nodejs.org/download/release/latest-v24.x/docs/api/http.html)). A reconnecting workspace stream remains an invalidation signal, so the TUI refreshes a scoped snapshot on connection and change.

The separate API-only per-run SSE endpoint now assigns each durable event `id: <seq>`, accepts a matching `afterSeq` query cursor or `Last-Event-ID`, pages replay from SQLite, subscribes before taking its replay fence, deduplicates replay/live races, and reconnects from the last validated sequence until the run is terminal. This includes transient Unix-socket resets, timeouts, unavailability, and socket errors; protocol failures, authorization errors, consumer-callback exceptions, and other non-retryable responses still fail closed. The client advances its cursor or terminal state only after the consumer successfully accepts that event. The cursor behavior follows the browser event-stream resume convention for `Last-Event-ID` ([WHATWG Server-Sent Events](https://html.spec.whatwg.org/dev/server-sent-events.html)). Server writes honor Node stream backpressure and disconnect clients that exceed bounded frame, queue, or drain limits ([Node stream backpressure documentation](https://nodejs.org/download/release/v24.1.0/docs/api/stream.html)). The TUI still uses workspace invalidation plus fresh snapshots rather than the run stream.

Every process that opens a durable deployment database first exclusively creates and holds the adjacent `<database>.owner.lock`; POSIX enforces mode `0600`, while Windows requires a reviewed NTFS ACL because Node mode bits cannot attest owner-only access there. A second owner fails closed. `tui --standalone`, `chat`, and direct database maintenance/export commands must be used only with `serve` stopped; the owner lock enforces this process boundary. It is never broken automatically after an unclean exit—follow the manual verification and recovery procedure in [Private corporate deployment](./docs/private-deployment.md#runtime-owner-lock-and-manual-recovery).

## Runtime shape

```text
Telegram / CLI / HTTP
        |
        v
session -> supervisor loop -> task-aware router -> local or hosted model
                    |                    |
                    |                    +-> bounded advisory subagents
                    v
           allowlisted tools + approvals
                    |
                    v
          events, usage, cost, feedback
```

Every explicit agent run has a durable run record and append-only events. Before any member of a returned tool-call batch can reach policy, approval, persistence, or execution, the complete batch receives bounded envelope and duplicate-safe strict-JSON preflight. Valid schema-checked input is recursively canonicalized once; its `sha256:` digest follows the same bytes through policy, invocation storage, approval review, restart recovery, and tool execution. Risky tools require that exact digest-bound approval. Whitespace and object-key order cannot change the identity, while top-level, nested, and escape-equivalent duplicate keys fail the whole batch before effects. Passive group observation does **not** create an agent run or call an LLM.

### Compact project-analyst eligibility gate

v0.5 introduced a separately promotable `project-analyst` lane for `project_analysis`. It does not receive supervisor skills or retrieved memory. Its complete tool surface is one no-argument, read-only tool: `project_analysis_snapshot_v1`. The host resolves the project from the durable run, so the model cannot select another workspace or project. The lane is capped at two steps, one tool call, 30 seconds, 4,096 input tokens, and 512 reserved output tokens.

Successful completion requires exactly one completed snapshot call followed by strict `openprojects.project-analysis-result.v1` JSON. The result must keep `actionTaken: false`, cite only task and evidence IDs present in the snapshot, and remain in the run's project scope. Prose, code fences, extra fields, invented IDs, missing calls, additional tools, writes, and approvals fail closed.

`eval-project-analyst` is the live eligibility gate for one reviewed candidate. The source route must advertise only `project_analysis`, be local and zero-cost, and match strong manifest identity material. The evaluator creates an in-memory copy that enables only that exact route, disables exploration, runs text/tool identity preflight, and requires every bounded trial to pass route, tool, result-schema, no-approval, and no-outbox assertions. It explicitly reports the supervisor, semantic-embedding, and vision lanes as `not_evaluated`; passing it never promotes those capabilities or edits the source configuration.

On the recorded M3/8 GB pilot, the pinned 1.7B candidate failed this gate 0/3. The separately pinned `mlx-community/Qwen3-4B-Instruct-2507-4bit` revision `50d427756c6b1b2fe0c0a10f67fbda1fc8e82c1b` passed 3/3: each trial made the one scoped read, returned valid strict JSON, and created no approval or outbox record. That is evidence only for the compact project-analyst lane. Supervisor, semantic embeddings, and vision remain unevaluated; materially increased swap use during the sequential 4B run also leaves no basis for an 8 GB co-residency claim.

### Representative gate, run commitments, and MCP boundary

The versioned representative corpus adds eight deterministic cases across project risk, deadlines, reviewed group memory, exact approvals, prompt injection, and crash recovery. Its exact file SHA-256 is `02213178021dd3070ba7df398e97fcd646a291fa5074d980b944c6ae8791c5ff`; the current deterministic run passed 8/8. Its separately opt-in live lane sent only three analyst prompts to the pinned Qwen 4B route and passed 3/3 in 10,565 ms, 10,472 ms, and 8,976 ms. Each live trial made exactly one scoped read, returned the strict analyst schema, and created no approval or outbox record. Approximate swap growth was 425 MB, reinforcing sequential analyst-only use on this 8 GB host. Supervisor and vision are still unqualified.

New runs also bind three redacted, content-addressed commitments for the effective agent, granted tools, and policy. Prompt/skill/schema bodies are represented by unsalted SHA-256 digests rather than stored in plaintext. These records support identity and fail-closed recovery; they are not signatures, encryption, or a complete executable bundle, and plugin/runtime/model-build identity remains separate.

The reviewed integration layer accepts only fixed local declarations. MCP may use a bounded direct stdio process or exact Streamable HTTP endpoint; JSON API tools use one exact origin plus structural path/query/body mappings. Local schemas, effects, data boundaries, idempotency, timeouts, and byte limits are authoritative, and every call retains the existing grant, monotonic policy, exact approval, recovery, and snapshot path. Remote MCP discovery is used only to verify the configured identity and required names—never to add tools or import authority. There are no resources, tasks, sampling, elicitation, OAuth login/refresh, arbitrary URL tools, OpenAPI import, or model-authored GraphQL/JQL. See [Reviewed MCP and JSON API integrations](./docs/integrations.md) and [Evaluation and extension gates](./docs/evaluation-extension-gates.md).

For framework interoperability without a migration, the isolated [AI SDK + MCP example](./examples/frameworks/ai-sdk-mcp/README.md) projects one fixed-scope `read + run` tool into a two-step local-model loop. It cannot select a workspace/project/principal, resolve an approval, or add tools, and its separate dependency graph does not enter the lightweight runtime.

### Local VLM readiness gate — not product ingestion

`eval-vision` evaluates one exact pinned `mlx-vlm` service without constructing the application, opening SQLite, downloading a model, or changing a route. It first requires healthy exact-model service identity plus complete model and runtime artifact commitments. It then sends one committed PNG at a time through the local VLM adapter, requires strict `openprojects.vision-analysis-result.v1` JSON with `actionTaken: false`, and grades grounding, unsupported claims, multilingual text, visual prompt injection, and category-specific image-dependence counterfactuals. Promotion requires every assertion across at least 50 sequential case attempts; smaller runs are diagnostics only. The wire contract supports an `ambiguous` status, but this v1 corpus does not qualify it.

```bash
npm run eval:vision -- \
  --config /absolute/path/openprojects.vision-candidate.yaml \
  --manifest /absolute/path/appliance-qualification.vision-candidate.json \
  --suite evals/openprojects-vision.v1.json \
  --batches 10 \
  --timeout-ms 300000 \
  --json
```

The report stores hashes, identity evidence, assertions, provenance, and latency—not image bytes or model descriptions. The bundled corpus is synthetic, MIT-licensed, hash-bound, and currently PNG-only; JPEG service decoding remains unqualified. No real VLM was downloaded or run while adding this gate, so the repository records no live vision pass. The first proposed M3/8 GB candidate is the exact `mlx-community/Qwen3-VL-2B-Instruct-4bit` revision `9c4f5209e57b31f4b9dfba735de3fb983739c9cc` on a separately pinned MLX-VLM 0.6.16 runtime, tested alone and sequentially. It remains a candidate until the live gate and host resource stop conditions pass. Product ingestion, OCR, tools, memory, Telegram images, PDFs, remote image URLs, and supervisor vision all remain disabled.

## Configure models and cost routing

The sample [openprojects.config.yaml](./openprojects.config.yaml) defines a zero-cost mock route. The recommended private profile is [examples/openprojects.private.yaml](./examples/openprojects.private.yaml). OpenProjects otherwise speaks OpenAI-compatible Chat Completions over bounded native HTTP, so local runtimes and hosted APIs use the same small adapter rather than provider SDKs. A minimal real local route looks like:

```yaml
routing:
  externalInference: deny
  preferLocal: true
  allowRemoteFallback: false
  dailyBudgetUsd: 2
  explorationRate: 0
  routes:
    - id: local-qualified
      provider: openai-compatible
      baseUrl: http://127.0.0.1:8080/v1
      model: your-qualified-local-model
      generation: reviewed-local-model-2026-08
      local: true
      enabled: true
      quality: 0.75
      tasks: [supervisor, project_analysis, memory_curator, summarization, notification]
      contextWindow: 32768
      inputCostPerMillion: 0
      outputCostPerMillion: 0
```

Remote inference is a separate data-boundary decision. A non-loopback route must use HTTPS, declare `local: false`, name an environment variable through `apiKeyEnv`, set an operator-managed immutable `generation`, and have `routing.externalInference: allow`; inline remote secrets are rejected. With `privacy.localOnly: true`, its exact origin must also appear in `privacy.allowedOrigins`. `preferLocal` defaults to true, exploration stays within the selected local/remote boundary, and a local failure does not become a cloud request unless `allowRemoteFallback: true` is also explicit. Adaptive route statistics are keyed by a SHA-256 identity over the route ID, provider, model, endpoint, boundary, context, tasks, wire profile, and generation, so changing any of those starts a clean learning lane. Budget accounting is an estimate based on operator-maintained per-token prices, not a provider billing guarantee.

The router:

1. keeps routes that support the task, minimum quality, and context;
2. excludes paid routes that would exceed the configured daily estimate;
3. ranks local routes first by default, then scores quality, cost, reliability, latency, and feedback reward;
4. keeps exploration inside one data boundary and only attempts an explicitly allowed fallback after a retryable provider failure.

Optional [FreeToken](https://github.com/FlashML-org/FreeToken) integration now has a strict experimental provider: loopback `/v1` only, no API key, one safe externally pinned `--served-model-name`, exact request/response identity, strict tool JSON, and parallel tool calls disabled. Use a model FreeToken currently lists as supported; its published list does not include Qwen3.8. FreeToken is not a trainer, embedding service, or Whisper replacement. The chosen cross-platform runtime matrix and before-public gates are in [Inference stack and promotion order](./docs/inference-stack.md).

A fuller, disabled-by-default set of local, FreeToken, llama.cpp, [OpenAI](https://platform.openai.com/docs/api-reference/chat/create), [Gemini compatibility](https://ai.google.dev/gemini-api/docs/openai), [Anthropic compatibility](https://platform.claude.com/docs/en/cli-sdks-libraries/libraries/openai-sdk), embedding, and transcription examples is in [examples/model-routes.yaml](./examples/model-routes.yaml). Provider model names, context limits, and prices are placeholders that must be reviewed before enablement. Anthropic describes its OpenAI compatibility layer primarily as a testing/comparison path, so qualify strict tool behavior before relying on it. Merge only routes you have qualified; adding hosted inference changes the deployment boundary. FreeToken has a separate hash-pin template at [examples/appliance-qualification.freetoken.example.json](./examples/appliance-qualification.freetoken.example.json).

### v0.6 configuration sections

| Section | Important fields | Meaning |
| --- | --- | --- |
| `privacy` | `localOnly`, `allowedOrigins` | Fail-closed origin policy for model, embedding, enabled Telegram, MCP HTTP, and JSON API clients owned by the harness |
| `integrations` | `externalDataPolicy`, `manifests[]` | Exact reviewed MCP/JSON manifests plus an independent gate for arguments leaving the host |
| `telegram` | `enabled`, `apiBaseUrl` | Explicit external-transport gate and Telegram-compatible API origin |
| `learning` | `enabled`, `groupObservation`, `minimumSalience`, `feedbackLearningRate`, `retentionDays` | Global learning/observation gates, bounded reinforcement rate, manual-purge retention |
| `embeddings` | `provider`, `model`, `baseUrl`, `dimensions`, `timeoutMs`, `serviceDigest`, `apiKeyEnv`, `generation`, `externalData` | Built-in, digest-pinned Ollama, or explicitly external OpenAI-compatible vector adapter |
| `routing` | `externalInference`, `preferLocal`, `allowRemoteFallback`, `dailyBudgetUsd`, `explorationRate`, `routes[]` | Explicit data boundary plus task/quality/context/cost selection and retry behavior |
| `subagents` | `maxCallsPerRun`, `maxParallel`, `maxDepth` | Advisory-child bounds |
| `notifications` | `enabled`, `intervalMs`, `lookaheadHours` | Deterministic scheduler controls |
| `transcription` | `provider`, `command`, `modelPath`, `ffmpegCommand`, `timeoutMs`, `maxBytes`, `maxDurationSeconds` | Optional local audio limits and binaries |
| `server` | `socketPath`, loopback `host`/`port`, `auth.principals[]` | Private IPC or TCP compatibility transport plus local capabilities and workspace scopes |

Both global learning flags and the persisted per-group admin opt-in must allow observation. Setting either `learning.enabled: false` or `learning.groupObservation: false` prevents Telegram group enablement and observation.

### Reviewed MCP and JSON API integrations

Integration manifests are static operator-owned contracts: exact process or
origin, credential environment reference, local/remote tool names, strict
schemas, effect, data boundary, idempotency, workspace scope, and limits. The
model never chooses URLs, executables, headers, credentials, methods, remote
tool names, GraphQL, or JQL.

Start from the bounded [GitHub, Jira, Slack, Linear, and MCP examples](./examples/integrations/README.md), then validate them without credentials or network access:

```bash
openprojects integrations check --config openprojects.config.yaml
```

An explicit `--probe` resolves credentials; it verifies MCP peer identity and
required tool names, while JSON API probing validates credential availability
and the exact allowed origin without issuing a business request. Provider
permissions, response shape, prompt-injection resistance, approval behavior,
and crash recovery still require staging evaluation. Full contract and current
provider compatibility notes are in [Reviewed integrations](./docs/integrations.md).

### Corporate Oracle and connector sidecars

The Oracle ingestion boundary is different from an agent integration tool. A
provider-specific sidecar owns OAuth or service-account login, token refresh,
pagination, webhooks, rate limits, provider SDKs, and projection of proprietary
payloads. It sends bounded normalized pages to `POST /api/oracle/sync` using a
workspace-scoped principal with only the `ingest` capability. When control auth
is enabled, the principal ID is the source identity; request content cannot
impersonate another connector. Each page must also supply the immutable
provider tenant/account identity as `sourceAccountId`; changing it for an
existing source/stream is rejected. The sidecar can read only its own
source/stream checkpoint through `GET /api/oracle/checkpoint` and cannot search
the Oracle, start runs, approve actions, or mutate memory unless separately
granted.

One page and its checkpoint commit atomically. Before producing each
cursor-bearing page after the first, the sidecar reads `GET
/api/oracle/checkpoint` and supplies that checkpoint cursor as
`previousCursor`; a mismatch fails as a compare-and-swap conflict. An exact
cursor/page replay must preserve the page's original `previousCursor` and is
idempotent; the same cursor with different committed content is rejected.
Schema v11 retains accepted-page identities, so replaying an older accepted
cursor returns the current retained heads without regressing the latest
checkpoint. The predecessor fence also protects the latest checkpoint migrated
from v10 when an unrecorded delayed or concurrent page arrives. Cursorless
webhook pages remain allowed and digest-keyed for exact replay; they do not use
or claim ordered pagination semantics. A record
older than its current `sourceUpdatedAt` is ignored, while different content at
the same source timestamp is a conflict. `sourceUrl` is an optional canonical,
credential-free HTTP(S) path; query strings and fragments are rejected.
Changed records receive a new retained revision and invalidate the old current
embedding. Embedding happens after the ledger commit, so a vector-service
failure cannot lose synchronized evidence or its checkpoint; search falls back
lexically. A later replay automatically fills a missing vector or one stale for
the selected embedding model/content. An admin can repair 1-100 active records
per call with `POST /api/oracle/embeddings/backfill`, optionally scoped to a
source. Temporal searches are lexical
because embeddings bind only current content. `asOf` filters provider state by
`sourceUpdatedAt`; `knownAt` filters by server-owned `observedAt` to reconstruct
what the harness had recorded by that host time. Either or both may be used.

Sync never launches an agent run or chat-completion LLM. Post-commit vector
work may invoke the configured local or explicitly approved cloud embedding
model. The receipt therefore reports `agentRunInvoked: false`,
`chatModelInvoked: false`, and an accurate `embeddingInvoked`; legacy
`modelInvoked: false` is retained and means no agent/chat completion.

This creates two complementary forms of learning over time:

- **Corporate evidence** follows mutable source truth and preserves its
  retained revision history. It is never promoted into instruction authority.
- **Reviewed memory** captures durable decisions, preferences, procedures, and
  lessons only through the existing proposal/review lifecycle. Feedback can
  adjust attributed active-memory and route rewards exactly once, but it does
  not rewrite source facts or update model weights.

The same Oracle and memory planes work with local or explicitly approved cloud
LLMs. Provider API details, the normalized record contract, endpoint matrix,
the [synthetic multi-domain sync fixture](./examples/integrations/oracle-sync.requests.ndjson),
and sidecar promotion gates are documented in
[Reviewed integrations](./docs/integrations.md#corporate-oracle-ingestion-plane).

After a completed `oracle_search`, the durable trajectory marks the entire
session as Oracle-influenced. The monotonic guard converts every later
external-boundary tool—even an external read—and every local effect other than
`read` or `draft` to `ask`, including calls in later runs of that session. The
ordinary canonical-argument, digest-bound exact approval applies to each call;
an approval does not clear the session taint. Local reads and drafts remain
available, and only starting a new session restores the untainted baseline.
This limits action
laundering from hostile source content, but it does not inspect the assistant's
final prose or prove that every material sentence contains the returned
citation.

## Durable learning and memory

Group learning is deliberately conservative:

```text
admin opt-in
   -> redact + deterministic salience test
   -> discard non-salient content
   -> store salient observation
   -> salient inference saved as proposed
   -> admin confirmation
   -> active memory can be retrieved
   -> attributed run feedback updates strength/reward once
```

Salience recognizes explicit decisions, commitments, deadlines, progress, durable preferences, and procedures in English and Russian. Short acknowledgements, bot commands, and instruction-injection-like messages are rejected. Procedures are still `proposed`; they are never self-approved.

The 4 GiB default, `builtin-hash-v1`, is a deterministic in-process 256-dimensional feature hash with no resident model or network call. It is lightweight and offline, but it is not a learned semantic encoder. For stronger multilingual retrieval on a higher-memory machine, run a separately reviewed BGE-M3 lane through Ollama:

```bash
ollama pull bge-m3
```

```yaml
embeddings:
  provider: ollama
  model: bge-m3:latest
  baseUrl: http://127.0.0.1:11434
  serviceDigest: 7907646426070047a77226ac3e684fbbe8410524f7b4a74d02837e43f2146bab
  dimensions: 1024
  timeoutMs: 30000
```

After pinning, qualification, and an explicit promotion decision, build or refresh stored-memory vectors:

```bash
npm run learning:embed
```

The configured dimension must match the vector returned by the embedding server. Retrieval searches only active memories and combines semantic similarity with lexical overlap, memory strength, and learned reward. If query embedding fails, it continues lexically.

Embedding selection is independent from chat routing: a local model can use cloud embeddings, a cloud model can use local embeddings, and both can use the 256-dimensional built-in fallback. The memory rows, activation review, retrieval attribution, and bounded feedback updates remain in the same SQLite control plane regardless of which model answers. This is reviewed memory/RAG feedback—not online RL, prompt mutation, or live weight training.

An external [OpenAI-compatible embeddings endpoint](https://developers.openai.com/api/reference/resources/embeddings/methods/create) requires a second explicit data decision:

```yaml
privacy:
  localOnly: true
  allowedOrigins: [https://api.openai.com]

embeddings:
  provider: openai-compatible
  model: your-reviewed-embedding-model
  baseUrl: https://api.openai.com/v1
  apiKeyEnv: OPENPROJECTS_EMBEDDING_API_KEY
  generation: reviewed-index-2026-08
  externalData: allow
  dimensions: 256
  timeoutMs: 30000
```

The key is resolved from the environment and never belongs in YAML. External embedding sends retrieval queries and sends memory text during `learning embed`; use it only when that disclosure is approved. `generation` is an operator-managed immutable index identity: change it whenever provider weights or aliases may have changed. Changing the embedding identity does not silently re-embed existing rows.

Ollama embeddings require the exact bare lowercase SHA-256 model digest as `embeddings.serviceDigest`; replace the recorded example digest whenever the reviewed artifact changes, and bind the same digest under the manifest's `embeddings` pin. `qualify --require embeddings` verifies that identity and grades four project-domain semantic ranking triplets—12 unit-normalized vectors with per-triplet positive-over-negative cosine margin at least 0.05 and mean margin at least 0.10. Merely returning distinct vectors is not semantic qualification.

On the recorded sealed-local M3 gate, identity-pinned Qwen3-Embedding 0.6B Q8_0 ranked every positive above its negative but failed unchanged minimum-margin policy (approximately 0.009–0.016 versus 0.05; mean approximately 0.116). It remains staged and unqualified. `bge-m3:latest` F16 through pinned Ollama v0.32.15 passed the same 1,024-dimension gate in 1.715 seconds with minimum margin 0.130 and mean 0.205; manifest/model digest `7907646426070047a77226ac3e684fbbe8410524f7b4a74d02837e43f2146bab` matched and cloud access was disabled. The production adapter subsequently completed 50/50 sequential three-text batches without error or dimension drift (69.12 ms p50, 72.76 ms p95, 1,478 ms cold maximum, repeated-input cosine 0.9999997075). A bounded in-memory `MemoryEngine` trial over 12 active project memories and six English/Russian/Azerbaijani queries achieved Recall@1 0.8333, Recall@3 1.0, and MRR 0.9167.

The formal `openprojects.semantic-embedding-eval-report.v1` gate then passed unchanged config and manifest across 10/10 batches with zero errors. Its versioned 10-document/12-query English/Russian/Azerbaijani corpus scored Recall@1 1.0, Recall@3 1.0, and MRR 1.0; minimum repeated-input and cross-batch drift cosine were both 1.0, with 452 ms p50 and 480 ms p95 batch latency. This formally qualifies the exact pinned BGE-M3 artifact for the semantic embedding lane. The higher-memory private example now selects that model, but qualification still does not mutate an installed configuration or re-embed existing memories; deployment and backfill remain explicit operator actions.

Retention purge is manual, not a background schedule:

```bash
npx tsx src/cli.ts learning purge
```

It removes expired group observations, group-derived memories, and observation learning signals according to `learning.retentionDays`. Disabling a group stops future observation and notifications but does not by itself erase retained data. The group-data delete API removes the content records described below, but sanitized inbound-event metadata and some aggregate/learning provenance can remain; v0.6 does not claim a complete participant-erasure workflow.

## Telegram setup

Telegram is outside the sealed private boundary. Enabling it requires an explicit external-origin decision in YAML; environment credentials alone intentionally do nothing:

```yaml
privacy:
  localOnly: true
  allowedOrigins:
    - https://api.telegram.org

telegram:
  enabled: true
  apiBaseUrl: https://api.telegram.org
```

This permits the exact Telegram origin to clients owned by the harness and changes the deployment from “all transport local” to “local AI processing with Telegram transport.” It does not make Telegram on-premises. Keep the hosted model-route list empty if inference must remain local.

Set these environment variables:

```bash
TELEGRAM_BOT_TOKEN=...
TELEGRAM_WEBHOOK_SECRET=...
TELEGRAM_BOT_USERNAME=optional_bot_username
TELEGRAM_ALLOWED_USER_IDS=123456789,987654321
```

`TELEGRAM_ALLOWED_USER_IDS` is a comma-separated operator allowlist and is fail-closed: when it is missing or empty, nobody can use direct messages, bind or disable groups, or activate shared memories. Group binding additionally requires Telegram administrator status. Once bound, ordinary participants in that group may be observed and may explicitly run the bot. Commands addressed to another `@bot_username` are ignored.

Register a webhook pointing to the fixed route:

```text
POST /webhooks/telegram
```

Telegram must send `TELEGRAM_WEBHOOK_SECRET` in `X-Telegram-Bot-Api-Secret-Token`; the secret is never duplicated in the URL. The service still binds only to loopback in this hybrid mode. Put a reviewed TLS reverse proxy in front of it and expose exactly that POST route—never `/api/*`, `/health`, or dashboard/static paths. Service startup rejects every configuration that combines enabled Telegram with `server.socketPath`, because the current process does not provide a separate network webhook listener.

To observe ordinary group messages, disable Telegram BotFather privacy mode for the bot. OpenProjects still ignores group messages and explicit run commands until an allowlisted operator who is also a Telegram administrator opts that group in.

Group commands:

| Command | Who | Effect |
| --- | --- | --- |
| `/openprojects_enable [project-id]` | Allowlisted operator + Telegram admin | Enables learning and notifications for the group and posts a notice |
| `/openprojects_disable` | Allowlisted operator + Telegram admin | Stops new group learning and notifications; does not purge retained records |
| `/openprojects_privacy` | Anyone | Shows the privacy/retention notice |
| `/remember <fact>` | Anyone in an enabled group | Submits an explicit candidate; activation requires an allowlisted operator who is also a Telegram admin |
| `/op <question>` | Anyone in an enabled group; allowlisted operators in DMs | Starts an explicit agent run |
| `/openprojects_status` | Anyone in an enabled group; allowlisted operators in DMs | Starts a project-status run |

Mentioning or replying to the bot in an enabled group also starts an explicit run. Only allowlisted operators can start direct-message runs. Passive messages in an opted-in group are observed without model inference.

Voice/audio uses the local transcriber only when a message has no text or caption. To enable `whisper.cpp`:

```yaml
transcription:
  provider: whisper-cpp
  command: whisper-cli
  ffmpegCommand: ffmpeg
  modelPath: /absolute/path/to/ggml-base.bin
  timeoutMs: 180000
  maxBytes: 25000000
  maxDurationSeconds: 1200
```

Install [whisper.cpp](https://github.com/ggml-org/whisper.cpp), its model, and FFmpeg separately. Raw Telegram audio is converted in a temporary directory and removed; an opted-in transcript can remain as a group observation under the normal retention policy.

## CLI

Run commands through the project entry point, for example `npm run learning:stats`. For commands without a package shortcut, use `npx tsx src/cli.ts <command>` during development or the built `openprojects` binary.

| Command | Behavior |
| --- | --- |
| `setup` / `init` | Runs the reviewed installation wizard; `--defaults --dry-run` produces the sealed plan without writing |
| `tui` | Attaches mission control to the configured Unix socket or loopback compatibility service; use `--principal <id>` when multiple principals exist; `--standalone` (and `tui --demo`) directly owns storage for development only, while non-TTY execution emits one read-only summary |
| `serve` | Starts the sole runtime owner, HTTP control plane, Telegram webhook, and eligible notification scheduler; `--demo` explicitly adds Atlas fixtures |
| `demo` | Runs the deterministic no-key demo |
| `chat` | Opens a direct-runtime development session; stop `serve` before pointing it at a durable deployment database |
| `eval` | Runs the deterministic mock-model, in-memory harness regression suite; its copied configuration removes live routing, so it cannot qualify or contact the configured model |
| `eval-harness-footprint -c <config>` | Measures the final built core lifecycle and enforces fixed RSS/startup/SQLite/run/shutdown/isolation/cleanup ceilings; it never qualifies a model |
| `eval-local-4gb -c <config> -q <qualification> -d <deployment>` | Qualifies one already-running, source/hash/argv/PID/namespace-bound analyst route with negative-auth and kernel cgroup/swap/soak evidence; macOS reports only non-certifying app-budget evidence |
| `eval-representative [--live ...]` | Runs the eight-case offline safety/durability corpus; only an explicit `--live` plus candidate config, manifest, and exact route adds the three isolated analyst prompts |
| `eval-project-analyst -c <config> -m <manifest> -r <route>` | Runs the route-isolated live `project_analysis` eligibility gate; requires a `project_analysis`-only route, strong identity pin, and a 100% trial pass rate |
| `eval-semantic-embeddings -c <config> -m <manifest> [--batches 2-10]` | Runs the pinned, versioned live EN/RU/AZ semantic-retrieval and stability gate without persistent state writes, downloads, route mutation, text-model requests, or promotion |
| `doctor` | Reports versioned readiness; `--probe` makes bounded model/embedding requests and checks storage, local transcription prerequisites, control auth, bind, privacy, and action policy |
| `qualify` | Runs selected sealed-local capability and identity lanes without opening SQLite or requesting a pull/install; MLX requires a reviewed `--manifest` with canonical `servedModelId` and a complete snapshot inventory |
| `integrations check [--probe]` | Validates reviewed MCP/JSON manifests offline; explicit `--probe` resolves credentials and starts/verifies configured peers without executing a business tool |
| `learning stats` | Shows memory/group aggregates, learning-signal count, and route statistics; direct database owner, so stop `serve` first |
| `learning embed [-w <workspace>] [-p <project>]` | Backfills missing embeddings; direct database owner, so stop `serve` first |
| `learning export [-f rewards\|sft\|preferences\|all] [--manifest]` | Writes deterministic JSONL to stdout, or prints only the manifest; direct database owner, so stop `serve` first |
| `learning purge [-w <workspace>]` | Applies configured retention; direct database owner, so stop `serve` first |
| `notify [--as-of <ISO time>]` | Plans notifications only and never sends them; direct database owner, so stop `serve` first |
| `export-feedback` | Deprecated direct-database alias for the secret-redacted rewards export; stop `serve` first and note that comments are omitted |

## HTTP API

The v0.6 surface plus the unreleased Corporate Oracle endpoints includes:

| Method and path | Purpose |
| --- | --- |
| `GET /health` | Unauthenticated local readiness metadata; Unix socket permissions still gate the private profile |
| `GET /api/meta`, `GET /api/whoami` | Runtime metadata without `agent.system` or any subagent `system`, plus the authenticated principal's safe grants/scope (`read`) |
| `GET /api/tui/snapshot` | Fetch one workspace-scoped mission-control snapshot with bounded `approvalLimit` and opaque `approvalCursor` paging |
| `GET /api/projects` | Projects and tasks |
| `GET /api/memories` | Query memories |
| `POST /api/oracle/sync` | Commit one bounded normalized, `sourceAccountId`-bound connector page plus its resume checkpoint (`ingest`); each cursor-bearing page after the first CAS-binds `previousCursor` to the current checkpoint, while cursorless webhook pages remain digest-keyed; no agent/chat model is invoked, while post-commit embedding may use the configured local/approved-cloud adapter and is reported separately |
| `POST /api/oracle/embeddings/backfill` | Admin-only repair of 1-100 missing or selected-model/content-stale current embeddings, optionally scoped by source; no agent/chat model is invoked |
| `GET /api/oracle/checkpoint` | Read the calling ingest principal's source/stream checkpoint so a sidecar can resume safely (`ingest`) |
| `GET /api/oracle/search`, `GET /api/oracle/sources` | Search current or historical cited corporate evidence using optional provider `asOf` and/or harness `knownAt` bounds, and inspect stream freshness (`read`) |
| `GET /api/oracle/records/:id/history` | Inspect bounded retained revisions for one workspace-scoped corporate record (`read`) |
| `DELETE /api/oracle/sources/:source/data` | Explicitly erase one source or stream, including retained revisions, current embeddings, and checkpoints (`admin`) |
| `POST /api/memories/:id/status` | Workspace-scoped `admin` activation or archival of proposed memories |
| `GET /api/groups`, `POST /api/groups` | Inspect scoped group bindings; bind/rebind requires an unscoped `admin` |
| `DELETE /api/groups/:id/data` | Delete that group's observations, derived memories, and non-sending notifications, then retain the binding disabled |
| `GET /api/learning/stats` | Learning statistics |
| `POST /api/learning/purge` | Apply retention |
| `GET /api/learning/export?kinds=rewards,sft,preferences&includeComments=false` | Generate deterministic export candidates with an unscoped `admin`; manual review remains required |
| `GET /api/notifications` | Inspect durable notification state |
| `POST /api/notifications/tick` | Execute a scheduler tick with an unscoped `admin` and potentially send Telegram messages |
| `GET /api/runs`, `POST /api/runs`, `GET /api/runs/:id` | Create synchronously and inspect runs; exact-run inspection includes verified redacted agent/tool/policy `snapshotDocuments` when bound |
| `POST /api/runs/async` | Persist a run and return its ID immediately while bounded execution continues |
| `GET /api/runs/:id/events/stream` | Page durable events after `afterSeq` or `Last-Event-ID`, emit `id: seq`, then stream deduplicated live events and a bounded run snapshot until terminal state |
| `GET /api/events/stream` | Stream live workspace invalidations only; clients refresh their scoped snapshot on connection, change, and reconnect |
| `POST /api/runs/:id/feedback` | Record run feedback and bounded reinforcement |
| `GET /api/approvals`, `POST /api/approvals/:id` | Inspect an indexed workspace queue with bounded `limit`/opaque `cursor` pages (`read`), or synchronously resolve an exact approval (`read` + `approve`); a bound row requires the reviewed `argumentsDigest` |
| `POST /api/approvals/:id/async` | Commit a digest-bound decision and resume bounded execution asynchronously; resolution requires both `read` and `approve` |
| `POST /api/events` | Ingest a principal-namespaced, deduplicated control event and return only a minimal dedupe/run-link receipt |
| `GET /api/feedback/export` | Legacy alias backed by the redacted rewards exporter; `format=jsonl` returns redacted JSONL |
| `POST /webhooks/telegram` | Fixed Telegram ingress authenticated only by `X-Telegram-Bot-Api-Secret-Token` |

When `server.auth` is configured, every `/api/*` request and SSE connection requires a protected Bearer credential and mutation identity comes from its authenticated principal, not from request bodies. The backward-compatible legacy form `{tokenFile, operatorId}` is normalized to one unscoped principal with every capability. The least-privilege form is:

```yaml
server:
  socketPath: /var/lib/openprojects/control.sock
  auth:
    principals:
      - id: atlas-reader
        tokenFile: /var/lib/openprojects/atlas-reader.token
        capabilities: [read]
        workspaces: [atlas]
      - id: local-admin
        tokenFile: /var/lib/openprojects/control.token
        capabilities: [admin]
```

Capabilities are `read`, `run`, `ingest`, `approve`, and `admin`; `admin` implies all capabilities. `read` covers ordinary GET/SSE inspection, `run` starts runs and records feedback or inbound events, and `ingest` is the narrow connector-sidecar grant for Oracle sync plus that principal's checkpoint. It does not grant Oracle search. Exact approval resolution requires **both** `read` and `approve` so an approve-only credential cannot receive run context/output as a side channel. `admin` covers sensitive memory/group/source-data mutation, purge, notification tick, and export operations. A present `workspaces` list must be non-empty and restricts access to exact workspace IDs; omission means all workspaces. Global exports, notification ticks, a purge without `workspaceId`, and binding/rebinding a provider-global external group identity require an unscoped admin. Group list/delete remains workspace-scoped, and an existing external group cannot be migrated across workspaces. This is local configuration-based RBAC and least-privilege enforcement in the ordinary senses described by [NIST's RBAC definition](https://csrc.nist.gov/glossary/term/role_based_access_control) and [least-privilege control guidance](https://nvlpubs.nist.gov/nistpubs/SpecialPublications/800-171r3/NIST.SP.800-171r3.html).

For `POST /api/events`, the caller-supplied `source` is data rather than adapter authority. The server stores it as `control-api/<base64url-principal>/<base64url-source>`, so a control client cannot impersonate the verified Telegram namespace or collide with another principal. Deduplication then uses workspace, namespaced source, and key. Any requested project is validated inside that workspace before the durable dedupe key is consumed, allowing a corrected retry with the same key. Responses are deliberately minimal receipts—`duplicate` plus optional `runId` and relative status/event links—not a full `RunOutcome`.

The TUI refuses to guess when more than one principal is configured: select one with `--principal <id>`. It displays the authenticated principal and disables run or approval actions that its grants do not allow; the server remains authoritative. This is **service-credential RBAC**, not per-human identity. Anyone allowed to run the CLI as the service UID and read its configuration/token files can select any configured principal unless the audited sudo rule or a fixed wrapper pins `--principal` and the config path. Principal IDs are labels attached to replayable token files, not proof of the human using them. v0.6 has no SSO, corporate-directory binding, per-human attestation, token expiry, or online rotation/revocation; replacement is a coordinated protected-file update plus service restart.

Legacy configs without `server.auth` remain unauthenticated for local development only. The POSIX private profile instead combines Bearer authorization with an owner-only Unix socket in a mode-`0700` directory; Node documents pathname-based Unix listeners and notes that a crash can leave their path behind ([Node Net documentation](https://nodejs.org/api/net.html)). OpenProjects refuses any pre-existing socket leaf and requires [explicit verified stale-socket recovery](./docs/private-deployment.md#unix-control-socket-and-manual-recovery). Loopback TCP remains a development/compatibility option, refuses non-loopback binds, and does not authenticate the process holding the port back to the client. Static assets and `/health` do not require a Bearer token on either transport; Unix socket filesystem permissions still gate access in the private profile, and ordinary browsers cannot address that socket, so use the TUI for administration.

## Notifications

Notifications are model-free templates derived from confirmed tasks. The scheduler covers approaching and overdue deadlines plus blocked work, writes a durable notification before sending, and uses a group/task/kind/day idempotency key.

Delivery outcomes are intentionally conservative:

- `sent`: Telegram acknowledged the send.
- `failed`: a known send failure; not retried automatically.
- `unknown_outcome`: the process stopped after claiming the row but before recording Telegram's outcome; never retried automatically to avoid duplicate messages.

The scheduler starts with `serve` only when notifications are enabled and Telegram delivery is configured. Routine shutdown first disables future scheduler ticks and gives any claimed delivery a fixed settlement budget. A timeout durably becomes `unknown_outcome` before the sender is aborted, and a detached non-cooperative sender is barred from later database writes; it is never converted into an ordinary failed delivery or retried automatically. Transport cleanup still runs if durable classification itself fails. There are no quiet hours or per-user notification preferences in v0.6.

`serve` applies a 30-second outer shutdown watchdog. SQLite is closed only after tracked service work settles; a non-cooperative operation instead causes a hard process stop with explicit stale owner-lock/socket recovery guidance.

## Feedback export and the training boundary

The live harness never changes weights. It can produce deterministic, secret-redacted candidate datasets:

- `rewards`: feedback joined with a recorded run output;
- `sft`: a human correction used as a candidate target;
- `preferences`: only when an original output, a distinct correction, and negative feedback are all present.

Each dataset and the overall manifest receive SHA-256 digests. Export is a boundary, not a programmatic review gate or consent record: the current runtime schema has no `review_status` or dedicated “approved for training” flag. A human must review scope, privacy, provenance, licenses, poisoning, and redaction before copying explicit row IDs into the separate training review file.

The optional [reviewed local fine-tuning lab](./training/README.md) then verifies that review, the source manifest, every dataset digest and every approved row before creating MLX-LM `train.jsonl` plus a separately sealed, source-group-held-out `holdout.jsonl` that MLX never receives. Its default model for this M3/8 GB host is the official 4-bit `Qwen/Qwen3-1.7B-MLX-4bit`, configured as a narrow QLoRA experiment with batch size 1, four adapted layers, rank 8, 1,024-token sequences, prompt masking, and gradient checkpointing.

The example deliberately requires 150 approved rows—enough only for a 100-train/50-held-out learnability experiment—and training remains disabled in the config. Validation and planning do not start MLX:

```bash
python3 -m training.prepare_dataset --config training/config.example.json --check
python3 -m training.run_mlx_lora --config training/config.example.json
npm run test:training
```

Starting it requires a local snapshot whose exact files match the reviewed Qwen commit lock, `mlx.enabled: true` in a copied reviewed config, and an explicit `--execute`. Immediately before training, the exact local tokenizer and chat template must accept every training row within a 960-token envelope and preserve at least 16 supervised completion tokens. The pinned MLX runtime runs in isolated Python mode, cannot be shadowed from the config directory, and is identity-checked with the model and training data before and after the attempt. The child is forced offline and never resumes an interrupted adapter. Even after a zero exit, a strict Safetensors/config postflight must prove structural consistency and finite FP16/BF16/FP32/FP64 adapter values; the result is still only `candidate_unverified`. Current MLX-LM has an open report of non-finite Qwen3-1.7B LoRA gradients, so loss alone remains insufficient. The lab never reads the database, runs DPO/RL, fuses or uploads weights, serves the adapter, edits model routes, or promotes a checkpoint. See the complete [training safety contract](./docs/training-safety.md) before collecting data or enabling execution.

## Implemented, optional, and future

- **Implemented/default:** SQLite durability through schema v11 with exclusive runtime-owner locking, supervisor loop, approvals, paged TUI approval traversal, deterministic mock route, the eight-case representative safety/durability corpus, redacted content-addressed run commitments, fail-closed loopback-or-exact-origin HTTP policy, protected POSIX Unix control socket, local capability/workspace enforcement including ingest-only connector principals, the versioned Corporate Oracle ledger, accepted-page replay and checkpoint-CAS safety, Unicode candidate indexes, embedding repair, read-only cited Oracle tools, and post-search session taint, one shared core run permit, globally capped/resumable bounded run SSE, finite prompt/collection reads, Telegram disabled, opt-in group observation, proposed-memory review, feature-hash embeddings, hybrid retrieval, attributed feedback reinforcement, bounded advisory specialists, the fail-closed one-tool project-analyst lane and its isolated live gate, deterministic notification state, JSONL export.
- **Implemented/optional:** hosted or local OpenAI-compatible routes, strict loopback MLX-LM text/tool inference, an authenticated alias-bound `llama.cpp` adapter and standalone whole-process 4 GiB gate, strict singleton/alias-bound FreeToken inference with mock conformance evidence, exact reviewed corporate origins, local Ollama or explicitly external OpenAI-compatible semantic embeddings, `whisper.cpp`, explicitly enabled Telegram delivery, reviewed static MCP stdio/Streamable-HTTP and declarative JSON API integrations behind existing policy/approval controls, no-pull appliance qualification, macOS `launchd` templates, and a separate fail-closed reviewed MLX QLoRA lab.
- **Not implemented:** bundled or live-qualified provider Oracle sidecars, a 4 GiB Oracle workload claim, generic final-prose citation validation, autonomous source-to-memory promotion, online reinforcement learning, automatic fine-tuning or checkpoint promotion, a durable consent/revocation training ledger, a production base-versus-candidate promotion runner, dynamic MCP tools/resources/prompts/tasks/sampling/elicitation or harness-owned OAuth, generic fetch/OpenAPI import, Restate/Temporal migration, silent group surveillance, unbounded/autonomous worker agents, arbitrary shell tools, semantic secret classification, automatic retention scheduler, quiet hours, SSO/per-human identity proof, online token lifecycle management, or a public multi-tenant control plane.

## Open source and licensing

OpenProjects' original source code and documentation are available under the
[OSI-approved MIT License](./LICENSE). Contributions are accepted under the
same terms; see [CONTRIBUTING.md](./CONTRIBUTING.md) and
[GOVERNANCE.md](./GOVERNANCE.md).

The project license does **not** relicense third-party packages, local model
weights, datasets, runtimes, FFmpeg builds, hosted services, or quantized model
artifacts. They retain their own licenses and terms. The reviewed dependency and
model boundary is recorded in [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).

Local databases, credentials, model weights, Python environments, appliance
state, and reviewed learning exports are covered by Git ignore rules and the
npm allowlist. In an initialized Git checkout, the release audit additionally
rejects any such path that was force-tracked despite the ignore rules. Do not
publish the working folder as a ZIP. Verify a release with:

```bash
npm run check:release
npm run test:package
npm pack --dry-run --json
```

The package remains `private: true` intentionally: that prevents accidental npm
publication while the npm namespace, maintainer policy, 2FA/OIDC controls, and
publishing provenance are selected. The source repository is
[MaxJafar/openprojects-harness](https://github.com/MaxJafar/openprojects-harness),
and `private: true` does not restrict use of that public source under MIT. See the
[open-source release checklist](./docs/open-source-release.md) for the remaining
repository-owner decisions.

## Documentation

- [Open-source release checklist](./docs/open-source-release.md)
- [Cross-platform qualification](./docs/cross-platform-qualification.md)
- [Private corporate deployment](./docs/private-deployment.md)
- [MLX on Apple Silicon](./docs/mlx-apple-silicon.md)
- [macOS appliance and qualification](./docs/macos-appliance.md)
- [Apple M3 8 GB live pilot results](./docs/macos-m3-live-pilot.md)
- [Evaluation, run commitments, MCP, and workflow-engine gates](./docs/evaluation-extension-gates.md)
- [Evidence-driven product roadmap](./docs/roadmap.md)
- [Reviewed MCP and JSON API integrations](./docs/integrations.md)
- [Terminal experience and setup wizard](./docs/terminal-experience.md)
- [Architecture](./docs/architecture.md)
- [Research and claim audit](./docs/research.md)
- [Reviewed local fine-tuning lab](./training/README.md)
- [Training safety and promotion gates](./docs/training-safety.md)
- [Security policy](./SECURITY.md)
- [Contribution guide](./CONTRIBUTING.md)
- [Third-party notices](./THIRD_PARTY_NOTICES.md)

v0.5 added reviewed static MCP stdio/Streamable-HTTP and declarative JSON API integrations, independent external-data/workspace gates, offline validation with explicit live probing, and manifest-bound run commitments. v0.6 adds the standalone local-VLM readiness gate and strict ephemeral media/adapter foundation without opening a product ingestion path. Unreleased schema v10 adds normalized Oracle ingest, temporal retained revisions, current heads, checkpoints, and read-only cited retrieval; schema v11 hardens accepted-page replay and cursor-chain CAS safety, Unicode candidate selection, embedding repair, URL handling, and post-search session approval. Generic prose citations are still not mechanically enforced, and no provider sidecar or 4 GiB Oracle deployment has been live-qualified. The recorded M3/8 GB evidence supports only the exact sequential lanes described above: BGE-M3 is qualified for semantic embeddings and pinned Qwen 4B passed the compact analyst corpus, while deployment promotion and memory re-embedding remain explicit operator actions. No live VLM result exists yet; the supervisor and product vision remain unqualified, and no Restate/Temporal migration is justified without the documented measured trigger.
