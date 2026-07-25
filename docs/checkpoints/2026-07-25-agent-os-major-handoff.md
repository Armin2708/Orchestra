# Agent OS Major Handoff — 2026-07-25

Status: safe multi-agent checkpoint. The verified integration branch is preserved, every worker
has stopped at a clean commit boundary, and the three release-blocker fixes are ready for controlled
integration. The product is not yet public plug-and-play.

## TL;DR

- Integration branch: `codex/northstar-program`
- Verified integration head: `8ae2eeb`
- Strict backlog reconciliation: **106 / 373 delivered; 267 open**
- Verified integrated baseline: **97 test files / 596 tests**, root/web TypeScript, root/web
  production builds, and desktop/phone Playwright acceptance
- Ready but not integrated: projection privacy/redaction, recoverable lifecycle auditing, and
  durable Codex approval outcomes
- First action after handoff: integrate the three blocker commits, resolve their known overlap,
  then rerun the complete combined release gate before advancing the backlog

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

## Completed blocker fixes awaiting integration

| Fix | Commit and clean worktree | Delivered | Observed evidence | Integration risk |
|---|---|---|---|---|
| Safe transcript projection | `555c869` in `/Users/arminrad/Desktop/agentboard-redaction-fix` | Safe text remains visible; credential-shaped text is redacted before storage/search/API/UI/export; reasoning is genuinely withheld; migration 010 repairs legacy projections | 600/600 tests; root/web TypeScript and builds | HIGH shared transcript-write boundary |
| Recoverable lifecycle auditing | `f2c6b8f` in `/Users/arminrad/Desktop/agentboard-lifecycle-audit-fix` | Caller idempotency is reserved before provider effects; applied effects and audit completion recover without reinvoking providers or falsely reporting failure | 22 focused tests; TypeScript; clean diff | HIGH aggregate lifecycle surface |
| Durable Codex approval outcomes | `b794d80` in `/Users/arminrad/Desktop/agentboard-codex-approval-audit` | Durable request/routing/decision chain for automatic, operator, timeout, shutdown, and failure outcomes; replay dedupe/cache; fail-closed persistence | 65/65 tests; TypeScript; Codex protocol 0.144.6; independent approval | CRITICAL central request/stop paths |

The redaction and approval commits overlap in `src/agent-os/codex-native-events.ts` and its tests.
Do not resolve this mechanically. Preserve the redaction boundary and verify that managed
`os_events` never retain raw approval parameters. Re-run GitNexus impact before editing overlapping
symbols and warn before proceeding with any HIGH or CRITICAL change.

## Controlled integration order

1. Integrate `f2c6b8f`.
2. Integrate `555c869`.
3. Integrate `b794d80`, resolving the known Codex event/test overlap against the redaction rules.
4. Run focused migration, lifecycle, native-event, approval, API, search/export, and UI tests.
5. Run the complete serial Node 22 gate, root/web TypeScript, root/web production builds, and
   browser acceptance at desktop and phone widths.
6. Run GitNexus `detect_changes` against `main`, perform an independent regression/security review,
   and update Graphify, the master backlog, and the Vault only from observed combined evidence.

These commits were intentionally left separate at this checkpoint: each worker proved its own
slice, but no claim has been made that the combined train passes until the integration gate above
is observed.

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
  sets `features.multi_agent_v2.max_concurrent_threads_per_session = 8`, the schema supported by
  the installed Codex CLI `0.144.6`.

## Remaining north-star critical path

After the blocker integration gate:

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
Verify the integration branch, blocker worktrees, environment, and GitNexus state first.
Integrate the three checkpointed blocker commits in the documented order, run the combined gate,
then continue the dependency-ordered master backlog with up to eight bounded parallel workers.
Always report Asked, Deliverables, Evidence plan before work and Delivered, Evidence, Remaining
after work.
```
