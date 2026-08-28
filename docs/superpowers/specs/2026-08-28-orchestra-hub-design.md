# Orchestra Hub — Hosted Multi-User Orgs (Design)

**Date:** 2026-08-28
**Status:** Draft — awaiting operator approval
**Approach:** "A" — hub mode inside this repo; local daemons sync to a hosted, multi-tenant, Postgres-backed hub. Local product stays free (FSL-1.1-ALv2); hosted orgs are paid.
**Stack (operator-chosen):** Stripe (billing), Supabase (Postgres), Clerk (human auth + org membership).

## 1. Problem & Goals

Orchestra today is single-machine: one daemon, one operator, agents coordinating through a local board. Teams want the same coordination across machines: a team creates an **org**, members connect their local daemons, and everyone sees one shared board with every member's agents — presence, activity, cards, and agent-to-agent mail — in real time.

**Goals (v1):**

- Hosted hub server: users sign up, pay, create an org, invite members.
- Members join with one command; their existing local daemon syncs to the org.
- Shared org board: all cards, all agents, owner badges, live presence, one-line activity per agent.
- Cross-machine agent mail (`orchestra ask` / `orchestra mail` addressed to a remote agent routes via hub).
- Server-authoritative shared state — overlapping claims are impossible by construction.
- Billing: org creation gated on an active Stripe subscription (flat per-org plan, seat cap).

**Non-goals (v1):**

- Viewing other members' agent transcripts or terminals (only one-line activity).
- Driving/prompting another member's agents.
- File-level locks beyond card claims.
- Multiple pricing tiers, SSO/SAML, audit-log UI.
- Syncing code. Code truth stays in git; the hub carries coordination state only.

## 2. Architecture Overview

```
Member A machine                Hosted hub (Fly/Railway)          Member B machine
┌──────────────────┐            ┌──────────────────────┐          ┌──────────────────┐
│ agents ⇄ hooks   │            │  hub server (Node,   │          │ agents ⇄ hooks   │
│  ⇄ local daemon  │◀──WS/REST─▶│  same Fastify core)  │◀─WS/REST▶│  ⇄ local daemon  │
│  (localhost API  │            │        │             │          │                  │
│   unchanged)     │            │    Postgres          │          │                  │
└──────────────────┘            └──────────▲───────────┘          └──────────────────┘
                                           │
                                 Hosted web UI (existing React app + org mode)
                                 Stripe (Checkout + webhooks)
```

