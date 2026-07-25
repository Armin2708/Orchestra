# Agent OS primary journeys

Status: observed baseline at `ecb38ee30e45def70ecefe869a4e6c853122fcaa`.

This document describes what a person can do now, what durable record proves the outcome, and
where the current product stops. It is a baseline, not a release or plug-and-play claim.

## TL;DR

| Journey | Current result | Durable truth | Important limit |
|---|---|---|---|
| Hire an agent | Implemented as an ambient/compatibility flow | legacy `agents` row plus provider state and captured Agent Home events where linked | direct Hire does not create a WorkContract, Job, assignment, or Delivery |
| Launch a card | Canonical flow implemented; Board button is dual-path | frozen contract, workspace assignment, session, job, draft delivery, causal `os_events` | Board canonical mode is opt-in; its default remains legacy |
| Ask an agent | Implemented targeted message transport | `messages`, `message_targets`, recipient receipts, and replies | not a durable Discussion/Q&A domain |
| Run a terminal command | Implemented canonical real PTY | `processes`, ordered `process_output`, exit state, runtime events | remote terminal authority is not device-scoped |
| Review a delivery | Implemented canonical Trackbook with compatibility Board controls | frozen Asked, revisioned report/results, evidence, verification, acceptance/rejection | the visual Trackbook is primarily a review surface; some mutations still use Board controls or CLI/API |
| Resolve a conflict | Detection and manual coordination only | computed overlaps, attention, messages, and changed scope | no durable Conflict, proposal, arbiter, rationale, or resolution lifecycle |
| Control from a phone | Functional PWA/tunnel beta surface | tunnel state, broad operator token, normal API audit records | no scoped DeviceSession; the pairing QR grants the master token |

The classifications follow [the canonical domain](./agent-os-domain.md): managed, ambient,
compatibility, and manual are intentionally different claims.

## 1. Hire an agent

**Intent:** start a Claude or Codex worker that can be seen and directed from Orchestra.

**Current class:** ambient/compatibility.

### Entry

- Web: Board → Overview → **+ Hire**, with optional provider, model, effort, and access overrides.
- CLI: `orchestra hire [--provider claude|codex] [--model ...] [--effort ...]`.
- HTTP: `POST /api/v1/boards/:id/hire`.

The web entry is in `web/src/Board.tsx:516`; the control and full-access confirmation are in
`web/src/ProviderLaunchControl.tsx:64`; CLI wording explicitly calls the result ambient in
`src/cli.ts:246`; the route is in `src/server.ts:1055`.

### Path

1. The operator selects a board and an optional provider launch profile.
2. The daemon validates operator authority, board existence, access profile, effort, and provider
   availability.
3. The provider manager starts or resumes the agent and stores its legacy agent/provider identity.
4. The route publishes a live `agent` event and returns `mode: "ambient"`.
5. The operator may send work with `orchestra task <name> <text>` or a targeted message.

### Successful exit

- The agent appears active in the Board/Agent Home compatibility view.
- Its provider, model, effort, access profile, and resumable provider identity are visible where
  supported.
- The API response says `ambient`; it does not invent canonical lifecycle IDs.

### Failure and recovery

- `501`: the daemon conductor is unavailable.
- `404`: the board does not exist.
- `400`: effort or access profile is invalid.
- `503`: the requested provider is unavailable or unauthenticated.
- A stopped resumable agent can be hired again with its saved provider session; a non-resumable
  one must start a new session.

### Evidence

- Legacy identity/runtime: `agents` and provider state (`src/db.ts:15`,
  `src/provider-agent-manager.ts`).
- Durable home projection when linked: `agent_profiles`, `agent_sessions`, `conversation_events`
  (`src/agent-os/migrations.ts:639`, `src/agent-os/migrations.ts:720`).
- Acceptance coverage: `test/provider-agent-manager.test.ts`,
  `test/server-conductor.test.ts`, and `test/operator-auth.test.ts`.

