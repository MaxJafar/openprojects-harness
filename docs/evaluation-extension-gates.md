# Evaluation and extension gates

Status: implemented stage and promotion boundary, recorded 2026-08-25. This document separates deterministic harness evidence, live-model evidence, content identity, and future architecture decisions.

## Stage decision

OpenProjects has not migrated to an agent framework or workflow engine. The authority-bearing path remains the existing `AgentRuntime`, `HarnessKernel`, policy/approval kernel, and single-owner SQLite store. This stage adds three things around that path:

1. a versioned representative evaluation corpus;
2. three redacted content-addressed execution-contract commitments on each newly allocated run;
3. a narrow, locally declared MCP `tools/call` adapter that becomes an ordinary kernel tool.

None of these additions changes who may authorize an action. Learning remains reviewed memory plus offline dataset preparation; it does not mutate prompts, policy, permissions, or model weights during a live run.

## Representative evaluation corpus

[`evals/openprojects-representative.v1.json`](../evals/openprojects-representative.v1.json) is schema `openprojects.representative-eval-corpus.v1`, version `1.0.0`. Its exact file SHA-256 is:

```text
02213178021dd3070ba7df398e97fcd646a291fa5074d980b944c6ae8791c5ff
```

The eight deterministic cases cover every required category:

| Category | Cases | Host-owned outcome checked |
| --- | ---: | --- |
| Project risk | 1 | Evidence-grounded high-risk result, scoped task/evidence IDs, no outbox write |
| Deadlines | 1 | Fixed due date and critical-path task grounding |
| Group memory | 1 | Secret redaction, replay deduplication, `proposed` status, exclusion from retrieval |
| Approvals | 2 | Rejection produces no effect; approval executes the exact external write once |
| Prompt injection | 2 | Unsafe group instruction is not learned; retrieved hostile text has no tool authority |
| Crash recovery | 1 | A resolved approval recovers once without a duplicate effect |

Run the guaranteed-offline lane with:

```bash
npx tsx src/cli.ts eval-representative \
  --config openprojects.config.yaml \
  --suite evals/openprojects-representative.v1.json \
  --json
```

This lane deliberately removes configured routing, uses the deterministic `mock/project-ops-v1` adapter, in-memory SQLite, `builtin-hash-v1`, and disabled external integrations. It passed **8/8**. This proves the fixed host behavior represented by the corpus; it does not qualify a real model.

The live lane is separately opt-in and accepts only the three corpus cases marked for project-analyst evaluation:

```bash
npx tsx src/cli.ts eval-representative \
  --config openprojects.config.yaml \
  --suite evals/openprojects-representative.v1.json \
  --live \
  --live-config /path/to/reviewed-candidate.yaml \
  --manifest /path/to/reviewed-manifest.json \
  --route project-analysis-only-route \
  --json
```

`--live-config`, `--manifest`, and `--route` are rejected as inert unless `--live` is explicit. The candidate still passes the existing strong identity/text/tool preflight and the route-isolated project-analyst contract. The live cases are not model implementations of group-memory review, approval, or crash recovery; those remain deterministic kernel gates.

On the recorded Apple M3 / 8 GB host, the exact pinned Qwen 4B analyst route passed **3/3** live representative cases in **10,565 ms**, **10,472 ms**, and **8,976 ms**. Every case selected that route, made exactly one host-scoped `project_analysis_snapshot_v1` read, returned strict grounded `openprojects.project-analysis-result.v1` JSON, and produced zero approvals and zero outbox records. Approximate swap use increased by **425 MB** during this sequential run, so the result supports sequential analyst-only use on that host—not concurrent residency with the semantic embedder, Whisper, a VLM, or a supervisor. Supervisor and vision remain unqualified.

A corpus pass is evidence for this exact corpus, code, configuration, model identity, and hardware posture. It is not a general safety proof, a model promotion, or permission to weaken a gate after a failure.

## Redacted content-addressed run commitments

Every newly allocated run record is bound to three `openprojects.run-snapshot.v1` SHA-256 addresses. Ordinary supervisor and subagent runs capture the effective contract; direct storage-only bookkeeping/test callers receive explicit `capture: compatibility` documents rather than a false claim that unknown state was captured. Pre-migration rows remain readable without bindings.

