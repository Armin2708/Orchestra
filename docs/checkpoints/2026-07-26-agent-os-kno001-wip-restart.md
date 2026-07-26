# Agent OS KNO-001 WIP Restart Checkpoint — 2026-07-26

Status: **restart-safe work in progress**. This checkpoint preserves the exact orchestration state
after the fresh Graphify/Vault reconciliation and the first durable KNO-001 implementation
checkpoint. It is not KNO-001 delivery, a release gate, or a shippability claim.

## TL;DR

| State | Exact evidence |
|---|---|
| Shared checkout | `/Users/arminrad/Desktop/agentboard`, `main` at `f1bc126144a3012f75cac7f6fcdee491ea28038b` |
| Coordinator | `/Users/arminrad/.codex/worktrees/agentboard/agent-os-next`, branch `codex/agent-os-next` |
| KNO implementation | `/Users/arminrad/.codex/worktrees/agentboard/kno001-persistence`, branch `codex/kno001-persistence` |
| Durable KNO WIP commit | `28d24624dc3107789c6988acfdee7090d9487ac7` |
| KNO focused evidence | 4 files / 59 tests PASS; root TypeScript PASS; `git diff --check` PASS |
| KNO GitNexus evidence | `applyAgentOsMigrations` HIGH warning honored; pre-commit delta LOW, 0 affected flows |
| Backlog truth | **126 / 373 delivered; 247 open**; KNO-001 remains open |
| Fresh Graphify | 4,150 nodes / 10,126 edges / 153 communities / 361 manifest files |
| Graphify review | PASS after two P2 artifact-presentation corrections; zero P0/P1/P2 |
| Vault reconciliation | Six notes verified at 126 / 373; Phase 7 remains 0 / 28 |
| Product status | Engineering preview; not plug-and-play or shippable |

## Asked

Continue the dependency-ordered Agent OS master backlog while preserving real terminal/CLI
behavior, worktree isolation, evidence-only backlog credit, GitNexus/Graphify/Vault contracts,
parallel review, and clear Asked-versus-Delivered reporting.

## Delivered in this partial batch

- Re-indexed GitNexus at exact `f1bc126`:
  7,577 nodes, 22,575 edges, 511 clusters, and 300 flows.
- Rebuilt Graphify from the full current corpus. The final reviewed artifacts are in the
  coordinator worktree under `graphify-out/`.
- Reconciled the six stale Vault notes from 123 / 373 to the previously proven exact-head truth of
  126 / 373. Only `JOB-010`, `PKG-002`, and `PKG-005` gained historical credit.
- Independently audited the KNO-001 migration shape, persistence-store boundary, security
  invariants, test matrix, and exact backlog acceptance boundary.
- Committed a coherent KNO-001 WIP implementation at `28d2462` containing:
  - migration `018-knowledge-persistence`;
  - six board-scoped persistence tables, indexes, constraints, and triggers;
  - strict full-entity validators;
  - a standalone `KnowledgeStore`;
  - focused migration/store evidence for restart, two-board isolation, canonical corruption,
    replay, lifecycle, redacted errors, and UTF-16/UTF-8 counting.
- Preserved the authoritative count rule: JavaScript UTF-16 code units for `character_count`
  (`content.length`) and UTF-8 bytes for `byte_count`.

## Evidence and backups

### Graphify

- Counts: 4,150 nodes, 10,126 edges, 153 communities, 361 manifest files.
- Independent output review after correction: PASS; no P0/P1/P2, no credential-pattern findings,
  and no skipped-sensitive-file content/path disclosure.
- Report correction: 132 detailed + 14 thin + 7 file-only communities = 153.
- HTML correction: all 10,126 ordered edge endpoints now match `graph.json`.
- Recovery archive:
  `/Users/arminrad/.codex/backups/agentboard-graphify-f1bc126-2026-07-26.tar.gz`
- Archive SHA-256:
  `34999a392006a0afef22ad6e174c7574fe5b7c87c256b52b5522536cdff62e96`

### Vault

- Mechanical master-backlog recount: 373 total, 126 checked, 247 open.
- Phase 5: 12 / 18. Phase 7: 0 / 28. Phase 16: 7 / 19.
- Recovery archive:
  `/Users/arminrad/.codex/backups/agentboard-vault-reconciliation-2026-07-26.tar.gz`
- Archive SHA-256:
  `87aaeff2fd69a182ba53d545021b4b90028b45b7d160c26c5be44b2c5d32079e`

### Shared-main preservation

The shared checkout remains intentionally dirty and must not be reset, cleaned, switched, or used
to create a branch. Its tracked UI delta remains:

`7bbddc6e6f21c48c9e8c7826b3e2f408e7ac7572`

Preserve `web/src/Board.tsx`, `web/src/styles.css`, `.codex/`, the retained screenshots, and the
existing shared `graphify-out/`.

## Remaining before KNO-001 can close

1. Update the two stale migration-count assertions:
   - `test/agent-home-controls.test.ts:950`
   - `test/agent-home-domain.test.ts:906`
2. Re-run the focused KNO/migration/contracts gate after that correction.
3. Run the complete serial Node 22.20.0 suite.
4. Run root and web TypeScript plus root and web production builds.
5. Run independent regression/security review of exact KNO head and fix every P0–P2 finding.
6. Run final GitNexus `detect_changes` against `main`.
7. Integrate the reviewed KNO commit into `codex/agent-os-next`.
8. Update the exact schema inventory for six new canonical tables:
   37 canonical and 52 total application tables, subject to executable drift-test confirmation.
9. Create an exact-head KNO-001 checkpoint with Asked, Delivered, Evidence, Remaining, and
   Asked-versus-Delivered.
10. Run `graphify update .` at the integrated code head and independently verify its outputs.
11. Only if all combined evidence passes, check **KNO-001 only** and reconcile:
    127 / 373 delivered, 246 open, Phase 7 at 1 / 28.
12. Update the Vault KNO note, master backlog, index, and daily session log.
13. Integrate to shared `main` without touching the preserved dirty UI work.

Browser acceptance is N/A for this slice only if final `detect_changes` confirms no route or UI
change. Every KNO-002 through KNO-027 item and KNO-GATE remains open.

## Exact resume procedure

1. Read `/Users/arminrad/Desktop/agentboard/AGENTS.md`.
2. Read this checkpoint and
   `docs/checkpoints/2026-07-26-agent-os-restart-handoff.md`.
3. Inspect, do not assume:
   - all three Git heads and worktree registrations;
   - dirty shared-main status and its stable patch ID;
   - KNO branch status (only temporary `node_modules` symlinks should be untracked);
   - Vault checkbox counts;
   - Graphify artifact/archive hashes.
4. Re-index GitNexus if the active indexed path/head changed.
5. Resume from KNO WIP commit `28d2462`; do not repeat the completed full Graphify extraction or
   six-note Vault reconciliation.
6. Follow the remaining-gates order above and move no backlog box without observed combined
   evidence.

## Paste-ready resume prompt

```text
Resume the Agentboard Agent OS program from:
/Users/arminrad/Desktop/agentboard/docs/checkpoints/2026-07-26-agent-os-kno001-wip-restart.md

Read that checkpoint and AGENTS.md first. Preserve the dirty shared main checkout. Resume from
KNO-001 WIP commit 28d2462 in its isolated worktree, finish its remaining tests/review/docs gates,
and do not check KNO-001 or claim shippability until the exact combined evidence passes.
```
