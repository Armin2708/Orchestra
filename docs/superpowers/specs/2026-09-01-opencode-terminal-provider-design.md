# OpenCode Terminal Provider — Design Spec

**Date:** 2026-09-01
**Status:** approved for implementation

## Goal

Add OpenCode (`sst/opencode`) as a fourth first-class agent provider alongside Claude,
Codex, and Qwen — full parity: hireable, streamed board events, interrupt/stop, resume,
live model catalog. Not a stub registration like Kimi (`release_state: 'unsupported'`,
capabilities `unknown`); this should work end-to-end.

## Why this isn't a drop-in copy of the Qwen driver

Every existing native-CLI driver (Claude, Codex, Qwen) spawns one child process per turn
and parses its stdout as newline-delimited JSON. OpenCode has that same shape
(`opencode run --format json`), but as of 2026 it has open upstream bugs that make it
unsuitable as the primary integration path:

- anomalyco/opencode#31365 — `opencode run` output truncated in non-interactive mode,
  missing the assistant response and `step_finish`.
- anomalyco/opencode#26855 — `run --format json` can exit before emitting the final
  `step_finish` event, which is where token/cost usage lives.

Both bugs hit exactly the signals Orchestra depends on for turn-completion detection and
usage accounting. Coding around them in our driver would mean guessing at completion from
partial output — fragile in the same way the codebase's own handoff notes describe
partial-snapshot commits and silent reverts as its recurring failure class.

OpenCode's other exposed surface, `opencode serve`, is a headless HTTP server with a real
session API and an SSE event bus (`/event?directory=`, ~90 typed events), backed by an
official `@opencode-ai/sdk` npm package. This is the same server the OpenCode TUI itself
talks to — it carries the project's actual reliability bar, not its secondary scripting
path. This spec integrates against `opencode serve` + the SDK.

## Architecture

Orchestra's existing per-provider shape is four layers:

1. **Manifest** (`src/provider-manifests.ts`) — declares executable, validated versions,
   supported platforms, and per-mode capability/support state.
2. **Driver** (`src/runtime/drivers/*.ts`) — implements `AgentDriver`
   (launch/send/interrupt/stop/events).
3. **Provider adapter** (`src/runtime/drivers/*-provider-adapter.ts`) — wraps the driver
   with contract-shaped discovery, readiness probing, model catalog, launch/resume
   requests, and session evidence.
4. **Manager wiring** (`src/provider-agent-manager.ts`) — a per-provider block (hire,
   launch, session tracking) gated by `if (provider === X_ID)` branches, plus the same
   branches repeated in routes/CLI/TUI/web.

OpenCode fits this shape unchanged at layers 1, 3, and 4. The only structural difference
is layer 2: instead of spawning a CLI process per turn, `OpenCodeAgentDriver` manages
**one long-lived `opencode serve` process per workspace**, reused across turns and
sessions, and talks to it over HTTP + SSE via `@opencode-ai/sdk`.

Process lifecycle (spawn, health-check, crash detection, restart) is **not**
reimplemented — it's delegated to the existing `RuntimeSupervisor`, the same
infrastructure `ShellAgentDriver` already uses to manage long-lived child processes. The
new engineering surface is bounded to "SDK client + event mapping," the same shape of
work the Qwen driver already does when it maps `assistant`/`tool_use`/`result` events to
`DriverEvent`.

## Components

New files:

- **`src/runtime/drivers/opencode.ts`** — `OpenCodeAgentDriver implements AgentDriver`.
  - `launch()`: request (or reuse) a `RuntimeSupervisor`-managed `opencode serve` process
    bound to the workspace's cwd on an ephemeral port; wait for readiness (a successful
    call against the server's `/doc` endpoint); create a session via
    `client.session.create({directory: cwd})`; send the initial prompt if present.
  - `send()` / `interrupt()` / `stop()`: map onto SDK session calls
    (message send / session abort / session end). `stop()` decrements a per-workspace
    reference count on the server process and only tears it down via
    `RuntimeSupervisor.stop()` once no session still holds it.
  - `events()`: subscribe to `/event?directory=<cwd>` SSE, filter to the session id, map
    event types (table below) to `DriverEvent`.
- **`src/runtime/drivers/opencode-provider-adapter.ts`** — mirrors
  `qwen-provider-adapter.ts`: executable discovery via `opencode --version`; **live**
  model catalog queried from the running server's config/provider-list endpoint (not a
  hardcoded array — OpenCode itself brokers whichever upstream model providers the user
  has configured, so a static list like Qwen's would go stale immediately); resume,
  launchRequest, and sessionEvidence following the same shape as
  `createQwenProviderAdapterV1`.

Modified files (matching the surface the `qwen` pattern already touches, grep-verified
against the current tree):

- `src/provider-manifests.ts` — new `OPENCODE_PROVIDER_MANIFEST_V1`. New `protocol` value
  `'http_sse'` (today only `native_cli` and `acp` exist) and a `runtime_mode` reflecting a
  managed background server rather than a per-invocation CLI.
