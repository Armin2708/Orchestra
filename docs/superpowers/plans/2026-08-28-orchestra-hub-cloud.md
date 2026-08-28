# Orchestra Cloud — Auth, Billing, UI, Deploy (Plan 3 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take the finished hub server core and make it a product people can sign into, pay for, and use from a browser — deployed on Railway (hub), Vercel (web UI), and Supabase (Postgres).

**Architecture:** Clerk owns human identity and organizations; the hub mirrors them into Postgres via webhooks so org-scoped queries never call Clerk on the hot path. Stripe owns billing; its catalogue is **already built in test and live mode**, so this plan writes only the integration. Daemons keep authenticating with hub-minted device tokens; browsers authenticate with Clerk session JWTs through a **separate client module**, leaving the local single-machine app's device/DPoP path untouched.

**Tech Stack:** TypeScript ESM (NodeNext, `.js` imports), Fastify 5, `pg` against Supabase's **session pooler**, `@clerk/backend` (hub) + `@clerk/react` 6.14.7 (web), `stripe` (Node SDK), Vite/React on Vercel, vitest + PGlite for tests.

**Spec:** `docs/superpowers/specs/2026-08-28-orchestra-hub-design.md`

**Depends on:** Plan 1 (`docs/superpowers/plans/2026-08-28-orchestra-hub-core.md`), complete on branch `feat/hub-core`. This plan builds on that branch.

## Global Constraints

- **ESM only.** `"type": "module"`, `module: NodeNext`. Every intra-repo import ends in `.js`.
- **Node `>=22.20.0 <23`, npm `>=10.9.3 <11`** — a hard engines pin. Any container or CI image must match, or `npm ci` fails outright.
- Tests are vitest: `npx vitest run <file>`. Tests live in `test/**/*.test.ts`.
- **No `better-sqlite3` under `src/hub/`.** The hosted server must not import the local SQLite stack at all — see Task 1.
- **Do not modify `src/server.ts`** (the local single-machine server) or `web/src/deviceAuth.ts` (its DPoP device auth). Both are load-bearing for the free local product and out of scope here.
- **Do not modify `web/src/api.ts`'s auth behaviour.** It already branches on `authorization` being `Bearer ` (local owner) or `Device ` (paired device), and its 401 handler clears the matching session. A Clerk token added as a third `Bearer` meaning would clear the wrong session. Hub calls go through a new module instead.
- **Stripe prices are referenced by LOOKUP KEY, never by price id.** Keys are identical in test and live; ids are not. A hardcoded `price_…` works in test and breaks in production.
- **Stripe CLI calls must pass `--project-name orchestraboard`.** The `default` profile points at an unrelated business.
- Migrations are numbered, append-only, and never edited once committed. Continue from `005`.
- Secrets (`CLERK_SECRET_KEY`, `STRIPE_SECRET_KEY`, webhook signing secrets, `HUB_DATABASE_URL`) must never be logged, echoed in an error, or returned in a response body.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `src/hub-entry.ts` | Hub-only process entrypoint — imports NO local-daemon code, so the hosted bundle has zero native dependencies |
| `src/hub/env.ts` | Typed env accessor for every hub setting, with clear errors for missing required values |
| `src/hub/cors.ts` | CORS for the Vercel origin — allowlist, never `*` |
| `src/hub/clerk.ts` | Clerk JWT verification and the `clerk_org_id → orgs.id` resolution |
| `src/hub/webhooks/clerk.ts` | Clerk webhook route: signature verification + mirror-table sync |
| `src/hub/webhooks/stripe.ts` | Stripe webhook route: signature verification + subscription/quantity sync |
| `src/hub/billing.ts` | Checkout session + customer portal, priced by lookup key |
| `src/hub/entitlements.ts` | Seat and concurrent-agent limits derived from subscription items; the enforcement gate |
| `src/hub/migrations/005-hub-entitlements.sql` | Cached entitlement columns |
| `web/src/hubApi.ts` | Browser → hub client: `VITE_HUB_BASE_URL` + Clerk JWT. Separate from `api.ts` by design |
| `web/src/HubBoard.tsx` | Org board view (agents, cards, presence) for hosted mode |
| `web/src/BillingPage.tsx` | Plan state + upgrade/manage buttons |
| `Dockerfile` / `railway.json` | Railway build and run |
| `vercel.json` | Vercel build config for `web/` |
| `docs/hosting.md` | Env var reference and the provisioning runbook |

