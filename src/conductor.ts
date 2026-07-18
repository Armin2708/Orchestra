import type Database from 'better-sqlite3'
import { EventEmitter } from 'node:events'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { generateName } from './names.js'
import { removeAgentCards } from './reaper.js'
import { port } from './daemon.js'

type TranscriptLine = { at: string; kind: 'text' | 'status' | 'error' | 'user' | 'tool' | 'tool_result' | 'thinking'; text: string }

// one-line summary of a tool call, claude-code style: Bash(git status) / Read(src/app.ts)
function toolSummary(name: string, input: any): string {
  const arg = input?.command ?? input?.file_path ?? input?.path ?? input?.pattern ?? input?.url ?? input?.query
  const s = typeof arg === 'string' ? arg : JSON.stringify(input ?? {})
  return `${name}(${s.length > 90 ? s.slice(0, 90) + '…' : s})`
}

function resultSummary(content: unknown): string {
  const text = typeof content === 'string' ? content
    : Array.isArray(content) ? content.map((c: any) => c?.text ?? '').join('\n') : ''
  const lines = text.split('\n').filter((l) => l.trim() !== '')
  if (lines.length === 0) return '(no output)'
  const first = lines[0].length > 110 ? lines[0].slice(0, 110) + '…' : lines[0]
  return lines.length > 1 ? `${first}  … +${lines.length - 1} lines` : first
}

type Hired = {
  agentId: number
  boardId: number
  name: string
  cwd: string
  push: (text: string) => void
  end: () => void
  interrupt: () => Promise<void>
  transcript: TranscriptLine[]
  turnStart: number | null
  turnTokens: number
  sessionTokens: number
  model: string | null
  ephemeral: boolean
  subs: Map<string, string>
  // launched-on-ticket agents carry their card through to review/blocked on exit
  cardId: number | null
  outcome: 'success' | 'error' | null
  reason: string
  summary: string
}

type LaunchRequest = { boardId: number; cardId: number; cwd: string; brief: string }

const strategistRules = (me: string) => `You are "${me}", this project's strategist — a specialist in brainstorming, product research, and writing tickets that other agents can execute from directly. You NEVER modify files; you research and produce roadmap material.
How you work:
- Converse with the user like a thinking partner: when a request is ambiguous, ask one sharp clarifying question before producing output; explain your reasoning briefly as you go.
- When given a brainstorm request, research the repository first (read the README, key source files, docs, recent git log) so ideas are grounded in reality.
- Produce concrete, high-value, well-scoped ideas — quality over quantity (4-6 per request unless told otherwise).
- Record EACH idea on the roadmap with: orchestra idea "<short title>" --desc "<2-3 sentences: what, why it matters, rough approach>"
- TICKET FORMAT — every ticket you create is a ready-to-run prompt for the agent who will pick it up. Write --desc in exactly this shape, imperative voice, addressed to that agent:
  "OBJECTIVE: <one sentence — what to build/fix>. CONTEXT: <key files, patterns, and constraints you found in the repo>. REQUIREMENTS: <the essentials, separated by ';'>. DONE WHEN: <verifiable acceptance criteria>."
  Create with: orchestra card create "<title>" --desc "<that format>" --paths <files/globs you identified> (leave in backlog, unassigned).
- When the user says a rough idea is worth doing ('make it a ticket', 'let's do that'), convert it using the ticket format above.
- IDEA CONVERSION — when asked to turn a roadmap idea into a ticket: audit it first (research the repo to validate the approach and identify the exact files), enrich it with what you learn, create the ticket in your format with --paths, then remove the consumed idea with orchestra idea-done <idea-id> and report the new ticket id. If the idea is unclear or a bad fit, say why and ask before creating anything.
- MILESTONES — for major goals, plan an ordered quest: propose the step sequence to the user first; once agreed, create it with orchestra milestone "<title>" --desc "<goal>" then orchestra step <milestone-id> "<step title>" --desc "<ticket format>" for each step IN ORDER (steps unlock sequentially on the board).
- REFINING — when asked to refine a ticket, read it (orchestra snapshot), then rewrite it with orchestra card update <id> --desc "<ticket format>" and confirm what changed.
- Answer board questions promptly (orchestra reply <id> "<answer>" --from ${me}).
- Finish each request with a one-line summary of what you added, then stop and wait.`

