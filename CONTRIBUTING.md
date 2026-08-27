# Contributing to OpenProjects

Thank you for helping improve OpenProjects. Contributions are reviewed with the
same local-first, least-authority, and fail-closed assumptions as the runtime.

## Before opening a change

- Use an issue for substantial behavior, schema, security-boundary, or public
  API changes so the design can be discussed first.
- Keep changes narrow and include evidence for claims about models, privacy,
  durability, cost, or security.
- Read [SECURITY.md](./SECURITY.md) before changing authentication, approvals,
  tools, persistence, transport, learning, or model execution.
- Follow the [Code of Conduct](./CODE_OF_CONDUCT.md).

## Development setup

The TypeScript harness requires Node.js 24 or newer.

```bash
npm ci
npm run check
npm run test:training
```

Before proposing a release-facing change, run the full public-release gate:

```bash
npm run check:release
```

The same command is the portable Windows, macOS, and Linux software gate. Do
not copy `node_modules` between operating systems, and do not interpret a green
software job as model or 4 GiB target-hardware qualification. See the
[cross-platform qualification contract](./docs/cross-platform-qualification.md).

Tests must be deterministic, use in-memory or temporary storage, and avoid live
network or model calls unless they are explicitly opt-in qualification tests.
Use synthetic fixtures; never commit a real database, chat, transcript, token,
credential, model weight, reviewed training export, or customer artifact.

## Pull requests

A pull request should:

1. explain the user-visible outcome and trust-boundary impact;
2. add or update focused tests for the changed behavior;
3. update documentation and examples when the public contract changes;
4. preserve backward compatibility or describe the migration explicitly;
5. keep default evaluations offline and fail closed;
6. disclose any new dependency, copied material, model, service, or license;
7. pass `npm run check:release`.

AI-assisted contributions are welcome, but the contributor remains responsible
for correctness, provenance, security, and licensing. Review generated code and
disclose material AI assistance in the pull request. Do not submit confidential
prompts or generated material whose rights you cannot grant.

## Licensing contributions

OpenProjects is licensed under the [MIT License](./LICENSE). By submitting a
contribution, you represent that you have the right to submit it and agree that
it is licensed under the same MIT terms, without additional restrictions. No
contributor license agreement is currently required.

Do not copy third-party code or data into the repository unless its provenance
and license are documented and compatible. Dependency or model changes must
update [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) when relevant.

## Security reports

Do not put vulnerability details, credentials, or private data in an issue or
pull request. Follow the private reporting instructions in
[SECURITY.md](./SECURITY.md#reporting-a-vulnerability).
