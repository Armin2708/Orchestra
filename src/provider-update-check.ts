// Per-provider "update available" state.
//
// Orchestra runs whichever provider CLI the operator has (cards #136/#138), so a
// stale CLI silently pins a stale model catalog — that is how a released model can
// stay invisible. Staleness must be VISIBLE, never silently corrected: this module
// only reports; applying an update is an explicit operator action, and nothing here
// ever restarts the daemon or a running agent.

import type Database from 'better-sqlite3'
import { ENVIRONMENT_COMPATIBILITY_CONTRACT } from './environment-compatibility.js'
import { compareExecutableSemver, parseExecutableSemver } from './provider-executable-version.js'

export type ProviderUpdateState = {
  provider_id: string
  installed: string | null
  latest: string | null
  update_available: boolean
  /** Documented command that upgrades this CLI. Shown to the operator; never auto-run. */
  update_command: string | null
  checked_at: string | null
  /** Set when "latest" could not be determined — the UI must not claim "up to date". */
  unknown_reason?: string
  /**
   * True when this provider is protocol-pinned (currently only codex) and the
   * installed CLI does not match the pin. Distinct from an ordinary "update
   * available": the fix is reinstalling the exact pinned version, not upgrading
   * further toward npm's `latest`.
   */
  pin_drift?: boolean
}

const PINNED_CODEX_VERSION =
  ENVIRONMENT_COMPATIBILITY_CONTRACT.providers.codex.managed.validated_versions[0]

// Each provider CLI is distributed as an npm package; its dist-tag `latest` is the
// authoritative upstream version. Providers absent from this map report unknown
// rather than a wrong "up to date".
//
// codex is the one exception: it is protocol-pinned (environment-compatibility.json
// validates exactly one version; every other version is unsupported), so it never
// gets an `@latest` nudge — see `evaluateProviderUpdate`.
const PROVIDER_PACKAGES: Readonly<Record<string, { pkg: string; update: string; pinnedVersion?: string }>> = {
  claude: { pkg: '@anthropic-ai/claude-code', update: 'claude update' },
  codex: {
    pkg: '@openai/codex',
    update: `npm install --global @openai/codex@${PINNED_CODEX_VERSION}`,
    pinnedVersion: PINNED_CODEX_VERSION,
  },
  qwen: { pkg: '@qwen-code/qwen-code', update: 'npm install --global @qwen-code/qwen-code@latest' },
  kimi: { pkg: '@moonshot-ai/kimi-cli', update: 'npm install --global @moonshot-ai/kimi-cli@latest' },
}

const CACHE_PREFIX = 'provider_latest_'
const CACHE_SUFFIX = '_v1'
const CACHE_TTL_MS = 6 * 60 * 60 * 1000 // upstream releases are not minute-to-minute news
const REGISTRY_TIMEOUT_MS = 4_000
const SAFE_PROVIDER_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/

const cacheKey = (providerId: string): string => {
  if (!SAFE_PROVIDER_ID.test(providerId)) throw new Error(`invalid provider id: ${providerId}`)
  return `${CACHE_PREFIX}${providerId}${CACHE_SUFFIX}`
}

type CachedLatest = { version: string | null; checked_at: string }

const readCache = (db: Database.Database, providerId: string): CachedLatest | null => {
  try {
    const row = db.prepare('SELECT value FROM kv WHERE key=?').get(cacheKey(providerId)) as
      { value: string } | undefined
    if (!row) return null
    const parsed = JSON.parse(row.value) as CachedLatest
    return typeof parsed?.checked_at === 'string' ? parsed : null
  } catch {
    return null
  }
}

