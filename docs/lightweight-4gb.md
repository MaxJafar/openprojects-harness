# Lightweight 4 GB product profile

Status: active engineering target, 2026-08-26.

OpenProjects is positioned as a lightweight private agent control plane. The
durable host owns project state, policy, approvals, memory status, recovery,
and tool authority. A learned model is a replaceable worker, not the operating
system of the product.

## What “works on 4 GB” means

Two limits must not be conflated:

| Profile | Supported claim |
| --- | --- |
| **4 GiB total system RAM** | The bounded OpenProjects core, SQLite, deterministic policy/approvals, owner-only control transport, built-in hash retrieval, and the mock/demo model. Learned inference is optional and may run on another reviewed endpoint. |
| **At least 8 GiB system RAM with a 4 GiB local-AI app budget** | One separately qualified local text, embedding, transcription, or vision process at a time. macOS evidence bounds the observed OpenProjects/model process trees to 4 GiB but is non-certifying; each production lane should retain additional host headroom. |

The first row is the product baseline. The second is a local-AI extension. A
model file fitting on disk is not evidence that its runtime, KV cache, prompt,
the operating system, and OpenProjects fit together.

The `core-4g-v1` configuration profile makes the baseline enforceable. It
allows at most four host tools, three model-loop steps, four tool calls, 45
seconds, 2,048 input tokens, 512 output tokens, two retrieved memories, and
1,024 aggregate retrieved characters. It uses the in-process, offline,
256-dimensional `builtin-hash-v1` adapter and disables
learning, group observation, Telegram, notifications, transcription,
subagents, and configured integrations. The wizard does not represent a model
requiring more memory than the host as eligible.

This profile is a capability reduction. It does not weaken the policy,
approval, provenance, workspace, or crash-recovery rules.

On a larger development machine, render the exact same lightweight plan
without writing anything:

```bash
npm run setup -- --core-4g --defaults --dry-run
```

The repository also includes a reviewable
[static core example](../examples/openprojects.core-4g.yaml). Create its
owner-only state directory and control token before serving it; the setup
wizard performs that protected publication for a real installation.

## Measured host cost

A promotion-eligible disposable gate on the Apple M3 8 GiB development host
measured the final built CLI with `core-4g-v1`, durable SQLite, the Unix control
socket, the Atlas demo, and the deterministic model:

| Measurement | Observed |
| --- | ---: |
| Startup | 189.95 ms |
| Settled idle RSS | 84,787,200 bytes (80.86 MiB) |
| Lifecycle peak RSS | 85,835,776 bytes (81.86 MiB) |
| RSS growth above idle | 1,048,576 bytes (1.00 MiB) |
| Canonical durable run | 23.91 ms |
| Live SQLite footprint after run | 999,032 bytes |
| Checkpointed SQLite after shutdown | 356,352 bytes |
| Shutdown | 16.94 ms |

Those measurements show substantial headroom; they are not a substitute for a
run on every supported 4 GiB host class. The versioned
`eval-harness-footprint` gate therefore enforces conservative ceilings: 1 s
startup, 192 MiB idle RSS, 256 MiB lifecycle peak, 32 MiB lifecycle growth, 250
ms deterministic run latency, 2 MiB live/1 MiB final SQLite, and 1 s shutdown.
It also requires SQLite integrity, protected runtime files, no Internet socket,
and complete lock/socket/WAL cleanup. The gate measures the harness only and
never promotes a model runtime. Its exact report contract is
`openprojects.harness-footprint-eval-report.v1`; the recorded contract digest is
`e01d5f76ee825f5e463f21ddf808032fc6799a76b72a73b332f7ab318c210b04`, and the
report explicitly records `targetFourGiBHostCertified: false` when run on this
8 GiB host.

Command-local module loading is part of this result: the `serve` path no longer
imports TUI, setup, qualification, training-export, or unrelated evaluation
modules. A same-host three-run comparison against the recreated eager import
graph reduced median startup by about 22.8%, idle RSS by 24.8%, and peak RSS by
25.3%. This is useful engineering evidence, not a universal platform ratio.

## Lightweight architecture

The 4 GiB design follows five rules:

