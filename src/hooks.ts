import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { api } from './client.js'
import { dataDir, ensureDaemon } from './daemon.js'
import { consumeHandoff, readMemoryInjection } from './memory.js'
import { hookRules, verbose } from './rules.js'
import {
  MANAGED_AGENT_BOOTSTRAP_ENV,
  MANAGED_AGENT_HOME_SESSION_ENV,
  managedAgentSessionCredentialPath,
  persistManagedAgentSessionCredential,
} from './agent-session-credential.js'

// throwaway sessions in temp dirs shouldn't create phantom boards
export function isThrowawayCwd(cwd: string): boolean {
  const real = (p: string) => { try { return fs.realpathSync(p) } catch { return p } }
  const c = real(cwd)
  return c.startsWith(real(os.tmpdir())) || c.startsWith('/private/var/folders/') || c.startsWith('/var/folders/')
}

export const _internals = {
  readStdin(): Promise<string> {
    return new Promise((resolve) => {
      let data = ''
      const t = setTimeout(() => resolve(data), 500)
      process.stdin.on('data', (c) => (data += c))
      process.stdin.on('end', () => { clearTimeout(t); resolve(data) })
    })
  },
  sessionFile(provider: HookProvider, id: string): string {
    return sessFile(provider, id)
  },
}

export type HookProvider = 'claude' | 'codex'

export function detectHookProvider(input: any, requested?: string): HookProvider {
  const value = requested ?? input?.provider ?? input?.orchestra_provider
  return value === 'codex' ? 'codex' : 'claude'
}

type Session = {
  agent_id: number
  agent_name: string
  board_id: number
  provider: HookProvider
  session_id: string
  session_token: string
  cwd?: string
  transcript_path?: string
}
// Keep the historical Claude path intact while isolating every other provider
// under its own directory. This avoids state collisions without invalidating
// active Claude sessions during upgrade.
const sessFile = (provider: HookProvider, id: string) =>
  managedAgentSessionCredentialPath(provider, id)
const loadSession = (provider: HookProvider, id: string): Session | undefined => {
  try {
    const session = JSON.parse(fs.readFileSync(sessFile(provider, id), 'utf8'))
    if (session.provider !== provider || session.session_id !== id || typeof session.session_token !== 'string')
      return undefined
    return session
  } catch { return undefined }
}

const saveSession = (provider: HookProvider, session: Session): void => {
  persistManagedAgentSessionCredential(session)
}

const sessionIdentity = (session: Session) => ({
  provider: session.provider,
  session_id: session.session_id,
  session_token: session.session_token,
})

async function registerSession(input: any, provider: HookProvider): Promise<Session | undefined> {
  if (!input.session_id) return undefined
  if (isThrowawayCwd(input.cwd ?? process.cwd())) return undefined
  if (!(await ensureDaemon())) return undefined
  const managed = process.env.ORCHESTRA_MANAGED_AGENT === '1'
  const managedBoardId = managed
    ? positiveEnvironmentInteger(process.env.ORCHESTRA_BOARD_ID) : null
  const board = managedBoardId
    ? { id: managedBoardId }
    : await api('POST', '/boards/resolve', { project_path: input.cwd ?? process.cwd() })
  const managedAgentId = managed
    ? positiveEnvironmentInteger(process.env.ORCHESTRA_AGENT_ID) : null
  const bootstrapNonce = managed
    ? process.env[MANAGED_AGENT_BOOTSTRAP_ENV]?.trim() || null : null
  const agentHomeSessionId = managed
    ? process.env[MANAGED_AGENT_HOME_SESSION_ENV]?.trim() || null : null
  const terminal = managed ? null : terminalIdentity()
  const agent = await api('POST', '/agents/register', {
    board_id: board.id, session_id: input.session_id, name: process.env.ORCHESTRA_NAME, provider,
    ...(managedAgentId ? { agent_id: managedAgentId } : {}),
    ...(bootstrapNonce ? { bootstrap_nonce: bootstrapNonce } : {}),
    ...(agentHomeSessionId ? { agent_home_session_id: agentHomeSessionId } : {}),
    ...(terminal ? { terminal } : {}),
  })
  if (typeof agent.session_token !== 'string') return undefined
  const sess: Session = {
    agent_id: agent.id, agent_name: agent.name, board_id: board.id, provider,
    session_id: input.session_id, session_token: agent.session_token,
    cwd: sessionCwd(input.cwd),
    transcript_path: input.transcript_path,
  }
  saveSession(provider, sess)
  return sess
}

