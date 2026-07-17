import type Database from 'better-sqlite3'
import { EventEmitter } from 'node:events'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { generateName } from './names.js'
import { removeAgentCards } from './reaper.js'
import { port } from './daemon.js'

type TranscriptLine = { at: string; kind: 'text' | 'status' | 'error' | 'user'; text: string }

type Hired = {
  agentId: number
  boardId: number
  name: string
  cwd: string
  push: (text: string) => void
  end: () => void
  interrupt: () => Promise<void>
  transcript: TranscriptLine[]
}

const rules = (me: string) => `You are agent "${me}", a hired Orchestra agent working autonomously in this project.
Orchestra board rules (standing instructions):
- REQUIRED before starting any task: run orchestra snapshot and evaluate every active card's title and description against your task. If another agent's card looks similar, related, or could conflict, you MUST ask its owner what they're covering BEFORE you start (orchestra ask <agent> "..." --from ${me}), wait for the answer, and scope your work to not duplicate theirs.
- REQUIRED: when you receive a task, BEFORE your first file edit, register it:
  orchestra card create "<short title>" --desc "<scope>" --paths <comma,separated,paths> --column in_progress --agent ${me}
  If the response shows "⚠ overlap" or "≈ similar work", ask that agent before proceeding.
- Keep the card updated as you progress (orchestra card update/move --agent ${me}); move it to done when finished.
- Do NOT touch paths claimed by another active card without asking first.
- Messages from the board arrive directly in this conversation; answer questions promptly with: orchestra reply <msg-id> "<answer>" --from ${me}, then continue your task.
- If the orchestra command is missing, use: npx -y orchestra-board`

// pushable async-generator bridge into the SDK's streaming input
function createInput() {
  const queue: unknown[] = []
  let notify: (() => void) | null = null
  let done = false
  const wrap = (text: string) => ({
    type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: '',
  })
  return {
    push(text: string) { queue.push(wrap(text)); notify?.() },
    end() { done = true; notify?.() },
    async *stream(): AsyncGenerator<any> {
      while (true) {
        while (queue.length) yield queue.shift()
        if (done) return
        await new Promise<void>((r) => { notify = r })
        notify = null
      }
    },
  }
}

export class Conductor {
  private hired = new Map<number, Hired>()

  constructor(private db: Database.Database, private bus: EventEmitter) {}

  private emit(boardId: number, type: string, data: unknown) {
    this.bus.emit('event', { board_id: boardId, type, data })
  }
  private touch(agentId: number, status: 'active' | 'idle') {
    this.db.prepare(`UPDATE agents SET status=?, last_seen=datetime('now') WHERE id=?`).run(status, agentId)
    const a = this.db.prepare(`SELECT * FROM agents WHERE id=?`).get(agentId) as any
    if (a) this.emit(a.board_id, 'agent', a)
  }

  isHired(agentId: number): boolean { return this.hired.has(agentId) }

  list(boardId: number): number[] {
    return [...this.hired.values()].filter((h) => h.boardId === boardId).map((h) => h.agentId)
  }

  hire(opts: { boardId: number; cwd: string; name?: string; model?: string }): any {
    let name = opts.name
    if (!name) {
      do { name = generateName() } while (
        this.db.prepare(`SELECT 1 FROM agents WHERE board_id=? AND name=?`).get(opts.boardId, name))
    }
    const { lastInsertRowid } = this.db.prepare(`
      INSERT INTO agents (board_id, name, session_id, kind) VALUES (?, ?, ?, 'hired')
      ON CONFLICT(board_id, name) DO UPDATE SET status='active', last_seen=datetime('now'), kind='hired'
    `).run(opts.boardId, name, `hired:${Date.now()}`)
    const agent = this.db.prepare(`SELECT * FROM agents WHERE board_id=? AND name=?`).get(opts.boardId, name) as any

    const input = createInput()
    const transcript: TranscriptLine[] = []
    const log = (kind: TranscriptLine['kind'], text: string) => {
      transcript.push({ at: new Date().toISOString(), kind, text })
      if (transcript.length > 500) transcript.shift()
      this.emit(opts.boardId, 'transcript', { agent_id: agent.id })
    }

    const q = query({
      prompt: input.stream(),
      options: {
        cwd: opts.cwd,
        ...(opts.model ? { model: opts.model } : {}),
        permissionMode: 'bypassPermissions',
        systemPrompt: { type: 'preset', preset: 'claude_code', append: rules(name) },
        // ORCHESTRA_NAME makes the in-session hooks re-register this same identity
        // instead of minting a second "session" agent for the SDK subprocess
        env: { ...process.env, ORCHESTRA_PORT: String(port()), ORCHESTRA_AGENT: name, ORCHESTRA_NAME: name },
      } as any,
    })

    const hired: Hired = {
      agentId: agent.id, boardId: opts.boardId, name, cwd: opts.cwd,
      push: (text: string) => { log('user', text); input.push(text) }, end: input.end,
      interrupt: async () => { try { await (q as any).interrupt() } catch { /* already stopped */ } },
      transcript,
    }
    this.hired.set(agent.id, hired)
    log('status', `hired in ${opts.cwd}`)

    void (async () => {
      try {
        for await (const m of q as AsyncIterable<any>) {
          if (m.type === 'assistant') {
            const blocks = m.message?.content ?? []
            for (const b of blocks) if (b.type === 'text' && b.text) log('text', b.text)
            this.touch(agent.id, 'active')
          } else if (m.type === 'result') {
            log('status', `turn finished (${m.subtype ?? 'done'})`)
            this.touch(agent.id, 'idle')
          }
        }
      } catch (e: any) {
        log('error', String(e?.message ?? e))
      } finally {
        this.hired.delete(agent.id)
        removeAgentCards(this.db, agent.id)
        this.db.prepare(`UPDATE agents SET status='gone' WHERE id=?`).run(agent.id)
        const a = this.db.prepare(`SELECT * FROM agents WHERE id=?`).get(agent.id)
        this.emit(opts.boardId, 'agent', a)
        this.emit(opts.boardId, 'card', { pruned: agent.id })
      }
    })()

    return agent
  }

  // instant delivery — no hooks, straight into the agent's conversation
  deliver(agentId: number, msg: { id: number; body: string; from_name?: string | null; reply_to?: number | null }): boolean {
    const h = this.hired.get(agentId)
    if (!h) return false
    const text = msg.reply_to
      ? `orchestra message from ${msg.from_name ?? 'human'}: "${msg.body}" (this answers your msg #${msg.reply_to})`
      : `orchestra message from ${msg.from_name ?? 'human'}: "${msg.body}" — answer it now with: orchestra reply ${msg.id} "<answer>" --from ${h.name}, then continue your task.`
    h.push(text)
    this.touch(agentId, 'active')
    return true
  }

  task(agentId: number, text: string): boolean {
    const h = this.hired.get(agentId)
    if (!h) return false
    h.push(text)
    this.touch(agentId, 'active')
    return true
  }

  transcript(agentId: number): TranscriptLine[] {
    return this.hired.get(agentId)?.transcript ?? []
  }

  async fire(agentId: number): Promise<boolean> {
    const h = this.hired.get(agentId)
    if (!h) return false
    await h.interrupt()
    h.end() // input stream closes → query ends → finally block cleans up
    return true
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.hired.keys()].map((id) => this.fire(id)))
  }
}
