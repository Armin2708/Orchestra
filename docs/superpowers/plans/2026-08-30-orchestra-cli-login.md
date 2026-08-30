# Orchestra CLI Login — Implementation Plan

**Spec:** `docs/superpowers/specs/2026-08-30-orchestra-cli-login-design.md`

**Goal:** `orchestra login` (browser handoff) + `orchestra org connect` (pick org, connect a
running daemon with no restart).

## Global Constraints

- ESM; every intra-repo import ends in `.js`. Tests are vitest.
- Never log, echo, or persist a plaintext token beyond its `0600` credential file.
- A CLI token must never authenticate an org data route — enforced in the auth hook.
- A device mint through a CLI token must still be seat-capped via the caller's membership.
- Do not change how existing device tokens or Clerk JWTs authenticate.
- Never run `git stash`. Never branch in the shared checkout.

---

## Task 1: Schema

**Files:** create `src/hub/migrations/006-cli-auth.sql`; modify `src/hub/migrations.ts` if the
list is explicit.

- `cli_auth_requests(id text pk, challenge text not null, label text not null, code_hash text,
  user_id text references users(id), created_at timestamptz not null default now(),
  expires_at timestamptz not null, approved_at timestamptz, consumed_at timestamptz)`
- `cli_tokens(id text pk, user_id text not null references users(id), token_hash text not null
  unique, label text not null, created_at timestamptz not null default now(),
  last_used_at timestamptz, revoked_at timestamptz)`
- Index `cli_tokens(user_id)`.
- Migrations must stay pure DDL — the PGlite test path splits on `;`.

## Task 2: Hub CLI-auth domain

**Files:** create `src/hub/cli-auth.ts`, `test/hub-cli-auth.test.ts`.

Produces:
- `startCliAuth(sql, {challenge, label}): Promise<{id, expiresAt}>`
- `approveCliAuth(sql, {requestId, userId}): Promise<{code}>` — one-time, stores `code_hash`
- `exchangeCliAuth(sql, {requestId, code, verifier}): Promise<{token, userId}>` — verifies
  `sha256(verifier) === challenge` in constant time, consumes the request conditionally,
  mints and returns a `orchestra_cli_v1.` token
- `verifyCliToken(sql, token): Promise<{id, userId}>`
- `listUserOrgs(sql, userId)`

Tests: happy path; replayed code refused; wrong verifier refused; expired request refused;
approving twice refused; exchange before approval refused; two concurrent exchanges yield
exactly one winner.

## Task 3: Hub routes + scope enforcement

**Files:** modify `src/hub/server.ts`; create `test/hub-cli-routes.test.ts`.

- `POST /api/v1/hub/cli/auth/start` (unauthenticated)
- `POST /api/v1/hub/cli/auth/approve` (Clerk JWT only)
- `POST /api/v1/hub/cli/auth/exchange` (unauthenticated; PKCE is the credential)
- `GET /api/v1/hub/cli/orgs` (CLI token)
- `POST /api/v1/hub/cli/orgs/:orgId/devices` (CLI token → membership → `mintDeviceToken`)

Auth hook: recognise the `orchestra_cli_v1.` prefix and set `request.hubCliUserId`. A CLI
token sets **no** `hubOrgId`, so every org-scoped route rejects it by construction.

Tests: a CLI token is refused on cards/agents/sync/ops/billing; mint is seat-capped; a
device token cannot call the CLI routes.

## Task 4: Cloud approval page

**Files:** create `web/src/CliApprove.tsx`; modify `web/src/cloud-main.tsx`.

Route on `/cli`. Signed out → Clerk sign-in, preserving the query. Signed in → show the
machine label and Approve/Cancel. Approve calls `/cli/auth/approve`, then
`window.location.replace('http://127.0.0.1:<port>/callback?code=…&state=…')`. Never
auto-approve on mount.

## Task 5: CLI login

**Files:** create `src/cli-auth.ts` (credential storage), `src/login-cli.ts`; modify `src/cli.ts`;
create `test/cli-login.test.ts`.

`orchestra login [--hub <url>]`, `orchestra logout`, `orchestra whoami`. Loopback listener on
`127.0.0.1:0`, opens the browser, verifies `state`, exchanges, stores `0600`. Refuses a
non-loopback callback. Times out with a clear message and the `--token-stdin` fallback named.

## Task 6: `orchestra org connect` + animation

**Files:** modify `src/org-cli.ts`; create `test/org-connect.test.ts`.

Lists orgs, auto-selects a single one, prompts otherwise, mints, saves the credential, then
spins until the daemon's sync loop is live. Requires a way to observe that: add
`GET /api/v1/org` to the daemon returning `{joined, orgId, state}` from the supervisor.

## Task 7: Docs + full verification

Update `docs/hosting.md` to lead with `orchestra login` and keep `--token-stdin` as the
headless path. Full suite, typecheck, manual run against the local hub.
