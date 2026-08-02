# Beta Lane D — outcome analytics candidate

## Asked

Implement the independently shippable MET-002–MET-016 foundation without modifying shared
runtime, migration, route-composition, package, release, or authoritative backlog files. Token
reduction must never pass when verified delivery quality declines, and MET-GATE must remain open
without observed representative evidence.

## Delivered

- A focused, replay-safe schema-v6 migration with an exact self-digested schema contract,
  immutable marker guards, update-immutable but retention-deletable evidence,
  versioned project/team/job budgets, execution-bound one-shot confirmations, and compact team digests.
- Exact input, cached-input, output, thinking, and provider-total attribution to board, optional
  team, canonical session, job, and derived contract revision. Context-injection tokens have a
  separate immutable exact/unavailable receipt; absent provider-native evidence remains `null` and
  cannot silently become a zero in reconciliation or budget evaluation.
- Privacy-safe exploration accounting: callers supply a resource identity, but only a per-install
  keyed HMAC is persisted or returned; legacy unkeyed digests are re-keyed during schema upgrade.
- Derived accepted-delivery efficiency, cached-input ratio, context selection/reuse/rejection/
  refresh, coordination wake/fanout/model-ack, duplicate exploration, time-to-first-result,
  time-to-verified-delivery, evidence-gap/rejection/retry/override, and per-job/per-team views.
- Soft/hard budgets with cumulative fanout/planning accounting and an atomic execution-time hard
  budget recheck. Confirmation is bound to a native execution key and can be consumed once;
  provisional fanout and provider/context counters cannot exceed the confirmed plan, and warning
  thresholds are re-evaluated before consumption. A separate immutable operation-context receipt
  prevents the compatibility carrier zero from authorizing unknown native context. Operation
  authorization requires an exact context count; budget evaluation preserves explicit `null`, hard
  context budgets fail closed, and soft policies surface the unavailable dimension as a warning.
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
- Live immutable Knowledge Compiler receipts now drive selection, reuse, rejection, and refresh
  counts: selected build entries are selections, duplicate omissions are reuse, and other omissions
  are rejection. Refresh requires an immutable receipt tying the current use/build to the exact
  previous managed use/build; a positive injection ordinal alone is not refresh evidence.
  Estimates are never relabeled as exact context-injection tokens.
- Accepted and verified delivery timestamps now supply distinct exact job-start durations. The
  dashboard labels accepted delivery as its useful-result boundary instead of accepting an
  operator-injected generic activity as production evidence.
- Managed Claude `Read` tool-use projections now create deterministic, replay-safe exploration
  receipts. Only the already-derived input fingerprint enters analytics, where it is protected
  again with the per-install HMAC; a later identical `Read` input in the same job/session produces
  an exact duplicate receipt. Replaying a native event with a changed delivery timestamp retains
  the first observation time, and the reserved `claude-native-read:` identity namespace is rejected
  by the operator activity API. This is deliberately partial Claude coverage, not an all-provider
  or same-file-with-different-range claim.
- Board creation now emits an SSE invalidation exactly once from `/boards/resolve`. The app
  subscribes before its initial board fetch, refreshes on every stream open/reconnect, queues events
  arriving during a snapshot, and retries failed snapshots while REST is unavailable. Disposal
  guards prevent an in-flight refresh from scheduling work after cleanup; the redundant 30-second
  discovery poll remains removed. The outcome dashboard applies the same subscribe-before-fetch,
  reconnect refresh, queued single-flight retry, and disposal guarantees to its board-scoped stream.
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
6. Knowledge context metrics are read from immutable `context_uses` and
   `context_build_entries`; accepted/useful and verified timing are read from delivery reports.
   Managed Claude native capture writes exact `Read` observations. Coordination, delivery retry,
   override, model acknowledgement, and future provider producers continue to use bounded,
   deterministic activity observations only where an exact native event exists.
7. Pass a native execution key when planning work, then call `consumeOperationExecution` with the
   same key and actual projected usage immediately before execution. The transactional consume is
   the authorization boundary and cannot be reused. The provider-native usage callback must pass
   that operation's `operationId`; the first canonical observation atomically reconciles the
   provisional provider/context reservation.

## Bounded candidate checkpoint

