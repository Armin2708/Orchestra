# Agent OS Migration Controls and Rollback Contract

Status: **BASE-007 definition delivered**. This contract defines the feature controls and rollback
points for every Agent OS phase. It does not claim that reserved controls or unfinished phases are
implemented.

The machine-readable source is
[`agent-os-migration-controls.json`](./agent-os-migration-controls.json). Tests enforce its phase
coverage, control lifecycle, source bindings, remote kill-switch split, rollback completeness, and
package inclusion.

## TL;DR

- All 19 phases, including explicitly deferred phase 18, have a named control and rollback point.
- The matrix declares 44 controls: **2 wired runtime flags, 6 release gates, and 36 reserved
  controls**.
- `reserved` is a stable control name and rollout contract, not a runtime feature or support claim.
- Every control defaults closed. A new phase is enabled one bounded cohort at a time only after its
  exact activation gate passes.
- Schema changes remain forward-only. Turning a flag off never performs a down migration or deletes
  canonical data.
- Rollback never silently changes provider, billing mode, workspace, assignment, authorization, or
  device identity.
- Remote pairing, device auth, scoped mutation, public tunnel, terminal write, push, and the
  emergency kill switch are independent controls.

## Control states

Each control moves through one monotonic lifecycle:

| State | Meaning |
|---|---|
| `reserved` | Name and rollback contract are frozen; no runtime binding exists |
| `wired_off` | A real binding exists and defaults disabled |
| `canary` | Enabled only for a bounded, attributable cohort |
| `default_on` | Enabled by default after complete acceptance and rollback evidence |
| `retire_pending` | Compatibility use is measured at zero; rollback evidence is retained |
| `retired` | Compatibility control is removed only after the supported observation window |

`implementation_state` is separate:

- `wired` names a real binding and source-backed test;
- `release_gate` blocks promotion but is not a runtime environment variable;
- `reserved` is intentionally unwired and must fail closed until implemented.

No reserved name may be treated as an accepted provider, available route, enabled UI, writable
schema, or release claim.

## Activation order

Every phase follows the same sequence:

1. Pin an exact source commit and record schema and compatibility state.
2. Create a backup and prove it can be restored before enabling durable writes.
3. Enable one control for a bounded canary cohort.
4. Compare privacy-safe counts, mismatches, failures, and latency against the compatibility path.
5. Pass API, CLI, UI, provider, restart, and rollback gates before default-on.
6. Remove compatibility behavior only after supported-window use reaches zero.

An operator changes one control at a time. The audit record includes actor, exact commit, previous
and next state, reason, cohort, timestamp, and verification result. It never stores a credential,
raw provider payload, terminal input, discussion content, or knowledge chunk merely to explain a
flag decision.

## Phase matrix

The JSON contains each exact trigger, action, verification, telemetry set, and data policy. This
table is the human index.

| Phase | Controls | Activation boundary | Rollback point |
|---|---|---|---|
| 0 — Baseline | `baseline.contract_gate` | Exact baseline reproduces tests, builds, package smoke, inventory, and dirty-checkout exclusions | Last reviewed baseline commit and retained evidence |
| 1 — Domain ledger | `domain.canonical_ledger` | Schemas, backfills, causal metadata, integrity, projections, upgrade, and restart pass | Pre-write backup and last compatible app commit |
| 2 — Orchestration | `orchestration.canonical_launch` | Board/CLI/API create one frozen lifecycle and idempotent dispatch | Exact pre-canary commit and database backup |
| 3 — Agent Home | `agent_home.canonical_surface` | History, events, controls, forks, retention, export, restart, and redaction pass | Pre-default backup and replay/export evidence |
| 4 — PTY/workspace | `terminal.session_binding` | Shell, cwd/worktree, signals, geometry, reconnect, tools, history, and mobile view-only pass | Last proven PTY/workspace build |
| 5 — Job Market | `job_market.publish_and_match` | Validation, Open Work, matching, assignments, dependencies, and exactly-one-job pass | Last compatible contract/assignment schema and backup |
| 6 — Delivery | `delivery.canonical_review` | Criteria, commands, hashes, review, revision, override, and shipped records pass | Last accepted schema and immutable evidence snapshot |
| 7 — Knowledge | `knowledge.ingest`, `retrieve`, `compile`, `inject` | Each stage passes provenance, freshness, redaction, ranking, budget, citation, and benchmark gates | Content-addressed snapshot before each stage |
| 8 — Discussions | `discussions.read`, `write`, `promote` | Trees, states, answers, search, subscriptions, provenance, permissions, loop prevention, and review pass | Last verified schema and accepted-answer export |
| 9 — Teams/conflicts | `teams.plan`, `delegate`, `conflicts.enforcement` | Explicit members, budgets, proposals, synthesis, conflict evidence, override, and integrated delivery pass | Independent pre-team job/assignment snapshot |
| 10 — Tools/providers | Four provider route controls plus `tools.permission_policy` | Exact provider tuple and tool/permission evidence pass independently | Last accepted tuple, matrix digest, source commit, and adapter |
| 11 — Command center | Navigation and canonical-detail controls | Navigation, deep links, search, states, layouts, accessibility, and terminal controls pass | Last verified Board/Agent Home navigation build |
| 12 — Analytics | `analytics.capture`, `analytics.display` | Attribution, privacy, budgets, quality-aware benchmarks, and calculations pass | Pre-capture schema and pre-dashboard aggregates |
| 13 — Remote/mobile | Seven independent remote controls | Pairing, device auth, scopes, tunnel, write, push, offline, revoke, abuse, platform, and accessibility pass | Local-only build, credential inventory, cache version, and tunnel state |
| 14 — Operations | Backup/restore, retention, diagnostics, and security controls | Recovery, backup, auth, rate limits, diagnostics, capacity, shutdown, and security pass | Restore-tested state backup and last supported package |
| 15 — Quality | `quality.north_star_gate` | Complete exact-commit test, review, package, provider, platform, and dogfood evidence passes | Last retained complete green evidence bundle |
| 16 — Packaging | First-run, public-artifact, and telemetry-consent controls | Clean lifecycle, onboarding, docs, privacy, and support workflow pass from retained artifact | Last retained package and compatible data range |
| 17 — Release | `release.beta`, `release.stable` | Exact artifact, providers, platforms, security, dogfood, diagnostics, support, and staged criteria pass | Previous provenance-verified release and rollback drill |
| 18 — Deferred | `deferred.scope` | A new decision supplies prerequisites, budget/threat analysis, controls, and evidence | Stable core release before admitted deferred work |

