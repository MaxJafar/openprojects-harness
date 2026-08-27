# MLX-LM on Apple Silicon

OpenProjects supports the official `mlx_lm.server` as provider `mlx-lm`. The
command and HTTP contract below were verified against MLX-LM v0.31.3. This
runtime integration is deliberately text/tool-only. The appliance qualifier
can independently probe a reviewed local MLX-VLM-compatible endpoint with
bounded synthetic images, but image ingestion, OCR, and multimodal product chat
remain unimplemented. Passing that endpoint probe does not make this adapter
accept images.

## Trust and process boundary

Run MLX-LM as a separately supervised local service. OpenProjects never
installs Python packages, downloads weights, starts the process, or passes a
model/repository name in a completion request. Omitting the request `model`
field forces the official server to use the `default_model` pinned by its
startup `--model` argument. This avoids request-time model switching and
implicit Hugging Face downloads from OpenProjects requests.

The upstream server itself does not expose a "default model only" mode: another
client that can reach its port can still submit a different path or Hub ID.
Treat loopback as necessary but insufficient. Run it under a dedicated account,
restrict which local principals can connect where the host supports that, and
deny inference-service egress after provisioning so an alternate Hub model
cannot be fetched.

The adapter accepts only `http://` loopback URLs with the exact `/v1` API root,
requires routing entries to declare `local: true`, and rejects API keys. Do not
expose MLX-LM on a LAN: its own documentation says the HTTP server implements
only basic security checks and is not recommended as a production network
boundary.

Precreate a service-owned mode-`0700` Hugging Face cache directory even for an
absolute local model: the pinned server's `/v1/models` handler scans that cache.
Then stage an audited model snapshot and supervise a command shaped like:

```sh
sudo install -d -o _openprojects -g _openprojects -m 0700 \
  '/Library/Application Support/OpenProjects/cache/huggingface/hub'

HF_HUB_OFFLINE=1 \
TRANSFORMERS_OFFLINE=1 \
HF_HUB_CACHE='/Library/Application Support/OpenProjects/cache/huggingface/hub' \
/Library/OpenProjects/mlx-venv/bin/python3 -I -m mlx_lm server \
  --model './models/mlx-model' \
  --host 127.0.0.1 \
  --port 8080 \
  --decode-concurrency 1 \
  --prompt-concurrency 1 \
  --prompt-cache-size 1 \
  --prompt-cache-bytes 268435456 \
  --allowed-origins 'http://127.0.0.1'
```

