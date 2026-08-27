# Open-source release checklist

OpenProjects source is prepared for release under the MIT license. This
checklist separates mechanical repository readiness from decisions that only
the copyright owner and future repository owner can make.

## Public source decision

The source repository is
[`MaxJafar/openprojects-harness`](https://github.com/MaxJafar/openprojects-harness)
under MIT. Its exact repository, homepage, and issue coordinates are recorded
in `package.json`. The first publication is Git-hosted source only;
`package.json` intentionally retains `"private": true` so this decision cannot
accidentally publish an npm package.

Before the first tagged release or npm publication:

1. confirm that every copyright holder has authority to publish the contributed
   work under MIT, including work created for an employer or client;
2. confirm or replace `OpenProjects contributors` in `LICENSE` with the exact
   holder wording selected by those owners;
3. keep GitHub private vulnerability reporting enabled or publish another monitored private
   security contact, and publish an actionable private conduct-reporting method
   (the channels may be separate);
4. record the people with merge and release authority in repository settings;
5. decide whether the project will remain Git-hosted only or publish to npm;
6. complete a name, package-name, and trademark clearance before broader
   branding. The proposed “OpenProjects” name is close to the established
   [OpenProject](https://www.openproject.org/) project-management product from
   [OpenProject GmbH](https://github.com/opf/openproject). MIT grants copyright
   permissions; it does not clear a product name or trademark. Rename before
   release if the clearance is not satisfactory.

`package.json` intentionally retains `"private": true` to prevent an accidental
npm publication before the package namespace, maintainers, 2FA/OIDC policy,
and provenance settings are chosen. This does not
restrict use of the source under MIT.

## Never publish local state

Do not upload or attach the working directory as a ZIP. In particular, never
publish:

- `.openprojects-appliance/` or its model weights, runtimes, control tokens,
  caches, manifests, logs, or state;
- `data/`, SQLite/WAL/SHM files, owner locks, sockets, or generated tokens;
- `.env`, private deployment YAML, reviewed learning exports, training
  artifacts, adapters, or model snapshots;
- `node_modules`, Python virtual environments, caches, or bytecode.

The Git ignore rules and npm allowlist provide two independent boundaries, but
they do not make a manual ZIP safe.

## Release verification

From a clean checkout with Node.js 24 and Python available:

```bash
npm ci
npm run check:release
npm pack --dry-run --json
```

`check:release` also packs the built artifact, installs it without lifecycle
scripts into an empty temporary consumer, verifies the package-root exports and
CLI help, and proves `setup --defaults --dry-run` creates no configuration or
data directory. The native platform qualification repeats that same smoke on
each Windows, macOS, and Linux matrix host.

After initializing Git, inspect what will actually be published:

```bash
git status --short
git ls-files
git grep -n '/Users/\|BEGIN .*PRIVATE KEY\|TELEGRAM_BOT_TOKEN=' -- .
git check-ignore -v .openprojects-appliance data/openprojects.db .env
```

Review the complete staged diff, not only the working tree. A release maintainer
should also generate and retain a dependency SBOM appropriate to the released
artifact. Any appliance/container distribution needs a separate SBOM and
license bundle for every included runtime, Python package, binary, and model.

## Package boundary

The npm `files` allowlist includes compiled runtime code, public assets, skills,
evaluation/configuration examples, deployment templates, documentation, and the
reviewed training-lab source. Core TypeScript source and the core test suites
are excluded; the deliberately distributable AI SDK/MCP example includes its
own TypeScript source and example tests. Compiled tests, local data, caches,
credentials, and model artifacts remain excluded. The MIT license and
third-party notice are mandatory package contents.

The packed runtime supports its compiled export, `openprojects` binary, and
compiled operational npm aliases. Development and release-maintenance scripts
such as build, typecheck, tests, and platform qualification are source-checkout
commands because the npm allowlist intentionally excludes the root TypeScript
source, core tests, and release scripts. If npm publication is selected, review
and trim those maintainer-only script entries as part of the publish-manifest
decision; they are not a supported consumer API.
