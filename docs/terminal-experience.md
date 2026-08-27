# Terminal experience

OpenProjects has two terminal surfaces with different jobs:

- `openprojects setup` creates a reviewed configuration. It detects the machine, recommends a local model tier, explains every privacy-boundary change, and publishes protected configuration, storage directories, and a local control credential only after confirmation.
- `openprojects tui` is the daily private-operations console. On POSIX private installations it attaches through the owner-only Unix control socket and presents projects, durable runs, approvals, memory, and service posture without requiring the browser dashboard.

Neither command downloads a model, installs a system service, changes a firewall, or starts an inference daemon. Setup generates only the local control credential; model-provider secrets and external service credentials remain explicit operator actions.

## Setup flow

The default path is a sealed local appliance:

```text
machine check
  -> deployment boundary
  -> local inference runtime
  -> hardware-sized model
  -> storage paths
  -> optional local Whisper
  -> exact privacy and policy review
  -> confirm protected config, token, and data-directory writes
  -> manual model/runtime steps
```

The wizard distinguishes these profiles:

| Profile | Model endpoint | Telegram | External writes |
| --- | --- | --- | --- |
| Private local | Loopback only | Disabled | Denied |
| Hybrid | Local or an explicitly allowlisted origin | Explicit opt-in | Approval required |

Hosted credentials are represented only by an environment-variable name such as `OPENPROJECTS_MODEL_API_KEY`; the wizard never asks for or serializes the secret itself. A private-local configuration cannot silently acquire a hosted fallback.

The config writer creates a complete same-directory temporary file, syncs it, and atomically publishes the final mode-`0600` config. A new control token follows different semantics: it is created exclusively at its final path with mode `0600`, written and synced there, then validated as an owner-only regular non-symlink file. It is not temporary-renamed into place. Data/token/socket-parent directories use mode `0700`. On POSIX the sealed/default profile names an owner-only Unix socket and one unscoped `local-admin` principal with the `admin` capability; Windows falls back to loopback TCP. When Telegram is explicitly enabled in a hybrid plan, the wizard instead omits the socket, keeps TCP on loopback, and requires a reviewed TLS reverse proxy exposing only `POST /webhooks/telegram`. The wizard rejects a Telegram-plus-socket plan, and service startup rejects that combination in every configuration. Existing configs are not replaced unless `--force` is supplied; forced replacement first creates a protected backup, retains a valid existing token, and refuses symbolic links or non-files.

For automation and review, `--defaults --dry-run` builds the same deterministic sealed plan without reading interactive input or mutating the filesystem. There is intentionally no npm `postinstall` wizard.

## Mission-control TUI

```text
◆ OPENPROJECTS  Private Ops v0.6                 [LOCAL-ONLY]
[ 1 Overview ]  2 Runs   3 Approvals   4 Memory   5 Projects
──────────────────────────────────────────────────────────────
RUNS 12       ACTIVE 1      APPROVALS 1      MEMORY 24

LOCAL STACK  ollama/qwen3.5:9b · optional bge-m3 · whisper.cpp
NETWORK      SEALED · local inference enforced

RECENT ACTIVITY
› [WAITING] Draft and send the Atlas blocker follow-up…
  [SUCCESS] Why is Atlas late and what should we do next?
──────────────────────────────────────────────────────────────
KEYS  c compose · j/k move · Tab switch · r refresh · q quit
[READY] local-admin · workspace:local            refreshed now
```

The interface uses explicit words and icons as well as color. Amber means attention or approval, green means completed/local-ready, red means failure or rejection, and cyan is navigation—but the text labels remain authoritative.

### Keys

| Key | Action |
| --- | --- |
| `1`–`5`, `Tab`, `Shift+Tab`, `h`/`l` | Switch page |
| `j`/`k`, arrows | Move the current selection |
| `c`, `n`, `/` | Compose a task; from Projects, target the selected project |
| `a` / `x` | Review an exact pending action for one-time approval / rejection |
| `[` / `]`, `PageUp` / `PageDown` | Move backward/forward through bounded approval snapshot pages |
| `y` or `Enter` | Confirm the displayed approval decision |
| `n` or `Esc` | Cancel the approval decision |
| `r` | Refresh the snapshot |
| `q`, `Ctrl+C` | Restore the terminal and exit |

The current principal and its grants appear in the status surface. A principal without `run` cannot open/submit the composer. Exact approval resolution requires both `read` and `approve`; `admin` implies both, while an approve-only credential cannot load or receive the run context/output. These UI affordances prevent accidental attempts, while the service enforces every capability and exact workspace scope. When `server.auth.principals` contains more than one entry, the CLI refuses to guess a credential: start it with `openprojects tui --principal <id> --config <path>`. A present `workspaces` list must be non-empty; omission means all workspaces.

