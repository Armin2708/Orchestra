# Orchestra Daemon Sync Client — Plan 2 of 3

> **For agentic workers:** implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task ends with tests passing and a commit.

**Goal:** Let a person's local Orchestra daemon join a hosted org and stay in sync with it, so their agents appear on the shared board automatically — replacing today's manual "mint a token in the browser and paste it into curl".

**Architecture:** The local daemon gains a sync client. `orchestra org join` stores a device token under `ORCHESTRA_HOME`. A sync loop then holds one long-lived SSE connection to the hub (`GET /api/v1/hub/orgs/:orgId/sync?since=<seq>`), applying inbound events into local state, and posts local changes outbound as ops. A bounded offline queue holds writes made while disconnected and replays them on reconnect, using idempotency keys so replay never double-applies.

**Tech Stack:** TypeScript ESM (NodeNext, `.js` imports), the existing daemon in `src/daemon.ts`, `src/cli.ts` (commander), vitest.

**Spec:** `docs/superpowers/specs/2026-08-28-orchestra-hub-design.md` §5 (Sync Protocol) and §11 (Plan 2).

**Depends on:** Plans 1 and 3, both merged to `main`. The hub is live and verified end to end.

## Global Constraints

- **ESM only.** Every intra-repo import ends in `.js` (sources are `.ts`, resolution is NodeNext).
- **Node `>=22.20.0 <23`**, npm `>=10.9.3 <11` — a hard engines pin.
- Tests are vitest: `npx vitest run <file>`; tests live in `test/**/*.test.ts`.
- **Do not modify `src/hub/**`** — the hub is verified and deployed-ready. This plan is daemon-side only. If you believe the hub must change, stop and say so rather than changing it.
- **Do not break local single-machine mode.** A daemon with no org joined must behave exactly as it does today. This is the free product; a regression here is worse than the feature being late.
- **Never run `git stash`** — the stash is one namespace shared across every worktree in this repo.
- Secrets (device tokens) are stored under `ORCHESTRA_HOME` with restrictive permissions, never logged, never echoed in an error.

## What already exists (do not rebuild)

- Hub ops endpoint: `POST /api/v1/hub/orgs/:orgId/ops` accepting `{op, idempotency_key?, payload}` with ops `card.create|update|move|claim`, `mail.send`, `agent.register|heartbeat`.
- Hub sync stream: `GET /api/v1/hub/orgs/:orgId/sync?since=<seq>` (SSE), plus `?catchup=1` to drain the backlog and close.
- Device tokens: minted at `POST /api/v1/hub/orgs/:orgId/devices` (Clerk-authenticated), returned once, verified by prefix `orchestra_device_v1.`.
- Reads: `GET .../cards`, `.../agents`, `.../boards`, `.../mail/inbox?agent=`, `.../entitlements`, `.../me`.
- Conflict contract: a stale write returns **409 with the current entity** in `current`.
- `src/daemon.ts` — `serve()`, `dataDir()` (= `ORCHESTRA_HOME`), `port()`, `baseUrl()`.
- `src/cli.ts` — commander; follow the `register*Commands(program, deps)` pattern used by `registerAgentOsCommands`, `registerDoctorCommand`, `registerHubCommands`.

---

## Task 1: `orchestra org join` and credential storage

**Files:** create `src/org-sync/credentials.ts`, `src/org-cli.ts`; modify `src/cli.ts`; create `test/org-credentials.test.ts`, `test/org-cli.test.ts`.

**Produces:**
- `interface OrgCredential { hubBaseUrl: string; orgId: string; deviceToken: string; deviceName: string }`
- `saveOrgCredential(cred, home?): Promise<void>` — writes `<ORCHESTRA_HOME>/org.json` with mode `0600`
- `loadOrgCredential(home?): Promise<OrgCredential | null>`
- `clearOrgCredential(home?): Promise<void>`
- `registerOrgCommands(program, deps?)` — `orchestra org join|status|leave`

- [ ] **Step 1: Write failing tests.** Round-trip save/load; `loadOrgCredential` returns null when absent; the file is created with mode `0600`; `clear` removes it; `status` prints the org and hub without printing the token; `join` rejects a token not starting with `orchestra_device_v1.`.
- [ ] **Step 2: Implement `credentials.ts`.** Store under `dataDir()`. Never log the token. On read, validate shape and return null (not throw) if malformed — a corrupt file must not prevent the daemon booting.
- [ ] **Step 3: Implement `org join`.** Accept `--hub <url>`, `--org <id>`, `--token <token>`, and a `--token-stdin` form so the token need not appear in shell history. Verify the credential works before saving by calling `GET /api/v1/hub/orgs/:orgId/me`; refuse to save a token the hub rejects, naming the failure.
- [ ] **Step 4: Implement `org status` and `org leave`.** `status` shows hub URL, org id, device name, and whether the credential currently verifies. `leave` clears the local credential and says plainly that it does **not** revoke the token server-side, and how to revoke it.
- [ ] **Step 5: Register in `src/cli.ts`** beside the other `register*` calls. Confirm bare `orchestra` still starts the local daemon.
- [ ] **Step 6: Run tests, commit.**

---

## Task 2: The hub client

**Files:** create `src/org-sync/hub-client.ts`; create `test/org-hub-client.test.ts`.

**Produces:**
- `class HubClient { constructor(cred: OrgCredential); postOp(op, payload, idempotencyKey?): Promise<OpResult>; get(path, query?): Promise<unknown>; streamSince(seq, onEvent, signal): Promise<void> }`
- `interface OpResult { result: unknown; seq: number }`
- `class HubConflictError extends Error { current: unknown }` — thrown on 409