- **Hub server** — new entrypoint (`orchestra hub`) in this repo. Reuses the existing Fastify server core and shared TypeScript event/entity types; storage is **Supabase Postgres** (used as plain Postgres: our own migrations and SQL — no Supabase client SDK, RLS, or Realtime; the hub's own seq-based event stream is the realtime layer). Multi-tenant: every row and every event is org-scoped.
- **Daemon sync client** — new module in the local daemon. Agents, hooks, and the CLI keep talking to `localhost` exactly as today; the daemon relays org-scoped writes to the hub and applies the hub's event stream into its local view.
- **Web UI** — the existing React board app pointed at the hub API, plus sign-up/login, org switcher, invite management, and billing screens.
- **Source of truth** — the hub owns all shared state (orgs, members, boards, cards, claims, mail, presence). Local daemons own their agents' processes, worktrees, and anything not org-shared. Code truth stays in git.

## 3. Data Model (Postgres)

All shared tables carry `org_id`; every query is org-scoped by middleware, never by convention.

Identity and membership are **owned by Clerk** (users, organizations, memberships, invitations). Postgres keeps thin mirror rows — synced by Clerk webhooks — so the rest of the schema has real foreign keys and org-scoped queries never call Clerk on the hot path.

| Table | Purpose / key columns |
|-------|----------------------|
| `users` | mirror: clerk_user_id (unique), email, display name |
| `orgs` | mirror + hub-owned fields: clerk_org_id (unique), name, slug, seat_cap, status (`active` / `suspended`) |
| `memberships` | mirror: user_id + org_id, role (`owner` / `admin` / `member`) |
| `subscriptions` | org_id, stripe_customer_id, stripe_subscription_id, status, current_period_end |
| `devices` | org_id + membership_id, token hash, name (hostname), last_seen_at, revoked_at |
| `projects` | org_id, name, repo identity (remote URL fingerprint) — maps members' local checkouts of the same repo to one board |
| `boards` | org_id + project_id |
| `cards` | board_id, number, title, desc, column, paths, owner agent, **version** (int, optimistic concurrency) |
| `card_events` | append-only card history; carries the org `seq` |
| `mail` | org-scoped agent mail; from/to include agent + device identity; dead-letter status per the existing #47 contract |
| `agents` | registry + presence: name, device_id, state (`working` / `idle` / `waiting` / `offline`), current card, activity line, last_heartbeat_at |
| `org_events` | append-only event log, monotonic `seq` per org — the sync backbone |

Entity shapes mirror the local sidecar so daemon↔hub translation is mostly 1:1, and the shared TypeScript types are the single definition for both sides.

## 4. Auth & Billing

**Humans (web UI):** **Clerk** — hosted sign-in/sign-up components in the web app; the hub verifies Clerk session JWTs in middleware. Org creation, membership, roles, and invitations use **Clerk Organizations**; Clerk webhooks (`user.*`, `organization.*`, `organizationMembership.*`) keep the Postgres mirror tables current. Seat cap enforced by the hub when a membership webhook lands (over cap ⇒ membership rejected/flagged).

**Daemons:** `orchestra org join` prints a hub URL; the member authenticates there via Clerk, picks the org, and the hub mints a **device token** (hub-owned, long-lived, hashed at rest, scoped to one org + membership; a paste-token fallback for headless machines). The daemon stores it under `ORCHESTRA_HOME` and sends it as a bearer token on WS connect and REST calls — daemons never talk to Clerk. Members can list and revoke their devices; org admins can revoke any device.

**Authorization:** role checks (from mirrored memberships) on org admin actions; all agent-level actions (cards, mail, presence) require an active membership + non-revoked device. If a member is removed in Clerk, the webhook revokes their devices.

**Billing:** creating an org requires completing Stripe Checkout (flat per-org monthly plan, seat cap enforced at invite acceptance). Stripe webhooks (`checkout.session.completed`, `customer.subscription.updated/deleted`) update `subscriptions.status`. Lapsed subscription ⇒ org `suspended`: reads still work (nobody's data is hostage), all writes are rejected with a clear error until payment resumes. Webhook handler is idempotent and signature-verified.

**Free/paid boundary:** the local single-machine product remains fully free under FSL-1.1-ALv2 (which also bars third parties from selling Orchestra hosting). The hub code lives in this same public repo; the paid thing is the hosted service, not the code.

## 5. Sync Protocol

**Transport:** one WebSocket per daemon per org: `wss://hub/orgs/:id/sync`, bearer device token. REST exists for the same ops (web UI uses it); WS is the daemon path.

**Events out (hub → daemon):** every committed shared-state change is appended to `org_events` with a per-org monotonic `seq`, then fanned out to connected daemons and web clients. Daemons persist their last applied `seq` and resume with `?since=<seq>` after any disconnect — replay is a range read of `org_events`. No gaps, no heuristic merging.

**Ops in (daemon → hub):** commands, not state dumps: `card.create`, `card.move`, `card.claim`, `card.update`, `mail.send`, `agent.heartbeat`, `agent.register`. Each op carries a client-generated idempotency key (UUID) so offline-queue replay after reconnect cannot double-apply.

**Conflict rule (the overlap-avoidance core):** every card write carries the card `version` the daemon last saw. The hub applies ops atomically (single Postgres transaction, `WHERE version = $expected`); first writer wins, the loser gets a **409 + the current card state**. The daemon surfaces the 409 to the agent as the existing board-etiquette failure: card is claimed/changed ⇒ `orchestra ask` the owner. Claims are therefore race-free by construction — two agents on two machines can both try to claim card #12; exactly one succeeds.

**Offline:** a disconnected daemon keeps working locally in read-only-ish mode: reads serve the last synced view (staleness marked in UI); writes to org state are queued (bounded queue, ~500 ops) and replayed on reconnect, where each replayed op individually succeeds or 409s. Queue overflow or long partition ⇒ writes fail fast with "org offline" rather than queueing unboundedly.

**Local ↔ org boards:** a daemon can serve both local-only boards (today's behavior, no hub involved) and org boards (hub-synced). `orchestra org join` links a local project directory to an org project by repo identity; from then on that board's state lives on the hub.

## 6. Presence & Activity

Each daemon heartbeats every ~15s per live agent: `{agent, state, card, activity}` where `activity` is the existing one-line `agentActivity` summary (e.g. "editing src/server.ts"). The hub marks an agent `offline` when heartbeats lapse past 45s (TTL sweep). Presence is ephemeral — latest state only, not part of `org_events` replay (no history, no transcripts, matching the "not too much detail" requirement).

## 7. Web UI

The existing React app gains a **hub mode**: Clerk sign-in/sign-up and org-switcher/invite components (Clerk's prebuilt React components), a billing page (Stripe-hosted portal link), and the org board. The org board is the existing board UI with per-agent additions: owner badge (which member), presence dot, activity line. Realtime via the same org event stream (WS) the daemons use. Board, Kanban, and mail views reuse existing components.

## 8. Deployment & Ops (v1)

- One hub deploy on Fly.io or Railway; DB is **Supabase Postgres** (connect via Supabase's session pooler — the hub is a long-lived server). TLS terminated by the platform.
- Config via env: `DATABASE_URL` (Supabase), `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`, `CLERK_WEBHOOK_SECRET`, `HUB_BASE_URL`.
- Migrations: plain SQL migration files run at boot (same pattern as the local sidecar's numbered migrations).
- Backups: Supabase daily snapshots. No multi-region, no HA in v1 — brief hub downtime degrades to the daemon offline mode above.

## 9. Security Notes

- Org scoping enforced in one middleware layer (device/session ⇒ org id), not per-handler.
- Device tokens hashed at rest; shown once at mint.
- Stripe webhook signature verification; idempotent handlers.
- Rate limits on auth endpoints and per-device op rate on the WS.
- Mail/card payloads are member content — no execution, rendered as text/markdown in UI (existing sanitization path).
- New routes must be added to `agent-os-surface-inventory.json`/`.md` and threat-matrix counts recomputed (standing repo rule).

## 10. Testing

Hermetic, no live network:

- **Sync core:** two simulated daemons against a real throwaway Postgres (dockerized or `pglite`): concurrent `card.claim` ⇒ exactly one winner, loser gets 409 + current state; disconnect/reconnect resumes from `seq` with no gaps or duplicates; idempotency-key replay applies once.
- **Billing gate:** mocked Stripe webhooks drive `subscriptions.status`; suspended org rejects writes, allows reads.
- **Auth:** Clerk mocked at the middleware boundary (stub JWT verifier) and via synthetic webhook payloads driving the mirror tables; membership-removal webhook revokes devices; seat cap; device revocation kills the WS and rejects the token.
- **Presence:** heartbeat TTL flips state to offline.
- Existing local-mode test suite must stay green untouched — hub mode is additive.

## 11. Build Order (input to the implementation plan)

1. Shared types + `org_events`/seq sync core (hub side, in-memory clients in tests).
2. Postgres schema + migrations + org-scoped Fastify hub entrypoint.
3. Auth: Clerk integration (JWT middleware + webhook mirror) + hub device tokens.
4. Daemon sync client (join, WS, op queue, 409 surfacing) + cross-machine mail.
5. Presence heartbeats.
6. Web UI hub mode (login, org switcher, org board).
7. Stripe billing gate.
8. Deploy recipe (Fly/Railway) + docs.
