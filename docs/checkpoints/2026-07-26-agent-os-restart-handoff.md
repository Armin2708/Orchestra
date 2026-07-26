# Agent OS restart handoff — 2026-07-26

This checkpoint is the durable continuation source for the Agentboard Agent OS program after a
machine or Codex restart. Re-read the repository `AGENTS.md` before acting and treat current Git,
test, Graphify, and Vault state as authoritative if it differs from this snapshot.

## Resume objective

Complete Agentboard's dependency-ordered Agent OS master backlog with evidence-backed delivery
while preserving real terminal/CLI behavior, worktree isolation, GitNexus/Graphify/Vault
contracts, multi-agent orchestration, and every release gate. Do not describe the product as
plug-and-play or shippable until every required release gate genuinely passes.

## Canonical repository state

| Item | Checkpoint value |
| --- | --- |
| Shared checkout | `/Users/arminrad/Desktop/agentboard` |
| Canonical branch | `main` |
| Agent OS consolidation commit | `1994f12d9ff23c969a6eb0b645b2db25ee694eda` |
| Consolidation parents | prior `main` `388e3b2`; northstar `b38df74` |
| Backlog truth | **126 / 373 delivered; 247 open** |
| Required runtime | `/Users/arminrad/.nvm/versions/node/v22.20.0/bin/node` |
| Product status | engineering preview; not release-ready or shippable |

The local `main` branch is ahead of `origin/main`; it was not pushed during consolidation.

## Evidence already delivered

- Exact conflict-free northstar-to-main merge recorded as `1994f12`.
- Complete repository serial suite passed on the exact merge state:
  **134 test files / 979 tests** under Node `22.20.0`.
- Root TypeScript, web TypeScript, root production build, and web production build passed.
- The blocker implementations for recoverable lifecycle audit, safe visible transcript
  projection/redaction, and durable Codex approval outcomes are present in the consolidated
  history. The approval change was conflict-resolved into `883683f`; lifecycle and redaction have
  patch-equivalent consolidated commits `f82ab4a` and `a59580d`.
- Exact-head delivery reconciliation is present at northstar head `b38df74`; only JOB-010,
  PKG-002, and PKG-005 gained backlog credit in that reconciliation.
- A superseded knowledge-contract candidate was preserved as `3a883fe` on
  `codex/kno-job010-replacement`; the hardened implementation in `main` remains authoritative.

## Local changes that must remain untouched

The shared checkout deliberately remains dirty with user-owned work:

- modified `web/src/Board.tsx`
- modified `web/src/styles.css`
- untracked `.codex/`
- untracked Agent Home and exact-head acceptance screenshots
- untracked `graphify-out/`

The two tracked UI edits were preserved and reapplied across the main consolidation. Their stable
patch ID is `7bbddc6e6f21c48c9e8c7826b3e2f408e7ac7572`. Recovery stashes include
`0f31925aa88eec5ff81f28bb14b8321ecd7ed50d` and
`df433fbef5b4c22eef0880e2325e6a95ff6f2b68`.

Never reset, overwrite, silently commit, or discard these files.

## Worktree cleanup checkpoint

Sixty-four unused worktrees were removed after two independent cleanliness/process audits.
Candidate branch refs were retained because many commits were integrated through equivalent
patches or conflict resolution rather than exact ancestry.

Expected registered worktrees before a restart:

1. `/Users/arminrad/Desktop/agentboard` — canonical shared checkout
2. `/Users/arminrad/Desktop/agentboard-northstar` — removable after Obsidian releases its cwd
3. `/Users/arminrad/Desktop/agentboard-workspaces/test` — live app-created terminal workspace
4. the short-lived restart-handoff worktree, until this checkpoint is merged and removed

Before restart, Obsidian PIDs used `agentboard-northstar` as their cwd. After restart, re-audit
process use and remove that worktree only when unused. Never remove
`agentboard-workspaces/test` while it backs an active terminal session.

Historical ignored `AGENTS.md`/`CLAUDE.md` variants were archived at:

`/Users/arminrad/.codex/backups/agentboard-worktree-instruction-snapshots-1994f12-2026-07-26.tar.gz`

## Required reporting and execution contract

Before every batch, report:

