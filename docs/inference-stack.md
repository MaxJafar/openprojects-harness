# Inference stack and promotion order

Status: implementation decision, recorded 2026-08-27. No public model-runtime
claim is made until the corresponding target-host report passes.

## Chosen stack

OpenProjects keeps inference replaceable. The durable product is the small
TypeScript/SQLite harness, policy kernel, approval ledger, tool gateway, and
evaluation corpus. A model server may propose text or tool calls; it never owns
permissions, approvals, persistence, or recovery.

| Lane | Runtime | First job | Current status |
| --- | --- | --- | --- |
| 4 GiB core | No resident learned model | Durable control plane, deterministic retrieval and evaluation | Implemented; portable learned lane still needs the Linux resource gate |
| Portable local | `llama.cpp` with one pinned GGUF and authenticated alias | Narrow project analyst | Strict adapter and gate implemented; real 4 GiB Linux evidence pending |
| Apple Silicon | MLX-LM with one externally pinned snapshot | Sequential project analyst | Qwen 4B analyst passed 3/3 on the M3/8 GB host; supervisor is not qualified |
| NVIDIA accelerator | FreeToken with one fixed served alias | Optional higher-quality MoE analyst | Strict adapter and mock conformance pass; real Windows/WSL or Linux NVIDIA run pending |
| Hosted compatibility | Dependency-free OpenAI-compatible HTTPS | Optional primary route or explicitly allowed fallback | Implemented; disabled until the operator accepts the data boundary, model, and prices |
| Semantic retrieval | BGE-M3 through digest-pinned Ollama | Offline memory retrieval | Qualified on the Mac; run separately from other large learned lanes |
| Speech | `whisper.cpp` | On-demand transcription | Qualified on the Mac; not resident in the 4 GiB core |

This keeps the product useful on small machines while allowing larger hardware
to earn a better inference lane. It also avoids making one young engine or one
model family an architectural dependency.

## Framework strategy

The authority-bearing runtime does not migrate to LangGraph, CrewAI, AutoGen,
Temporal, or another orchestration framework. Frameworks can integrate at the
edges through the authenticated OpenProjects JSON/SSE API, or contribute
reviewed tools through the existing narrow MCP and declarative JSON gateways.
Every such call still passes the same local schemas, grants, policy decisions,
durable approvals, timeouts, ambiguity handling, and run snapshots.

Inference frameworks integrate through explicit provider adapters:

- `mlx-lm` omits request-time model selection and requires the pinned
  `default_model` identity;
- `llama.cpp` requires authenticated loopback `/v1`, a fixed alias, strict
  tool JSON, and no parallel tool calls;
- `freetoken` requires unauthenticated loopback `/v1`, exactly one fixed safe
  `--served-model-name` alias, strict tool JSON, and no parallel tool calls;
- a generic `openai-compatible` route remains available for reviewed hosted or
  local services, but does not inherit those runtime-specific guarantees.

