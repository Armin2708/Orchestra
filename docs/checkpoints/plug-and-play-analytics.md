# Plug-and-play analytics and beta monitoring checkpoint

## Asked

Audit the automatable parts of MET-002, MET-006, MET-007, MET-011, MET-013, MET-015,
MET-GATE and REL-014 from exact beta candidate
`7c147c4ccccb11bb89850f3119cdb23859c81916`. Add real tooling without inventing provider-native
signals, elapsed beta operation, representative results, or quality-neutral token savings.

## Delivered

- A shell-free controlled outcome benchmark runner that verifies exact source HEAD, freezes task,
  provider, model, seed and command inputs, runs control before treatment, hashes both bounded
  result artifacts, and produces a digest-bound report.
- A quality guard requiring non-declining quality and accepted-delivery count before any reduction
  in tokens per accepted delivery can pass.
- A privacy-safe beta rollout monitor for install outcomes, provider errors/recoveries, token-rate
  storms, and migration outcomes. Unmatched recoveries, duplicate events, raw diagnostic fields,
  empty streams and threshold breaches fail closed.
- Packaged CLI entry points and operator documentation linked from the beta release operations
  contract.

## Evidence

- Exact environment: Node `22.20.0`, npm `10.9.3`; dependency lock installed; audit reports zero
  vulnerabilities.
- Focused new plus existing analytics/operations regression: 7 files / 41 tests passed.
- Root production build passed. Web production build passed with the pre-existing dynamic-import
  and large-chunk advisories.
- Dry-run package inventory contains both runners and both operator documents (60 files total).

## Remaining truthfully open

- MET-002: the providers still do not expose exact context-injection tokens; unavailable remains
  `null`, not zero or a compiler estimate.
- MET-006: exact child wakes/fanout are integrated, but no provider-native model-acknowledgement
  signal exists.
- MET-007: managed Claude identical-`Read` coverage remains partial; Codex and changed-range file
  reads cannot be inferred safely from generic commands.
- MET-011: the execution-bound operator confirmation system exists, but provider-native automatic
  preflight before an internally spawned high-fanout swarm remains unavailable.
- MET-013: outcome and board discovery are event-driven; independent terminal/provider/Git sources
  without an equivalent event contract remain polled.
- MET-015 and MET-GATE: the new runner is ready, but only retained representative exact-artifact
  observations can close them. Reports hard-code `representative_evidence_observed: false` and
  `gate_claimed: false`.
- REL-014: the monitor is ready, but the real named beta cohort and elapsed observation window have
  not occurred. Reports hard-code `gate_claimed: false`.