---

## Task 1: Hub-only entrypoint and Railway readiness

The hosted server currently cannot deploy cleanly: `dist/cli.js` statically imports `better-sqlite3` and `node-pty` (both native C++ addons) even though `orchestra hub` never touches SQLite or a PTY, the port comes only from `--port` while Railway supplies `$PORT`, and there is no `start` script.

**Files:** Create `src/hub-entry.ts`, `src/hub/env.ts`, `Dockerfile`, `railway.json`; modify `tsup.config.ts`, `package.json`, `src/hub-cli.ts`, `src/hub/server.ts`; create `test/hub-env.test.ts`, `test/hub-entry-build.test.ts`.

**Interfaces produced:**
- `hubEnv(env?: NodeJS.ProcessEnv): HubEnv` — throws `ValidationError` naming any missing required variable
- `interface HubEnv { databaseUrl; port; webOrigin; hubBaseUrl; clerkSecretKey; clerkPublishableKey; clerkWebhookSigningSecret; stripeSecretKey; stripeWebhookSecret }`
- `dist/hub-entry.js` — a bundle that does not reference `better-sqlite3` or `node-pty`

- [ ] **Step 1: Write the failing env test** — `hubEnv({})` throws naming `HUB_DATABASE_URL`; a full env parses; `PORT` is preferred over the default; a malformed `PORT` is rejected. Assert the thrown message never contains a secret's *value*.

- [ ] **Step 2: Write `src/hub/env.ts`.** Required: `HUB_DATABASE_URL` (or `DATABASE_URL`). Optional-with-defaults: `PORT` (4760), `WEB_ORIGIN`, `HUB_BASE_URL`. Clerk/Stripe values are required only by the tasks that use them — expose them as optional here so Task 1 can ship and deploy before billing exists.

- [ ] **Step 3: Write `src/hub-entry.ts`.** It imports only `./hub/pg.js`, `./hub/migrations.js`, `./hub/server.js`, `./hub/env.js`. It must NOT import `./cli.js`, `./daemon.js`, or anything under `src/agent-os/`. Run migrations, build the server, listen on `0.0.0.0:$PORT`.

- [ ] **Step 4: Add the second tsup entry.** `entry: ['src/cli.ts', 'src/hub-entry.ts']`. Keep `copy-hub-migrations.mjs` in the build — and note it copies to `<outDir>/migrations` deliberately; Plan 1 shipped a boot-failure bug by copying to `<outDir>/hub/migrations`, and `test/hub-build-migrations.test.ts` guards it.

- [ ] **Step 5: Write the build assertion test.** After `npx tsup`, read `dist/hub-entry.js` and assert it contains neither `better-sqlite3` nor `node-pty`. This is the whole point of the task — without it the split silently regresses the first time someone adds an import.

- [ ] **Step 6: Add `"start": "node dist/hub-entry.js"`** to `package.json`, and teach `src/hub-cli.ts` to fall back to `env.PORT` so `orchestra hub` behaves identically to the entrypoint.

- [ ] **Step 7: Fastify options for a proxied environment.** In `buildHubServer`, enable `trustProxy: true` (Railway terminates TLS upstream, so client IPs and `x-forwarded-proto` are otherwise wrong) and a `logger` so Railway's log pane shows requests. Do not log headers or bodies — they carry tokens.

- [ ] **Step 8: Write `Dockerfile` and `railway.json`.** Base image `node:22.20-bookworm-slim` to satisfy the engines pin. `npm ci`, `npm run build`, `npm start`. Healthcheck path `/healthz` (already unauthenticated). Do not copy a host `node_modules` in — platform-specific optional binaries would be wrong.

- [ ] **Step 9: Verify, then commit.** `npx vitest run test/hub-env.test.ts test/hub-entry-build.test.ts test/hub-build-migrations.test.ts`, plus a real `npm run build` and a local `PORT=4999 HUB_DATABASE_URL=… node dist/hub-entry.js` boot.

---

## Task 2: CORS and the browser→hub client

Splitting the UI onto Vercel makes the browser call the hub cross-origin for the first time. The existing `web/src/api.ts` cannot be reused: it hardcodes same-origin `/api/v1`, sends `credentials: 'omit'`, and its DPoP signatures bind `location.origin` into the `htu` claim.

