# Agent OS surface inventory

Status: exact observed baseline at `18de61c764ca30fbc06a34f58348866222f438f5`.

This inventory separates the original Board product from the canonical Agent OS and the bridges
that keep both usable during migration. The machine-readable source of truth is
[`agent-os-surface-inventory.json`](./agent-os-surface-inventory.json); the executable drift check
is `test/agent-os-baseline-docs.test.ts`.

## TL;DR

| Surface | Canonical | Compatibility | Legacy | Infrastructure | Total |
|---|---:|---:|---:|---:|---:|
| SQLite application tables | 29 | 3 | 10 | 2 | 44 |
| Registered HTTP routes | 83 | 29 | 25 | 9 | 146 |
| CLI command families/subcommands | 77 | 5 | 18 | 8 | 108 |

Classification does not mean “safe to delete.” Compatibility and legacy surfaces remain supported
until migration telemetry and release gates allow removal.

## Classification

- **Canonical:** durable Agent OS state or an interface under `/api/v1/os`.
- **Compatibility:** a supported legacy-shaped bridge that may project to or gate canonical state,
  but is not itself the canonical source of truth.
- **Legacy:** the original Board, presence, message, milestone, review, and telemetry product.
- **Infrastructure:** shared daemon, auth, streaming, push, settings, and schema machinery.

The source contract is `docs/agent-os-domain.md:102`; route registration is rooted at
`src/server.ts:1406` and `src/agent-os/routes.ts:111`.

## Database tables

The exact live schema is obtained by opening a fresh database, applying every migration, and
reading `sqlite_master`. Base tables are defined in `src/db.ts:9`; Agent OS migrations start at
`src/agent-os/migrations.ts:124`; the migration ledger is created at
`src/agent-os/migrations.ts:1892`.

### Canonical

| Domain | Tables |
|---|---|
| Agent Home | `agent_profiles`, `agent_conversations`, `agent_sessions`, `agent_session_actions`, `conversation_events`, `conversation_event_conflicts` |
| Retention and transcript integrity | `agent_home_retention_policies`, `agent_home_retention_runs`, `agent_home_raw_artifact_archives`, `agent_home_evidence_bundle_repairs`, `agent_home_transcript_repairs` |
| Runtime/workspace | `workspaces`, `workspace_assignments`, `processes`, `process_output`, `daemon_leases` |
| Contract/scheduling | `jobs`, `job_market_contracts`, `job_market_criteria`, `job_market_dependencies` |
| Delivery/evidence | `delivery_reports`, `delivery_deliverable_results`, `delivery_criterion_results`, `artifacts` |
| Control plane | `os_events`, `attention_items`, `policies`, `checkpoints`, `context_items` |

### Compatibility

| Table | Current role |
|---|---|
| `boards` | shared project/board scope used by both products |
| `task_contracts` | card-keyed TaskContract bridge and current canonical launch input |
| `agent_usage` | original agent-keyed usage storage now carrying provider-neutral additions |

### Legacy

| Table | Current role |
|---|---|
| `agents` | Board presence and hired-agent compatibility identity |
| `cards` | original Board task surface |
| `card_events` | original card activity log |
| `messages` | ask/reply/task/notify/announce/swarm transport |
| `message_targets` | explicit fan-out recipient snapshot |
| `deliveries` | message-recipient receipt; **not** a work Delivery |
| `milestones` | ordered Board planning steps |
| `ideas` | Roadmap idea records |
| `review_decisions` | Board approve/send-back record |
| `token_telemetry` | injected-context hook accounting |

### Infrastructure

`kv` stores daemon settings/cache values. `os_schema_migrations` records applied Agent OS
migrations. SQLite's own internal tables are intentionally excluded.

## HTTP APIs

The extractor reads literal Fastify `get/post/put/patch/delete` registrations from
`src/server.ts`, `src/push.ts`, `src/agent-session-controls.ts`,
`src/agent-os/routes.ts`, `src/agent-os/agent-home-routes.ts`, and
`src/agent-os/agent-home-retention-routes.ts`. The seven session action routes are expanded from
`AGENT_HOME_SESSION_ACTIONS` in `src/agent-os/agent-home-lifecycle.ts:26`.

### Canonical routes

