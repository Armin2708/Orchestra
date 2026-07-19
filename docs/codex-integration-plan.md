# Codex first-class provider implementation plan

Status: implemented; final verification in progress  
Base: `main` at `cb1a102`  
Primary transport: `codex app-server` JSONL over daemon-owned stdio  
Compatibility target at planning time: Codex CLI `0.144.6`

## Outcome

Orchestra must run Claude and Codex agents concurrently on the same board, with the same durable lifecycle guarantees: explicit and default provider selection, card/worktree ownership, live transcript and steering, approvals, model/reasoning controls, usage, restart recovery, hooks for ambient sessions, and clean shutdown. Provider differences remain explicit through capabilities; the UI must never silently emulate a missing feature or fall back to another provider.

## Architectural decision

```text
Web / CLI / ambient hooks
          |
ProviderAgentManager
  routing · identity · policy · normalized events
          |
          +-- Claude provider -> existing Conductor
          |
          +-- Codex provider  -> CodexAgentRuntime
                                   |
                         CodexAppServerSupervisor
                                   |
                          codex app-server (JSONL)
```

- Preserve `Conductor` as the Claude implementation and migration bridge.
- Implement Codex directly on app-server. Do not build the interactive integration on `codex exec` or the lightweight SDK first.
- Keep the existing `AgentDriver` lifecycle seam for Agent OS jobs. Add provider-control/catalog services beside it instead of forcing shell drivers to implement auth, models, approvals, and rate limits.
- Put provider routing in one manager used by legacy board routes and Agent OS. No route may choose a provider independently.
- One daemon owns one supervised app-server process and multiplexes all Codex threads.

## Invariants

1. Existing databases and agents migrate to `provider='claude'` without changing behavior.
2. An unavailable or unsupported provider fails explicitly; it never launches Claude as a fallback.
3. Provider-native session IDs are namespaced and never collide.
4. A card has at most one active provider job/agent, regardless of provider.
5. Codex cached input is never added twice when calculating total tokens.
6. Codex credentials are accessed only through app-server account methods; Orchestra never reads auth files.
7. `danger-full-access` requires a deliberate neutral `full_access` selection.
8. Restart reconciliation is idempotent and cannot duplicate turns, agents, transcript lines, or card claims.
9. Ambient hook sessions and daemon-managed sessions register the same provider identity without creating ghosts.
10. Current Claude behavior and regression tests remain green throughout the migration.

## Phase 1 — persistence and provider domain

### Schema

- Add to legacy `agents`:
  - `provider TEXT NOT NULL DEFAULT 'claude'`
  - `external_session_id TEXT`
  - `provider_state_json TEXT NOT NULL DEFAULT '{}'`
  - `access_profile TEXT`
- Backfill `external_session_id=sdk_session` for Claude rows while retaining `sdk_session` for one compatibility release.
- Add indexes on `(provider, external_session_id)` and `(board_id, provider, status)`.
- Add provider and normalized fields to usage persistence:
  - reported total, input, cached input, output, reasoning output, provider cost when authoritative
  - keep legacy Claude cache-read/cache-creation columns and calculations intact
- Persist Codex thread ID, active turn ID, last completed item IDs/event cursor, CLI version, model, effort, sandbox, approval policy, and rate-limit pause metadata in provider state.

### Provider contracts

- Generalize model-cache keys by provider.
- Add `AgentProviderService` for availability, auth state, model catalog, capabilities, usage/rate limits, and diagnostics.
- Add capability flags for steering, approvals, model switching, effort switching, rate limits, usage, diffs/plans, subagents, ambient hooks, and session-end hooks.
- Keep shell as a runtime driver, not an agent model provider.

### Acceptance

- Old databases open with every existing agent classified as Claude.
- Provider/session lookup is unique and indexed.
- Invalid provider defaults are rejected or shown unavailable, never executed as Claude.

## Phase 2 — app-server transport and supervision

### `CodexAppServerClient`

- Spawn `codex app-server --stdio` with sanitized inherited environment and no shell.
- Implement JSONL framing, request IDs, pending request timeouts, notification dispatch, bidirectional server requests, stderr diagnostics, maximum line/payload bounds, and graceful termination.
- Perform `initialize` / `initialized` exactly once per process.
- Expose typed wrappers for:
  - `thread/start`, `thread/resume`, `thread/read`, `thread/unsubscribe`
  - `turn/start`, `turn/steer`, `turn/interrupt`
  - `model/list`
  - `account/read`, login/logout, rate limits, and usage
  - approval responses
- Treat unknown notification/item variants as forward-compatible diagnostic events.

### `CodexAppServerSupervisor`

