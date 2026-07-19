import type Database from 'better-sqlite3'
import { EventEmitter } from 'node:events'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { generateName } from './names.js'
import { removeAgentCards, bounceDeadLetters } from './reaper.js'
import { emptyUsage, fromSdkUsage, addUsage, turnUsage, recordUsage, hasUsage, UsageSplit } from './usage.js'
import { port } from './daemon.js'
import { conductorRules } from './rules.js'
import { autoshipEnabled } from './shipqueue.js'

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

// modes the board can switch a hired agent between; anything else stays bypass
export const PERMISSION_MODES = ['bypassPermissions', 'acceptEdits', 'plan'] as const
export type HiredPermissionMode = (typeof PERMISSION_MODES)[number]

// the SDK's effort ladder — a spawn param, not switchable mid-session, so changing it
// means restart-with-resume (see setEffort)
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type EffortLevel = (typeof EFFORT_LEVELS)[number]

type PendingPermission = {
  id: string
  tool: string
  summary: string
  title: string | null
  at: string
  finish: (allow: boolean, message?: string) => void
}

type Hired = {
  agentId: number
  boardId: number
  name: string
  cwd: string
  push: (text: string) => void
  end: () => void
  interrupt: () => Promise<void>
  // live SDK handle — shared control surface (setPermissionMode here, setModel for #41); never serialize it
  query: any
  permissionMode: HiredPermissionMode
  pending: Map<string, PendingPermission>
  // this session's slash commands, kept fresh by init + commands_changed (REPLACE semantics)
  commands: { name: string; description: string }[]
  transcript: TranscriptLine[]
  turnStart: number | null
  turnTokens: number
  sessionTokens: number
  // true token split from the API's own usage reports — turn accrues live from assistant
  // messages, session sums authoritative per-turn totals (result usage when present)
  turnUsage: UsageSplit
  sessionUsage: UsageSplit
  model: string | null
  effort: EffortLevel | null
  models: any[]
  role?: 'strategist' | 'auditor' | 'verifier'
  // an effort restart supersedes this session — its exit must leave cards/queue untouched
  handoff: boolean
  ephemeral: boolean
  subs: Map<string, string>
  // launched-on-ticket agents carry their card through to review/blocked on exit
  cardId: number | null
  // the card worktree's branch, when autoship launched this agent isolated (#59)
  branch: string | null
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
   orchestra card create "<title>" --desc "OBJECTIVE: <one sentence>. CONTEXT: <exact files, patterns, constraints you verified>. REQUIREMENTS: <essentials, separated by ';'>. DONE WHEN: <verifiable acceptance criteria>." --paths <files/globs you verified> --no-owner
   (--no-owner keeps the ticket unassigned so it stays on the board after you dissolve — never claim it yourself)
4. CONSUME: remove the source idea with orchestra idea-done <idea-id>.
5. REPORT — REQUIRED, your console vanishes when you finish, so the report must live on the board:
   orchestra note "audit idea #<id>: <created ticket #N | rejected — reason | duplicate of card #N>" --from ${me}
   Then stop; you will be released.
Be skeptical and precise: a thin idea deserves interrogation of the codebase, not a thin ticket. Do not brainstorm new ideas, do not create milestones, do not take tickets.`

const verifierRules = (me: string) => `You are "${me}", a one-shot delivery verifier for the Orchestra board. Your single job: check ONE delivered card against its own acceptance criteria and report a per-criterion verdict. You NEVER modify files, never create cards, never approve, move, or ship anything — you only inspect and report.
How you work — in order:
1. CRITERIA: split the DONE WHEN section of the card description in your brief into individual criteria. No DONE WHEN → fall back to REQUIREMENTS. Neither → treat the OBJECTIVE as a single criterion.
2. EVIDENCE: inspect the actual delivered changes, not the claimed summary — use the shipped commit if your brief names one (git show <hash>), otherwise locate the delivery (recent merges matching the card, or the diffstat in your brief) and read the real code.
3. TEST: if package.json has a "test" script, run it and record the outcome; otherwise report tested:false. Never fix anything.
4. JUDGE each criterion: met true (evidence found), false (contradicted or absent), or "unverifiable" (cannot be established from the repo) — with one line of evidence each.
5. REPORT — REQUIRED, exactly once, using the curl command template in your brief. Overall verdict: pass = every criterion met; gaps = unmet/unverifiable criteria but the core objective is delivered; fail = core objective missing or the test suite is broken by the change.
Then stop; you will be released. Be skeptical: your entire value is the gap between what was claimed and what was delivered.`

const rules = conductorRules

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
    const c = this.db.prepare(`SELECT c.id, c.branch FROM cards c
      JOIN card_events e ON e.card_id=c.id AND e.type='launched' AND e.agent_id=?
      WHERE c.owner_agent_id=? AND c.column_name='in_progress'`).get(agentId, agentId) as any
    if (c) { h.cardId = c.id; h.branch = c.branch ?? null }
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
    // autoship isolates each ticket in its own worktree+branch so the daemon can later
    // merge it test-gated; falling back to the shared checkout just disables auto-merge
    let cwd = req.cwd
    let branch: string | null = null
    if (autoshipEnabled()) {
      const name = `card-${req.cardId}`
      const wt = path.join(req.cwd, '..', `${path.basename(req.cwd)}-card-${req.cardId}`)
      try {
        if (!existsSync(wt)) {
          try { execFileSync('git', ['worktree', 'add', wt, '-b', name], { cwd: req.cwd, timeout: 30_000 }) }
          catch { execFileSync('git', ['worktree', 'add', wt, name], { cwd: req.cwd, timeout: 30_000 }) } // relaunch reuses the branch
        }
        cwd = wt
        branch = name
      } catch { /* not a git repo or worktree failed — shared checkout, no auto-merge */ }
    }
    const agent = this.hire({ boardId: req.boardId, cwd })
    const h = this.hired.get(agent.id)!
    h.cardId = req.cardId
    h.branch = branch
    this.db.prepare(`UPDATE cards SET owner_agent_id=?, column_name='in_progress', branch=?, updated_at=datetime('now') WHERE id=?`)
      .run(agent.id, branch, req.cardId)
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

  hire(opts: { boardId: number; cwd: string; name?: string; model?: string; role?: 'strategist' | 'auditor' | 'verifier'; ephemeral?: boolean; resumeSession?: string; permissionMode?: string; effort?: string }): any {
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

    const permissionMode: HiredPermissionMode = PERMISSION_MODES.includes(opts.permissionMode as HiredPermissionMode)
      ? opts.permissionMode as HiredPermissionMode : 'bypassPermissions'
    const pending = new Map<string, PendingPermission>()
    // non-bypass modes deny tools unless a canUseTool handler answers — park each ask as a
    // pending request the board resolves via approve/deny buttons in the terminal
    const canUseTool = (toolName: string, toolInput: Record<string, unknown>, o: any): Promise<any> => {
      const id = String(o?.toolUseID ?? o?.requestId ?? `${Date.now()}-${pending.size}`)
      const summary = toolSummary(toolName, toolInput)
      log('status', `permission requested: ${o?.title ?? summary}`)
      this.emit(opts.boardId, 'permission', { agent_id: agent.id, request_id: id, tool: toolName, summary, title: o?.title ?? null, status: 'pending' })
      return new Promise((resolve) => {
        pending.set(id, {
          id, tool: toolName, summary, title: o?.title ?? null, at: new Date().toISOString(),
          finish: (allow, message) => {
            pending.delete(id)
            log('status', `permission ${allow ? 'allowed' : 'denied'}: ${summary}`)
            this.emit(opts.boardId, 'permission', { agent_id: agent.id, request_id: id, status: allow ? 'allowed' : 'denied' })
            resolve(allow ? { behavior: 'allow', updatedInput: toolInput } : { behavior: 'deny', message: message || 'denied from the board' })
          },
        })
        // an interrupted turn withdraws its asks — fail closed, leave no orphan buttons
        o?.signal?.addEventListener?.('abort', () => {
          if (!pending.delete(id)) return
          this.emit(opts.boardId, 'permission', { agent_id: agent.id, request_id: id, status: 'withdrawn' })
          resolve({ behavior: 'deny', message: 'permission request aborted' })
        })
      })
    }

    const effort: EffortLevel | null = EFFORT_LEVELS.includes(opts.effort as EffortLevel) ? opts.effort as EffortLevel : null

    // ORCHESTRA_NAME makes the in-session hooks re-register this same identity
    // instead of minting a second "session" agent for the SDK subprocess
    const env: Record<string, string | undefined> = { ...process.env, ORCHESTRA_PORT: String(port()), ORCHESTRA_AGENT: name, ORCHESTRA_NAME: name }
    // auditors author tickets meant to outlive them — without ORCHESTRA_AGENT the cli
    // cannot auto-claim ownership, so their cards are born unowned
    if (opts.role === 'auditor' || opts.role === 'verifier') delete env.ORCHESTRA_AGENT
    const q = query({
      prompt: input.stream(),
      options: {
        cwd: opts.cwd,
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.resumeSession ? { resume: opts.resumeSession } : {}),
        ...(effort ? { effort } : {}),
        permissionMode,
        canUseTool,
        systemPrompt: { type: 'preset', preset: 'claude_code', append: (opts.role === 'strategist' ? strategistRules : opts.role === 'auditor' ? auditorRules : opts.role === 'verifier' ? verifierRules : rules)(name) },
        env,
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
      query: q,
      permissionMode,
      pending,
      commands: [],
      transcript,
      turnStart: null, turnTokens: 0, sessionTokens: 0, turnUsage: emptyUsage(), sessionUsage: emptyUsage(),
      model: null, ephemeral: opts.ephemeral ?? false, subs: new Map(),
      effort, models: [], role: opts.role, handoff: false,
      cardId: null, branch: null, outcome: null, reason: '', summary: '',
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
            // init carries names only; supportedCommands() backfills descriptions (best effort —
            // don't overwrite if a commands_changed replacement raced ahead of the resolution)
            hired.commands = (m.slash_commands ?? []).map((n: string) => ({ name: n, description: '' }))
            const fromInit = hired.commands
            Promise.resolve((q as any).supportedCommands?.())
              .then((cmds: any) => {
                if (Array.isArray(cmds) && hired.commands === fromInit)
                  hired.commands = cmds.map((c: any) => ({ name: c.name, description: c.description ?? '' }))
              })
              .catch(() => { /* older CLI without the control request */ })
            // model catalog (incl. per-model effort levels) for the terminal's selectors
            void Promise.resolve((q as any).supportedModels?.()).then((ms) => { hired.models = ms ?? [] }).catch(() => {})
            log('status', `session started · ${m.model ?? ''} · ${opts.cwd}`)
          } else if (m.type === 'system' && m.subtype === 'commands_changed') {
            // mid-session push (e.g. skills discovered while working) — REPLACE the cached list
            hired.commands = (m.commands ?? []).map((c: any) => ({ name: c.name, description: c.description ?? '' }))
          } else if (m.type === 'assistant') {
            if (hired.turnStart === null) hired.turnStart = Date.now()
            hired.turnTokens += m.message?.usage?.output_tokens ?? 0
            hired.sessionTokens += m.message?.usage?.output_tokens ?? 0
            if (m.message?.usage) addUsage(hired.turnUsage, fromSdkUsage(m.message.usage))
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
            const turn = turnUsage(m.usage, hired.turnUsage)
            addUsage(hired.sessionUsage, turn)
            recordUsage(this.db, opts.boardId, agent.id, turn)
            hired.turnUsage = emptyUsage()
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
        // a session that dies mid-turn (error, fire, effort handoff) still consumed real
        // tokens — flush the in-flight accrual so the daily rollup never undercounts
        if (hasUsage(hired.turnUsage)) {
          recordUsage(this.db, opts.boardId, agent.id, hired.turnUsage)
          hired.turnUsage = emptyUsage()
        }
        hired.pending.clear()
        this.hired.delete(agent.id)
        // an effort restart supersedes this session: the replacement re-registers the same
        // agent row and inherits the ticket, so the exit path must not park, prune, or drain —
        // and its mail is still deliverable, so it must not bounce either (gone ⇒ bounce, alive ⇒ deliver)
        if (!hired.handoff) {
          if (hired.cardId !== null) this.finalizeLaunch(hired)
          removeAgentCards(this.db, agent.id)
          this.db.prepare(`UPDATE agents SET status='gone' WHERE id=?`).run(agent.id)
          for (const bounce of bounceDeadLetters(this.db, agent.id) as any[]) {
            const sender = bounce.to_agent_id
            if (sender && this.isHired(sender) && this.deliver(sender, { ...bounce, from_name: null })) {
              this.db.prepare(`INSERT OR IGNORE INTO deliveries (message_id, agent_id) VALUES (?, ?)`).run(bounce.id, sender)
              this.db.prepare(`UPDATE messages SET delivered_at=coalesce(delivered_at, datetime('now')) WHERE id=?`).run(bounce.id)
            }
            this.emit(opts.boardId, 'message', bounce)
          }
          const a = this.db.prepare(`SELECT * FROM agents WHERE id=?`).get(agent.id)
          this.emit(opts.boardId, 'agent', a)
          this.emit(opts.boardId, 'card', { pruned: agent.id })
          if (hired.cardId !== null) this.drainQueue()
        }
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

  transcript(agentId: number): { lines: TranscriptLine[]; working: { secs: number; tokens: number } | null; info?: { model: string | null; cwd: string; tokens: number; permissionMode: string; commands: { name: string; description: string }[]; effort: string | null; models: any[]; usage: { turn: UsageSplit; session: UsageSplit } }; permissions?: Omit<PendingPermission, 'finish'>[] } {
    const h = this.hired.get(agentId)
    if (!h) return { lines: [], working: null }
    return {
      lines: h.transcript,
      working: h.turnStart ? { secs: Math.round((Date.now() - h.turnStart) / 1000), tokens: h.turnTokens } : null,
      info: { model: h.model, cwd: h.cwd, tokens: h.sessionTokens, permissionMode: h.permissionMode, commands: h.commands, effort: h.effort, models: h.models,
        usage: { turn: h.turnUsage, session: h.sessionUsage } },
      permissions: [...h.pending.values()].map(({ finish: _f, ...p }) => p),
    }
  }

  // live-switch the model for subsequent turns; persisted so a daemon restart resumes with it
  async setModel(agentId: number, model: string): Promise<boolean> {
    const h = this.hired.get(agentId)
    if (!h || !model) return false
    try { await h.query.setModel(model) } catch { return false }
    h.model = model
    this.db.prepare(`UPDATE agents SET model=? WHERE id=?`).run(model, agentId)
    h.transcript.push({ at: new Date().toISOString(), kind: 'status', text: `model → ${model} (takes effect next turn)` })
    this.emit(h.boardId, 'transcript', { agent_id: agentId })
    this.emit(h.boardId, 'agent_model', { agent_id: agentId, model })
    return true
  }

  // effort is a spawn param (no mid-session setter in the SDK) — changing it restarts the
  // session with resume, carrying ticket, permission mode, model, and transcript history
  async setEffort(agentId: number, level: string): Promise<'ok' | 'busy' | 'not-found' | 'bad-level' | 'no-session'> {
    const h = this.hired.get(agentId)
    if (!h) return 'not-found'
    if (!EFFORT_LEVELS.includes(level as EffortLevel)) return 'bad-level'
    if (h.turnStart !== null) return 'busy' // mirror the launch gate: never yank a running turn
    const row = this.db.prepare(`SELECT sdk_session FROM agents WHERE id=?`).get(agentId) as any
    if (!row?.sdk_session) return 'no-session' // nothing to resume — a restart would drop the conversation

    const prior = { cardId: h.cardId, branch: h.branch, model: h.model, permissionMode: h.permissionMode, role: h.role, lines: [...h.transcript] }
    h.handoff = true
    await h.interrupt()
    h.end() // input stream closes → query ends → finally tears down without touching cards
    for (let i = 0; i < 250 && this.hired.has(agentId); i++) await new Promise((r) => setTimeout(r, 20))
    if (this.hired.has(agentId)) { h.handoff = false; return 'busy' } // teardown stuck; leave the session alone

    this.hire({
      boardId: h.boardId, cwd: h.cwd, name: h.name, role: prior.role,
      resumeSession: row.sdk_session, permissionMode: prior.permissionMode,
      model: prior.model ?? undefined, effort: level,
    })
    const nh = this.hired.get(agentId)
    if (!nh) return 'not-found' // respawn failed; agent row already re-marked active by hire's upsert
    nh.cardId = prior.cardId // launched tickets ride through the restart
    nh.branch = prior.branch
    nh.transcript.unshift(...prior.lines.slice(-400))
    nh.transcript.push({ at: new Date().toISOString(), kind: 'status', text: `effort → ${level} (session restarted with conversation resumed)` })
    this.db.prepare(`UPDATE agents SET effort=? WHERE id=?`).run(level, agentId)
    this.emit(nh.boardId, 'transcript', { agent_id: agentId })
    this.emit(nh.boardId, 'agent_effort', { agent_id: agentId, effort: level })
    return 'ok'
  }

  // live-switch the SDK session's permission mode; persisted so a daemon restart resumes with it
  async setPermissionMode(agentId: number, mode: string): Promise<boolean> {
    const h = this.hired.get(agentId)
    if (!h || !PERMISSION_MODES.includes(mode as HiredPermissionMode)) return false
    try { await h.query.setPermissionMode(mode) } catch { return false }
    h.permissionMode = mode as HiredPermissionMode
    this.db.prepare(`UPDATE agents SET permission_mode=? WHERE id=?`).run(mode, agentId)
    h.transcript.push({ at: new Date().toISOString(), kind: 'status', text: `permission mode → ${mode}` })
    this.emit(h.boardId, 'permission_mode', { agent_id: agentId, mode })
    return true
  }

  resolvePermission(agentId: number, requestId: string, behavior: 'allow' | 'deny', message?: string): boolean {
    const p = this.hired.get(agentId)?.pending.get(requestId)
    if (!p) return false
    p.finish(behavior === 'allow', message)
    return true
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