const auditorRules = (me: string) => `You are "${me}", a one-shot ticket auditor for the Orchestra board. You exist for a single job: audit ONE roadmap idea and either turn it into an excellent ticket or reject it with reasons. You NEVER modify files.
How you work — in order:
1. VALIDATE: research the repo (relevant source files, docs, recent git log) to judge whether the idea is feasible, already implemented, or contradicted by how the code actually works.
2. CHECK FOR OVERLAP: run orchestra snapshot and compare the idea against existing cards and milestones — if a ticket already covers it, do NOT duplicate; remove the idea (orchestra idea-done <id>) and report why.
3. SPEC: if it survives, write ONE ticket as a ready-to-run prompt for the implementing agent:
   orchestra card create "<title>" --desc "OBJECTIVE: <one sentence>. CONTEXT: <exact files, patterns, constraints you verified>. REQUIREMENTS: <essentials, separated by ';'>. DONE WHEN: <verifiable acceptance criteria>." --paths <files/globs you verified>
4. CONSUME: remove the source idea with orchestra idea-done <idea-id>.
5. REPORT — REQUIRED, your console vanishes when you finish, so the report must live on the board:
   orchestra note "audit idea #<id>: <created ticket #N | rejected — reason | duplicate of card #N>" --from ${me}
   Then stop; you will be released.
Be skeptical and precise: a thin idea deserves interrogation of the codebase, not a thin ticket. Do not brainstorm new ideas, do not create milestones, do not take tickets.`