const writeCache = (db: Database.Database, providerId: string, entry: CachedLatest): void => {
  try {
    db.prepare(`INSERT INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
      .run(cacheKey(providerId), JSON.stringify(entry))
  } catch {
    // A cache write failure must never break the provider listing.
  }
}

const isFresh = (entry: CachedLatest | null, now: number): boolean => {
  if (!entry) return false
  const at = Date.parse(entry.checked_at)
  return Number.isFinite(at) && now - at < CACHE_TTL_MS
}

/** Fetch the dist-tag `latest` version for a package. Never throws. */
export const fetchLatestVersion = async (
  packageName: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REGISTRY_TIMEOUT_MS)
  try {
    const response = await fetchImpl(
      `https://registry.npmjs.org/${packageName.replace('/', '%2F')}/latest`,
      { signal: controller.signal, headers: { accept: 'application/json' } },
    )
    if (!response.ok) return null
    const body = await response.json() as { version?: unknown }
    const version = typeof body?.version === 'string' ? body.version : null
    return version && parseExecutableSemver(version) ? version : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

export const providerUpdateCommand = (providerId: string): string | null =>
  PROVIDER_PACKAGES[providerId]?.update ?? null

/**
 * Compare an installed version against upstream `latest`.
 *
 * Fails OPEN as "unknown", never as "up to date": if latest cannot be resolved the
 * caller must not tell the operator they are current when we simply do not know.
 */
export const evaluateProviderUpdate = (
  providerId: string,
  installed: string | null,
  latest: string | null,
  checkedAt: string | null,
): ProviderUpdateState => {
  const installedSemver = parseExecutableSemver(installed)
  const pinnedVersion = PROVIDER_PACKAGES[providerId]?.pinnedVersion
  const pinnedSemver = parseExecutableSemver(pinnedVersion ?? null)
  // A pinned provider's "latest" is the pin itself, never npm's `latest` dist-tag —
  // reported for display even when the registry lookup was skipped or failed.
  const latestSemver = pinnedSemver ?? parseExecutableSemver(latest)
  const base = {
    provider_id: providerId,
    // CLIs report versions as free text ("codex-cli 0.146.0"); publish the parsed
    // semver so callers can render it directly instead of re-parsing the banner.
    installed: installedSemver?.value ?? installed,
    latest: latestSemver?.value ?? (pinnedVersion ?? latest),
    update_command: providerUpdateCommand(providerId),
    checked_at: checkedAt,
  }
  if (!installedSemver) {
    return { ...base, update_available: false, unknown_reason: 'installed version is unknown' }
  }
  if (pinnedSemver) {
    const drifted = compareExecutableSemver(installedSemver.tuple, pinnedSemver.tuple) !== 0
    return { ...base, update_available: drifted, pin_drift: drifted }
  }
  if (!latestSemver) {
    return { ...base, update_available: false, unknown_reason: 'upstream latest version is unavailable' }
  }
  return {
    ...base,
    update_available: compareExecutableSemver(latestSemver.tuple, installedSemver.tuple) > 0,
  }
}

/**
 * Resolve update state for one provider, using the cached upstream version when it is
 * still fresh. Best-effort by construction: a registry outage yields "unknown", not an
 * error, so the providers listing always renders.
 */
export const checkProviderUpdate = async (
  db: Database.Database,
  providerId: string,
  installed: string | null,
  deps: { fetchImpl?: typeof fetch; now?: () => number } = {},
): Promise<ProviderUpdateState> => {
  const now = deps.now?.() ?? Date.now()
  const packaged = PROVIDER_PACKAGES[providerId]
  if (!packaged) {
    return evaluateProviderUpdate(providerId, installed, null, null)
  }
  // Pin drift is detected against the local contract, not the registry — a pinned
  // provider never needs an npm lookup (and must still detect drift if npm is down).
  if (packaged.pinnedVersion) {
    return evaluateProviderUpdate(providerId, installed, null, new Date(now).toISOString())
  }
  const cached = readCache(db, providerId)
  if (isFresh(cached, now)) {
    return evaluateProviderUpdate(providerId, installed, cached!.version, cached!.checked_at)
  }
  const latest = await fetchLatestVersion(packaged.pkg, deps.fetchImpl ?? fetch)
  const checkedAt = new Date(now).toISOString()
  // Cache even a null result so a registry outage cannot cause a fetch storm.
  writeCache(db, providerId, { version: latest, checked_at: checkedAt })
  return evaluateProviderUpdate(providerId, installed, latest, checkedAt)
}
