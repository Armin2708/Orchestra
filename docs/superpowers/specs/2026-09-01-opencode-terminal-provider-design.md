# OpenCode Terminal Provider — Design Spec

**Date:** 2026-09-01
**Status:** approved for implementation

## Goal

Add OpenCode (`sst/opencode`) as a fourth first-class agent provider alongside Claude,
Codex, and Qwen: hireable, streamed board events, interrupt/stop, resume, live model
catalog. Not a stub registration like Kimi (`release_state: 'unsupported'`); this should
work end-to-end at the same tier Qwen is at today.

**Correction from initial framing (per `[[Agentboard - Subscription-First Terminal Agent
Compatibility]]`, an active ADR):** "full parity with Claude/Codex/Qwen" does not mean
passing the documented eight-gate acceptance harness (install provenance, subscription
readiness + negative API-fallback checks, resume-after-restart, cancellation,
effective-model evidence, capability/approval/redaction/usage semantics, raw-PTY
coexistence, revoked-credential handling, clean-machine packaging + a real
subscription-billed run). That harness is a separate, long-running track
(`TOOL-014`/`BASE-010`) that hasn't been completed even for Codex, the most mature
third-party integration — Codex itself is still `release_state: 'candidate'`, not
`'supported'`. Qwen and Kimi are explicitly logged as "unsupported managed providers"
despite having working drivers. This spec targets the same honest tier: a real,
working driver/adapter/manifest registered as `release_state: 'candidate'`, with
per-mode `support.state: 'unknown'` until a real acceptance run happens — never
silently promoted to `'supported'`. Running the eight-gate harness is explicitly out of
scope for this pass (see "Out of scope" below).

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
**one long-lived, daemon-wide `opencode serve` process** — verified against
`@opencode-ai/sdk@1.18.25`'s actual types: every session/event endpoint takes an
optional `directory` query param, so one process serves every workspace, directory-scoped
per call, rather than needing one process per workspace. It talks to that process over
HTTP + SSE via `@opencode-ai/sdk`.

Process lifecycle (spawn, health-check, crash detection, restart) is **not**
reimplemented — it's delegated to the existing `RuntimeSupervisor`, the same
infrastructure `ShellAgentDriver` already uses to manage long-lived child processes. The
new engineering surface is bounded to "SDK client + event mapping," the same shape of
work the Qwen driver already does when it maps `assistant`/`tool_use`/`result` events to
`DriverEvent`.

## Components

New files:

- **`src/runtime/drivers/opencode.ts`** — `OpenCodeAgentDriver implements AgentDriver`.
  - `launch()`: lazily starts (or reuses) the **one** `RuntimeSupervisor`-managed
    `opencode serve` process for the whole daemon on a fixed ephemeral port chosen at
    first launch; waits for readiness (the `"opencode server listening on …"` stdout
    line, read through `RuntimeSupervisor`'s output stream); creates a session via
    `client.session.create({query: {directory: cwd}})`; sends the initial prompt via
    `client.session.prompt(...)` if present. Every subsequent call for this session
    passes the same `directory` so multiple workspaces safely share the one server.
  - `send()` → `client.session.prompt({path: {id: sessionId}, query: {directory}, body: {parts: [{type: 'text', text}]}})`.
  - `interrupt()`/`cancel()` → `client.session.abort({path: {id: sessionId}, query: {directory}})`.
  - `stop()` → abort, then decrement a process-wide reference count; the shared server is
    only torn down via `RuntimeSupervisor.stop()` once zero sessions across all
    workspaces still reference it.
  - `events()`: subscribes once to `client.event.subscribe({query: {directory: cwd}})`
    (SSE `GlobalEvent = {directory, payload: Event}`), filters to events whose
    `sessionID` matches, and maps them to `DriverEvent` per the table below.
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

Launch sequence (see Components above for the exact SDK calls). One
`RuntimeSupervisor`-managed `opencode serve` process serves the whole daemon; each
session/event call carries its own `directory` query param to scope it to a workspace.

**Event mapping** — verified against `@opencode-ai/sdk@1.18.25`'s real `Event` union in
`dist/gen/types.gen.d.ts`. The DeepWiki-sourced names used in initial research
(`EventSessionNextTextDelta`, etc.) do not exist in this version and are discarded:

| OpenCode SSE event (`payload.type`) | `DriverEvent.type` | Notes |
|---|---|---|
| `message.part.updated` where `part.type === 'text'` | `output` | `metadata.kind: 'text'`; `delta` carries incremental text |
| `message.part.updated` where `part.type === 'tool'` | `tool` | `part.state.status` (`pending`/`running`/`completed`/`error`) → `tool_call`/`tool_result`; `part.tool` is the tool name, `part.callID` the call id |
| `message.updated` where `info.role === 'assistant'` | `status` | carries `info.cost`, `info.tokens.{input,output,reasoning,cache}` directly off `AssistantMessage` — no reconstruction needed, unlike Qwen's separate `result` event |
| `session.idle` | `status` | `phase: 'turn_completed'` |
| `session.error` | `error` | `properties.error` is a typed union (`ProviderAuthError`\|`UnknownError`\|`MessageOutputLengthError`\|`MessageAbortedError`\|`ApiError`); `ProviderAuthError` feeds `auth_status` probing |
| `permission.updated` / `permission.replied` | `status` | feeds the `approvals` capability |
| server process `process.failed`/`process.lost` (via `RuntimeSupervisor`, not SSE) | `error` + `exit` | see error handling below |

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

- **Port allocation**: one ephemeral free port for the single daemon-wide server,
  allocated at first launch and reused for the daemon's lifetime.
- **Server crash mid-session**: `RuntimeSupervisor` already emits
  `process.failed`/`process.lost`; the driver maps that into `error` + `exit`
  `DriverEvent`s for every session across every workspace attached to that server — the
  same pattern `ShellAgentDriver` uses today for supervisor lifecycle events. A crash
  also resets the reference count and clears the cached server handle so the next
  `launch()` restarts it.
- **Cold start latency**: only the very first OpenCode launch on the daemon pays the
  server boot cost; surfaced as its own `status` event (`phase: 'server_starting'`) so
  the UI can distinguish "server booting" from "turn running" instead of the latency
  being silently absorbed into the first turn.
- **Reference counting**: the shared server process is not stopped while any session in
  any workspace still holds it; `stop()` decrements the count and only tears down the
  process at zero.

## Governance / manifest release state

Registered as `release_state: 'candidate'` from the start — matching Qwen's manifest
exactly, not `'unsupported'` like Kimi's stub. Per-mode `support.state` stays `'unknown'`
with an explicit `reason_code` (e.g. `acceptance_harness_not_run`) — it is **not**
flipped to `'supported'` by this work. Promotion to `'supported'` is a separate,
explicitly out-of-scope effort gated on the eight-gate acceptance harness described in
the Goal section above, consistent with how Codex/Qwen remain unpromoted today despite
working drivers. This build must not silently claim parity it hasn't earned.

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

- The eight-gate acceptance harness and any promotion to `release_state: 'supported'` —
  tracked separately, matching `TOOL-014`/`BASE-010` precedent for Codex/Qwen.
- Whether OpenCode's own upstream-provider terms permit autonomous/non-interactive use
  the way Alibaba's Coding Plan terms blocked autonomous Qwen orchestration — OpenCode is
  bring-your-own-key/provider rather than a single subscription product, so this gate may
  not map the same way. Flagged as unresolved, not assumed either way.
- Hard role/permission gating beyond what Claude/Codex/Qwen already enforce.
- Any OpenCode-specific UI beyond reusing the existing provider picker/model-select
  components (`web/src/agentProviderUi.ts`) — no bespoke OpenCode UI surface.
- Multi-server load balancing — one shared `opencode serve` process for the whole
  daemon is sufficient for this pass.
