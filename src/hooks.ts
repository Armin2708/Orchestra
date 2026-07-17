import fs from 'node:fs'
import path from 'node:path'
import { api } from './client.js'
import { dataDir, ensureDaemon } from './daemon.js'

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

type Session = { agent_id: number; agent_name: string; board_id: number }
const sessFile = (id: string) => path.join(dataDir(), 'sessions', `${id}.json`)
const loadSession = (id: string): Session | undefined => {
  try { return JSON.parse(fs.readFileSync(sessFile(id), 'utf8')) } catch { return undefined }
}

const RULES = `orchestra rules (coordination board for this project — these are standing instructions):
- REQUIRED: as soon as you receive a task, and BEFORE your first file edit, register it:
  orchestra card create "<short title>" --desc "<scope>" --paths <comma,separated,paths> --column in_progress
- Keep your card updated (orchestra card update/move) as scope or status changes; move it to done when finished.
- Check the board below; do NOT touch paths claimed by another active card without asking first.
- To ask a neighbor: orchestra ask <agent-name> "<question>". Replies arrive automatically.
- Your identity is in $ORCHESTRA_AGENT / $ORCHESTRA_AGENT_ID (also echoed here).`

async function sessionStart(input: any): Promise<void> {
  if (!(await ensureDaemon())) return
  const board = await api('POST', '/boards/resolve', { project_path: input.cwd ?? process.cwd() })
  const agent = await api('POST', '/agents/register', {
    board_id: board.id, session_id: input.session_id, name: process.env.ORCHESTRA_NAME,
  })
  fs.mkdirSync(path.join(dataDir(), 'sessions'), { recursive: true })
  fs.writeFileSync(sessFile(input.session_id),
    JSON.stringify({ agent_id: agent.id, agent_name: agent.name, board_id: board.id }))
  const snap = await api('GET', `/boards/${board.id}/snapshot`)
  const lines = [RULES, '', `You are agent "${agent.name}" (id ${agent.id}) on board "${board.name}".`]
  for (const a of snap.agents.filter((x: any) => x.id !== agent.id && x.status !== 'gone'))
    lines.push(`- agent ${a.name}: ${a.status}`)
  for (const c of snap.cards.filter((c: any) => c.column !== 'done'))
    lines.push(`- card #${c.id} [${c.column}] "${c.title}" (${c.owner ?? 'unowned'}) paths: ${c.paths.join(', ') || '-'}`)
  for (const q of snap.open_questions) lines.push(`- open question #${q.id} from ${q.from_name ?? 'human'} to ${q.to_name ?? 'all'}: ${q.body}`)
  console.log(lines.join('\n'))
}

async function deliver(input: any, hookEventName: string, throttleMs: number): Promise<void> {
  const sess = loadSession(input.session_id)
  if (!sess) return
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
  // one-time nudge if the agent is working without a card on the board
  const nudged = sessFile(input.session_id) + '.nudged'
  if (!fs.existsSync(nudged)) {
    const snap = await api('GET', `/boards/${sess.board_id}/snapshot`)
    const mine = snap.cards.filter((c: any) => c.owner === sess.agent_name && c.column !== 'done')
    fs.writeFileSync(nudged, '')
    if (mine.length === 0) {
      lines.push('Reminder: you have no card on the orchestra board. Register what you are working on now: orchestra card create "<short title>" --desc "<scope>" --paths <paths> --column in_progress')
    }
  }
  if (lines.length === 0) return
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: lines.join('\n') } }))
}

const postToolUse = (input: any) => deliver(input, 'PostToolUse', 30_000)
const userPromptSubmit = (input: any) => deliver(input, 'UserPromptSubmit', 0)

async function stop(input: any): Promise<void> {
  const sess = loadSession(input.session_id)
  // heartbeat only — pulse would consume undelivered messages with no way to show them
  if (sess) await api('POST', `/agents/${sess.agent_id}/heartbeat`)
}

async function sessionEnd(input: any): Promise<void> {
  const sess = loadSession(input.session_id)
  if (!sess) return
  await api('POST', `/agents/${sess.agent_id}/leave`)
  for (const suffix of ['', '.throttle', '.nudged'])
    fs.rmSync(sessFile(input.session_id) + suffix, { force: true })
}

export async function runHook(event: string): Promise<void> {
  const deadline = new Promise<void>((r) => setTimeout(r, 2000))
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