- Status: **CANDIDATE PENDING FINAL EXACT REVIEW**, not final-central ready.
- Base: `b6dc067f7de66f7978b951d1e37ffb9c86ba9cfb`; central must integrate the accepted Lane B and
  Lane C ancestry before evaluating final-central readiness.
- Exact heads `d31bb8e`, `8837762`, and `183aa7e` were rejected by independent review and are
  superseded by the current remediation. A fresh exact candidate review must report P0=0, P1=0,
  P2=0 before this marker can become ready for central integration.

## Evidence

- Focused analytics/API/runtime/knowledge/native-Claude/UI/SSE/inventory coverage passed 9 files /
  62 tests.
  It proves exact refresh linkage, ordinal non-inference, unavailable context-token propagation,
  exact accepted-versus-verified timing, changed-timestamp replay stability, reserved native-ID
  enforcement, app and dashboard subscribe-before-fetch/reconnect/retry/disposal behavior, and
  exactly-once board-create events.
- The complete repository suite passed 240 files / 2,007 tests in both default-parallel and
  `--maxWorkers=1` modes on Node 22.20.0 / npm 10.9.3.
- Root TypeScript and production build pass on Node 22.20.0 / npm 10.9.3.
- Web TypeScript and production build pass on Node 22.20.0 / npm 10.9.3; the production build
  retains the existing advisory for a JavaScript chunk larger than 500 kB.
- Root and web `npm audit --audit-level=high` report zero vulnerabilities.
- Gitleaks 8.30.1 reports no findings across 796 commits / 30.06 MB of full-history content or the
  candidate diff.
- An exact-head GitNexus reindex maps 71 changed symbols across 20 files to seven affected execution
  flows and reports high aggregate risk, which
  is expected for this cross-runtime/API/Knowledge Compiler/App candidate. The required pre-edit
  symbol analysis identified HIGH risk for `recordActivity` and `recordNormalizedProviderUsage`
  and CRITICAL risk for shared `buildServer`; those warnings were surfaced before remediation.
  The refreshed index has no PDG taint layer, so no clean taint claim is made.
- Graphify refreshed the deterministic code graph and semantically re-extracted the three changed
  inventory/checkpoint artifacts. The verified graph contains 9,293 nodes / 22,376 edges / 326
  communities, includes schema-v6 evidence, and contains no stale schema-v4 checkpoint node.
  `graphify-out/` remains an untracked verification artifact and is not part of this checkpoint
  commit.
- The controlled unit suite proves the quality guard, but is not representative product evidence.

## Remaining

- Central registration, exact Codex provider-usage reconciliation, job-bound operation
  consumption, and provider-native child wake/fanout dispatch are integrated at
  `c25ec778febd393950829a8dae5cb7e44b102e8d` plus its review remediation. Child dispatch is
  deduplicated by durable provider child identity across `item/started`, `thread/started`, and
  `item/completed` projections.
- The live runtime still does **not** produce exact context-injection token totals (MET-002) or
  model acknowledgements. An immutable availability receipt preserves that absence through usage,
  reconciliation, dashboard, and budget projections: totals remain `null`/`unavailable`, including
  per-job and per-team views, rather than using compiler estimates, compatibility zeros, or
  provider-wide input as an inference.
- MET-004/MET-005 now have live Knowledge Compiler receipt coverage. MET-007 has exact managed
  Claude `Read` and identical-input duplicate coverage only; Codex and other providers, and
  same-file reads with changed input ranges, remain unavailable. MET-008 uses the exact human
  accepted-delivery boundary; it does not claim an earlier provider-native usefulness signal.
- High-fanout planning is available only through the operator-bound plan/confirm API. There is no
  provider-native automatic high-fanout preflight producer yet, so MET-011 remains open.
- Product navigation is integrated; visual browser acceptance remains part of final combined
  verification.
- MET-013 now covers the analytics dashboard and global board discovery. Terminal streaming,
  provider status, external Git HEAD, settings, and other independent polling remain in place
  because this slice found no equivalent event contract for those sources.
- MET-015 still needs retained exact-artifact before/after observations from a controlled task
  suite.
- MET-GATE remains open. `representative_evidence_observed` and `gate_claimed` are hard-coded false
  in the comparison response until the integrator records and reviews representative evidence.
- The route classification is a conservative threat-control contract, not a claim that
  `DeviceSession`, pairing, revocation, or remote step-up is implemented. REM-GATE remains open.