// Where does this session's CLI sit? The hook is a child of the provider CLI,
// so the parent pid's controlling tty is the terminal to inject into. All
// best-effort: a null just means queued (hook-fire) delivery.
function terminalIdentity(): Record<string, string> | null {
  const identity: Record<string, string> = {}
  try {
    const tty = execFileSync('/bin/ps', ['-o', 'tty=', '-p', String(process.ppid)],
      { encoding: 'utf8', timeout: 1_000 }).trim()
    if (tty && tty !== '??' && /^[a-zA-Z0-9]+$/.test(tty)) identity.tty = tty
  } catch { /* ps unavailable — env hints may still work */ }
  if (process.env.TERM_PROGRAM) identity.term_program = process.env.TERM_PROGRAM
  if (process.env.ITERM_SESSION_ID) identity.iterm_session_id = process.env.ITERM_SESSION_ID
  const tmuxSocket = process.env.TMUX?.split(',')[0]
  if (tmuxSocket && process.env.TMUX_PANE) {
    identity.tmux_socket = tmuxSocket
    identity.tmux_pane = process.env.TMUX_PANE
  }
  return Object.keys(identity).length ? identity : null
}

function positiveEnvironmentInteger(value: string | undefined): number | null {
  if (!value || !/^\d+$/u.test(value)) return null
  const number = Number(value)
  return Number.isSafeInteger(number) && number > 0 ? number : null
}

function sessionCwd(value: unknown): string {
  const cwd = typeof value === 'string' && value ? value : process.cwd()
  try {
    return fs.realpathSync(cwd)
  } catch {
    return path.resolve(cwd)
  }
}

// session file may be missing (session-start cut short, cleanup, crash) — self-heal
const ensureSession = async (input: any, provider: HookProvider): Promise<Session | undefined> =>
  loadSession(provider, input.session_id) ?? registerSession(input, provider)

// injected-token telemetry: spool emissions locally and flush them on the next daemon
// call the hook already makes (pulse/heartbeat/leave) — never an extra blocking request
const telFile = (provider: HookProvider, id: string) => sessFile(provider, id) + '.tel'
function spool(provider: HookProvider, sessionId: string, event: string, text: string): void {
  try {
    fs.mkdirSync(path.dirname(telFile(provider, sessionId)), { recursive: true })
    fs.appendFileSync(telFile(provider, sessionId), JSON.stringify({ provider, event, chars: text.length }) + '\n')
  } catch { /* best effort */ }
}
function takeSpool(provider: HookProvider, sessionId: string): { provider: HookProvider; event: string; chars: number }[] | undefined {
  try {
    const raw = fs.readFileSync(telFile(provider, sessionId), 'utf8')
    fs.rmSync(telFile(provider, sessionId), { force: true })
    const entries = raw.split('\n').filter(Boolean).map((line) => ({ provider, ...JSON.parse(line) }))
    return entries.length ? entries : undefined
  } catch { return undefined }
}

// a card matters to this session if any of its claimed paths could collide with files under cwd
const touchesCwd = (paths: string[], root: string, cwd: string): boolean => {
  if (cwd === root) return paths.length > 0
  return paths.some((p) => {
    const abs = path.resolve(root, p)
    return abs === cwd || abs.startsWith(cwd + path.sep) || cwd.startsWith(abs + path.sep)
  })
}

