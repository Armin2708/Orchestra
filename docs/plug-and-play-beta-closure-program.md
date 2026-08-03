# Plug-and-play beta closure program

Status: active execution plan, based on exact beta candidate
`7c147c4ccccb11bb89850f3119cdb23859c81916`.

## Outcome

Ship an opt-in technical beta that a trusted tester can install without repository knowledge,
connect to an explicitly accepted native-subscription provider, complete and verify a task, resume
after interruption, and recover or revoke remote access without maintainer intervention.

This document creates execution packages, not duplicate backlog checkboxes. Every package maps to
the authoritative IDs in `Agentboard - Agent OS Master Backlog`.

## Release boundaries

- Beta requires at least one provider to pass the complete exact-version native-subscription
  acceptance matrix. A provider that has not passed is displayed as unsupported and is not claimed.
- Implementation, deterministic tests, and local rehearsal do not substitute for credentialed
  provider evidence, real-device evidence, elapsed dogfood time, hosted CI, or clean external hosts.
- The retained `0.1.0` candidate remains immutable. A successor artifact must use an explicitly
  approved prerelease version and be retained once for all final tests.
- No version change, push, npm publication, tag, GitHub release, production trust-root update, or
  stable promotion is authorized by this plan.
- `REL-016` and `LATER-001` through `LATER-010` remain outside beta scope.

## Execution packages

| Package | Scope and exit condition | Authoritative backlog IDs | Owner lane | Evidence class |
|---|---|---|---|---|
| PNP-01 | Freeze the beta provider claim set and exact version/auth/billing/capability/OS matrix; unsupported providers remain visible and fail closed. | BASE-010, TOOL-014 | Provider integration | Code + policy + real provider |
| PNP-02 | Make Codex CLI detection, doctor, protocol generation, onboarding, launch/resume/cancel, approvals, events, usage, and clean-profile native-subscription acceptance pass for one exact supported tuple. | TOOL-014, QA-005, REL-007, REL-008 | Codex | Code + credentialed acceptance |
| PNP-03 | Make Claude Code detection, doctor, supported hook/plugin path, onboarding, launch/resume/cancel, approvals, events, usage, and policy-authorized native-subscription acceptance pass for one exact supported tuple. | TOOL-014, QA-005, REL-007, REL-008 | Claude | Code + provider policy + credentialed acceptance |
| PNP-04 | Reduce private-tarball first run to install, doctor, onboard, launch, verify, support; every blocked provider result includes one safe corrective action and no credential handling. | PKG-GATE, QA-GATE, REL-GATE | Onboarding | Code + clean-user journey |
| PNP-05 | Eliminate the fixture/admission HTTP 429 failure and pass desktop, tablet, and phone interaction, keyboard, semantic/screen-reader, contrast, and performance budgets against the exact build. | UX-012, UX-GATE, QA-013, QA-014, QA-015 | Browser quality | Automated browser + visual review |
| PNP-06 | Install the retained PWA on real iOS and Android devices; prove reconnect, scoped credential storage, step-up, and lost-device revoke without disrupting other sessions. | REM-017, REM-GATE, MILE-D phone | Remote/mobile | Real devices |
| PNP-07 | Prove daemon restart during an active Agent Home and a real terminal coding task without history, PTY, provider, or tool regression. | AGT-GATE, PTY-GATE, MILE-B durable home, MILE-B PTY parity | Runtime quality | Deterministic + real task |
| PNP-08 | Exercise every lifecycle transition and active multi-agent work across daemon, provider, and network interruptions; retain duration and recovery evidence with no duplicates or silent loss. | OPS-002, OPS-GATE, QA-016, REL-009 | Operations | Harness + elapsed dogfood |
| PNP-09 | Pass install, distinct-version upgrade, uninstall, backup, restore, and data preservation from the exact package on clean supported macOS and Linux hosts. | QA-017, REL-006, PKG-001, PKG-015, MILE-E clean install | Packaging | Clean external hosts |
| PNP-10 | Establish a reviewed Ed25519 release trust root and a distinct signed prior artifact; prove exact cross-version upgrade and rollback without down-migration or data loss. | PKG-015, REL-012, MILE-E artifact path | Provenance | Human key ceremony + artifact lifecycle |
| PNP-11 | Produce machine-verifiable GitNexus impact/detect-changes and Graphify evidence for every slice, bind it to the exact integration ancestry, and obtain an independent signed QA-018 receipt. | QA-018 | Integration quality | Tool reports + human signature |
| PNP-12 | Prepare an explicit prerelease version, observe protected `npm-beta`, obtain green hosted CI for exact head, and verify the retained artifact is the artifact eligible for provenance publication. | REL-003, REL-005, REL-013 | Release engineering | Hosted systems + approval |
| PNP-13 | Refresh exact release notes, screenshots, provider matrix, verification counts, migration/rollback/privacy/security docs, and tester support instructions. | REL-004, REL-012, MILE-E artifact path | Documentation | Exact-head review |
| PNP-14 | Prove tokens per accepted delivery improves without quality decline; retain install/provider/recovery/token-storm/migration monitoring and rollback thresholds. | MET-002, MET-006, MET-007, MET-011, MET-013, MET-015, MET-GATE, REL-014, MILE-D analytics | Analytics/operations | Representative benchmark + staged telemetry |
| PNP-15 | Observe legacy launch-write telemetry at zero before removal; do not make beta depend on premature destructive cleanup. | ORC-020, MILE-A legacy | Post-beta observation | Production telemetry |
| PNP-16 | After all preceding exact evidence passes, request approval with commit, retained digest, provider/platform matrix, tests, monitoring, rollback, and support plan; only then push public main, publish, tag, and create the beta release. | REL-002, REL-005, REL-011, REL-GATE | Human release owner | Explicit authorization |

## Dependency order

1. PNP-01 to PNP-05 establish a usable accepted-provider install path.
2. PNP-06 to PNP-11 establish real-device, interruption, lifecycle, and traceability evidence.
3. PNP-12 to PNP-14 bind the successor artifact to hosted CI, docs, monitoring, and measured value.
4. PNP-16 is the public-action approval gate. PNP-15 may remain observation-only during beta.

## Closure rules

| Result | Meaning |
|---|---|
| implemented | Committed product or harness work exists and focused tests pass. |
| locally verified | Exact-head tests or artifact rehearsal pass on the integration host. |
| externally verified | Clean host, real device, provider account, hosted CI, or elapsed-time evidence is retained. |
| release closed | All required evidence is exact-bound, independently reviewed, and explicitly approved. |

A package may advance only through observed evidence. A skipped external gate remains open; a
fixture, mock, synthetic key, or same-version artifact cannot close it.

## 2026-08-03 local progress

- PNP-05 is partially verified: the HTTP 429/stability blockers are cleared, three retained
  exact-artifact desktop/tablet/phone observations passed 108 / 108 journeys, and the fixed-budget
  matrix passed 36 / 36. `QA-015` is locally closed.
- PNP-05 is not release-closed: the in-app Browser/visual acceptance surface was unavailable, so
  `QA-013`, `QA-014`, `UX-GATE`, and `QA-GATE` remain open.
- Exact code head `87484e1` passed complete default-parallel and one-worker suites at 281 files /
  2,360 tests. No provider, device, clean-host, elapsed dogfood, publication, or stable-promotion
  claim changed.