The generic route uses bounded native HTTP and Chat Completions without adding
OpenAI, Google, or Anthropic SDKs. The disabled catalog uses the official
[OpenAI API](https://platform.openai.com/docs/api-reference/chat/create),
[Gemini OpenAI-compatibility](https://ai.google.dev/gemini-api/docs/openai), and
[Anthropic OpenAI-SDK compatibility](https://platform.claude.com/docs/en/cli-sdks-libraries/libraries/openai-sdk)
base URLs. Model IDs, context limits, prices, and tool behavior remain
operator-qualified inputs; Anthropic explicitly describes its compatibility
layer mainly as a testing and comparison path.

Hosted inference cannot appear accidentally: `externalInference: allow`, an
enabled `local: false` route, an environment-only credential name, HTTPS, and
the exact network allowlist must agree. Local routes remain preferred and do
not fall through to hosted inference unless `allowRemoteFallback: true` is also
explicit. Exploration never crosses the local/remote boundary.

Embeddings remain a separate lane. The 4 GiB profile uses the in-process
256-dimensional feature hash; higher-memory private machines may run qualified
BGE-M3 locally; an OpenAI-compatible `/embeddings` service is available only
with its own `externalData: allow` and environment credential. Memory review,
retrieval attribution, and bounded feedback are provider-agnostic SQLite facts,
not online reinforcement learning or model-weight updates.

Optional framework examples must keep their dependencies outside the root
production package. A framework is promoted only when its interoperability
test demonstrates the same policy/approval behavior; popularity alone is not a
migration reason.

The first example is the isolated
[`AI SDK + MCP` bridge](../examples/frameworks/ai-sdk-mcp/README.md). A local
OpenAI-compatible model sees exactly one MCP tool, while the bridge fixes the
OpenProjects principal, workspace, and project outside model input. Its
credential must have exactly `read` and `run` for exactly one workspace; it
cannot approve or administer. The model loop has a one-execution budget and a
second synthesis step with tools disabled. Raw run status and approval state
remain deterministic control data rather than model-authored claims. Its own
lockfile, tests, and dependencies do not enter the root production graph.

## FreeToken lane

FreeToken is useful for a separate NVIDIA machine, not for the 8 GB Mac or the
4 GiB product promise. Its current documented source lane requires Linux
x86-64, NVIDIA/CUDA 13-class support, and a model from its known-good table.
FreeToken exposes OpenAI-compatible `/v1/models` and
`/v1/chat/completions`, but documents no model-server authentication. The
strict adapter is therefore loopback-only and refuses API keys, remote hosts,
checkpoint-shaped request model IDs, multiple served models, response identity
drift, malformed tool JSON, and parallel tool calls.

Start with a documented MoE checkpoint, not Qwen3.8:

```bash
ft serve \
  --model nvidia/Qwen3.6-35B-A3B-NVFP4 \
  --served-model-name openprojects-qwen36-moe \
  --host 127.0.0.1 \
  --port 1919 \
  --max-running-requests 1 \
  --max-output-tokens 512 \
  --max-seq-len-override 8192
```

The checkpoint path or Hub ID belongs only to the externally reviewed launch
configuration. OpenProjects sends the safe alias
`openprojects-qwen36-moe`, so a prompt or framework cannot select another
checkpoint or trigger request-time loading.

Use the disabled route in
[`examples/model-routes.yaml`](../examples/model-routes.yaml) and replace every
placeholder in
[`examples/appliance-qualification.freetoken.example.json`](../examples/appliance-qualification.freetoken.example.json)
with exact local hashes. Record the resolved FreeToken package or Desktop
asset, source commit/build stamp, model format and complete checkpoint
inventory. Native Windows Desktop, WSL2, and Linux are distinct evidence lanes.

Then run:

```bash
npx tsx src/cli.ts qualify \
  --config /absolute/path/to/freetoken-candidate.yaml \
  --manifest /absolute/path/to/appliance-qualification.freetoken.json \
  --require text \
  --json
```

Qualification is read-only. It requires singleton `/v1/models` identity,
plain text, exactly one structured echo tool call, final text after the tool
result, exact response model identity, and matching artifact pins. It does not
download, start, promote, or quality-certify a model. The live representative
analyst corpus must pass separately before the route is enabled.

## Qwen3.8 decision

Qwen3.8 is not required. The official Qwen3.8-27B checkpoint is a dense
vision-language model, not MoE. The actual Qwen3.8 MoE is
Qwen3.8-2.4T-A95B: 2.4 trillion total parameters with 95 billion activated per
token. That model is not a consumer-hardware target and carries a separate
model license. FreeToken's current known-good model table does not list either
Qwen3.8 release.

If a later low-bit Qwen3.8-27B GGUF proves useful, test it through the
`llama.cpp` lane as a separate dense candidate. It must beat the existing
analyst route on the same corpus and fit the measured target envelope. It does
not replace the default merely because it is newer.

Primary upstream references:

- [FreeToken repository and API overview](https://github.com/FlashML-org/FreeToken)
- [FreeToken installation contract](https://github.com/FlashML-org/FreeToken/blob/main/docs/install.md)
- [FreeToken supported models](https://github.com/FlashML-org/FreeToken/blob/main/docs/models.md)
- [FreeToken CLI limits](https://github.com/FlashML-org/FreeToken/blob/main/docs/cli.md)
- [Qwen3.8-27B model card](https://huggingface.co/Qwen/Qwen3.8-27B)
- [Qwen3.8-2.4T-A95B model card](https://huggingface.co/Qwen/Qwen3.8-2.4T-A95B)

## Before-public promotion order

1. Keep the deterministic harness corpus and all unit/integration tests green.
2. Run the native Mac and Windows platform qualification at the same source
   state; retain reports and SHA-256 manifests.
3. Run the portable learned analyst in a real 4 GiB Linux VM/cgroup and pass
   the full resource, unload, and quality gates.
4. Run the Mac read-only analyst pilot with the exact qualified MLX snapshot,
   BGE-M3 and Whisper sequentially.
5. If suitable NVIDIA hardware is available, qualify FreeToken first with a
   documented Qwen3.6/Qwen3.5 MoE checkpoint and then run the same analyst
   corpus. Keep it disabled on failure.
6. Exercise at least one real read-only MCP or JSON integration, including
   hostile-content and crash/ambiguous-outcome cases.
7. Only after those reports are reproducible should packaging and public
   release claims be finalized.