- Own process lifecycle for the daemon.
- Detect CLI absence/version, login state, startup failure, protocol errors, and process exit.
- Restart with bounded exponential backoff and jitter.
- Reinitialize and ask the Codex runtime to reconcile known threads after restart.
- Cache the last successful model, account, usage, and rate-limit snapshots with stale timestamps.
- Expose health without blocking ordinary board reads.

### Compatibility

- Add a script/CI check that runs `codex app-server generate-ts` for the installed supported CLI and detects protocol drift.
- Pin and document a tested CLI range while allowing explicit override for development.

### Acceptance

- Fixture transport tests cover partial/multiple JSONL frames, malformed messages, request errors/timeouts, server requests, crash/restart, and shutdown.
- A read-only opt-in smoke initializes, reads account state, and lists models without starting a billable turn.

## Phase 3 — Codex managed-agent runtime

### Lifecycle mapping

| Orchestra | Codex |
|---|---|
| launch | `thread/start`, persist identity, then `turn/start` |
| attach/resume | `thread/resume` plus `thread/read(includeTurns=true)` |
| send while idle | `turn/start` |
| send during active turn | `turn/steer(expectedTurnId)` |
| interrupt | `turn/interrupt(threadId, turnId)` |
| stop | interrupt active turn, unsubscribe, close Orchestra lifecycle; archive only explicitly |
| model/effort change | persist and apply through the next `turn/start` override |

### Normalized state and events

- Create a legacy board agent row immediately with `status='starting'`, `provider='codex'`, then mark active after `thread/start`.
- Map agent messages, reasoning summaries, plans, command execution, file changes, MCP/dynamic tools, diffs, warnings, errors, turn completion, token usage, and subagent activity into Orchestra transcript/event shapes.
- Preserve native thread, turn, and item IDs in metadata.
- Deduplicate replayed items by persisted native IDs.
- Derive working/idle/stopped state from thread and turn notifications, not polling text.
- Record final outcome/evidence and release card ownership with the same review/blocked semantics as Claude launches.

### Approvals and policy

- Introduce neutral access profiles:
  - `read_only` -> Codex `read-only`, approval `on-request`
  - `workspace_write` -> Codex `workspace-write`, approval `on-request`
  - `full_access` -> Codex `danger-full-access`, explicit opt-in
- Route command, file-change, and permission server requests into the existing pending-permission/Needs You surfaces.
- Evaluate Agent OS policy before presenting/answering an approval when enough operation data is available; fail closed on malformed policy/state.
- Support accept, accept-for-session, decline, and cancellation where the provider supports them.

### Usage and limits

- Consume `thread/tokenUsage/updated` and turn-completion usage.
- Use reported `totalTokens`; cached input remains a subset of input.
- Enforce token budgets by interrupting at or above the durable threshold.
- Enforce cost budgets only when an authoritative provider cost is available; otherwise expose them as unsupported instead of estimating silently.
- Map rate-limit saturation to a provider-specific paused state and resume schedule from authoritative reset data when available.

### Subagents

- Map `parentThreadId`, collaboration tool calls, and subagent activity to board subagent presence.
- Do not allow child events to consume parent-directed messages.

### Acceptance

- Launch, transcript, steer, interrupt, model/effort, approval, token usage, stop, and restart/resume all pass fixture-backed tests.
- Replaying `thread/read` is idempotent.

## Phase 4 — provider-neutral routing

### `ProviderAgentManager`

- Implement the existing server-facing conductor surface and delegate by the persisted agent provider.
- Resolve worker/specialist defaults once, server-side.
- Combine Claude and Codex provider catalogs and capabilities.
- Queue asynchronous provider operations safely while preserving existing boolean delivery semantics.
- Make provider choice immutable for a live agent; changing provider starts a new agent.

### Route every path

- Manual board hire and CLI hire.
- Card launch and queued launch.
- Strategist, auditor, and verifier creation.
- Assign/task/message delivery, interrupt, fire/stop.
- Model, effort, access profile, and approval responses.
- Agent transcript, subagent state, and capability reads.
- Daemon survivor restoration and Agent OS job reconciliation.
- Retry, limit pause/wake, capacity accounting, and graceful shutdown.

### Agent OS

- Register Codex in the driver registry through a generic registration method.
- Remove Claude-only card-claim checks and provider-shaped launch fields from the executor.
- Build provider-specific launch requests through the driver/service.
- Allow Codex token budgets with usage-driven interruption; reject only unsupported cost budgets.
- Ensure one card cannot be claimed concurrently by Claude, Codex, or shell jobs.

### Acceptance

- The same board runs one Claude and one Codex agent concurrently.
- Every implicit specialist honors the specialist provider default.
- Unsupported providers fail before creating a ghost agent/card claim.

