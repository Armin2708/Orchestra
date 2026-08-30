# Org collaboration: a true shared workspace for people's agents

Date: 2026-08-30 · Card: #309 · Author: onyx-otter

## Problem

Org sync moves *state* one way (card.create out; everything in) but supports no *interaction*:
local moves/claims/edits never reach the hub, agents on different machines cannot message each
other, milestones stay local, and the cloud board shows presence but not what an agent holds.

## Design

All phases reuse the existing pipeline: local bus → `mapLocalChange` → outbox → `postOp`,
and hub events → SSE → `LocalBoardState.apply` → projection. No new transports.

### P1 — hub accepts `blocked`
`CARD_COLUMNS` in src/hub/cards.ts gains `blocked` (no SQL CHECK exists; web `LANES` already
renders the lane). Old hubs 400 the op — the daemon marks it failed and the board self-heals
from the next inbound event.

### P2 — two-way card sync (update / move / claim)
- `org_sync_card_mappings` gains `last_synced_snapshot` (JSON of title|description|column|owner|paths).
  Written on every inbound projection and on every outbound enqueue.
- `mapLocalChange` now returns `LocalHubOp[]`. For a mapped card it diffs the bus event's full
  card row against the snapshot: content delta → `card.update`, column delta → `card.move`,
  owner delta → `card.claim`. Version chaining: `expected_version` = stored `hub_version`,
  incremented per version-bumping op in the same batch; the mapping is optimistically advanced
  (snapshot + hub_version) at enqueue so later bus events diff against what is already queued.
- Echo suppression is the snapshot itself: a projected inbound change stores the snapshot before
  the bus event loops back, so the diff is empty. Conflicts (409) stay resolved as today: the op
  is dropped and the next inbound event overwrites local state — hub is the source of truth.
- **Create-echo exception (decided during implementation):** for the echo of our OWN
  `card.create`/`milestone.create`, local wins. The local row may have been edited in the window
  before the echo landed (create card → attach milestone immediately, the funnel's normal flow);
  overwriting it would silently revert those edits. Instead the projection keeps the local row,
  records the hub state as the synced baseline, and re-publishes the row — its bus echo diffs
  into catch-up ops that converge the hub to the local edits.
- Hub `optionalBoundedString` rejected '' — cards/milestones with empty descriptions were
  unsyncable (found by e2e). New `emptyableBoundedString` used for description fields.
- Not supported by the hub, deliberately skipped: card delete, unclaim (owner→null).
- Known limitation (pre-existing hub design): `from_agent` on `mail.send` is client-asserted;
  any org device can write any agent name. Fine within a trusted org, revisit before open orgs.

### P3 — agent↔agent mail across machines
- Outbound: bus `message` events on the org board map to `mail.send` (names resolved from local
  agent ids; `mail_type='organization_sync'` rows are inbound projections and are skipped —
  that marker is the echo gate). New `org_sync_mail_mappings` (org_id, local_message_id,
  hub_mail_id, outbound_idempotency_key) records enqueues.
- Inbound `#projectMail`: skip when the event's idempotency key is one of ours (echo); otherwise
  if `to_agent` names a *local* agent (org_sync_remote_origin IS NULL) on this machine, insert
  the message on that agent's own board so real delivery paths (snapshot, hooks, inbox) fire —
  the shadow-agent insert on the org board remains the fallback for everyone else.
- Skipped v1: attachments, reply threading across the hub (reply_to not mapped).

### P4 — presence carries the held card
`listLocalPresenceAgents` also resolves, per agent name, the hub card id of an org-board card
they own that is in_progress (via org_sync_boards + mappings). `PresencePublisher` sends it as
`current_card_id`; HubBoard's roster shows "on #N".

### P5 — shared milestones
- Hub migration 007: `milestones` (id, org_id, board_id, title, description) +
  `cards.milestone_id`; ops `milestone.create/update/delete`, `card.update` accepts
  `milestone_id`; events `milestone.*`.
- Sync: local bus `milestone` events (incl. `{deleted}`) map outbound with a new
  `org_sync_milestone_mappings`; inbound projection mirrors into local `milestones` +
  `cards.milestone_id`. HubBoard shows a milestone strip grouping cards.

### P6 — surface
`orchestra org board` prints the local org board id + a hint how to message a teammate's agent.
Docs: cli_commands entry; no new HTTP routes (threat-matrix counts unchanged).

## Trust boundary (unchanged, verified by test)
Only the org's own local board syncs out (cc26522) — new outbound mappers keep the same gate;
a personal-board message/milestone must never reach the hub (asserted in e2e).

## Tests
Unit: diff→ops mapping, echo suppression, version chaining, mail echo + local re-route,
milestone projection. E2E (org-sync-e2e): move/claim/edit on daemon A visible on B; claim race
409; mail A→B lands on B's real agent's board; personal boards leak nothing; outbox quiesces
(no echo storms).
