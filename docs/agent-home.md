# Durable Agent Home

Status: the durable domain, provider-native capture, lifecycle/search/export/CLI controls, and
responsive visual Agent Home are implemented. Configurable retention, bounded compaction, and
legacy evidence-bundle repair are implemented. Provenance-safe native fork and the real
daemon-to-browser restart E2E gate remain open.

Agent Home is the canonical visual and API surface for one durable agent identity and its provider
sessions. It combines conversation, real terminal processes, assigned work, context, tools,
permissions, usage, attention, and history without replacing provider-native CLIs or PTYs.

## Product contract

An `AgentProfile` is durable identity, defaults, capabilities, and ownership. An `AgentSession` is
one provider-native execution lifecycle. Ambient Claude/Codex sessions remain externally
controlled and disclose their recovery limits; managed sessions retain the identifiers needed for
reattach or honest loss reporting.

The current in-memory Claude/Codex transcript arrays are presentation caches, not durable history.
Agent Home must reconstruct its timeline from normalized durable events after daemon or browser
restart. Raw provider events remain available for recovery/debugging subject to retention and
redaction policy; the UI consumes a safe provider-neutral projection.

## Durable conversation contract

Each conversation event records:

- stable event ID and session ID;
- provider event/thread/turn/item IDs and replay cursor when available;
- `user`, `assistant`, `system`, `tool`, `tool_result`, `approval`, `usage`, `status`, or `error` kind;
- ordered sequence, timestamp, actor type/ID, correlation ID, and causation ID;
- safe projected text and structured metadata;
- optional raw payload artifact reference rather than unbounded inline provider data;
- content hash/idempotency key for replay deduplication;
- redaction state, retention class, and archival timestamp.

Provider adapters append raw events once. A projection service creates the human transcript and
tool/usage/attention views. Replayed Claude or Codex events with the same provider identity are
idempotent; conflicting payloads are retained as diagnostics instead of silently overwriting
history.

## Agent Home layout

Desktop uses a persistent identity/work rail, a primary conversation pane, and a real terminal pane
side by side. Secondary tabs expose Work, Context, Tools, Usage, and History. Narrow screens use one
explicit pane at a time while preserving the selected agent, session, and process.

The header always shows:

- agent name and durable identity;
- managed or ambient status;
- provider, model, effort, access profile, and health;
- active contract, job, workspace, branch, session, and process;
- pending approvals, questions, conflicts, reviews, and failures;
- restart/recovery state and the last durable event cursor.

Agent Home supports pause, resume, stop, retry, fork, rename, and archive with permission-aware
controls. Transcript search filters by kind, actor, tool, status, file/symbol reference, and time.
Export includes provenance and applies redaction policy before writing an artifact.

## API and CLI parity

The service boundary owns profile/session lookup, normalized event append, replay, search, export,
retention, and lifecycle commands. Routes live under `/api/v1/os`; every mutation has an equivalent
`orchestra agent` or `orchestra session` command. Deep links identify agent, session, job, message,
workspace, and process without depending on transient UI state.

Provider-specific capabilities remain visible. Unsupported pause/resume/fork actions return an
actionable capability result and never fall back to a different provider.

### Implemented control contract

Agent and operator principals may read the same durable profile, conversation, session,
capability, search, export, and deep-link state. Only an operator may mutate a profile or session
or persist an export artifact. Every mutation requires an idempotency key; replay returns the
original action or artifact, while reuse for different input fails with a conflict.

`GET /api/v1/os/sessions/:id` returns:

- the durable session, including display name, parent session, lineage, and control state;
- all seven action capabilities (`resume`, `pause`, `stop`, `retry`, `fork`, `rename`, `archive`)
  with `supported`, `allowed`, `requires_operator`, and a human reason;
- exact profile, conversation, session, job, workspace, event, and process identifiers plus a
  canonical Agent Home deep link.

Lifecycle mutations use `POST /api/v1/os/sessions/:id/:action`. Pause and resume act on the
currently attached provider session. Stop cancels the canonical scheduler job. Retry creates one
new canonical child job/session linked to the same Agent Home, records `parent_session_id` and
`lineage_type=retry`, and is replay-safe. Rename is metadata-only. Archive requires a terminal
session and records `control_state=archived` plus `archived_at` without erasing the terminal
provider status (`stopped`, `failed`, `lost`, or `exited`). Lifecycle mutations are serialized per
session and carry the owning daemon lease. On restart, unfinished non-retry actions are recorded as
interrupted, replay the same durable error for the original key, and release the lock for a new
operator action. Retry commits its child lineage and action result before best-effort dispatch, so
a crash or scheduler failure can resume the same idempotency key without creating another child.
Paused intent is persisted in `control_state`, restored before provider attach, and remains paused
when Codex replays an interrupted turn or Claude reattaches. Codex and Claude do not currently
expose provenance-safe native session forking, so
`fork` fails explicitly with HTTP 501 instead of fabricating a clone.