**Files:** Create `src/hub/cors.ts`, `web/src/hubApi.ts`; modify `src/hub/server.ts`, `web/vite.config.ts`; create `test/hub-cors.test.ts`.

**Interfaces produced:**
- `registerHubCors(server: FastifyInstance, webOrigin: string | undefined): void`
- `hubFetch(method: string, path: string, body?: unknown): Promise<unknown>` in `web/src/hubApi.ts`
- `hubConfigured(): boolean` — true only when `VITE_HUB_BASE_URL` and `VITE_CLERK_PUBLISHABLE_KEY` are both set

- [ ] **Step 1: Write the failing CORS test.** A preflight `OPTIONS` from the configured origin returns the origin echoed plus `access-control-allow-credentials: true`; a preflight from any other origin does NOT receive an allow-origin header; the response is never `*`. Also assert `vary: origin` is set, since responses differ per origin and a shared cache must not serve one origin's response to another.

- [ ] **Step 2: Add `@fastify/cors`** (the hub currently registers no CORS at all) and write `src/hub/cors.ts`. Allow exactly `WEB_ORIGIN`. When `WEB_ORIGIN` is unset (local development), register nothing — a hub with no configured origin must not become open to every site.

- [ ] **Step 3: Write `web/src/hubApi.ts`.** It reads `import.meta.env.VITE_HUB_BASE_URL`, obtains a Clerk token via `useAuth().getToken()` (or the top-level `getToken` export — `@clerk/react` 6.14.7 exports both), and sends `Authorization: Bearer <clerk_jwt>` to the hub's own origin. It is a *separate* module: `web/src/api.ts` and `web/src/deviceAuth.ts` are not modified, so the local app's auth is untouched.

- [ ] **Step 4: Local mode must still work with neither variable set.** `hubConfigured()` returns false and no hub call is ever made. Assert this — a missing env var must not blank the board.

- [ ] **Step 5: Commit.**

---

## Task 3: Clerk JWT verification in the hub

**Files:** Create `src/hub/clerk.ts`; modify `src/hub/server.ts`; create `test/hub-clerk-auth.test.ts`.

**Interfaces produced:**
- `verifyClerkToken(token: string, env: HubEnv): Promise<ClerkPrincipal>` where `ClerkPrincipal = { clerkUserId: string; clerkOrgId: string | null }`
- `resolveOrgForClerk(sql, principal): Promise<{ orgId: string; membershipId: string }>` — 403 if the user has no mirrored membership
- Request decorations gain `hubUserId: string | null`

**The existing `onRequest` hook (Plan 1) currently accepts only device tokens.** It must now accept either, without weakening what Plan 1's reviews established.

