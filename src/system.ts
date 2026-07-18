import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import type Database from 'better-sqlite3'

// each hired agent is a full Claude Code SDK process (~1.5GB working set); RAM binds
// long before CPU since agents spend most of their time waiting on the API
const GB = 1024 ** 3
export function hardware(): { cores: number; total_gb: number; capacity: number } {
  const cores = os.cpus().length
  const capacity = Math.max(1, Math.min(Math.floor((os.totalmem() - 6 * GB) / (1.5 * GB)), cores * 2))
  return { cores, total_gb: Math.round(os.totalmem() / GB), capacity }
}

export type UsageError = 'keychain' | 'offline' | 'none'
type TokenRead = { token?: string; reason?: UsageError }

type UsageWindow = { utilization: number; resets_at: string | null }
export type ClaudeUsage = { five_hour: UsageWindow; seven_day: UsageWindow; stale_since?: string } | null
export type UsageResult = { usage: ClaudeUsage; usage_error: UsageError | null; usage_error_since: string | null }

const credsFileToken = (): string | undefined => {
  try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', '.credentials.json'), 'utf8'))?.claudeAiOauth?.accessToken } catch { return undefined }
}

// extracted for tests — keychain and network are unmockable inline
export const _internals = {
  // macOS keeps Claude Code's OAuth credentials in the keychain; linux in a plaintext file.
  // A headless daemon can't answer keychain prompts and npx upgrades invalidate the per-binary
  // ACL grant — those denials must surface as 'keychain', not look like missing credentials.
  async readToken(): Promise<TokenRead> {
    if (process.platform === 'darwin') {
      const { err, out } = await new Promise<{ err: any; out: string }>((resolve) => execFile('security',
        ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
        (err, out) => resolve({ err, out: out ?? '' })))
      if (!err && out.trim()) {
        try {
          const token = JSON.parse(out)?.claudeAiOauth?.accessToken
          if (token) return { token }
        } catch { /* malformed entry — fall through to file */ }
      }
      const fileToken = credsFileToken()
      if (fileToken) return { token: fileToken }
      // exit 44 = errSecItemNotFound (no entry) → no credentials; anything else is a denied/locked read
      if (err && err.code !== 44) return { reason: 'keychain' }
      return { reason: 'none' }
    }
    const token = credsFileToken()
    return token ? { token } : { reason: 'none' }
  },
  // same endpoint Claude Code's /usage command reads — real limits, not estimates
  async fetchUsage(token: string): Promise<NonNullable<ClaudeUsage>> {
    const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: { authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) throw new Error(`usage endpoint → ${res.status}`)
    const d: any = await res.json()
    return {
      five_hour: { utilization: d.five_hour?.utilization ?? 0, resets_at: d.five_hour?.resets_at ?? null },
      seven_day: { utilization: d.seven_day?.utilization ?? 0, resets_at: d.seven_day?.resets_at ?? null },
    }
  },
}

// last successful payload persists in the daemon db — a keychain-denied restart still shows
// the previous numbers, stale-marked, instead of blank meters
const saveLastUsage = (db: Database.Database | undefined, usage: NonNullable<ClaudeUsage>) =>
  db?.prepare(`INSERT INTO kv (key, value) VALUES ('last_usage', ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now')`)
    .run(JSON.stringify(usage))
const loadLastUsage = (db: Database.Database | undefined): { usage: NonNullable<ClaudeUsage>; at: string } | undefined => {
  const row = db?.prepare(`SELECT value, updated_at FROM kv WHERE key='last_usage'`).get() as any
  try { return row ? { usage: JSON.parse(row.value), at: row.updated_at } : undefined } catch { return undefined }
}

let cache: { at: number; result: UsageResult } | undefined
let failSince: string | undefined
let loggedReason: UsageError | undefined
export const _resetUsageState = () => { cache = failSince = loggedReason = undefined }

export async function claudeUsage(db?: Database.Database): Promise<UsageResult> {
  if (cache && Date.now() - cache.at < 60_000) return cache.result
  let usage: NonNullable<ClaudeUsage> | undefined
  let reason: UsageError | null = null
  const read = await _internals.readToken()
  if (!read.token) reason = read.reason ?? 'none'
  else {
    try { usage = await _internals.fetchUsage(read.token) } catch { reason = 'offline' }
  }
  let result: UsageResult
  if (usage) {
    failSince = loggedReason = undefined
    saveLastUsage(db, usage)
    result = { usage, usage_error: null, usage_error_since: null }
  } else {
    failSince ??= new Date().toISOString()
    if (loggedReason !== reason) { // once per failure streak, not once per minute
      loggedReason = reason!
      console.error(`[orchestra] Claude usage unavailable (${reason}) — meters degrade to stale/unavailable. ` +
        `Remedy: restart the daemon from an interactive terminal (orchestra restart) and choose "Always Allow" on the keychain prompt.`)
    }
    const last = loadLastUsage(db)
    result = {
      usage: last ? { ...last.usage, stale_since: last.at } : null,
      usage_error: reason,
      usage_error_since: failSince,
    }
  }
  cache = { at: Date.now(), result }
  return result
}
