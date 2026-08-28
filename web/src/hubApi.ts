import { getToken } from '@clerk/react'

/**
 * The browser→hub client. Deliberately separate from `./api.ts`: that module
 * is same-origin only (`credentials: 'omit'`, hardcoded `/api/v1`, and its
 * `Bearer ` meaning is "local owner session" — its 401 handler clears that
 * session on any 401). Splitting the UI onto Vercel while the hub runs on
 * Railway makes this the first cross-origin caller, authenticated with a
 * Clerk session token instead. Reusing `api()` for hub calls would make a
 * hub 401 clear the wrong (local-owner or paired-device) session — hence a
 * new module instead of a third meaning bolted onto `Bearer ` there.
 */

export class HubApiError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

/**
 * `import.meta.env.VITE_*` is inlined by Vite at BUILD time: one real build
 * bakes in one fixed value, permanently — nothing at runtime (including a
 * test mutating `process.env` or calling `vi.stubEnv`) changes what a
 * built/transformed module reads afterward, because the replacement happens
 * once, before any test code runs. Routing every read through this function
 * — rather than touching `import.meta.env` inline at each call site — gives
 * tests a seam (`__setHubEnvOverrideForTest`) to exercise both the
 * configured and unconfigured states in a single run. Production code never
 * calls the setter, so shipped behavior is exactly "whatever the build
 * baked in", unchanged.
 */
type HubEnvKey = 'VITE_HUB_BASE_URL' | 'VITE_CLERK_PUBLISHABLE_KEY'
let testEnvOverride: Partial<Record<HubEnvKey, string | undefined>> | null = null

/** Test-only seam — see the comment above. Pass `null` to restore the real build-time env. */
export function __setHubEnvOverrideForTest(override: Partial<Record<HubEnvKey, string | undefined>> | null): void {
  testEnvOverride = override
}

function readHubEnv(key: HubEnvKey): string | undefined {
  if (testEnvOverride) return testEnvOverride[key]
  return (import.meta.env as unknown as Record<string, string | undefined>)[key]
}

/**
 * True only when both the hub's base URL and the Clerk publishable key were
 * baked into this build. Local single-machine mode ships with neither set —
 * that must keep working with a false return here, never a thrown error,
 * since callers use this to decide whether to attempt any hub call at all.
 */
export function hubConfigured(): boolean {
  return Boolean(readHubEnv('VITE_HUB_BASE_URL') && readHubEnv('VITE_CLERK_PUBLISHABLE_KEY'))
}

/**
 * Calls the hub at `${VITE_HUB_BASE_URL}/api/v1/hub${path}`, authenticated
 * with the current Clerk session token. Never attempts a network call when
 * `hubConfigured()` is false — a missing env var must fail closed, not blank
 * the board with a doomed cross-origin request.
 *
 * Uses the top-level `getToken` export (not the `useAuth()` hook) because
 * this is a plain async function, callable from outside React render —
 * exactly the "API interceptor / data-fetching layer" use case it documents.
 */
