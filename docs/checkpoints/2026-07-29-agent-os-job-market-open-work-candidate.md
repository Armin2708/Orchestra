# Agent OS Job Market / Open Work candidate

Date: 2026-07-29
Lane: 4
Exact base: `b18181a32880eda3c51242fc07d3c3ba22bd66f2`
Lane branch: `codex/accel-job-market`
Lane worktree: `/Users/arminrad/.codex/worktrees/agentboard/accel-job-market`

## Bottom line

Lane 4 produced a focused backend and frontend candidate for dependency-aware Open Work,
deterministic matching, explicit assignment, and one-job dispatch. The candidate code head is
`26a8f3b67d047f2dbc3f2be4e4005cdc39c2c6f0`.

No global backlog item is closed by this checkpoint. Lane 1 must first perform the listed central
registrations, integrate the exact candidate commits, and pass exact-head suites. `JOB-014`
remains substantively partial until the private runtime prompt path delegates to the shared
renderer.

## Candidate commits

| Purpose | Source candidate | Lane 4 commit |
| --- | --- | --- |
| Deterministic Open Work backend | `8b623df87ab670c743eebe2b378d6ab0523a0440` | `50da828` |
| Fail-closed operator composition | `608121c81821c086aeeae4ebedc990ce280f214c` | `84db1a13e0aaacdd00ddef00f970def47deec480` |
| Responsive Open Work console | `78055988aae21aec2daa153e9e098a3906f1fbb3` | `79545cbe7f2dbf1c2fc3de4e712cbb9e90c93a5b` |
| Browser-found viewport fixes | n/a | `26a8f3b67d047f2dbc3f2be4e4005cdc39c2c6f0` |

The candidate changes 12 focused files. It does not edit central route composition, application
navigation, migrations, package manifests, canonical inventories, or the shared backlog.

### Changed files

Code diff against the exact base: 12 files, 8,564 insertions, 0 deletions.

- `src/agent-os/agent-brief.ts`
- `src/agent-os/open-work-routes.ts`
- `src/agent-os/open-work.ts`
- `test/job-market-gate.test.ts`
- `test/open-work-api.test.ts`
- `test/open-work-presentation.test.ts`
- `test/open-work-service.test.ts`
- `test/open-work-ui-contract.test.ts`
- `web/src/OpenWorkView.tsx`
- `web/src/openWork.css`
- `web/src/openWorkApi.ts`
- `web/src/openWorkPresentation.ts`

## Backlog disposition

| ID | Lane 4 evidence | Disposition before Lane 1 integration |
| --- | --- | --- |
| `JOB-008` | Repository, repeated capability, signed exact priority, dependency-readiness, and non-negative budget filters; fail-closed API parser; responsive queue | Candidate-complete; do not close globally |
| `JOB-009` | Deterministically ordered dependency nodes/edges, transitive critical paths, cycle/invalid terminals, and explicit blocker reasons | Candidate-complete; do not close globally |
| `JOB-014` | Typed editor, local/backend validation, save → exact backend preview → publish lock, shared brief renderer, byte-preserving preview/dispatch responses | Partial: actual `AgentOsJobExecutor.prompt` parity and central contract CAS remain |
| `JOB-015` | Deterministic provider/model/access/capability/workspace/capacity matching with explicit no-winner evidence and no fallback | Candidate-complete; do not close globally |
| `JOB-GATE` | Valid publish, dependency enforcement, deterministic match, one assignment, one job, one delivery/session/start under replay and concurrency | Backend gate proven; do not close before integrated exact-head evidence |
| `JOB-012` | Requires the real Team domain and intentional collaborative assignment | Open by design; no claim made |

## Preserved invariants

- Only published `open` contracts are advertised or matchable.
- Malformed Open Work state is omitted rather than coerced.
- Dependency-blocked work cannot be matched or dispatched.
- Required provider, model, access profile, capabilities, workspace, per-profile capacity, and
  global current capacity are checked from declared state.
- Missing or unsupported providers never silently fall back.
- Match and dispatch recompute current evidence and require the exact market version.
- Assignment reservation and job creation share the outer database transaction.
- Dispatch requires explicit confirmation and a retained idempotency key.
- Concurrent/replayed callers produce exactly one assignment, job, delivery, session, and start.
- Missing central operator composition fails dispatch closed with `403`.
- Preview runs in a rollback transaction and does not mutate the persisted contract.
- Dirty editor state cannot preview or publish; a preview is bound to its source market version,
  not the hypothetical version returned by rollback rendering.
