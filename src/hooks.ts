import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { api } from './client.js'
import { dataDir, ensureDaemon } from './daemon.js'

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
}

type Session = { agent_id: number; agent_name: string; board_id: number; transcript_path?: string }
const sessFile = (id: string) => path.join(dataDir(), 'sessions', `${id}.json`)
const loadSession = (id: string): Session | undefined => {
  try { return JSON.parse(fs.readFileSync(sessFile(id), 'utf8')) } catch { return undefined }
}

async function registerSession(input: any): Promise<Session | undefined> {
  if (!input.session_id) return undefined
  if (isThrowawayCwd(input.cwd ?? process.cwd())) return undefined
  if (!(await ensureDaemon())) return undefined
  const board = await api('POST', '/boards/resolve', { project_path: input.cwd ?? process.cwd() })
  const agent = await api('POST', '/agents/register', {
    board_id: board.id, session_id: input.session_id, name: process.env.ORCHESTRA_NAME,
  })
  const sess: Session = { agent_id: agent.id, agent_name: agent.name, board_id: board.id, transcript_path: input.transcript_path }
  fs.mkdirSync(path.join(dataDir(), 'sessions'), { recursive: true })
  fs.writeFileSync(sessFile(input.session_id), JSON.stringify(sess))
  return sess
}

// session file may be missing (session-start cut short, cleanup, crash) — self-heal
const ensureSession = async (input: any): Promise<Session | undefined> =>
  loadSession(input.session_id) ?? registerSession(input)

const rules = (me: string) => `orchestra rules (coordination board for this project — these are standing instructions):
- You are agent "${me}". ALWAYS pass --agent ${me} on card commands and --from ${me} when asking/replying.
- REQUIRED before starting any task: read the board below and evaluate every active card's title and description against your task. If another agent's card looks similar, related, or could conflict with what you're about to do, you MUST ask its owner what they're covering BEFORE you start: orchestra ask <agent-name> "<question>" --from ${me}. Wait for the answer, then scope your work to not duplicate theirs.
- REQUIRED: as soon as you receive a task, and BEFORE your first file edit, register it:
  orchestra card create "<short title>" --desc "<scope>" --paths <comma,separated,paths> --column in_progress --agent ${me}
  If the response shows "⚠ overlap" or "≈ similar work", ask that agent before proceeding.
- Keep your card updated as work progresses: orchestra card update <id> --desc "<what you're doing now>" --agent ${me}; move it (orchestra card move <id> done|review|blocked --agent ${me}) when status changes. Move to done when finished.
- Do NOT touch paths claimed by another active card without asking first. Replies arrive automatically.
- SUBAGENTS: spawn them freely — they work under YOUR identity and card. Instruct each one: do NOT run orchestra commands; board coordination belongs to you, the parent.`

async function sessionStart(input: any): Promise<void> {
  if (isThrowawayCwd(input.cwd ?? process.cwd())) return
  if (!(await ensureDaemon())) return
  const board = await api('POST', '/boards/resolve', { project_path: input.cwd ?? process.cwd() })
  const agent = await api('POST', '/agents/register', {
    board_id: board.id, session_id: input.session_id, name: process.env.ORCHESTRA_NAME,
  })
  fs.mkdirSync(path.join(dataDir(), 'sessions'), { recursive: true })
  fs.writeFileSync(sessFile(input.session_id),
    JSON.stringify({ agent_id: agent.id, agent_name: agent.name, board_id: board.id, transcript_path: input.transcript_path }))
  const snap = await api('GET', `/boards/${board.id}/snapshot`)
  const lines = [rules(agent.name), '', `You are agent "${agent.name}" (id ${agent.id}) on board "${board.name}".`]
  for (const a of snap.agents.filter((x: any) => x.id !== agent.id && x.status !== 'gone'))
    lines.push(`- agent ${a.name}: ${a.status}`)
  for (const c of snap.cards.filter((c: any) => c.column !== 'done'))
    lines.push(`- card #${c.id} [${c.column}] "${c.title}" (${c.owner ?? 'unowned'}) paths: ${c.paths.join(', ') || '-'}`)
  for (const q of snap.open_questions) lines.push(`- open question #${q.id} from ${q.from_name ?? 'human'} to ${q.to_name ?? 'all'}: ${q.body}`)
  console.log(lines.join('\n'))
}

const cardAgeMs = (c: any) => Date.now() - new Date(c.updated_at.replace(' ', 'T') + 'Z').getTime()

// events that only ever fire in the main conversation may adopt a missing transcript_path
// (heals session files written before the field existed)
function stampTranscript(sess: Session, input: any): void {
  if (!sess.transcript_path && input.transcript_path) {
    sess.transcript_path = input.transcript_path
    try { fs.writeFileSync(sessFile(input.session_id), JSON.stringify(sess)) } catch { /* best effort */ }
  }
}

