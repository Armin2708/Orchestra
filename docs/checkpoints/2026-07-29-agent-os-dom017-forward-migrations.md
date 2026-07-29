# Agent OS DOM-017 Forward Migration Checkpoint — 2026-07-29

Status: **delivered at one exact code head**. This checkpoint closes DOM-017 only. It does not
close DOM-019 telemetry/cutover, unfinished canonical domains, TOOL-014, BASE-010, or public
release.

## TL;DR

| State | Exact evidence |
|---|---|
| Branch | `codex/dom017-forward-migrations` |
| Worktree | `/Users/arminrad/.codex/worktrees/agentboard/dom017-forward-migrations` |
| Exact base | `f2401d2e65af413ba3320c2467d733977b155eba` |
| Exact code head | `74d632f46bfeaaead1c7a52ced8a317915baacbf` |
| Restart point | the isolated branch commit containing this checkpoint |
| Required toolchain | Node `22.20.0`; npm `10.9.3`; no project `.env` file was present or assumed |
| Backlog truth | **137 / 375 delivered; 238 open**; Phase 1 is 19 / 20; TOOL-014 and BASE-010 remain open |
| Exact tests | final complete-suite evidence is recorded below |
| Product status | Engineering preview; DOM-017 advances no writer, route, UI, provider support, reserved control, or public-release state |

## Crash recovery

- The interrupted session transcript is
  `/Users/arminrad/.codex/sessions/2026/07/27/rollout-2026-07-27T00-01-27-019fa072-8399-7f63-aba4-4176e7a50918.jsonl`.
- The final event was reasoning at `2026-07-29T07:32:51Z` during read-only DOM-017 exploration.
  There was no patch, write, commit, reset, checkout, or delete action before the interruption.
- The isolated worktree survived clean at exact base
  `f2401d2e65af413ba3320c2467d733977b155eba`; recovery reconstructed the plan from the transcript,
  backlog, DOM-016 handoff, repository, and durable Vault notes.
- The reported “70k deleted lines” is not supported by the recovered transcript or git state. It
  is consistent with a misleading cross-worktree/base diff or stale UI summary, not a destructive
  edit in this DOM-017 worktree.

## Delivered

- Migration `022-legacy-projection-forward-plan` requires migration `021`, validates exact
  prerequisite/evidence schemas, and runs inside the existing all-migrations SQLite transaction.
- One frozen executable plan covers all 13 DOM-016 compatibility/legacy tables.
- The seven movable/validated source surfaces receive deterministic link or quarantine evidence:
  shared board scope, normalized TaskContracts, usage baselines, collision-free Agent adoption,
  card authority partitions, historical card-event import, and exact review/delivery lineage.
- The six semantically distinct/deferred sources remain named legacy concepts; no Discussion,
  Team, planning domain, work Delivery, provider usage, billing record, or accepted outcome is
  fabricated.
- Three additive evidence tables retain source/target snapshot hashes, quarantine reasons, and
  validation results.
- Five validators cover count, key, scope, lifecycle, and linked-snapshot hash integrity.
- Restart and marker-loss replay are idempotent; incompatible schemas and changed linked
  snapshots fail closed.
- The operator contract fixes command ordering, compatibility range, verified backup procedure,
  failure atomicity, and a forward-only rollback that preserves canonical writes and evidence.

## Exact evidence

- Direct DOM-017 implementation suite: 1 file / 5 tests PASS.
- Focused migration/regression suite: 7 files / 63 tests PASS.
- Documentation/inventory plus direct DOM-017 suite: 6 files / 25 tests PASS.
- Complete one-worker suite: 159 files / 1,249 tests PASS.
- Complete default-parallel suite: 159 files / 1,249 tests PASS.
- Root and web strict TypeScript PASS.
- Root and web production builds PASS.
- Staged Gitleaks and `git diff --check` PASS.
- Browser screenshot acceptance is N/A because DOM-017 changes no rendered UI or response shape.

