# Beta Lane D — outcome analytics candidate

## Asked

Implement the independently shippable MET-002–MET-016 foundation without modifying shared
runtime, migration, route-composition, package, release, or authoritative backlog files. Token
reduction must never pass when verified delivery quality declines, and MET-GATE must remain open
without observed representative evidence.

## Delivered

- A focused, replay-safe schema-v3 migration with update-immutable but retention-deletable evidence,
  versioned project/team/job budgets, execution-bound one-shot confirmations, and compact team digests.
- Exact input, cached-input, output, thinking, provider-total, and context-injection attribution to
  board, optional team, canonical session, job, and derived contract revision.
- Privacy-safe exploration accounting: callers supply a resource identity, but only a per-install
  keyed HMAC is persisted or returned; legacy unkeyed digests are re-keyed during schema upgrade.
- Derived accepted-delivery efficiency, cached-input ratio, context selection/reuse/rejection/
  refresh, coordination wake/fanout/model-ack, duplicate exploration, time-to-first-result,
  time-to-verified-delivery, evidence-gap/rejection/retry/override, and per-job/per-team views.
- Soft/hard budgets with cumulative fanout/planning accounting and an atomic execution-time hard
  budget recheck. Confirmation is bound to a native execution key and can be consumed once; actual
  fanout and provider/context counters cannot exceed the confirmed plan, and actual warning
  thresholds are re-evaluated before consumption.
- Canonical provider/session/job attribution, conservative billing derivation from retained
  provider-acceptance evidence, active-membership team derivation, bounded timestamps, and
  artifact-attested benchmark metrics. Provider evidence is bound by exact retained evidence ID,
  driver, adapter, mode, platform and source commit; unattested or ambiguous claims fail closed.
- One-to-one execution→usage reconciliation replaces provisional provider/context counters with
  canonical observations without double-counting, while fanout/planning counters remain durable.
- Benchmark evidence stores an immutable artifact digest, evidence version, verifier reference and
  provenance digest; every comparison revalidates the current artifact before it can pass.
- Metrics-only team digests for leader update patterns.
- A controlled before/after comparison that passes only when every paired scenario lowers tokens
  per accepted delivery while preserving quality and accepted-delivery count.
- A focused Fastify registrar and an event-driven responsive React dashboard. Mutations emit one
  payload-free `outcome_analytics` invalidation event through the inherited Orchestra bus or an
  injected publisher; the dashboard debounces that stream and introduces no snapshot poll.

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
   the authorization boundary and cannot be reused.

## Evidence

- Focused backend/service/API/UI-contract suite: 3 files, 23 tests (parallel and one-worker).
- Root TypeScript and production build pass on Node 22.20.0 / npm 10.9.3.
- Web TypeScript and production build pass on Node 22.20.0 / npm 10.9.3.
- The controlled unit suite proves the quality guard, but is not representative product evidence.

## Remaining

- Central registration and live runtime/activity producers are deliberately left to the integrator.
- Product navigation and visual browser acceptance require the final integrated App surface.
- MET-013 is proven only for this analytics dashboard; broader avoidable snapshot polling remains
  a repository-wide integration concern.
- MET-015 still needs retained exact-artifact before/after observations from a controlled task
  suite.
- MET-GATE remains open. `representative_evidence_observed` and `gate_claimed` are hard-coded false
  in the comparison response until the integrator records and reviews representative evidence.
