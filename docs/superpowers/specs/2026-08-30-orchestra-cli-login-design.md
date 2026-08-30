# Orchestra CLI Login — Design Spec

**Date:** 2026-08-30
**Status:** approved for implementation

## Goal

`orchestra login` opens a browser, you sign in to Orchestra Cloud, and the CLI comes back
authenticated. `orchestra org connect` then connects this machine's daemon to one of your
organizations from the terminal — no copy-pasted token, no daemon restart.

## Why this doesn't exist today

Device tokens are minted at `POST /api/v1/hub/orgs/:orgId/devices`, which requires a Clerk
JWT (`request.hubUserId`). Only a browser holds one. Nobody built the browser→CLI handoff, so
the only route to a token is the "Copy this token now" modal (`web/src/HubApp.tsx`) and a
manual `orchestra org join --token-stdin`. That was a Plan-2 shortcut, not a decision.

## The security constraint this design must not break

`src/hub/server.ts:311-318` deliberately restricts device minting to a Clerk-authenticated
member: a device token minting *another* device token has no membership behind it, so
`assertSeatAvailable` becomes a no-op and one paired daemon could hand out unlimited free
daemons.

A CLI token is therefore **not** a device token with extra rights. It is a third principal
type, always bound to a `user_id`, and every mint through it resolves that user's membership
in the target org so the seat cap still meters exactly what it meters today.

## Flow

### `orchestra login`

1. CLI generates `verifier` (32 random bytes) and `state`; `challenge = base64url(sha256(verifier))`.
2. `POST /api/v1/hub/cli/auth/start` `{challenge, label}` — **unauthenticated** — returns
   `{request_id, expires_at}`. `label` is the machine name shown to the human ("mac").
3. CLI binds a loopback listener on `127.0.0.1:0` and opens
   `<webOrigin>/cli?request=<request_id>&port=<port>&state=<state>`.
4. The browser page (Clerk-authenticated) shows *which machine* is asking and an Approve
   button. Approving calls `POST /api/v1/hub/cli/auth/approve` `{request_id}` with the Clerk
   JWT; the hub records `user_id` and returns a single-use `code`.
5. The page redirects to `http://127.0.0.1:<port>/callback?code=<code>&state=<state>`.
6. The CLI checks `state` matches, then `POST /api/v1/hub/cli/auth/exchange`
   `{request_id, code, verifier}`. The hub recomputes the challenge from the verifier,
   compares in constant time, marks the request consumed, and returns `{token, user}`.
7. CLI writes `<ORCHESTRA_HOME>/cli-auth.json` mode `0600`.

### `orchestra org connect`

1. `GET /api/v1/hub/cli/orgs` (Bearer CLI token) → `[{org_id, name, role}]`.
2. One org connects automatically; several prompt for a choice.
3. `POST /api/v1/hub/cli/orgs/:orgId/devices` `{name}` → device token, seat-capped through
   the caller's membership in that org.
4. CLI saves the org credential. The daemon's credential supervisor
   (`src/org-sync/supervisor.ts`) picks it up live — **no restart**.
5. A spinner runs until the daemon reports the sync loop live, so the animation ends on a
   real state change rather than a timer.

## Security requirements

- `state`, `code` and the auth request are **single-use** with a **120s TTL**. Consumption is
  a conditional UPDATE, so two exchanges of the same code cannot both win.
- Only `sha256` of the CLI token is stored, matching `mintDeviceToken`'s existing rule.
- The redirect target is **loopback only**. The hub never redirects; the browser page does,
  and only to `127.0.0.1` on the port the CLI passed.
- PKCE binding: a stolen `code` is useless without the `verifier`, which never leaves the CLI.
- **Scope.** A CLI token authenticates exactly two routes: list-my-orgs and mint-a-device.
  It must be rejected on every org data route (cards, agents, mail, sync, ops, billing). This
  is enforced in the auth hook, not per route, so a new route is closed by default.
- Approval is explicit. The page never approves on load — a link alone must not connect a
  machine.
- Tokens are never logged, echoed, or written to shell history.

## Data

Two tables (migration 006):

- `cli_auth_requests` — `id`, `challenge`, `label`, `code_hash`, `user_id`, `created_at`,
  `expires_at`, `approved_at`, `consumed_at`.
- `cli_tokens` — `id`, `user_id`, `token_hash`, `label`, `created_at`, `last_used_at`,
  `revoked_at`.

## Out of scope

- Device-code (headless/SSH) fallback. `orchestra org join --token-stdin` still works and
  stays documented for that case.
- Refresh/rotation of CLI tokens. Revoke and log in again.
- Changing anything about how daemons authenticate to the hub afterwards.

## Done criteria

- `orchestra login` connects with no token ever visible to the user.
- `orchestra org connect` connects a **running** daemon with no restart.
- A CLI token is refused on an org data route.
- A replayed code, a wrong verifier, a mismatched state, and an expired request are each
  refused, each with a test.
- Full suite green.
