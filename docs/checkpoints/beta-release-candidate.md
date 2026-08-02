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
| Disposable package preflight | byte-identical packs; 1,222,371 bytes; expected candidate SHA-256 `38ab73f75566fcd9977183390a53860bec135a1d5d8313033bb70e005e3a8c96`; local lifecycle passed; release gate correctly remained incomplete |
| Provider/platform audit | 6 files / 76 deterministic tests passed; zero providers are managed-beta accepted; only this macOS host is observed |
| Security | root/web audits zero at the integrated head; Gitleaks clean; production QA-018 and prior-artifact trust roots empty by design |

The four files changed by the candidate commit are excluded from the npm package. Therefore the
retained candidate built after this commit must be byte-identical to the disposable Phase P
preflight above. A different digest is a release-blocking source or packaging drift.

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
| Browser/mobile | Repaired standalone CDP harness exists | In-app Browser, successful exact-head desktop/tablet/phone capture, and exact-candidate iOS/Android PWA evidence remain open |

## Remaining gates

- Provider-native: `BASE-010`, `TOOL-014`, `QA-005`, `PKG-GATE`, `REL-007`, `REL-008`, and
  `QA-GATE` remain open.
- Metrics: exact context-injection totals, model acknowledgements, complete provider-neutral
  duplicate-work attribution, high-fanout predispatch, repository-wide event replacement,
  representative before/after evidence, `MET-015`, and `MET-GATE` remain open.
- Quality: `QA-013`, `QA-014`, `QA-015`, real-duration `QA-016`, clean-platform `QA-017`, signed
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
