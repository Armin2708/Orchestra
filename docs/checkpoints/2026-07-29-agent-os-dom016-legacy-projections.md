# Agent OS DOM-016 Legacy Projection Contract Checkpoint — 2026-07-29

Status: **delivered at one exact code head**. This checkpoint closes DOM-016 only. It does not
implement DOM-017 migrations/backfills/rollback plans, DOM-019 migration telemetry, unfinished
canonical domains, TOOL-014, BASE-010, or public release.

## TL;DR

| State | Exact evidence |
|---|---|
| Branch | `codex/dom016-legacy-projections` |
| Worktree | `/Users/arminrad/.codex/worktrees/agentboard/dom016-legacy-projections` |
| Exact base | `9af31358ed4f4ac01d77a0c0c85e4098b548db6a` |
| Exact code head | `f5df13666ccdfdf552e423a379faf60463fc6643` |
| Restart point | the isolated branch commit containing this checkpoint |
| Required toolchain | Node `22.20.0`; npm `10.9.3`; no project `.env` file was present or assumed |
| Backlog truth | **136 / 375 delivered; 239 open**; Phase 1 is 18 / 20; TOOL-014 and BASE-010 remain open |
| Exact tests | direct: 1 file / 4 tests; serial and default: 156 files / 1,236 tests PASS |
| Product status | Engineering preview; no schema, write path, route, response, UI, provider support, or release state changed |

## Delivered

- `src/agent-os/compatibility-projection-contract.ts` defines one immutable, versioned DOM-016
  catalog covering all 13 compatibility/legacy tables in the live surface inventory.
- Each entry fixes its current authority mode, canonical table relationship, bounded legacy and
  canonical scope, explicit non-authorities, read/write boundary, target disposition, and cutover
  gate.
- The contract permits one shared scope (`boards`), one bounded compatibility authority
  (`task_contracts`), three scope-partitioned bridges, one projection sink, one legacy-event
  ingress, and six isolated legacy domains.
- The design forbids last-write-wins reconciliation and stale-projection promotion on rollback.
- `docs/agent-os-compatibility-projections.md` names the exact field/lineage splits, deliberately
  distinct legacy semantics, and DOM-017/DOM-019 handoff.
- This slice creates no SQLite view or migration and changes no current writer. Physical
  cutover/backfill/validation/rollback belongs to DOM-017; usage and mismatch measurement belongs
  to DOM-019.

## Exact evidence

- Direct projection contract: 1 file / 4 tests PASS.
- Contract plus source-controlled inventory/documentation: 5 files / 20 tests PASS.
- Complete one-worker suite: 156 files / 1,236 tests PASS.
- Complete default-parallel suite: 156 files / 1,236 tests PASS.
- Root and web strict TypeScript PASS.
- Root and web production builds PASS.
- Changed-diff Gitleaks and `git diff --check` PASS.
- GitNexus staged detection was LOW: 2 new files, no indexed changed symbols, and no affected
  process.
- The required comparison to `main` remained CRITICAL because it covered the accumulated Agent OS
  train: 105 files, 139 indexed changed symbols, and 55 affected symbols/process entries.
- The existing `LegacyEventProjection` measured MEDIUM (3 direct dependents, one Agent OS plugin
  flow) and was intentionally not modified.
- Browser screenshot acceptance is N/A because DOM-016 changes no rendered UI or response shape.

The first complete attempt had 153 passing files / 1,213 passing tests and three import-only suite
failures because the fresh worktree did not yet have `web/node_modules`. Installing the locked web
dependency tree resolved the prerequisite; both complete modes then passed without a source
change.

## Authority and rollback contract

- `boards` remains one shared project-scope anchor; no second Agent OS board identity is created.
- Adopted Agent OS identity/session, managed assignment/execution/delivery, causal events, and
  normalized usage evidence remain canonical in their focused tables/services.
- Unadopted Board presence and legacy-only planning/transport/telemetry stay explicitly isolated;
  they are not relabeled as finished Agent OS domains.
- Compatibility commands write canonical state first only after DOM-017 implements and validates
  that adapter. A projection can never win over canonical state because it is newer.
- Rollback selects a retained compatible read route and preserves canonical writes. It never runs
  an automatic down migration, guesses an ambiguous backfill, or restores a stale table as
  authority.

## Remaining

- DOM-017 and DOM-019 remain open in Phase 1.
- DOM-017 is the next dependency-ready item.
- Discussions/Q&A, Teams/conflicts, secure DeviceSessions, and KNO-003 onward remain open in their
  own phases.
- TOOL-014 still needs exact real-provider acceptance; BASE-010 still needs the exact expanded
  provider compatibility matrix.

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
4. Resume TOOL-014 only when clean-profile authentication is available; otherwise continue
   DOM-017.
5. Run GitNexus impact before every existing-symbol edit and `detect_changes` before every commit.
6. Keep physical-view, migration, telemetry, TOOL-014, BASE-010, provider, and public-release
   claims open until their exact gates pass.
7. After meaningful changes, update Graphify and the Obsidian project notes, then rerun complete
   verification and preservation checks.

## Paste-ready resume prompt

```text
Resume the Agentboard Agent OS program from:
/Users/arminrad/.codex/worktrees/agentboard/dom016-legacy-projections/docs/checkpoints/2026-07-29-agent-os-dom016-legacy-projections.md

Read AGENTS.md and the checkpoint first. Preserve the dirty shared main checkout and continue the
earliest dependency-ready Agent OS backlog item from branch codex/dom016-legacy-projections.
DOM-016 is evidence-complete at 136/375 delivered. TOOL-014 and BASE-010 remain open pending exact
real-provider evidence; continue DOM-017 while provider authentication remains unavailable.
```