## Currently wired flags

Only these two phase-migration environment flags exist today:

| Flag | Default | Scope | Source evidence | Rollback |
|---|---|---|---|---|
| `ORCHESTRA_CANONICAL_LAUNCH=1` | off | Routes the compatibility Board launch through canonical orchestration | `src/server.ts`; `test/orchestration-route-guards.test.ts` | Unset it for new Board launches; preserve and drain existing canonical jobs under frozen identity |
| `ORCHESTRA_CODEX_PROVIDER_CONTRACT=1` | off | Opts new Codex sessions into the exact source-commit provider-contract route | `src/daemon.ts`; `test/daemon.test.ts` | Disable only new Codex contract routing; never substitute provider/billing and never mutate acceptance evidence |

The Codex control also requires an exact
`ORCHESTRA_PROVIDER_CONTRACT_SOURCE_COMMIT`. A flag alone cannot bypass manifest, executable,
platform, billing, capability, or eight-gate matrix checks.

`ORCHESTRA_NO_AUTH`, `ORCHESTRA_AUTOWAKE`, `ORCHESTRA_AUTOSHIP`,
`ORCHESTRA_VERBOSE_RULES`, and `ORCHESTRA_VERBOSE_OUTPUT` are explicitly excluded from the
migration matrix. They are development or behavior controls and cannot serve as authority,
schema, provider, or release rollback.

## Remote kill-switch split

The remote threat model requires independent controls, all reserved and off:

- `remote.pairing`
- `remote.device_auth`
- `remote.scoped_mutation`
- `remote.public_tunnel`
- `remote.terminal_write`
- `remote.push`
- `remote.kill_switch`

An emergency rollback activates the kill switch, stops only verified Orchestra-owned tunnels,
revokes device credentials/streams/grants/push subscriptions, purges authenticated cache state,
and returns terminal access to view-only. The local loopback operator recovery path remains
available. Rollback never restores the reusable master-token QR or treats a DeviceSession
credential as the operator master bearer.

## Durable data rules

Feature rollback and data recovery are different operations:

- flag rollback stops new use of a surface and selects an already-compatible route;
- schema is forward-only and remains readable by the declared compatibility range;
- canonical records and accepted evidence remain available for diagnosis;
- backup restore is explicit, offline, integrity-checked, and separately audited;
- active work drains or stops under its original frozen identity;
- forgetting, superseding, retention, revocation, and destructive cleanup remain explicit commands.

A phase with no safe compatibility path fails closed for new mutations and stays readable. It does
not silently fall back to a different provider, billing mode, workspace, assignment, credential,
or legacy authority.

## Rollback drill

Before any control reaches `default_on`, evidence must show:

1. the exact pre-activation checkpoint and backup;
2. the canary actor/cohort and one-control delta;
3. the injected rollback trigger;
4. the documented disable/kill action;
5. post-rollback API, CLI, UI, provider, restart, and integrity checks;
6. preserved canonical records, audit history, worktrees, artifacts, revocations, and credentials;
7. a new exact commit/evidence bundle before re-enabling.

The broad phase acceptance tasks remain open until their own implementation and real evidence pass.
BASE-007 closes the migration-control definition gap; it does not close any runtime phase, release
gate, provider matrix, remote-security item, or rollback drill.