const cardLine = (c: any, full: boolean) => {
  if (full) return `- card #${c.id} [${c.column}] "${c.title}" (${c.owner ?? 'unowned'}) paths: ${c.paths.join(', ') || '-'}`
  const paths = c.paths.slice(0, 2).join(', ') + (c.paths.length > 2 ? ` +${c.paths.length - 2}` : '')
  return `#${c.id} ${c.column} "${c.title}" @${c.owner ?? '-'} ${paths || '-'}`
}
const questionLine = (q: any, full: boolean) => full
  ? `- open question #${q.id} from ${q.from_name ?? 'human'} to ${q.to_name ?? 'all'}: ${q.body}`
  : `- Q#${q.id} ${q.from_name ?? 'human'}→${q.to_name ?? 'all'}: ${q.body.length > 120 ? q.body.slice(0, 120) + '…' : q.body}`

// pure renderer, exported for tests and A/B token measurement (card #38)
export function renderSessionStart(agent: { id: number; name: string }, board: any, snap: any, cwd: string): string {
  const me = agent.name
  const full = verbose()
  const others = snap.agents.filter((x: any) => x.id !== agent.id && x.status !== 'gone')
  const lines = [hookRules(me), '', full
    ? `You are agent "${me}" (id ${agent.id}) on board "${board.name}".`
    : `Board ${board.name} · ${me}#${agent.id}`]
  if (full) {
    for (const a of others) lines.push(`- agent ${a.name}: ${a.status}`)
    for (const c of snap.cards.filter((c: any) => c.column !== 'done')) lines.push(cardLine(c, full))
    for (const q of snap.open_questions) lines.push(questionLine(q, full))
  } else {
    lines.push(`Peers:${others.length} · full: orchestra snapshot --full`)
    const root = board.project_path ?? cwd
    for (const c of snap.cards.filter((c: any) =>
      c.column !== 'done' && (!c.owner || c.owner === me || touchesCwd(c.paths, root, cwd))))
      lines.push(cardLine(c, full))
    for (const q of snap.open_questions.filter((q: any) => !q.to_name || q.to_name === me))
      lines.push(questionLine(q, full))
  }
  return lines.join('\n')
}

// the one-shot handoff plus what was remembered on this board; empty when nothing was ever saved
export function renderMemorySection(boardId: number, root = path.join(dataDir(), 'memory')): string {
  const handoff = consumeHandoff(root, boardId)
  const memory = readMemoryInjection(root, boardId)
  const parts: string[] = []
  if (handoff) parts.push(`=== HANDOFF ===\n${handoff.trim()}`)
  if (memory) parts.push(memory)
  return parts.join('\n\n')
}

async function sessionStart(input: any, provider: HookProvider): Promise<void> {
  if (isThrowawayCwd(input.cwd ?? process.cwd())) return
  const session = await registerSession(input, provider)
  if (!session) return
  const snap = await api('GET', `/boards/${session.board_id}/snapshot`)
  const text = renderSessionStart(
    { id: session.agent_id, name: session.agent_name },
    snap.board,
    snap,
    input.cwd ?? process.cwd(),
  )
  const memory = renderMemorySection(session.board_id)
  const context = memory ? `${text}\n\n${memory}` : text
  spool(provider, input.session_id, 'session_start', context)
  if (provider === 'codex') {
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } }))
  } else {
    console.log(context)
  }
}

const cardAgeMs = (c: any) => Date.now() - new Date(c.updated_at.replace(' ', 'T') + 'Z').getTime()

// events that only ever fire in the main conversation may adopt a missing transcript_path
// (heals session files written before the field existed)
function stampTranscript(sess: Session, input: any, provider: HookProvider): void {
  if (!sess.transcript_path && input.transcript_path) {
    sess.transcript_path = input.transcript_path
    try { saveSession(provider, sess) } catch { /* best effort */ }
  }
}

