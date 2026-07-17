import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { baseUrl } from './daemon.js'

export function projectPath(cwd: string = process.cwd()): string {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim()
  } catch { return fs.realpathSync(cwd) }
}

export async function api(method: string, p: string, body?: unknown): Promise<any> {
  const res = await fetch(`${baseUrl()}/api/v1${p}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status}: ${await res.text()}`)
  return res.json()
}
