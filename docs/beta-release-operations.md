# Beta artifact, upgrade, rollback, and hotfix operations

Status: **implementation contract, not a publication claim**. No npm package, tag, GitHub release,
or stable promotion is authorized by this document. Public actions still require the exact-artifact
evidence bundle and explicit human approval.

## Release boundary

One `npm pack` tarball is the release candidate. CI retains that tarball and its exact-commit
evidence; publication must download and verify those bytes and must not rebuild the source tree.
The package inventory includes the bundled daemon/CLI runtime, built web application, provider
hooks, Claude and Codex plugin manifests, and the environment compatibility contract.

`scripts/package-install-smoke.mjs` records:

- the source commit, package filename, byte count, SHA-256, npm shasum and npm integrity;
- the complete npm file inventory and required runtime assets;
- a second, scripts-disabled pack whose bytes must match exactly;
- an isolated install/upgrade/uninstall report with data-preservation evidence; and
- a high/critical dependency audit of the installed artifact.

The artifact secret scan runs against the extracted retained package. The publish boundary then
checks the uploaded artifact identity, exact workflow run, tag/version, complete CI evidence and
tarball digest before copying the same bytes to `verified.tgz`.

## Local retained-artifact rehearsal

Use the supported Node `22.20.0` and npm `10.9.3` toolchain. Point evidence variables at a new,
disposable directory and the clean exact source commit:

```sh
CI_EVIDENCE_SHA="$(git rev-parse HEAD)" \
CI_EVIDENCE_DIR="/absolute/disposable/evidence" \
npm run package:artifact
```

The command builds once, retains one tarball, proves byte reproducibility, installs it into a new
consumer, installs and removes both providers' hooks, reinstalls/upgrades, audits dependencies,
uninstalls the package, and proves that state, unrelated provider configuration and project files
survive. To exercise a real cross-version upgrade, set `ORCHESTRA_PREVIOUS_PACKAGE` to a retained,
previously verified tarball. Without it, the harness explicitly reports
`same-artifact-reinstall`; that is an idempotency rehearsal, not cross-version evidence.

The Orchestra package is required to define no `preinstall`, `install`, or `postinstall` script.
Reviewed native dependencies such as SQLite and PTY bindings still require their own install
scripts for a functional clean install; the lifecycle harness therefore permits dependency scripts
and then exercises the installed daemon. The separate minimal CLI smoke keeps all scripts disabled.

Do not point `CI_EVIDENCE_DIR`, `ORCHESTRA_HOME`, or lifecycle fixtures at a real user directory.
The harness creates and removes only its own temporary consumer roots.

## Beta channel and staged flags

The machine-readable contract is `scripts/beta-release-contract.json`. Promotion order is
`internal` → named opt-in `canary` → public opt-in `beta`. The npm distribution tag is `beta`.
All migration controls remain off by default until their own gates pass. `stable` is intentionally
disabled and remains outside this beta task.

The beta package version must be an explicit SemVer prerelease such as `0.1.0-beta.1`, and its Git
tag must be the exact `v`-prefixed package version. A stable-looking `0.1.0`/`v0.1.0` pair is not a
beta candidate and the publish job rejects tags without a prerelease suffix. Publication uses
`npm publish --tag beta`; it must never write the default `latest` tag. The source version remains
`0.1.0` during preparation because changing it is itself a release action requiring human approval.

Before changing cohorts, retain the exact artifact and evidence, name the cohort, record the one
control delta, verify backup/restore, and observe install, provider, recovery, token and migration
signals. Never silently substitute a provider, authentication method or billing mode.

## Upgrade and uninstall

An upgrade uses the previous and candidate retained tarballs. Stop the daemon, preserve the
configured state directory and worktrees, install the candidate with lifecycle scripts disabled,
run compatibility checks, then restart. Schema evolution is forward-only: application rollback is
allowed only inside the documented compatibility range and never performs a schema down migration.

For uninstall, stop remote exposure and the daemon, run `orchestra uninstall --provider both`,
remove the npm package, and preserve state by default. Deleting `ORCHESTRA_HOME`, worktrees,
artifacts or provider credentials is a separate, explicit operator decision.

## Rollback

Stop promotion for data corruption, credential/authorization failure, unbounded resource or token
use, cohort-level install/upgrade failure, provider/runtime regression, or an unresolved P0/P1.
Disable only the affected new-work control, preserve forward-only data and audit history, restore
the previous retained and provenance-verified application artifact, then verify database integrity,
active work and provider identity before resuming.

Rollback must not rebuild the previous artifact, down-migrate schema, delete user data, or silently
change provider or billing mode. A release without a retained previous artifact and a rehearsed
rollback remains blocked.

## Hotfix

Branch from the exact affected release commit. Apply the smallest reviewed fix, create a new
artifact with new provenance, and pass the same test, build, lifecycle, audit, secret-scan,
provider/platform and rollback gates as a normal beta candidate. A hotfix may not skip tests or
mutate an already-published artifact. Publication, tagging, public pushes and promotion still stop
for explicit human approval.

## Evidence still requiring external systems

Local disposable consumers do not prove public npm/npx availability, npm provenance, a clean Linux
host, every supported macOS tuple, or credentialed native-provider journeys. Those remain final
release gates and must cite the retained artifact digest rather than a rebuilt equivalent.
