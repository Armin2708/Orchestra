# Agent OS DOM-010 Causal Metadata Checkpoint — 2026-07-28

Status: **delivered at one exact code head**. This checkpoint closes DOM-010 only. It does not
close the remaining Phase 1 service, compatibility, idempotency-coverage, rollback-plan, or
telemetry items; close TOOL-014 or BASE-010; or make Orchestra public plug-and-play.

## TL;DR

| State | Exact evidence |
|---|---|
| Branch | `codex/dom010-causal-metadata` |
| Worktree | `/Users/arminrad/.codex/worktrees/agentboard/dom010-causal-metadata` |
| Exact base | `2f5367f35fcb6c9c77cf272637f557fb31e37efe` |
| Exact code head | `40de6d385441d3a66e4ab779d1eb3616c0b2ad87` |
| Restart point | the isolated branch commit containing this checkpoint |
| Required toolchain | Node `22.20.0`; npm `10.9.3`; no project `.env` file was present or assumed |
| Backlog truth | **132 / 375 delivered; 243 open**; Phase 1 is 14 / 20; TOOL-014 and BASE-010 remain open |
| Exact tests | direct: 1 file / 4 tests; serial and default: 149 files / 1,209 tests PASS |
| Product status | Engineering preview; no provider support, UI, production route, or release state changed |

## Delivered

- Migration `020-causal-event-metadata` adds required `actor_type` and nullable `actor_id` columns
  to `os_events`, backfills pre-existing causal identity, and records the migration atomically.
- Legacy events with a valid service-produced payload actor retain that identity. Other legacy
  events use `system` plus their bounded source where possible. Missing correlations backfill to
  the immutable event ID.
- Exact migration-owned actor, causation, session, and contract indexes make every standardized
  scope queryable. Insert/update guards reject blank, padded, or oversized actor and causal
  metadata.
- The migration safely replays after marker loss, rejects partial actor columns and altered
  migration-owned triggers, and preserves the pre-existing immutable Job Market assignment trigger
  byte-for-byte while performing its transaction-scoped backfill.
- `EventStore.append` now bounds and normalizes actor, correlation, causation, workspace, session,
  process, job, contract, idempotency, kind, and source values. Internal events default to
  `system` plus source; valid service-produced payload actors remain compatible.
- New canonical events receive their own event ID as correlation when no operation ID is supplied.
  An omitted correlation on replay reuses the original; explicit actor, correlation, or causation
  changes conflict under the same idempotency key.
- Duplicate launch validation still preserves existing option/preflight error precedence, and
  repeated provider/session terminal transitions reuse their originally stored causal pair instead
  of self-causing on replay.

## Exact evidence

- Direct migration/EventStore gate: 1 file / 4 tests PASS.
- Causal plus migration gate: 2 files / 18 tests PASS.
- Migration/home/knowledge compatibility gate: 5 files / 54 tests PASS.
- Six regression suites that exposed dependency/setup issues: 66 / 66 tests PASS after the
  compatibility fixes and isolated web dependency install.
- Complete one-worker suite: 149 files / 1,209 tests PASS.
- Complete default-parallel suite: 149 files / 1,209 tests PASS.
- Root and web strict TypeScript PASS.
- Root and web production builds PASS.
- Changed-diff Gitleaks and `git diff --check` PASS.
- GitNexus pre-edit impact correctly classified `EventStore.append` CRITICAL, `OsEvent` and the
  migration runner HIGH, `createCardJob` MEDIUM, and terminal-transition replay HIGH. Final staged
  change detection remained CRITICAL, mapping 24 changed symbols to 17 affected execution flows;
  the complete regression suite is the acceptance evidence for that shared-core scope.
- Browser acceptance is N/A because DOM-010 changes no UI or route surface.

## Compatibility and rollback boundary

- `EventStore.append` is the canonical append boundary and guarantees non-null correlation for new
  Agent OS events. Direct SQL remains a migration/projection compatibility path and is not a
  client-authoritative event API.
- Actor type is bounded to 64 characters, actor ID to 256, and causal/scope IDs to 512. Empty
  optional values normalize to null; padded whitespace and oversize values fail closed.
- Migration 020 requires migration 019 and is forward-only. Structural or data incompatibility
  aborts the surrounding migration transaction without recording the marker.
- Replaying a terminal-transition event is safe only with its original correlation and causation;
  the runtime now reads that pair before issuing an idempotent append.
- This slice does not claim that every command family has an idempotency key. That coverage remains
  owned by DOM-013.

## Remaining

- DOM-013 through DOM-017 and DOM-019 remain open in Phase 1.
- TOOL-014 still needs a real exact-source Codex matrix and the remaining declared-provider
  adapters. BASE-010 still needs the exact four-provider compatibility matrix.
- KNO-003 onward, remaining product phases, packaging, and public release stay open.
- The next independent dependency-ready backlog item is DOM-013.

## Shared-main preservation

The dirty shared checkout remains on `main` and was not reset, cleaned, switched, staged, or
committed.

- `web/src/Board.tsx` expected SHA-256:
  `e7b01cdab3709c66730f5b790f767e19bb2ddca6df0dc9fe56847c9b0bf0e0e8`
- `web/src/styles.css` expected SHA-256:
  `f54f263c6fd0f76e025b602a9f8f812d6e7e1cb4ad3e6bd8ee7f2ec5621cb2ec`

## Exact resume procedure

1. Read `/Users/arminrad/Desktop/agentboard/AGENTS.md` and this checkpoint completely.
2. Use this isolated worktree and branch; never switch or create a branch in the shared checkout.
3. Verify branch, worktree, shared UI hashes/status, Node/npm, `.env` state, and exact commit.
4. Resume TOOL-014 only when clean-profile authentication is available; otherwise continue DOM-013.
5. Run GitNexus impact before every existing-symbol edit and `detect_changes` before every commit.
6. Keep TOOL-014, BASE-010, all provider labels, and public-release claims open until their exact
   gates pass.
7. After meaningful changes, update Graphify and the Obsidian project notes, then rerun complete
   verification and preservation checks.

## Paste-ready resume prompt

```text
Resume the Agentboard Agent OS program from:
/Users/arminrad/.codex/worktrees/agentboard/dom010-causal-metadata/docs/checkpoints/2026-07-28-agent-os-dom010-causal-metadata.md

Read AGENTS.md and the checkpoint first. Preserve the dirty shared main checkout and continue the
earliest dependency-ready Agent OS backlog item from branch codex/dom010-causal-metadata.
DOM-010 is evidence-complete at 132/375 delivered. TOOL-014 and BASE-010 remain open pending exact
real provider evidence; continue DOM-013 while provider authentication remains unavailable.
```
