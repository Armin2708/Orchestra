import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import {
  checkProviderUpdate,
  evaluateProviderUpdate,
  fetchLatestVersion,
  providerUpdateCommand,
} from '../src/provider-update-check.js'

const memoryDb = () => {
  const db = new Database(':memory:')
  db.exec(`CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT)`)
  return db
}

const jsonResponse = (body: unknown, ok = true) => ({
  ok,
  json: async () => body,
}) as unknown as Response

describe('evaluateProviderUpdate', () => {
  it('flags an update when upstream is newer', () => {
    const state = evaluateProviderUpdate('claude', '2.1.212', '2.1.222', 't')
    expect(state.update_available).toBe(true)
    expect(state.update_command).toBe('claude update')
  })

  it('reports no update when versions match', () => {
    expect(evaluateProviderUpdate('claude', '2.1.222', '2.1.222', 't').update_available).toBe(false)
  })

  it('does not flag an update when the installed CLI is newer than the registry', () => {
    expect(evaluateProviderUpdate('claude', '2.2.0', '2.1.222', 't').update_available).toBe(false)
  })

  // Fail OPEN as unknown: telling an operator they are current when we do not know
  // is the failure that keeps a stale CLI (and a stale model catalog) invisible.
  it('reports unknown — never "up to date" — when latest cannot be resolved', () => {
    const state = evaluateProviderUpdate('claude', '2.1.212', null, null)
    expect(state.update_available).toBe(false)
    expect(state.unknown_reason).toMatch(/upstream latest/)
  })

  it('reports unknown when the installed version cannot be parsed', () => {
    const state = evaluateProviderUpdate('claude', null, '2.1.222', 't')
    expect(state.unknown_reason).toMatch(/installed version/)
  })

  it('has no update command for an unknown provider', () => {
    expect(providerUpdateCommand('nope')).toBeNull()
  })
})

describe('fetchLatestVersion', () => {
  it('returns the dist-tag version', async () => {
    const latest = await fetchLatestVersion('@scope/pkg', (async () => jsonResponse({ version: '3.4.5' })) as unknown as typeof fetch)
    expect(latest).toBe('3.4.5')
  })

  it('returns null on a non-ok response instead of throwing', async () => {
    const latest = await fetchLatestVersion('@scope/pkg', (async () => jsonResponse({}, false)) as unknown as typeof fetch)
    expect(latest).toBeNull()
  })

  it('returns null when the registry throws (offline/timeout)', async () => {
    const latest = await fetchLatestVersion('@scope/pkg', (async () => { throw new Error('ENOTFOUND') }) as unknown as typeof fetch)
    expect(latest).toBeNull()
  })

  it('rejects a non-semver version string', async () => {
    const latest = await fetchLatestVersion('@scope/pkg', (async () => jsonResponse({ version: 'nightly' })) as unknown as typeof fetch)
    expect(latest).toBeNull()
  })
})

describe('checkProviderUpdate caching', () => {
  it('caches the upstream lookup so repeat calls do not hit the registry', async () => {
    const db = memoryDb()
    let calls = 0
    const fetchImpl = (async () => { calls += 1; return jsonResponse({ version: '2.1.222' }) }) as unknown as typeof fetch

    const first = await checkProviderUpdate(db, 'claude', '2.1.212', { fetchImpl })
    const second = await checkProviderUpdate(db, 'claude', '2.1.212', { fetchImpl })

    expect(first.update_available).toBe(true)
    expect(second.update_available).toBe(true)
    expect(calls).toBe(1)
  })

  it('re-checks once the cache TTL has expired', async () => {
    const db = memoryDb()
    let calls = 0
    const fetchImpl = (async () => { calls += 1; return jsonResponse({ version: '2.1.222' }) }) as unknown as typeof fetch
    const start = Date.parse('2026-08-05T00:00:00Z')

    await checkProviderUpdate(db, 'claude', '2.1.212', { fetchImpl, now: () => start })
    await checkProviderUpdate(db, 'claude', '2.1.212', { fetchImpl, now: () => start + 7 * 60 * 60 * 1000 })

    expect(calls).toBe(2)
  })

  // A registry outage must not turn into a request storm on every Settings open.
  it('caches a failed lookup and reports unknown', async () => {
    const db = memoryDb()
    let calls = 0
    const fetchImpl = (async () => { calls += 1; throw new Error('offline') }) as unknown as typeof fetch

    const first = await checkProviderUpdate(db, 'claude', '2.1.212', { fetchImpl })
    const second = await checkProviderUpdate(db, 'claude', '2.1.212', { fetchImpl })

    expect(first.unknown_reason).toMatch(/upstream latest/)
    expect(second.unknown_reason).toMatch(/upstream latest/)
    expect(calls).toBe(1)
  })

  it('reports unknown for a provider with no known package', async () => {
    const db = memoryDb()
    const state = await checkProviderUpdate(db, 'mystery', '1.0.0')
    expect(state.update_available).toBe(false)
    expect(state.update_command).toBeNull()
  })
})

describe('version normalization', () => {
  // Codex reports "codex-cli 0.146.0"; the API must publish "0.146.0" so the UI can
  // render it directly rather than showing the raw banner text.
  it('publishes the parsed semver for a CLI that reports a banner string', () => {
    const state = evaluateProviderUpdate('codex', 'codex-cli 0.146.0', '0.146.1', 't')
    expect(state.installed).toBe('0.146.0')
    expect(state.latest).toBe('0.146.1')
    expect(state.update_available).toBe(true)
  })

  it('leaves an unparseable installed string intact for diagnostics', () => {
    expect(evaluateProviderUpdate('codex', 'nightly-build', '1.0.0', 't').installed).toBe('nightly-build')
  })
})

describe('installed version reflects the CLI Orchestra actually runs', () => {
  // Regression: the panel reported the BUNDLED version while #136/#138 make the
  // daemon launch the newest of (PATH, bundled). An operator on a self-updated
  // 2.1.223 was told "update available -> 2.1.223" against the bundled 2.1.212.
  it('does not flag an update when the running CLI already matches upstream', () => {
    const state = evaluateProviderUpdate('claude', '2.1.223', '2.1.223', 't')
    expect(state.update_available).toBe(false)
    expect(state.installed).toBe('2.1.223')
  })

  it('still flags an update when the running CLI genuinely trails upstream', () => {
    expect(evaluateProviderUpdate('claude', '2.1.212', '2.1.223', 't').update_available).toBe(true)
  })
})