## Migration and rollback contract

- Stop all writers before upgrade; retain a verified SQLite backup, SHA-256, exact compatible
  application commit, validator output, and restart evidence.
- Startup validates prerequisites, creates exact additive evidence schema, performs row work,
  executes all five validators, revalidates schema, and records marker `022` in one transaction.
- Every handled source key has one disposition. Ambiguous rows are quarantined with bounded safe
  evidence and never resolved by display name, update time, guessed scope, or guessed provider.
- A pre-022 application may read the retained compatibility paths against a copied additive 022
  database, but old and new writers must never run concurrently.
- Rollback returns only unlinked rows to retained compatibility reads and keeps canonical writes,
  imported events, links, quarantines, checks, and migration markers.
- There is no automatic down migration. Backup restore is an explicit offline recovery decision
  that may discard post-checkpoint writes and therefore requires operator review.

## Code-intelligence boundary

- Required GitNexus impact analysis initially reported a formally CRITICAL result for the new
  migration function: 577 direct callers, 799 affected symbols, and 56 processes.
- That result is internally impossible for a newly added symbol. Repository text evidence shows
  one production import/call in `src/agent-os/migrations.ts` plus direct test imports only.
- The false relationships match the repository's documented corrupt-index behavior. The result
  was treated as a mandatory manual-review warning, never as valid caller evidence.
- A fresh staged `detect_changes` immediately before the feature commit reported LOW risk:
  two indexed touched migration-interface symbols, zero affected processes, and nine changed
  files. Complete tests remain the authoritative regression evidence.

## Remaining

- DOM-019 is the only open Phase 1 item. It must measure old-versus-canonical reads/writes and
  mismatches before any cutover/removal claim.
- Discussions/Q&A, Teams/conflicts, secure DeviceSessions, and KNO-003 onward remain open in their
  own phases.
- TOOL-014 still needs exact real-provider acceptance; BASE-010 still needs the exact expanded
  provider compatibility matrix.
- The product remains an engineering preview rather than public plug-and-play software.

## Shared-main preservation

The dirty shared checkout must remain on `main` and must not be reset, cleaned, switched, staged,
or committed by this recovery.

- `web/src/Board.tsx` expected SHA-256:
  `e7b01cdab3709c66730f5b790f767e19bb2ddca6df0dc9fe56847c9b0bf0e0e8`
- `web/src/styles.css` expected SHA-256:
  `f54f263c6fd0f76e025b602a9f8f812d6e7e1cb4ad3e6bd8ee7f2ec5621cb2ec`

## Exact resume procedure

1. Read `/Users/arminrad/Desktop/agentboard/AGENTS.md` and this checkpoint completely.
2. Use this isolated worktree and branch; never switch or create a branch in the shared checkout.
3. Verify branch, worktree, shared UI hashes/status, Node/npm, `.env` state, and exact commit.
4. Continue DOM-019; do not advance the reserved Phase 1 control or retire a compatibility path
   without its measured usage/mismatch window.
5. Run GitNexus impact before every existing-symbol edit and `detect_changes` before every commit.
6. Keep TOOL-014, BASE-010, provider, telemetry, cutover, and public-release claims open until
   their exact gates pass.
7. After meaningful changes, update Graphify and the Obsidian project notes, then rerun complete
   verification and preservation checks.

## Paste-ready resume prompt

```text
Resume the Agentboard Agent OS program from:
/Users/arminrad/.codex/worktrees/agentboard/dom017-forward-migrations/docs/checkpoints/2026-07-29-agent-os-dom017-forward-migrations.md

Read AGENTS.md and the checkpoint first. Preserve the dirty shared main checkout and continue the
earliest dependency-ready Agent OS backlog item from branch codex/dom017-forward-migrations.
DOM-017 is evidence-complete at 137/375 delivered. DOM-019 is the only open Phase 1 item.
TOOL-014 and BASE-010 remain open pending exact real-provider evidence.
```