- [ ] **Step 1: Write the failing tests.**
  - A device token still authenticates exactly as before (regression guard — Plan 1's whole security model rests on it).
  - A valid Clerk JWT whose org maps to a mirrored membership sets `hubOrgId` and `hubUserId`.
  - A valid Clerk JWT for an org the user is NOT a member of is refused 403.
  - An invalid/expired Clerk JWT is refused with **the same generic body** as an invalid device token. Plan 1 deliberately collapsed all auth failures to one body so "unknown" and "revoked" can't be distinguished; adding a third failure mode must not reintroduce an oracle. Assert byte-identical responses.

- [ ] **Step 2: Add `@clerk/backend`** and write `src/hub/clerk.ts` using `verifyToken` with the secret key. Never trust an unverified claim.

- [ ] **Step 3: Discriminate token types by shape, not by trial.** Device tokens are prefixed `orchestra_device_v1.` (see `src/hub/devices.ts`). Anything else is treated as a Clerk JWT. Do not attempt device verification on a Clerk token — a failed lookup would still cost a database round trip per request.

- [ ] **Step 4: Resolve the org from the mirror tables, never from the JWT alone.** The JWT's `org_id` is a Clerk id; map it through `orgs.clerk_org_id` and confirm a `memberships` row exists. A user presenting a valid token for an org they were removed from must be refused even if Clerk's token has not expired yet.

- [ ] **Step 5: Preserve the path-org check.** Plan 1's hook 403s when the route's `:orgId` disagrees with the token's org. That must hold for Clerk principals too. Add a test.

- [ ] **Step 6: Commit.**

---

## Task 4: Clerk webhooks and the identity mirror

**Files:** Create `src/hub/webhooks/clerk.ts`; modify `src/hub/server.ts`; create `test/hub-clerk-webhook.test.ts`.

**Interfaces produced:**
- `hubClerkWebhookPlugin: FastifyPluginAsync<{ sql; env }>` mounted at `POST /webhooks/clerk`
- Handles `user.created|updated|deleted`, `organization.created|updated|deleted`, `organizationMembership.created|updated|deleted`

- [ ] **Step 1: Write the failing tests.** A correctly-signed payload creates the mirror row; a payload with a bad signature is rejected 400 and writes nothing; replaying the same event is a no-op (idempotent by Svix message id); `organizationMembership.deleted` removes the membership **and revokes that member's device tokens** — otherwise a removed teammate's daemon keeps full access indefinitely, which is the security-relevant case.

- [ ] **Step 2: Mount the route OUTSIDE `/api/v1/hub/`.** Plan 1's auth hook returns early for anything not under that prefix, so the webhook is unauthenticated by that hook — which is correct: it carries its own Svix signature. Verify the signature; never accept an unsigned payload.

- [ ] **Step 3: Raw body.** Signature verification needs the exact bytes. Register a content-type parser scoped to this route that preserves the raw buffer; Fastify's default JSON parsing destroys it.

- [ ] **Step 4: Enforce the seat cap on membership creation.** When accepting `organizationMembership.created` would exceed the org's entitled seats (Task 6), record the membership as over-cap rather than silently allowing it, and surface it. Do not throw away the webhook — Clerk will retry and the state would flap.

- [ ] **Step 5: Commit.**

---

## Task 5: Stripe checkout, portal, and webhooks

The Stripe catalogue already exists in test **and** live mode. This task writes only integration code.

**Files:** Create `src/hub/billing.ts`, `src/hub/webhooks/stripe.ts`, `src/hub/migrations/005-hub-entitlements.sql`; modify `src/hub/migrations.ts`, `src/hub/server.ts`; create `test/hub-billing.test.ts`, `test/hub-stripe-webhook.test.ts`.

**Interfaces produced:**
- `createCheckoutSession(sql, stripe, { orgId, lookupKey, quantity }): Promise<{ url: string }>`
- `createPortalSession(sql, stripe, { orgId }): Promise<{ url: string }>`
- `syncSubscriptionFromStripe(sql, subscription): Promise<void>` — updates status, period end, and cached quantities
- Migration `005-hub-entitlements` adds to `subscriptions`: `seats_included`, `seats_purchased`, `agent_packs`, `sso_enabled`

- [ ] **Step 1: Write the failing tests.** Checkout resolves a price by **lookup key** (assert the Stripe call is made with `lookup_keys`, not a price id); an unknown lookup key is a 400, not a 500; a signed `checkout.session.completed` marks the org active and caches quantities; `customer.subscription.deleted` suspends the org; a bad signature is rejected and writes nothing; replaying an event is idempotent.

- [ ] **Step 2: Write migration `005-hub-entitlements.sql`.** Pure DDL only — `hubMigrate`'s splitter rejects `$$`-quoted bodies by design.

- [ ] **Step 3: Write `src/hub/billing.ts`.** Resolve prices via `stripe.prices.list({ lookup_keys: [key], expand: ['data.product'] })`. The lookup keys are exactly: `cloud_base_{monthly,yearly}`, `cloud_seat_{monthly,yearly}`, `cloud_agent_pack_{monthly,yearly}`, `cloud_sso_{monthly,yearly}`, `business_seat_{monthly,yearly}`.

- [ ] **Step 4: Write the webhook with raw-body signature verification**, same mechanics as Clerk's. Derive cached quantities from subscription **items**, since the subscription is multi-line (base + seats + packs + SSO).

- [ ] **Step 5: Never trust the client for price or quantity beyond the lookup key.** A checkout request naming `cloud_base_monthly` must not be able to smuggle an amount. Assert this in a test.

- [ ] **Step 6: Commit.**

---

## Task 6: Entitlement enforcement

**Files:** Create `src/hub/entitlements.ts`; modify `src/hub/server.ts`, `src/hub/routes/ops.ts`; create `test/hub-entitlements.test.ts`.

**Interfaces produced:**
- `entitlementsFor(sql, orgId): Promise<{ seats: number; concurrentAgents: number; sso: boolean; status: string }>`
- `assertOrgWritable(sql, orgId): Promise<void>` — throws `ForbiddenError` when suspended
- `assertAgentCapacity(sql, orgId): Promise<void>` — throws when live agents would exceed the cap

- [ ] **Step 1: Write the failing tests.** Seats = 3 (base) + purchased; concurrent agents = 3 × seats + 10 × packs. A suspended org **allows reads and refuses writes** — assert both halves, since the point is that nobody's data is held hostage. Registering an agent beyond capacity is refused with a clear, actionable error naming the limit. An org at exactly its cap can still operate.

- [ ] **Step 2: Implement, deriving limits from the cached columns**, never from a live Stripe call — billing must not be on the request path, and Stripe being down must not stop a paying team from working.

- [ ] **Step 3: Wire `assertOrgWritable` into the ops endpoint** for every mutating op, and `assertAgentCapacity` into `agent.register`.

- [ ] **Step 4: Commit.**

---

## Task 7: Web UI hub mode

**Files:** Create `web/src/HubBoard.tsx`, `web/src/BillingPage.tsx`; modify `web/src/App.tsx`, `web/src/ClerkAuthControls.tsx`, `web/src/styles.css`; create `web/src/hubMode.test.ts` if the web package has a test runner, otherwise cover the logic in `test/`.

- [ ] **Step 1: Add the org switcher.** `@clerk/react` 6.14.7 exports `OrganizationSwitcher`, `CreateOrganization`, `useOrganization` — use them rather than hand-rolling. Note this version has **no `SignedIn`/`SignedOut`**; the API is `<Show when="signed-in">`.

- [ ] **Step 2: Build the org board** — cards, agents with an owner badge, presence dot, and the one-line activity string. Reuse existing board components; do not fork them.

- [ ] **Step 3: Build the billing page** — current plan, seats used vs entitled, agent capacity used vs entitled, and buttons hitting checkout/portal.

- [ ] **Step 4: Bring the merged Clerk UI across.** The existing sign-in controls live on branch `feat/clerk-web` (commit `8ff6f15`) and are not on `main`. Merge or cherry-pick rather than reimplementing. Add the missing `.clerk-auth` CSS rule — the component references a class that does not exist yet.

- [ ] **Step 5: Local mode must be visually unchanged** when `VITE_HUB_BASE_URL` and `VITE_CLERK_PUBLISHABLE_KEY` are unset. Verify by building without them.

- [ ] **Step 6: Commit.**

---

## Task 8: Deploy

**Files:** Create `vercel.json`, `docs/hosting.md`; modify `.github/workflows/ci.yml` if a deploy gate is wanted.

- [ ] **Step 1: Write `docs/hosting.md`** — every env var, which platform sets it, and the provisioning order. This is the runbook a human follows; make it complete enough to redo from scratch.

- [ ] **Step 2: Vercel config.** Root directory `web/`, build `npm run build`, output `dist`. Build-time env: `VITE_HUB_BASE_URL`, `VITE_CLERK_PUBLISHABLE_KEY` — Vite inlines these at build time, so they are build variables, not runtime ones. A changed value needs a rebuild, not a restart; say so in the runbook.

- [ ] **Step 3: Railway config.** Deploy the Dockerfile from Task 1. Set `HUB_DATABASE_URL` to Supabase's **session pooler** URI (the transaction pooler breaks the session-scoped advisory lock the migrations rely on and cannot hold transactions across statements). Set `WEB_ORIGIN` to the Vercel URL.

- [ ] **Step 4: Point both webhooks at the Railway hub** — `/webhooks/clerk` and `/webhooks/stripe`. Not at Vercel; they mutate database state.

- [ ] **Step 5: Smoke test the deployed system end to end.** Sign up → create org → pay in Stripe **test mode** → join a daemon → create a card from one machine → see it on another. Record the result in `docs/hosting.md`.

- [ ] **Step 6: Commit.**

---

## Done Criteria

- `dist/hub-entry.js` contains no native dependency, boots on Railway, and passes `/healthz`.
- A browser on the Vercel origin can sign in with Clerk, create an org, pay in Stripe test mode, and see the org board.
- A daemon joins with a device token and its cards and agents appear for other members in real time.
- A suspended org serves reads and refuses writes.
- Removing a member in Clerk revokes their device tokens.
- Local single-machine mode is unchanged with no hub or Clerk env set.

## What this plan does NOT do

Production Clerk instance (development keys are deliberate for now — see the operator decision), custom domains, per-seat proration edge cases, SSO enforcement beyond the entitlement flag, and multi-region or HA. All are follow-ups.
