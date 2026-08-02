# Beta launch checklist

Status: **NO-GO for public beta**. Source-candidate preparation may proceed; publication, tagging,
public push, version change, and stable promotion require explicit human approval.

## Integrated and locally verified

- [x] Accepted Beta Lane A, B, C, and Lane D implementation ancestry is unified.
- [x] Combined code tree passed complete default-parallel and one-worker suites at 273 files /
  2,261 tests, plus root/web TypeScript and production builds.
- [x] Independent code-integration and packaged-document reviews report P0/P1/P2 = 0/0/0.
- [x] Package preflight is byte-reproducible; expected candidate SHA-256 is
  `38ab73f75566fcd9977183390a53860bec135a1d5d8313033bb70e005e3a8c96`.
- [x] Publication and stable promotion are disabled; both production trust-root lists are empty.

## Exact-candidate verification

- [ ] Resolve the full `[beta-release-candidate]` commit SHA and verify the tracked tree is clean.
- [ ] Pass complete default-parallel and one-worker suites at that exact commit.
- [ ] Pass root/web TypeScript, production builds, dependency audits, Gitleaks, and security review.
- [ ] Run exact-candidate remote pairing, revoke, step-up, lost-device, interruption, and rollback
  journeys without weakening the still-open native/mobile duration gates.
- [ ] Complete a successful exact-head desktop/tablet/phone accessibility and performance capture;
  in-app Browser coverage remains separately required.
- [ ] Build one retained artifact only, verify its source/provenance and expected digest, and run all
  artifact smoke/scan/lifecycle checks against those same bytes.
- [ ] Obtain a distinct signed prior artifact and pass real cross-version upgrade and rollback.
- [ ] Verify the retained artifact on clean macOS and Ubuntu 24.04 x64 hosts.

## Provider and product acceptance

- [ ] Claude: obtain automation-policy authority and pass the exact native-subscription matrix.
- [ ] Codex: install/accept the exact declared version and pass the native ChatGPT subscription
  matrix; the current installed `0.146.0` correctly fails the pinned `0.144.6` contract.
- [ ] Qwen: establish an allowed managed-subscription policy and accepted adapter/version matrix.
- [ ] Kimi: pass native login plus Extra Usage consent, metering, and cap evidence.
- [ ] Complete representative outcome-quality benchmarking; do not claim token savings without
  equal or better verified delivery quality.
- [ ] Complete the defined real-world dogfood duration with no unresolved P0/P1 failures.
- [ ] Pass exact-candidate iOS and Android installed-PWA reconnect, offline, and revoke acceptance.

## Human approval and public actions

- [ ] Approve an explicit beta prerelease version; `0.1.0` is not a prerelease version.
- [ ] Review the exact candidate SHA, retained artifact digest, complete evidence, limitations, and
  rollback plan.
- [ ] Push the approved implementation to public `main` and require green exact-commit hosted CI.
- [ ] Publish only the retained tarball with npm provenance and the `beta` dist-tag.
- [ ] Verify public npm/npx and every claimed provider/plugin installation from clean consumers.
- [ ] Tag the exact verified commit and create the GitHub beta release.
- [ ] Start staged opt-in rollout and monitor installation, provider, recovery, token, and migration
  signals with an approved rollback owner.

`REL-016` is out of beta scope. Stable promotion stays disabled until plug-and-play and retention
criteria are independently met.