### North-star delta

Direct Hire is deliberately not managed work. It creates no frozen request, assignment, Job, or
Delivery. `orchestra agent create` creates a durable identity, not a running worker. A future
managed direct-hire journey must either require a contract or describe itself as ambient just as
the current route does.

## 2. Launch a card

**Intent:** turn a requested card into one isolated, auditable agent execution.

**Current class:** canonical through Agent OS API/CLI; compatibility dual-path through the Board.

### Entry

- Web: open a Board card and choose **Launch agent**.
- Canonical CLI: `orchestra job create <card-id> ...`.
- Canonical HTTP: `POST /api/v1/os/boards/:id/jobs` with `card_id`.
- Compatibility HTTP: `POST /api/v1/cards/:id/launch`.

The Board control is wired in `web/src/CardDrawer.tsx:146`. The compatibility route selects
canonical orchestration only when `ORCHESTRA_CANONICAL_LAUNCH=1`; otherwise it returns
`mode: "legacy"` (`src/server.ts:870`). The direct Agent OS job route always uses canonical
orchestration for a card (`src/agent-os/routes.ts:607`).

### Path

1. Read or create the card's versioned TaskContract.
2. Validate Job Market status, dependencies, provider/model/access constraints, budgets, and
   duplicate-active-job rules.
3. Freeze the current contract version and reserve a workspace, assignment, AgentSession, Job, and
   draft Delivery in one observable lifecycle.
4. Append scoped causal events with contract, job, session, workspace, correlation, and
   idempotency IDs.
5. Dispatch the selected driver. Dispatch may be started, completed, blocked, or deferred without
   erasing the reserved lifecycle.

The orchestration transaction begins in `src/agent-os/orchestration-service.ts:89`; the shared
response contract and exact-ID checks are documented in
[canonical lifecycle acceptance](./canonical-lifecycle-acceptance.md).

### Successful exit

- The response says `mode: "canonical"`.
- It contains the exact contract version, job, workspace, session, draft delivery, correlation ID,
  and dispatch outcome.
- The Workspace Cockpit joins those records by exact IDs rather than proximity.
- A replay with the same key and normalized request returns the same lifecycle.

### Failure and recovery

- Invalid or incomplete contract/dependency/provider constraints fail before lifecycle writes.
- Reusing an idempotency key for different input returns a conflict.
- A duplicate active card job loses the atomic claim race.
- An unavailable provider stays explicit; there is no silent Claude/Codex substitution.
- On daemon restart, the scheduler reattaches a resumable provider or records one retry/block/lost
  transition against the same Job.

### Evidence

- Core records: `task_contracts`, `job_market_*`, `workspaces`, `workspace_assignments`,
  `agent_sessions`, `jobs`, `delivery_reports`, and `os_events`.
- UI evidence: `web/src/CanonicalLifecycleStatus.tsx` and
  `web/src/WorkspaceCockpit.tsx`.
- Executable evidence: `test/canonical-orchestration-acceptance.test.ts`,
  `test/orchestration-entrypoints.test.ts`, `test/orchestration-idempotency.test.ts`, and
  `test/canonical-lifecycle-presentation.test.ts`.

### North-star delta

The canonical lifecycle exists, but the main Board button still defaults to the legacy launch
path because `ORCHESTRA_CANONICAL_LAUNCH` defaults off (`README.md:196`). Public onboarding cannot
call card launch universally canonical until that compatibility flag is retired with measured
migration evidence.

## 3. Ask an agent

**Intent:** ask one agent a precise question and receive a substantive answer without waking
everyone.

**Current class:** legacy message transport with compatibility delivery into live agents.

### Entry

- Web: Board → Messages → compose a Question, or open an agent and prompt it.
- CLI: `orchestra ask <agent> [question]` and `orchestra reply <message-id> [answer]`.
- HTTP: `POST /api/v1/messages` with `kind: "ask"` or `"reply"`.