| Commitment | Redacted content |
| --- | --- |
| `agent` | Agent ID/version/name, budgets, task/runtime profile, skill/tool grants, and SHA-256 commitments to system prompt, skill text, and any final-output validator |
| `tools` | Exact granted tool names, effects, idempotency, timeouts, and SHA-256 commitments to descriptions, input/output schemas, and transport-specific snapshot bindings |
| `policy` | Effect decisions, deny-ungranted posture, tool grants, and the stable IDs of participating policy-guard plugins |

The canonical documents live once in `run_snapshot_documents`; each run stores the three immutable digests. An existing digest must resolve to the exact same kind, schema, and canonical bytes. Recovery verifies stored documents and refuses to resume an ordinary runtime run when its current agent/tool/policy commitments differ.

Canonical encoding uses a strict deterministic JSON subset: recursively UTF-16-sorted object keys, plain records and dense arrays, finite/safe numbers, paired Unicode surrogates, and no accessors, symbols, hidden properties, cycles, sparse arrays, non-finite values, or negative zero. [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785.html) informs the deterministic content-addressing goal, but OpenProjects intentionally does **not** claim full RFC 8785/JCS conformance.

These are redacted commitments with important limits:

- SHA-256 addresses prove local byte identity, not who authored, reviewed, or signed the content. They are hashes, not digital signatures, trusted timestamps, or an append-only transparency log.
- Prompt, skill, description, and schema bodies are not copied into snapshot documents, so the records alone cannot reconstruct the full executable prompt/tool bundle.
- The commitments are unsalted. Avoiding plaintext storage is not encryption: someone with likely candidate text can hash guesses and compare them. Protect the database as sensitive data.
- Plugin code, host runtime/build identity, dependency lock, model artifact/runtime identity, and external transport implementation are outside these three documents. Model qualification manifests and deployment provenance remain separate requirements.
- A digest collision check detects an inconsistent local row; it does not protect against a hostile process with the same database/filesystem privileges.

## Narrow MCP tool gateway

The implemented MCP seam is intentionally `tools/call`-only. A reviewed operator supplies a fixed local declaration for every exposed tool: local and remote names, description, strict input/output object schemas, effect, idempotency, timeout, and request/response/text byte limits. Dynamic server metadata and annotations cannot grant authority. MCP tools then enter the ordinary kernel registry, agent grant check, monotonic policy guards, exact durable approval, timeout/ambiguity handling, result-schema validation, and run snapshots.

The gateway accepts only bounded text blocks plus required JSON-object `structuredContent`; text is validated for protocol hygiene but is not exposed as the tool result. Remote and transport error text is replaced with stable local errors. The stable gateway/transport ID, exact remote name, and limits are committed in the tool snapshot binding, so a changed remote binding cannot silently resume an old approved call.

v0.5 added reviewed, lifecycle-owned stdio and Streamable HTTP clients. They use
bounded initialization and `tools/list` only to verify the configured peer
identity and presence of each exact allowlisted name; remote schemas and
annotations never register tools or grant authority. Stdio receives literal
argv and an explicit empty-by-default environment. HTTP is fixed to one
reviewed endpoint, denies redirects, and supports only an optional loopback
connection or an environment-backed static Bearer token. Both enforce wire,
timeout, concurrency, and teardown bounds before the gateway's materialized
response checks.

This remains deliberately narrower than a general MCP client. It has no
list-change subscription, prompts, resources, resource links, sampling,
elicitation, task-augmented execution, OAuth/refresh flow, credential broker,
automatic registry installation, remote policy, or server trust decision.
See [the reviewed integration contract](./integrations.md) for configuration,
JSON API tools, operator probes, popular-provider compatibility, and known
identity/process-isolation limits.

