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

const RULES = `orchestra rules (coordination board for this project):
- Before starting work: orchestra card create "<title>" --desc "<scope>" --paths <comma,separated,paths> --column in_progress
- Keep your card updated (orchestra card update/move) as scope or status changes.
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

async function postToolUse(input: any): Promise<void> {
  const sess = loadSession(input.session_id)
  if (!sess) return
  const throttle = sessFile(input.session_id) + '.throttle'
  try {
    if (Date.now() - fs.statSync(throttle).mtimeMs < 30_000) return
  } catch { /* first run */ }
  fs.mkdirSync(path.dirname(throttle), { recursive: true })
  fs.writeFileSync(throttle, '')
  const r = await api('POST', `/agents/${sess.agent_id}/pulse`)
  if (r.messages.length === 0) return
  const ctx = r.messages.map((m: any) =>
    `📨 orchestra message from ${m.from_name ?? 'human'}: ${m.body}` +
    (m.reply_to ? ` (reply to your msg #${m.reply_to})` : ` — reply with: orchestra reply ${m.id} "..."`)).join('\n')
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: ctx } }))
}

async function stop(input: any): Promise<void> {
  const sess = loadSession(input.session_id)
  if (sess) await api('POST', `/agents/${sess.agent_id}/pulse`)
}

async function sessionEnd(input: any): Promise<void> {
  const sess = loadSession(input.session_id)
  if (!sess) return
  await api('POST', `/agents/${sess.agent_id}/leave`)
  fs.rmSync(sessFile(input.session_id), { force: true })
}

export async function runHook(event: string): Promise<void> {
  const deadline = new Promise<void>((r) => setTimeout(r, 2000))
  const work = (async () => {
    const input = JSON.parse((await _internals.readStdin()) || '{}')
    if (event === 'session-start') await sessionStart(input)
    else if (event === 'post-tool-use') await postToolUse(input)
    else if (event === 'stop') await stop(input)
    else if (event === 'session-end') await sessionEnd(input)
  })()
  try { await Promise.race([work, deadline]) } catch { /* never break a session */ }
}
