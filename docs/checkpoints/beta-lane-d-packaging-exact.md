# Beta Lane D packaging and exact-artifact checkpoint

Status: **integration-ready implementation, not a beta release artifact or publication approval**.
Packaging implementation is based on central head
`f6718aac2e86e02dbac2e8d9b4eaee4e51d01560`; the hardening commits through
`1e270e9599db6aca697f6b7aa14da108203bd512` are ready for central integration.

## Asked

Own PKG-001, PKG-003, PKG-006, PKG-007, PKG-011 through PKG-017 and PKG-GATE as
evidence permits. Prove a reproducible package, clean-consumer lifecycle, exact-artifact
provenance, recovery assets, package links and secret scanning without publishing, tagging,
pushing, changing the approved version, or claiming external/manual gates.

## Delivered

- The pre-existing retained-artifact lane is present on the central base: one npm tarball is built,
  reproduced byte-for-byte, installed into a disposable consumer, exercised through doctor,
  daemon, web and provider-specific hook lifecycles, audited, backed up, uninstalled and retained
  for publish-boundary verification without rebuilding.
- Packaging now verifies `HEAD`, tracked cleanliness and the Git ownership of every packaged
  non-build input at the point of packing. The publish boundary requires that source identity.
  QA-019's exact-commit gate also rejects staged or unstaged tracked changes.
- Upgrade, rollback and uninstall continuity now preserves exact core entity rows, every
  pre-upgrade table and column descriptor, nondecreasing row counts, every protected primary-key
  identity, each foreign-key definition and child-to-parent relationship, and the full rows of
  tables without primary keys. Only the bounded generation-scoped
  `os_compatibility_failure_success_receipts` identities may rotate; its table and row-count
  continuity remain mandatory.
- Every artifact boundary rejects symlink, hardlink, device and FIFO archive entries before
  extraction or content reads. Packaged Markdown checking now covers shortcut reference links.
- The post-integration generated-bundle Gitleaks allowance was revalidated at exact
  `dist/cli.js:33435`: the line SHA remains
  `ef102280ca6d450064fd2d0643c0c9cd6a3acc49de602108a90a359b51a1e463`, proving the same
  assignment-replay false positive moved without changing content.
- Package version remains `0.1.0`. The beta contract requires explicit human approval before a
  prerelease version change, and the publish job remains unconditionally disabled.

## Evidence

- Environment: Darwin arm64, Node `22.20.0`, npm `10.9.3`; `.env`, `.env.local`, `web/.env` and
  `web/.env.local` absent.
- Focused package/recovery/security/doc tests: 11 files / 65 tests passed in default-parallel and
  one-worker modes. Root/web TypeScript and production builds passed; root/web production audits
  reported zero vulnerabilities.
- GitNexus before edits: `verifyPublishArtifact` LOW (one direct dependent, zero flows),
  `verifyExactCommit` LOW (two affected symbols, zero flows); newer package-lifecycle/link/tar
  symbols were unindexed and treated as an `UNKNOWN` release-boundary risk. Change detection was
  LOW/MEDIUM with no unexpected affected flow. Graphify updated to 8,531 nodes / 20,013 edges;
  clustering completed after the final meaningful code slice.
- Independent review of the earlier exact `493ba68` found P0 0 / P1 2 / P2 1 after its first
  findings were remediated: relationship/schema continuity and QA-019 evidence composition were
  still false-green, and one prior-artifact content read preceded archive entry-type validation.
  Fresh independent review of exact `1e270e9` accepted the remediation with P0 0 / P1 0 / P2 0.
  Its attack suite rejected dirty/mismatched source, untracked packed inputs, destructive primary-
  key replacement, foreign-key reassignment, dropped columns, changed unkeyed rows, missing
  QA-019 source/continuity evidence, unsafe tar entry types and missing shortcut-reference targets.
- One clearly **non-candidate** local rehearsal at exact implementation commit `1e270e9` produced
  a 943,150-byte, 54-file tarball with SHA-256
  `0ad29d5dde5981d89ce0a122bb53db88fa7c235a6edfc17b83faf55a1b0272f8`. Its second pack was
  byte-identical; source identity, installed runtime, 132-table/64-primary-key/4-foreign-key
  relationship continuity, packaged backup, uninstall preservation, Markdown links, minimal
  scripts-disabled install, zero-moderate+ consumer audit and exact artifact secret scan passed.
