# Backlog System Design — rank, kanban, readiness, epics, ledger

**Date:** 2026-08-04 · **Status:** approved by operator · **Approach:** extend the legacy card system in place (Approach A)

## Problem

The backlog replicates none of the practices large engineering teams rely on:

- Cards have no priority or rank — the board renders by card id, so neither humans nor agents can tell what to pick up next.
- No hierarchy above cards — milestones exist but carry only title/description, so big efforts are scattered loose cards.
- Weak traceability — the chain idea → card → branch/commits → review → shipped result exists in fragments (card_events, shipped view, verification events) but is never assembled.
- No lifecycle hygiene — cards idle in review/blocked indefinitely; nothing distinguishes groomed, ready work from raw notes.
- No kanban surface — the web app has no GitHub-issues-style column board for seeing flow at a glance.

## Constraints

- Column names (`backlog`/`in_progress`/`review`/`blocked`/`done`) and card-event shapes are cross-agent contracts — do not change them. All schema changes are additive.
- Agents must keep their current freedom to self-register cards directly into `in_progress`; readiness gating applies only to picking work *from the backlog*.
- Existing accept-to-done and review-gate flows are preserved; the kanban UI performs the same moves the CLI does today.
- The delivery ledger is a read-only projection — no new write paths.

## Design

### 1. Data model (additive)

- `cards.rank REAL` — smaller = higher priority; NULL = unranked. Insertion between neighbors uses the midpoint; when a gap underflows (< 1e-9), renormalize the board's backlog ranks to integers in one transaction.
- `milestones.status TEXT NOT NULL DEFAULT 'open'` (`open`|`shipped`|`dropped`), `milestones.outcome TEXT NOT NULL DEFAULT ''`, `milestones.rank REAL` — milestones become epics.
- **Definition of Ready (DoR):** a card is *ready* iff it has a `task_contracts` row with a non-empty `objective` and ≥1 entry in `acceptance_criteria`. No new tables.
- **Triage** is a derived lane, not a column value: `column='backlog' AND (NOT ready OR rank IS NULL)`.

### 2. Ranking + `orchestra next`

- One endpoint `POST /api/v1/cards/:id/rank {before?, after?}` computes the new rank server-side (midpoint / renormalize). CLI: `orchestra card rank <id> --before <id> | --after <id> | --top | --bottom`.
- `orchestra next [--agent <name>]` claims the top-ranked ready backlog card: single transaction selects `MIN(rank)` ready card, sets `column='in_progress'`, `owner_agent_id`, emits the existing move card-event. Two concurrent claimers get different cards or a clean "backlog empty" result.

### 3. Kanban view (web)

- New board tab (`BOARD_TABS` entry `kanban`): columns Triage / Backlog / In progress / Review / Blocked / Done (Done collapsed to a count with expand). HTML5 drag-and-drop — no new dependency.
- Drag within Backlog = re-rank (calls the rank endpoint). Drag across columns = existing move endpoints with existing rules (e.g. done is only reachable through the accept flow).
- Filters: epic, owner, free-text. Card chips: rank position, epic tag, DoR badge, staleness dot.

### 4. Hygiene: gates + nudges

- Gate: auto-pick (`orchestra next` and any future auto-dispatch) serves only ready cards. The UI shows "Not ready" on triage cards with a one-click "draft contract" editor pre-filled from the description's `DONE WHEN` section.
- Staleness nudges: a card is stale when `updated_at` is older than a per-column threshold (in_progress 3d, review 7d, blocked 7d; configurable via daemon config). Stale cards get an amber flag and a counter in the kanban header. Nothing is ever auto-moved.

### 5. Epics (milestone upgrade)

- `status` transitions: open → shipped (allowed only when every step card is done or explicitly detached), open → dropped (always allowed; cards detach back to loose).
- `outcome` records the shipped result in one paragraph — the epic-level "clean result".
- Kanban epic filter; epic progress roll-up (done steps / total) in board groups and roadmap.

### 6. Delivery ledger (read-only projection)

- `GET /api/v1/cards/:id/ledger` assembles, from existing tables only: origin (creator agent, source idea, epic) → contract objective/criteria/version → branch + commits (card_events, `cards.branch`) → review decisions → verification events → shipped/delivery record.
- Rendered as a "Ledger" timeline section in the card drawer. Epic drawers roll up their cards' ledgers plus the epic outcome.

### 7. Testing & failure modes

- Unit tests: rank midpoint/renormalization, `next` claim atomicity under concurrent claimers, DoR predicate, epic status transition guards, ledger assembly against a fixture DB.
- UI: extend the existing acceptance-test pattern to the kanban tab (render, drag-rank call shape, gate badges).
- Concurrency: rank writes are last-write-wins (ordering only, no data loss); claims and renormalization are transactional.

## Delivery phases (independently shippable)

1. **P1 — rank + kanban tab + `orchestra next`** (kills "misordered")
2. **P2 — DoR gate + triage lane + staleness nudges**
3. **P3 — epic upgrade + delivery ledger**

## Out of scope

- Moving the backlog to the Agent OS job-market layer (Approach B) — revisit after P3.
- Auto-archival or any automatic card movement.
- Estimation/story points, sprints, burndown — YAGNI for an agent-driven board.
