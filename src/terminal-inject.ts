import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// mirror of daemon.ts dataDir() — imported inline to keep this module cycle-free
const dataDir = () => process.env.ORCHESTRA_HOME ?? path.join(os.homedir(), '.orchestra')

// The terminal seat of an externally-launched agent CLI, captured by its
// SessionStart hook. Everything here is best-effort presence data: any field
// may be missing, and endpoints go stale when the terminal closes.
export interface TerminalEndpoint {
  tty?: string
  term_program?: string
  iterm_session_id?: string
  tmux_socket?: string
  tmux_pane?: string
}

const MAX_FIELD = 256
const STORE_FILE = () => path.join(dataDir(), 'terminal-endpoints.json')

const endpoints = new Map<number, TerminalEndpoint>()
let loaded = false

const cleanField = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > MAX_FIELD || /[\x00-\x1f\x7f]/.test(trimmed)) return undefined
  return trimmed
}

export function sanitizeTerminalEndpoint(raw: unknown): TerminalEndpoint | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  const endpoint: TerminalEndpoint = {}
  const tty = cleanField(value.tty)
  // ttys never contain path separators — reject anything that could steer ps/osascript
  if (tty && /^[a-zA-Z0-9]+$/.test(tty.replace(/^\/dev\//, ''))) endpoint.tty = tty.replace(/^\/dev\//, '')
  const program = cleanField(value.term_program)
  if (program) endpoint.term_program = program
  const iterm = cleanField(value.iterm_session_id)
  if (iterm) endpoint.iterm_session_id = iterm
  const tmuxSocket = cleanField(value.tmux_socket)
  const tmuxPane = cleanField(value.tmux_pane)
  // a pane without its socket (or vice versa) can never be injected into
  if (tmuxSocket && path.isAbsolute(tmuxSocket) && tmuxPane && /^%\d+$/.test(tmuxPane)) {
    endpoint.tmux_socket = tmuxSocket
    endpoint.tmux_pane = tmuxPane
  }
  return Object.keys(endpoint).length ? endpoint : null
}

function load(): void {
  if (loaded) return
  loaded = true
  try {
    const raw = JSON.parse(fs.readFileSync(STORE_FILE(), 'utf8')) as Record<string, unknown>
    for (const [id, value] of Object.entries(raw)) {
      const endpoint = sanitizeTerminalEndpoint(value)
      if (Number.isSafeInteger(Number(id)) && endpoint) endpoints.set(Number(id), endpoint)
    }
  } catch { /* first run or unreadable — start empty */ }
}

function persist(): void {
  try {
    fs.writeFileSync(STORE_FILE(), JSON.stringify(Object.fromEntries(endpoints)), { mode: 0o600 })
  } catch { /* presence cache only — losing it degrades to queued delivery */ }
}

export function recordTerminalEndpoint(agentId: number, raw: unknown): void {
  load()
  const endpoint = sanitizeTerminalEndpoint(raw)
  if (!endpoint) return
  endpoints.set(agentId, endpoint)
  persist()
}

export function terminalEndpoint(agentId: number): TerminalEndpoint | undefined {
  load()
  return endpoints.get(agentId)
}

// Same phrasing the hook pulse uses, so agents obey identical reply rules
// whichever channel delivered the message.
export function formatInjectedMessage(
  kind: string,
  id: number,
  fromName: string | null,
  body: string,
  replyTo: number | null,
): string {
  const from = fromName ?? 'human'
  if (replyTo || kind === 'reply')
    return `orchestra reply from ${from}: "${body}" (answers your msg #${replyTo}) — no response required unless a follow-up is materially needed.`
  if (kind === 'task')
    return `orchestra task from ${from}: "${body}" — act on it; do not send an acknowledgment-only reply.`
  return `direct orchestra ask from ${from}: "${body}" — reply required with: orchestra reply ${id} '<answer>'; no acknowledgment-only reply.`
}

// One line, bounded: the injected text becomes a typed prompt in someone's terminal.
export function sanitizeInjectionText(text: string): string {
  return text.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 2_000)
}

const run = (file: string, args: string[]): Promise<string> => new Promise((resolve, reject) => {
  execFile(file, args, { timeout: 5_000, maxBuffer: 65_536 }, (error, stdout) => {
    if (error) reject(error)
    else resolve(String(stdout).trim())
  })
})

// Types text into the session's terminal and submits it — argv only, no shell.
const ITERM_SCRIPT = `on run argv
  set targetTty to item 1 of argv
  set msg to item 2 of argv
  tell application "iTerm2"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if tty of s ends with targetTty then
            tell s to write text msg
            return "ok"
          end if
        end repeat
      end repeat
    end repeat
  end tell
  return "not-found"
end run`

const TERMINAL_APP_SCRIPT = `on run argv
  set targetTty to item 1 of argv
  set msg to item 2 of argv
  tell application "Terminal"
    repeat with w in windows
      repeat with t in tabs of w
        if tty of t ends with targetTty then
          do script msg in t
          return "ok"
        end if
      end repeat
    end repeat
  end tell
  return "not-found"
end run`

/**
 * Best-effort instant delivery: type the message into the agent's terminal.
 * Returns true only when a backend confirmed the write; callers fall back to
 * queued hook delivery otherwise.
 */
export async function injectTerminalMessage(agentId: number, text: string): Promise<boolean> {
  if (process.env.ORCHESTRA_NO_TERMINAL_INJECT === '1') return false
  const endpoint = terminalEndpoint(agentId)
  if (!endpoint) return false
  const message = sanitizeInjectionText(text)
  if (!message) return false
  if (endpoint.tmux_socket && endpoint.tmux_pane) {
    try {
      await run('tmux', ['-S', endpoint.tmux_socket, 'send-keys', '-t', endpoint.tmux_pane, '-l', message])
      await run('tmux', ['-S', endpoint.tmux_socket, 'send-keys', '-t', endpoint.tmux_pane, 'Enter'])
      return true
    } catch { /* pane gone — try the tty backends */ }
  }
  if (!endpoint.tty) return false
  const scripts = endpoint.term_program === 'Apple_Terminal'
    ? [TERMINAL_APP_SCRIPT, ITERM_SCRIPT]
    : [ITERM_SCRIPT, TERMINAL_APP_SCRIPT]
  for (const script of scripts) {
    try {
      if (await run('osascript', ['-e', script, endpoint.tty, message]) === 'ok') return true
    } catch { /* app absent or automation denied — try the next backend */ }
  }
  return false
}
