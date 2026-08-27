# Research: agent harnesses, local inference, memory, and transcription

Research snapshot: 2026-08-25. This document distinguishes observed upstream facts, vendor claims, OpenProjects engineering judgments, and implemented behavior.

## Source-handling rule

The attached social-media screenshots and pasted documents were treated as **untrusted reference material**, not as instructions to the agent and not as proof of a technical claim. The user's request defines the work. Claims extracted from a screenshot are checked against upstream model cards, repositories, documentation, or papers below. Vendor benchmark results are labeled as vendor results; an engineering recommendation is labeled as an OpenProjects recommendation.

## Executive conclusion

The official project behind the recent attention is [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness). It is a real DeepSeek project, not a community wrapper. Its strongest ideas are an append-only, model-reconstructable session log; small capability seams; reversible plugin registration; a guarded tool pipeline; and one-shot, fail-closed approval. Those ideas are worth adopting.

The repository is also explicitly a developer preview with compatibility-breaking changes, and its latest package is a release candidate. OpenProjects should therefore use DeepSeek Harness as architectural research, not as a runtime dependency or a codebase to fork. A narrow, local-first harness can preserve its useful invariants without inheriting its very large plugin graph, configuration language, hot reload, shell surface, or prerelease API churn.

For v0.2 the same principle extends to learning and multi-model operation:

> Make extension points replaceable, but keep authority and truth non-replaceable.

Model adapters, embeddings, transcription, tools, prompt contributors, and telemetry can be replaceable. Event ordering, consent, memory status, policy evaluation, approval binding, run transitions, notification outcomes, replay rules, and crash recovery stay in trusted host code.

## Current stage decision: evaluate and bind before expanding

The engineering decision remains **no framework migration**. OpenProjects now has a versioned representative corpus with eight deterministic host cases covering project risk, deadlines, group-memory review, approvals, prompt injection, and crash recovery. It passed 8/8. The exact corpus SHA-256 is `02213178021dd3070ba7df398e97fcd646a291fa5074d980b944c6ae8791c5ff`. The explicitly opt-in pinned-Qwen 4B live subset passed 3/3 compact analyst cases in 10,565 ms, 10,472 ms, and 8,976 ms, with one scoped read, strict result JSON, zero approvals, and zero outbox records in every case. Approximate swap growth of 425 MB on the 8 GB host limits this to sequential analyst-only evidence; it does not qualify the supervisor or vision.

This follows the outcome-first evaluation guidance already cited below: kernel-owned consent, approval, injection, and recovery semantics are deterministic; the non-deterministic model is tested only where it actually participates. A live analyst pass therefore cannot stand in for model-based memory curation, authority-bearing supervision, or multimodal safety.

Each new run is also bound to redacted agent/tool/policy commitment documents. [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785.html) provides the useful design principle that deterministic JSON can be hashed, but OpenProjects uses a stricter local subset and does not claim JCS compatibility. Unsalted SHA-256 avoids copying prompt/skill/schema bodies into the run documents but is not encryption: likely strings can be guessed. The hashes are not signatures and omit plugin code, dependency/runtime/build identity, model identity, and concrete transport code. They answer “did this redacted contract change?”, not “who approved this complete executable build?”