## Phase 5 — API and web UI

### API

- Return provider, external session, capabilities, access profile, model, effort, and health on agent/session responses.
- Accept provider and optional per-launch override on hire/card-launch endpoints.
- Add provider-neutral access-profile and approval decision endpoints while retaining legacy Claude endpoints for compatibility.
- Expose combined provider health/auth/model/rate-limit/usage snapshots.
- Keep unavailable providers visible with actionable diagnostics.

### UI

- Show provider badges on agents, cards, terminal, workspaces, and Needs You items.
- Keep worker/specialist defaults, plus add a per-launch override for Hire and card Launch.
- Filter model and reasoning controls by the selected provider/model catalog.
- Render neutral access profiles; show the explicit full-access warning.
- Render Codex-native plan/diff/tool/file/approval/subagent events without Claude labels.
- Calculate usage totals with provider semantics and show cached/stale/error states.
- Gate unsupported controls using capabilities instead of catching failed requests silently.
- Replace Claude-only onboarding, meter, spinner/help text, and capacity wording where the surface is shared.

### Acceptance

- UI/API tests prove provider persistence, defaults, per-launch overrides, badges, capability gating, approval actions, and telemetry math.

## Phase 6 — ambient hooks, plugin, packaging, and docs

### Installer

- Add `orchestra install|uninstall --provider claude|codex|both`.
- Preserve existing default behavior for compatibility while documenting `both` for dual-provider use.
- Write Claude hooks to `.claude/settings.json` and Codex hooks to `.codex/hooks.json`.
- Make install/uninstall idempotent and preserve unrelated user hook entries.
- Verify configuration files after writing before reporting success.

### Codex hooks

- Support SessionStart (`startup|resume`), PostToolUse, UserPromptSubmit, Stop, PermissionRequest, SubagentStart, and SubagentStop.
- Do not install SessionEnd for Codex.
- Namespace local session files by provider and session/thread ID.
- Include `provider` in registration/heartbeat/telemetry payloads.
- Use explicit runtime stop/reaper behavior when no lifecycle-end hook exists.

### Plugin and durable guidance

- Add `.codex-plugin/plugin.json` and a Codex-compatible hook manifest.
- Include plugin/hook assets in npm `files` and verify packed tarball contents.
- Track provider-neutral `AGENTS.md` guidance or generate provider-specific guidance from a neutral source; never blindly copy Claude-only instructions.
- Update package description/keywords, README, onboarding, CLI help, troubleshooting, and diagnostics.

### Acceptance

- Installer tests cover global/project Claude, Codex, both, uninstall, malformed input, and preservation of unrelated hooks.
- A packed-install smoke contains and runs both plugin paths.

## Phase 7 — verification and rollout

### Automated matrix

- Existing database migration and rollback-safe reopen.
- App-server client protocol fixtures.
- Codex lifecycle and reconnect fixtures.
- Mixed Claude/Codex board, messaging, card ownership, and specialist defaults.
- Approval allow/deny/accept-session/cancel paths.
- Token accounting including cached input and reasoning output.
- Rate-limit endpoint failure, stale cache, pause, and wake.
- Ambient hook identity and subagent isolation.
- API/UI provider capability tests.
- Full backend/web typecheck, tests, production builds, and package dry-run/install smoke.

### Optional live smoke

- Require explicit environment opt-in.
- Verify `codex login status`.
- Create an isolated temporary git worktree.
- Launch a minimal Codex turn, stream completion, send a second turn, restart app-server, resume/read, and stop cleanly.
- Avoid destructive permissions and clean up only the explicit temporary target.

### Release gates

- GitNexus `detect_changes(compare main)` shows only expected provider/runtime/API/UI/hook flows.
- Graphify is incrementally updated after final code/docs changes.
- No unrelated shared-checkout changes are staged or modified.
- Full audit note and daily vault log are updated.
- Claude-only fallback remains available when Codex is absent, with honest unavailable state.

## Risk controls

- `AgentDriver` and `Conductor` are HIGH-impact symbols; `buildServer` is CRITICAL. Prefer new modules, adapters, and narrow delegates.
- Keep changes in this isolated worktree and integrate slices only after focused tests pass.
- Never force-restart the user's canonical daemon during development; use isolated data/ports for smoke tests.
- Do not commit generated secrets, Codex state, `.env` files, or live app-server payloads containing account data.

## Final definition of done

Codex is first-class only when a user can choose it from Settings or per launch, run it beside Claude, see and control the complete live lifecycle, approve work safely, survive daemon/app-server restarts, receive truthful provider telemetry, use ambient Codex hooks, install the packaged plugin, and pass the full mixed-provider acceptance matrix without regressing Claude.