- The same rehearsal intentionally exited `2`: no distinct signed prior artifact/evidence was
  supplied, so `release_gate.status` is `incomplete`, top-level `passed` is false, and upgrade and
  rollback remain open. These bytes are not the final integrated candidate and must not be
  published or substituted for the future central artifact.

## Backlog reconciliation

| Item | Evidence-backed state before central reconciliation |
|---|---|
| PKG-001 | Local reproducible package implementation passes; remains open because publication and final exact integrated artifact are absent. |
| PKG-003 / PKG-006 | Central onboarding and fail-closed defaults exist; final integrated provider evidence remains required. |
| PKG-007 | Data/recovery documentation, packaged offline backup and representative lifecycle preservation pass; final Lane C restore integration remains central. |
| PKG-011 / PKG-012 | Honest remote/lost-device and troubleshooting contracts exist; Lane C secure runtime/diagnostics must be integrated before closure. |
| PKG-013 | Production-contract lifecycle demo implementation/tests exist; accepted native-provider execution remains open. |
| PKG-014 | Versioned candidate API/event/schema docs exist; exhaustive generated drift/publication gate remains open. |
| PKG-015 | Notes and automation exist; distinct signed prior artifact cross-version upgrade/rollback remains open. |
| PKG-016 | External telemetry is opt-in, enum-only, redacted and transport-inert; destination/privacy approval remains open. |
| PKG-017 | Strict support adapter exists; Lane C actual-byte diagnostics integration and operator review remain open. |
| PKG-GATE | Open: no clean personal subscriber completed the final integrated native-provider journey. |

## Provider and platform boundary

This slice makes no provider-native acceptance claim. Credentialed Claude, Codex, Qwen and Kimi
journeys remain owned by the final exact integrated provider matrix. Local Darwin arm64 package
rehearsal passed; exact clean Ubuntu/macOS lifecycle evidence for the final artifact remains
required. Windows remains unsupported.

## Remaining and rollback

- Integrate Lanes A/C plus QA-014/QA-018, then create exactly one final retained tarball from that
  clean exact central commit. Do not reuse or rebuild this rehearsal as the candidate.
- Supply a distinct prior tarball with verified exact-commit evidence and a signature rooted in a
  reviewed production trust key; run real upgrade and rollback against the final candidate.
- Run final dual full suites, clean macOS/Linux lifecycle, exact artifact audit/secret scan,
  provider-native acceptance, remote/security/browser gates and independent review.
- Human approval is required before changing `0.1.0` to a beta prerelease, enabling `npm-beta`,
  pushing, tagging, publishing, or creating a GitHub release.
- Code rollback is the removal of the packaging hardening commits before candidate creation. A
  released data rollback never down-migrates schema or deletes user data; it restores only a
  retained provenance-verified application artifact after the documented offline checks.

## Integrated-stack rehearsal addendum

The accepted packaging ancestry was merged onto central `36f3602` and rehearsed at exact stack
commit `ae6d62a2e2c7e67165db76756a39ee75cf847eef`. The local lifecycle passed and two packs were
byte-identical at SHA-256
`f7a16eb67fa7577b79ab045add645646ff6d13b0f388c1dbf1e1d2ad7eff3deb`
(1,207,466 bytes). The release gate correctly remained incomplete without a distinct signed prior
artifact/evidence bundle. These bytes are diagnostic, not the final retained beta candidate; Lane B
and the remaining central slices must be integrated before one final artifact is created.

## Central code-integration observation — 2026-08-02

The packaging ancestry is present at exact central code head
`58fc112a94c2253dd04f2ba617a6477b11d3d966` together with accepted Lanes A–C, the bounded QA-016
slice, integrated PKG-017 diagnostics/support, and live metrics. The prior rehearsals remain
diagnostic and are not the retained candidate.

Retain a candidate only after final documentation and evidence reconciliation at a clean exact
head. PKG-001, PKG-015, QA-017, and PKG-GATE remain open. Package version remains `0.1.0`, and any
version change, tag, publication, or release requires explicit human approval.