```text
DELETE /api/v1/os/workspaces/:id
GET /api/v1/os/agent-profiles/:id
GET /api/v1/os/agent-profiles/:id/conversations
GET /api/v1/os/agent-profiles/:id/home
GET /api/v1/os/agent-profiles/:id/sessions
GET /api/v1/os/boards/:id/agent-profiles
GET /api/v1/os/boards/:id/attention
GET /api/v1/os/boards/:id/conflicts
GET /api/v1/os/boards/:id/events
GET /api/v1/os/boards/:id/jobs
GET /api/v1/os/boards/:id/policies
GET /api/v1/os/boards/:id/retention
GET /api/v1/os/boards/:id/workspaces
GET /api/v1/os/cards/:id/contract
GET /api/v1/os/cards/:id/contract/validate
GET /api/v1/os/cards/:id/deliveries
GET /api/v1/os/cards/:id/evidence
GET /api/v1/os/conversations/:id
GET /api/v1/os/conversations/:id/events
GET /api/v1/os/conversations/:id/events/:eventId
GET /api/v1/os/conversations/:id/export
GET /api/v1/os/conversations/:id/search
GET /api/v1/os/deliveries/:id/export
GET /api/v1/os/drivers
GET /api/v1/os/jobs/:id
GET /api/v1/os/plugins
GET /api/v1/os/processes/:id
GET /api/v1/os/processes/:id/output
GET /api/v1/os/providers
GET /api/v1/os/sessions/:id
GET /api/v1/os/sessions/:id/events
GET /api/v1/os/sessions/:id/export
GET /api/v1/os/sessions/:id/search
GET /api/v1/os/settings/agent-defaults
GET /api/v1/os/workspaces/:id
GET /api/v1/os/workspaces/:id/checkpoints
GET /api/v1/os/workspaces/:id/context
GET /api/v1/os/workspaces/:id/processes
PATCH /api/v1/os/agent-profiles/:id
PATCH /api/v1/os/conversations/:id
PATCH /api/v1/os/workspaces/:id
POST /api/v1/os/agent-profiles/:id/archive
POST /api/v1/os/agent-profiles/:id/conversations
POST /api/v1/os/attention/:id/resolve
POST /api/v1/os/boards/:id/agent-profiles
POST /api/v1/os/boards/:id/jobs
POST /api/v1/os/boards/:id/policies
POST /api/v1/os/boards/:id/retention/run
POST /api/v1/os/boards/:id/workspaces
POST /api/v1/os/cards/:id/contract/publish
POST /api/v1/os/cards/:id/contract/transition
POST /api/v1/os/cards/:id/evidence
POST /api/v1/os/checkpoints/:id/fork
POST /api/v1/os/conversations/:id/archive
POST /api/v1/os/conversations/:id/export
POST /api/v1/os/deliveries/:id/accept
POST /api/v1/os/deliveries/:id/reject
POST /api/v1/os/deliveries/:id/revise
POST /api/v1/os/deliveries/:id/verify
POST /api/v1/os/jobs/:id/cancel
POST /api/v1/os/jobs/:id/deliveries/prepare
POST /api/v1/os/jobs/:id/deliveries/submit
POST /api/v1/os/policies/:id/evaluate
POST /api/v1/os/processes/:id/input
POST /api/v1/os/processes/:id/resize
POST /api/v1/os/processes/:id/restart
POST /api/v1/os/processes/:id/signal
POST /api/v1/os/sessions/:id/archive
POST /api/v1/os/sessions/:id/events
POST /api/v1/os/sessions/:id/export
POST /api/v1/os/sessions/:id/fork
POST /api/v1/os/sessions/:id/link
POST /api/v1/os/sessions/:id/pause
POST /api/v1/os/sessions/:id/rename
POST /api/v1/os/sessions/:id/resume
POST /api/v1/os/sessions/:id/retry
POST /api/v1/os/sessions/:id/stop
POST /api/v1/os/workspaces/:id/checkpoints
POST /api/v1/os/workspaces/:id/processes
PUT /api/v1/os/boards/:id/retention
PUT /api/v1/os/cards/:id/contract
PUT /api/v1/os/settings/agent-defaults
PUT /api/v1/os/workspaces/:id/context
```

### Compatibility routes

```text
DELETE /api/v1/agents/:id
GET /api/v1/agents/:id/inbox
GET /api/v1/agents/:id/mcp
GET /api/v1/agents/:id/transcript
POST /api/v1/agents/:id/access-profile
POST /api/v1/agents/:id/approvals/:requestId
POST /api/v1/agents/:id/effort
POST /api/v1/agents/:id/fire
POST /api/v1/agents/:id/heartbeat
POST /api/v1/agents/:id/interrupt
POST /api/v1/agents/:id/leave
POST /api/v1/agents/:id/mcp/:name/reconnect
POST /api/v1/agents/:id/mcp/:name/toggle
POST /api/v1/agents/:id/model
POST /api/v1/agents/:id/permission-mode
POST /api/v1/agents/:id/permissions/:requestId
POST /api/v1/agents/:id/plugins/reload
POST /api/v1/agents/:id/pulse
POST /api/v1/agents/:id/subping
POST /api/v1/agents/:id/task
POST /api/v1/agents/register
POST /api/v1/cards/:id/approve
POST /api/v1/cards/:id/launch
POST /api/v1/cards/:id/move
POST /api/v1/cards/:id/restore
POST /api/v1/cards/:id/send-back
POST /api/v1/cards/:id/shipped
POST /api/v1/cards/:id/verification
POST /api/v1/cards/:id/verify
```