The six message kinds are closed in `src/server.ts:81`; the CLI entry is
`src/cli.ts:130`; the visual composer is `web/src/MessageComposer.tsx:29`.

### Path

1. Resolve exactly one live recipient for `ask`.
2. Store the question in `messages`; snapshot explicit recipients in `message_targets` when needed.
3. Deliver immediately to a hired agent or through the provider hook/pulse path for an attached
   terminal agent.
4. Record mechanical delivery in legacy `deliveries`.
5. Store the substantive answer as a `reply` linked by `reply_to`; the reply targets the original
   sender and does not create an acknowledgement loop.

### Successful exit

- The original message has one linked substantive reply.
- The UI shows the thread as answered.
- Delivery/read counts describe transport, not task completion.

### Failure and recovery

- Unknown or gone recipients fail rather than silently posting an undeliverable question.
- A failed provider delivery can produce a visible bounce to the sender.
- `reply` without `reply_to`, targetless `ask`, and unconfirmed `swarm` are rejected.
- The operator can resend to a live agent or leave a board-only announcement.

### Evidence

- Transport records: `messages`, `message_targets`, and legacy `deliveries`
  (`src/db.ts:62`, `src/db.ts:98`, `src/db.ts:110`).
- Thread projection: `src/server.ts:1449`, `web/src/MessageThread.tsx`.
- Executable evidence: `test/server-messages.test.ts`, `test/message-ui.test.ts`, and
  `test/message-presentation.test.ts`.

### North-star delta

This is not the canonical `Discussion` described in `docs/agent-os-domain.md:56`. There is no
durable topic/status, nested post tree, accepted answer, subscription/mention model, search,
decision promotion, or cited knowledge reuse. The legacy table named `deliveries` means message
receipt only; canonical work results live in `delivery_reports`.

## 4. Run a terminal command

**Intent:** use the real terminal, installed CLIs, MCP tools, git, package managers, and arbitrary
local commands without losing terminal semantics.

**Current class:** canonical.

### Entry

- Web: Agent Home → Terminal or Workspace → Terminal/Processes.
- CLI: `orchestra process start <workspace-id> <command...>` then
  `orchestra process attach <process-id>`.
- HTTP: create a workspace process, then use the process input/output/resize/signal/restart routes
  under `/api/v1/os`.

The PTY contract is in `docs/agent-os.md:48`; the CLI attaches to the same durable HTTP byte stream
in `src/agent-os-cli.ts:18`; the web terminal is `web/src/ProcessTerminal.tsx`.

### Path

1. Select a shared or worktree Workspace.
2. Spawn `node-pty` with explicit command/cwd/environment/rows/columns or open an interactive shell.
3. Persist process identity and ordered PTY output chunks.
4. Forward input bytes, resize events, and signals directly to the PTY.
5. Stream output to xterm/CLI without turning it into chat.
6. Persist terminal status, PID, exit code, end time, and optional restart recipe.

### Successful exit

- The process reaches `exited` or `stopped` with its exact exit code.
- Ordered output remains readable from a sequence cursor.
- Detaching the browser or CLI does not fabricate process termination.

### Failure and recovery

- Spawn/persistence failures become `process.failed` or `process.persistence_error`.
- A process that cannot be reattached after daemon restart becomes `lost`, never falsely running.
- A restartable stopped/lost process can use the saved recipe.
- A dirty worktree is not silently deleted when a workspace is archived.

### Evidence

- Durable state: `processes`, `process_output`, runtime `process.*` events, and attention items.
- Runtime types: `src/runtime/types.ts:113`; supervision: `src/runtime/supervisor.ts`.
- Executable evidence: `test/runtime-supervisor.test.ts`,
  `test/agent-home-runtime-controls.test.ts`, `test/agent-terminal-controls.test.ts`, and
  `test/runtime-workspaces.test.ts`.

### North-star delta

