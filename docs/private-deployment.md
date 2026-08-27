# Private corporate deployment

Position the product as **OpenProjects Private Appliance — on-prem inference, organizational memory, embeddings, and transcription, with no external LLM API required**. Local image/document vision belongs in the same product boundary, but v0.6 implements only a standalone readiness evaluator—not product ingestion or multimodal agent runs. The harness, project state, memory, inference, embeddings, and optional transcription run on a machine controlled by the customer. Hosted model APIs are an optional compatibility path, not a runtime dependency of the private profile.

The supported v0.6 private boundary is one trusted machine or VM with a low-privilege service identity. On POSIX the authenticated control API listens only on an owner-only Unix-domain socket, the service-attached TUI is the operator surface, model and embedding endpoints stay on loopback, SQLite stays on local storage, and external writes are denied. The ready-to-copy profile is [`examples/openprojects.private.yaml`](../examples/openprojects.private.yaml); it provisions one unscoped `local-admin` token, while deployments can define multiple least-privilege principals. Those principal IDs do not prove which individual person used a token, so a multi-user corporate deployment still needs an external human identity/accountability layer.

## What “private” means

Three claims must remain distinct:

| Claim | Evidence required |
| --- | --- |
| **Local inference** | Every enabled model and embedding route resolves to a customer-controlled loopback process; transcription uses local files and binaries. |
| **Private deployment** | Local inference plus controlled host identity, filesystem permissions, encrypted storage/backups, patching, access logging, and independently enforced network policy. |
| **Air-gapped** | A disconnected network zone with an audited offline process for importing code/models and exporting approved artifacts. Telegram and hosted APIs are impossible in this mode. |

The YAML field `local: true` is only router-scoring metadata. The separate `privacy.localOnly: true` policy is an application guard: v0.6 rejects non-loopback model, embedding, and enabled Telegram HTTP origins unless their exact origin is allowlisted, and its owned clients reject redirects. That is materially useful fail-closed behavior, but it cannot constrain a local model server that proxies elsewhere, installed plugins, child processes, or another same-privilege process. A credible private claim comes from the complete deployment and verification evidence, not one application label.

## Sealed topology

```text
managed admin workstation
      |
      | protected SSH session + audited sudo
      v
corporate machine / private VM
  ├── OpenProjects service (unprivileged OS account, owner-only Unix socket)
  ├── service-attached TUI (same host, selected local principal)
  ├── Ollama or qualified OpenAI-compatible server (loopback)
  │     ├── local tool-capable language model
  │     └── separately qualified semantic embedding model
  ├── optional whisper.cpp + FFmpeg + local model file
  └── SQLite + model files + backups on protected local storage

default-deny egress control around the OpenProjects service
```

OpenProjects and its local inference server are separate processes and separate trust components. Patch and restrict both. Keep the inference server on loopback and disable any feature that downloads models or forwards telemetry during normal operation.

## Hardware and serving tiers

These are capacity-planning starting points, not quality or compatibility guarantees. Actual memory depends on model architecture, quantization, context/KV cache, concurrency, runtime, embeddings, Whisper, and operating-system overhead. Qualify the complete bundle on the intended host.