Conversation search is available at both
`GET /api/v1/os/conversations/:id/search` and
`GET /api/v1/os/sessions/:id/search`. It uses a stable monotonic sequence cursor and supports
projected-text, event kind, actor type/ID, tool, status, time range, session, and archived-event
filters. Each hit carries the exact session and event deep-link IDs.
`GET /api/v1/os/conversations/:id/events/:eventId` resolves one stable event directly without a
pagination scan, rejects an event from a different conversation, and returns `{ event, links }`.
Canonical browser links follow the existing query contract:
`/?board=<id>&agent=<profile>&conversation=<id>&session=<id>&job=<id>&workspace=<id>&process=<id>&event=<id>`.
Profile and conversation links leave session, job, workspace, process, and event fields null rather
than guessing a latest session; event links include a process only when the event names that exact
process.

Redacted transcript reads are available from the matching conversation or session `export`
endpoint in human text or canonical JSON. Operator-only `POST` persists the export as an
idempotent artifact. The export retains event/session/provider IDs, provider cursors, source
content hashes, raw artifact references, and deep links, but never embeds raw artifact content.
Credential-shaped keys and secret patterns are redacted recursively before either format is
rendered.

CLI parity is exposed as:

- `orchestra agent list|create|show|home|rename|archive`;
- `orchestra session list|show|resume|pause|stop|retry|fork|rename|archive`;
- `orchestra session search` with the API filters;
- `orchestra session export` in human, JSON, or persisted-artifact mode.
- `orchestra retention show|set|run` for operator policy and bounded sweeps.

## Retention and compaction contract

Migration `012-agent-home-retention` adds one board-scoped policy, immutable run records, raw
artifact archive evidence, and legacy evidence-bundle repair provenance. The default policy
soft-archives transcript events after 90 days and ephemeral events after 7 days. Audit and pinned
canonical events remain forever. Strongly owned inline provider artifacts (`provider_event` and
legacy `provider_raw_event`) compact after 30 days; compaction nulls only `artifacts.content`.
External artifact paths, canonical event IDs/sequences/dedupe keys/hashes/provider cursors, safe
projected text, and redaction state are unchanged.

A raw artifact is not compacted while an owning session is active, paused, or attachable, when its
artifact metadata is explicitly pinned, when an accepted delivery references it directly or as
deliverable/criterion evidence, or when a checkpoint uses it as a patch artifact. Event
`retention_class=audit|pinned` protects the canonical event, not an otherwise unpinned raw payload.
An arbitrary artifact kind is never treated as provider-owned merely because a
`raw_artifact_id` relationship exists. Orphan strong-kind provider artifacts remain eligible.

Each run processes at most 500 candidates in each event, raw-artifact, and legacy-repair lane and
returns `has_more` for another sweep. `as_of` controls policy cutoffs; the server-generated
`created_at` records when archival/repair actually occurred. Runs are board/idempotency-key durable
across restart, and the whole sweep is one SQLite transaction.

Historical `evidence_bundle` artifacts that copied sensitive raw provider data are replaced once
with a small tombstone. The original/repaired SHA-256, byte counts, implicated raw artifact IDs,
run ID, and repair time are stored in `agent_home_evidence_bundle_repairs`; unrelated bundles stay
byte-for-byte unchanged. Retention audit payloads contain identifiers, counts, and hashes only,
never raw provider content or approval parameters.

Operator endpoints are:

- `GET /api/v1/os/boards/:id/retention`;
- `PUT /api/v1/os/boards/:id/retention`;
- `POST /api/v1/os/boards/:id/retention/run`.

## Terminal invariants

The terminal remains the exact `node-pty` stream. Agent Home may select, attach, resize, signal, or
restart a named process but does not summarize terminal bytes into chat. Viewing and writing are
separate permissions; remote/mobile sessions default to view-only. Normal shells, git, package
managers, Claude CLI, Codex CLI, MCP tools, plugins, and arbitrary installed commands remain usable.

## Acceptance evidence

- Claude and Codex provider-event fixtures produce the same normalized semantic timeline while
  preserving provider-specific metadata.
- Duplicate replay does not create duplicate conversation events.
- A daemon restart reconstructs transcript, tool state, usage, attention, selected workspace, and
  restartable processes from durable records.
- A provider session that cannot reattach is labeled lost/ambient with an actionable recovery path.
- Raw PTY Unicode, ANSI, rapid input, resize, signal, reconnect, large-output, and exit contracts
  remain byte-correct.
- Desktop, tablet, and phone layouts preserve selection, deep links, keyboard/focus behavior, and
  visible errors.
- Transcript export proves provenance and secret redaction.
- Retention replay survives database restart, rollback injection leaves no partial mutation, and
  repeated sweeps do not rewrite repair tombstones.

Observed Playwright acceptance on the integrated train passed at 1440×1000 and 390×844. Direct
lookup loaded and focused/highlighted `event-5001` with its surrounding context, Pause changed the
mocked provider state from Running to Idle exactly once, neither viewport overflowed horizontally,
and fresh desktop/phone reloads produced zero console errors, page errors, or unhandled mocks.
