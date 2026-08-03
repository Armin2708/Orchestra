# Beta release-candidate checkpoint

Marker: `[beta-release-candidate]`

Status: **source candidate prepared; beta publication is not authorized**.

The exact candidate is the commit that contains this file and whose subject contains
`[beta-release-candidate]`. Recording its SHA inside the commit would be self-referential, so the
post-commit evidence bundle and approval packet must bind the resolved full SHA. No npm publish,
tag, GitHub release, public push, version change, or stable promotion is authorized here.

## Asked

Integrate accepted Beta Lanes A through C with Lane D analytics, quality, onboarding, packaging,
support, and release controls; reconcile shared seams; prepare one exact-source beta artifact; and
leave every unproved provider, platform, browser, duration, provenance, and public-release gate
fail-closed.

## Delivered

- Accepted collaboration, Knowledge, Discussion, Team, runtime, command-center, secure-remote,
  operations, analytics, QA, packaging, onboarding, and diagnostics/support lineages are unified.
- The sole code conflict preserved both secure remote authority/navigation and the serialized
  single-flight metrics refresh path. Independent integration review reported P0/P1/P2 = 0/0/0.
- Packaged operational documentation now matches the integrated implementation and explicitly
  separates deterministic component evidence from managed-provider, clean-platform, and public
  release acceptance.
- Publication stays disabled, stable promotion stays disabled, package version remains `0.1.0`,
  and both production trust-root lists remain intentionally empty.

## Evidence available before this commit

| Gate | Observed result |
|---|---|
| Combined code integration | default-parallel and one-worker suites each passed 273 files / 2,261 tests on Node 22.20.0 / npm 10.9.3 |
| Final integration review | ACCEPT, P0=0, P1=0, P2=0; root/web types and production builds passed |
| Packaged-document phase | exact commit `10e430747c41d9335bacd5fa041c4bd359e196e5`; 21 files / 123 focused tests, root/web types/builds, audits, Gitleaks, package inventory, GitNexus, and Graphify passed; independent P0/P1/P2=0 |
| Historical disposable package preflight | Earlier source candidate `7c147c4` produced byte-identical 1,222,371-byte packs with SHA-256 `38ab73f75566fcd9977183390a53860bec135a1d5d8313033bb70e005e3a8c96`; later plug-and-play product changes invalidate that digest for the current source, so the current retained-artifact gate remains open |
| Provider/platform audit | 6 files / 76 deterministic tests passed; zero providers are managed-beta accepted; only this macOS host is observed |
| Security | root/web audits zero at the integrated head; Gitleaks clean; production QA-018 and prior-artifact trust roots empty by design |

## Post-checkpoint local browser closure — 2026-08-03

- Product fix `49e1e5c6b8edf8be49d682680815e22fec5166f4` prevents a semantically unchanged
  saved-view filter from issuing a duplicate Open Work request. The worst observed phone graph
  journey fell from 2,061 ms to 539 ms without relaxing the 1,000 ms experience ceiling.
- Three independent exact-artifact observations passed 108 / 108 desktop, tablet, and phone
  journeys with zero validation, request, console, or page errors. Their evidence digests are
  `e4e2ae8db22c654994d1f60a680b21efe02a2c855683a36ec38d7d24cc3e5196`,
  `666bc674c4ba2f93343b9d57241be8f9501aa5195a909ac1e7865b77391dcf77`, and
  `ac1e40d5d618976adb5c0d3633af8048681d25a3861e24c307f8a587f31c575f`.
- The retained QA-015 baseline digest is
  `de92bb96f2fe7467a1fc1f43b68127c002b229e0e19e1553ca673d29db06d43a`.
  The budgeted exact-artifact matrix at `3c6b9e08d8235604f4a51823abd07c0c7e0d96de`
  passed another 36 / 36 journeys; evidence digest
  `bb58f2fb17735eb11ebd55c1296c7ca6c6103ed5a68b3bc46dee5fec81891eca`.
- Artifact identity remained byte-identical across the evidence-only commit: root
  `c92de228f05b4adf575f7e20fb60a1a720fadfd1048e225fab7fec4fb7a4d1dc`, web
  `c4d2149ba3efec5d3500f8e837bbad661fb5528a9bd17814ad5638179a69eae0`.
- Exact code head `87484e1` passed complete default-parallel and one-worker suites at 281 files /
  2,360 tests on Node 22.20.0. The only initial full-suite failure was a date-brittle test whose
  fixed 2026-08-03 expiry had elapsed; the test now uses its existing frozen fixture clock.
