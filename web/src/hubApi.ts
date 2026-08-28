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
  if (!res.ok) throw new HubApiError(res.status, await res.text())
  return res.json()
}
