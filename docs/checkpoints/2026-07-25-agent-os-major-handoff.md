# Agent OS Major Handoff — 2026-07-25

> **Superseded historical checkpoint.** This document preserves the verified `1b1dfbe` /
> 106-of-373 state and must not be read as current release evidence. Continue from the
> [local Gate C and JOB-010 phase-one checkpoint](./2026-07-25-agent-os-local-gate-c-job010-phase-one.md),
> whose tested code head is `0c1323780b5f776eb419c4dabbbe42b2bcf1c0ee`.

Status: blocker integration is complete on the isolated integration branch. The combined code,
security, protocol, package, and build gates pass; current desktop/phone browser acceptance remains
open because the browser runtime exposed no usable browser. The product is not yet public
plug-and-play.

## TL;DR

- Integration branch: `codex/northstar-program`
- Verified integration head: `1b1dfbe`
- Strict backlog reconciliation: **106 / 373 delivered; 267 open**
- Verified combined code gate: **99 test files / 631 tests**, focused security/auth checks,
  root/web TypeScript, root/web production builds, package/e2e checks, pinned Codex protocol, and
  independent security review
- Integrated: recoverable lifecycle auditing (`f82ab4a`), safe transcript projection
  (`a59580d`), durable Codex approval outcomes (`883683f`), and managed-event security closure
  (`1b1dfbe`)
- Still open: current desktop/phone browser acceptance and the dependency-ordered Agent Home
  durability work

## Asked

Build Orchestra toward an Agent OS that preserves the real terminal, installed Claude/Codex CLIs,
provider-native behavior, and all existing tools while adding:

- visual, durable homes for independent agents and sessions;
- agent-to-agent coordination, discussions, planning, and conflict resolution;
- typed work contracts, an Open Work marketplace, and Asked-versus-Delivered traceability;
- repository knowledge and token-efficient context;
- safe browser and phone control;
- engineering-team handoffs that state deliverables before work and Delivered/Evidence/Remaining
  after work.

## Delivered on the integration branch

The current integration train contains:

- canonical Board/API/CLI orchestration and durable Agent OS lifecycle;
- durable provider-native Agent Home identities, conversations, replay, controls, search, export,
  exact deep links, responsive UI, and real PTY attachment;
- canonical Delivery Trackbook Asked/Delivered/Evidence contracts;
- typed Job Market criteria, verifiers, artifacts, dependencies, constraints, budgets, lifecycle,
  validation, optimistic concurrency, audit events, API, and CLI.

The source-controlled delivery summary lives in
[`docs/north-star-delivery-program.md`](../north-star-delivery-program.md).

## Integrated blocker fixes

| Fix | Integration commit | Delivered | Observed evidence | Integration risk |
|---|---|---|---|---|
| Recoverable lifecycle auditing | `f82ab4a` from `f2c6b8f` | Caller idempotency is reserved before provider effects; applied effects and audit completion recover without reinvoking providers or falsely reporting failure | Included in 99/631 combined suite | HIGH aggregate lifecycle surface |
| Safe transcript projection | `a59580d` from `555c869` | Safe text remains visible; credential-shaped text is redacted before storage/search/API/UI/export; reasoning is genuinely withheld; migration 010 repairs legacy projections | Included in 99/631 combined suite and focused security gate | HIGH shared transcript-write boundary |
| Durable Codex approval outcomes | `883683f` from `b794d80` | Durable request/routing/decision chain for automatic, operator, timeout, shutdown, and failure outcomes; replay dedupe/cache; fail-closed persistence | Included in 99/631 combined suite; Codex protocol 0.144.6 verified | CRITICAL central request/stop paths |
| Managed-event security closure | `1b1dfbe` | Raw approval parameters, credentials, Codex reasoning, and Claude thinking are excluded from managed `os_events`; migration 011 repairs legacy rows; agent tokens cannot read operator transcript/SSE surfaces | 7 files / 86 focused tests; independent security PASS | CRITICAL auth and HIGH event-persistence boundaries |

