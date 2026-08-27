# Private macOS appliance and qualification

This stage adds a reviewable `launchd` appliance layout and a no-download qualification command. It does **not** install a runtime, download a model, promote an adapter, start a service, or claim that a successful smoke test is a quality/security certification.

## Honest status of the development Mac

The inspected target is an Apple M3 Mac with 8 GiB unified memory. The original inspection found no local model runtime or snapshot. A later workspace-local pilot staged an isolated MLX-LM environment, a fully hashed `mlx-community/Qwen3-1.7B-4bit` snapshot, and a pinned Whisper model; it qualified the narrow MLX text/tool protocol and local transcription. That does not make the Mac a qualified appliance:

- the 1.7B model failed the compact project-analyst live gate 0/3 and is not eligible as either that specialist or the supervisor;
- the separately pinned `mlx-community/Qwen3-4B-Instruct-2507-4bit` revision `50d427756c6b1b2fe0c0a10f67fbda1fc8e82c1b` passed the project-analyst gate 3/3, but supervisor status remains `not_evaluated`;
- workspace-local pinned Ollama v0.32.15 is now staged with cloud access disabled: Qwen3-Embedding 0.6B Q8_0 failed the unchanged semantic margin gate, while digest-pinned BGE-M3 F16 passed the appliance gate, 50-batch reliability soak, bounded multilingual `MemoryEngine` trial, and formal versioned evaluator; the exact BGE artifact is qualified for the semantic lane but has not been selected as the deployment default or used to re-embed memories;
- no VLM was staged, and product image/document vision remains disabled and unqualified.

v0.6 now provides an offline-built readiness gate for a future VLM candidate;
it does not change that live status. The first proposed isolated candidate is
`mlx-community/Qwen3-VL-2B-Instruct-4bit` revision
`9c4f5209e57b31f4b9dfba735de3fb983739c9cc` under a separately hash-locked
MLX-VLM 0.6.16 runtime. Stage and run it only after stopping MLX-LM, Ollama, and
Whisper, and do not claim success until the 50-attempt evaluator and host memory,
swap, listener, cache, and egress stop gates pass.

The evidence and exact boundary are recorded in [the M3 live pilot report](./macos-m3-live-pilot.md). Nothing in the production runbook treats staged pilot files as installed corporate services.

## Safe 8 GiB profile

Treat 8 GiB as a sequential-lane machine, not a miniature multi-model server. The evaluation order is text-first:

1. A separately pinned MLX-LM route with one decode, one prompt, one prompt-cache entry, and a measured context limit. The staged 1.7B route is useful only as a protocol fixture because it failed the specialist gate. The exact 4B revision recorded above passed that gate 3/3 and is eligible only for `project_analysis`.
2. The in-process feature-hash retrieval fallback remains the default and is **not** accepted by `qualify --require embeddings` as a semantic model. The exact pinned BGE-M3 artifact is formally qualified for the semantic lane, but replacing the fallback and re-embedding stored memories remain separate reviewed operator actions.
3. Whisper.cpp only on demand, after provisioning and hashing an approved model.

The 4B MLX text option is not a general 8 GiB default. Test it in a separate route rather than as automatic fallback and promote only the capability actually graded. The 3/3 analyst result does not qualify the supervisor. Swap use rose materially during this host's sequential run, so the pilot provides no evidence for model co-residency or spare supervisor headroom; move broader evaluation to stronger hardware unless a separately measured profile proves otherwise.

Do not keep the text model, a separate VLM, a semantic embedding model, and Whisper resident together on this Mac. Run these qualification lanes separately:

```bash
# Text/tool lane (the example manifest defaults to text only)
node dist/src/cli.js qualify \
  --config '/Library/OpenProjects/etc/openprojects.local.yaml' \
  --manifest '/Library/OpenProjects/etc/appliance-qualification.json'

# Experimental separate VLM lane; stop the text lane first on an 8 GiB host
node dist/src/cli.js qualify --require vision \
  --config '/Library/OpenProjects/etc/openprojects.local.yaml' \
  --manifest '/Library/OpenProjects/etc/appliance-qualification.json'

# Readiness/quality lane after the exact identity probe passes
# Export the protected server key only into this explicit command environment;
# the evaluator deliberately does not load a workspace .env file.
export MLX_VLM_SERVER_API_KEY="$(cat /protected/path/vision-server-api-key)"
node dist/src/cli.js eval-vision \
  --config '/Library/OpenProjects/etc/openprojects.vision-candidate.yaml' \
  --manifest '/Library/OpenProjects/etc/appliance-qualification.vision-candidate.json' \
  --suite evals/openprojects-vision.v1.json \
  --batches 10 \
  --timeout-ms 300000 \
  --json

# Semantic embedding lane; builtin feature hashing intentionally fails this gate
node dist/src/cli.js qualify --require embeddings \
  --config '/Library/OpenProjects/etc/openprojects.local.yaml' \
  --manifest '/Library/OpenProjects/etc/appliance-qualification.json'

# Versioned semantic retrieval/stability lane; run only against the pinned candidate
node dist/src/cli.js eval-semantic-embeddings \
  --config '/Library/OpenProjects/etc/openprojects.semantic-candidate.yaml' \
  --manifest '/Library/OpenProjects/etc/appliance-qualification.semantic-candidate.json' \
  --batches 10

# Whisper lane; requires the pinned model plus a reviewed known-audio fixture
node dist/src/cli.js qualify --require transcription \
  --config '/Library/OpenProjects/etc/openprojects.local.yaml' \
  --manifest '/Library/OpenProjects/etc/appliance-qualification.json'

# Live compact analyst gate; use a dedicated route that advertises only project_analysis
node dist/src/cli.js eval-project-analyst \
  --config '/Library/OpenProjects/etc/openprojects.analyst-candidate.yaml' \
  --manifest '/Library/OpenProjects/etc/appliance-qualification.analyst-candidate.json' \
  --route 'local-mlx-project-analyst' \
  --attempts 3
```

Use `--json` for the versioned report. A non-qualified result exits nonzero. `configured`, `reachable`, `capabilityQualified`, `identityQualified`, and `qualified` are separate fields; a listening server is never reported as capability-qualified merely because its port opened. One total `--timeout-ms` budget covers identity endpoints, all declared artifact hashes, and inference calls.

The command issues no pull/install/promotion request and writes no persistent OpenProjects state. Whisper qualification does create and remove bounded temporary working files. Local runtimes may create caches or logs, and a runtime not forced offline could lazily fetch; the JSON report states these caveats. The on-demand `launchd` job also writes stdout/stderr to its precreated protected logs.

## What each lane actually proves

| Lane | Live probe | Identity evidence | Important limit |
| --- | --- | --- | --- |
| Text | Separate non-empty assistant response; exactly one structured echo tool call with no extra text/calls/arguments; tool result followed by final assistant text | `/health` + `/v1/models` for MLX-LM, exact canonical `servedModelId`, and every declared contained artifact SHA-256 | A bounded harness smoke test, not task quality or safety qualification |
| Vision | A cryptographically selected three-request pattern over two embedded 95/96-byte solid-color PNGs; the pattern contains an adjacent repeat plus the other hidden label | Exact `/v1/models` served path/model plus the complete snapshot inventory | Constant and strict-alternating canned answers fail; this still qualifies that endpoint only, not product image/document ingestion |
| Embeddings | Four project-domain query/positive/negative triplets (including Russian and Azerbaijani queries) must return 12 finite, nonzero, unit-normalized vectors; every positive must beat its negative by cosine margin at least 0.05 and the mean margin must be at least 0.10 | Ollama model name and exact bare SHA-256 service digest matching runtime configuration, plus optional artifacts | Builtin feature hashing and merely distinct vectors do not satisfy the semantic-model gate |
| Transcription | Known local audio must contain the manifest's expected normalized phrase | Resolved executables and exact Whisper model/artifact SHA-256 | No cloud fallback; no supplied corporate voice fixture |

The project-analyst command is a task-quality gate layered on top of the text identity/protocol preflight. Its candidate route must be local, declare zero provider cost, advertise exactly `project_analysis`, and match strong `route:<id>` manifest identity material. The evaluator enables only that route in an in-memory copy with exploration disabled and requires 100% of the bounded trials to make the one scoped snapshot read, return strict grounded JSON, and produce no approvals or outbox records. It never edits or promotes the source route, and its report leaves supervisor, semantic embeddings, and vision as `not_evaluated`.