export async function hubFetch(method: string, path: string, body?: unknown): Promise<unknown> {
  if (!hubConfigured()) {
    throw new HubApiError(0, 'hub is not configured (VITE_HUB_BASE_URL / VITE_CLERK_PUBLISHABLE_KEY unset)')
  }
  const base = readHubEnv('VITE_HUB_BASE_URL')!

  const token = await getToken()
  if (!token) throw new HubApiError(401, 'not signed in')

  const headers: Record<string, string> = { authorization: `Bearer ${token}` }
  if (body !== undefined) headers['content-type'] = 'application/json'

  const res = await fetch(`${base}/api/v1/hub${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'omit',
    cache: 'no-store',
    redirect: 'error',
    referrerPolicy: 'no-referrer',
  })
  if (!res.ok) throw new HubApiError(res.status, await hubErrorMessage(res))
  return res.json()
}

/**
 * Every hub error body is `{ error, code }` (see `HubError`/`setErrorHandler` in
 * src/hub/server.ts) — extracts `.error` so `HubApiError.message` is the actual
 * human-readable refusal (e.g. `assertSeatAvailable`'s over-cap text) rather than
 * the raw `{"error":"…","code":"forbidden"}` JSON a UI would otherwise render
 * verbatim. Falls back to the raw response text for a body that isn't JSON
 * shaped like that (a proxy error page, an empty body, …) so no failure mode
 * loses information — it just stays unparsed instead of showing "undefined".
 */
async function hubErrorMessage(res: Response): Promise<string> {
  const text = await res.text()
  try {
    const parsed = JSON.parse(text) as { error?: unknown }
    if (typeof parsed.error === 'string' && parsed.error) return parsed.error
  } catch { /* not JSON — fall through to the raw text */ }
  return text
}

// ---------------------------------------------------------------------------
// Task 7: typed wrappers around hubFetch for the web UI's org board, billing
// page, and device-token mint flow. Field names here deliberately mirror
// src/hub/types.ts (HubCard, HubAgent) verbatim — the web package builds
// separately from the hub server and cannot import its types directly, so
// these are a hand-kept structural copy, not a shared source of truth.
// ---------------------------------------------------------------------------

export type HubCardColumn = 'backlog' | 'in_progress' | 'blocked' | 'review' | 'done'

export interface HubCard {
  id: string
  org_id: string
  board_id: string
  number: number
  title: string
  description: string
  column: HubCardColumn
  owner_agent: string | null
  paths: string[]
  version: number
  created_at: string
  updated_at: string
}

export type HubAgentState = 'working' | 'idle' | 'waiting' | 'offline'

export interface HubAgent {
  id: string
  org_id: string
  board_id: string
  device_id: string | null
  name: string
  state: HubAgentState
  current_card_id: string | null
  activity: string | null
  last_heartbeat_at: string | null
}

export interface HubEntitlements {
  tier: 'cloud' | 'business' | 'none'
  status: string
  sso: boolean
  seats: { used: number; entitled: number; overCap: boolean }
  agents: { used: number; entitled: number; overCap: boolean }
}

export interface HubDevice {
  id: string
  org_id: string
  membership_id: string | null
  name: string
  last_seen_at: string | null
  revoked_at: string | null
}

/**
 * The one call a freshly signed-in browser makes before any other org-scoped
 * request: maps the Clerk org the user has selected onto this hub's own
 * `orgs.id` (a random `org_<uuid>` — see `GET /api/v1/hub/me` in
 * src/hub/server.ts for why nothing else can derive it). Throws
 * `HubApiError(403, …)` when the signed-in user has no active org selected
 * yet — callers should treat that as "prompt org selection/creation", not as
 * a fatal error.
 */
export async function resolveHubIdentity(): Promise<{ userId: string; orgId: string }> {
  const body = await hubFetch('GET', '/me') as { user_id: string; org_id: string }
  return { userId: body.user_id, orgId: body.org_id }
}

export async function listHubCards(orgId: string): Promise<HubCard[]> {
  const body = await hubFetch('GET', `/orgs/${orgId}/cards`) as { cards: HubCard[] }
  return body.cards
}

export async function listHubAgents(orgId: string): Promise<HubAgent[]> {
  const body = await hubFetch('GET', `/orgs/${orgId}/agents`) as { agents: HubAgent[] }
  return body.agents
}

export async function getHubEntitlements(orgId: string): Promise<HubEntitlements> {
  return await hubFetch('GET', `/orgs/${orgId}/entitlements`) as HubEntitlements
}

export async function createHubCheckout(
  orgId: string, lookupKey: string, quantity?: number,
): Promise<{ url: string }> {
  return await hubFetch('POST', `/orgs/${orgId}/billing/checkout`, {
    lookup_key: lookupKey, quantity,
  }) as { url: string }
}

export async function createHubPortal(orgId: string): Promise<{ url: string }> {
  return await hubFetch('POST', `/orgs/${orgId}/billing/portal`) as { url: string }
}

/** Mints a device token for the signed-in member — returns the plaintext exactly
 * once (see POST /orgs/:orgId/devices in src/hub/server.ts). Callers must show
 * it to the user immediately and never re-fetch it: only its hash is stored. */
export async function mintHubDeviceToken(orgId: string, name: string): Promise<{ device: HubDevice; token: string }> {
  return await hubFetch('POST', `/orgs/${orgId}/devices`, { name }) as { device: HubDevice; token: string }
}
