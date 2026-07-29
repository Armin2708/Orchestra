# Agent OS DOM-015 BuildServer Composition Checkpoint — 2026-07-29

Status: **delivered at one exact code head**. This checkpoint closes DOM-015 only. It does not
close the remaining Phase 1 compatibility-projection, migration/rollback-plan, or migration-
telemetry items; implement reserved product domains; close TOOL-014 or BASE-010; or make Orchestra
public plug-and-play.

## TL;DR

| State | Exact evidence |
|---|---|
| Branch | `codex/dom015-buildserver-composition` |
| Worktree | `/Users/arminrad/.codex/worktrees/agentboard/dom015-buildserver-composition` |
| Exact base | `9c0ef4636576ff04a2b16fa0c7511afbcc630cd4` |
| Exact code head | `98c722f10357311d5c1dfdb4ca8e83228adc2b8c` |
| Restart point | the isolated branch commit containing this checkpoint |
| Required toolchain | Node `22.20.0`; npm `10.9.3`; no project `.env` file was present or assumed |
| Backlog truth | **135 / 375 delivered; 240 open**; Phase 1 is 17 / 20; TOOL-014 and BASE-010 remain open |
| Exact tests | direct: 1 file / 5 tests; focused: 6 files / 28 tests; serial and default: 154 files / 1,228 tests PASS |
| Product status | Engineering preview; no schema, UI, route shape, provider support, or release state changed |

## Delivered

- `src/server-composition.ts` defines the immutable
  `composition_and_compatibility_routing` contract.
- `composeAgentOsRouteOptions` assembles only already-created dependencies and preserves the exact
  Claude, Codex, shell, provider-catalog, explicit-override, and operator-auth behavior previously
  embedded in `buildServer`.
- `registerAgentOsServerComposition` delegates exactly once to the focused
  `registerAgentOsRoutes` registrar.
- `buildServer` no longer imports the registrar, fallback provider builders, or
  `CODEX_CAPABILITIES`; it injects the database, host, Agent OS options, and operator predicate
  through the composition seam.
- Static guards reject canonical domain constructors, inline Agent OS route handlers, and SQL in
  the composition seam.
- Existing legacy routes remain supported compatibility routing. DOM-015 does not relabel their
  tables or claim projection completeness.

## Exact evidence

- Direct composition contract: 1 file / 5 tests PASS.
- Focused service/API/auth regression: 6 files / 28 tests PASS.
- Complete one-worker suite: 154 files / 1,228 tests PASS.
- Complete default-parallel suite: 154 files / 1,228 tests PASS.
- Root and web strict TypeScript PASS.
- Root and web production builds PASS.
- Changed-diff Gitleaks and `git diff --check` PASS.
- The fresh worktree loaded both locked dependency trees before the successful complete gates.
- The initial complete run reached 153 passing files and 1,227 passing tests before the host-shell
  fixture exposed an Oh My Zsh update prompt from the user's login shell. The prompt consumed the
  first character of `echo`; the isolated PTY file and both complete modes passed with
  `DISABLE_AUTO_UPDATE=true` scoped only to the test process. No user or project configuration was
  edited.
- GitNexus pre-edit impact classified both `buildServer` and `ServerOptions` as CRITICAL: 43 direct
  callers, 55 total impacted symbols, and the daemon `serve` process for `buildServer`; 40 direct
  and 52 total for `ServerOptions`.
- Final staged detection was LOW: 2 stale-index-adjacent touched symbols and no affected process.
  The required comparison to `main` remained CRITICAL because it covered the accumulated Agent OS
  train: 100 files, 139 indexed changed symbols, and 55 affected symbols/process entries.
- Browser screenshot acceptance is N/A because DOM-015 changes no rendered UI or response shape.

## Boundary and rollback contract

- `buildServer` remains responsible for Fastify lifecycle/authentication, dependency injection,
  focused plugin registration, and supported legacy compatibility routes.
- It must not become the home of new canonical domain state transitions, service construction,
  persistence, or validation.
- Focused domain services remain authoritative. The new composition module is not a second source
  of truth.
- Rollback re-inlines the unchanged fallback assembly and direct registrar call. There is no schema
  migration, backfill, durable-state rewrite, or client transition.

## Remaining

- DOM-016, DOM-017, and DOM-019 remain open in Phase 1.
- DOM-016 is the next independent dependency-ready item.
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
   DOM-016.
5. Run GitNexus impact before every existing-symbol edit and `detect_changes` before every commit.
6. Keep projection/source-of-truth claims, TOOL-014, BASE-010, provider labels, and public-release
   claims honest until their exact gates pass.
7. After meaningful changes, update Graphify and the Obsidian project notes, then rerun complete
   verification and preservation checks.

## Paste-ready resume prompt

```text
Resume the Agentboard Agent OS program from:
/Users/arminrad/.codex/worktrees/agentboard/dom015-buildserver-composition/docs/checkpoints/2026-07-29-agent-os-dom015-buildserver-composition.md

Read AGENTS.md and the checkpoint first. Preserve the dirty shared main checkout and continue the
earliest dependency-ready Agent OS backlog item from branch codex/dom015-buildserver-composition.
DOM-015 is evidence-complete at 135/375 delivered. TOOL-014 and BASE-010 remain open pending exact
real-provider evidence; continue DOM-016 while provider authentication remains unavailable.
```