- Asked
- Deliverables
- Evidence Plan

After every batch, report:

- Delivered
- Evidence
- Remaining
- Asked versus Delivered

For all implementation work:

1. Never create or switch branches in the shared checkout.
2. Create an isolated worktree and branch for each implementation lane.
3. Run GitNexus `impact` before editing every function, class, or method.
4. Warn before any HIGH or CRITICAL edit.
5. Run GitNexus `detect_changes` before each commit.
6. Preserve real PTY/terminal and supported CLI behavior.
7. Load and verify environment files before local tests.
8. Use bounded parallel agents only for independent work and give each editing agent its own
   isolated worktree.
9. Integrate only reviewed commits, then test the exact combined head.
10. Update Graphify after meaningful code changes and reconcile the Obsidian Vault/backlog only
    from observed evidence.

## Current incomplete reconciliation

- `graphify-out/graph.json` in the shared checkout was last known to describe commit `915d632`
  and is stale relative to `main`. An interrupted update produced partial generated files; do not
  claim Graphify is current until a fresh update completes and its output is validated.
- The Vault master backlog and five related Agentboard notes remain stale at the earlier
  123 / 373 checkpoint. They need the observed **126 / 373** reconciliation after Graphify is
  refreshed.
- QA-001, QA-013, TOOL-010, the Hono moderate advisory, public npm publication, remote/browser
  release proof, and the remaining master backlog items are still open.
- The retained package evidence is preview-only. Public npm lookup previously returned `E404`.
- Installed Codex `0.145.0` was correctly rejected by the compatibility contract pinned to
  `0.144.6`; do not turn that fail-closed result into a release claim.

## Next dependency-ordered batch

First restore knowledge truth:

1. Create a new isolated worktree from current `main`.
2. Refresh and validate Graphify at the exact current head.
3. Reconcile the six identified Vault files to 126 / 373 without checking any additional backlog
   box.
4. Re-parse `docs/north-star-delivery-program.md` and the Vault master backlog to confirm counts.

Then implement **KNO-001 durable knowledge persistence**, the next audited dependency-ready slice:

- add migration `018-knowledge-persistence`
- persist `KnowledgeSource`, `KnowledgeChunk`, `ContextBuild`, build entries, and `ContextUse`
- use board-scoped composite source/chunk keys
- retain canonical request/source-set evidence needed to re-verify deterministic build IDs
- enforce strict JSON, hashing, accounting, ordering, lifecycle, scope, idempotence, and
  redacted-error invariants
- expose only the minimal persistence store; do not claim ingestion, retrieval, compilation,
  injection, lifecycle automation, or operator UI work from KNO-002 onward

Known GitNexus warning: `applyAgentOsMigrations` previously measured **HIGH** risk with 119 affected
symbols and seven direct dependents. Re-run impact at the current head and warn before editing.

Required KNO-001 evidence includes migration idempotence/atomic failure, restart persistence,
two-board isolation, canonical corruption rejection, Unicode counts, direct-SQL constraint tests,
focused tests, the complete serial Node 22 suite, root/web types and builds, independent
security/regression review, browser acceptance where the slice changes UI, then exact backlog,
Graphify, and Vault reconciliation.

## Paste-ready resume prompt

```text
Resume the Agentboard Agent OS program from:
/Users/arminrad/Desktop/agentboard/docs/checkpoints/2026-07-26-agent-os-restart-handoff.md

Start by reading that file and /Users/arminrad/Desktop/agentboard/AGENTS.md. Inspect current Git,
worktree, process, Graphify, and Vault state before relying on the snapshot. Preserve the dirty
shared-main UI work and use isolated worktrees only.

Continue the persistent objective: complete the dependency-ordered 373-item Agent OS master
backlog with evidence, terminal/CLI fidelity, GitNexus/Graphify/Vault contracts, multi-agent
orchestration, and all release gates. Do not claim shippability early.

First remove the old northstar worktree only if no process uses it, refresh Graphify and reconcile
the six stale Vault notes to the proven 126/373 checkpoint, then execute the KNO-001 durable
knowledge-persistence batch. Before and after every batch use Asked, Deliverables, Evidence Plan,
Delivered, Evidence, Remaining, and Asked versus Delivered.
```