These routes do not all behave identically. In particular, card launch returns either a canonical
or legacy envelope depending on `ORCHESTRA_CANONICAL_LAUNCH` (`src/server.ts:897`), while Board
review/move routes consult Trackbook gates for managed cards (`src/server.ts:409`,
`src/server.ts:646`).

### Legacy routes

```text
DELETE /api/v1/boards/:id
DELETE /api/v1/cards/:id
DELETE /api/v1/ideas/:id
DELETE /api/v1/messages/:id
DELETE /api/v1/milestones/:id
GET /api/v1/boards
GET /api/v1/boards/:id/events
GET /api/v1/boards/:id/reviews
GET /api/v1/boards/:id/shipped
GET /api/v1/boards/:id/snapshot
GET /api/v1/boards/:id/telemetry
GET /api/v1/boards/:id/timeline
GET /api/v1/cards/:id/events
GET /api/v1/cards/:id/reviews
PATCH /api/v1/cards/:id
POST /api/v1/boards/:id/hire
POST /api/v1/boards/:id/wake
POST /api/v1/boards/resolve
POST /api/v1/cards
POST /api/v1/cards/:id/assign
POST /api/v1/ideas
POST /api/v1/ideas/:id/promote
POST /api/v1/messages
POST /api/v1/milestones
POST /api/v1/milestones/:id/steps
```

Direct Hire is included here because it explicitly returns `mode: "ambient"` and does not create
a canonical contract/job lifecycle (`src/server.ts:1055`).

### Infrastructure routes

```text
GET /api/v1/events
GET /api/v1/push/status
GET /api/v1/push/vapid-key
GET /api/v1/system
GET /health
POST /api/v1/push/ntfy
POST /api/v1/push/subscribe
POST /api/v1/push/test
POST /api/v1/push/unsubscribe
```

`GET /api/v1/events` is the operator-authenticated global SSE stream
(`src/server.ts:1358`). Agent OS event history is the paged durable
`GET /api/v1/os/boards/:id/events`, not SSE.

## CLI API

The exact 108 command paths are machine-checked from `src/cli.ts` and
`src/agent-os-cli.ts`. The compact human map is:

| Class | Command surface |
|---|---|
| Canonical | `agent {list,create,show,home,rename,archive}`; `session {list,show,resume,pause,stop,retry,fork,rename,archive,search,export}`; `retention {show,set,run}`; `workspace {list,create,show,update,archive}`; `process {list,start,output,attach,input,resize,signal,restart}`; `attention {list,resolve}`; `contract {show,set,validate,publish,transition}`; `evidence {list,add}`; `delivery {show,submit,verify,accept,reject,revise,export}`; `context {show,set}`; `checkpoint {list,create,fork}`; `job {list,create,cancel}`; `policy {list,create,evaluate}`; `events`; `conflicts`; `drivers`; `plugins` |
| Compatibility | `hire`; `task`; `fire`; `wake`; `shipped` |
| Legacy | `join`; `card {create,update,move}`; `ask`; `reply`; `notify`; `note`; `announce`; `swarm`; `pulse`; `snapshot`; `idea`; `idea-done`; `ideas`; `milestone`; `step` |
| Infrastructure | `serve`; `stop`; `restart`; `token`; `remote`; `hook`; `install`; `uninstall` |

Root command names and every child command are listed individually in
`agent-os-surface-inventory.json`; the test expands the dynamic Agent Home session-action loop so
those routes and CLI commands cannot drift silently.

## Events and projections

| Ledger/channel | Class | Contract | Source |
|---|---|---|---|
| `conversation_events` | canonical | ordered provider-neutral transcript with 9 closed kinds: `user`, `assistant`, `system`, `tool`, `tool_result`, `approval`, `usage`, `status`, `error` | `src/agent-os/conversations.ts:34` |
| `conversation_event_conflicts` | canonical | retains conflicting provider replay instead of overwriting canonical history | `src/agent-os/conversations.ts:970` |
| `os_events` | canonical | append-only causal operational ledger; open namespaces are enumerated in the JSON inventory | `src/agent-os/event-store.ts:55` |
| `card_events` | legacy | original card activity log and shipped/review compatibility evidence | `src/db.ts:36` |
| `messages` + recipient receipts | legacy | closed message kinds: `ask`, `reply`, `task`, `notify`, `announce`, `swarm` | `src/server.ts:81` |
| global/board SSE bus | mixed | 16 legacy event names plus `os:driver`, `os:runtime`, and `os:workspace`; it is live fan-out, not durable truth | `src/server.ts:112`, `src/agent-os/runtime-integration.ts:1596` |
| `LegacyEventProjection` | compatibility | projects `legacy.<bus-type>` into `os_events` and creates selected attention items | `src/agent-os/legacy-projection.ts:23` |