`eval-semantic-embeddings` similarly begins with the pinned embedding preflight, then runs the fixed `project-retrieval-en-ru-az.v1` corpus for 2–10 sequential batches. It grades Recall@1, Recall@3, MRR, repeated-input consistency, cross-batch drift, identity, dimensions, errors, and latency while leaving source config/manifest files and persistent harness state unchanged. The recorded exact BGE-M3 run passed 10/10 batches with Recall@1, Recall@3, and MRR all 1.0, zero errors, and minimum repeat/drift cosine both 1.0. Passing qualifies that embedding lane; it does not select the config or run `learning embed`.

For MLX-LM, the route `model` is an operator label. The server is launched with an exact local snapshot path, omitted-model chat responses use the literal `default_model` sentinel, and `/v1/models` exposes the served local path. Qualification therefore requires all of the following independently:

- `servedModelId` is an existing canonical absolute snapshot directory;
- `/v1/models` lists exactly that one canonical path, because omitted-model requests otherwise cannot be bound to one default;
- omitted-model responses report exactly `default_model`;
- the manifest pins every regular file in the materialized snapshot exactly once; symlinks, hard links, special files, missing files, and extra files fail closed;
- the inventory includes `config.json`, `tokenizer_config.json`, `tokenizer.json` or `tokenizer.model`, and either the sole top-level `model.safetensors` or every shard named by `model.safetensors.index.json`.

An arbitrary README, config, or single shard cannot establish identity. MLX-VLM additionally requires a processor/preprocessor config; its current third-party server requires a request model, so the qualifier sends the exact pinned `servedModelId`, never the repository label that might trigger request-time loading, and requires the response identity to match. Model identity still trusts the reviewed server protocol: the qualifier does not attest the MLX Python wheel, Python executable, or launchd process image. Pin those separately with a root-owned lockfile/SBOM and deployment evidence.

The two static PNG fixtures are committed as bounded base64 in [`src/qualification/index.ts`](../src/qualification/index.ts). Each is decoded only to verify its 95/96-byte bound and then sent inline; no remote image URL is fetched. The expected labels and selected three-call pattern are not disclosed in the prompts. Every pattern includes an adjacent repeated image plus the other image, so constant and strict-alternating text-only responders fail deterministically.

## Qualification manifest

Copy [`examples/appliance-qualification.macos.example.json`](../examples/appliance-qualification.macos.example.json) to the root-owned configuration directory. Every all-zero hash and example digest is an intentional fail-closed placeholder. Materialize a reviewed snapshot without Hugging Face cache symlinks, then enumerate every file under it exactly once, up to the supported 64-file/64-directory and 64-GiB bounds. If the real snapshot includes README, vocabulary, merge, special-token, generation, index, or sharded-weight files, they must all appear in the manifest; the abbreviated example is valid only for a curated directory containing exactly its listed files.

```bash
shasum -a 256 -- '/exact/model/snapshot/config.json'
shasum -a 256 -- '/exact/model/snapshot/model.safetensors'
```

The wizard's routed MLX target is `route:local-mlx-lm`; a non-routed configuration uses `model`. The report lists target IDs before a manifest is introduced. Pin IDs are restricted to `model`, `vision`, `embeddings`, `transcription`, or `route:<safe-id>`. The strict JSON loader rejects unknown properties, nested duplicate keys, symbolic-link manifest files, prototype-like target names, missing/escaping artifacts, and malformed hashes.

`maxContextTokens` and `maxConcurrency` are reviewed deployment declarations. The qualifier rejects a configured route context above the declared maximum and reports both values, but it cannot prove a server's concurrency flag from an OpenAI-compatible response. Verify the launch arguments independently.

## launchd layout

The examples assume a dedicated `_openprojects` service account and these root-controlled paths:

```text
/Library/OpenProjects/app                         root:_openprojects 0550 reviewed app
/Library/OpenProjects/runtime                     root:_openprojects 0550 Node runtime
/Library/OpenProjects/mlx-venv                    root:_openprojects 0550 reviewed MLX env
/Library/OpenProjects/models                      root:_openprojects 0550; files 0440
/Library/OpenProjects/etc                         root:_openprojects 0550; files 0440/0640
/Library/Application Support/OpenProjects/state   _openprojects:_openprojects 0700 DB/socket
/Library/Application Support/OpenProjects/tmp     _openprojects:_openprojects 0700 temporary
/Library/Application Support/OpenProjects/cache/huggingface/hub
                                                    _openprojects:_openprojects 0700; precreated HF cache
/Library/Logs/OpenProjects                        root:_openprojects 0750; files 0600
```

