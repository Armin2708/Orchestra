# Inbox revamp: email-style Messages tab

**Date:** 2026-08-04 · **Card:** #99 · **Author:** slate-newt

## Goal

Replace the Messages feed with an email-style inbox. Agents working on the board send the
operator direct messages; the operator triages, reads, and replies inline from one place.
Replies are delivered back to the sending agent over the existing bus (which wakes hired
agents instantly).

## Approach (hybrid — chosen)

Reuse the existing message bus (`messages` table, kinds ask/reply/task/notify/announce/swarm,
`reply_to` threading, `from_name`/`to_name` where `null` = the human). No new tables, no new
message kinds. Email semantics are a presentation convention: **first line of the body =
subject**, rest = preview/body.

Rejected: a dedicated `orchestra mail` contract (new kind + CLI verb) — richer but breaks
cross-agent contracts for no added delivery capability; the bus already threads, delivers,
and wakes.

## Producer gap: agents cannot address the operator

`orchestra ask <to>` requires an agent name; unknown names 400. Fix server-side:

- `POST /api/v1/messages` maps `to ∈ {human, operator, owner, you}` (case-insensitive) to
  "no agent recipient" **before** validation. An `ask` without an agent recipient is already
  legal, renders as "to You", and joins `open_questions`.
- `notify`/`task` to the sentinel still 400 (they require a deliverable agent recipient).
- CLI unchanged: `orchestra ask human 'subject line…'` just works.
- One line added to conductor + hook rules so agents learn the affordance:
  `Need the operator? orchestra ask human '<first line = subject>' --from <me> — lands in the inbox; the answer comes back as a reply.`

## UI design (web/src)

Two-pane email client replacing the feed in `MessagesView.tsx`. `MessageThread.tsx` /
`MessageComposer.tsx` keep their APIs (still used by CardDrawer, CommandCenterSurfaces).

**List pane (left)**
- Mailbox tabs with counts: **Inbox** (root from an agent, no agent recipient → addressed to
  you), **Needs reply** (inbox asks not yet answered by you), **Sent** (root from you),
  **All** (everything incl. agent↔agent and board traffic).
- Rows sorted by latest activity (root or newest reply): avatar (existing identity colors),
  sender, time, **subject** (first line, bold when unread), snippet, badges (kind, board name
  when multiple boards, card chip), unread dot.
- "Compose" button switches the reading pane to the existing `MessageComposer`.

**Reading pane (right)**
- Thread header: subject, from → to, kind badge, card link, delete.
- Conversation: root + replies chronologically via `MessageBody` (keeps protocol-token
  rendering + raw escape hatch).
- Docked reply form at the bottom (always visible for replyable threads): textarea + Send →
  `POST /messages {kind:'reply', reply_to:<root>}` — server routes to the original sender and
  wakes hired agents.

**Unread tracking** — client-only, `localStorage` key `orchestra-inbox-read-v1`:
`{ "<boardId>:<threadId>": <lastSeenMessageId> }`. A thread is unread when its newest
message id (root or reply, not authored by you) exceeds the stored id. Selecting a thread
marks it read. No server schema change.

**Mobile** — list pane full-width; selecting a thread slides in the reading pane with a Back
button (CSS + `selected` state, ≤980px breakpoint, consistent with existing messages.css
breakpoints).

## Components & data flow

- `messageUi.ts` (+helpers, existing exports untouched): `splitSubject(body)`,
  `mailboxOf(thread)`, `threadActivity(thread)`, `latestForeignId(thread)`,
  `readStore` (get/mark), `inboxMatches(thread, tab)`.
- `MessagesView.tsx`: rewrite — owns selection, tab, unread state; subcomponents
  `InboxRow`, `ReadingPane` in-file.
- `messages.css`: new `.inbox-*` styles appended; legacy `.message-thread` styles retained
  for other consumers.
- Server: sentinel mapping only. `listThreads` untouched.

## Error handling

- Reply failures render inline in the reading pane (reuse ApiError → readable message).
- Deleted/vanished thread selection falls back to empty reading pane.
- `localStorage` unavailable (private mode) → everything reads as read; no crash (guarded).

## Testing

- `message-ui.test.ts`: splitSubject, mailboxOf, unread computation, inboxMatches.
- `message-feed-ui.test.ts` → rewritten as inbox UI structure assertions (two panes, tabs,
  docked reply, mobile collapse, raw-protocol escape hatch preserved).
- `server-messages.test.ts`: `to:'human'` ask lands with `to_agent_id null` + appears in
  open_questions; `notify` to sentinel still 400; round-trip reply back to agent unchanged.

## Done when

Operator can triage (unread/needs-reply), read full threads, and answer agents from the
Messages tab; agents can reach the inbox via `orchestra ask human`; suite green.