1. **Deterministic host first.** Deadlines, permissions, approvals, routing,
   retrieval limits, and recovery do not consume model context or depend on a
   model remembering policy.
2. **Narrow learned lanes.** A small model may extract, classify, summarize, or
   produce a strict advisory result. It does not become the supervisor merely
   because it fits in memory.
3. **One resident lane.** Text, semantic embeddings, transcription, and vision
   are mutually exclusive on the constrained local tier. Each process unloads
   after use and must return close to the pre-run footprint.
4. **Pay only for enabled features.** Integration transports are loaded lazily;
   the 4 GiB profile forbids configured connectors. Model response JSON is
   streamed with a 256 KiB decoded bound.
5. **Evaluate the exact artifact.** Model family names, parameter counts, and
   vendor quantization charts never replace OpenProjects task, memory, latency,
   swap, and failure gates.

Resource hardening is now enforced rather than left to deployment convention.
`core-4g-v1` shares one fail-fast run permit across the supervisor and compact
analyst, permits four active SSE clients, and creates no unbounded request
queue. Prompt history uses a 512-event post-compaction ceiling; inspection
tails, run replay, projects, tasks, evidence, approvals, memories, groups,
notifications, and scheduler reads all have validated finite limits. An
overloaded HTTP run receives 429 before a durable run is allocated, and an
overloaded approval remains pending.

## Candidate lanes — not defaults

The default remains built-in retrieval with no learned process. Current small
candidates for the separate AI-child tier are:

