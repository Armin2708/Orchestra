# Agent OS BASE-009 Request-to-Knowledge Acceptance Checkpoint — 2026-07-28

Status: **delivered at one exact code head**. This checkpoint closes BASE-009 only. It does not
implement the production Knowledge Compiler, execute a provider-native network turn, close
TOOL-014 or BASE-010, or make Orchestra public plug-and-play.

## TL;DR

| State | Exact evidence |
|---|---|
| Branch | `codex/base009-north-star-acceptance` |
| Worktree | `/Users/arminrad/.codex/worktrees/agentboard/base009-north-star-acceptance` |
| Exact base | `195888967aba7127b671a43d6da9d6d6041176a7` |
| Exact code head | `bb7c32f0a78608c113ee3c953ed5fd4ef3c0b4a4` |
| Restart point | the isolated branch commit containing this checkpoint |
| Required toolchain | Node `22.20.0`; npm `10.9.3`; no project `.env` file was present or assumed |
| Backlog truth | **131 / 375 delivered; 244 open**; BASE-009 closed; TOOL-014 and BASE-010 open |
| Exact tests | focused: 6 files / 78 tests; serial and default: 148 files / 1,205 tests PASS |
| Product status | Engineering preview; no provider support, production routing, or release state changed |

## Delivered

- `test/north-star-request-to-knowledge-acceptance.test.ts` drives a real canonical Agent OS API
  launch through frozen contract, job, workspace assignment, session, and prepared delivery state.
- Production delivery services submit claims separately from evidence, verify every required
  deliverable and criterion against a scoped artifact, and accept only the verified report.
- The test's deterministic promotion seam converts only that accepted bounded summary into one
  production-validated `verified_delivery` source/chunk with exact original contract, job,
  workspace, session, report, revision, content hash, and provenance links.
- A second canonical request selects that exact source/chunk into the `verified_deliveries`
  section of a production-validated context build, records one exact context use, and completes
  token accounting.
- Identical source, chunk, build, and use replays preserve one row each. An unaccepted report and a
  forged session target both fail before any knowledge source or chunk is written.
- `docs/canonical-lifecycle-acceptance.md` distinguishes this executable acceptance specification
  from unfinished automatic adapters, ranking, compilation, managed injection, provider-output
  citations, freshness, Discussion promotion, and operator surfaces.

## Exact evidence

- Direct BASE-009 gate: 1 file / 2 tests PASS.
- Related lifecycle gate: 6 files / 78 tests PASS.
- Complete one-worker suite: 148 files / 1,205 tests PASS.
- Complete default-parallel suite: 148 files / 1,205 tests PASS.
- Root and web strict TypeScript PASS.
- Root and web production builds PASS.
- Gitleaks and `git diff --check` PASS.
- GitNexus classified the new code slice LOW with zero affected execution flows; the two edited
  document symbols and the monotonic BASE-008 reconciliation assertion were also LOW with zero
  direct dependents or flows.
- Shared-main UI hashes remained unchanged.

## Acceptance boundary

- The executor is deterministic and local. It proves lifecycle wiring without authenticating a
  provider or claiming model output, provider-native tokens, billing, or support.
- The verified-delivery promotion and context-selection builders are test seams around real
  bounded-summary, Knowledge contract, persistence, scope, replay, and accounting code. They do
  not claim a production source adapter, retriever, ranker, compiler, or prompt injector.
- The accepted source is board-visible for a later request but retains exact provenance to the
  original lifecycle. The follow-up context manifest separately targets its own exact
  job/session/report and cites the original source/chunk identities.
- Discussion-answer promotion remains outside this slice because the production Discussion
  service is not implemented.

## Remaining

- TOOL-014: record the real exact-source Codex matrix, reconcile support only from passing
  evidence, and implement the remaining declared-provider adapters.
- BASE-010: define and prove the exact four-provider version, authentication/billing, capability,
  autonomous-use, overage, and platform matrix.
- KNO-003 through KNO-GATE: implement the remaining source adapters, retrieval, Graphify/GitNexus
  integration, compilation, budgets, managed injection, freshness, review, APIs/UI, and benchmark.
- All remaining open checklist boxes stay dependency-ordered work.

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
4. Resume TOOL-014's exact real-provider gate when clean-profile authentication is available;
   otherwise continue the earliest independent dependency-ready backlog item.
5. Run GitNexus impact before every existing-symbol edit and `detect_changes` before every commit.
6. Keep TOOL-014, BASE-010, provider labels, production Knowledge claims, and public-release claims
   open until their exact gates pass.
7. After meaningful changes, update Graphify and the Obsidian project notes, then rerun complete
   verification and preservation checks.

## Paste-ready resume prompt

```text
Resume the Agentboard Agent OS program from:
/Users/arminrad/.codex/worktrees/agentboard/base009-north-star-acceptance/docs/checkpoints/2026-07-28-agent-os-base009-request-to-knowledge-acceptance.md

Read AGENTS.md and the checkpoint first. Preserve the dirty shared main checkout and continue the
earliest dependency-ready Agent OS backlog item from branch codex/base009-north-star-acceptance.
BASE-009 is evidence-complete at 131/375 delivered. TOOL-014 and BASE-010 remain open pending exact
real provider evidence; production Knowledge Compiler work remains open under KNO-003 onward.
```
