# Agent OS TOOL-013 WIP Restart Checkpoint — 2026-07-26

Status: **restart-safe work in progress**. This checkpoint preserves the exact TOOL-013
subscription-first provider-contract remediation state. It is not TOOL-013 delivery, a release
gate, or a shippability claim.

## TL;DR

| State | Exact evidence |
|---|---|
| Shared checkout | `/Users/arminrad/Desktop/agentboard`, `main` at `9d3b2474323a17ee91c7d655ff944392f6db9d71` |
| Isolated worktree | `/Users/arminrad/.codex/worktrees/agentboard/tool013-provider-contract` |
| Branch | `codex/tool013-provider-contract` |
| Required Node | `/Users/arminrad/.nvm/versions/node/v22.20.0/bin/node` (`v22.20.0`) |
| Backlog truth | **127 / 375 delivered; 248 open**; TOOL-013 remains open |
| Focused evidence | 1 file / 82 tests PASS |
| Compile evidence | Root TypeScript PASS; `git diff --check` PASS |
| WIP source hashes | contract `87674d7398a66e59c99a542be8ee08e300595b183eaa283534364e5e4aff2f6d`; manifests `0a64d56f277428a0bfbd9af850633454a9e788e54f015c3bc2cab72411e9340c`; tests `dc50328d5a99b7107ea1af3162b530060a8110bf9fecfbb4f5c533a06453c069` |
| Product status | Engineering preview; not plug-and-play or shippable |

## Asked

Continue autonomously through the dependency-ordered Agent OS backlog using the four-worker
quality sweet spot, subscription-first native CLI behavior, evidence-only backlog credit, isolated
worktrees, and Asked-versus-Delivered reporting.

## Delivered in this partial TOOL-013 batch

- Added a strict versioned provider contract and four canonical first-release manifests.
- Kept native vendor CLI plus personal subscription as the primary path and usage-priced API as an
  explicit secondary path.
- Kept Claude managed subscription automation policy-blocked, Codex candidate-only, and Qwen/Kimi
  unsupported rather than overstating compatibility.
- Kept attach, resume, and restart recovery fail-closed until durable rehydration authority exists.
- Enforced sealed launch/fork model, effort, access, scope, executable, environment, billing, and
  consent evidence.
- Added fixed raw-adapter error redaction, credential-shaped identity rejection, bounded live
  session/event state, exact event ordering, and raw environment conflict auditing.
- Added wrapper-minted public managed session IDs and private raw-ID translation across controls
  and events.
- Added an event-stream retirement promise, `AbortSignal`, single raw `return()` path, pending-read
  tracking, and bounded raw-ID quarantine.
- Added regressions for terminal retirement before control, stale output after stop/reuse, fork
  access ceilings, resume fail-closed behavior, reflection safety, environment isolation, model and
  effort evidence, identity conflicts, and bounded capacity.

## Current verified evidence

The latest observed gate before this checkpoint:

```text
Test Files  1 passed (1)
Tests       82 passed (82)
```

- Root TypeScript: PASS.
- `git diff --check` for the three TOOL-013 implementation/test files: PASS.
- Prior standalone strict test TypeScript: PASS before the newest stream/quarantine edits; rerun is
  still required.
- Prior full serial Node 22 suite: 139 / 139 files and 1,135 / 1,135 tests PASS on the earlier
  candidate; it must be rerun on the final exact hash.
- Prior root/web production builds and web TypeScript passed on the earlier candidate; they must be
  rerun on the final exact hash.
- Gitleaks passed on the earlier candidate; rerun is required after the final remediation.

## Independent review findings that keep TOOL-013 open

Three independent reviewers found real lifecycle/identity defects after the first green gate:

1. A raw event read already pending during `stop()` could hang until the provider emitted again.
2. Terminal delivery did not actively close the raw iterator.
3. A lazily created old iterable could bind to a replacement session on first iteration.
4. Adapter/provider IDs could be reused while an old raw iterator was still closing.
5. Exact public session-ID reuse made an old terminal event indistinguishable from a replacement
   session generation.

The current WIP addresses most of this with wrapper-managed IDs, synchronous record capture,
retirement racing, abort propagation, one-shot iterator close, and bounded quarantine.

### Remaining critical design gap

The raw adapter still chooses its returned local `session_id`. A hostile or buggy adapter can start
a replacement using a quarantined raw ID before the gateway detects the collision during
registration. The final patch must make the gateway assign the adapter-local session ID before raw
launch/fork:

- add a gateway-owned `assigned_session_id` to the private authorized implementation context;
- mint it before invoking raw launch/fork;
- require the raw session result to return that exact assigned ID;
- use the same ID as the public managed ID and for all raw controls/events;
- retain provider-ID quarantine until raw stream cleanup succeeds;
- keep failed/hung cleanup entries counted inside the existing 1,024-session capacity.

Do not accept bounded LRU/TTL tombstones. Eviction would reintroduce stale-generation ambiguity.

## Required deterministic regressions before the next freeze

1. A lazy iterable captured before stop cannot call raw `events()` or bind to a replacement.
2. Sequential sessions receive different gateway IDs even when provider-native IDs repeat.
3. Public raw-ID controls reject; managed-ID controls reach the raw adapter with the assigned ID.
4. Raw events must match the assigned ID and are delivered only under that managed ID.
5. Follow-up/fork implementation contexts retain sealed public evidence and receive the correct
   assigned/target IDs.
6. A second `next()` pending before stop rejects immediately without another provider emission.
7. Abort-aware raw iteration runs its finalizer and raw `return()` exactly once.
8. Non-cooperative pending reads still cancel publicly; late values/errors are discarded.
9. Sync throw, async rejection, credential-bearing cause, and hung raw `return()` never leak.
10. Failed/hung close retains bounded quarantine and consumes capacity; successful close releases
    quarantine.
11. Concurrent stop, terminal delivery, and consumer cleanup remain idempotent.
12. Terminal delivery invokes cleanup without requiring caller `return()` and cannot be rebound.

## Remaining gates

1. Complete the gateway-assigned session-ID change and the regression matrix above.
2. Run focused TOOL-013 tests and standalone strict test TypeScript.
3. Freeze the exact contract/manifests/tests hashes.
4. Obtain independent contract, security, and adversarial PASS verdicts on those exact hashes.
5. Run the complete serial Node 22 suite.
6. Run root and web TypeScript.
7. Run root and web production builds.
8. Run Gitleaks and diff hygiene.
9. Stage only the intended files and run GitNexus `detect_changes` against `main`.
10. Update provider strategy/supported-environment documentation.
11. Update Graphify, the Obsidian Vault, daily log, and master backlog from observed combined
    evidence only.
12. Only after every gate passes, check TOOL-013 and reconcile to 128 / 375 delivered and 247 open.

Browser acceptance remains N/A for TOOL-013 only if final change detection proves there is no
route/UI/runtime wiring. TOOL-014 and every other open item remain undelivered.

## Shared-main preservation

The shared checkout remains intentionally dirty and must not be reset, cleaned, switched, or used
to create a branch.

- `web/src/Board.tsx` SHA-256:
  `e7b01cdab3709c66730f5b790f767e19bb2ddca6df0dc9fe56847c9b0bf0e0e8`
- `web/src/styles.css` SHA-256:
  `f54f263c6fd0f76e025b602a9f8f812d6e7e1cb4ad3e6bd8ee7f2ec5621cb2ec`
- Combined tracked UI patch ID:
  `7bbddc6e6f21c48c9e8c7826b3e2f408e7ac7572`

Preserve `.codex/`, the retained screenshots, `graphify-out/`, and all unrelated user changes.

## Exact resume procedure

1. Read `/Users/arminrad/Desktop/agentboard/AGENTS.md`.
2. Read this checkpoint completely.
3. Inspect the shared checkout and isolated worktree; do not switch or branch the shared checkout.
4. Verify the WIP commit and the three source hashes recorded above.
5. Recreate temporary dependency symlinks only if absent:
   - `node_modules` to `/Users/arminrad/Desktop/agentboard/node_modules`
   - `web/node_modules` to `/Users/arminrad/Desktop/agentboard/web/node_modules`
6. Re-run the 82-test focused gate and root TypeScript before editing.
7. Run GitNexus impact analysis before every symbol edit; its current result is `UNKNOWN` because
   these files are new/untracked. Treat the boundary as CRITICAL.
8. Resume with the gateway-assigned `assigned_session_id` change described above.
9. Do not move the TOOL-013 backlog box or claim shippability before all remaining gates pass.

## Paste-ready resume prompt

```text
Resume the Agentboard Agent OS program from:
/Users/arminrad/Desktop/agentboard/docs/checkpoints/2026-07-26-agent-os-tool013-wip-restart.md

Read AGENTS.md and the checkpoint first. Preserve the dirty shared main checkout. Resume TOOL-013
in the isolated codex/tool013-provider-contract worktree from its WIP checkpoint commit. Complete
the gateway-assigned session-ID, active cancellation, bounded quarantine, exact-hash review, full
Node 22/build, GitNexus, Graphify, Vault, and backlog gates. Do not check TOOL-013 or claim
shippability until every combined gate passes.
```
