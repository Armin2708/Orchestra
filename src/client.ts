import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { baseUrl } from './daemon.js'
import { loadToken } from './token.js'

export function projectPath(cwd: string = process.cwd()): string {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim()
  } catch { return fs.realpathSync(cwd) }
}

export async function api(method: string, p: string, body?: unknown): Promise<any> {
  const headers: Record<string, string> = {}
  // read fresh each call — the daemon may have minted the token after this process started
  const token = loadToken()
  if (token) headers.authorization = `Bearer ${token}`
  // fastify rejects bodyless requests that carry a json content-type
  if (body !== undefined) headers['content-type'] = 'application/json'
  const res = await fetch(`${baseUrl()}/api/v1${p}`, {
    method,
    headers: Object.keys(headers).length ? headers : undefined,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status}: ${await res.text()}`)
  return res.json()
}
