# Beta Lane D — deterministic quality matrix

## Asked

Build the independent QA slice for `QA-001`, `QA-009`–`QA-012`, `QA-016`, and `QA-018` without
claiming coverage for Lane A/C domains that are not present on the base revision.

## Delivered

- A machine-readable beta requirement inventory at `docs/quality/beta-quality-matrix.json` that is
  independently constrained by a digest-pinned manifest and evidence schema. It cannot delete,
  rename, add, or flip a case to `covered` without failing the gate.
- A current-base contract verifier and fail-closed exact-head release gate at
  `scripts/check-beta-quality-matrix.mjs`, plus an external evidence runner at
  `scripts/run-beta-quality-evidence.mjs`.
- Negative transition-matrix prerequisites for Job Market, organization membership, and the
  Delivery Report SQLite trigger. These do not claim exhaustive positive service-lifecycle proof.
- Broad source discovery for state/status types, transition constants/functions, lifecycle/state
  machine classes, SQL transition triggers, and transition rejection guards. Every discovered
  file must be classified; evasion fixtures prove all five discovery forms fail closed.
- Exact commit/blob binding for source and test artifacts, exact command argv, SHA-256-bound Vitest
  JSON results, and release-time command reproduction. Comments and substring anchors are not
  accepted as evidence.
- Exact-commit, digest-bound external GitNexus and Graphify report envelopes. No checkpoint prose
  satisfies `QA-018`.
- Seven exact, commit/path/rule/line Gitleaks fixture fingerprints (two generic idempotency-key
  false positives and five historical occurrences of intentional PEM-redaction fixtures); no path-, rule-, or commit-wide
  allowlist was introduced.

## Evidence

- GitNexus impact: `JobMarketService.transition` and `OrganizationService.transitionMembership`
  were LOW risk. `DeliveryReportService.submit` and `verify` were HIGH risk, so this slice did not
  modify either production symbol.
- GitNexus detect_changes: LOW risk; one tracked test constant, zero affected execution flows.
- Graphify update: refreshed the worktree code graph to 7,066 nodes, 16,995 edges, and 264
  communities. The final integrator must perform the semantic documentation refresh after all lane
  checkpoints are assembled.
- Current-base gate: `node scripts/check-beta-quality-matrix.mjs --mode current-base` validates the
  immutable inventory and classifies every entry as a prerequisite or lane dependency.
- Release gate: `node scripts/check-beta-quality-matrix.mjs --mode release --evidence-report ...`;
  this intentionally fails without exact-head external artifacts and all required case results.
- Focused affected-surface gate after P1 remediation: 13 files / 129 tests passed.
- Root/web TypeScript and production builds passed on Node 22.20.0/npm 10.9.3.
- Gitleaks 8.30.1 scanned 564 commits / 16.22 MB with no findings; `.gitleaksignore` retained the
  same SHA-256 before and after the guard test and scan.
- Default-parallel repository gate: 187 files / 1,697 tests passed; two unrelated 5-second timeout
  cases failed under host contention, then passed directly as 2 files / 17 tests. The QA matrix
  itself is 3 files / 6 tests green and no longer exceeds the parallel timeout.

## Remaining

- `QA-001` remains open globally: current negative/transition tests are prerequisites, while Lane A
  and C must add and classify their new state machines and guards.
- `QA-009` and `QA-010` remain prerequisites until an exact-head evidence runner report reproduces
  their declared commands; existing test source is not itself execution evidence.
- `QA-011` and `QA-012` remain lane-dependent on Team/conflict and DeviceSession controls.
- `QA-016` remains open. Current daemon/provider interruption tests are prerequisites, not the
  requested long-running daemon/provider/network dogfood scenario.
- `QA-018` remains open until every lane and the integrator supplies machine-verifiable,
  exact-commit GitNexus and Graphify reports with validated digests.

## P1 remediation marker

Reviewer findings about mutable case lists, prose/substrings as evidence, narrow discovery,
overstated `QA-016` dogfood, and prose-only `QA-018` evidence are remediated in the commit following
`7f63f89`. The release gate now stays red unless an external exact-HEAD evidence directory contains
reproducible Vitest JSON, Git blob digests, and digest/commit-bound GitNexus and Graphify reports.
The code-only Graphify refresh observed 7,173 nodes / 17,134 edges / 279 communities, but that
observation does not close `QA-018`. Exact branch-history Gitleaks (`--log-opts HEAD`) scanned 382
commits / 9.33 MB with no findings, and the allowlist checksum remained unchanged.

## P1 fail-closed evidence remediation

- The SHA-256 pin now covers the complete matrix bytes, so changing any item, case, status, lane,
  or command binding fails even when the replacement command is known and passing.
- State-machine discovery now recognizes enums, lowercase transition maps, arrow transitions,
  workflow classes, and `setStatus`/`setState` methods. This regex discovery is advisory and does
  **not** establish exhaustive `QA-001` completeness; nevertheless, every discovered candidate is
  digest-bound and an unclassified candidate fails the gate.
- `QA-018` requires separately keyed Lane A, B, C, D, and integrator GitNexus and Graphify files.
  Their semantic schemas bind lane and commit, require useful impact/change or update fields, and
  require zero unresolved P0/P1/P2 findings. The integrator pair must match exact HEAD; lane pairs
  must identify commits that are ancestors of it.
- Evidence/log/tool paths must resolve inside the retained evidence directory, including through
  symlinks. Malformed JSON and schema violations produce structured failures, and command
  reproduction uses only the repository-local Vitest executable from the digest-pinned argv.