Assets:

- [`com.openprojects.harness.plist.example`](../deploy/launchd/com.openprojects.harness.plist.example)
- [`com.openprojects.mlx-lm.plist.example`](../deploy/launchd/com.openprojects.mlx-lm.plist.example)
- [`com.openprojects.qualify.plist.example`](../deploy/launchd/com.openprojects.qualify.plist.example)

The MLX plist uses the supported `python -I -m mlx_lm server` entry point, sets `HF_HUB_OFFLINE=1` and `TRANSFORMERS_OFFLINE=1`, selects one decode/prompt concurrency, caps retained prompt-cache storage at 256 MiB, and names an exact root-owned local model path. `--prompt-cache-size 1` is an entry count and `--prompt-cache-bytes` limits retained cache, not active prompt prefill or peak unified memory. The environment variables prevent normal library fetching; they are not an operating-system network sandbox. Enforce and test outbound denial with MDM, a host firewall, or a VM/container boundary before making a data-residency claim.

The upstream MLX development HTTP server has no local client authentication. Loopback prevents remote network access but does not stop another local user or process from sending large prompts or alternate requests. The Mac profile is therefore a dedicated/trusted-host pilot only. A multi-user corporate SKU needs a reviewed authenticated local proxy plus request-size/token bounds or a stronger VM/sandbox boundary.

Keep immutable trust material out of the service-owned state tree. Precreate exact mutable paths and logs before bootstrap; the log directory must not be writable by the service so it cannot replace a log with a symlink. Treat logs and qualification JSON as sensitive because prompts, local paths, and runtime errors may appear there. For example:

```bash
sudo install -d -o root -g _openprojects -m 0550 /Library/OpenProjects/etc /Library/OpenProjects/models
sudo install -d -o _openprojects -g _openprojects -m 0700 \
  '/Library/Application Support/OpenProjects/state' \
  '/Library/Application Support/OpenProjects/tmp' \
  '/Library/Application Support/OpenProjects/cache/huggingface/hub'
sudo install -d -o root -g _openprojects -m 0750 /Library/Logs/OpenProjects
sudo install -o _openprojects -g _openprojects -m 0600 /dev/null /Library/Logs/OpenProjects/harness.log
sudo install -o _openprojects -g _openprojects -m 0600 /dev/null /Library/Logs/OpenProjects/harness.error.log
sudo install -o _openprojects -g _openprojects -m 0600 /dev/null /Library/Logs/OpenProjects/mlx-lm.log
sudo install -o _openprojects -g _openprojects -m 0600 /dev/null /Library/Logs/OpenProjects/mlx-lm.error.log
sudo install -o _openprojects -g _openprojects -m 0600 /dev/null /Library/Logs/OpenProjects/qualification.json
sudo install -o _openprojects -g _openprojects -m 0600 /dev/null /Library/Logs/OpenProjects/qualification.error.log
```

Install the reviewed config/manifest as `root:_openprojects` mode `0440` (or `0640` while staging), and each materialized model file as `root:_openprojects` mode `0440`. The database and control socket configured in YAML must live under the service-owned `state` directory. `HF_HUB_CACHE` deliberately names the precreated `cache/huggingface/hub` directory: MLX-LM's `/v1/models` scans it even when the served model is an absolute local path, and a missing fresh cache directory can make that endpoint fail offline. Verify the pinned MLX environment before bootstrap with `/Library/OpenProjects/mlx-venv/bin/python3 -I -m mlx_lm server --help`; this development Mac has no MLX environment, so that live check has not been performed here.

Review every path and account name, then validate copies before installation:

