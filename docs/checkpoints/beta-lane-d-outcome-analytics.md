# Beta Lane D — outcome analytics candidate

## Asked

Implement the independently shippable MET-002–MET-016 foundation without modifying shared
runtime, migration, route-composition, package, release, or authoritative backlog files. Token
reduction must never pass when verified delivery quality declines, and MET-GATE must remain open
without observed representative evidence.

## Delivered

- A focused, replay-safe schema-v4 migration with an exact self-digested schema contract,
  immutable marker guards, update-immutable but retention-deletable evidence,
  versioned project/team/job budgets, execution-bound one-shot confirmations, and compact team digests.
- Exact input, cached-input, output, thinking, provider-total, and context-injection attribution to
  board, optional team, canonical session, job, and derived contract revision.
- Privacy-safe exploration accounting: callers supply a resource identity, but only a per-install
  keyed HMAC is persisted or returned; legacy unkeyed digests are re-keyed during schema upgrade.
- Derived accepted-delivery efficiency, cached-input ratio, context selection/reuse/rejection/
  refresh, coordination wake/fanout/model-ack, duplicate exploration, time-to-first-result,
  time-to-verified-delivery, evidence-gap/rejection/retry/override, and per-job/per-team views.
- Soft/hard budgets with cumulative fanout/planning accounting and an atomic execution-time hard
  budget recheck. Confirmation is bound to a native execution key and can be consumed once;
  provisional fanout and provider/context counters cannot exceed the confirmed plan, and warning
  thresholds are re-evaluated before consumption.
- Canonical provider/session/job attribution, conservative billing derivation from retained
  provider-acceptance evidence verified through the canonical content-addressed evidence store,
  active-membership team derivation, bounded timestamps, and
  artifact-attested benchmark metrics. Provider evidence is bound by exact retained evidence ID,
  driver, adapter, mode, platform and source commit; unattested or ambiguous claims fail closed.
- One-to-one execution→usage reconciliation atomically replaces provisional provider/context
  counters with canonical observations without double-counting, while fanout/planning counters
  remain durable. Signed actual-versus-provisional variance and confirmed-plan overage are retained
  and surfaced; an unlinked consumed execution makes `operationId` mandatory for canonical usage.
- Benchmark evidence stores an immutable artifact digest, evidence version, verifier reference and
  provenance digest; every comparison revalidates the current artifact before it can pass.
- Metrics-only team digests for leader update patterns.
- A controlled before/after comparison that passes only when every paired scenario lowers tokens
  per accepted delivery while preserving quality and accepted-delivery count.
- A focused Fastify registrar and an event-driven responsive React dashboard. Mutations emit one
  payload-free `outcome_analytics` invalidation event through the inherited Orchestra bus or an
  injected publisher; the dashboard debounces that stream and introduces no snapshot poll.
- A fail-closed remote-access classification synchronized to the canonical route inventory. The two
  outcome GET routes are sensitive, exact-board reads that remain denied to `DeviceSession` by
  default; all nine POST routes require the current production operator predicate and target a
  future `admin` plus step-up policy. The budget-evaluation POST is now covered by the same guard.

## Root integration

1. Call `applyOutcomeAnalyticsMigration(db)` from the central migration train.
2. Register `outcomeAnalyticsPlugin` under `/api/v1/os`, passing the existing operator predicate.
   The plugin inherits `app.bus`; an explicit `publish` adapter is also supported.
3. Export the three backend modules from `src/agent-os/index.ts` if public package access is wanted.
4. Mount `OutcomeDashboard` in the command center and pass its selected board ID.
5. At the existing normalized provider-usage seam, call `OutcomeAnalyticsService.recordUsage`
   with one deterministic provider-event ID and timestamp. Preserve each provider's declared
   `subset` versus `additive` cached-input semantics.
6. At Knowledge Compiler, coordination, exploration, first-useful-result, delivery retry, and
   override seams, record the corresponding bounded activity observation with a deterministic ID.
7. Pass a native execution key when planning work, then call `consumeOperationExecution` with the
   same key and actual projected usage immediately before execution. The transactional consume is
   the authorization boundary and cannot be reused. The provider-native usage callback must pass
   that operation's `operationId`; the first canonical observation atomically reconciles the
   provisional provider/context reservation.

## Evidence

- Focused analytics/API/runtime, baseline-documentation, and remote-threat suite passed 5 files /
  42 tests and covers all 11 outcome routes, including exact no-unclassified-route drift and
  remote-device denial before body validation.
- The broader relevant regression suite passed 14 files / 125 tests in both default-parallel and
  one-worker modes.
- Root TypeScript and production build pass on Node 22.20.0 / npm 10.9.3.
- Web TypeScript and production build pass on Node 22.20.0 / npm 10.9.3; the production build
  retains the existing advisory for a JavaScript chunk larger than 500 kB.
- Root and web `npm audit --audit-level=moderate` report zero vulnerabilities.
- Gitleaks 8.30.1 reports no findings across 759 commits or the candidate diff.
- GitNexus PDG re-index and change detection completed; its high-risk flag reflects the shared
  registrar symbol, while the inspected change is the fail-closed guard on one POST route. The
  route file has no persisted taint finding, subject to GitNexus's documented analysis limits.
- `graphify update .` refreshed the 8,305-node / 19,572-edge code graph; `graphify-out/` remains an
  untracked verification artifact and is not part of this checkpoint commit.
- The controlled unit suite proves the quality guard, but is not representative product evidence.

## Remaining

- Central registration, exact Codex provider-usage reconciliation, job-bound operation
  consumption, and provider-native child wake/fanout dispatch are integrated at
  `c25ec778febd393950829a8dae5cb7e44b102e8d` plus its review remediation. Child dispatch is
  deduplicated by durable provider child identity across `item/started`, `thread/started`, and
  `item/completed` projections.
- The live runtime does **not** yet produce exact context-injection totals (MET-002), stable-context
  selection/reuse/rejection/refresh evidence (MET-004/MET-005), file-read/duplicate exploration
  evidence (MET-007), an accepted/useful-result signal (MET-008), or model acknowledgements.
  These fields are explicitly `unavailable` in `production_signals` and the UI rather than
  reported as zero or inferred from message deltas or child dispatch.
- High-fanout planning is available only through the operator-bound plan/confirm API. There is no
  provider-native automatic high-fanout preflight producer yet, so MET-011 remains open.
- Product navigation is integrated; visual browser acceptance remains part of final combined
  verification.
- MET-013 is proven only for this analytics dashboard; broader avoidable snapshot polling remains
  a repository-wide integration concern.
- MET-015 still needs retained exact-artifact before/after observations from a controlled task
  suite.
- MET-GATE remains open. `representative_evidence_observed` and `gate_claimed` are hard-coded false
  in the comparison response until the integrator records and reviews representative evidence.
- The route classification is a conservative threat-control contract, not a claim that
  `DeviceSession`, pairing, revocation, or remote step-up is implemented. REM-GATE remains open.
