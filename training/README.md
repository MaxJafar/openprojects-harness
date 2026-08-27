# Reviewed local fine-tuning lab

This directory is an offline-from-the-live-runtime boundary for a small local drafting specialist. Planning may name a Hugging Face repository, but `--execute` accepts only a previously downloaded, non-symlink model directory beneath `training/models/` whose exact file set, sizes, and SHA-256 values match a reviewed lock beneath `training/model-locks/`. The child process is forced into Hugging Face/Transformers offline mode and receives neither implicit Hub credentials nor proxy variables. The lab cannot read the OpenProjects SQLite database, does not accept raw Telegram/group exports, and never changes the harness model routes. It consumes only the deterministic learning-export bundle after a reviewer approves explicit row IDs.

The smallest candidate configured for the current 8 GB Apple Silicon host is [`Qwen/Qwen3-1.7B-MLX-4bit`](https://huggingface.co/Qwen/Qwen3-1.7B-MLX-4bit): batch size 1, four LoRA layers, rank 8, 1,024-token sequences, prompt masking, and gradient checkpointing. This remains a supervised experiment, not an unattended-stability claim. [`mlx-lm` issue #1658](https://github.com/ml-explore/mlx-lm/issues/1658) reports non-finite gradients for BF16 Qwen3-1.7B, while the proposed finite-gradient guard in [PR #1659](https://github.com/ml-explore/mlx-lm/pull/1659) is not part of this lab. A displayed loss can remain finite while individual gradients are corrupt, so monitor the run and evaluate the saved adapter independently.

A Gemma 3 1B checkpoint is another small option, but its Gemma license and any gated access must be reviewed separately. Qwen3.5-2B is intentionally not the Apple default while MLX training is being qualified; treat it as a remote/CUDA route candidate instead.

Use the adapter for narrow, measurable work such as project-message drafting, structured extraction, summaries, or memory classification. Keep the stronger routed model in charge of supervision, tools, permissions, and hard reasoning.

## Safety contract

Preparation fails closed unless all of these match:

- `manifest.json` has schema `openprojects.learning-export.v1`, a valid canonical manifest digest, and exact per-file row counts and SHA-256 digests.
- Configs, manifests, reviews, JSONL rows, preflight results, and adapter configs reject duplicate JSON keys instead of accepting the last value.
- Every JSONL row has the expected OpenProjects schema, canonical serialization, deterministic order, bounded character and UTF-8 lengths, a nontrivial target, and a unique ID. The example caps prompts at 1,200 characters and responses at 400 characters; prompt plus completion must also fit a conservative `2 × maxSequenceLength` character and byte envelope.
- `review.json` is bound to that manifest and dataset digest, names every approved row ID, records an accountable reviewer, has the exact purpose `model_training`, and has all five attestations set to `true`. A generic content review cannot be reused as training approval.
- At least two independent source components exist. Rows connected by the same source run or normalized prompt are assigned together to one side of a deterministic split. The 50-row pilot holdout is written outside MLX's data directory and is not evaluated automatically.
- Immediately before execution, the pinned local tokenizer and its chat template reproduce MLX's completion formatting with `tools=None`. The prompt-only tokens must be an exact prefix of the full prompt-plus-completion tokens. Every training row must use at most `maxSequenceLength - 64` tokens, leave the prompt-mask offset before the end, and retain at least 16 supervised completion tokens. Truncation is forbidden and the preflight report is hashed into the run spec.
- MLX runs under Python isolated mode (`-I`) from the trusted `training/` directory. The run spec and tokenizer preflight bind the exact Python version, module origins, and pinned `mlx-lm`, `mlx`, and `transformers` distribution versions. A config-adjacent Python package cannot shadow `mlx_lm`.
- Immediately before launch and again after exit, the runner rehashes the reviewed model, prepared training file, and isolated runtime. Any mismatch is `failed_input_integrity` and cannot become a candidate.

The example refuses fewer than 150 approved rows and enforces at least 100 training / 50 sealed holdout rows after source-component grouping. If the groups are too skewed to satisfy both minima, preparation fails. That is a minimum pilot, not evidence of production quality. For a narrow production experiment, target at least 800 reviewed examples and move to a future three-way split near 500 training / 100 validation / 200 untouched holdout.

Hashes prove that the reviewed files did not change; they are not signatures and do not prove the reviewer’s identity. Protect the review bundle with normal filesystem/account controls.

## 1. Create one consistent export bundle

The safest path is to capture one loopback API response so the manifest and JSONL come from the same database snapshot:

```bash
mkdir -p training/reviewed-export
curl -fsS 'http://127.0.0.1:4310/api/learning/export?kinds=sft&includeComments=false' \
  -o training/reviewed-export/export-response.json
jq '.manifest' training/reviewed-export/export-response.json \
  > training/reviewed-export/manifest.json
jq -j '.datasets[] | select(.kind == "sft") | .jsonl' \
  training/reviewed-export/export-response.json \
  > training/reviewed-export/sft.jsonl
```

`export-response.json` is not read by the lab and should be removed from the reviewed bundle after extracting the two required files. The bundle is intentionally ignored by Git.

Inspect every candidate and copy `review.example.json` to `reviewed-export/review.json`. Replace both digests, the reviewer metadata, and `approvedRowIds`; do not approve rows by wildcard. Review authorization, participant expectations, sensitive data, provenance/licenses, prompt injection or poisoning, and training/holdout leakage.

## 2. Validate and prepare without training

Export and artifact paths are resolved relative to the config file. `modelLock` is restricted to `training/model-locks/`. Generated artifacts are confined beneath the relative `artifactRoot`, and every existing artifact path component is rejected if it is a symlink.

```bash
python3 -m training.prepare_dataset \
  --config training/config.example.json \
  --check

python3 -m training.prepare_dataset \
  --config training/config.example.json
```

This writes content-addressed, write-once-or-verify `train.jsonl` and `prepared-manifest.json` under `training/artifacts/datasets/`. The separately hashed `holdout.jsonl` and `holdout-manifest.json` live under `training/artifacts/holdouts/`, a path never passed to MLX v1. Repeating preparation is idempotent. A changed source, review, split, or existing artifact is rejected instead of overwritten by the lab; a user who controls the filesystem can still modify or delete local files.

Treat the holdout as sealed. Once anyone inspects its contents or uses its outcomes to make a tuning decision, it is burned and fresh authorized examples are required for a new holdout.

## 3. Inspect the exact MLX plan

Install the pinned MLX runtime in a local virtual environment. The upstream project documents completion datasets, prompt masking, and QLoRA for quantized models in its [LoRA guide](https://github.com/ml-explore/mlx-lm/blob/main/mlx_lm/LORA.md). This lab deliberately pins `mlx-lm==0.31.3`, `mlx==0.31.2`, and `transformers==5.12.1`: [upstream issue #1458](https://github.com/ml-explore/mlx-lm/issues/1458) records an import failure for this MLX-LM release with Transformers 5.13, while 5.12.1 is verified working. Regenerate and review a complete hash lock before treating the environment as an appliance runtime; the short requirements file alone is resolver input, not a supply-chain lock.

```bash
python3.12 -m venv training/.venv
training/.venv/bin/pip install -r training/requirements-mlx.txt
training/.venv/bin/python -m training.run_mlx_lora \
  --config training/config.example.json
```

The default command only prints the exact argv and generated MLX config. It does not start training.

The training interpreter tested on this host is Homebrew Python 3.12. The validation scripts use only the standard library and can run under the system `python3`, but use the 3.12 virtual environment for MLX dependencies.

Download the model explicitly, outside the runner, at the reviewed commit:

```bash
training/.venv/bin/hf download Qwen/Qwen3-1.7B-MLX-4bit \
  --revision 21457c6f51ed54a7c16e988c0844db973815c137 \
  --local-dir training/models/qwen3-1.7b-mlx-4bit
```

Then copy the example config and change `mlx.model` to `models/qwen3-1.7b-mlx-4bit`. Keep `modelSource`, the exact 40-character `modelRevision`, and `modelLock` unchanged. Execution rejects missing or extra snapshot files and any size/digest mismatch against the reviewed lock, then records the lock and snapshot identity in the run spec. These hashes establish local content identity, not authenticity or a signature; source/revision and licensing still require review.

## 4. Start training explicitly

First copy the example config to a new reviewed run config, select the pinned local model path, set `mlx.enabled` to `true`, and choose a never-before-used `adapterName`. Then provide the second independent gate:

```bash
training/.venv/bin/python -m training.run_mlx_lora \
  --config training/my-reviewed-run.json \
  --execute
```

The runner invokes `sys.executable -I -m mlx_lm lora` with an argv array, a trusted working directory, and `shell=False`; dataset text is never interpolated into a command. It disables remote experiment logging and network model resolution, runs exact tokenizer preflight, and records a write-once-or-verify run spec plus one attempt result.

V1 never resumes. MLX's `--resume-adapter-file` restores weights but not optimizer/scheduler state, so it is a warm start rather than trustworthy crash resume. Any existing adapter directory, weights, or prior attempt is refused. After interruption or any changed setting, use a fresh `adapterName` and start from the base snapshot.

A zero process exit yields only `candidate_unverified`, and only after a bounded strict safetensors scan proves at least one tensor, exact data coverage, and finite values in every supported floating tensor; the duplicate-key-free adapter config must also match the persisted model, LoRA, layer, sequence, and prompt-mask settings. Artifact sizes and SHA-256 hashes are candidate identities, not generation quality, signatures, or promotion approval.

The runner never fuses, uploads, serves, registers, evaluates against live group traffic, or promotes the result. Before manual routing, compare the adapter with the base model on frozen safety, tool-format, privacy, project-quality, and latency suites. A lower loss alone is not a promotion criterion.

The pre/post hashes detect ordinary or concurrent input changes but are not an operating-system immutability boundary. A hostile process with the same filesystem privileges could change and restore bytes between checks. Stronger production isolation requires an attempt-private snapshot or read-only mount and a less-privileged training process. The unit suite mocks MLX execution; an end-to-end parity run remains manual because the pinned runtime and ~914 MB model are intentionally not installed/downloaded by tests.

## What this deliberately does not do

- No online reinforcement learning or weight changes from reactions.
- No DPO from scalar likes/dislikes; the first lab accepts only reviewed SFT corrections.
- No automatic reviewer/consent inference.
- No Hugging Face token forwarding; use a cached/local model if gated access is required.
- No automatic holdout evaluation and no resume/warm-start path in v1.
- No shell commands, model fusion, uploads, or route edits.
