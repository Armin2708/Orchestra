# Agent OS DOM-014 Focused Service Boundaries Checkpoint — 2026-07-29

Status: **delivered at one exact code head**. This checkpoint closes DOM-014 only. It does not
close the remaining Phase 1 composition, compatibility-projection, rollback-plan, or
migration-telemetry items; implement Discussions, durable Conflict resolution, or DeviceSessions;
close the remaining Knowledge Compiler; close TOOL-014 or BASE-010; or make Orchestra public
plug-and-play.

## TL;DR

| State | Exact evidence |
|---|---|
| Branch | `codex/dom014-service-boundaries` |
| Worktree | `/Users/arminrad/.codex/worktrees/agentboard/dom014-service-boundaries` |
| Exact base | `5f2a73fad595a1e4b0ff8babb00f4ebfa9a28d56` |
| Exact code head | `3630baa28073871deef3e24d4562dcef32530353` |
| Restart point | the isolated branch commit containing this checkpoint |
| Required toolchain | Node `22.20.0`; npm `10.9.3`; no project `.env` file was present or assumed |
| Backlog truth | **134 / 375 delivered; 241 open**; Phase 1 is 16 / 20; TOOL-014 and BASE-010 remain open |
| Exact tests | focused: 4 files / 26 tests; serial and default: 152 files / 1,221 tests PASS |
| Product status | Engineering preview; no schema, UI, route shape, or release state changed |

## Delivered

- `src/agent-os/service-boundaries.ts` defines one immutable seven-domain catalog with narrow
  structural service types, owned responsibilities, exclusions, implementation states, and
  independent injection points.
- Orchestration, conversations, and deliveries are labeled `canonical` and bind the existing
  `OrchestrationService`, `ConversationService`, and `DeliveryReportService`.
- Knowledge is labeled `persistence_only` and binds `KnowledgeStore`; retrieval, compilation,
  managed injection, freshness automation, review, and promotion remain open.
- `ComputedWorkspaceConflictService` is an independently scoped `compatibility_only` boundary. It
  validates board identity and exposes only current execution-root and owned-path overlap
  detection.
- The existing canonical conflicts route delegates to that boundary without changing its URL or
  response shape.
- Discussions and device pairing are `reserved` with `service: null`. Messages remain targeted
  wake/delivery transport, and the master-token QR remains an unsafe bootstrap rather than a
  PairingTicket or DeviceSession.

## Exact evidence

- Focused service-boundary/API regression: 4 files / 26 tests PASS.
- Complete one-worker suite: 152 files / 1,221 tests PASS.
- Complete default-parallel suite: 152 files / 1,221 tests PASS.
- Root and web strict TypeScript PASS.
- Root and web production builds PASS.
- Changed-diff Gitleaks and `git diff --check` PASS.
- The fresh worktree loaded both locked dependency trees before the successful complete gates. An
  initial serial attempt correctly exposed missing web dependencies before collecting three UI
  suites; the exact rerun after `web/npm ci` passed all 1,221 tests.
- GitNexus pre-edit impact for `agentOsPlugin` was LOW with no indexed upstream callers. Final
  worktree-local staged detection was MEDIUM: 3 indexed changed symbols and 4 affected Agent OS
  plugin flows, all covered by both complete suites.
- The required comparison to `main` remained CRITICAL but represented the accumulated engineering
  train rather than isolated DOM-014: 92 files, 137 indexed changed symbols, and 55 affected
  symbols/process entries.
- Browser screenshot acceptance is N/A: DOM-014 changes no rendered UI or response shape.

## Boundary and rollback contract

- The catalog is descriptive and injectable; it does not become a second source of truth.
- A reserved boundary cannot silently receive a compatibility service. Activating Discussions or
  device pairing requires changing the explicit implementation state and passing its later gates.
- Knowledge remains persistence-only. No caller may infer that a stored source/chunk/build/use
  proves retrieval, compilation, injection, freshness, or effectiveness.
- Conflict detection remains advisory and compatibility-only. It does not create durable conflict
  records, lock work, arbitrate, enforce, or resolve.
- Rollback removes the catalog and conflict adapter, then restores the conflict route's direct
  `WorkspaceStore.conflicts` delegation. No data migration or backfill is involved.

## Remaining

- DOM-015 through DOM-017 and DOM-019 remain open in Phase 1.
- Discussions/Q&A, Teams/conflicts, secure DeviceSessions, and KNO-003 onward remain open in their
  own phases.
- TOOL-014 still needs real exact-source provider acceptance; BASE-010 still needs the exact
  four-provider compatibility matrix.
- The next independent dependency-ready backlog item is DOM-015.

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
   DOM-015.
5. Run GitNexus impact before every existing-symbol edit and `detect_changes` before every commit.
6. Keep reserved boundary states, TOOL-014, BASE-010, provider labels, and public-release claims
   honest until their exact gates pass.
7. After meaningful changes, update Graphify and the Obsidian project notes, then rerun complete
   verification and preservation checks.

## Paste-ready resume prompt

```text
Resume the Agentboard Agent OS program from:
/Users/arminrad/.codex/worktrees/agentboard/dom014-service-boundaries/docs/checkpoints/2026-07-29-agent-os-dom014-service-boundaries.md

Read AGENTS.md and the checkpoint first. Preserve the dirty shared main checkout and continue the
earliest dependency-ready Agent OS backlog item from branch codex/dom014-service-boundaries.
DOM-014 is evidence-complete at 134/375 delivered. TOOL-014 and BASE-010 remain open pending exact
real provider evidence; continue DOM-015 while provider authentication remains unavailable.
```
