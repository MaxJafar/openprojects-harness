# Governance

OpenProjects currently uses a maintainer-led governance model suitable for an
early-stage public project.

## Decision making

- Routine changes are accepted through reviewed pull requests.
- Significant public API, storage, policy, security, model-routing, or licensing
  changes should begin with a design issue.
- Maintainers seek consensus, but may make a documented final decision when a
  decision is required.
- Security-sensitive decisions can be discussed privately until coordinated
  disclosure is safe.

## Roles

Contributors submit issues, documentation, tests, code, research, and reviews.
Maintainers triage work, review and merge changes, manage releases, enforce the
Code of Conduct, and protect security and licensing boundaries. Maintainer
access is granted based on sustained, trustworthy contributions and can be
removed for inactivity, security risk, or conduct violations.

The public repository should maintain an auditable list of people with merge
and release authority in its hosting-platform settings. No source file should
be treated as proof of current account permissions.

## Releases

A maintainer may cut a release only after the documented tests and open-source
release gate pass, dependency and model-license changes are reviewed, and the
package contents are inspected. Release notes must distinguish implemented,
qualified, experimental, and future capabilities.

## Licensing

Project contributions are accepted under the repository's MIT license as
described in [CONTRIBUTING.md](./CONTRIBUTING.md). A change to the project
license requires explicit maintainer approval, a documented rights review, and
clear notice to contributors and users.
