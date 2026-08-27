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
an empty consumer directory, exercises CLI help/setup dry-run/package exports,
and records the host contract, every stage log, the native Vitest JSON report, explicit skips, and hardware/model
exclusions, then writes JSON and Markdown summaries plus a SHA-256 evidence
manifest to the exclusive temporary directory printed at exit. Use
`-- --output <new-directory>` when a retained, operator-protected location is
required; the destination must not already exist, preventing stale evidence
from being mixed into a new run.

The software corpus is fail-closed rather than a floating “whatever tests still
exist” count. The current baseline is 41 files, 123 suites, and 473 registered
Vitest assertions, with exact per-file counts. macOS expects zero framework
skips, Linux expects one named macOS-alias fixture skip, and Windows expects 28
named POSIX/macOS-only skips. Any missing file/assertion, extra or missing skip,
or todo fails qualification. The POSIX Python lane likewise requires exactly 38
tests and zero skips.

Merely adding the matrix is not a pass. Preserve the workflow URL and commit
SHA in release evidence after the repository is pushed and the run completes.
GitHub-hosted runners are useful clean-room compatibility evidence; native runs
remain valuable for the operator's exact Windows and Mac versions.

## Current evidence status

On 2026-08-27 a fresh native working-tree qualification including the Corporate
Oracle corpus passed on `darwin/arm64` (Apple M3, 8 GiB): clean install, 473/473
Vitest assertions across 41 files and 123 suites, 38/38 Python safety tests,
zero framework skips, build/typecheck, packed-install smoke, the 232-file MIT
package boundary, and zero production audit vulnerabilities. The retained
14-file evidence set is stored in the private appliance evidence directory;
its `evidence-manifest.json` SHA-256 is
`59d168aef826ecd4305545e84b04d59b9afdd2643b7c6fb14e1d698f24dee774`.
The earlier 465- and 472-test Mac reports are now historical and superseded.

This is current local Mac evidence, not a release-commit claim: the workspace
is not yet a Git repository. Native Windows and hosted Ubuntu/Windows/macOS
results remain pending; the checked-in workflow is configuration, not evidence
of a run that has not happened.

## Platform boundaries

- macOS and Linux use the protected Unix-domain control endpoint in the sealed
  local profile. Windows uses authenticated loopback TCP because the POSIX
  socket ownership/mode contract is unavailable there.
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