Approval details are treated differently from ordinary table cells: the complete tool arguments must be inspectable before a decision. Unsafe terminal code points are shown as visible Unicode escapes instead of being silently omitted, and long inputs require paging through every segment. A model cannot use the TUI to alter the stored invocation, effect class, or policy decision.

## Terminal safety and accessibility

- Model, user, project, memory, tool, and error text is untrusted. ANSI/OSC/C1 controls, bidirectional formatting controls, and unsafe terminal characters are removed before rendering.
- `NO_COLOR` disables color while retaining labels and layout.
- `--plain` and `--screen-reader` explicitly produce a finite sequential status summary; they do not recover or resume interrupted work.
- `TERM=dumb`, redirected input/output, and non-TTY execution use the same read-only summary with no cursor movement or escape sequences.
- Resize redraws the complete viewport. Exit, abort, and process signals restore cursor visibility, raw input mode, and the previous screen.
- If an API request is already in flight, service-attached exit restores the screen immediately and waits for that bounded client operation. The TUI owns no storage in this mode, and a durable run already accepted by the service continues there. Standalone exit waits for its bounded operation before closing the directly owned runtime and storage.
- The wizard uses ordinary line-oriented prompts, so it remains operable in basic terminals and assistive workflows.

The service owns the production runtime and storage connection; on POSIX the private TUI uses Node's HTTP-over-`socketPath` support to attach through the configured Unix socket ([Node HTTP documentation](https://nodejs.org/download/release/latest-v24.x/docs/api/http.html)). It submits durable asynchronous runs, listens to the workspace-invalidation stream, and fetches a fresh snapshot after each invalidation. Workspace SSE remains invalidation-only; the TUI does not consume the API-only per-run stream.

For API clients, the per-run stream now emits durable `id: seq` frames, accepts `afterSeq` or `Last-Event-ID`, replays SQLite in pages, subscribes before its replay fence, deduplicates the replay/live race, and resumes from the last validated sequence until terminal state. Classified transient Unix-socket reset, timeout, unavailable, and socket errors reconnect; protocol/authentication/non-retryable errors stop. Consumer-callback exceptions are non-retryable, and cursor/terminal state advances only after successful callback delivery. `Last-Event-ID` follows the standard event-stream reconnection contract ([WHATWG Server-Sent Events](https://html.spec.whatwg.org/dev/server-sent-events.html)). Slow consumers are disconnected when bounded frame/queue/drain limits are exceeded; writes respect Node stream backpressure ([Node stream documentation](https://nodejs.org/download/release/v24.1.0/docs/api/stream.html)). The run snapshot contains run/approval state and a cursor, not a duplicate full event history.

The authenticated principal is authoritative for mutation identity regardless of body actor fields. This is service-credential capability/workspace RBAC in the sense of [NIST's RBAC definition](https://csrc.nist.gov/glossary/term/role_based_access_control), not a per-human login. Anyone able to execute the TUI as the service UID and read its configuration/token files can choose an available principal unless an audited sudo command or fixed wrapper pins `--principal` and `--config`. Principal IDs still name replayable local credentials—not verified human identities. There is no SSO, corporate-directory binding, credential expiry, or online rotation/revocation.

`--standalone` is a development-only ownership mode, and `--demo` implies standalone mode. Both directly own the configured database. Other direct stateful commands—including `chat`, every `learning` subcommand, `notify`, and `export-feedback`—do the same. Stop `serve` before using any of them against a durable deployment. The adjacent runtime-owner lock makes concurrent or unrecovered ownership fail closed; it never auto-breaks a presumed stale lock. Follow the [manual recovery runbook](./private-deployment.md#runtime-owner-lock-and-manual-recovery) rather than scripting lock deletion.

## Honest deployment boundary

The terminal UI does not create privacy by itself. A private deployment still needs a controlled host, low-privilege service identity, protected storage and backups, pinned local model artifacts, an authenticated access path, and independently enforced deny-by-default egress. The private socket parent must remain owner-only mode `0700` and the live socket mode `0600`; OpenProjects refuses a pre-existing leaf, so a crash requires the [explicit stale-socket recovery runbook](./private-deployment.md#unix-control-socket-and-manual-recovery) rather than automatic deletion. Node likewise documents that a filesystem socket may remain after a crash ([Node Net documentation](https://nodejs.org/api/net.html)). Loopback TCP remains a development/compatibility path and does not authenticate the port holder back to the client. The browser dashboard has no control-token entry flow and ordinary browsers cannot address the private Unix socket. Telegram remains an external transport even when the TUI and model are local, and a private multi-user colleague still needs an internal transport plus per-user corporate identity and authorization.
