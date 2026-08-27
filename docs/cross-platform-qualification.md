# Cross-platform qualification

OpenProjects separates **core software portability** from **target-hardware AI
qualification**. A green build on Windows, macOS, or Linux proves that the
bounded harness, SQLite migrations, policy/approval kernel, deterministic
fixtures, and release boundary work on that operating system. The POSIX-only
MLX training-safety suite runs on macOS/Linux and is a recorded Windows N/A,
not a synthetic pass. No software gate qualifies an Ollama, MLX, `llama.cpp`,
vision, embedding, or Whisper model on that machine.

## Supported qualification lanes

| Lane | Target | What it proves | What it does not prove |
| --- | --- | --- | --- |
| Native workstation | The operator's real Windows or Mac | The release gate executes with that machine's filesystem, process, and terminal behavior | Another OS, a particular model, or a 4 GiB host |
| Hosted CI | Ubuntu 24.04 x64, Windows Server 2025 x64, and macOS 15 arm64 | A clean checkout installs and passes the same portable core gate on three fresh runner images, with platform exclusions recorded | Consumer hardware, offline operation, sustained memory use, GPU support, or local model quality |
| Provider-sidecar software | A fresh exact-commit Node 24 matrix plus the packed CLI smoke | Offline config, provider normalization with injected transports, crash-spool/owner-lock behavior, test-controlled loopback Oracle ingestion, and the installed `sidecars check` command execute on the recorded OS | A real provider tenant, real provider TLS/DNS/proxy behavior, OAuth, a target Linux VM, or physical Windows deployment controls |
| Harness footprint | The current supported macOS evaluator host | Built CLI startup, settled/lifecycle RSS, one durable mock run, shutdown, descriptor isolation, and cleanup | Co-resident model memory or a 4 GiB total-system certification |
| Local model gate | Exact reviewed target process and artifacts | The capability and resource evidence defined by that model lane | Portability to a different runtime, quantization, device, or host |
| Portable 4 GiB promotion | A real Linux VM/host with the required cgroup-v2 evidence | The exact `llama.cpp` candidate remains inside the finite Linux resource envelope during the full soak | Windows/macOS equivalence or a larger unmeasured model |

The GitHub-hosted matrix is deliberately a software gate. Standard hosted
runners have substantially more than 4 GiB of memory, so a green Linux job must
never be presented as the lightweight model certification.

## One release command on every OS

Requirements are Node.js 24+ and npm. Python 3.12+ is required on macOS/Linux
for the optional MLX training lab's 38 standard-library safety tests. The
application runtime itself does not embed a Python service, and native Windows
does not implement that lab's POSIX `dir_fd` and symlink-race contract.

macOS or Linux:

```bash
npm ci
npm run check:release
```

Windows PowerShell:

```powershell
npm ci
npm run check:release
```

On Windows, `check:release` visibly reports the MLX Python suite as
`Windows N/A`; the Node/SQLite harness gate still runs in full. On macOS/Linux,
the strict launcher resolves `OPENPROJECTS_PYTHON`, then `python3`/`python`
without invoking a command shell. Set the override when Python is installed in
a nonstandard location:

```bash
OPENPROJECTS_PYTHON=/reviewed/path/to/python3 npm run test:training:strict
```

Do not copy `node_modules` between operating systems. Run `npm ci` separately
on each native filesystem. When using WSL for an additional Linux check from a
Windows PC, keep a separate checkout inside the WSL filesystem; that is useful
Linux-kernel evidence, but it is not a substitute for the native Windows run.

## CI evidence

