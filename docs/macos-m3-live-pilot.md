# Apple M3 8 GB live local-AI pilot

Status: the original text/Whisper pilot, v0.4 project-analyst comparison, representative host/live corpus, bounded semantic-embedding appliance gate, BGE-M3 reliability soak, manual multilingual memory-retrieval trial, and formal versioned semantic evaluator completed 2026-08-25 on the current Apple M3 / 8 GB host. The exact BGE-M3 artifact is qualified for the semantic embedding lane; deployment selection and memory re-embedding remain explicit operator actions. This is a bounded workstation pilot, not a general production certification.

## Provisioned boundary

- All installed Python packages, model copies, configuration, state, and qualification manifests live under the ignored `.openprojects-appliance/` workspace directory.
- The isolated runtime is Python 3.12.13 with `mlx-lm==0.31.3`, `mlx==0.31.2`, and `transformers==5.12.1`, installed from a complete hash lock. MLX-LM 0.31.3 is incompatible with Transformers 5.13 and newer; see [upstream issue #1458](https://github.com/ml-explore/mlx-lm/issues/1458).
- The Python virtual environment links to the Homebrew Python 3.12 installation. It does not mutate global packages, but it is not a self-contained appliance interpreter.
- The first interrupted resolver attempt touched the existing user-level `uv` cache. The completed installation used only the workspace-local cache, so do not claim that every provisioning write was local.
- No launchd unit or `/Library` path was installed. All inference processes were foreground pilot processes rather than production services; shutdown was verified at completed checkpoints, while later gates restarted only the lane they needed.
- The embedding comparison used a workspace-local pinned Ollama v0.32.15 service on loopback with cloud access disabled. It ran separately from MLX and Whisper.

## MLX text result

The staged model is `mlx-community/Qwen3-1.7B-4bit` at immutable Hub revision `3b1b1768f8f8cf8351c712464f906e86c2b8269e`.

- Exact snapshot: 11 regular, non-linked, mode-`0400` files; 984,015,687 bytes.
- `model.safetensors` SHA-256: `0e86d9677e519323849eac1bc272caae88567a481ff188c431f70be543d9995f`.
- The offline MLX service bound only `127.0.0.1:8080`; its runtime Hugging Face cache remained empty.
- `/health` passed and `/v1/models` returned one canonical local snapshot path.
- OpenProjects text qualification returned `overall: qualified` in 3,235 ms. The exact deployment produced plain text, exactly one structured `qualification_echo` tool call, and final text after the tool result. All 11 manifest hashes matched.
- A separate 33-prompt-token / 24-completion-token request completed in 0.62 seconds. macOS reported a 1,203 MB physical footprint after inference and a 1,490 MB peak.

This narrow protocol result is not sufficient to promote the model as the OpenProjects supervisor. A natural Atlas risk request using the complete agent prompt and ten-tool catalog returned tool-shaped JSON as final text (`finish_reason: stop`) and executed zero tools. A second diagnostic with a shorter, five-tool, no-skill configuration returned generic prose and also executed zero tools. The runtime correctly refused to reinterpret either response as an action.

That result justified only a smaller, separately evaluated specialist experiment. It did not qualify 1.7B as the full project-operations colleague, and structured-call validation was not weakened to make it pass.

## Compact project-analyst result

v0.4 narrows project analysis to an independently promotable lane: no supervisor skills, no retrieved memory, two steps, one tool call, a 30-second runtime budget, and exactly one available tool. `project_analysis_snapshot_v1` accepts no model arguments; the host obtains workspace/project scope from the durable run and returns a bounded read-only snapshot. Completion must be strict `openprojects.project-analysis-result.v1` JSON whose project, task IDs, and evidence IDs are grounded in that snapshot and whose `actionTaken` value is `false`.

The same pinned 1.7B snapshot passed the text/tool identity preflight and then failed the route-isolated analyst gate **0/3**:

- one trial made the correct single scoped tool call but returned an object that failed the exact result schema because fields were missing or unknown;
- two trials produced no structured tool call;
- all trials remained read-only: no approvals, external writes, or outbox records were created.

Decision: 1.7B is not eligible for this compact specialist lane and must not be advertised as a supervisor route. The next trial therefore used a separately pinned 4B candidate with the identical lane and graders. This was a sequential manual escalation, not an automatic router fallback.

The machine-readable analyst report deliberately marks `supervisor`, `semanticEmbeddings`, and `vision` as `not_evaluated`. A passing candidate becomes eligible only for the compact `project_analysis` capability.

## 4B project-analyst result

The escalated candidate was `mlx-community/Qwen3-4B-Instruct-2507-4bit` at immutable Hub revision `50d427756c6b1b2fe0c0a10f67fbda1fc8e82c1b`.

- Exact snapshot: 13 regular, non-linked, mode-`0400` files; 2,278,972,236 bytes.
- `model.safetensors` SHA-256: `2a73c6c248601ab904e035548abd8e6abb65ea27dcb5f342fb0a8910eb44173f`.
- The reviewed `analyst-mlx-4b` route advertised only `project_analysis`, declared zero provider cost, used an 8,192-token route context and one-server concurrency, and remained disabled in the source configuration.
- Text/tool identity preflight passed against the complete snapshot inventory.
- The live analyst gate passed **3/3** in 9.114, 8.186, and 9.323 seconds.
- Every trial selected the exact pinned route, made exactly one `project_analysis_snapshot_v1` read, returned valid strict grounded result JSON, and produced zero approvals and zero outbox records.

Decision: this exact 4B snapshot is eligible for the compact project-analyst lane on this host under the tested sequential configuration. The report records `projectAnalysis: passed` and leaves `supervisor`, `semanticEmbeddings`, and `vision` as `not_evaluated`. It does not qualify the 4B model as the authority-bearing supervisor and does not enable or promote the source route.

Swap use rose materially during the sequential 4B pilot. That observation rules out a co-residency or spare-headroom claim on this 8 GB Mac: do not keep the 4B model, semantic embeddings, a VLM, and Whisper resident together. A supervisor evaluation belongs on stronger hardware unless a separately measured host profile proves adequate headroom.

## Representative corpus result

The subsequent `openprojects.representative-eval-corpus.v1` gate binds host safety/durability cases and the compact live analyst prompts in one versioned report. The exact corpus file SHA-256 was `02213178021dd3070ba7df398e97fcd646a291fa5074d980b944c6ae8791c5ff`.

- The offline deterministic lane passed **8/8** cases across project risk, deadlines, reviewed group memory, rejection/one-shot approval, prompt injection, and approval crash recovery. It removed configured routing, used in-memory SQLite and the deterministic mock adapter, and made no live-model claim.
- The explicitly enabled live subset used the same exact pinned Qwen 4B route and passed **3/3** in 10,565 ms, 10,472 ms, and 8,976 ms.
- Each live trial made exactly one host-scoped `project_analysis_snapshot_v1` read, returned strict grounded `openprojects.project-analysis-result.v1` JSON, and produced zero approvals and zero outbox records.
- Approximate swap use increased by 425 MB during the sequential live representative run.

Decision: the expanded evidence still qualifies only the exact compact project-analyst lane under sequential operation. The deterministic approval/memory/recovery cases validate host behavior rather than Qwen behavior. The live prompts do not evaluate the full supervisor, memory curator, a VLM, concurrent lane residency, or arbitrary prompt-injection resistance. No route was enabled or promoted.

## Semantic embedding result

The unchanged embedding gate requests 12 finite, unit-normalized 1,024-dimension vectors for four project-domain query/positive/negative triplets, including Russian and Azerbaijani queries. Every positive must beat its negative by cosine margin at least 0.05 and the mean margin must be at least 0.10. Identity discovery, artifact hashing, and the live probe ran with local-only policy and cloud-disabled Ollama v0.32.15.

The first candidate was Qwen3-Embedding 0.6B Q8_0:

- Ollama tag/manifest digest: `ac6da0dfba84a81fdbfbaf330198c33cd77c4cdfc53e8bc50eb581914a15621d`.
- Model blob SHA-256: `06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439`.
- Every positive outranked its paired negative and mean margin was approximately 0.116, but repeated minimum margins were only approximately 0.009–0.016.

Decision: identity qualified, semantic quality failed. The exact Qwen artifact remains staged but unqualified; the threshold was not weakened.

The second candidate was `bge-m3:latest` F16:

- Ollama tag/manifest digest: `7907646426070047a77226ac3e684fbbe8410524f7b4a74d02837e43f2146bab`.
- Model blob SHA-256: `daec91ffb5dd0c27411bd71f29932917c49cf529a641d0168496c3a501e3062c`.
- The 1,024-dimension lane returned `overall: qualified` in 1.715 seconds with minimum margin 0.130 and mean margin 0.205.
- The production Ollama adapter then completed 50/50 sequential three-text batches without error or dimension drift. Repeated-input cosine was 0.9999997075; warm latency was 69.12 ms p50 and 72.76 ms p95, with a 1,478 ms cold maximum.
- Ollama's BGE worker used approximately 1.06 GB RSS. Parent and worker listeners remained loopback-only.
- A bounded in-memory production `MemoryEngine` trial loaded 12 active project memories and issued six English/Russian/Azerbaijani queries. Recall@1 was 0.8333, Recall@3 was 1.0, and MRR was 0.9167; five expected memories ranked first and the Azerbaijani case ranked second. No persistent database was opened.
- The formal `openprojects.semantic-embedding-eval-report.v1` gate completed 10/10 batches with zero errors over corpus `project-retrieval-en-ru-az.v1` (10 documents and 12 queries). Aggregate Recall@1, Recall@3, and MRR were all 1.0; minimum repeated-input cosine and minimum cross-batch drift cosine were both 1.0; batch latency was 452 ms p50 and 480 ms p95.
- The evaluator observed the exact configured model, digest, and 1,024 dimensions. Source config and manifest hashes were unchanged, and its posture records no persistent harness-state write, download, promotion, route mutation, or text-model request.

Decision: this exact BGE-M3 artifact is formally qualified for the semantic embedding lane. Qualification does not edit the runtime configuration, replace `builtin-hash-v1`, or backfill existing memory vectors. Selecting the BGE configuration and running `learning embed` remain separate reviewed operator actions. This result does not qualify the supervisor or vision and does not justify co-residency with the 4B model on this 8 GB host.

## Whisper result

The existing local whisper.cpp model was copied into the protected pilot snapshot and pinned:

- Model: `ggml-large-v3-turbo-q5_0.bin`, 574,041,195 bytes.
- SHA-256: `394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2`.
- Runtime: Homebrew `whisper-cli` 1.9.1 with FFmpeg 8.1.
- A locally synthesized known-audio fixture containing “open projects qualification phrase” matched exactly.
- OpenProjects transcription qualification returned `overall: qualified` in 9,229 ms.

MLX and Whisper were qualified sequentially, never resident together.

## Remaining limits and unqualified lanes

- `builtin-hash-v1` remains the repository default and is not a semantic model. The exact BGE-M3 artifact is qualified but has not been selected in the default deployment or used to re-embed existing memories; Qwen3-Embedding failed the unchanged semantic margin threshold.
- The standalone v0.6 VLM readiness evaluator exists, but OpenProjects image/document ingestion is not implemented and no VLM was downloaded or qualified on this host. Qwen3-VL 2B 4-bit is only the proposed first isolated candidate; the repository has no live vision pass.
- The 1.7B model failed both the natural full-supervisor tool-use diagnostic and the compact project-analyst gate. The separately pinned 4B model passed only the analyst gate; no supervisor route is qualified on this host.
- The representative corpus passed 8/8 deterministic host cases and 3/3 pinned live analyst prompts. That is a regression/promotion gate for those exact contracts, not a general security certification or evidence for supervisor/vision behavior.
- The 4B representative run added approximately 425 MB of swap in sequential operation. It does not establish safe co-residency with BGE-M3, Whisper, or a future VLM.
- MLX-LM’s HTTP server is explicitly a basic-security development endpoint. Loopback is acceptable for this trusted single-user pilot, not a corporate multi-user security boundary.

## Earlier repository checkpoint

At the conclusion of the original text/Whisper pilot, before the v0.4 specialist extension:

- TypeScript/check/build: 214 tests passed.
- Training lab: 38 tests passed.
- Port 8080 was closed, no model or chat process remained, and the SQLite owner lock was absent. These are historical checkpoint facts, not a claim about a later gate while it is running.
