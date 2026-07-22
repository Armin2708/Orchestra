# Durable Agent Home

Status: planned next after the canonical Milestone A lifecycle.

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
