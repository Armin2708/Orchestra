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