The offline environment variables are defense in depth documented by Hugging
Face; enforce deny-by-default service egress at the host boundary as the
authoritative control. Provision the MLX-LM Python environment outside
OpenProjects, pin `mlx-lm==0.31.3`, `mlx==0.31.2`, and
`transformers==5.12.1`, pin every transitive dependency artifact by hash, and
verify the installed `python3 -I -m mlx_lm server --help`; do not deploy from a
floating `pip install`. Transformers 5.13 and newer are incompatible with the
unpatched v0.31.3 wheel ([upstream issue #1458](https://github.com/ml-explore/mlx-lm/issues/1458)); its fix landed after that release. Do not add
`--trust-remote-code`. The current server does not
expose the older `--max-kv-size` option; OpenProjects instead applies an
8,192-token routing cap for the 8 GB profile and starts from one prompt/decode
worker. `--prompt-cache-bytes` bounds retained prompt-cache storage, not active
prefill or peak unified memory.

```yaml
model:
  provider: mlx-lm
  model: mlx-community/Qwen3-1.7B-4bit # audited operator label; not sent on the wire
  baseUrl: http://127.0.0.1:8080/v1

routing:
  dailyBudgetUsd: 0
  explorationRate: 0
  routes:
    - id: local-mlx-lm
      provider: mlx-lm
      model: mlx-community/Qwen3-1.7B-4bit
      tasks: [supervisor, project_analysis, memory_curator, summarization, notification]
      baseUrl: http://127.0.0.1:8080/v1
      local: true
      enabled: true
      quality: 0.75
      inputCostPerMillion: 0
      outputCostPerMillion: 0
      contextWindow: 8192
```

## Model guidance

- 8 GB Apple Silicon: `mlx-community/Qwen3-1.7B-4bit`, 8k route context, one
  decode/prompt worker is economical as a protocol fixture. On the recorded M3
  pilot it passed the bounded text/tool probe but failed both full-supervisor
  diagnostics and the compact project-analyst gate (0/3); it is not an eligible
  production route.
- `mlx-community/Qwen3-4B-Instruct-2507-4bit` is the checkpoint in MLX-LM's
  official tool-use example. Exact revision
  `50d427756c6b1b2fe0c0a10f67fbda1fc8e82c1b` passed the recorded M3/8 GB
  project-analyst gate 3/3, with one scoped read and valid strict result in each
  trial. This makes it eligible only for that lane. Swap use rose materially
  during the sequential run, so there is no co-residency or supervisor-headroom
  claim; 16 GB or more remains the safer starting tier for broader evaluation.

Qwen3.5 and arbitrary Gemma conversions are not assumed to support tools.
Structured tool output depends on the exact model, tokenizer special tokens,
chat template, parser, quantization, and MLX-LM version. OpenProjects rejects
malformed JSON arguments, unoffered tools, duplicate call IDs, contradictory
finish reasons, and empty responses that can indicate parser loss. A successful
text completion alone is not tool qualification.

Before production use, create the reviewed snapshot manifest and run
`openprojects qualify --config <config> --manifest <manifest.json>` to verify
`/health`, `/v1/models`, plain text, the exact structured tool roundtrip, and
the complete snapshot inventory. MLX qualification intentionally refuses to
run without `servedModelId` plus artifact hashes. The separate `doctor --probe`
command is only a shallow connectivity/text check; it is not a tool or identity
qualification. The route's `model` value is an audited operator label and
is never sent to MLX-LM; it therefore cannot prove which local directory the
server loaded. Omitted-model chat responses report the literal `default_model`
alias, not the resolved path. A production manifest must bind the canonical
local path reported by `/v1/models` (`servedModelId`) to hashes of artifacts
contained in that same staged model directory. Capability probing and
active-model identity are separate checks, and an unpinned label is not an
identity proof.

After that preflight, run the live task-quality gate against a dedicated route
that advertises exactly `project_analysis`:

```bash
openprojects eval-project-analyst \
  --config <candidate-config> \
  --manifest <candidate-manifest.json> \
  --route <project-analysis-only-route> \
  --attempts 3
```

This command enables only the named candidate in an in-memory configuration
copy, disables exploration, and requires every trial to make exactly one
host-scoped `project_analysis_snapshot_v1` read followed by strict grounded
result JSON. It does not edit the source route or qualify the supervisor,
embeddings, or vision. Escalating from 1.7B to 4B therefore means stopping the
first server and running the same gate with a separately reviewed snapshot and
pin; it is not router fallback.

For the wizard's routed profile, the manifest pin key is
`route:local-mlx-lm`. Start from
[`examples/appliance-qualification.macos.example.json`](../examples/appliance-qualification.macos.example.json),
but treat it only as a fail-closed schema template: every all-zero hash must be
replaced, and its abbreviated artifact array must be replaced with a one-to-one
inventory of **every** regular file in the materialized snapshot. A normal
downloaded Qwen snapshot has more files than the abbreviated template. The
qualifier rejects missing files, unlisted extra files, symlinks, hard links,
special files, escaping paths, duplicate paths, and noncanonical
`servedModelId` values. The exact inventory must include `config.json`,
`tokenizer_config.json`, `tokenizer.json` or `tokenizer.model`, and either one
top-level `model.safetensors` or every shard named by
`model.safetensors.index.json`. It is bounded to 64 files, 64 directories, and
64 GiB and fails explicitly above those limits.

The dedicated [macOS appliance runbook](./macos-appliance.md) contains the
root-owned/service-owned path split, launchd templates, cache precreation,
complete-manifest procedure, and separate text, vision, embedding, and Whisper
qualification commands.

## Primary upstream references

- [MLX-LM repository and installation](https://github.com/ml-explore/mlx-lm)
- [MLX-LM v0.31.3 release](https://github.com/ml-explore/mlx-lm/releases/tag/v0.31.3)
- [Pinned HTTP server contract and security warning](https://github.com/ml-explore/mlx-lm/blob/v0.31.3/mlx_lm/SERVER.md)
- [Pinned server implementation and supported flags](https://github.com/ml-explore/mlx-lm/blob/v0.31.3/mlx_lm/server.py)
- [Pinned official Qwen3 4B tool-use example](https://github.com/ml-explore/mlx-lm/blob/v0.31.3/mlx_lm/examples/tool_use.py)
- [MLX framework](https://github.com/ml-explore/mlx)
- [Qwen3 1.7B MLX 4-bit model card](https://huggingface.co/mlx-community/Qwen3-1.7B-4bit)
- [Qwen3 4B Instruct 2507 MLX 4-bit model card](https://huggingface.co/mlx-community/Qwen3-4B-Instruct-2507-4bit)
- [Open upstream Qwen3.5/3.6 non-Coder tool-parser gap](https://github.com/ml-explore/mlx-lm/issues/1293)
- [Hugging Face offline-mode environment variable](https://huggingface.co/docs/huggingface_hub/package_reference/environment_variables#hf-hub-offline)