| Unified/system memory | Starting language-model tier | Intended use |
| --- | --- | --- |
| 4 GB | No learned model by default; `core-4g-v1` with built-in retrieval | Bounded harness target; retain a target-host footprint report. A single Granite 350M/llama.cpp lane is the first portable experiment, not yet a qualified local supervisor. |
| 8 GB | Approximately 2B at 4-bit | Developer evaluation and narrow read-only tasks; do not assume reliable supervisor/tool behavior |
| 16 GB | [Qwen3.5-class 4B](https://huggingface.co/Qwen/Qwen3.5-4B) quantization | Edge pilot with local embeddings and modest context/concurrency |
| 32 GB | Qwen3.5-class 9B quantization | Recommended corporate pilot tier with more headroom |
| 64 GB or more | 27B-class Q4 quantization | Higher-quality workstation/server evaluation; benchmark context and tool calls before promotion |
| 96–128 GB | Larger quantized model or more concurrency | Serious Apple private-appliance evaluation after workload-specific sizing |

For NVIDIA servers, treat VRAM as the first sizing constraint: approximately 24 GB for a 4B–9B VLM or quantized 14B pilot, 48 GB for a 9B BF16 or quantized 27B–32B pilot, and 80/96 GB for evaluating 27B–35B production serving with useful concurrency. These are still planning bands rather than support guarantees.

Serving recommendation by platform:

- **4 GB total-system baseline:** use the strict [lightweight core profile](./lightweight-4gb.md), no resident learned service, and an optional reviewed remote endpoint only when policy permits it. The first local experiment is one pinned 350M GGUF through one-slot `llama.cpp`, qualified on an actual constrained Linux host; do not extrapolate from artifact size.
- **Apple Silicon:** v0.6 supports a strict loopback MLX-LM text/tool route and supplies a fail-closed [MLX setup guide](./mlx-apple-silicon.md), [macOS appliance runbook](./macos-appliance.md), and `launchd` templates. MLX-LM's HTTP server is development-grade and unauthenticated, so this remains a dedicated/trusted-host pilot unless a reviewed isolation layer is added. Ollama is the convenient alternative; a commit-pinned [`llama.cpp`](https://github.com/ggml-org/llama.cpp) build remains attractive for reproducible GGUF serving.
- **Linux with NVIDIA:** use a pinned [vLLM OpenAI-compatible server](https://docs.vllm.ai/en/latest/serving/online_serving/openai_compatible_server/) container and model digest. If inference is on another corporate host, place it behind an authenticated TLS proxy and network allowlist; a private IP alone is not authentication.
- **Embeddings:** keep the exact reviewed model on the customer-controlled Ollama endpoint supported by v0.6, or use the in-process hash fallback when semantic quality is not required. Do not promote by model family name: the recorded M3 pilot's pinned Qwen3-Embedding 0.6B Q8_0 failed the unchanged semantic margin gate, while pinned BGE-M3 F16 passed the bounded semantic gate, reliability soak, manual multilingual retrieval thresholds, and formal 10-batch versioned evaluator. That exact BGE artifact is qualified for the semantic lane and is selected by the higher-memory example. Installed deployment changes and re-embedding stored memories remain separate reviewed actions. The hash fallback deliberately cannot pass semantic appliance qualification.
- **Voice:** keep Whisper/FFmpeg binaries and the selected model on the appliance; there is no cloud transcription fallback.

Stage code, containers, model files, licenses, and hashes through an approved offline artifact repository. Normal production startup should not download models. For an Ollama pilot, set `OLLAMA_NO_CLOUD=1` in the **Ollama service environment** as defense in depth, then independently deny and test egress; setting it only on OpenProjects does not constrain the Ollama process.

## Local-only quick start

This path requires no model API key. It assumes Linux, Node.js 24+ at `/usr/bin/node`, an installed Ollama service, enough RAM/VRAM for the selected model, and an operator-qualified tool-calling model. The example currently names `qwen3.5:9b` for the 32 GB pilot tier; change it consistently in both `model` and `routing.routes[0]` if the corporate hardware uses another qualified model. It selects BGE-M3 for optional higher-memory semantic retrieval; retain the in-process 256-dimensional hash fallback on a 4 GiB host, and change the embedding config, digest, and manifest together only after reviewing model-specific evidence. Run the build and staging commands from a clean, reviewed checkout. The account-creation commands below are conventional Linux examples; use the organization's account-management system when it supplies the service identity instead.

```bash
ollama pull qwen3.5:9b
ollama pull bge-m3

sudo groupadd --system openprojects
sudo useradd --system --gid openprojects --home-dir /nonexistent \
  --shell /usr/sbin/nologin --no-create-home openprojects

npm ci
npm run build
sudo install -d -o root -g root -m 0755 /opt/openprojects
sudo cp -R dist public skills evals package.json package-lock.json /opt/openprojects/
sudo chown -R root:root /opt/openprojects
sudo npm ci --omit=dev --ignore-scripts --prefix /opt/openprojects

sudo install -d -o openprojects -g openprojects -m 0700 /var/lib/openprojects
sudo install -d -o root -g openprojects -m 0750 /etc/openprojects
sudo -u openprojects /bin/sh -c \
  'umask 077; set -C; openssl rand -base64 48 > /var/lib/openprojects/control.token'
sudo chmod 0600 /var/lib/openprojects/control.token
sudo install -o root -g openprojects -m 0640 \
  examples/openprojects.private.yaml \
  /etc/openprojects/openprojects.private.yaml

sudo -u openprojects /bin/sh -c \
  'cd /opt/openprojects && exec /usr/bin/node dist/src/cli.js doctor --probe --config /etc/openprojects/openprojects.private.yaml'
sudo -u openprojects /bin/sh -c \
  'cd /opt/openprojects && exec /usr/bin/node dist/src/cli.js eval --config /etc/openprojects/openprojects.private.yaml --suite evals/project-ops.json'
```

`doctor --probe` validates composition and control-token readability, makes one bounded live model request and one bounded live embedding request, and checks storage plus configured Whisper prerequisites. It is a connectivity smoke test, not proof of model quality or host network isolation. `eval` removes the loaded routing table before installing the deterministic mock adapter and uses an in-memory database; it verifies harness behavior without contacting a configured live route. Neither command qualifies a new model or quantization.

Model eligibility requires a separate reviewed gate. For the compact project analyst introduced in v0.5, create a candidate route that advertises only `project_analysis`, keep it out of supervisor routing, bind it to strong `route:<id>` manifest identity material, and run `eval-project-analyst`. The evaluator isolates exactly that route, performs text/tool identity preflight, and requires every trial to make the single host-scoped snapshot read and return grounded strict JSON without an approval or outbox write. Its result applies only to project analysis: supervisor, semantic embeddings, and vision remain unevaluated. A failed small model may be followed by a separately pinned larger candidate, but never by automatic fallback inside the eligibility gate.

The authenticated private profile is operated through the TUI. From a managed workstation, run it through a protected host session:

```bash
ssh -t admin@openprojects-host \
  "sudo -u openprojects /bin/sh -c 'cd /opt/openprojects && exec /usr/bin/node dist/src/cli.js tui --config /etc/openprojects/openprojects.private.yaml'"
```

Use a managed administrator identity and a narrowly authorized, audited sudo rule; do not enable interactive login for the `openprojects` service account. The POSIX sealed profile opens no TCP control listener. Its parent `/var/lib/openprojects` must be owned by `openprojects` at mode `0700`; after binding, OpenProjects restricts `/var/lib/openprojects/control.sock` to mode `0600`. The TUI uses Node's native HTTP `socketPath` support and loads the selected owner-only token on the appliance ([Node HTTP documentation](https://nodejs.org/download/release/latest-v24.x/docs/api/http.html)).

`server.auth` accepts either the legacy `{tokenFile, operatorId}` form—normalized to all capabilities and all workspaces—or independent `principals` with unique token files, a non-empty subset of `read`, `run`, `ingest`, `approve`, and `admin`, and an optional non-empty workspace allowlist. `admin` implies every capability; omitting `workspaces` means all. Ordinary inspection/SSE requires `read`; runs, feedback, and inbound events require `run`; Oracle connector pages and that principal's own checkpoint require `ingest`, which grants neither search nor run authority; exact approval decisions require both `read` and `approve`, preventing approve-only response access to run context/output; sensitive mutation, purge, exports, and notification delivery require `admin`. Global exports, notification tick, a purge without `workspaceId`, and binding/rebinding a provider-global external group identity require an unscoped admin. Group list/delete remains workspace-scoped and cross-workspace group migration is refused. This is local RBAC and least-privilege enforcement in the senses documented by [NIST](https://csrc.nist.gov/glossary/term/role_based_access_control) and [NIST SP 800-171r3](https://nvlpubs.nist.gov/nistpubs/SpecialPublications/800-171r3/NIST.SP.800-171r3.html).

Control-API event `source` values are data, not adapter identities. The server persists `control-api/<encoded-principal>/<encoded-source>`, keeping API dedupe keys separate from verified Telegram ingress and from other principals. Deduplication is within workspace plus that namespaced source plus key. A supplied project must belong to the requested workspace before the key is consumed, and the response is a minimal `duplicate`/optional-run-link receipt rather than a full outcome. `/api/meta` also omits `agent.system` and every subagent `system`.

For multiple principals, supply `tui --principal <id>`; the CLI refuses to guess. This selection is service-credential RBAC, not a human login. Anyone authorized to execute as `openprojects` and read its config/token files can select every available principal unless the sudo command or a fixed wrapper pins both `--principal` and `--config`. Use that restriction if the organization maps different humans to different service credentials. The TUI displays its identity and disables unsupported run/approval controls, while the server remains authoritative for capabilities and workspace scope. Tokens are still replayable and have no expiry or online rotation/revocation. Principal IDs do not bind themselves to the SSH/sudo human identity, so this is not SSO, corporate-directory authentication, or per-human proof. The Unix pathname is protected by OS filesystem ownership; OpenProjects does not claim peer-credential verification or cryptographic server identity. The browser dashboard has no token-entry flow and ordinary browsers cannot address the Unix socket, so it is not the administration surface for this profile.

TCP loopback remains available for development and compatibility. It refuses non-loopback binds, but plaintext Bearer auth proves the client only to whichever process owns that port; it does not authenticate that process back to the client. A local process that binds the port while OpenProjects is down could capture a reconnecting token. Do not substitute TCP compatibility mode into the sealed profile without accepting and documenting that boundary.

## Linux service profile

The repository includes a hardened starting point:

- [`deploy/systemd/openprojects-local.service.example`](../deploy/systemd/openprojects-local.service.example)
- [`deploy/systemd/openprojects.env.example`](../deploy/systemd/openprojects.env.example)
- [`deploy/systemd/ollama-local.override.example`](../deploy/systemd/ollama-local.override.example)

The example unit assumes the `openprojects` account, root-controlled application tree at `/opt/openprojects`, configuration and environment under `/etc/openprojects`, and writable state under `/var/lib/openprojects` were prepared by the quick start. Install reviewed copies rather than symlinking directly from a writable checkout:

```bash
sudo install -o root -g root -m 0644 \
  deploy/systemd/openprojects-local.service.example \
  /etc/systemd/system/openprojects.service
sudo install -o root -g openprojects -m 0640 \
  deploy/systemd/openprojects.env.example \
  /etc/openprojects/openprojects.env
sudo install -d -o root -g root -m 0755 /etc/systemd/system/ollama.service.d
sudo install -o root -g root -m 0644 \
  deploy/systemd/ollama-local.override.example \
  /etc/systemd/system/ollama.service.d/local-only.conf
sudo systemctl daemon-reload
sudo systemctl restart ollama
sudo systemctl enable --now openprojects
sudo systemctl status --no-pager openprojects
```

Apply the Ollama override only after the reviewed model artifacts are present; it intentionally prevents later downloads. The example units ask the service manager to permit only loopback IP traffic in addition to OpenProjects' application HTTP-origin guard. Do not describe the OS rule as an enforced sandbox until the target kernel/service manager accepts those controls and a negative egress test succeeds. Also verify that the separately managed model server cannot egress during normal operation; restricting OpenProjects alone cannot constrain an Ollama or llama.cpp process that proxies elsewhere.

For the first portable 4 GiB analyst experiment, use the dedicated
[`openprojects-llama-server` unit](../deploy/systemd/openprojects-llama-server.service.example)
instead of the Ollama override. It is CPU-only, loopback-only, offline,
authenticated, one-slot, hash-checked, and cgroup-capped; its UI, agent, MCP,
tool, router, multimodal, and download surfaces remain disabled. The unit is a
candidate, not certification. Replace the binary hash placeholder, install the
key file at mode 0600, run a negative egress check, install the example
`openprojects-4gb.slice`, and pass `eval-local-4gb` with the model and evaluator
beneath that same finite parent slice before enabling a product route. The
model may retain its stricter child-service memory cap. The pass also requires
exact source and qualification bindings, shared network/cgroup namespaces,
read-only full-model mapping by the declared PID, sole listener ownership,
pre/post negative-auth rejection, a sealed model-process environment, and stable
kernel cgroup-v2 memory/swap peaks over the full 30-minute observation on a
Linux host with at most 4.5 GiB total memory and at least 256 MiB available
throughout. Treat
the unit's 1.5 GiB child cap and other systemd hardening as separately reviewed
defense in depth: the evaluator attests the live process and shared envelope,
not the name or full directive set of the service manager unit that launched it.

On routine service stop, OpenProjects disables future deadline ticks and gives any active delivery a fixed settlement budget before it closes Telegram. A sender that exceeds the budget is durably marked `unknown_outcome`, barred from late storage writes, and aborted. Do not shorten the service-manager stop timeout below this reviewed bound; forced process termination can still leave a claimed notification for conservative restart recovery.

The service is the sole production SQLite owner. The default TUI attaches through the Unix control socket and may run while the service is active. Direct stateful commands—including `chat`, every `learning` subcommand, `notify`, `export-feedback`, `tui --standalone`, and `tui --demo`—open the configured database themselves; stop `openprojects.service` before running any of them against this durable deployment. The runtime-owner lock fails closed if another owner or an unrecovered lock exists.

These checks exercise the health boundary, auth rejection, authenticated TUI snapshot, and single-owner refusal without exposing the control token in process arguments. Run the socket requests as the service identity because the socket is owner-only:

```bash
sudo -u openprojects curl --fail --silent --show-error \
  --unix-socket /var/lib/openprojects/control.sock http://localhost/health
test "$(sudo -u openprojects curl --silent --output /dev/null --write-out '%{http_code}' \
  --unix-socket /var/lib/openprojects/control.sock http://localhost/api/meta)" = 401
sudo -u openprojects /bin/sh -c \
  'cd /opt/openprojects && exec /usr/bin/node dist/src/cli.js tui --plain --config /etc/openprojects/openprojects.private.yaml'

# Expected to fail with runtime ownership unavailable while the service is active:
sudo -u openprojects /bin/sh -c \
  'cd /opt/openprojects && exec /usr/bin/node dist/src/cli.js learning stats --config /etc/openprojects/openprojects.private.yaml'
```

## Unix control socket and manual recovery

OpenProjects validates the absolute socket path through its existing parent, refuses symbolic links and every pre-existing leaf, creates the listener, applies mode `0600`, and records the created device/inode. When a protected socket already exists, startup and `doctor` make a short local connect-only liveness probe: an accepting listener is reported as active, while refusal/timeout is reported as a stale candidate. Neither result authorizes deletion. Graceful shutdown removes only the exact socket it created, and OpenProjects never deletes a replacement or automatically removes a stale candidate. Node documents that filesystem Unix sockets are normally removed on close but may remain after a crash ([Node Net documentation](https://nodejs.org/api/net.html)).

After an unclean exit, startup intentionally fails until the socket is recovered. The bounded liveness probe is supporting evidence only: a refused connection does not prove that no process owns or may reuse the path. Remove it only after proving there is no surviving listener:

1. Stop the unit and its restart loop.
2. Confirm the unit is inactive and no OpenProjects process under the service account survives.
3. Inspect `/var/lib/openprojects` without following links. The parent must be the expected service-owned directory at mode `0700`; `control.sock` must be a Unix socket owned by `openprojects:openprojects` at mode `0600`. Preserve and escalate any unexpected type, owner, or mode.
4. Treat the absence of a process as necessary but not sufficient; verify the exact path and remove only that inspected socket.
5. Start the unit and confirm that it recreates the mode-`0600` socket and passes the Unix-socket health check.

```bash
sudo systemctl stop openprojects
sudo systemctl show openprojects --property=ActiveState,SubState,MainPID
sudo pgrep -a -u openprojects -f '/opt/openprojects/dist/src/cli.js'
sudo stat --format='type=%F mode=%a owner=%U:%G inode=%d:%i' -- \
  /var/lib/openprojects /var/lib/openprojects/control.sock
sudo test -S /var/lib/openprojects/control.sock

# Only after the checks above prove that this is the expected stale socket:
sudo -u openprojects rm -- /var/lib/openprojects/control.sock
sudo systemctl start openprojects
sudo stat --format='type=%F mode=%a owner=%U:%G inode=%d:%i' -- \
  /var/lib/openprojects/control.sock
sudo systemctl status --no-pager openprojects
```

Never put socket deletion in `ExecStartPre`, cron, or another automatic cleanup path. If ownership or process state cannot be proven, leave the path in place and investigate.

## Runtime-owner lock and manual recovery

Before opening a durable database, OpenProjects exclusively creates the adjacent mode-`0600` `<database>.owner.lock`, writes and syncs non-secret PID/start metadata, and holds the file descriptor until after SQLite closes. For this profile the exact path is `/var/lib/openprojects/openprojects.db.owner.lock`. `:memory:` storage has no owner lock. An existing file, symbolic link, or special file at the lock path is refused; OpenProjects never guesses that a lock is stale and never removes it automatically.

After an unclean exit, recover only after proving there is no surviving owner:

1. Stop the unit and its restart loop.
2. Confirm the service is inactive and no OpenProjects process under the service account is using the application entry point.
3. Inspect the exact lock path without following links. It must be the expected regular file, owned by `openprojects:openprojects`, mode `0600`. Preserve and escalate any unexpected type, owner, or mode.
4. Treat the recorded PID/start metadata as supporting evidence only; PIDs can be reused and metadata alone never authorizes deletion.
5. Remove only the exact verified lock, then start the service and inspect its status.

```bash
sudo systemctl stop openprojects
sudo systemctl show openprojects --property=ActiveState,SubState,MainPID
sudo pgrep -a -u openprojects -f '/opt/openprojects/dist/src/cli.js'
sudo stat --format='type=%F mode=%a owner=%U:%G inode=%d:%i' -- \
  /var/lib/openprojects/openprojects.db.owner.lock

# Only after the checks above prove that this is the expected stale regular file:
sudo -u openprojects rm -- /var/lib/openprojects/openprojects.db.owner.lock
sudo systemctl start openprojects
sudo systemctl status --no-pager openprojects
```

Never put lock deletion in `ExecStartPre`, cron, or another automatic cleanup path. If process ownership cannot be proven, leave the lock in place and investigate instead of restoring availability by deletion.

## SQLite migration backup and rollback

Application startup upgrades an older supported database through a numbered
ledger in one transaction. It does not make an automatic backup. Before changing
the OpenProjects package or binary:

1. Stop the unit and its restart loop, prove no runtime owner remains, and retain
   the exact package/configuration identities being replaced.
2. Create an encrypted, access-controlled SQLite-consistent backup using the
   organization's snapshot or SQLite backup procedure. Never copy only the main
   database file while a WAL owner may still be active.
3. Validate the backup separately and record both `PRAGMA user_version` and the
   ordered `schema_migrations` rows when that table exists.
4. Start the new build and retain its startup log plus the post-upgrade version
   and ledger. Exercise a disposable run and restart before returning the host to
   service.

A future database version, missing/gapped/renamed ledger, or incomplete current
schema is rejected. A failed pending sequence rolls back its DDL, ledger rows,
and `user_version`; preserve the database and logs for diagnosis. Do not make an
older binary appear compatible by editing the ledger or `PRAGMA user_version`.
Rollback normally means stopping the service and restoring the verified
pre-upgrade backup with its original application/configuration, then repeating
the ownership, permission, integrity, and recovery checks.

Suggested acceptance checks on the actual corporate image:

1. Confirm `privacy.localOnly: true`, an empty `privacy.allowedOrigins`, `telegram.enabled: false`, loopback `baseUrl` values, no hosted fallback, and no API-key environment override.
2. Confirm the service cannot connect to a controlled non-loopback test address while it can still reach the local model and embedding endpoints.
3. Inspect active sockets during a representative run and during transcription.
4. Stop the local model server and confirm the run fails closed instead of selecting a remote route.
5. Search the environment, YAML, process arguments, and logs for provider credentials.
6. Reboot, confirm the same configuration and model hashes load, and repeat the egress test.
7. Confirm the local model server's cloud/download features are disabled and that production startup succeeds with the external network unavailable.
8. Run `openprojects qualify` with a reviewed manifest, record its non-secret report, and retain the OS image, application commit/package lock, complete model artifacts, runtime versions, firewall policy, and test results as deployment evidence. Qualification requests no pull/install and exits nonzero unless every required capability, identity, and sealed-local gate passes.
9. Confirm `/var/lib/openprojects` is service-owned mode `0700`, the live control socket is mode `0600`, no TCP control listener exists, every token is an owner-only regular file, an unauthenticated `/api/*` request is rejected, and the service-attached TUI can authenticate and refresh its workspace snapshot.
10. Create disposable scoped `read`, `run`, `approve`-only, and `read`+`approve` principals. Prove capability and cross-workspace denial, prove approve-only cannot resolve/receive exact context, and verify that global export/tick/global purge rejects a workspace-scoped admin.
11. Submit the same claimed source/key from two principals and from verified Telegram ingress; confirm all namespaces remain distinct. Reject an invalid project, correct it with the same key, and confirm the receipt contains no full run outcome.
12. Interrupt and reconnect a disposable run stream—including a transient Unix-socket reset—confirming it resumes after `Last-Event-ID`/`afterSeq` without duplicate durable events, while protocol/auth/consumer-callback failures stop. Verify cursor and terminal state advance only after successful callback delivery, and workspace SSE still triggers a fresh scoped snapshot.
13. Confirm `/api/meta` contains neither `agent.system` nor any subagent `system`. Stop the service during two disposable notification deliveries: verify one settles inside the shutdown budget, and verify a noncooperative sender becomes durable `UNKNOWN_OUTCOME_AFTER_SHUTDOWN_TIMEOUT`, cannot write late, and is aborted before Telegram closes.
14. Confirm a second direct runtime is refused while the service owns the database, and exercise both documented stale-socket and stale-owner-lock recovery procedures in a disposable test image.
15. Restore a disposable pre-upgrade backup and exercise the schema migration.
    Confirm the ledger and `PRAGMA user_version` agree, then mix a healthy
    interrupted run with an old-version run, a changed snapshot, a malformed row,
    an unchanged pending approval, and a previously running invocation. Healthy
    work must continue; bad rows must emit `run.recovery.failed`; the inert wait
    must remain pending without appearing as recovered; and the prior running
    invocation must remain an explicit unknown outcome with a verify-before-retry
    warning.

Network tooling differs across Linux distributions and corporate platforms. Use the organization’s firewall/eBPF/VM policy and verification tooling as the authoritative control. Application configuration is not a substitute.

## Local audio

The private profile disables audio until reviewed local dependencies are installed. To enable it, change only the transcription provider after installing `whisper-cli`, FFmpeg, and a local Whisper model:

```yaml
transcription:
  provider: whisper-cpp
  command: /usr/local/bin/whisper-cli
  modelPath: /var/lib/openprojects/models/ggml-small.bin
  ffmpegCommand: /usr/bin/ffmpeg
  timeoutMs: 180000
  maxBytes: 25000000
  maxDurationSeconds: 1200
```

There is no cloud transcription fallback. Temporary audio is removed after processing, while an opted-in transcript can still enter normal local retention. Review FFmpeg, whisper.cpp, their model files, and the host media stack as part of the appliance supply chain.

## Telegram is not the sealed profile

A local LLM prevents project prompts from being sent to an external model vendor, but Telegram is still an external processor and network transport. Messages and files reach Telegram before the bot receives them, and OpenProjects must call Telegram to validate admins, download audio, and deliver responses or reminders.

Therefore:

- the sealed profile omits Telegram credentials, disables notifications, and keeps `groupObservation: false`;
- a Telegram-connected private deployment may still truthfully claim **local model inference**, but not “all data stays on the corporate machine” or “air-gapped”;
- a fully private corporate chat experience requires an approved internal transport adapter plus corporate human identity and accountability. Local control principals do not supply that layer. [Mattermost documents an air-gapped deployment pattern](https://docs.mattermost.com/deployment-guide/reference-architecture/deployment-scenarios/air-gapped-deployment.html), and Mattermost or Matrix are sensible future connector targets, but v0.6 implements neither.

The current process does not expose a separate network listener alongside the private Unix socket. Therefore the wizard handles Telegram-enabled hybrid plans differently:

1. it omits `server.socketPath` and keeps the service TCP listener on loopback;
2. it requires a reviewed TLS reverse proxy to forward exactly `POST /webhooks/telegram` to `http://127.0.0.1:4310`;
3. the proxy must expose no `/api/*`, `/health`, dashboard/static route, alternate method, or broader prefix;
4. Telegram authenticates the fixed route only with `X-Telegram-Bot-Api-Secret-Token`; `TELEGRAM_WEBHOOK_SECRET` is not placed in the URL; and
5. the wizard rejects an explicit plan that combines Telegram with `server.socketPath`, and service startup rejects that combination in every configuration.

If Telegram is enabled, replace the sealed service egress restriction only with an organization-approved destination policy, document the changed boundary to participants, retain the existing admin opt-in gates, and never add a hosted model fallback silently. Keep control clients on the loopback side of the proxy.

## Image and document vision status

v0.6 sends text messages to the product model path and has a local audio-to-text adapter. Its separate `eval-vision` command can qualify one exact pinned loopback MLX-VLM runtime against a hash-bound synthetic PNG corpus without constructing the application or opening SQLite. Promotion requires exact health/model/runtime identity and at least 50 fully passing sequential case attempts, including visual prompt injection, unsupported claims, multilingual grounding, abstention, and image-dependence counterfactuals. The report retains assertions and provenance but not image bytes or model descriptions.

That command is readiness evidence only. No real VLM has passed it on the recorded M3 host, the bundled corpus does not qualify JPEG decoding, and the product does **not** ingest Telegram images, send multimodal image parts in a run, perform local OCR, persist visual output, or expose image/document tools. Passing the evaluator does not activate vision.

A future private vision lane should keep the same product boundary:

1. accept only bounded, allowlisted media types and dimensions;
2. decode in a low-privilege isolated worker;
3. run OCR/VLM inference through a customer-controlled local endpoint;
4. treat extracted text and model descriptions as untrusted prompt-injection surfaces;
5. store neither raw images nor derived text by default;
6. record provenance and require the same tool/policy approvals as text runs;
7. qualify the exact model, quantization, prompt template, and hardware on internal document and screenshot evals.

Until that lane exists, position OpenProjects as a private **text and voice project colleague with a vision-readiness lab**, not a private vision assistant.

## Storage, learning, and training

- SQLite is local but not application-encrypted. Use encrypted host volumes and encrypted, access-controlled backups.
- Restrict the database, model files, configuration, `.env`, skills, exports, adapters, and logs to the service/operator accounts that need them.
- Group observation opt-in is not permission to train. Keep reviewed training exports and adapter experiments in a separate controlled workflow.
- The optional QLoRA lab does not contact the live database or auto-promote weights. Its library-level offline mode is not an OS network sandbox.
- Dynamic project facts, people, deadlines, and revocations belong in scoped memory/RAG, where they can be corrected or deleted; do not bake them into weights.

## Optional cloud-assisted profile

Hosted routes remain supported for customers who explicitly choose them, for example a separately approved high-quality primary route or fallback. They should live in a different reviewed configuration with a visible provider/data-processing policy, `externalInference: allow`, `local: false`, an exact HTTPS allowlist entry, `apiKeyEnv`, and an immutable operator-managed `generation`; secrets in YAML are rejected. Bump the generation whenever an upstream alias may have changed so learned route statistics do not cross model generations. `preferLocal: true` and `allowRemoteFallback: false` preserve the safe default. Enabling remote fallback is a second explicit decision and only retryable provider failures can use it. Private mode should fail closed when the local endpoint is unavailable.

Cloud embeddings are independent and require the `openai-compatible` embedding
provider, an HTTPS base URL, `apiKeyEnv`, an operator-managed immutable
`generation`, and `externalData: allow`.
That choice sends retrieval queries and any explicitly backfilled memory text to
the embedding provider; chat-route permission does not imply embedding
permission. The reviewed memory content, status, attribution, and bounded
feedback stay in SQLite whether chat and embeddings are local or hosted.

That separation is the product story: **owned inference by default; rented inference only by an explicit customer decision.**
