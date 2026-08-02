# Beta Lane D stack integration checkpoint

Status: **integration-ready Lane D stack; not the final central beta candidate**.

## Asked

Integrate the accepted packaging, signed QA-evidence verifier, and browser/accessibility harness
onto central commit `36f360228bfef1c4ef213c1df235a4f0f608a14b`, preserving ancestry and resolving the
shared packaging and quality-contract seams. Replace the Lane A/C placeholder quality bindings
with commands that execute the integrated implementations. Do not build the final retained
candidate, close external gates, change the package version, or perform a public action.

## Delivered

- Preserved the complete accepted packaging ancestry through marker
  `62725d1d782e78443d3aa923b530b7117601cea0` in merge commit
  `257e13f534eb5261466366b9f55c376ec7a1662f`.
- Preserved the accepted QA-018 verifier commit
  `457d4e3eb57107aaea4532616eb575f69d61a9d1` in merge commit
  `c5f4ca9bf4e9c3d8f6369e256d8931b7e97f7b6c`. The only textual conflict was the
  immutable requirements digest; the resolution pins the merged Lane A/C inventory.
- Preserved the complete accepted QA-014 harness ancestry through marker
  `b3c822daaeaaa4f23213275d963c8cf04dfc0089` in merge commit
  `ae6d62a2e2c7e67165db76756a39ee75cf847eef`.
- Replaced the four Lane A/C future-command placeholders with exact local Vitest commands for
  Discussion/Team, DeviceSession, team budget/conflict, and remote pairing/scope/revoke/step-up.
  `qa016-long-running-dogfood` and `qa018-tool-reports` remain the only future/external command
  bindings. The matrix and requirements byte digests are respectively
  `98c421b1b0b6b084cbd2cd29e5d1fe54a81bfdb102885e399f2b4fa87671b6fb` and
  `5c870551a16a4efd9ae7643a1693ee22e5ae603451c08474f7d87692279d85ec`.

## Evidence

- Environment: Node `22.20.0`, npm `10.9.3`; `.env`, `.env.local`, `web/.env`, and
  `web/.env.local` were absent.
- The current-base quality contract passed with the integrated 52-file state-machine inventory
  digest `ebed304b129292f7a5b6a0fc65479119f2a1dfb30ea5160ec0f5d83c48ced981`.
- Packaging/QA-018 focused suite: 6 files / 67 tests passed. QA-014 harness suite: 1 file / 25
  tests passed. The four new exact bindings independently passed 17, 38, 15, and 65 tests with
  zero failed, pending, skipped, or todo cases.
- Root and web TypeScript and production builds passed. Root and web moderate-level audits each
  reported zero vulnerabilities. Gitleaks `8.30.1` scanned 500 commits / 15.71 MB with zero
  findings; `.gitleaksignore` remained byte-stable at SHA-256
  `be6c34f8fba63729c35ebffcfdf032aa93577a334b957daccbc818953f379f07`.
- A clearly non-candidate exact-stack package rehearsal produced byte-identical packs at SHA-256
  `f7a16eb67fa7577b79ab045add645646ff6d13b0f388c1dbf1e1d2ad7eff3deb`
  (1,207,466 bytes). The local rehearsal passed and the release gate correctly remained
  `incomplete`: no distinct signed prior artifact/evidence bundle was supplied.
- Exact desktop QA-014 capture failed closed before any viewport completed because a fixture event
  request returned HTTP 429. Source/build binding passed at failure. The retained diagnostic has
  internal digest `e6eb5ec2ff1a49595ded8b1b5c9516acacf35c363e074444cfdfdff3371d734f`
  and file SHA-256 `505460c8d5be53198560c21ea635ab4c04d926caccba7063bce106dc45f6c136`.
- GitNexus classified each staged merge slice LOW or MEDIUM with no unexpected affected process.
  `graphify update .` refreshed the code graph to 10,638 nodes / 25,027 edges / 417 communities.
  Graphify explicitly reported that the final combined tree still needs the semantic documentation
  update; that must run after Lane B and the remaining central slices are present.

## Remaining

- This stack is based on central `36f3602`, which does not contain the accepted Lane B marker.
  The final integrator must merge Lane B and then re-run the quality discovery digest, exact
  command evidence, browser capture, package source/secret fingerprints, and all combined suites.
- QA-014 remains open: desktop is fatal, tablet/phone were not attempted, and the in-app Browser
  was not exercised. QA-016 long-running production dogfood remains open.
- Production QA-018 remains open because the checked-in trust-root list is intentionally empty and
  there is no externally signed exact-final manifest/receipt. No test-local key may close it.
- The package rehearsal is not the retained candidate. Final packaging must use one artifact from
  the clean exact final central commit and a distinct provenance-verified prior artifact for real
  upgrade/rollback evidence.
- Provider-native, clean macOS/Linux, remote-device, public CI, approval, version, tag, npm and
  GitHub-release gates remain outside this checkpoint. Stable promotion remains prohibited.

## Final integration seams

- Recompute the digest-pinned quality requirements/matrix and state-machine inventory after Lane B,
  metrics, or QA-016 changes; never carry these exact-stack hashes forward by assumption.
- Revalidate `scripts/artifact-secret-scan-reviewed.json` against the final generated bundle,
  because later UI/runtime integration can move the reviewed line.
- Build QA-018's five-slice exact manifest from final ancestry, capture raw GitNexus/Graphify
  evidence, and stop for human public-key/signature review.
- Re-run QA-014 on the final App/navigation/runtime composition; this harness changes no product UI
  and its current HTTP 429 is an open product/fixture stability condition, not a passing matrix.

## Superseding central integration observation — 2026-08-02

Exact code integration `58fc112a94c2253dd04f2ba617a6477b11d3d966` contains the accepted
Lane B work, packaging/QA stack, bounded QA-016 marker, integrated PKG-017 diagnostics/support
slice, and accepted live metrics slice. This supersedes the historical missing-Lane-B and
missing-slice observations above; it does not promote any rehearsal tarball to a retained
candidate.

Final exact-head QA, fresh QA-014/QA-015 capture, long-running QA-016 dogfood, signed QA-018
evidence, a distinct signed prior artifact, clean-OS lifecycle evidence, provider-native
acceptance, and all public/version approval gates remain open.