The redaction and approval overlap in `src/agent-os/codex-native-events.ts` and its tests was
resolved deliberately: visible safe transcript text, credential redaction, genuine reasoning
withholding, durable approval outcomes, and the rule that raw approval parameters never enter
managed `os_events` are all preserved.

## Observed integration closure

1. Integrated the three fixes in the required order, preserving separate commits.
2. Added the managed-event security closure after independent review found raw durable-event
   exposure paths.
3. Passed the final serial Node 22 suite: 99 files / 631 tests.
4. Passed root/web TypeScript and production builds, `scripts/e2e.sh`, `npm pack --dry-run`, pinned
   Codex protocol 0.144.6, and independent regression/security review.
5. Rebuilt the corrupt derived GitNexus index at `1b1dfbe`: 6,309 nodes, 18,102 edges, 378
   clusters, and 300 flows. The full branch comparison remains CRITICAL as expected for an
   82-file program train.
6. Refreshed Graphify after the code closure.
7. Attempted production desktop/phone browser acceptance, but the configured browser backend
   listed zero browsers. No substitute harness was used, so this gate remains open.

## Environment and repository state

- Required runtime: `/Users/arminrad/.nvm/versions/node/v22.20.0/bin/node`
- No project `.env`, `.env.local`, `web/.env`, or `web/.env.local` was present at the verified
  baseline; recheck before testing.
- Integration worktree:
  `/Users/arminrad/Desktop/agentboard-northstar`
- Primary checkout user changes remain outside the integration worktree and must not be overwritten.
- `node_modules`, `web/node_modules`, and `graphify-out` in the integration worktree are generated
  or local working artifacts, not checkpoint source.
- Agentboard-local Codex configuration:
  `/Users/arminrad/Desktop/agentboard/.codex/config.toml`
  sets `features.multi_agent_v2.max_concurrent_threads_per_session = 8`, the schema validated for
  the repository-era Codex CLI `0.144.6`. The current global CLI is `0.145.0`; protocol evidence
  was produced with an isolated `0.144.6` installation.

## Remaining north-star critical path

After the blocker integration:

1. Finish Agent Home retention/compaction, provenance-safe native fork, and the real
   daemon-mid-session-to-browser continuation gate.
2. Build Open Work, assignment/reassignment, dependency/critical-path UX, contract templates and
   capability/capacity matching.
3. Build the Knowledge Compiler with cited, fresh, budgeted repo context.
4. Build durable Discussions/Q&A, bounded Teams, planning, conflict resolution, and synthesis.
5. Add provider-neutral tools/permissions, token/outcome analytics, and the unified command center.
6. Add scoped DeviceSessions and safe browser/phone remote control.
7. Complete reliability/security/operations, deterministic quality gates, clean-machine packaging,
   onboarding, dogfood, rollback, provenance, and staged public release.

## Fork/resume brief

`fork` creates a new independent Codex chat from this saved transcript. The original chat remains
intact, while the new runtime can load the eight-worker configuration. It preserves the transcript,
not private model scratch reasoning or running subagent processes; this file carries the durable
engineering state those processes produced.

From the Agentboard checkout:

```bash
cd /Users/arminrad/Desktop/agentboard
codex fork -c 'features.multi_agent_v2.max_concurrent_threads_per_session=8'
```

Select the main Agentboard session, then send:

```text
Resume the Agent OS program from
docs/checkpoints/2026-07-25-agent-os-major-handoff.md.
Verify integration head 1b1dfbe, environment, GitNexus state, and the still-open browser gate first.
Continue the dependency-ordered Agent Home durability backlog with up to eight bounded parallel
workers, then rerun the combined gate.
Always report Asked, Deliverables, Evidence plan before work and Delivered, Evidence, Remaining
after work.
```