async function deliver(input: any, hookEventName: string, throttleMs: number, provider: HookProvider): Promise<void> {
  const sess = await ensureSession(input, provider)
  if (!sess) return
  if (hookEventName === 'UserPromptSubmit') stampTranscript(sess, input, provider)
  // hooks also fire inside subagents (Task tool) — report presence and heartbeat, but never
  // consume the parent's board messages: injected context would vanish into the subagent's transcript
  if (sess.transcript_path && input.transcript_path && sess.transcript_path !== input.transcript_path) {
    const key = String(input.transcript_path).split('/').pop()?.slice(0, 24) ?? 'sub'
    await api('POST', `/agents/${sess.agent_id}/subping`, {
      key, state: 'started', ...sessionIdentity(sess),
    }).catch(() => {})
    return
  }
  const throttle = sessFile(provider, input.session_id) + '.throttle'
  if (throttleMs > 0) {
    try {
      if (Date.now() - fs.statSync(throttle).mtimeMs < throttleMs) return
    } catch { /* first run */ }
  }
  fs.mkdirSync(path.dirname(throttle), { recursive: true })
  fs.writeFileSync(throttle, '')
  const r = await api('POST', `/agents/${sess.agent_id}/pulse`, {
    ...sessionIdentity(sess), telemetry: takeSpool(provider, input.session_id),
    ...(sess.transcript_path ? { transcript_path: sess.transcript_path } : {}),
  })
  const lines = r.messages.map((m: any) => {
    const from = m.from_name ?? 'human'
    if (m.reply_to || m.kind === 'reply')
      return `orchestra reply from ${from}: "${m.body}" (answers your msg #${m.reply_to}) — no response required unless a follow-up is materially needed.`
    if (m.kind === 'notify')
      return `orchestra notification #${m.id} from ${from}: "${m.body}" — no reply required.`
    if (m.kind === 'task')
      return `orchestra task from ${from}: "${m.body}" — act on it; do not send an acknowledgment-only reply.`
    if (m.kind === 'swarm')
      return `explicit orchestra swarm request from ${from}: "${m.body}" — reply only with a substantive result using: orchestra reply ${m.id} '<answer>'; never send an acknowledgment-only reply.`
    return `direct orchestra ask from ${from}: "${m.body}" — reply required with: orchestra reply ${m.id} '<answer>'; no acknowledgment-only reply.`
  })
  // one-time nudge if the agent is working without a card; recurring nudge if its card is stale
  const nudged = sessFile(provider, input.session_id) + '.nudged'
  const stale = sessFile(provider, input.session_id) + '.stale'
  const firstCheck = !fs.existsSync(nudged)
  let staleCheck = false
  try { staleCheck = Date.now() - fs.statSync(stale).mtimeMs > 600_000 } catch { staleCheck = true }
  if (firstCheck || staleCheck) {
    const snap = await api('GET', `/boards/${sess.board_id}/snapshot`)
    const mine = snap.cards.filter((c: any) => c.owner === sess.agent_name && c.column !== 'done')
    fs.writeFileSync(nudged, ''); fs.writeFileSync(stale, '')
    // full command syntax only in the session's first reminder; later nudges stay terse
    if (mine.length === 0 && firstCheck) {
      lines.push(`Reminder: no orchestra card yet — register now: orchestra card create '<title>' --desc '<scope>' --paths <paths> --column in_progress --agent ${sess.agent_name}`)
    } else if (mine.length > 0 && staleCheck && !firstCheck) {
      const old = mine.filter((c: any) => cardAgeMs(c) > 600_000)
      if (old.length > 0) {
        lines.push(`Card ${old.map((c: any) => `#${c.id}`).join(', ')} not updated in 10+ minutes — update or move it.`)
      }
    }
  }
  if (lines.length === 0) return
  const additionalContext = lines.join('\n')
  spool(provider, input.session_id,
    hookEventName === 'UserPromptSubmit' ? 'user_prompt_submit' : 'post_tool_use', additionalContext)
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext } }))
}

// pulse is a ~1ms localhost call — keep the throttle just tight enough to survive tool bursts
const postToolUse = (input: any, provider: HookProvider) => deliver(input, 'PostToolUse', 5_000, provider)
const userPromptSubmit = (input: any, provider: HookProvider) => deliver(input, 'UserPromptSubmit', 0, provider)