- [ ] **Step 1: Write failing tests** against a stub server (use the existing hub test fixtures for shape, but do NOT import hub internals — treat it as a remote HTTP API). Cover: a successful op returns `{result, seq}`; a 409 throws `HubConflictError` carrying `current`; a 403 throws a clear auth error naming the likely cause; a 5xx is retryable while a 4xx is not.
- [ ] **Step 2: Implement `postOp`** with `Authorization: Bearer <deviceToken>`. Every mutating op sends a client-generated UUID `idempotency_key` — this is what makes replay safe, so it is not optional.
- [ ] **Step 3: Implement `streamSince`** consuming SSE, parsing `data:` frames, invoking `onEvent(event)` in order, and honouring an `AbortSignal`. Ignore `: ping` keepalives.
- [ ] **Step 4: Distinguish error classes** — network/5xx (retry with backoff) from 4xx (do not retry; surface). A daemon that retries a 403 forever is worse than one that stops and says why.
- [ ] **Step 5: Run tests, commit.**

---

## Task 3: The offline queue

**Files:** create `src/org-sync/outbox.ts`; create `test/org-outbox.test.ts`.

**Produces:**
- `class Outbox { enqueue(op, payload): string; pending(): QueuedOp[]; markSent(id); markFailed(id, reason); size(): number }`
- Persisted to `<ORCHESTRA_HOME>/outbox.json`, survives daemon restart.

- [ ] **Step 1: Write failing tests.** An op enqueued while offline persists across a reload; each op keeps a stable idempotency key across retries (**the key must be generated at enqueue time, not at send time** — a key regenerated per attempt defeats the whole mechanism); the queue is bounded at 500 and refuses further writes with a clear error rather than growing without limit; `markSent` removes; ordering is preserved.
- [ ] **Step 2: Implement,** writing atomically (temp file + rename) so a crash mid-write cannot corrupt the queue.
- [ ] **Step 3: Test the overflow path explicitly** — a full queue must fail the *new* write loudly, never silently drop an older queued op.
- [ ] **Step 4: Run tests, commit.**

---

## Task 4: The sync loop

**Files:** create `src/org-sync/sync-loop.ts`; create `test/org-sync-loop.test.ts`.

**Produces:**
- `class SyncLoop { start(): void; stop(): Promise<void>; state(): 'offline'|'connecting'|'live' }`
- Persists last applied `seq` to `<ORCHESTRA_HOME>/org-cursor.json`.

- [ ] **Step 1: Write failing tests.** On start it drains the backlog from the stored cursor and advances it; a disconnect transitions to `offline` and reconnects with backoff; on reconnect it resumes from the stored cursor with **no gap and no duplicate**; queued ops flush on reconnect, in order; a 409 during flush is surfaced (not silently dropped) and the op is removed from the queue rather than retried forever.
- [ ] **Step 2: Implement the loop.** Reconnect with exponential backoff and jitter, capped (e.g. 30s). Never busy-loop.
- [ ] **Step 3: Persist the cursor only after an event is successfully applied** — persisting before means a crash loses the event permanently, which is exactly the failure the seq design exists to prevent.
- [ ] **Step 4: Surface a 409 as the existing board etiquette** — the card was claimed or changed by someone else, so tell the agent to ask the owner, matching how conflicts already read locally.
- [ ] **Step 5: Run tests, commit.**

---

## Task 5: Daemon integration

**Files:** modify `src/daemon.ts`; create `test/org-daemon-integration.test.ts`.

- [ ] **Step 1: Write failing tests.** With no credential the daemon behaves exactly as today and starts no sync loop; with a credential it starts one; a failing sync loop does **not** prevent the daemon serving locally; `stop()` shuts the loop down cleanly with no dangling timer or listener.
- [ ] **Step 2: Start the loop from `serve()`** only when a credential loads. Log one line stating org-sync on/off — never the token.
- [ ] **Step 3: Register local agents with the hub** on startup and heartbeat their presence, so they appear on the shared board. Reuse the existing local activity derivation rather than inventing a second one.
- [ ] **Step 4: Isolate failures.** An unreachable hub must degrade to local-only operation with a visible status, never crash or hang the daemon. Assert this.
- [ ] **Step 5: Run tests, commit.**

---

## Task 6: End-to-end verification

**Files:** create `test/org-sync-e2e.test.ts`; modify `docs/hosting.md`.

- [ ] **Step 1: Write an end-to-end test** driving a real `buildHubServer` over HTTP with two simulated daemons: both join, one creates a card, the other receives it through its sync loop. This is the product's core promise; test it directly.
- [ ] **Step 2: Test the conflict path** — both daemons claim the same card; exactly one wins and the loser gets a 409 carrying current state.
- [ ] **Step 3: Test disconnect/reconnect** — kill one daemon's stream mid-flight, create cards while it is down, reconnect, and assert it catches up with no gaps or duplicates.
- [ ] **Step 4: Update `docs/hosting.md`** to replace the manual token-paste instructions with `orchestra org join`.
- [ ] **Step 5: Run the full suite (`npx vitest run`), commit.**

---

## Done Criteria

- `orchestra org join --hub <url> --org <id> --token-stdin` connects a daemon in one command.
- A card created on one machine appears on another machine's board without manual steps.
- A daemon offline for a period catches up on reconnect with no gaps or duplicates.
- Two daemons cannot claim the same card; the loser sees a 409 with current state.
- A daemon with no org joined behaves exactly as it does today.
- Full suite green.

## Known constraints worth respecting

- The hub is verified and merged; treat it as a fixed remote API.
- Concurrency guarantees in the hub rest on Postgres row locks that the local test harness cannot fully exercise — do not claim to have proven concurrency you have only simulated. Say plainly what is and is not proven.
- Every implementer on Plans 1 and 3 found at least one real defect in their brief. Read this plan critically and report defects rather than implementing something you believe is wrong.