```bash
plutil -lint deploy/launchd/com.openprojects.harness.plist.example
plutil -lint deploy/launchd/com.openprojects.mlx-lm.plist.example
plutil -lint deploy/launchd/com.openprojects.qualify.plist.example

sudo install -o root -g wheel -m 0644 \
  deploy/launchd/com.openprojects.harness.plist.example \
  /Library/LaunchDaemons/com.openprojects.harness.plist
sudo install -o root -g wheel -m 0644 \
  deploy/launchd/com.openprojects.mlx-lm.plist.example \
  /Library/LaunchDaemons/com.openprojects.mlx-lm.plist
sudo install -o root -g wheel -m 0644 \
  deploy/launchd/com.openprojects.qualify.plist.example \
  /Library/LaunchDaemons/com.openprojects.qualify.plist

sudo launchctl bootstrap system /Library/LaunchDaemons/com.openprojects.mlx-lm.plist
sudo launchctl bootstrap system /Library/LaunchDaemons/com.openprojects.harness.plist
sudo launchctl bootstrap system /Library/LaunchDaemons/com.openprojects.qualify.plist

# The qualification job has no automatic trigger; invoke it only in a reviewed lane.
sudo launchctl kickstart -k system/com.openprojects.qualify
```

Do not bootstrap these examples until the `_openprojects` identity, protected directories, reviewed runtime lock/SBOM, configuration, complete snapshot manifest, and protected log files exist. `launchd` has no dependency ordering equivalent to systemd's `After=`; confirm MLX readiness before starting the harness.

The harness plist deliberately omits `KeepAlive`. A crash can leave a conservative Unix-domain control socket, and blind auto-restart would loop because OpenProjects refuses to delete an unproven stale socket. Recovery is manual: boot out the harness job; verify with `launchctl print`, `lsof -U`, and `pgrep -u _openprojects` that no harness process or listener owns the exact configured socket; verify the path is a socket with the expected owner/mode; then move that exact socket into a protected quarantine directory for review and manually bootstrap the job. Never glob, recursively remove, or blindly unlink the state directory. MLX remains independently supervised.

The separate vision lane is intentionally not shipped as a service plist. MLX-VLM serving is third-party and experimental here; pin and review its exact server/version/arguments before creating a local daemon. A passing vision lane still does not route Telegram photos, screenshots, PDFs, or other images through OpenProjects.

### Proposed isolated M3 vision candidate

The first candidate for a manually supervised, sequential gate is
`mlx-community/Qwen3-VL-2B-Instruct-4bit` at revision
`9c4f5209e57b31f4b9dfba735de3fb983739c9cc`. The reviewed tree has 16 files
and 1,798,023,774 materialized bytes; `model.safetensors` is 1,782,040,921
bytes with SHA-256
`4750d95a2162829e127a94e83ac350d498d02070aab216c4687da48804a06ffb`.
These identifiers are acquisition inputs, not a local qualification result.
Materialize every file as a regular non-linked file, compute the complete local
inventory, and replace every zero placeholder in the example manifest before
running a gate. The converted snapshot is Apache-2.0; preserve its notices when
redistributing weights. [Pinned model tree](https://huggingface.co/mlx-community/Qwen3-VL-2B-Instruct-4bit/tree/9c4f5209e57b31f4b9dfba735de3fb983739c9cc)

Use a separate Python 3.12 environment and hash-locked wheelhouse for MLX-VLM
0.6.16. Its wheel SHA-256 is
`172ebd2c05ecb9d7a82b32e34d8fa44ee9bd9ae9b72205e9b9a46a098e76c83a`;
the upstream dependency file contains lower bounds rather than a reproducible
lock, so the wheel alone is insufficient runtime evidence. Bind only
`127.0.0.1`, set a protected API key through `MLX_VLM_SERVER_API_KEY`, omit
remote-code/thinking/draft/APC/KV-quantization options, and use one sequence,
one vision-cache entry, a 2,048-token KV bound, and short output. Run with a
sanitized offline environment and independent host egress denial. The pinned
server can otherwise accept remote image URLs and dynamically named models;
OpenProjects' evaluator forces one inline image and the exact served model, but
that does not sandbox other clients of the port. [MLX-VLM 0.6.16](https://github.com/Blaizzy/mlx-vlm/releases/tag/v0.6.16)

Stop MLX-LM, Ollama/BGE, and Whisper before this 8 GiB experiment. Reject the
candidate on any non-loopback listener or outbound connection, inventory/model
drift, unexpected cache growth, process crash, warning/critical memory
pressure, peak process footprint above 4 GiB, or swap growth above 512 MiB over
the sequential soak. Qwen3.5 2B 4-bit is a later challenger, not an automatic
fallback. No product process should start or depend on either candidate until
the readiness report passes and a separate ingestion design is approved.