- `src/agent-providers.ts` — `OPENCODE_PROVIDER_ID`, `openCodeProviderCatalog()`.
- `src/provider-agent-manager.ts` — new OpenCode block (hire/launch/session-tracking)
  following the Qwen block's shape (`ProviderAgentManager`, ~700 lines for Qwen alone),
  plus a branch added everywhere `provider === QWEN_PROVIDER_ID` is currently checked.
- `src/provider-contract.ts`, `src/provider-auth-status.ts`,
  `src/declared-provider-compatibility.ts`, `src/first-run-onboarding.ts`,
  `src/first-run-cli.ts`, `src/operator-telemetry.ts`, `src/usage.ts`,
  `src/agent-os/routes.ts`, `src/server.ts`, `src/daemon.ts`,
  `web/src/agentProviderUi.ts` — same touch points the existing `qwen` wiring already
  hits; add the OpenCode equivalent alongside each.
- `package.json` — new dependency `@opencode-ai/sdk`.
- `agent-os-surface-inventory.json` + `.md` — any new routes; threat-matrix counts
  **recomputed from the inventory**, never hand-incremented (per this repo's own rule —
  four agents rewrote them wrong in one day previously).

## Data flow & event mapping

Launch sequence:

```
RuntimeSupervisor.spawn({command: 'opencode', args: ['serve', '--port', N], cwd})
  → poll readiness (GET /doc)
  → client.session.create({directory: cwd})
  → if prompt present: session.prompt(...)
```

SSE → `DriverEvent` mapping:

| OpenCode event | `DriverEvent.type` | Notes |
|---|---|---|
| `EventSessionNextTextDelta` | `output` | `metadata.kind: 'text'` |
| tool-call part event | `tool` | `metadata.kind: 'tool_call'` |
| tool-result part event | `tool` | `metadata.kind: 'tool_result'` |
| `EventSessionUpdated` (idle/completed) | `status` | turn-completion signal |
| `EventSessionError` / stream error | `error` | |
| session end / server process exit | `exit` | see error handling below |

## Auth & model catalog

OpenCode manages its own auth (`opencode auth login`), the same shape as Claude/Codex/
Qwen's own CLI-managed credentials — Orchestra doesn't touch it directly. Readiness
probing checks `opencode --version` succeeds **and** a live call against the running
server succeeds (Qwen's adapter only checks the former —
`authenticationObserved = Boolean(probedVersion)` — but OpenCode's correctness depends on
the server being reachable, so that check is added).

Model catalog is queried live from the running server rather than hardcoded, and cached
through the existing `writeProviderModelCache(db, value, 'opencode')` /
`readProviderModelCache` KV path so it survives daemon restarts like every other
provider's catalog.

## Error handling / process lifecycle

- **Port allocation**: an ephemeral free port per workspace, not a hardcoded `4096` — more
  than one workspace/board can run OpenCode concurrently.
- **Server crash mid-session**: `RuntimeSupervisor` already emits
  `process.failed`/`process.lost`; the driver maps that into `error` + `exit`
  `DriverEvent`s for every session attached to that server — the same pattern
  `ShellAgentDriver` uses today for supervisor lifecycle events.
- **Cold start latency**: first launch on a workspace pays the server boot cost once;
  surfaced as its own `status` event (`phase: 'server_starting'`) so the UI can
  distinguish "server booting" from "turn running" instead of the latency being silently
  absorbed into the first turn.
- **Reference counting**: the server process is not stopped while any session still holds
  it; `stop()` decrements the count and only tears down the process at zero.

## Governance / manifest release state

Registered as `release_state: 'experimental'` from the start — not `'unsupported'` like
Kimi's stub registration, since the goal here is working parity, not placeholder
registration. Per-mode `support.state` starts `'unknown'` with a `reason_code` until the
live readiness probe is verified end-to-end, then flips to `'supported'` — the same
staged pattern Qwen's own manifest already documents (`candidate` release state,
per-mode `unknown` pending specific integration work).

## Testing

Mirrors the Qwen test footprint:

- `test/opencode-driver.test.ts` — unit tests against a mocked SDK client and a fake SSE
  stream (session lifecycle, event mapping, interrupt/stop, reference-counted server
  teardown).
- `test/opencode-managed-runtime.test.ts` — integration through `ProviderAgentManager`
  (hire → launch → session tracking), mirroring `test/qwen-managed-runtime.test.ts`.
- Additions to `test/provider-adapter-integration.test.ts`,
  `test/declared-provider-compatibility.test.ts`, `test/provider-contract.test.ts`,
  `test/tool-capabilities.test.ts`, `test/first-run-onboarding.test.ts`.

Given this repo's documented history of partial-snapshot commits hiding broken builds
behind a shared checkout, verification before calling this done includes:

```
git worktree add --detach /tmp/chk HEAD && cd /tmp/chk && npx tsc --noEmit
```

## Out of scope for this pass

- Hard role/permission gating beyond what Claude/Codex/Qwen already enforce.
- Any OpenCode-specific UI beyond reusing the existing provider picker/model-select
  components (`web/src/agentProviderUi.ts`) — no bespoke OpenCode UI surface.
- Multi-server load balancing — one `opencode serve` process per workspace is sufficient
  for this pass.