async function stop(input: any, provider: HookProvider): Promise<void> {
  const sess = await ensureSession(input, provider)
  if (!sess) return
  stampTranscript(sess, input, provider)
  // heartbeat only — pulse would consume undelivered messages with no way to show them.
  // idle:true — the turn just ended, don't let the working ring linger.
  await api('POST', `/agents/${sess.agent_id}/heartbeat`, {
    ...sessionIdentity(sess), telemetry: takeSpool(provider, input.session_id), idle: true,
    ...(sess.transcript_path ? { transcript_path: sess.transcript_path } : {}),
  })
  if (input.stop_hook_active) return // already continued once for this — never loop
  const snap = await api('GET', `/boards/${sess.board_id}/snapshot`)
  // a card touched in the last 10 minutes is proof of board discipline — don't burn a turn on it
  const mine = snap.cards.filter((c: any) =>
    c.owner === sess.agent_name && c.column === 'in_progress' && cardAgeMs(c) > 600_000)
  if (mine.length === 0) return
  const ids = mine.map((c: any) => `#${c.id} "${c.title}"`).join(', ')
  const reason = `Card ${ids} still in_progress — report Delivered / Evidence / Remaining, then move it to review (or blocked). Never self-mark done; done requires human acceptance.`
  spool(provider, input.session_id, 'stop', reason)
  if (provider === 'codex') {
    console.log(JSON.stringify({
      continue: false,
      stopReason: reason,
      hookSpecificOutput: { hookEventName: 'Stop', additionalContext: reason },
    }))
  } else {
    console.log(JSON.stringify({ decision: 'block', reason }))
  }
}

async function sessionEnd(input: any, provider: HookProvider): Promise<void> {
  const sess = loadSession(provider, input.session_id)
  if (!sess) return
  await api('POST', `/agents/${sess.agent_id}/leave`, {
    ...sessionIdentity(sess), telemetry: takeSpool(provider, input.session_id),
  })
  for (const suffix of ['', '.throttle', '.nudged', '.stale', '.tel'])
    fs.rmSync(sessFile(provider, input.session_id) + suffix, { force: true })
}

async function providerHeartbeat(input: any, provider: HookProvider): Promise<Session | undefined> {
  const sess = await ensureSession(input, provider)
  if (!sess) return undefined
  await api('POST', `/agents/${sess.agent_id}/heartbeat`, {
    ...sessionIdentity(sess), telemetry: takeSpool(provider, input.session_id),
    ...(sess.transcript_path ? { transcript_path: sess.transcript_path } : {}),
  })
  return sess
}

async function subagentPresence(input: any, provider: HookProvider, state: 'started' | 'stopped'): Promise<void> {
  const sess = await providerHeartbeat(input, provider)
  if (!sess) return
  const key = String(
    input.agent_id ?? input.subagent_id ?? input.agent_type ?? input.subagent_type ??
    input.transcript_path ?? `${provider}-subagent`,
  ).split('/').pop()?.slice(0, 64) ?? `${provider}-subagent`
  await api('POST', `/agents/${sess.agent_id}/subping`, {
    key, state, ...sessionIdentity(sess),
  }).catch(() => {})
}

export async function runHook(event: string, requestedProvider?: string): Promise<void> {
  // session-start runs once and may need to cold-start the daemon; per-tool hooks stay tight
  const deadline = new Promise<void>((r) => setTimeout(r, event === 'session-start' ? 10_000 : 2000))
  const work = (async () => {
    const input = JSON.parse((await _internals.readStdin()) || '{}')
    const provider = detectHookProvider(input, requestedProvider)
    if (event === 'session-start') await sessionStart(input, provider)
    else if (event === 'post-tool-use') await postToolUse(input, provider)
    else if (event === 'user-prompt-submit') await userPromptSubmit(input, provider)
    else if (event === 'stop') await stop(input, provider)
    else if (event === 'session-end') await sessionEnd(input, provider)
    else if (event === 'permission-request') await providerHeartbeat(input, provider)
    else if (event === 'subagent-start') await subagentPresence(input, provider, 'started')
    else if (event === 'subagent-stop') await subagentPresence(input, provider, 'stopped')
  })()
  try { await Promise.race([work, deadline]) } catch { /* never break a session */ }
}