The workflow in [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs
the portable gate independently on pinned Ubuntu, Windows, and macOS runner
labels. It can also be started manually. Each matrix cell must be green before
a release is called cross-platform qualified.

A separate three-OS job installs and checks the isolated
[`AI SDK + MCP` example](../examples/frameworks/ai-sdk-mcp/README.md) from its
own lockfile. Its deterministic suite includes an actual built MCP stdio child
and loopback HTTP server, so the job exercises process spawning and protocol
I/O on each runner without downloading or invoking a model. This job does not
add the framework packages to the root runtime or qualify model quality.

The workflow calls the same evidence-producing entry point available locally:

```bash
npm run qualify:platform
```

That command performs its own clean `npm ci`, installs the packed tarball into
an empty consumer directory, exercises CLI help, setup dry-run, an offline
Windows-safe sidecar config check, and package exports, and records the host
contract, every stage log, the native Vitest JSON report, explicit skips, and hardware/model
exclusions, then writes JSON and Markdown summaries plus a SHA-256 evidence
manifest to the exclusive temporary directory printed at exit. Use
`-- --output <new-directory>` when a retained, operator-protected location is
required; the destination must not already exist, preventing stale evidence
from being mixed into a new run.

The software corpus is fail-closed rather than a floating “whatever tests still
exist” count. The current baseline is 46 files, 135 suites, and 563 registered
Vitest assertions, with exact per-file counts. macOS expects zero framework
skips, Linux expects two named macOS-alias fixture skips, and Windows expects 33
named POSIX/macOS-only skips. Any missing file/assertion, extra or missing skip,
or todo fails qualification. The POSIX Python lane likewise requires exactly 38
tests and zero skips.

### Sidecar qualification boundary

| Evidence layer | Current disposition | Honest limitation |
| --- | --- | --- |
| Deterministic source and packed CLI | Implemented; fresh exact-commit three-OS evidence pending | Injected provider transports do not exercise a vendor endpoint or credential |
| Linux CI and target Linux VM | Unqualified for the new sidecars | The historical hosted run predates them, and no retained target-VM sidecar report exists |
| Native Windows sidecar deployment | Unqualified | Hosted tests cannot attest Task Scheduler identity, NTFS DACL/reparse-point isolation, firewall policy, power-loss spool durability, or the owner's physical host |
| Linear/Jira live read | Unqualified | No exact artifact/config/tenant has passed real TLS, pagination, retry, replay, and unchanged-repeat evidence |
| Provider OAuth lifecycle | Not implemented or qualified | Static API-key or pre-issued-token consumption proves no consent, PKCE, refresh, rotation, or revocation behavior |
| Complete Oracle inside 4 GB | Unqualified | Neither the sidecar process nor a representative Oracle dataset was included in the earlier resource evidence |
| Vision | Unqualified | Dependency and deterministic adapter tests are not a live VLM or product-ingestion result |

Merely adding the matrix is not a pass. Preserve the workflow URL and commit
SHA in release evidence after the repository is pushed and the run completes.
GitHub-hosted runners are useful clean-room compatibility evidence; native runs
remain valuable for the operator's exact Windows and Mac versions.

## Current evidence status

On 2026-08-27 a fresh native qualification of source commit
`ad02b19e62607e9c0f52402571ecb5c5931a8dc5`, including the Corporate Oracle
corpus, README cover, and inode-pinned Unix socket cleanup, passed on
`darwin/arm64` (Apple M3, 8 GiB): clean install, 473/473 Vitest assertions
across 41 files and 123 suites, 38/38 Python safety tests, zero framework skips,
build/typecheck, packed-install smoke, the 233-file MIT package boundary, and
zero production audit vulnerabilities. The retained 14-file evidence set is
stored in the private appliance evidence directory; its
`evidence-manifest.json` SHA-256 is
`a4768e74ba68f916ee9e8774f355b3b67d50c8ea667fcc286f3edd2e7ef94443`.

The same commit passed the public [cross-platform qualification workflow](https://github.com/MaxJafar/openprojects-harness/actions/runs/33031375045):
GitHub-hosted core jobs on macOS 15 ARM64, Ubuntu 24.04 x64, and Windows Server 2025
x64, plus the isolated AI SDK/MCP interoperability and production-audit job on
all three systems. The uploaded qualification ZIP digests were:

- macOS: `sha256:9216015b21d0e3eb899e08a0221b29758bb9c822874241f29fd5752aec459a79`
- Ubuntu: `sha256:1279272b1dde641776eda5c3d683eaa9b53be194ea053fc6859d2f4c38da5970`
- Windows: `sha256:36907e7c9646861f4d60a6314342ab88d6a4706f84b5c5c3b3756a43a4e2cbe8`

These hosted results prove clean-runner compatibility at that commit; they do
not replace a deployment-specific NTFS ACL review or a native qualification on
the owner's physical Windows device. The earlier 465-, 472-, and pre-hardening
473-test Mac reports are historical and superseded.

That historical run predates the Linear/Jira read-only sidecars. Their
deterministic source/tests must pass a fresh hosted matrix at the exact pushed
commit, and a real provider sidecar still requires separate live-tenant
evidence. Even after hosted Windows passes, physical Windows sidecar deployment
remains unqualified until CA-authenticated loopback HTTPS (or equivalent protected IPC), crash-spool recovery,
Task Scheduler identity, firewall posture, and reviewed NTFS ACLs pass on the
owner's machine.

## Platform boundaries

- macOS and Linux use the protected Unix-domain control endpoint in the sealed
  local profile. The general Windows service uses Bearer-protected loopback TCP,
  but sidecar sync rejects that plaintext transport because it does not
  authenticate the Oracle server; Windows sidecars require reviewed loopback
  HTTPS or an equivalent protected local transport.
- POSIX `0600`/`0700` checks are not Windows ACL verification. A Windows
  deployment must use an NTFS volume, restrict the data/config/token paths to
  the service identity with reviewed ACLs, and retain loopback/firewall checks.
- MLX and MLX-LM are Apple-Silicon lanes. They are not Windows or Linux runtime
  dependencies.
- FreeToken's reviewed source/server lane remains an optional Linux/NVIDIA
  experiment, not a portable core dependency.
- The macOS footprint evaluator and Linux cgroup-v2 4 GiB evaluator are
  intentionally platform-specific. Unsupported evidence is reported as such;
  it is never converted into a synthetic pass.

## Release acceptance

A cross-platform release record should contain:

1. The exact source commit and lockfile.
2. A successful native run on the maintainer's available Mac and Windows
   machines.
3. One successful CI matrix run covering all three pinned operating systems.
4. Separate manifests/reports for every promoted local model lane.
5. A real constrained-Linux report before making the total-system 4 GiB model
   claim.

Until item 3 has run against a pushed commit, the honest status is **matrix
configured, hosted qualification pending**. Until item 5 passes, the honest
status is **lightweight core target, portable local-model certification
pending**.