The stable MCP specification describes tools as model-controlled and says clients must treat tool annotations as untrusted unless the server is trusted ([server overview](https://modelcontextprotocol.io/specification/2026-07-28/server/index), [tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)). It also makes [transports](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports), [authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization), and experimental [tasks](https://modelcontextprotocol.io/specification/2026-07-28/basic/utilities/tasks) separate protocol surfaces. OpenProjects therefore does not acquire those surfaces implicitly.

The configured transports enforce byte limits while reading from the
pipe/socket. Promotion still requires a provider-specific staging call and the
representative approval, injection, output-shape, and crash/ambiguous-outcome
gates; an initialize/tool-name probe alone does not qualify business behavior.

## Local VLM readiness gate

`eval-vision` is a standalone evaluation path, not an agent capability. It reads
one reviewed config, one strict qualification manifest, and the versioned
`openprojects.vision-eval-corpus.v1`; verifies their hashes and every fixture;
requires exact MLX-VLM health, singleton served-model identity, resolved
credential, complete model inventory, and hash-bound runtime evidence; then
sends one inline PNG at a time through the strict local adapter. It never
constructs `OpenProjectsApp`, opens SQLite, downloads a model, changes a route,
calls a tool, creates an approval, writes an outbox row, or persists pixels or
model descriptions.

The corpus contains synthetic MIT-licensed EN/RU/AZ project cards covering
grounding, unsupported claims, visual prompt injection, and paired
same-prompt/different-image counterfactuals for every claimed category. The
wire contract supports `ambiguous`, but this v1 corpus does not qualify that
status. Per-batch case order is randomized
and recorded so a fixed response sequence cannot qualify as image grounding.
Every result must match the strict schema, keep `actionTaken: false`, and pass
all case assertions. Promotion requires a 100% pass rate, no errors, unchanged
source bindings, differentiated counterfactual outputs, and at least 50
sequential attempts. Static fixture memorization remains a benchmark-
contamination risk; candidate evaluation must retain the exact corpus and model
hashes and should be complemented by privately held fixtures before deployment.

The bundled corpus is PNG-only. The media foundation structurally validates
JPEG containers, but no current report qualifies JPEG service decoding. No real
VLM has been run for v0.6, so the repository contains a gate, not a passing
vision claim. The proposed first M3/8 GB candidate is the exact pinned Qwen3-VL
2B 4-bit snapshot, run alone under a separately pinned MLX-VLM 0.6.16 runtime;
Qwen3.5 2B remains a challenger. Product ingestion, persistence, OCR, remote
URLs, PDFs, Telegram media, tools, memory, and supervisor vision remain outside
this gate.

## Workflow-engine migration gate

There is no Restate or Temporal dependency or prototype in the product path. SQLite plus one owner remains the simpler boundary while it meets the appliance's measured needs. A workflow-engine spike may begin only when all of the following evidence exists:

1. A named production requirement defines the target availability, recovery time, recovery point, peak concurrency, and durable-wait volume.
2. A repeatable load/restart benchmark at forecast peak misses that target in at least three consecutive runs, and profiling attributes the miss to the single SQLite writer/owner or single-host recovery—not model latency, an external API, tool code, or an unbounded client.
3. WAL/index/query tuning, bounded batching, backpressure, and process supervision have been measured and cannot meet the target without violating current durability or policy invariants.
4. The requirement genuinely needs multi-process/multi-host coordination, automatic host-failure recovery, or durable cross-service timers; novelty or framework popularity is not a trigger.
5. The operator accepts the added service, identity, backup, upgrade, monitoring, and incident-recovery surface.

If those gates open, the prototype stays outside the production authority path until it demonstrates:

- 8/8 deterministic representative-corpus parity plus the relevant pinned live-model gate;
- exact approval binding, policy monotonicity, model-order tool results, snapshot commitments, crash recovery, and ambiguous-external-effect behavior;
- no weaker local/private deployment posture;
- measured improvement against the failed SLO on the same workload, with total operational cost recorded.

[Restate durable steps](https://docs.restate.dev/develop/ts/durable-steps), [actions](https://docs.restate.dev/foundations/actions), and [architecture](https://docs.restate.dev/references/architecture) are relevant research for durable service handlers. [Temporal's platform documentation](https://docs.temporal.io/) is relevant research for durable workflow execution. Neither source is evidence that migration benefits this local single-owner appliance today; selection belongs after the trigger benchmark, not before it.

## Learning and fine-tuning gate

“Learning” in the live product means consent-gated observations, proposed memories, explicit activation, retrieval attribution, bounded memory reinforcement, route telemetry, and deterministic offline export. It does not mean online RL, autonomous prompt evolution, policy mutation, or live weight updates.

Fine-tuning begins only with clean, purpose-authorized examples that have passed the existing explicit review and digest checks. The current lab can produce only a local `candidate_unverified`; promotion still requires the separate data-volume, contamination, chronological split, base-versus-candidate evaluation, canary, and rollback gates in [Training safety and promotion gates](./training-safety.md). The representative corpus belongs in that promotion suite, but passing eight deterministic host cases or three analyst prompts is not sufficient to promote a checkpoint.
