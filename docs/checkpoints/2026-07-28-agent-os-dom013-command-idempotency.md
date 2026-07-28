# Agent OS DOM-013 Command Idempotency Checkpoint — 2026-07-28

Status: **delivered at one exact code head**. This checkpoint closes DOM-013 only. It does not
close the remaining Phase 1 service-boundary, composition, compatibility-projection,
rollback-plan, or migration-telemetry items; close TOOL-014 or BASE-010; or make Orchestra public
plug-and-play.

## TL;DR

| State | Exact evidence |
|---|---|
| Branch | `codex/dom013-idempotency-coverage` |
| Worktree | `/Users/arminrad/.codex/worktrees/agentboard/dom013-idempotency-coverage` |
| Exact base | `a2fa5fa7efe66336420074534b6043ab57025f43` |
| Exact code head | `085b180b8f696eb0c0e5352fd0b696ba2563d147` |
| Restart point | the isolated branch commit containing this checkpoint |
| Required toolchain | Node `22.20.0`; npm `10.9.3`; no project `.env` file was present or assumed |
| Backlog truth | **133 / 375 delivered; 242 open**; Phase 1 is 15 / 20; TOOL-014 and BASE-010 remain open |
| Exact tests | direct: 2 files / 6 tests; serial and default: 151 files / 1,217 tests PASS |
| Product status | Engineering preview; no provider support, visual layout, or release state changed |

## Delivered

- Migration `021-command-idempotency-coverage` adds one board-scoped durable command-receipt
  ledger for workspace create, checkpoint create, policy create, delivery submit, delivery accept,
  and job cancel. Exact schema replay rejects altered owned objects, invalid fingerprints,
  premature results, control-character keys, and invalid lifecycle transitions.
- Receipt identity combines the board, caller key, command, command scope, and a canonical
  normalized-request hash. An exact replay returns the original durable result; altered command,
  scope, or request reuse fails with conflict.
- Public Agent OS workspace, policy, checkpoint, job-launch, delivery-submit, delivery-accept, and
  job-cancel routes now require exactly one matching header, snake-case body, or camel-case body
  identity. Canonical Board launch requires the same key when its feature gate is enabled.
- Job launch retains its existing board/key uniqueness in `jobs` and now computes a canonical
  fingerprint for direct cardless and card-linked scheduler calls. Existing Agent Home profile
  create and session retry/action commands retain their previously delivered replay contracts.
- Runtime workspace creation and checkpoint capture claim a pending receipt before an external
  side effect, then persist success or bounded failure. Database-only create/submit/accept paths
  write the result and receipt in the same immediate transaction.
- CLI commands generate a unique key when omitted and accept explicit replay keys for workspace,
  checkpoint, job launch/cancel, policy, and delivery submit/accept. The launch control sends a
  browser-generated UUID without changing its visual behavior.
- Delivery-submit identity includes its optional verification payload, preventing a caller from
  omitting or changing verification data under a previously completed submit key.

## Exact evidence

- Direct DOM-013 contract gate: 2 files / 6 tests PASS.
- Receipt/API/migration focused gate: 3 files / 20 tests PASS.
- Delivery/auth focused regression gate: 5 files / 30 tests PASS.
- Complete one-worker suite: 151 files / 1,217 tests PASS.
- Complete default-parallel suite: 151 files / 1,217 tests PASS.
- Root and web strict TypeScript PASS.
- Root and web production builds PASS.
- Changed-diff Gitleaks and `git diff --check` PASS.
- GitNexus pre-edit review classified delivery submit and `buildServer` CRITICAL, with the other
  edited service boundaries LOW or MEDIUM. Final worktree-local detection remained CRITICAL,
  mapping 109 indexed changed symbols to 25 execution flows; the complete serial and default
  suites are the acceptance evidence for that shared-core scope.
- The required comparison to `main` also remained CRITICAL but included the accumulated
  engineering train rather than only DOM-013: 84 files, 1,254 indexed symbols, and 57 affected
  symbols/process entries. It is retained as a broad regression boundary, not presented as the
  isolated change count.
- Browser screenshot acceptance is N/A: the web delta changes only the launch request payload,
  not rendered layout. Web TypeScript/build and the existing provider/card UI tests pass.

## Contract and rollback boundary

- Public command routes fail closed when the key is absent, repeated as multiple headers, malformed,
  or inconsistent across supported spellings. Internal service callers remain backward compatible
  when no key is supplied.
- A receipt is immutable after success or failure. Reusing a failed key reports the original
  bounded failure, and a pending key reports that the command is still in progress.
- Database-only commands are transactionally atomic with their receipt. Runtime-backed workspace
  and checkpoint commands use a pending/succeeded/failed lifecycle around the external operation;
  they do not claim cross-process compensation beyond that recorded outcome.
- Migration 021 requires migration 020 and is forward-only. Structural incompatibility aborts the
  migration transaction without recording its marker.
- This slice does not make every POST endpoint a command and does not redefine non-command
  process input, resize, signal, verification, rejection, revision, or compatibility operations.
  It closes the create/launch/retry/submit/accept/cancel families enumerated by DOM-013.

## Remaining

- DOM-014 through DOM-017 and DOM-019 remain open in Phase 1.
- TOOL-014 still needs a real exact-source Codex matrix and the remaining declared-provider
  adapters. BASE-010 still needs the exact four-provider compatibility matrix.
- KNO-003 onward, remaining product phases, packaging, and public release stay open.
- The next independent dependency-ready backlog item is DOM-014.

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
   DOM-014.
5. Run GitNexus impact before every existing-symbol edit and `detect_changes` before every commit.
6. Keep TOOL-014, BASE-010, all provider labels, and public-release claims open until their exact
   gates pass.
7. After meaningful changes, update Graphify and the Obsidian project notes, then rerun complete
   verification and preservation checks.

## Paste-ready resume prompt

```text
Resume the Agentboard Agent OS program from:
/Users/arminrad/.codex/worktrees/agentboard/dom013-idempotency-coverage/docs/checkpoints/2026-07-28-agent-os-dom013-command-idempotency.md

Read AGENTS.md and the checkpoint first. Preserve the dirty shared main checkout and continue the
earliest dependency-ready Agent OS backlog item from branch codex/dom013-idempotency-coverage.
DOM-013 is evidence-complete at 133/375 delivered. TOOL-014 and BASE-010 remain open pending exact
real provider evidence; continue DOM-014 while provider authentication remains unavailable.
```
