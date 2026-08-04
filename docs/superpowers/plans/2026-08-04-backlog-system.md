# Backlog System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ranked, gated, traceable backlog with a kanban web view — spec: `docs/superpowers/specs/2026-08-04-backlog-system-design.md`.

**Architecture:** Additive columns on `cards`/`milestones` (rank, epic status/outcome), readiness derived from existing `task_contracts`, `orchestra next` claims top-ranked ready card in one transaction, new `kanban` board tab with HTML5 drag-drop, read-only ledger endpoint assembling existing events.

**Tech Stack:** better-sqlite3, Fastify (src/server.ts), commander CLI (src/cli.ts), React (web/src), vitest.

## Global Constraints

- Column names `backlog|in_progress|blocked|review|done` and card-event shapes are cross-agent contracts — never change them; schema changes additive only.
- Readiness gate applies only to backlog picking; agents may still create cards straight into `in_progress`.
- Kanban moves reuse existing endpoints (`/cards/:id/move`, approve flow for done); `done` still requires operator.
- Ledger endpoint is read-only; no new write paths.
- Tests: vitest, in-memory `openDb(':memory:')` like `test/reaper.test.ts`.

---

### Task 1: Schema + rank service (P1)

**Files:**
- Modify: `src/db.ts` (~line 211, ALTER pattern)
- Create: `src/backlog.ts`
- Test: `test/backlog-rank.test.ts`

**Interfaces:**
- Produces: `rankBetween(db, cardId, {before?, after?, top?, bottom?}): number` (new rank, renormalizes on underflow), `isReady(db, cardId): boolean`, `claimNext(db, boardId, agentName?): Card | null`.

- [ ] Step 1: failing tests (rank midpoint, renormalize, isReady via task_contracts, claimNext atomicity + gate)
- [ ] Step 2: run, verify fail
- [ ] Step 3: implement `src/backlog.ts` + db.ts ALTERs (`cards.rank REAL`, `milestones.status TEXT DEFAULT 'open'`, `milestones.outcome TEXT DEFAULT ''`, `milestones.rank REAL`)
- [ ] Step 4: run, verify pass
- [ ] Step 5: commit

### Task 2: API + CLI (P1)

**Files:**
- Modify: `src/server.ts` (card routes block ~line 736), `src/cli.ts` (card command ~line 440)
- Test: `test/backlog-api.test.ts`

**Interfaces:**
- Produces: `POST /api/v1/cards/:id/rank {before?|after?|top?|bottom?, agent?}` → `{card}`; `POST /api/v1/boards/:id/next {agent}` → `{card}` or 404 `{error:'no ready cards'}`; snapshot cards gain `rank`, `ready`; CLI `orchestra card rank <id> --before/--after/--top/--bottom`, `orchestra next [--agent]`.

- [ ] Steps: failing route tests → implement (routes call backlog.ts; `logEvent` type `'ranked'` payload `{rank}` for audit; `next` emits existing `moved` event) → CLI subcommands → pass → commit

### Task 3: Kanban tab (P1)

**Files:**
- Create: `web/src/KanbanView.tsx`, `web/src/kanban.css`
- Modify: `web/src/boardNavigation.ts` (BOARD_TABS + resolveStoredNavigation), `web/src/BoardSection.tsx`, `web/src/api.ts` (Card type: rank/ready; api helpers rankCard/nextCard)
- Test: `test/web-kanban.test.tsx` if web tests exist, else acceptance via existing pattern; minimum: typecheck + build

**Interfaces:**
- Consumes: snapshot `cards[].rank/ready`, `POST /cards/:id/rank`, `/cards/:id/move`, approve endpoint for done.
- Produces: `KanbanView({snaps, onChange})` — columns Triage(derived)/Backlog/In progress/Review/Blocked/Done(count+expand); drag within Backlog → rank; across → move; filters epic/owner/text; chips: epic tag, DoR badge, staleness dot (thresholds task 5).

- [ ] Steps: tab entry → component with DnD (native draggable/onDrop) → wire api → build + manual check → commit

### Task 4: DoR gate + triage + draft contract (P2)

**Files:**
- Modify: `src/server.ts` (next route already gated by claimNext — verify), `web/src/KanbanView.tsx` (Not-ready badge + "draft contract" action), `web/src/CardDrawer.tsx` (contract editor section if absent)
- Test: extend `test/backlog-api.test.ts`

**Interfaces:**
- Consumes: `TaskContractService` (src/agent-os/task-contracts.ts) via existing `/api/v1/os/cards/:id/contract` routes (verify path; else add thin legacy `PUT /api/v1/cards/:id/contract {objective, acceptance_criteria[]}`).
- Produces: draft-contract prefill parses `DONE WHEN` section from card description.

- [ ] Steps: failing test (unready card not claimable; contract upsert makes it claimable) → implement → UI affordance → pass → commit

### Task 5: Staleness nudges (P2)

**Files:**
- Modify: `src/server.ts` (snapshot: `stale` bool per card), `web/src/KanbanView.tsx` (amber dot + header counter)
- Test: extend `test/backlog-api.test.ts`

**Interfaces:**
- Produces: card `stale: true` when `updated_at` older than per-column threshold (in_progress 3d, review 7d, blocked 7d; env `ORCHESTRA_STALE_DAYS="in_progress:3,review:7,blocked:7"` override).

- [ ] Steps: failing snapshot test with aged fixtures → implement → pass → commit

### Task 6: Epic upgrade (P3)

**Files:**
- Modify: `src/server.ts` (milestone routes: PATCH status/outcome with transition guards), `web/src/Board.tsx` + `web/src/RoadmapView.tsx` (status chip, progress roll-up), `web/src/KanbanView.tsx` (epic filter uses status)
- Test: `test/epics.test.ts`

**Interfaces:**
- Produces: `PATCH /api/v1/milestones/:id {status?, outcome?}`; ship guard: every step card `done` (or detached via existing step removal) else 409; drop always allowed, cards keep `milestone_id`? No — dropped epic detaches its non-done cards (`milestone_id=NULL, step_order=NULL`).

- [ ] Steps: failing transition tests → implement → UI chips → pass → commit

### Task 7: Delivery ledger (P3)

**Files:**
- Modify: `src/server.ts` (GET `/api/v1/cards/:id/ledger`), `web/src/CardDrawer.tsx` (Ledger timeline section)
- Test: `test/card-ledger.test.ts`

**Interfaces:**
- Produces: `{origin: {created_at, creator, milestone}, contract: {objective, criteria, version} | null, work: {branch, commits: [...from card_events 'shipped'/'moved' payloads...]}, reviews: [review_decision events], verification: latest verification event | null, shipped: shipped-record | null}` — all from existing tables (`cards`, `card_events`, `task_contracts`, `milestones`).

- [ ] Steps: fixture-DB failing test → implement assembly → drawer section → pass → commit

### Task 8: Full suite + deploy

- [ ] `npx tsc --noEmit`, full `npx vitest run` (expect only the pre-existing docs-drift failure), `npm run build`, `detect_changes`, orchestra cards → review.