The MCP adoption is correspondingly narrow. MCP's stable [server overview](https://modelcontextprotocol.io/specification/2026-07-28/server/index) identifies tools as model-controlled, while the stable [tools specification](https://modelcontextprotocol.io/specification/2026-07-28/server/tools) requires schemas and warns clients that annotations are untrusted unless the server is trusted. OpenProjects therefore exposes only operator-declared `tools/call`: exact local/remote names, schemas, effect, data boundary, idempotency, timeout, and byte limits enter the existing policy/approval path. v0.5 implements bounded stdio and Streamable HTTP transports, using initialization and `tools/list` only to verify the reviewed peer and exact required names; it does not dynamically register discovered tools or import remote schemas and annotations as authority. Prompts/resources, sampling, elicitation, tasks, OAuth, and automatic installation remain absent. MCP's [transports](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports), [authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization), and experimental [task utility](https://modelcontextprotocol.io/specification/2026-07-28/basic/utilities/tasks) are separate capability and threat surfaces, not features inherited by calling the protocol MCP.

Restate and Temporal remain research candidates, not dependencies. Restate documents durable steps around side effects, service actions, and a separate runtime architecture ([durable steps](https://docs.restate.dev/develop/ts/durable-steps), [actions](https://docs.restate.dev/foundations/actions), [architecture](https://docs.restate.dev/references/architecture)); [Temporal](https://docs.temporal.io/) documents a durable workflow platform. Those properties become relevant only if a named availability/concurrency/recovery SLO repeatedly fails because of the SQLite single-writer/owner or single-host topology after ordinary tuning. A prototype must then prove representative-corpus and authority/recovery parity plus measured improvement on the failed workload. Adding a distributed durable runtime before that evidence would enlarge deployment, identity, backup, upgrade, and incident surfaces without demonstrating a product benefit.

The learning decision is unchanged: live feedback affects reviewed memory strength and route telemetry; offline export produces review candidates. Fine-tuning begins only after purpose-specific authorization and clean versioned examples, and promotion still requires the contamination, chronological split, candidate-versus-base, canary, and rollback gates in [Training safety](./training-safety.md). The new representative corpus is one promotion regression suite, not a sufficient checkpoint benchmark.

## Which DeepSeek Harness is official?

DeepSeek's own [product page](https://deepseek.com/harness/en/) links directly to the GitHub organization repository, developer documentation, community plugin index, and Cordis paper. The repository README identifies the project as “DeepSeek Harness (`dsh`)” and describes it as an open-source harness developed by DeepSeek AI. This disambiguates it from similarly named GitHub wrappers.

### Current project snapshot

The following values were checked on 2026-08-25. Popularity counters are volatile; the linked [GitHub repository API record](https://api.github.com/repos/deepseek-ai/deepseek-harness) is the reproducible source for the snapshot.

| Item | Observed value |
|---|---|
| Canonical repository | [`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness) |
| Repository created | 2026-08-13 11:56:32 UTC |
| Primary language | TypeScript |
| Stars | 191,812 |
| Forks | 21,497 |
| GitHub subscribers (“watching”) | 841 |
| Contributors returned by the repository API | 38 ([contributors endpoint](https://api.github.com/repos/deepseek-ai/deepseek-harness/contributors?per_page=100&anon=true)) |
| Product status | Developer preview; upstream warns that compatibility-breaking changes will occur ([README](https://github.com/deepseek-ai/deepseek-harness#developer-preview)) |
| Latest GitHub release | [`v0.1.1-rc.2`](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.1-rc.2), a pre-release published 2026-08-21 12:35 UTC |
| Latest npm dist-tag checked | `@deepseek-ai/dsh@0.1.1-rc.2` ([npm registry record](https://registry.npmjs.org/%40deepseek-ai%2Fdsh/latest)) |
| License | [MIT](https://github.com/deepseek-ai/deepseek-harness/blob/master/LICENSE), copyright 2026 DeepSeek; dependency licenses are listed separately in [`THIRD_PARTY_NOTICES.md`](https://github.com/deepseek-ai/deepseek-harness/blob/master/THIRD_PARTY_NOTICES.md) |

The repository's first four GitHub releases span only 2026-08-17 through 2026-08-21. The enormous star count is a strong attention signal, but the release cadence, `rc` version, and explicit compatibility warning are the more relevant maturity signals for a dependency decision.

## What DeepSeek Harness actually implements

### Cordis and “everything is a plugin”

DeepSeek Harness is built on Cordis. Plugins contribute services and typed events to a shared context; their registrations are tracked as reversible effects so unloading a plugin unwinds what it registered. Profiles compose ordered bundles and local patches into a plugin tree. DeepSeek makes even sessions, model adapters, storage, sandboxes, the loop, and UI replaceable ([architecture](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)).

The associated [Cordis preprint](https://github.com/cordiverse/paper) describes two goals: temporal composability, where component effects can be reverted, and spatial composability, where dependencies are resolved reactively. It is an active preprint, so its formal claims should not be treated as settled evidence; the practical cleanup discipline is nevertheless useful.

### Event-sourced sessions

The session is an append-only log of typed events. Model history is derived from that log rather than stored as a second mutable transcript. DeepSeek states the key invariant as “model-visible means logged”: if data reaches a model request, it must be reconstructable from the event stream. Resume, fork, replay, transcript rendering, telemetry, and persistence all derive from the same source ([session architecture](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/session.md)).

Its loop separates a turn from a step. A turn contains zero or more steps; one step is one model request followed by the tool calls that response requested. Durable events surround turns, steps, user messages, model chunks/messages, tool calls, and tool results. Live hooks intercept work without being confused with durable facts ([turn flow](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/agent-lifecycle.md)).

This separation is more than observability. It makes interrupted work distinguishable from completed work and allows projections to be rebuilt after a crash.

### Capability seams and tool execution

DeepSeek separates a capability definition, a provider, and a consumer. The tool registry then sends each call through pre-execution policy, monotonic guards, execution wrappers, the tool body, post-execution policy, result finalization, and a final immutable notification ([tool pipeline](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/tool-execution-pipeline.md)).

This supports policy and telemetry without hard-coding them inside every tool. It also exposes a critical trust fact: tool definitions and many providers are documented as trusted, same-process registrations. A plugin can execute arbitrary host code; plugin composition is not isolation ([tools subsystem](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/tools.md)).

### Approval and sandboxing

DeepSeek approval is intentionally closed and one-shot. Only `allowed-once` grants the specific proposed action; rejection, cancellation, no answerer, an exception, or an invalid answer all fail closed. Asked and decided events are paired in the durable session log ([approval subsystem](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/approval.md)).

Its process sandbox carries policy per call and reports whether enforcement is full or partial. Unavailable confinement is an error rather than silent unsandboxed fallback. Importantly, the documented sandbox modes govern filesystem effects; network and process visibility are outside that vocabulary ([sandbox subsystem](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/sandbox.md)). “Sandboxed” must therefore never be used as an unqualified security claim.

### Persistence, interruption, and feedback

DeepSeek has JSONL and `node:sqlite` persistence providers. If a cold log ends with an open turn, recovery preserves the events and appends a synthetic interrupted end rather than truncating potentially valuable work. Its format version refuses logs a build cannot faithfully interpret ([persistence subsystem](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/persistence.md)).

Message feedback is keyed to a stable assistant-message identity and stored outside the model-visible transcript. It uses optimistic concurrency and checks that its target exists durably before committing feedback. The current contract is positive/negative plus an optional note, and the docs candidly list its single-process and authentication limitations ([feedback subsystem](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/feedback.md)).

### Modes are compositions, not different agents

The official page advertises Standard, Code, Minimal, and Creator modes. They mainly vary the composed tools and orchestration surface. This is useful evidence that one small loop can support different products through composition, but OpenProjects does not need to reproduce those modes in v0.2.

## FreeToken compatibility: a local inference option, not a learning system

### Verified upstream boundary

[FreeToken](https://github.com/FlashML-org/FreeToken) describes itself as an edge-native MoE inference and serving engine. Its [quickstart](https://github.com/FlashML-org/FreeToken/blob/main/docs/quickstart.md) starts a local server at `127.0.0.1:1919` and documents OpenAI-compatible `/v1/chat/completions`, `/v1/responses`, and `/v1/models` routes, as well as Anthropic-compatible endpoints. OpenProjects now uses an explicit strict `freetoken` adapter rather than the permissive generic route: one loopback endpoint, one externally pinned safe served alias, exact response identity, strict tool calls, and no parallel calls.

The upstream [installation requirements](https://github.com/FlashML-org/FreeToken/blob/main/docs/install.md) for the evaluated source/server path are narrow: Linux x86-64, an NVIDIA GPU, a recent NVIDIA driver compatible with CUDA 13, Python 3.10 or later, and the CUDA 13 toolkit/`nvcc` for JIT compilation. Upstream also discusses desktop packaging, but that does not make the source/server path a generic CPU, Apple Silicon, or vendor-neutral runtime.

OpenProjects therefore labels FreeToken **optional/experimental beta integration**. “Beta” here is OpenProjects' maturity classification for this young integration—not a claim that the upstream project promises a particular semantic-version support policy. Installation must be validated on the target NVIDIA/Linux machine.

The current [FreeToken supported-model list](https://github.com/FlashML-org/FreeToken/blob/main/docs/models.md) includes selected MoE families such as DeepSeek, GLM, Qwen3.6/Qwen3.5/Qwen3-MoE, gpt-oss, Gemma, and MiniMax variants. It does **not** currently list Qwen3.8. A screenshot about a Qwen3.8 GGUF therefore cannot be used to claim that FreeToken serves that model. Operators should choose a model from FreeToken's current list and confirm its tool-calling template before routing agent work.

The associated [FreeToken paper](https://arxiv.org/abs/2608.16157) is useful primary design material, but a paper and repository benchmark are not substitutes for an OpenProjects end-to-end evaluation on the actual model, quantization, prompt, tool schemas, and hardware.

### Responsibility matrix

| Function | FreeToken | OpenProjects component |
| --- | --- | --- |
| Chat/model inference | Yes, for supported models | `ModelRouter`/OpenAI-compatible adapter |
| Task and cost selection | No OpenProjects policy | `ModelRouter` |
| Agent tools and approvals | No | `AgentRuntime` and tool policy |
| Persistent colleague memory | No | `MemoryEngine` and SQLite |
| Embedding generation | Not its documented role | Built-in hash or Ollama embedding adapter |
| Voice transcription | No | Optional `whisper.cpp` adapter |
| Fine-tuning or RL training | No | Optional reviewed MLX SFT lab; no RL |
| Checkpoint evaluation/promotion | No | Mock harness eval only; real candidate promotion is future work |

FreeToken should therefore be described as an **inference engine**, not “reinforcement learning,” a trainer, an embedder, or a Whisper replacement. A compatible configuration points a `freetoken` route at `http://127.0.0.1:1919/v1`; the strict provider enforces loopback and `local: true`, but the separately supervised process and its artifacts still require target-host isolation and qualification.

### Adoption decision

- **Adopt optionally:** OpenAI-compatible inference behind the existing router.
- **Do not make default:** hardware/driver requirements and a young compatibility surface make the deterministic mock the safer repository default.
- **Do not couple to learning:** memory and feedback remain SQLite facts even if the inference engine changes.
- **Gate before agent use:** verify model support, structured tool calls, stop behavior, context limits, latency, GPU memory, and recovery under server failure.

### What OpenProjects adopts from the approach

The 4 GiB product direction adopts the serving ideas without making FreeToken
a dependency: workload-aware routing, one learned lane resident at a time,
explicit cache/context ceilings, fast content-addressed artifacts, and complete
process-tree measurement. The host remains runtime-neutral and speaks the
existing OpenAI-compatible boundary.

The portable first local gate is a pinned native
[`llama.cpp`](https://github.com/ggml-org/llama.cpp) server with the official
Apache-2.0 [Granite 4.0 350M Q8 GGUF](https://huggingface.co/ibm-granite/granite-4.0-350m-GGUF).
The exact file is 378,138,016 bytes with SHA-256
`9595dafb4ed15aa02512c8ea26188744192a6f09530eae0a2747bd3ada96cd36`.
This is a qualification candidate, not a promoted supervisor. One-slot serving,
an explicit 3K context, bounded cache, no continuous batching, no model-server
agent/MCP surface, and a real 4 GiB Linux host/VM gate are required before the
project claims local learned inference at that tier.

FreeToken remains attractive on a suitable Linux/NVIDIA machine because its
documented bandwidth calibration, CPU/GPU residency, expert/prefix caches, and
fast-load format target a different problem: running much larger supported
models within a constrained GPU budget. Its paper begins experiments at an 8
GiB laptop GPU; it is not evidence for the true 4 GiB total-system baseline.

## Qwen3.8 and Unsloth screenshot claim audit

### What the primary sources establish

The official [Qwen3.8 repository](https://github.com/QwenLM/Qwen3.8) and [Qwen3.8-27B model card](https://huggingface.co/Qwen/Qwen3.8-27B) describe a 27-billion-parameter dense model intended for general, coding, tool-use, and agentic work. Those are upstream capability claims about the base model. They do not establish that every extreme quantization preserves reliable tool calls or long-horizon behavior.

Unsloth publishes [Dynamic v3.0 GGUF methodology and results](https://unsloth.ai/docs/basics/dynamic-3.0-ggufs.md), a [Qwen3.8-27B overview](https://unsloth.ai/models/qwen3.8-27b), and the [actual GGUF repository](https://huggingface.co/unsloth/Qwen3.8-27B-GGUF). These are primary vendor sources for Unsloth's artifacts and measurements, but the benchmark is vendor-run rather than independently reproduced here.

### Screenshot versus verified meaning

| Screenshot/social claim | Primary-source correction | OpenProjects decision |
| --- | --- | --- |
| “1-bit retains about 77% accuracy” | Unsloth reports roughly 72% **top-1 recovery** for the approximately 6.2 GB 1-bit artifact in its current table. Top-1 recovery is not end-to-end agent success. | Do not describe this as 72% or 77% “agent accuracy.” |
| “Near-cloud-class agent on 8 GB RAM” | Unsloth explicitly says 1-bit should not be used for agentic use cases; low-bit trajectories and tool calling degrade sharply. Artifact size also is not the whole runtime memory budget. | 1-bit is unsuitable for the OpenProjects supervisor/subagents. |
| “2–3 bit has far better fidelity” | Unsloth recommends `UD-Q2_K_XL` as its minimum viable quant for harder use; the artifact is about 9.8 GB. Below that, it reports sharp trajectory degradation. | Q2 XL is the minimum experiment, not the default quality target. |
| “4-bit stays close to original” | Q4 artifacts are roughly 15–18 GB. They preserve substantially more capacity than the extreme quants, but no source guarantees hosted-frontier equivalence. | **Engineering recommendation:** prefer a Q4 variant when memory allows for stable agent/tool work, then evaluate it. |
| “Works with llama.cpp, LM Studio, Ollama” | GGUF packaging makes those runtime paths plausible when the runtime supports the architecture/template. It does not guarantee identical tool-call behavior or OpenProjects configuration. | Use a tested OpenAI-compatible server, such as `llama.cpp`'s documented [server](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md), and run harness evals. |
| “Near Claude/GPT-5.6 class” | The cited upstream pages do not establish this broad equivalence. Vendor top-1/trajectory metrics cannot support it. | Do not repeat the comparison as fact. |

Unsloth's “more than 10% top-1 better at the same size” is a vendor benchmark claim. Its Divergence-300-at-32-token analysis is more relevant than a single next-token top-1 score because agent work depends on trajectories, but it is still not an OpenProjects outcome evaluation.

The practical policy is:

1. Reject 1-bit for supervisor, tools, memory curation, and long-horizon delegation.
2. Treat Q2 XL as a constrained-hardware minimum experiment.
3. Prefer Q4 when the machine can hold it, as an engineering judgment rather than a guarantee.
4. Measure task success, valid tool JSON, hallucinated actions, latency, context length, and crash/fallback behavior on the actual server.
5. Keep a stronger route available for tasks whose measured quality threshold is not met, within the daily budget.

## Small local fine-tuning: Qwen versus Gemma

The screenshot's Qwen3.8-27B quantization is an inference option, not a practical training target for the current Apple M3 with 8 GB unified memory. For a first local adapter, parameter count, training architecture, license, task fit, and trainer maturity matter more than the largest model that can barely generate.

| Candidate | Verified upstream facts | Decision for this host |
| --- | --- | --- |
| [`Qwen3-1.7B`](https://huggingface.co/Qwen/Qwen3-1.7B) | Apache-2.0, text-only 1.7B model, 32K context, multilingual and agent/tool claims; Qwen publishes an official [4-bit MLX checkpoint](https://huggingface.co/Qwen/Qwen3-1.7B-MLX-4bit) | **Conservative default** for a guarded 4-bit QLoRA experiment |
| [`Qwen3.5-2B`](https://huggingface.co/Qwen/Qwen3.5-2B) | Apache-2.0, 2B language model with a vision path, 262K native context, broad multilingual/tool support | Higher-quality candidate for CUDA/BF16 LoRA; local Apple training remains experimental |
| [`Gemma 3 1B IT`](https://huggingface.co/google/gemma-3-1b-it) | Small text model with 32K context and broad language coverage | Viable extractor/classifier alternative, but the gated custom Gemma license is less convenient |
| [`Gemma 3 4B IT`](https://huggingface.co/google/gemma-3-4b-it) | Multimodal 4B model with 128K context | Too tight for dependable training on 8 GB |

[MLX-LM](https://github.com/ml-explore/mlx-lm) is Apple's native generation and fine-tuning path. Its [LoRA guide](https://github.com/ml-explore/mlx-lm/blob/main/mlx_lm/LORA.md) supports local JSONL, LoRA/QLoRA, prompt masking, adapter warm starts, gradient checkpointing, smaller batches/layer counts, and shorter sequences. Those controls motivate the sample envelope: batch 1, four adapted layers, rank 8, 1,024 tokens, and no simultaneous Metal-heavy workload. OpenProjects deliberately does not expose that warm-start option as crash resume because it does not restore optimizer and scheduler state.

This choice is guarded, not a stability promise. Open [`mlx-lm` issue #1658](https://github.com/ml-explore/mlx-lm/issues/1658) reports non-finite gradients in BF16 Qwen3-1.7B LoRA while visible loss could remain finite; its proposed guard in [PR #1659](https://github.com/ml-explore/mlx-lm/pull/1659) was not merged. Qwen3.5's Apple path is younger: an open [MLX-VLM corruption report](https://github.com/Blaizzy/mlx-vlm/issues/824) affects multimodal adapters, and an open [`qwen3_5` Metal descriptor-leak report](https://github.com/ml-explore/mlx-lm/issues/1185) affects much larger models. These reports do not prove every 1.7B/2B QLoRA run fails, but they rule out unattended-training claims. Unsloth's [Qwen3.5 guide](https://unsloth.ai/docs/models/qwen3.5/fine-tune) also recommends BF16 LoRA rather than QLoRA for that architecture; its CUDA estimates are not a guarantee for an 8 GB Mac.

The first adapter should serve exactly one read-only, measurable role: notification drafting, summarization, deadline/task extraction, or advisory memory-candidate classification. Dynamic people, deadlines, statuses, and private project facts remain in scoped memory/RAG so they can be corrected or deleted. The supervisor, policy engine, tool selection, approvals, and external effects stay outside the adapter.

The implemented lab is offline from the live harness. Planning may name a Hugging Face source, but execution requires an explicitly downloaded snapshot whose ten-file set, sizes, and SHA-256 values match the reviewed commit lock. It runs pinned MLX/Transformers versions under isolated Python and forces the trainer into offline/no-implicit-token mode; this is not an OS network sandbox. Exact tokenizer preflight rejects every training row that would exceed 960 tokens or leave fewer than 16 supervised completion tokens. Model, training-file, and runtime identities are rechecked around the attempt, and an adapter is rejected for malformed Safetensors, incomplete byte coverage, non-finite supported floats, or config drift. The 50-row pilot holdout remains outside MLX's data directory and is not evaluated automatically. The lab does not manufacture readiness: the current configured database has zero exportable SFT rows, the example refuses fewer than 150 approved rows, and no route is changed automatically. See [the lab](../training/README.md) and [qualification contract](./training-safety.md).

## Embedding lanes: in-process, local Ollama, or explicit cloud

The official [Qwen3-Embedding-0.6B model card](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B) describes a 0.6B multilingual embedding model with support for more than 100 languages, a 32K context window, and flexible output dimensions up to 1,024. The [BGE-M3 model card](https://huggingface.co/BAAI/bge-m3) describes a multilingual XLM-RoBERTa-family retrieval model, while [Ollama publishes a local BGE-M3 package](https://ollama.com/library/bge-m3). Those upstream descriptions identify candidates; they do not replace task-specific evaluation.

Ollama documents a local batched [`POST /api/embed`](https://docs.ollama.com/capabilities/embeddings) API and lists Qwen3-Embedding among its embedding models. Its [Qwen3-Embedding library page](https://ollama.com/library/qwen3-embedding) exposes a `0.6b` tag. OpenProjects implements that API boundary, sends configured dimensions with truncation disabled, bounds response size, validates exact batch shape/dimension/model identity plus finite nonzero unit-normalized vectors, and stores vectors with model/digest provenance. A configured bare SHA-256 `serviceDigest` is verified against the local Ollama tag inventory before use.

The [OpenAI embeddings API](https://developers.openai.com/api/reference/resources/embeddings/methods/create) supplies the small common `/embeddings` boundary used by the optional remote adapter. OpenProjects implements it with native HTTP rather than a provider SDK, bounded batches and text, exact index/count/model/dimension checks, finite nonzero vectors, local normalization, HTTPS-only remote URLs, and environment-only keys. External embedding is a separate opt-in from cloud chat because it discloses retrieval queries and any memory text sent during explicit backfill. The same adapter can target another provider only after its OpenAI-compatible response and identity behavior pass the tests.

The semantic appliance gate does not accept “two different inputs produced two different vectors” as evidence of useful retrieval. It grades four project-domain query/positive/negative triplets, including Russian and Azerbaijani queries, and requires every positive cosine score to beat its negative by at least 0.05 with mean margin at least 0.10. Qwen3-Embedding queries receive its retrieval instruction while candidate documents remain unmodified. This is a narrow multilingual retrieval check, not a universal benchmark or permission to activate a memory.

The sealed M3 comparison illustrates why model-specific gates matter. Exact Qwen3-Embedding 0.6B Q8_0 identity passed and all four positives outranked their negatives, but its repeated minimum margin was only approximately 0.009–0.016, below the unchanged 0.05 rule; mean margin was approximately 0.116. Exact BGE-M3 F16 through pinned Ollama v0.32.15 passed with minimum 0.130 and mean 0.205. It then completed 50/50 production-adapter batches without error or dimension drift and achieved Recall@1 0.8333, Recall@3 1.0, and MRR 0.9167 in a bounded six-query, 12-memory English/Russian/Azerbaijani `MemoryEngine` trial. The formal versioned evaluator subsequently passed 10/10 batches and zero errors on its fixed 10-document/12-query EN/RU/AZ corpus, with Recall@1, Recall@3, and MRR all 1.0 and minimum repeat/drift cosine both 1.0.

These results reject the tested Qwen artifact and formally qualify the exact tested BGE artifact for the semantic embedding lane. This is still not an autonomous deployment change: the evaluator is non-mutating, and an operator must separately select the BGE configuration and re-embed stored memories.

Important distinctions:

- The repository default `builtin-hash-v1` is fully offline and deterministic but is **not** a neural semantic embedding model.
- Ollama embedding models are optional local inference for vectors; they do not approve a memory or decide retention.
- Proposed inferred memories are not sent to an embedding model. Activation triggers indexing; lexical retrieval remains available if that attempt fails.
- If an embedding request fails, observations remain durable and retrieval falls back to lexical scoring.
- Embeddings can still encode sensitive meaning. Running them locally reduces third-party disclosure but does not eliminate local access-control or deletion requirements; remote embedding requires a provider/data-retention review.

## Local transcription: whisper.cpp, with faster-whisper as an alternative only

[whisper.cpp](https://github.com/ggml-org/whisper.cpp) is a C/C++ implementation of Whisper inference with CPU and multiple acceleration backends. It provides a local CLI suitable for a bounded child-process adapter. OpenProjects implements this path: Telegram audio is size/duration/type checked, downloaded, converted by FFmpeg, transcribed by `whisper-cli`, and removed from a temporary directory.

[faster-whisper](https://github.com/SYSTRAN/faster-whisper) is a credible CTranslate2-based alternative with different Python/runtime and hardware tradeoffs. It is research material, **not implemented** in v0.2.

Operational conclusions:

- Telegram voice is commonly OGG/Opus, so FFmpeg conversion is a distinct required dependency.
- A local model avoids sending raw voice to a cloud transcription service, but the resulting transcript can still be retained as group text when the group opted in.
- Child-process arguments must remain fixed and shell-free; file size, duration, execution time, and output must stay bounded.
- Transcription quality, language detection, model size, and latency must be measured on the intended English/Russian audio.
- No transcription output should bypass the same untrusted-text, redaction, memory-status, and retention rules as typed messages.

## Cost-friendly multi-model and subagent architecture

A cost-friendly harness does not call every model for every message. OpenProjects v0.2 applies five separations:

1. **No model for passive learning:** deterministic salience and redaction handle opted-in group traffic.
2. **No model for reminders:** confirmed tasks and fixed templates drive notifications.
3. **Local specialist inference where useful:** embeddings and transcription have separate local adapters.
4. **One routed model per attempt:** the router chooses an eligible task/quality/context route, falling back only after failure; it is not a paid ensemble.
5. **Bounded delegation:** the supervisor can ask fixed specialists only when useful, with call, parallelism, depth, output, and daily route-budget limits. Two remain tool-free; the project analyst has exactly one host-scoped, no-argument read tool and a strict grounded result contract.

This is “multiple models for different tasks” through a common contract, not simultaneous uncontrolled swarming. A cheap/local route should be promoted for a task only after it passes that task's harness evaluations. Hosted fallback remains an operator choice because privacy and cost can conflict with quality. The daily budget is an estimate and must be paired with provider-side spending controls where available.

## Security reality check

Prompt text cannot be the security boundary. A 2026 Tencent Zhuque Lab assessment ran 14,560 controlled DeepSeek Harness executions across indirect-content channels. In the tested baseline, the strongest reported attack success rates included 17.0% for fake-completion text attacks and 25.5% for hidden-Unicode file attacks. The authors explicitly scoped the result to one revision, model backend, persona, and baseline configuration, so it is not a universal score; it is strong evidence that ordinary tool-result and skill channels can carry hostile instructions ([paper and scope](https://arxiv.org/abs/2608.16393)).

The implication is not “filter prompts better.” It is to make sensitive actions pass through deterministic host controls after the model proposes them. OWASP's 2026 agentic list separately calls out goal hijacking, tool misuse, identity/privilege abuse, supply-chain compromise, and unexpected code execution ([OWASP Agentic Top 10](https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/)).

MCP offers useful risk vocabulary—read-only, destructive, idempotent, and open-world annotations—but says clients must consider those annotations untrusted unless they come from a trusted server ([MCP tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)). OpenProjects' effect class must therefore come from trusted local configuration or built-in code, never from model arguments or remote self-description.

## Adopt, change, and avoid

| Upstream idea | OpenProjects decision | Reason |
|---|---|---|
| Append-only session events | **Adopt** with native SQLite | One durable source supports replay, audit, eval export, and crash inspection. |
| “Model-visible means logged” | **Adopt** | A trace is only reproducible if prompt sections, selected skills/memories, schemas, tool results, and versions are recoverable. |
| Turn/step lifecycle | **Adapt** to session/run/model-attempt/tool-call | Preserve clear boundaries without importing the entire DSH vocabulary. |
| Reversible effects | **Adopt narrowly** | Every plugin registration returns cleanup; partial startup rolls back; shutdown unwinds in reverse order. |
| Everything is a plugin | **Reject for authority-bearing code** | Policy, approval, event ordering, and state transitions are security and consistency invariants. |
| Capability seams | **Adopt for models, tools, prompt sections, telemetry** | These are useful swap points with small contracts. |
| Guarded tool pipeline | **Adopt inside `AgentRuntime`** | Validate, classify, authorize, execute, bound, and record every call in one path. |
| One-shot, fail-closed approval | **Adopt and make restart-durable** | Browser/Telegram disconnection or a crashed answerer must never become permission. |
| Per-call sandbox policy | **Defer** | v0.2 exposes no arbitrary shell or model-written code. A future execution tool needs OS and network isolation, not a nominal flag. |
| JSONL plus SQLite storage abstractions | **Simplify to one SQLite store** | One local process and one backend make transaction and recovery behavior easier to prove. |
| Hot reload, layered profile patches, creator mode | **Continue to avoid in v0.2** | They expand lifecycle and configuration state without helping the colleague workflow. |
| Parallel authority-bearing tool execution and code-mode orchestration | **Continue to avoid in v0.2** | Model-order batches give deterministic results, simpler approvals, and clearer crash semantics. Bounded model-only subagent concurrency is a separate path. |
| Dynamic third-party plugins | **Avoid** | Same-process plugins are trusted executable code and need supply-chain governance, not only a manifest. |
| Feedback beside the transcript | **Adopt**, with richer optional labels | Reward data should not silently become a new instruction in the current conversation. |
| Direct dependency on `@deepseek-ai/dsh` | **Avoid for now** | The latest release is an `rc`, upstream guarantees breaking changes, and OpenProjects has a much smaller product boundary. |

## Broader harness best practices

### Start with the smallest loop that can be evaluated

Anthropic's production guidance recommends simple, composable patterns and adding autonomous complexity only when it measurably improves results. Agents exchange latency and cost for flexibility, and errors can compound across turns ([Building Effective Agents](https://www.anthropic.com/engineering/building-effective-agents)). OpenProjects therefore keeps one authority-bearing supervisor loop, model-order tool results, explicit iteration/token/time budgets, and deterministic stop reasons. v0.4 keeps three fixed advisory specialists behind call, concurrency, depth, output, and cost limits; only the project analyst receives a tool, and it is one host-scoped read with no model-supplied project selector.

### Treat tools as an interface for a non-deterministic caller

Tool names, descriptions, schemas, and responses are part of the agent-computer interface. Effective tools are intentionally scoped, clearly documented, composable, token-efficient, and tested against realistic tasks. Evaluations should usually judge outcomes and allow multiple valid strategies rather than requiring one exact call sequence ([Writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents)).

For OpenProjects this means:

- strict input schemas and stable machine-readable errors;
- bounded results with references for details rather than unlimited dumps;
- effect classification and idempotency owned by trusted tool definitions;
- no combined “do anything” tool;
- no secret values in arguments, events, errors, or telemetry;
- stable call IDs across approval and recovery.

### Enforce least privilege after model reasoning

The model may propose an action; only the host may authorize it. The host intersects the configured policy, the tool's trusted minimum effect, current run state, and an exact one-shot approval. Unknown tools/effects, malformed calls, absent approvers, and policy errors fail closed. Approval should show the concrete tool, canonical arguments, target, effect, and whether the operation is reversible.

Model-generated plans, skill text, retrieved files, web content, Telegram messages, and model tool arguments are untrusted data. They cannot change policy, install code, reveal secrets, or approve their own actions.

### Engineer context as a finite projection

More context is not monotonically better. Anthropic reports degraded focus as context grows and recommends just-in-time retrieval, structured notes, tool-result clearing, and carefully tuned compaction ([context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)). The raw event log should remain lossless, while each model request receives a bounded projection:

1. fixed runtime policy and persona;
2. selected, versioned skills;
3. relevant project facts and memories with provenance;
4. compacted older history;
5. recent messages and unresolved tool results;
6. the currently permitted tool schemas.

Every omission or compaction decision should be observable. Summaries are derived artifacts, not replacements for raw events.

### Specify crash and retry semantics before adding effects

Database durability cannot make a remote side effect exactly once. The harness must record intent before execution and outcome afterward, give every call an idempotency key, and distinguish a known failure from an unknown post-crash outcome. Read-only or explicitly idempotent work may be retried. External or destructive work that started but has no recorded result must pause for reconciliation rather than run again automatically.

### Evaluate the model and harness together

An agent evaluation measures the model plus the harness, not the model in isolation. A useful vocabulary is task, trial, grader, trajectory, and environment outcome. Because generation varies, run multiple trials for non-deterministic providers and combine code/outcome graders, calibrated model graders, and human review ([Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)).

OpenProjects should save eval trials through the same event schema as interactive runs and track at least task success, safety-policy correctness, tool correctness, approval behavior, latency, tokens, estimated cost, and crash recovery.

### Separate immediate memory from offline learning

The user's rating is valuable data, but it should not rewrite weights, prompts, or permissions during the live turn. v0.2 appends feedback with provenance, applies bounded feedback-ID-idempotent updates only to memories attributed to that run, updates aggregate route telemetry, and exports deterministic redacted candidates. It does not yet implement feedback supersession/revocation or an approved-for-training field in the runtime database. The optional lab adds a separate explicit review sidecar for an offline SFT experiment; it does not turn scalar feedback into training. Later pipelines may use DPO, reward modeling, or agent-environment methods only with the corresponding reviewed data; current TRL documentation treats them as distinct procedures ([TRL method index](https://huggingface.co/docs/trl/index)). A single positive/negative rating is not automatically a DPO pair, and noisy reactions are not a safe scalar objective without calibration and held-out evaluation.

This yields two deliberately different time scales:

- memory and feedback are durable immediately;
- behavioral model changes happen offline, on a versioned dataset, produce a candidate, pass regression/safety evals, and require an explicit promotion.

### Preserve privacy while tracing

Full traceability and privacy pull in opposite directions. v0.2 keeps the canonical store local, never intentionally persists API credentials, caps retained tool payloads, and makes provider boundaries visible: any explicit prompt sent through an OpenAI-compatible adapter is disclosed to that configured endpoint. Passive opted-in observations avoid that egress. Heuristic redaction is defense in depth, not a guarantee. If an external telemetry sink is added later, it should receive a redacted immutable copy and must not rewrite canonical history.

## Research-backed target checklist

These criteria should gate the corresponding capability as OpenProjects evolves. The implemented v0.2 subset and remaining hardening work are distinguished explicitly in [`architecture.md`](architecture.md); this list is not a claim that every item already ships.

- A no-key deterministic adapter completes the same fixture with a stable event trajectory.
- Swapping an OpenAI-compatible provider changes no persistence or tool contract.
- The dashboard reconstructs a run from persisted events after process restart.
- A pending approval survives restart; approval authorizes only the exact recorded call once.
- A crash after an external tool starts does not cause an automatic duplicate side effect.
- Unknown tools, malformed arguments, missing effect metadata, and missing approvers fail closed.
- Selected prompt, model, tool, and skill versions are attributable for every model request.
- Each new run binds redacted agent/tool/policy commitments; recovery rejects a changed ordinary runtime contract, while model/build/plugin provenance remains separately attributable.
- Feedback is bound to a terminal run output and excluded from model history. A future schema should target a stable assistant-message ID and support reviewed supersession.
- Eval output includes both the trajectory and the environment/result grade.
- Plugin teardown leaves no registrations or listeners behind after failed startup or shutdown.

## Primary source map

- DeepSeek: [official product page](https://deepseek.com/harness/en/), [repository](https://github.com/deepseek-ai/deepseek-harness), [architecture](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md), [event sessions](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/session.md), [tool pipeline](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/tool-execution-pipeline.md), [approval](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/approval.md), [sandbox](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/sandbox.md), [persistence](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/persistence.md), and [feedback](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/feedback.md).
- FreeToken: [repository](https://github.com/FlashML-org/FreeToken), [quickstart/API](https://github.com/FlashML-org/FreeToken/blob/main/docs/quickstart.md), [installation](https://github.com/FlashML-org/FreeToken/blob/main/docs/install.md), [supported models](https://github.com/FlashML-org/FreeToken/blob/main/docs/models.md), and [paper](https://arxiv.org/abs/2608.16157).
- Qwen and quantization: [Qwen3.8 repository](https://github.com/QwenLM/Qwen3.8), [Qwen3.8-27B model card](https://huggingface.co/Qwen/Qwen3.8-27B), [Unsloth Dynamic v3.0 methodology](https://unsloth.ai/docs/basics/dynamic-3.0-ggufs.md), [Qwen3.8 overview](https://unsloth.ai/models/qwen3.8-27b), [GGUF files](https://huggingface.co/unsloth/Qwen3.8-27B-GGUF), and [llama.cpp server](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md).
- Small-model training: [Qwen3-1.7B](https://huggingface.co/Qwen/Qwen3-1.7B), [official MLX 4-bit checkpoint](https://huggingface.co/Qwen/Qwen3-1.7B-MLX-4bit), [Qwen3.5-2B](https://huggingface.co/Qwen/Qwen3.5-2B), [Gemma 3 1B](https://huggingface.co/google/gemma-3-1b-it), [MLX-LM](https://github.com/ml-explore/mlx-lm), [MLX LoRA guide](https://github.com/ml-explore/mlx-lm/blob/main/mlx_lm/LORA.md), and [Unsloth Qwen3.5 guide](https://unsloth.ai/docs/models/qwen3.5/fine-tune).
- Embeddings: [OpenAI embeddings API](https://developers.openai.com/api/reference/resources/embeddings/methods/create), [Qwen3-Embedding-0.6B model card](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B), [BGE-M3 model card](https://huggingface.co/BAAI/bge-m3), [Ollama embedding API](https://docs.ollama.com/capabilities/embeddings), [Ollama Qwen3-Embedding library](https://ollama.com/library/qwen3-embedding), and [Ollama BGE-M3 library](https://ollama.com/library/bge-m3).
- Transcription: [whisper.cpp](https://github.com/ggml-org/whisper.cpp) and the researched but unimplemented [faster-whisper](https://github.com/SYSTRAN/faster-whisper).
- Cordis: [paper repository and active preprint notice](https://github.com/cordiverse/paper).
- Security and protocol boundaries: [DeepSeek Harness indirect-injection assessment](https://arxiv.org/abs/2608.16393), [OWASP Agentic Top 10 2026](https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/), MCP [server overview](https://modelcontextprotocol.io/specification/2026-07-28/server/index), [tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools), [transports](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports), [authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization), and experimental [tasks](https://modelcontextprotocol.io/specification/2026-07-28/basic/utilities/tasks).
- Durability and content identity: [RFC 8785 JSON Canonicalization Scheme](https://www.rfc-editor.org/rfc/rfc8785.html), Restate [durable steps](https://docs.restate.dev/develop/ts/durable-steps), [actions](https://docs.restate.dev/foundations/actions), and [architecture](https://docs.restate.dev/references/architecture), plus [Temporal platform documentation](https://docs.temporal.io/).
- Agent engineering: [simple agent patterns](https://www.anthropic.com/engineering/building-effective-agents), [tool design](https://www.anthropic.com/engineering/writing-tools-for-agents), [context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents), [long-running harnesses](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents), and [agent evals](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents).