const rules = (me: string) => `You are agent "${me}", a hired Orchestra agent working autonomously in this project.
Orchestra board rules (standing instructions):
- REQUIRED before starting any task: run orchestra snapshot and evaluate every active card's title and description against your task. If another agent's card looks similar, related, or could conflict, you MUST ask its owner what they're covering BEFORE you start (orchestra ask <agent> "..." --from ${me}), wait for the answer, and scope your work to not duplicate theirs.
- REQUIRED: when you receive a task, BEFORE your first file edit, register it:
  orchestra card create "<short title>" --desc "<scope>" --paths <comma,separated,paths> --column in_progress --agent ${me}
  If the response shows "⚠ overlap" or "≈ similar work", ask that agent before proceeding.
- Keep the card updated as you progress (orchestra card update/move --agent ${me}); move it to done when finished.
- Do NOT touch paths claimed by another active card without asking first.
- If your assignment mentions open prerequisite steps, message their owners FIRST (orchestra ask) to agree boundaries and interfaces — then build in parallel against the agreed contract instead of waiting.
- Messages from the board arrive directly in this conversation; answer questions promptly with: orchestra reply <msg-id> "<answer>" --from ${me}, then continue your task.
- SUBAGENTS: spawn them freely for parallel work — they operate under YOUR identity and YOUR card. Tell every subagent in its prompt: do NOT run orchestra commands (no cards, no asks, no replies) — board coordination belongs to you, the parent. Summarize subagent results on your card as you go.
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
  private launchQueue: LaunchRequest[] = []

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

  subagents(agentId: number): { key: string; label: string }[] {
    const h = this.hired.get(agentId)
    return h ? [...h.subs.entries()].map(([key, label]) => ({ key, label })) : []
  }

  list(boardId: number): number[] {
    return [...this.hired.values()].filter((h) => h.boardId === boardId).map((h) => h.agentId)
  }

  private cardRow(id: number): any {
    const c = this.db.prepare(`SELECT c.*, a.name AS owner FROM cards c LEFT JOIN agents a ON a.id=c.owner_agent_id WHERE c.id=?`).get(id) as any
    return c && { ...c, column: c.column_name, paths: JSON.parse(c.paths) }
  }
  private logCardEvent(cardId: number, agentId: number | null, type: string, payload: unknown = {}) {
    this.db.prepare(`INSERT INTO card_events (card_id, agent_id, type, payload) VALUES (?, ?, ?, ?)`)
      .run(cardId, agentId, type, JSON.stringify(payload))
  }
  private maxLaunched(): number {
    const n = Number(process.env.ORCHESTRA_MAX_LAUNCHED ?? 3)
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 3
  }
  private launchedCount(): number {
    return [...this.hired.values()].filter((h) => h.cardId !== null).length
  }

  isLaunched(cardId: number): boolean {
    return [...this.hired.values()].some((h) => h.cardId === cardId) ||
      this.launchQueue.some((q) => q.cardId === cardId)
  }

  // a daemon restart resumes launched agents with cardId lost to memory — re-adopt the
  // ticket from the db, or the agent's eventual exit would delete it via removeAgentCards
  adoptLaunch(agentId: number): void {
    const h = this.hired.get(agentId)
    if (!h || h.cardId !== null) return
    const c = this.db.prepare(`SELECT c.id FROM cards c
      JOIN card_events e ON e.card_id=c.id AND e.type='launched' AND e.agent_id=?
      WHERE c.owner_agent_id=? AND c.column_name='in_progress'`).get(agentId, agentId) as any
    if (c) h.cardId = c.id
  }


  launch(req: LaunchRequest): any {
    if (this.launchedCount() >= this.maxLaunched()) {
      // one queue slot per card — relaunching a queued ticket must not double-book it
      if (!this.launchQueue.some((q) => q.cardId === req.cardId)) this.launchQueue.push(req)
      const position = this.launchQueue.findIndex((q) => q.cardId === req.cardId) + 1
      this.emit(req.boardId, 'launch', { card_id: req.cardId, status: 'queued', position })
      this.logCardEvent(req.cardId, null, 'launch_queued', { position })
      return { queued: true, position }
    }
    return this.startLaunch(req)
  }

  private startLaunch(req: LaunchRequest): any {
    const agent = this.hire({ boardId: req.boardId, cwd: req.cwd })
    const h = this.hired.get(agent.id)!
    h.cardId = req.cardId
    this.db.prepare(`UPDATE cards SET owner_agent_id=?, column_name='in_progress', updated_at=datetime('now') WHERE id=?`)
      .run(agent.id, req.cardId)
    this.logCardEvent(req.cardId, agent.id, 'launched', { agent: agent.name })
    this.emit(req.boardId, 'card', this.cardRow(req.cardId))
    this.emit(req.boardId, 'launch', { card_id: req.cardId, agent_id: agent.id, agent_name: agent.name, status: 'started' })
    h.push(req.brief)
    return { agent, card: this.cardRow(req.cardId) }
  }

  // the ticket must survive its agent: park it in review/blocked and release ownership
  // BEFORE removeAgentCards deletes everything the exiting agent still owns
  private finalizeLaunch(h: Hired): void {
    const card = this.cardRow(h.cardId!)
    if (!card) return
    const outcome = h.outcome ?? 'error'
    const reason = h.reason || (outcome === 'success' ? 'finished' : 'agent exited unexpectedly')
    const to = card.column === 'done' ? 'done' : outcome === 'success' ? 'review' : 'blocked'
    this.db.prepare(`UPDATE cards SET owner_agent_id=NULL, column_name=?, updated_at=datetime('now') WHERE id=?`)
      .run(to, card.id)
    this.logCardEvent(card.id, h.agentId, 'agent_exit', { outcome, reason, to, agent: h.name })
    this.emit(h.boardId, 'card', this.cardRow(card.id))
    this.emit(h.boardId, 'launch', {
      card_id: card.id, agent_id: h.agentId, agent_name: h.name,
      status: 'finished', outcome, reason, to_column: to, summary: h.summary,
    })
  }

  private drainQueue(): void {
    while (this.launchQueue.length && this.launchedCount() < this.maxLaunched()) {
      this.startLaunch(this.launchQueue.shift()!)
    }
  }

  hire(opts: { boardId: number; cwd: string; name?: string; model?: string; role?: 'strategist' | 'auditor'; ephemeral?: boolean; resumeSession?: string }): any {
    // re-hiring an already-live name returns the existing session instead of leaking a new one
    if (opts.name) {
      const existing = [...this.hired.values()].find((h) => h.boardId === opts.boardId && h.name === opts.name)
      if (existing) return this.db.prepare(`SELECT * FROM agents WHERE id=?`).get(existing.agentId)
    }
    let name = opts.name
    if (!name) {
      do { name = generateName() } while (
        this.db.prepare(`SELECT 1 FROM agents WHERE board_id=? AND name=?`).get(opts.boardId, name))
    }
    const { lastInsertRowid } = this.db.prepare(`
      INSERT INTO agents (board_id, name, session_id, kind, role) VALUES (?, ?, ?, 'hired', ?)
      ON CONFLICT(board_id, name) DO UPDATE SET status='active', last_seen=datetime('now'), kind='hired', role=excluded.role
    `).run(opts.boardId, name, `hired:${Date.now()}`, opts.role ?? null)
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
        ...(opts.resumeSession ? { resume: opts.resumeSession } : {}),
        permissionMode: 'bypassPermissions',
        systemPrompt: { type: 'preset', preset: 'claude_code', append: (opts.role === 'strategist' ? strategistRules : opts.role === 'auditor' ? auditorRules : rules)(name) },
        // ORCHESTRA_NAME makes the in-session hooks re-register this same identity
        // instead of minting a second "session" agent for the SDK subprocess
        env: { ...process.env, ORCHESTRA_PORT: String(port()), ORCHESTRA_AGENT: name, ORCHESTRA_NAME: name },
      } as any,
    })

    const hired: Hired = {
      agentId: agent.id, boardId: opts.boardId, name, cwd: opts.cwd,
      push: (text: string) => {
        log('user', text)
        if (hired.turnStart === null) { hired.turnStart = Date.now(); hired.turnTokens = 0 }
        input.push(text)
      },
      end: input.end,
      interrupt: async () => { try { await (q as any).interrupt() } catch { /* already stopped */ } },
      transcript,
      turnStart: null, turnTokens: 0, sessionTokens: 0, model: null, ephemeral: opts.ephemeral ?? false, subs: new Map(),
      cardId: null, outcome: null, reason: '', summary: '',
    }
    this.hired.set(agent.id, hired)
    log('status', opts.resumeSession ? `resumed in ${opts.cwd} (previous session continues)` : `hired in ${opts.cwd}`)

    void (async () => {
      try {
        for await (const m of q as AsyncIterable<any>) {
          if (m.type === 'system' && m.subtype === 'init') {
            hired.model = m.model ?? null
            // remember the sdk session so a daemon restart can resume this agent with its memory intact
            if (m.session_id) this.db.prepare(`UPDATE agents SET sdk_session=? WHERE id=?`).run(m.session_id, agent.id)
            log('status', `session started · ${m.model ?? ''} · ${opts.cwd}`)
          } else if (m.type === 'assistant') {
            if (hired.turnStart === null) hired.turnStart = Date.now()
            hired.turnTokens += m.message?.usage?.output_tokens ?? 0
            hired.sessionTokens += m.message?.usage?.output_tokens ?? 0
            const blocks = m.message?.content ?? []
            for (const b of blocks) {
              if (b.type === 'text' && b.text) log('text', b.text)
              else if (b.type === 'thinking' && b.thinking?.trim()) log('thinking', b.thinking)
              else if (b.type === 'tool_use') {
                if (b.name === 'Task') {
                  const label = b.input?.description ?? b.input?.subagent_type ?? 'subagent'
                  hired.subs.set(b.id, String(label).slice(0, 40))
                  this.emit(opts.boardId, 'agent', { id: agent.id, subs: true })
                }
                log('tool', toolSummary(b.name, b.input))
              }
            }
            this.touch(agent.id, 'active')
          } else if (m.type === 'user') {
            for (const b of (Array.isArray(m.message?.content) ? m.message.content : [])) {
              if (b.type === 'tool_result') {
                if (b.tool_use_id && hired.subs.delete(b.tool_use_id)) this.emit(opts.boardId, 'agent', { id: agent.id, subs: true })
                log('tool_result', resultSummary(b.content))
              }
            }
          } else if (m.type === 'result') {
            const secs = m.duration_ms ? ` · ${(m.duration_ms / 1000).toFixed(1)}s` : ''
            log('status', `turn finished (${m.subtype ?? 'done'})${secs}`)
            hired.turnStart = null
            hired.turnTokens = 0
            hired.subs.clear()
            this.touch(agent.id, 'idle')
            // one-shot agents (idea auditors) dissolve after their turn
            if (hired.ephemeral) void this.fire(agent.id)
            // launched agents work one ticket run, then their card gets parked
            if (hired.cardId !== null && hired.outcome === null) {
              hired.outcome = m.subtype === 'success' ? 'success' : 'error'
              hired.reason = m.subtype === 'success' ? 'finished' : `agent turn ended: ${m.subtype ?? 'unknown error'}`
              hired.summary = typeof m.result === 'string' && m.result ? m.result
                : [...transcript].reverse().find((l) => l.kind === 'text')?.text ?? ''
              void this.fire(agent.id)
            }
          }
        }
      } catch (e: any) {
        log('error', String(e?.message ?? e))
        if (hired.cardId !== null && hired.outcome === null) {
          hired.outcome = 'error'
          hired.reason = String(e?.message ?? e)
        }
      } finally {
        this.hired.delete(agent.id)
        if (hired.cardId !== null) this.finalizeLaunch(hired)
        removeAgentCards(this.db, agent.id)
        this.db.prepare(`UPDATE agents SET status='gone' WHERE id=?`).run(agent.id)
        const a = this.db.prepare(`SELECT * FROM agents WHERE id=?`).get(agent.id)
        this.emit(opts.boardId, 'agent', a)
        this.emit(opts.boardId, 'card', { pruned: agent.id })
        if (hired.cardId !== null) this.drainQueue()
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

  transcript(agentId: number): { lines: TranscriptLine[]; working: { secs: number; tokens: number } | null; info?: { model: string | null; cwd: string; tokens: number } } {
    const h = this.hired.get(agentId)
    if (!h) return { lines: [], working: null }
    return {
      lines: h.transcript,
      working: h.turnStart ? { secs: Math.round((Date.now() - h.turnStart) / 1000), tokens: h.turnTokens } : null,
      info: { model: h.model, cwd: h.cwd, tokens: h.sessionTokens },
    }
  }

  async interruptAgent(agentId: number): Promise<boolean> {
    const h = this.hired.get(agentId)
    if (!h) return false
    await h.interrupt()
    const log = h.transcript
    log.push({ at: new Date().toISOString(), kind: 'status', text: 'interrupted by user' })
    this.touch(agentId, 'idle')
    return true
  }

  async fire(agentId: number): Promise<boolean> {
    const h = this.hired.get(agentId)
    if (!h) return false
    // a launched agent killed before finishing was stopped by a human
    if (h.cardId !== null && h.outcome === null) { h.outcome = 'error'; h.reason = 'stopped by user' }
    await h.interrupt()
    h.end() // input stream closes → query ends → finally block cleans up
    return true
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.hired.keys()].map((id) => this.fire(id)))
  }
}