async function deliver(input: any, hookEventName: string, throttleMs: number): Promise<void> {
  const sess = await ensureSession(input)
  if (!sess) return
  if (hookEventName === 'UserPromptSubmit') stampTranscript(sess, input)
  // hooks also fire inside subagents (Task tool) — report presence and heartbeat, but never
  // consume the parent's board messages: injected context would vanish into the subagent's transcript
  if (sess.transcript_path && input.transcript_path && sess.transcript_path !== input.transcript_path) {
    const key = String(input.transcript_path).split('/').pop()?.slice(0, 24) ?? 'sub'
    await api('POST', `/agents/${sess.agent_id}/subping`, { key }).catch(() => {})
    return
  }
  const throttle = sessFile(input.session_id) + '.throttle'
  if (throttleMs > 0) {
    try {
      if (Date.now() - fs.statSync(throttle).mtimeMs < throttleMs) return
    } catch { /* first run */ }
  }
  fs.mkdirSync(path.dirname(throttle), { recursive: true })
  fs.writeFileSync(throttle, '')
  const r = await api('POST', `/agents/${sess.agent_id}/pulse`)
  const lines = r.messages.map((m: any) =>
    `orchestra message from ${m.from_name ?? 'human'}: "${m.body}"` +
    (m.reply_to ? ` (this answers your msg #${m.reply_to})`
      : ` — answer it now with: orchestra reply ${m.id} "<answer>", then continue your task.`))
  // one-time nudge if the agent is working without a card; recurring nudge if its card is stale
  const nudged = sessFile(input.session_id) + '.nudged'
  const stale = sessFile(input.session_id) + '.stale'
  const firstCheck = !fs.existsSync(nudged)
  let staleCheck = false
  try { staleCheck = Date.now() - fs.statSync(stale).mtimeMs > 600_000 } catch { staleCheck = true }
  if (firstCheck || staleCheck) {
    const snap = await api('GET', `/boards/${sess.board_id}/snapshot`)
    const mine = snap.cards.filter((c: any) => c.owner === sess.agent_name && c.column !== 'done')
    fs.writeFileSync(nudged, ''); fs.writeFileSync(stale, '')
    // full command syntax only in the session's first reminder; later nudges stay terse
    if (mine.length === 0 && firstCheck) {
      lines.push(`Reminder: no orchestra card yet — register now: orchestra card create "<title>" --desc "<scope>" --paths <paths> --column in_progress --agent ${sess.agent_name}`)
    } else if (mine.length > 0 && staleCheck && !firstCheck) {
      const old = mine.filter((c: any) => cardAgeMs(c) > 600_000)
      if (old.length > 0) {
        lines.push(`Card ${old.map((c: any) => `#${c.id}`).join(', ')} not updated in 10+ minutes — update or move it.`)
      }
    }
  }
  if (lines.length === 0) return
  const additionalContext = lines.join('\n')
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext } }))
}

// pulse is a ~1ms localhost call — keep the throttle just tight enough to survive tool bursts
const postToolUse = (input: any) => deliver(input, 'PostToolUse', 5_000)
const userPromptSubmit = (input: any) => deliver(input, 'UserPromptSubmit', 0)

async function stop(input: any): Promise<void> {
  const sess = await ensureSession(input)
  if (!sess) return
  stampTranscript(sess, input)
  // heartbeat only — pulse would consume undelivered messages with no way to show them
  await api('POST', `/agents/${sess.agent_id}/heartbeat`)
  if (input.stop_hook_active) return // already continued once for this — never loop
  const snap = await api('GET', `/boards/${sess.board_id}/snapshot`)
  // a card touched in the last 10 minutes is proof of board discipline — don't burn a turn on it
  const mine = snap.cards.filter((c: any) =>
    c.owner === sess.agent_name && c.column === 'in_progress' && cardAgeMs(c) > 600_000)
  if (mine.length === 0) return
  const ids = mine.map((c: any) => `#${c.id} "${c.title}"`).join(', ')
  const reason = `Card ${ids} still in_progress — move it (orchestra card move <id> done|review|blocked) or update it, then finish.`
  console.log(JSON.stringify({ decision: 'block', reason }))
}

async function sessionEnd(input: any): Promise<void> {
  const sess = loadSession(input.session_id)
  if (!sess) return
  await api('POST', `/agents/${sess.agent_id}/leave`)
  for (const suffix of ['', '.throttle', '.nudged', '.stale'])
    fs.rmSync(sessFile(input.session_id) + suffix, { force: true })
}

export async function runHook(event: string): Promise<void> {
  // session-start runs once and may need to cold-start the daemon; per-tool hooks stay tight
  const deadline = new Promise<void>((r) => setTimeout(r, event === 'session-start' ? 10_000 : 2000))
  const work = (async () => {
    const input = JSON.parse((await _internals.readStdin()) || '{}')
    if (event === 'session-start') await sessionStart(input)
    else if (event === 'post-tool-use') await postToolUse(input)
    else if (event === 'user-prompt-submit') await userPromptSubmit(input)
    else if (event === 'stop') await stop(input)
    else if (event === 'session-end') await sessionEnd(input)
  })()
  try { await Promise.race([work, deadline]) } catch { /* never break a session */ }
}