| Lane | Candidate | Why it is only a candidate |
| --- | --- | --- |
| Portable first 4 GiB text gate | [Granite 4.0 350M dense Q8 GGUF](https://huggingface.co/ibm-granite/granite-4.0-350m-GGUF) — 378,138,016 bytes, SHA-256 `9595dafb4ed15aa02512c8ea26188744192a6f09530eae0a2747bd3ada96cd36` | Apache-2.0 and the best first Linux/CPU target, but its published tool score is full precision and no exact OpenProjects 4 GiB run exists yet. |
| Narrow extraction/tool routing | [LFM2.5-350M MLX 4-bit](https://huggingface.co/LiquidAI/LFM2.5-350M-MLX-4bit/tree/f6cb4e006bb7a2d8a6afa14ec0a53e0586f65a5b) — 226,574,917-byte tree | Smallest plausible structured-output challenger, but no exact Apple peak, no RU/AZ support, and LFM 1.0 is not the project’s MIT license. |
| General local text/tools | [LFM2.5-1.2B Instruct MLX 4-bit](https://huggingface.co/LiquidAI/LFM2.5-1.2B-Instruct-MLX-4bit/tree/7ccafdb04c36936f4f1c4685198c6c9a40275932) — 663,548,181-byte tree | Plausible one-lane worker; it is not yet a qualified supervisor and exact tool behavior/resource use must pass locally. |
| Permissive text alternative | [Granite 4.0 1B MLX 4-bit](https://huggingface.co/mlx-community/granite-4.0-1b-4bit/tree/29f108a4e2ff99079a173004871604c2f1e12c1f) — 927,978,963-byte tree | Apache-2.0, but heavier and without a direct Apple peak measurement. |
| Semantic embeddings | [EmbeddingGemma 300M](https://ai.google.dev/gemma/docs/embeddinggemma) / Ollama QAT Q4 — 238,530,688-byte model layer | Must pass the unchanged EN/RU/AZ semantic gate; Gemma terms require separate review. Use `keep_alive: 0`. |
| Voice | [`whisper.cpp` base multilingual Q5](https://github.com/ggml-org/whisper.cpp/blob/371b5a7561823ab2bb32142d2751e35e7534727b/README.md) — 59,707,625-byte model | On-demand only; RU/AZ accuracy and exact peak still require the transcription gate. |
| Vision lab | [LFM2.5-VL-450M MLX 4-bit](https://huggingface.co/LiquidAI/LFM2.5-VL-450M-MLX-4bit/tree/f19926f17a25164d4cbcdc16d9eaf4714b807cfb) — 380,882,688-byte tree | A plausible one-image experiment, not product ingestion. Exact 4-bit resource/quality evidence is absent and vision remains disabled. |

For a true 4 GiB total-system release, every learned lane in this table remains
experimental until it passes on target-equivalent hardware. Remote inference
is an explicit compatibility choice, not a hidden fallback.

### Portable local runtime candidate

The first true 4 GiB local-model qualification should use one pinned native
[`llama.cpp`](https://github.com/ggml-org/llama.cpp) server plus the dense
Granite 350M Q8 artifact. This is preferred over making MLX the baseline because
GGUF/llama.cpp covers Linux, Windows, CPU, Metal, Vulkan, and CUDA while keeping
OpenProjects as the sole policy and tool authority.

The reviewed launch posture is loopback-only, offline, authenticated, one slot,
CPU-only (`--device none --gpu-layers 0`), no continuous batching, explicit
3,072-token context, 512-token output, bounded 64 MiB prompt cache, memory
mapping without `mlock`, and no llama.cpp UI,
agent, MCP, model router, multimodal projection, or download surface. The exact
supported flags must be pinned to the reviewed binary; this profile is tied to
the commit-pinned
[`llama-server` guide](https://github.com/ggml-org/llama.cpp/blob/c1d0e7a004015f23bc0233470b747b596f29b264/tools/server/README.md).

OpenProjects now has a dedicated `llama.cpp` adapter for this boundary. It
accepts only authenticated loopback HTTP at `/v1`, replaces every request model
with the reviewed safe `--alias`, sends `parallel_tool_calls: false`, validates
strict tool-call structure, and rejects a response that does not echo the alias.
It does not install, launch, route, or download anything.

The repository includes a CPU-only, cgroup-bounded
[`systemd` candidate](../deploy/systemd/openprojects-llama-server.service.example),
a [candidate configuration](../examples/openprojects.local-4gb-candidate.yaml),
an [appliance pin manifest](../examples/appliance-qualification.llama-cpp.example.json),
and a [deployment-evidence manifest](../examples/local-4gb-deployment.llama-cpp.example.json).
The runtime template is reviewed against llama.cpp v0.3.0 commit
`c1d0e7a004015f23bc0233470b747b596f29b264`; replace its binary hash placeholder
with the exact installed build before it can contact the endpoint.

### Whole-process local 4 GB gate

`eval-local-4gb` is deliberately separate from the harness footprint gate. It
requires an already-running endpoint and never starts, stops, pulls, promotes,
or rewrites it. The versioned `openprojects.local-4gb-deployment.v1` manifest
binds the route, endpoint, PID, exact runtime/model hashes, version, and complete
argv. It holds the configuration, qualification manifest, and deployment
manifest open as exact byte/inode snapshots, cross-binds their route, artifact,
runtime, context, and concurrency claims, then rehashes every source and artifact
after observation. The evaluator accepts one enabled local zero-cost
`project_analysis`-only route, checks the exact 53-argument CPU-only
one-slot/offline/no-UI/no-agent/no-tools posture, and runs the three-case strict
project-analyst gate against those same source bytes while sampling resources.

On Linux, promotion additionally requires the same stable PID start time,
executable inode, complete NUL-delimited argv, network and cgroup namespaces,
target-root runtime/model hashes and inodes, complete readable non-writable model
mapping, and namespace-wide sole ownership of the declared listener before and
after observation. The worker environment must contain no recognized runtime,
proxy, GPU, or loader override, and both unauthenticated and fixed-wrong-Bearer
requests must return 401/403 before and after the quality run.

The evaluator resolves the actual cgroup-v2 mount from `mountinfo`, verifies the
filesystem type and stable measured-directory inode, and samples the closest
shared ancestor on an absolute 500 ms schedule. Portable certification also
requires the observed Linux host to expose no more than 4.5 GiB total memory and
to retain at least 256 MiB available throughout the run; a cgroup-only pass on a
larger machine is not target-host certification. The shared ancestor must retain stable
finite `memory.max <= 4 GiB` and `memory.swap.max <= 64 MiB`, kernel
`memory.peak <= 3.5 GiB`, at least 256 MiB cgroup headroom, kernel swap peak and
observed swap growth no larger than 64 MiB, combined process-tree peak at or
below 1.5 GiB, continuous target identity/liveness, at least 95% sample coverage,
bounded edge/gap latency, and a 30-minute soak. Any telemetry error, source or
artifact mutation, injected probe, or injected clock blocks promotion. The
current versioned contract SHA-256 is
`fabf92828cfc969c1252e8b06b63e3a22d11479c1309cff660fd0020c612fca2`.

```bash
npm run build
OPENPROJECTS_LLAMA_API_KEY='value-from-the-owner-only-key-file' \
  npm run eval:local-4gb -- \
  --config examples/openprojects.local-4gb-candidate.yaml \
  --qualification-manifest examples/appliance-qualification.llama-cpp.example.json \
  --deployment-manifest examples/local-4gb-deployment.llama-cpp.example.json \
  --json
```

Replace every placeholder, especially the runtime hash and PID. Install the
[4 GiB slice](../deploy/systemd/openprojects-4gb.slice.example), assign the
model service and evaluator scope beneath it, and retain the model service's
stricter 1.5 GiB child cap as defense in depth. The evaluator proves the shared
envelope and observed peaks; it does not attest that the example service unit or
its child cap is the active launcher. On macOS the
same command can collect correlated process-tree/quality evidence under
`macos-app-budget` mode, but it can never emit portable 4 GiB certification.
This gate's reviewed argv contract currently covers `llama.cpp` only. MLX keeps
its separate Apple qualification lane; either result is evidence on the observed
Mac and neither is a claim that a 4 GiB Mac can run the workload.

Fewer weight bits do not automatically mean lower peak memory. A current
[llama.cpp 2 GiB ARM report](https://github.com/ggml-org/llama.cpp/issues/22713)
measured a Qwen 0.8B Q4 process around 1,029 MiB, while lower-bit variants tried
to allocate a roughly 3 GiB KV buffer. OpenProjects therefore pins context,
cache, slots, and batching and measures the whole process tree instead of
inferring RAM from the GGUF filename.

## FreeToken and extreme quantization

[FreeToken](https://github.com/FlashML-org/FreeToken) is valuable architecture
research and an optional OpenAI-compatible server. Its adaptive CPU/GPU
residency, bandwidth calibration, bounded expert/prefix caches, elastic memory,
and fast-load artifacts are patterns OpenProjects should borrow in its resource
governor and runtime qualification. The associated
[paper](https://arxiv.org/abs/2608.16157) evaluates starting at an 8 GiB laptop
GPU.

FreeToken is not the 4 GiB default: the reviewed source path targets
Linux/x86-64 with NVIDIA/CUDA, and its supported models and working memory are
separate from this harness. It attaches through the strict `freetoken`
loopback/alias adapter on suitable hardware; it receives no policy or tool
authority beyond the normal OpenProjects kernel.

Likewise, the approximately 6.2 GB 1-bit Qwen3.8-27B artifact shown in the
provided screenshots cannot fit a 4 GiB machine and is not an agent-quality
result. Unsloth’s own current guidance says the extreme 1-bit variant is not
for agentic use. OpenProjects evaluates valid structured calls and project
outcomes rather than repeating top-1 recovery as “agent accuracy.” See the
[source audit](./research.md#qwen38-and-unsloth-screenshot-claim-audit).

## Promotion gates

A local learned lane is promotable only when all of these hold on the exact
target class:

- exact runtime, model, quantization, tokenizer/template, and artifact hashes;
- one worker, bounded context/output, and no implicit download or egress;
- 100% schema, scope, approval, and no-unauthorized-effect assertions;
- task-specific quality against the versioned OpenProjects corpus;
- no OOM/Metal failure, normal memory pressure, and no material swap growth;
- for the portable 4 GiB lane, whole-cgroup peak at or below 3.5 GiB and
  combined OpenProjects/model process-tree RSS at or below 1.5 GiB;
- process exit/unload returns close to baseline with no orphan listener; and
- failure falls back to a smaller/remote reviewed lane or a clear abstention,
  never silent capability escalation.

This is how OpenProjects stays responsive: less resident machinery, smaller
authority surfaces, and measured specialization instead of one oversized model
attempting every job.
