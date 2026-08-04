# Teams Tab — Design

Date: 2026-08-04 · Author: violet-lynx (with arminrad)

## Goal

Replace the Agents tab with a **Teams** tab. Instead of hiring individual agents one by one, the
operator designs (or has designed) whole teams with hierarchy, roles, and workflows that mimic
high-scale engineering orgs, then hires a team as a unit and runs work through it.

## Decisions (locked with operator)

1. **Mastermind designs, operator approves.** A special "mastermind" agent takes a goal/brief and
   proposes a full team structure (roles, hierarchy, workflow stages) as a *draft*. The operator can
   edit, then approve. Designing a team never spawns worker agents.
2. **Hiring a team spawns only the lead.** The team lead hires members on demand as work requires
   them (bounded by the approved spec) and can release idle members.
3. **Task flow: both paths.** A board card can be assigned to a team, and the operator can chat with
   the lead directly like a manager. Both feed the same team work queue; the lead decomposes,
   assigns to roles per the workflow, reviews results, and reports back.
4. **Teams tab replaces Agents.** Solo agents remain visible under an "Individual contributors"
   section so nothing existing is lost.

## Approach (C — hybrid)

Reuse the primitives that already work — `hire`/`launch` for spawning, `ask`/`reply`/`task` board
messages for hierarchy communication, cards/jobs for work, `TeamPlanningVisualization` for the org
chart — and add a **thin team layer** on top. The heavyweight dormant planning machinery
(`os_team_delegations`, integrations, command receipts) is left untouched; it models planning
sessions, not living teams.

## Data model

New light tables in the main DB (same pattern as `backlog.ts`):

```
teams:        id, board_id, name, goal, status(draft|approved|hired|archived),
              lead_agent (name once hired), spec_json, created_at, updated_at
```

`spec_json` (TeamSpec) is the mastermind's/operator's structure:

```ts
type TeamSpec = {
  roles: Array<{
    key: string            // 'lead' | 'staff-eng' | 'reviewer' | 'qa' | ...
    title: string          // "Engineering Lead"
    charter: string        // what this role does, in prose (injected into the agent's brief)
    provider?: string; model?: string; effort?: string
    reports_to: string | null   // role key; null only for the lead
    max_agents: number     // how many live agents this role may have at once
  }>
  workflow: Array<{ stage: string; role: string; gate?: 'review' | 'none' }>
  // e.g. [{stage:'design',role:'lead'},{stage:'implement',role:'staff-eng'},
  //       {stage:'review',role:'reviewer',gate:'review'},{stage:'qa',role:'qa'}]
  norms?: string           // team-wide working agreements injected into every member brief
}
```

Exactly one role has `reports_to: null` — the lead. Hierarchy = the `reports_to` edges.

## Server API

- `POST  /api/v1/boards/:id/teams` — create draft team (manual or from mastermind output)
- `GET   /api/v1/boards/:id/teams` — list teams (+ live member state joined from `agents`)
- `GET   /api/v1/teams/:id` / `PATCH` — read/edit spec while draft; `DELETE` archive
- `POST  /api/v1/teams/:id/approve` — draft → approved
- `POST  /api/v1/teams/:id/hire` — approved → hired: spawns the lead via existing
  `maestro.hire`, with a lead brief composed from goal + spec + team norms
- `POST  /api/v1/teams/:id/design` — hire/reuse the mastermind agent and hand it the goal;
  mastermind replies with a TeamSpec draft (structured), stored on the team
- `POST  /api/v1/cards/:id/assign-team` — assign card to a team: queues it and notifies the
  lead via the existing message-injection path (`task` kind)

Members hired by the lead carry `team_id` + `role_key` (new nullable columns on `agents`), so the
UI can group live agents by team and the lead's hires are bounded by `max_agents` per role.

Lead capability: leads (and only leads) may call the existing hire API through a new
`orchestra team hire-member <role>` CLI command that validates against the spec.

## Mastermind

A reserved agent role (`mastermind`), hired like any agent but with a design charter: interview the
goal, produce a TeamSpec (JSON) modeled on real tech-org shapes (EM/TL, ICs, reviewer, QA, docs...).
It never hires anyone. Its output lands as a draft team in the UI for approval.

## UI

- `boardNavigation.ts`: tab `agents` → `teams` (label "Teams").
- `TeamsView.tsx` (new): overview grid in the style of the board overview — one card per team
  (name, goal, status, lead, live members, queue depth) + "Individual contributors" section listing
  non-team agents (current AgentHome roster behavior preserved via drill-down to agent terminal).
- Team detail: org chart (reuse `TeamPlanningVisualization` node/edge shape), member list with live
  status, work queue (cards assigned to the team), and the lead's conversation (existing
  `AgentTerminal`).
- Create team flow: "New team" → describe goal → mastermind drafts → editable spec (roles table +
  hierarchy) → Approve → Hire team.

## Communication & hierarchy at runtime

No new messaging primitives. The lead receives card assignments as injected `task` messages;
delegates via `task` messages to members; members report via `reply`; review gates are the lead (or
reviewer role) reviewing before the card moves. Escalation = lead asks the operator via the
existing operator-mail path.

## Error handling

- Hire refuses non-approved specs, specs without exactly one lead, or cycles in `reports_to`.
- Lead hire-member refuses roles at `max_agents` or unknown role keys.
- Team archive releases members (existing release semantics) before archiving.

## Testing

Vitest for spec validation, CRUD/approve/hire lifecycle, assign-team queue + lead notification,
member-hire bounds; UI covered by existing board-nav tests updated for the new tab plus a
teams-view test.

## Phases (tickets)

1. **Teams core:** data model + CRUD/approve/hire APIs + lead spawn (server).
2. **Mastermind:** design endpoint + charter + structured TeamSpec output.
3. **Teams tab UI:** replace Agents tab, overview grid, team detail, create/approve/hire flow.
4. **Team runtime:** card→team assignment, lead member-hire CLI, role briefs, review-gate norms.