- The realized dispatch brief remains visible until an explicit queue refresh.

## Verification

Environment was explicitly restored to Node `22.20.0` / npm `10.9.3`; no `.env` files exist in
the lane, backend, or frontend worktrees.

| Gate | Exact result |
| --- | --- |
| Combined focused service/API/UI | 5 files / 33 tests passed |
| Adjacent Agent OS domains | 4 files / 51 tests passed |
| Root TypeScript | `npx tsc --noEmit` passed |
| Root build | `npm run build` passed |
| Web TypeScript | `cd web && npx tsc --noEmit` passed |
| Web build | `cd web && npm run build` passed |
| Diff hygiene | `git diff --check` passed |
| Secret scan | Gitleaks 8.30.1 scanned the 4-commit code range / ~293.05 KB; no leaks |
| GitNexus aggregate | Compare to exact base: 12 changed files, 0 indexed changed/affected symbols or processes, LOW risk |
| Isolated Graphify | 6,113 → 6,148 nodes, 14,160 → 14,204 links, 0 dangling links/absolute sources; focused central-integration query resolved the checkpoint at `L109-L123` |

GitNexus pre-edit impact at the exact base reported `JobMarketService` CRITICAL (37),
`JobScheduler` CRITICAL (24), `OrchestrationService` MEDIUM (17), and
`JobAssignmentService` LOW (6). Lane 4 therefore added focused modules instead of modifying
those existing symbols. The new `openWorkPlugin` was not present in the exact-base index, so its
follow-up impact lookup was UNKNOWN/target-not-found; manual scope was the unmounted registrar
default plus its direct API test. Staged review of that fix was LOW risk.

Only Lane 1 should rerun the complete 1,249-test serial/default suites after integration.

## Rendered browser acceptance

A temporary, non-committed Vite harness rendered the committed component without changing
Lane 1-owned `App.tsx` or navigation.

- Desktop `1440 × 1000`: zero page errors, no horizontal overflow, ready and blocked dependency
  states rendered, explicit blocker shown, and blocked matching disabled.
- Editor flow: dirty edits locked preview/publish; save exposed a durable success notice; backend
  preview rendered the exact supplied brief and unlocked publish; publish advanced the displayed
  market version.
- Assignment flow: the selected profile exposed exact provider/model/access/workspace/capacity and
  a 64-character decision digest; confirmation was disabled before the operator checkbox; dispatch
  rendered one durable assignment/job and retained the realized result before explicit refresh.
- Phone `390 × 844`: zero horizontal overflow, every form control stayed within the viewport,
  every visible button measured at least 44 px high, and the single-column editor remained usable.
- Accessibility checks: zero unlabeled form controls, zero unnamed buttons, zero duplicate IDs,
  and keyboard focus used a visible 2 px outline.

Desktop, blocked, dispatch-result, and phone screenshots were captured and visually inspected from
the temporary harness. They were not committed because central shell/navigation integration can
change final framing; Lane 1 should capture final integrated screenshots.

## Central integration required

Lane 1 must:

1. Mount `openWorkPlugin` below `/api/v1/os` using the canonical database and
   `OrchestrationService`.
2. Pass the live supported-provider list, capacity limits, and the real operator authorization
   hook. Omission now fails closed.
3. Add atomic `expected_market_version` compare-and-set semantics to the existing contract PUT and
   publish handlers; the frontend already sends the exact expected version.
4. Delegate the private runtime `AgentOsJobExecutor.prompt` construction to `renderAgentBrief`
   and supply dependency/critical-path context before claiming actual driver-prompt byte parity.
5. Register `OpenWorkView` in `web/src/App.tsx` and project/global navigation.
6. Reconcile central exports, inventories, documentation, package inclusion, and backlog counts
   only after exact-head integration evidence passes.

## External gates deliberately left open

- Figma creation requires the user-mandated team choice between the authenticated Full-seat
  personal team and the second View-only team. No team was guessed and no Figma file was created.
- Clean Linux, iOS, and Android environments were not available in this lane. macOS Chromium
  desktop/phone emulation passed, but device/OS release-candidate gates remain open.
- Time-based dogfood, usage-observation, and staged-release periods remain open.

## Next dependency-ready task

Lane 1 should cherry-pick the exposed commits, perform the six central edits above, capture
integrated desktop/phone screenshots, and run the complete exact-head serial/default suites.
