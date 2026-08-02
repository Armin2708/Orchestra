# Beta Lane D PKG-017 diagnostics/support integration

Exact base: `03c7a6cf84e899fddefd6f0454b1b66427993b8e`

## Asked

Connect the existing Lane C diagnostics generator to the strict support workflow so a local owner
can prepare a reviewable support case from the actual verified bytes. Preserve authorization,
consent, redaction, digest/size, path and fail-closed boundaries across the daemon, web UI and CLI.

## Delivered

- Added an independent verifier for the exact gzip bytes. It recomputes the digest, enforces
  compressed/decoded bounds, validates the closed schema and exclusions, and rejects retained
  unsafe content before issuing an attestation.
- Added a local-owner-only support-case route that generates fresh diagnostics and returns one
  digest-bound JSON attachment containing the report plus the exact gzip bytes as base64.
- Added a Settings workflow and `orchestra ops support-case` command. Both require explicit local
  export/review consent; neither performs an upload or public action.
- The CLI accepts one bounded regular request file and an existing output directory, verifies the
  response digest, uses the server-generated filename, writes mode `0600` with exclusive create,
  and refuses overwrite or unsafe filenames.
- Kept the standalone `prepareSupportCase` dependency-injection boundary fail closed and extended
  its filename contract only for the generator's real `.json.gz` format.

## Verification contract

- Positive coverage decodes an export and proves its embedded bytes equal the generated artifact.
- Adversarial coverage rejects absent consent, unknown fields, authorization failures, digest drift,
  malformed/compression-amplified data, closed-schema drift, exclusion drift, unsafe retained
  content, traversal filenames and overwrite attempts.
- Root and web typechecks/builds, complete test suites, audits, secret scanning, GitNexus change
  review, Graphify update and configuration stability must pass at the candidate commit before this
  checkpoint can be accepted.

## Candidate evidence

- Post-hardening focused verification: 8 files / 20 tests in both default and one-worker modes.
- Complete default-parallel verification: 272 files / 2,246 tests at the final working tree.
- Complete one-worker verification: 272 files / 2,246 tests before the final canonical-JSON-only
  verifier hardening; the affected focused set then passed in both modes. Central integration must
  run its own complete dual suites at the combined exact head.
- Root/web TypeScript checks and production builds passed under Node `22.20.0` / npm `10.9.3`.
- Root/web audits reported zero vulnerabilities. Full-history Gitleaks scanned 792 commits with no
  findings. GitNexus PDG review reported no persisted finding in the four changed runtime/UI files,
  with its documented closure/property-flow limitations.
- GitNexus change review classified the central operations registration seam as critical breadth;
  the exact candidate therefore requires independent P0/P1/P2 review before integration.
- Graphify code update produced 10,690 nodes, 25,126 edges and 411 communities and resolves the new
  verifier/export symbols. Configuration/release-calibration files remained byte-identical to base.

## Remaining

- This slice does not register an external support transport, publish a report, establish an SLA,
  validate public distribution or close provider/platform/release gates.
- PKG-017 can be credited as a locally actionable product seam only after exact-candidate review and
  central integration. Public support and release readiness remain open.
