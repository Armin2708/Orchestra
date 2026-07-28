# Agent OS BASE-007 Migration Controls Checkpoint — 2026-07-28

Status: **definition delivered; runtime phases remain independently gated**. This checkpoint
closes BASE-007 only. It does not implement a reserved control, complete a migration phase, prove a
rollback drill, promote a provider, or make Orchestra a public plug-and-play release.

## TL;DR

| State | Exact evidence |
|---|---|
| Branch | `codex/base007-migration-controls` |
| Worktree | `/Users/arminrad/.codex/worktrees/agentboard/base007-migration-controls` |
| Exact base | `8008c0f3e03286b97d5b7004099784825213268b` |
| Restart point | the isolated branch commit containing this checkpoint |
| Required toolchain | Node `22.20.0`; npm `10.9.3`; no project `.env` file was present or assumed |
| Backlog truth | **129 / 375 delivered; 246 open**; BASE-007 closed; TOOL-014 and BASE-010 open |
| Control truth | 19 phases; 44 controls; 2 wired; 6 release gates; 36 reserved; all default closed |
| Focused evidence | 1 file / 7 tests PASS; combined migration/package gate 2 files / 12 tests PASS |
| Complete evidence | 145 / 145 files and 1,194 / 1,194 tests PASS |
| Product status | Engineering preview; no runtime route, schema, support label, or release state changed |

## Delivered

- `docs/agent-os-migration-controls.json` is the machine-readable source for phases 0 through 18.
  Every phase has unique controls, an activation gate, privacy-safe telemetry, a checkpoint,
  rollback triggers/actions/verification, and an explicit durable-data policy.
- `docs/agent-os-migration-controls.md` explains the monotonic lifecycle from `reserved` through
  retirement, one-control-at-a-time canaries, forward-only schema recovery, fail-closed provider
  semantics, and the evidence required before `default_on`.
- The contract distinguishes implementation truth:
  - `wired` means a real environment binding and source-backed test;
  - `release_gate` blocks promotion but is not an environment variable;
  - `reserved` freezes a name and rollback contract without claiming an implementation.
- Only `ORCHESTRA_CANONICAL_LAUNCH` and `ORCHESTRA_CODEX_PROVIDER_CONTRACT` are labeled wired.
  Both remain off by default and retain their existing source/test bindings.
- Remote pairing, device auth, scoped mutation, public tunnel, terminal write, push, and the
  emergency kill switch are independently reserved. Rollback cannot revive the legacy reusable
  master-token QR.
- Behavior/development toggles are excluded from migration authority, and the documents are linked
  from the README, Agent OS guide, domain contract, delivery program, and npm package allowlist.

## Observed evidence

- Node `22.20.0`; npm `10.9.3`.
- No `.env`, `.env.local`, `web/.env`, or `web/.env.local` existed in the worktree.
- Focused migration-control contract: 1 / 1 file and 7 / 7 tests PASS.
- Combined migration-control/package truthfulness gate: 2 / 2 files and 12 / 12 tests PASS.
- Complete serial suite: 145 / 145 files and 1,194 / 1,194 tests PASS.
- The first complete attempt intentionally exposed the fresh-worktree prerequisite: root
  dependencies alone passed 142 files / 1,171 tests while three UI suites could not import React.
  After the locked `web` dependencies were installed, the exact complete rerun passed.
- JSON parse, unique-control counts, source markers, remote split, forward-only recovery,
  documentation links, and npm package inclusion are asserted by
  `test/agent-os-migration-controls.test.ts`.

## Rollback and compatibility boundary

This slice changes documentation, packaging metadata, and tests only. There is no runtime behavior
to roll back. Reverting the exact BASE-007 commit removes the definition while leaving databases,
sessions, jobs, worktrees, providers, and runtime flags unchanged.

The control matrix itself requires:

1. an exact source checkpoint and restore-tested backup before durable writes;
2. one attributable canary/control delta at a time;
3. privacy-safe comparison telemetry and a deliberately exercised rollback trigger;
4. forward-only schema handling without an automatic down migration;
5. preservation of accepted evidence and frozen work identity;
6. fail-closed behavior when no safe compatibility path exists.

## Remaining

- The 36 reserved controls are not wired.
- Each owning phase still needs its implementation, canary evidence, rollback drill, and full
  acceptance gate.
- TOOL-014 still needs the real exact-source Codex matrix and post-reconciliation production run.
- BASE-010 still needs the exact four-provider version/auth/billing/capability/platform matrix.
- BASE-008, BASE-009, and the other 242 open checklist boxes remain dependency-ordered work.

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
3. Verify branch, worktree, shared UI hashes/status, Node/npm, `.env` state, and the exact commit.
4. Continue the earliest dependency-ready open item, currently BASE-008 or the independently
   pending TOOL-014 clean-profile acceptance track.
5. Run GitNexus impact before every existing-symbol edit and `detect_changes` before every commit.
6. Keep TOOL-014, BASE-010, provider labels, and all reserved controls open until their exact gates
   pass.
7. After meaningful changes, update Graphify and the Obsidian project notes, then rerun the
   relevant complete verification and preservation checks.

## Paste-ready resume prompt

```text
Resume the Agentboard Agent OS program from:
/Users/arminrad/.codex/worktrees/agentboard/base007-migration-controls/docs/checkpoints/2026-07-28-agent-os-base007-migration-controls.md

Read AGENTS.md and the checkpoint first. Preserve the dirty shared main checkout and continue the
earliest dependency-ready Agent OS backlog item from branch codex/base007-migration-controls.
BASE-007 is definition-complete at 129/375 delivered; do not treat reserved controls as
implemented. TOOL-014 and BASE-010 remain open pending exact real provider evidence.
```