Local terminal fidelity is one of the strongest implemented surfaces. The remaining release risk
is end-to-end PTY/platform/browser acceptance, especially reconnect and mobile authority, not a
need to replace the terminal with an agent abstraction.

## 5. Review a delivery

**Intent:** compare exactly what was asked with what was delivered, independently verified,
accepted, rejected, revised, and shipped.

**Current class:** canonical Trackbook with compatibility Board review controls.

### Entry

- Web: card Trackbook summary → **Open full Trackbook**, or Workspace → Trackbook.
- CLI: `orchestra delivery show|submit|verify|accept|reject|revise|export`.
- HTTP: delivery routes under `/api/v1/os/jobs/:id/deliveries` and
  `/api/v1/os/deliveries/:id`.

The visual Asked/Delivered/Delta presentation is `web/src/TrackbookPane.tsx`; the Board review
buttons remain in `web/src/CardDrawer.tsx:157`; the lifecycle API starts at
`src/agent-os/routes.ts:459`.

### Path

1. A managed launch creates a draft report with an immutable Asked snapshot.
2. The producing agent submits an explicit outcome for every promised deliverable and criterion,
   including partial, missed, and unverifiable results.
3. A verifier records item-level results and observed evidence.
4. The operator accepts, rejects, or applies an attributed override with a reason.
5. Rejection remains immutable; revise creates a linked child draft.
6. Compatibility Board approve/send-back/move gates update or consult the same current canonical
   delivery for managed cards.

### Successful exit

- `accepted`: every required promise has evidence-backed success or an attributed human override.
- `rejected`: the reason is durable and the original report remains unchanged.
- `revised`: a new linked draft exists; history and lineage remain visible.
- Human and JSON exports deterministically separate Asked, Delivered, Delta, claims, and evidence.

### Failure and recovery

- Submission fails if a promised item has no explicit outcome.
- Acceptance fails when required evidence is missing.
- Agent credentials cannot accept/reject/override or move a managed card to done.
- Cross-board/workspace/job/session evidence and stale lineage fail closed.
- Retried prepare/submit operations replay instead of duplicating a report.

### Evidence

- Canonical records: `delivery_reports`, `delivery_deliverable_results`,
  `delivery_criterion_results`, artifacts, and scoped `os_events`.
- Domain implementation: `src/agent-os/delivery-reports.ts`.
- Executable evidence: `test/delivery-reports.test.ts`, `test/delivery-api.test.ts`,
  `test/delivery-trackbook-ui.test.ts`, `test/review.test.ts`, and `test/operator-auth.test.ts`.

### North-star delta

The full visual Trackbook explains state and history, but canonical lifecycle mutations are still
primarily CLI/API operations while the Board exposes older verify/approve/send-back controls. A
future Job Detail should make every canonical action and evidence gap directly operable without
obscuring the compatibility route used.

## 6. Resolve a conflict

**Intent:** detect agents colliding on a path, execution root, dependency, resource, or decision;
negotiate; record a resolution; and continue safely.

**Current class:** partial—detection, attention, and manual coordination.

### Entry

- Workspace conflict banner and `GET /api/v1/os/boards/:id/conflicts`.
- Needs You items such as `path.conflict`.
- Advisory overlap warning returned when cards claim intersecting paths.
- CLI: `orchestra conflicts`, then `orchestra ask` to coordinate.

The computed conflict service is `src/agent-os/workspace-store.ts:101`; the compatibility
path-conflict attention projection is `src/agent-os/legacy-projection.ts:91`; the banner is
`web/src/WorkspaceCockpit.tsx:521`.

### Path available now

1. Compare active workspaces for the same execution root and active cards for intersecting owned
   paths.
2. Show the computed collision and, for legacy card events, create a Needs You item.
3. A human or agent asks the peer to agree boundaries, moves ownership, changes paths/workspace, or
   serializes the work.
4. Recompute the overlap and manually resolve the attention item.

### Successful exit