Provider Driver events have the closed types `output`, `status`, `tool`, `error`, and `exit`
(`src/runtime/types.ts:204`). Runtime PTY events have 11 closed `process.*` kinds
(`src/runtime/types.ts:113`). `os_events` intentionally allows versioned domain namespaces because
Job, Delivery, lifecycle, and compatibility helpers accept a kind parameter. The drift test
therefore exact-checks the closed vocabularies and source-backs the open namespace list instead of
pretending the open ledger is an enum.

Safe projection is part of the event boundary: raw approval parameters, credential-shaped content,
Codex reasoning, and Claude thinking must not enter managed `os_events`; the full approval form is
live operator state, not durable event payload.

## UI surfaces

Primary navigation is defined in `web/src/App.tsx` and `web/src/boardNavigation.ts`; composition is
in `web/src/BoardSection.tsx`.

| Surface | Class | Implementation |
|---|---|---|
| Board → Overview | legacy | `web/src/Board.tsx` |
| Board → Agents / Agent Home | canonical | `web/src/AgentHome.tsx` |
| Board → Messages | legacy | `web/src/MessagesView.tsx` |
| Board → Workspace | canonical | `web/src/WorkspaceCockpit.tsx` |
| Board → Timeline | legacy | `web/src/TimelineView.tsx` |
| Board → Shipped | compatibility | `web/src/ShippedView.tsx` |
| Roadmap | legacy | `web/src/RoadmapView.tsx` |
| Settings | infrastructure | `web/src/SettingsView.tsx` |
| Needs You | canonical | `web/src/NeedsYou.tsx` |
| Card Trackbook summary/review buttons | compatibility | `web/src/CardTrackbookSummary.tsx`, `web/src/CardDrawer.tsx` |
| Agent Home mobile panes | canonical | Conversation, Terminal, Details (`web/src/AgentHome.tsx:729`) |
| Agent Home detail tabs | canonical | Work, Context, Tools, Usage, History (`web/src/AgentHomePanels.tsx:442`) |
| Workspace panes | canonical except compatibility Agent conversation | Terminal, Agent, Changes, Trackbook, Processes, Context, Policy (`web/src/WorkspaceCockpit.tsx:40`) |
| Phone install surface | infrastructure | responsive web UI plus `web/public/manifest.webmanifest` |

There is one responsive web application, not a separate phone product. The exact UI evidence
markers are listed in the JSON inventory and fail the drift test if removed or renamed.

## Planned nouns that do not have current surfaces

The canonical domain document names the target, but the schema/routes/UI above prove these are not
implemented yet:

| Planned domain | Current nearest surface | Missing canonical boundary |
|---|---|---|
| Discussion / DiscussionPost | `messages`, Messages UI | durable topics/posts, accepted answer, subscriptions, search, decision/knowledge promotion |
| Team / PlanningSession | explicit `swarm` transport | bounded participants/roles/budgets/rounds/proposals/synthesis |
| Conflict | computed workspace overlap + attention | durable collision, negotiation, proposals, arbiter, rationale, resolution/follow-up |
| KnowledgeItem / ContextBuild / ContextUse | `context_items` manifest | cited freshness-aware compiler, deterministic build/use and outcome record |
| DeviceSession | `orchestra remote` master-token QR | named expiring scoped revocable credential, device attribution, step-up |

Absence is a product fact, not a migration failure. These nouns must not be shown as delivered
until their own tables/services/APIs/UI and acceptance evidence exist.

## Drift-check contract

Run:

```sh
/Users/arminrad/.nvm/versions/node/v22.20.0/bin/node \
  ./node_modules/vitest/vitest.mjs run test/agent-os-baseline-docs.test.ts
```

The test:

1. opens a fresh in-memory database and exact-compares every application table;
2. extracts every registered literal HTTP route, applies Agent OS prefixes, expands session
   actions, and exact-compares all 146 signatures;
3. extracts every Commander root/subcommand and exact-compares all 108 command paths;
4. exact-compares closed message, conversation, driver, runtime, workspace, and session-action
   vocabularies;
5. exact-compares legacy/canonical live-bus names;
6. verifies that every UI inventory entry still has its source evidence marker.

A new or removed table, route, command, closed event kind, or declared UI surface breaks the test
until an engineer deliberately classifies it and updates this document/manifest. Human review is
still required for classification changes, dynamic open `os_events` namespaces, and determining
whether a compatibility surface can be retired.
