import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'

// each hired agent is a full Claude Code SDK process (~1.5GB working set); RAM binds
// long before CPU since agents spend most of their time waiting on the API
const GB = 1024 ** 3
export function hardware(): { cores: number; total_gb: number; capacity: number } {
  const cores = os.cpus().length
  const capacity = Math.max(1, Math.min(Math.floor((os.totalmem() - 6 * GB) / (1.5 * GB)), cores * 2))
  return { cores, total_gb: Math.round(os.totalmem() / GB), capacity }
}

async function oauthToken(): Promise<string | undefined> {
  // macOS keeps Claude Code's OAuth credentials in the keychain; linux in a plaintext file
  const parse = (raw: string) => JSON.parse(raw)?.claudeAiOauth?.accessToken
  if (process.platform === 'darwin') {
    const raw = await new Promise<string>((resolve) => execFile('security',
      ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
      (err, out) => resolve(err ? '' : out)))
    if (raw.trim()) { try { return parse(raw) } catch { /* fall through */ } }
  }
  try { return parse(fs.readFileSync(path.join(os.homedir(), '.claude', '.credentials.json'), 'utf8')) } catch { return undefined }
}

type UsageWindow = { utilization: number; resets_at: string | null }
export type ClaudeUsage = { five_hour: UsageWindow; seven_day: UsageWindow } | null
let cache: { at: number; usage: ClaudeUsage } | undefined

// same endpoint Claude Code's /usage command reads — real limits, not estimates
export async function claudeUsage(): Promise<ClaudeUsage> {
  if (cache && Date.now() - cache.at < 60_000) return cache.usage
  let usage: ClaudeUsage = null
  try {
    const token = await oauthToken()
    if (token) {
      const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
        headers: { authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
        signal: AbortSignal.timeout(5000),
      })
      if (res.ok) {
        const d: any = await res.json()
        usage = {
          five_hour: { utilization: d.five_hour?.utilization ?? 0, resets_at: d.five_hour?.resets_at ?? null },
          seven_day: { utilization: d.seven_day?.utilization ?? 0, resets_at: d.seven_day?.resets_at ?? null },
        }
      }
    }
  } catch { /* no credentials or offline — the dashboard hides the meter */ }
  cache = { at: Date.now(), usage }
  return usage
}