- The computed overlap no longer exists.
- Any corresponding Needs You item is resolved.
- Messages/card/workspace history explains the operational choice as far as the participants wrote
  it down.

### Failure and recovery

- Warnings are advisory and do not lock files or prevent simultaneous edits.
- A resolved attention item can be wrong because it does not validate a formal resolution.
- There is no automatic arbiter, proposal comparison, merge plan, or conflict-specific recovery.
- Decision, dependency, and resource conflicts outside the two computed overlap kinds may be
  invisible unless an agent or human reports them.

### Evidence

- Current computed kinds: `execution_root` and `owned_paths`
  (`src/agent-os/workspace-store.ts:113`).
- Attention resolution: `attention_items` and
  `POST /api/v1/os/attention/:id/resolve`.
- Executable evidence: `test/overlap.test.ts`, `test/agent-os-services.test.ts`, and
  `test/orchestration-route-guards.test.ts`.

### North-star delta

There is no `conflicts` table or durable Conflict service. The domain target—cause, participants,
resources, severity, proposals, arbiter, rationale, follow-ups, and
`open → negotiating → resolved|needs_human|superseded`—exists only in
`docs/agent-os-domain.md:69`. This journey must remain labeled partial.

## 7. Control from a phone

**Intent:** monitor agents, send messages, handle attention, and perform safe controls away from
the workstation.

**Current class:** functional PWA/tunnel surface; not the safe remote-beta security model.

### Entry

1. Run `orchestra remote`.
2. Orchestra prefers private `tailscale serve`; otherwise it can start a public random
   `cloudflared` quick tunnel.
3. Scan the QR URL.
4. The PWA reads `#token=...`, stores the token in browser local storage, removes it from the
   address bar, and opens the normal responsive UI.

Implementation: `src/remote.ts:75`; pairing URL: `src/remote.ts:95`; boot-time token handling:
`web/src/main.tsx:8`; PWA contract: `test/pwa.test.ts`.

### Path

- The phone uses the same Board, Agent Home, Messages, Workspace, Needs You, and API routes as the
  desktop browser.
- Narrow Agent Home exposes Conversation, Terminal, and Details panes.
- Push subscriptions and ntfy can notify the device of work requiring attention.
- SSE remains network-only and is deliberately excluded from service-worker caching.

### Successful exit

- The phone authenticates and can observe live state.
- An allowed mutation reaches the daemon and leaves the same Board/Agent OS evidence as a desktop
  mutation.
- Stopping remote tears down the recorded tunnel state.

### Failure and recovery

- Remote refuses to run with auth disabled.
- Missing/down tunnel tooling, an unreachable daemon, or an unavailable provider produces an
  explicit error.
- A stale cloudflared process record is discarded before a new tunnel is created.
- Offline cached UI must not be mistaken for a live control result.

### Evidence

- Tunnel state: `remote.json` with mode `0600` (`src/remote.ts:21`).
- Pairing/auth behavior: `test/remote.test.ts` and `test/auth.test.ts`.
- PWA assets/cache policy: `test/pwa.test.ts`.
- Responsive Agent Home acceptance is recorded in `docs/agent-home.md:186`.

### North-star delta and security boundary

The QR currently embeds the operator master token. After the fragment is stripped, the browser
still stores that broad token and sends it as a normal bearer credential; there is no named,
expiring, scoped, individually revocable DeviceSession, no device attribution, and no step-up
boundary for terminal write or destructive actions. Treat the QR like a password. This journey
cannot satisfy safe remote beta until the `DeviceSession` contract in
`docs/agent-os-domain.md:88` is implemented and tested.

## Cross-journey acceptance rule

A journey is not delivered merely because a button renders or an agent says it completed work.
For each run, the exit state above must be observed in its listed durable records and, where
applicable, reloaded after daemon/browser restart. Compatibility and ambient flows must keep their
labels; missing canonical IDs must never be inferred from nearby cards, owners, workspaces, or
sessions.