- `QA-015` is locally closed. The evidence explicitly prohibits closing `QA-013`, and `QA-014`
  remains open because the intended in-app Browser/visual acceptance surface was unavailable.
  The standalone Chromium result is not promoted into unsupported in-app evidence.

No retained package has been built for the current successor source. The historical `38ab73f…`
digest must not be reused as current evidence. Final packaging requires an approved prerelease
version and one newly retained artifact whose exact source, digest, lifecycle, and provenance are
verified without rebuilding it between tests and release.

## Provider and platform matrix

| Surface | Deterministic state | Beta release decision |
|---|---|---|
| Claude Code | SDK/native `0.3.212`, bundled CLI `2.1.212` compatibility passes | Unsupported: policy authority, real native acceptance, and Linux evidence absent |
| Codex CLI | Adapter contract pins `0.144.6`; installed `0.146.0` fails closed | Unsupported: exact clean-profile native acceptance and Linux evidence absent |
| Qwen Code | Fail-closed discovery/policy boundary exists; executable absent | Unsupported: no accepted tuple/login/adapter matrix; autonomous Coding Plan use not permitted |
| Kimi Code | ACP implementation exists; executable absent | Unsupported: no accepted tuple/login/Extra Usage metering and cap evidence |
| macOS arm64 | Node/npm and repository checks observed on the current host | Host evidence only; final clean-machine artifact lifecycle remains open |
| Ubuntu 24.04 x64 | Repository CI/toolchain contract exists | No exact retained-candidate clean-machine lifecycle evidence |
| Windows and other platforms | No complete acceptance matrix | Unsupported |
| Browser/mobile | Standalone CDP exact-artifact desktop/tablet/phone matrix and QA-015 budgets pass | In-app Browser/visual acceptance and exact-candidate iOS/Android PWA evidence remain open |

## Remaining gates

- Provider-native: `BASE-010`, `TOOL-014`, `QA-005`, `PKG-GATE`, `REL-007`, `REL-008`, and
  `QA-GATE` remain open.
- Metrics: exact context-injection totals, model acknowledgements, complete provider-neutral
  duplicate-work attribution, high-fanout predispatch, repository-wide event replacement,
  representative before/after evidence, `MET-015`, and `MET-GATE` remain open.
- Quality: `QA-013`, `QA-014`, real-duration `QA-016`, clean-platform `QA-017`, signed
  production `QA-018`, and `QA-GATE` remain open.
- Remote/operations: exact-candidate iOS/Android `REM-017`, `REM-GATE`, production every-transition
  `OPS-002`, and `OPS-GATE` remain open.
- Packaging/release: publication, prerelease version approval, a distinct signed prior artifact,
  clean macOS/Linux lifecycle, hosted exact-commit evidence, public install/provider/plugin
  verification, dogfood duration, monitoring, tag, GitHub release, and all human/public actions
  remain open. `REL-016` is out of beta scope and stable promotion stays disabled.
- Phase 18 `LATER-*` items remain deferred.

## Exact-candidate post-commit protocol

After resolving this commit's full SHA, run the complete parallel and one-worker suites, root/web
types and production builds, audits, Gitleaks, quality gates, provider doctor, remote/security
journeys, browser capture, and rollback drill. Then build exactly one retained tarball in
`/Users/arminrad/Desktop/agentboard-beta-artifacts/<candidate-sha>` and never rebuild it. Verify its
source/provenance SHA and exact digest above, scan and exercise those same bytes, and retain the
fail-closed release metadata.

Post-commit run IDs, timestamps, and the resolved SHA belong in the external approval packet and
Vault. Adding them to tracked files would create a different candidate.

## Security review and rollback

- The staged candidate has a CRITICAL GitNexus blast radius versus `main` because it changes 773
  symbols across 403 files and touches 60 execution flows. Full regression and artifact gates are
  mandatory.
- No private key, provider credential, auth cache, token, raw diagnostic content, or user state is
  release evidence. Empty trust roots intentionally prevent synthetic signatures from becoming
  production acceptance.
- Roll back before publication by stopping the candidate daemon, preserving state and artifacts,
  restoring the last provenance-verified application artifact, and verifying database integrity,
  provider/hook state, active work, and remote authority. Never down-migrate or delete user data.
- If no distinct trusted prior artifact exists, public rollout is blocked; rollback is not simulated
  with a same-artifact reinstall.

## Decision

This checkpoint prepares an engineering beta candidate; it does not make the candidate releasable.
Before any public action, a human must approve the exact commit, retained artifact digest, complete
test evidence, provider/platform limitations, and rollback plan.