All 37 cases remain open as prerequisites or lane dependencies. In particular, this remediation
does not close `QA-001`, `QA-016`, or `QA-018`; the final integrator must produce and retain the
exact-head evidence set after all lane commits are integrated.

Verification used Node 22.20.0/npm 10.9.3: the current-base gate passed, the focused matrix suite
and strict allowlist suites passed 17/17 tests, and the affected QA surface passed 36 suites / 170
tests with zero pending,
skipped, or todo tests. Root/web TypeScript
checks and production builds passed. GitNexus classified the nine-file staged change as LOW risk
with zero affected processes. Graphify refreshed the code graph to 7,214 nodes / 17,186 edges /
273 communities; this code-only refresh is not a semantic `QA-018` report. `npm audit
--audit-level=high` passed while still reporting two existing moderate transitive findings.

## Final raw-receipt and runner hardening

- `QA-018` now has a reviewed-verifier implementation path, but remains open in production. The
  runner accepts only one externally prepared v2 integration manifest and one detached QA-only
  receipt. It rejects legacy per-lane flags and emits no `QA-018` case results unless the checker
  independently verifies the signature, exact Git history, complete slice inventory, raw evidence,
  risk dispositions, and zero unresolved P0/P1/P2 findings.
- The receipt contract retains raw GitNexus impact and `detect_changes` output plus raw Graphify
  update output, captured status, graph, and manifest artifacts. Every exact request, tool version, base, range,
  marker, commit, path, and output digest is explicit. The checker recomputes retained hashes and
  validates raw semantic fields rather than trusting receipt summary counts.
- GitNexus request envelopes preserve the configured MCP method names, camelCase impact arguments,
  and explicit repository/worktree identity. Graphify 0.8.39 has no `status` subcommand, so the
  contract retains raw `graphify update .` stdout and uses the pinned project-owned
  `scripts/capture-graphify-status.mjs` command to bind exact HEAD and graph/manifest byte digests.
  It never accepts fabricated output from a nonexistent `graphify status` command.
- A separately pinned v2 integration-manifest schema binds Lane A, B, C, D, and the integrator as
  an exact five-slice inventory. Each slice identifies its source checkpoint, every accepted
  remediation checkpoint, final accepted commit, both tool-report byte digests, the digest of its
  exact requests, and every raw-artifact path/digest. Arbitrary ancestors and marker substitution
  are not accepted. Lane ready commits remain external inputs until final integration.
- The checker verifies the manifest against Git itself: every source/remediation commit must exist,
  descend from `0dd3dd4`, be ordered monotonically, be an ancestor of exact integrator HEAD, and
  contain the lane-specific marker in its real subject/body. HIGH/CRITICAL impact results require
  one signed independent-review disposition bound to the exact request and accepted checkpoint.
- `scripts/beta-quality-signature.mjs` verifies a detached Ed25519 receipt over a domain-separated
  canonical attestation. It binds purpose, repository, exact manifest byte digest, integrator HEAD,
  signing time, and `qa-018-evidence-only` scope. Signer identity comes only from the pinned public
  trust root; a receipt cannot self-name its signer. Both manifest and verifier enforce
  `public_release_authorized: false`.
- `scripts/beta-quality-trust-roots.json` intentionally contains zero production keys. No private
  key, signing command, environment override, CLI trust override, or generated signature exists in
  this repository. Production verification therefore fails closed and `QA-018` remains open until
  a human supplies and reviews the public trust input and matching detached signature described in
  the release operations guide. Ephemeral Ed25519 keys are used only inside adversarial tests.
- Vitest evidence now requires `passed === total` and zero failed, pending, skipped, and todo tests
  in both retained JSON and the release rerun.
- Evidence creation requires a fresh mode-0700 directory outside the repository by realpath. It
  rejects symlink path components and pre-existing outputs; files are created mode 0600 through
  exclusive temporary writes and atomic hard-link publication, which cannot follow or overwrite a
  pre-existing symlink.
- Malformed contract, evidence, receipt, and tool payload shapes return structured failures. The
  focused adversarial suite now covers these constraints; all 37 matrix cases remain open.
- Full-ref Gitleaks review found one new generic-key false positive: the literal
  `idempotency-key` header at `test/session-tool-routes.test.ts:83` in commit `3c79b69`. Only that
  exact commit:path:rule:line fingerprint was added; the strict allowlist test and the 621-commit
  `--all` scan both pass with zero findings.

## QA-018 verifier upgrade checkpoint

The mechanism is implemented without claiming the gate. Its adversarial suite covers empty
production trust, valid test-local Ed25519 verification, unknown/revoked keys, signature and
manifest tampering, wrong repository/base/HEAD/scope, attempted public-release authorization,
artifact traversal/symlinks/digest changes, remediation-marker substitution, missing signed
HIGH/CRITICAL dispositions, and unverified QA-018 case injection. The exact final integration
manifest and human signature do not exist yet, so all five QA-018 matrix cases remain open.

## Integrated Lane A/C command binding addendum

The Lane D stack based on central `36f3602` replaces the four Lane A/C future placeholders with
exact integrated Vitest commands. Discussion/Team, DeviceSession, team budget/conflict, and remote
pairing/scope/revoke/step-up commands independently passed 17, 38, 15, and 65 tests. This closes
the placeholder-binding gap only; the cases remain exact-evidence prerequisites until the final
clean-head runner reproduces them. QA-016 long-running dogfood and production-signed QA-018 remain
open, and Lane B is not part of this stack checkpoint.
