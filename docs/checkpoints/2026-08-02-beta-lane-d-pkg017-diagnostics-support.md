# Beta Lane D PKG-017 diagnostics/support integration

Exact base: `03c7a6cf84e899fddefd6f0454b1b66427993b8e`

## Asked

Connect the existing Lane C diagnostics generator to the strict support workflow so a local owner
can prepare a reviewable support case from the actual verified bytes. Preserve authorization,
consent, redaction, digest/size, path and fail-closed boundaries across the daemon, web UI and CLI.

## Delivered

- Added an independent verifier for the exact gzip bytes. It recomputes the digest, enforces
  compressed/decoded bounds, validates exact versioned schemas at every fixed nested container and
  the exclusions, and rejects Unix, home, relative, Windows, UNC, URL and credential-like retained
  content before issuing an attestation. Caller-supplied verification claims are never trusted.
- Added a local-owner-only support-case route that generates fresh diagnostics and returns one
  digest-bound JSON attachment containing the report plus the exact gzip bytes as base64.
- Added a Settings workflow and `orchestra ops support-case` command. Both require explicit local
  export/review consent; neither performs an upload or public action.
- The CLI accepts one bounded regular request file and an existing output directory, verifies the
  response digest, uses the server-generated filename, reads descriptor-first with no-follow,
  writes mode `0600` with exclusive no-follow create plus descriptor-based chmod/fsync, and refuses
  overwrite, unsafe filenames, symlink inputs/outputs and deletion of a swapped output path.
- Kept the standalone `prepareSupportCase` dependency-injection boundary fail closed and extended
  its filename contract only for the generator's real `.json.gz` format.

## Verification contract

- Positive coverage decodes an export and proves its embedded bytes equal the generated artifact.
- Adversarial coverage rejects absent consent, unknown fields, authorization failures, digest drift,
  malformed/compression-amplified data, closed-schema drift, exclusion drift, unsafe retained
  content and misleading claims. It also covers absolute/home/relative/Windows/UNC paths, nested
  unknown and mistyped fields, traversal, symlinks, canonical containment, inode changes, overwrite
  attempts and the inherited central mutation rate limit.
- Root and web typechecks/builds, complete test suites, audits, secret scanning, GitNexus change
  review, Graphify update and configuration stability must pass at the candidate commit before this
  checkpoint can be accepted.

## Candidate evidence

The earlier `7ceed609b113af6ebe2f3d43c315a9c400d33be7` candidate was rejected by independent
review (P0=0, P1=1, P2=2) and is not eligible for integration. The findings were incomplete local
path detection, open nested schemas and pathname-based file operations. The replacement candidate
must receive a fresh exact-SHA review.

- The first remediated exact review reproduced 8 focused files / 23 tests in both modes and rejected
  the candidate only for a same-inode request-growth bound and this evidence-count mismatch
  (P0=0, P1=0, P2=2). The replacement exact focused command and counts are recorded below after the
  added bounded-read regression test.
- Replacement focused verification passed 8 files / 49 tests in default and one-worker modes. The
  exact files were `support-case-export`, `support-case-cli`, `support-case-route`, `support-case-ui`,
  `operator-docs`, `operations-health-diagnostics`, `operations-metrics-capacity`, and
  `beta-quality-matrix`; each is under `test/` with the `.test.ts` suffix.
- Complete default-parallel verification: 272 files / 2,252 tests in 112.90 seconds.
- Complete one-worker verification: 272 files / 2,252 tests in 404.11 seconds. Central integration
  must still run its own complete dual suites at the combined exact head.
- Root/web TypeScript checks and production builds passed under Node `22.20.0` / npm `10.9.3`.
- Root/web audits reported zero vulnerabilities. Full-history Gitleaks scanned 797 commits with no
  findings. A clean GitNexus PDG rebuild found no persisted taint finding in the verifier, CLI or
  quality-contract script, with its documented closure/property/implicit-flow limitations.
- GitNexus remediation change review was low risk: 8 files, 48 changed symbols and zero affected
  execution flows. The broader original registration seam remains critical breadth and still
  requires independent P0/P1/P2 review before integration.
- The final bounded-read delta's generic `readRequest` name produced a conservative CRITICAL
  `detect-changes` result with 203 unrelated flows; the exact function-UID upstream impact remained
  LOW (3 symbols, 1 direct caller, 0 flows), and file-anchored PDG review had zero persisted findings
  with the limitations above. This graph-name ambiguity is disclosed rather than suppressed.
- Graphify's code update produced 10,758 nodes, 25,215 edges and 422 communities before the final
  semantic checkpoint refresh. The quality requirements now explicitly classify the verifier as a
  reviewed state-machine candidate; its discovery digest and independent immutable requirements
  pin were updated together and remained stable after focused and complete verification.

## Remaining

- This slice does not register an external support transport, publish a report, establish an SLA,
  validate public distribution or close provider/platform/release gates.
- PKG-017 can be credited as a locally actionable product seam only after exact-candidate review and
  central integration. Public support and release readiness remain open.
