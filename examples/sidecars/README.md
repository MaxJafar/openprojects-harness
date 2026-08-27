# Read-only Corporate Oracle sidecars

These are intentionally non-runnable templates. Replace every `REPLACE...`
value before `sidecars check`; unresolved placeholders fail closed.

Each process is one-shot and bounded. It verifies the immutable provider
account, executes only code-fixed read/query operations, normalizes a finite
page, durably spools that exact page, and submits it through an OpenProjects
principal that should have only `ingest` for the configured workspace. It
never gives provider tools to the model and never performs a provider write.

```bash
npm run build
node dist/src/cli.js sidecars check --config examples/sidecars/linear-readonly.yaml
node dist/src/cli.js sidecars probe --config /protected/linear-sidecar.yaml --json
node dist/src/cli.js sidecars sync --config /protected/linear-sidecar.yaml --json
```

Use Task Scheduler, launchd, systemd timers, or another reviewed scheduler to
run `sync`; the sidecar is not a resident service. Never overlap invocations.
The owner lock enforces this cooperatively. After a crash, verify that no
sidecar process is running before manually removing the exact
`sidecar-state.owner.lock`; leave `pending-page.json` in place so the next run
can replay its byte-identical Oracle request.

The Linear template supports a restricted personal API key or a pre-issued
OAuth Bearer token. The Jira template currently supports a pre-issued OAuth
Bearer token, verifies `cloudId` through Atlassian accessible resources, and
requires the exact `read:jira-work` grant with no write/manage scope.
Supplying a token does not qualify OAuth authorization, refresh, rotation, or
revocation. Provider deletion/archive reconciliation is also outside this v1
polling lane.

The templates use a protected POSIX Unix socket. Plain HTTP loopback sync is
rejected because a Bearer credential authenticates the sidecar to the Oracle,
not the Oracle server to the sidecar. A Windows deployment therefore needs
CA-authenticated loopback HTTPS or an equivalent protected local transport;
that path has not yet been qualified.
