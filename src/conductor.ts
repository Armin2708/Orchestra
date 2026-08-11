import type Database from 'better-sqlite3'
import { EventEmitter } from 'node:events'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { generateName } from './names.js'
import { removeAgentCards, bounceDeadLetters } from './reaper.js'
import { emptyUsage, fromSdkUsage, addUsage, turnUsage, recordUsage, hasUsage, UsageSplit } from './usage.js'
import { conductorRules, outputDiscipline } from './rules.js'
import { isMastermindName, mastermindRules, mastermindToolDecision } from './mastermind-scope.js'
import { autoshipEnabled, cardWorktree } from './shipqueue.js'
import { isUsageLimitError } from './limits.js'
import { evaluatePolicy, type PolicyOperation } from './agent-os/policy-engine.js'
import { DEFAULT_AGENT_PROVIDER, defaultsForRole } from './agent-defaults.js'
import {
  claudeProviderCatalog,
  normalizeProviderModels,
  readProviderModelCache,
  writeProviderModelCache,
  type AgentProviderCatalog,
} from './agent-providers.js'
import { loadSdkSessionTranscript } from './external-transcript.js'
import { resolvePreferredClaudeExecutableV1 } from './readiness-doctor.js'
import { prepareManagedSubscriptionEnvironmentV1 } from './provider-runtime-environment.js'
import {
  issueManagedAgentLaunchBootstrap,
  MANAGED_AGENT_BOOTSTRAP_ENV,
  MANAGED_AGENT_HOME_SESSION_ENV,
} from './agent-session-credential.js'
import type {
  ClaudeAgentHomeBinding,
  ClaudeNativeEvent,
  ClaudeNativeEventSink,
} from './runtime/drivers/claude.js'

type TranscriptLine = { at: string; kind: 'text' | 'status' | 'error' | 'user' | 'tool' | 'tool_result' | 'thinking'; text: string }

// one-line summary of a tool call, claude-code style: Bash(git status) / Read(src/app.ts)
function toolSummary(name: string, input: any): string {
  const arg = input?.command ?? input?.file_path ?? input?.path ?? input?.pattern ?? input?.url ?? input?.query
  const s = typeof arg === 'string' ? arg : JSON.stringify(input ?? {})
  return `${name}(${s.length > 90 ? s.slice(0, 90) + '…' : s})`
}

// tools whose use counts as "real file work" for auto-card resolution (#143)
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

function resultSummary(content: unknown): string {
  const text = typeof content === 'string' ? content
    : Array.isArray(content) ? content.map((c: any) => c?.text ?? '').join('\n') : ''
  const lines = text.split('\n').filter((l) => l.trim() !== '')
  if (lines.length === 0) return '(no output)'
  const first = lines[0].length > 110 ? lines[0].slice(0, 110) + '…' : lines[0]
  return lines.length > 1 ? `${first}  … +${lines.length - 1} lines` : first
}

function policyOperationForTool(toolName: string, input: Record<string, unknown>, cwd: string): PolicyOperation {
  const command = input.command
  if (typeof command === 'string' && command.trim()) return { kind: 'command', value: command, actor: 'agent' }

  const file = input.file_path ?? input.path ?? input.notebook_path
  if (typeof file === 'string' && file.trim()) {
    const resolved = path.isAbsolute(file) ? path.normalize(file) : path.resolve(cwd, file)
    const relative = path.relative(cwd, resolved)
    const scoped = relative === '' ? '.'
      : !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative) ? relative : resolved
    return { kind: 'filesystem', value: scoped.replaceAll('\\', '/'), actor: 'agent' }
  }

  const url = input.url ?? input.host ?? input.domain
  if (typeof url === 'string' && url.trim()) return { kind: 'network', value: url, actor: 'agent' }

  const lower = toolName.toLowerCase()
  const secret = input.secret ?? input.secret_name ?? (lower.includes('secret') ? input.name : undefined)
  if (typeof secret === 'string' && secret.trim()) return { kind: 'secret', value: secret, actor: 'agent' }

  // Unknown provider tools stay governable through command rules instead of bypassing policy.
  return { kind: 'command', value: toolName, actor: 'agent' }
}

// modes the board can switch a hired agent between; anything else stays bypass
export const PERMISSION_MODES = ['default', 'bypassPermissions', 'acceptEdits', 'plan'] as const
export type HiredPermissionMode = (typeof PERMISSION_MODES)[number]

// the SDK's effort ladder — a spawn param, not switchable mid-session, so changing it
// means restart-with-resume (see setEffort)
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type EffortLevel = (typeof EFFORT_LEVELS)[number]

type PendingQuestion = {
  id: string
  header?: string
  question: string
  options: { label: string; description?: string }[]
  multiSelect: boolean
  isOther: boolean
}

type PendingPermission = {
  id: string
  tool: string
  summary: string
  title: string | null
  at: string
  approvalKind?: 'user-input'
  questions?: PendingQuestion[]
  finish: (allow: boolean, message?: string, answers?: Record<string, string[]>) => void
}

// AskUserQuestion asks the operator, not for permission — surface its questions as a
// form the board can answer instead of a bare allow/deny on the raw tool input.
export function askUserQuestions(toolInput: Record<string, unknown>): PendingQuestion[] | null {
  const raw = toolInput.questions
  if (!Array.isArray(raw) || raw.length === 0) return null
  const questions: PendingQuestion[] = []
  for (const [index, entry] of raw.entries()) {
    if (!entry || typeof entry !== 'object') return null
    const q = entry as Record<string, unknown>
    if (typeof q.question !== 'string' || !q.question.trim()) return null
    const options = Array.isArray(q.options)
      ? q.options.flatMap((option) => {
          const o = option as Record<string, unknown>
          return o && typeof o.label === 'string' && o.label.trim()
            ? [{ label: o.label, ...(typeof o.description === 'string' ? { description: o.description } : {}) }]
            : []
        })
      : []
    questions.push({
      id: String(index),
      ...(typeof q.header === 'string' && q.header ? { header: q.header } : {}),
      question: q.question,
      options,
      multiSelect: q.multiSelect === true,
      isOther: true,
    })
  }
  return questions
}

// AskUserQuestion answers travel as updatedInput.answers keyed by question text —
// the same shape the interactive permission component produces.
export function askUserQuestionInput(
  toolInput: Record<string, unknown>,
  questions: PendingQuestion[],
  answers: Record<string, string[]>,
): Record<string, unknown> {
  return {
    ...toolInput,
    answers: Object.fromEntries(questions.flatMap((question) => {
      const chosen = (answers[question.id] ?? [])
        .filter((answer) => answer.trim()).join(', ')
      return chosen ? [[question.question, chosen]] : []
    })),
  }
}

const transcriptSig = (lines: TranscriptLine[]): string => {
  const tail = lines[lines.length - 1]
  return tail ? `${lines.length}:${tail.at}:${tail.text.slice(0, 80)}` : ''
}

/** Drawer history persisted across daemon restarts — best-effort, capped at 500 lines. */
export function loadStoredTranscript(db: Database.Database, agentId: number): TranscriptLine[] {
  try {
    const row = db.prepare('SELECT lines FROM agent_transcripts WHERE agent_id=?')
      .get(agentId) as { lines: string } | undefined
    if (!row) return []
    const parsed = JSON.parse(row.lines) as unknown
    return Array.isArray(parsed)
      ? parsed.filter((line): line is TranscriptLine => Boolean(line
          && typeof (line as TranscriptLine).text === 'string'
          && typeof (line as TranscriptLine).kind === 'string'))
      : []
  } catch { return [] }
}

/** Kind of work the live turn is doing — drives which indicator the chat animates. */
export type TurnKind = 'work' | 'compact'

/** `/compact` (with or without custom instructions) is the SDK's context-compaction command. */
export function compactCommandPrompt(text: string): boolean {
  return /^\s*\/compact(?:\s|$)/i.test(text)
}

type Hired = {
  agentId: number
  boardId: number
  name: string
  cwd: string
  push: (text: string, excludeMessageId?: number) => void
  end: () => void
  interrupt: () => Promise<void>
  // live SDK handle — shared control surface (setPermissionMode here, setModel for #41); never serialize it
  query: any
  permissionMode: HiredPermissionMode
  pending: Map<string, PendingPermission>
  // this session's slash commands, kept fresh by init + commands_changed (REPLACE semantics)
  commands: { name: string; description: string }[]
  transcript: TranscriptLine[]
  // signature of the last flushed transcript state (length + tail line), so the
  // 3s flusher only writes agent_transcripts rows that actually changed
  persistedSig: string
  turnStart: number | null
  // what the running turn is doing, when it is not ordinary work — /compact spends the
  // whole turn summarizing, so the terminal shows a compaction indicator instead of "Working…"
  turnKind: TurnKind
  turnTokens: number
  sessionTokens: number
  // true token split from the API's own usage reports — turn accrues live from assistant
  // messages, session sums authoritative per-turn totals (result usage when present)
  turnUsage: UsageSplit
  sessionUsage: UsageSplit
  sessionCostUsd: number
  model: string | null
  effort: EffortLevel | null
  models: any[]
  role?: 'strategist' | 'auditor' | 'verifier'
  // an effort restart supersedes this session — its exit must leave cards/queue untouched
  handoff: boolean
  // the session died on a spent usage window — resumable, so the exit path parks
  // (paused_limit + blocked ticket) instead of pruning
  limitHit: boolean
  ephemeral: boolean
  subs: Map<string, string>
  // launched-on-ticket agents carry their card through to review/blocked on exit
  cardId: number | null
  // card auto-created from the operator's ask (#143) — resolved at turn end: kept
  // when the turn did file work or the agent touched the card, deleted otherwise
  autoCardId: number | null
  // file-editing tool uses this turn, counted from the stream (canUseTool is
  // bypassed under bypassPermissions, so the transcript is the reliable signal)
  turnEdits: number
  // the card worktree's branch, when autoship launched this agent isolated (#59)
  branch: string | null
  outcome: 'success' | 'error' | null
  reason: string
  summary: string
}

// wakeAgentId marks a queued wake of a limit-paused agent: when a slot frees, the queue
// resumes that agent's saved session instead of minting a fresh one
type LaunchRequest = {
  boardId: number
  cardId: number
  cwd: string
  brief: string
  wakeAgentId?: number
  provider?: string
  model?: string
  effort?: string
  permissionMode?: string
  accessProfile?: string
}

export type ConductorOptions = {
  nativeEventSink?: ClaudeNativeEventSink
}

const MODEL_CATALOG_TIMEOUT_MS = 2_500

async function supportedModelsWithTimeout(queryHandle: any): Promise<unknown> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.resolve(queryHandle.supportedModels()),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('provider model catalog timed out')), MODEL_CATALOG_TIMEOUT_MS)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

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
- Finish each request with a one-line summary of what you added, then stop and wait.${outputDiscipline()}`

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
Be skeptical and precise: a thin idea deserves interrogation of the codebase, not a thin ticket. Do not brainstorm new ideas, do not create milestones, do not take tickets.${outputDiscipline()}`

const verifierRules = (me: string) => `You are "${me}", a one-shot delivery verifier for the Orchestra board. Your single job: check ONE delivered card against its own acceptance criteria and report a per-criterion verdict. You NEVER modify files, never create cards, never approve, move, or ship anything — you only inspect and report.
How you work — in order:
1. CRITERIA: split the DONE WHEN section of the card description in your brief into individual criteria. No DONE WHEN → fall back to REQUIREMENTS. Neither → treat the OBJECTIVE as a single criterion.
2. EVIDENCE: inspect the actual delivered changes, not the claimed summary — use the shipped commit if your brief names one (git show <hash>), otherwise locate the delivery (recent merges matching the card, or the diffstat in your brief) and read the real code.
3. TEST: if package.json has a "test" script, run it and record the outcome; otherwise report tested:false. Never fix anything.
4. JUDGE each criterion: met true (evidence found), false (contradicted or absent), or "unverifiable" (cannot be established from the repo) — with one line of evidence each.
5. REPORT — REQUIRED, exactly once, using the curl command template in your brief. Overall verdict: pass = every criterion met; gaps = unmet/unverifiable criteria but the core objective is delivered; fail = core objective missing or the test suite is broken by the change.
Then stop; you will be released. Be skeptical: your entire value is the gap between what was claimed and what was delivered.${outputDiscipline()}`

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
  private completedAccounting = new Map<number, { usage: UsageSplit; costUsd: number }>()
  private launchQueue: LaunchRequest[] = []

  constructor(
    private db: Database.Database,
    private bus: EventEmitter,
    private readonly agentToken?: string,
    private readonly options: ConductorOptions = {},
  ) {
    // 8s, not 3s: each pass rewrites the whole 500-line blob for every agent whose
    // transcript moved, which during an active turn is every pass. Graceful shutdown
    // and handoff both flush explicitly, so only a SIGKILL loses the tail — and that
    // path already recovers from the provider's own session file.
    this.transcriptFlushTimer = setInterval(() => this.flushTranscripts(), 8_000)
    this.transcriptFlushTimer.unref()
  }

  private readonly transcriptFlushTimer: ReturnType<typeof setInterval>

  // Drawer history is memory-first; this flusher makes it survive daemon restarts.
  private flushTranscripts(): void {
    for (const h of this.hired.values()) {
      const sig = transcriptSig(h.transcript)
      if (sig === h.persistedSig || !h.transcript.length) continue
      try {
        this.db.prepare(`INSERT INTO agent_transcripts (agent_id, lines, updated_at)
          VALUES (?, ?, datetime('now'))
          ON CONFLICT(agent_id) DO UPDATE SET lines=excluded.lines, updated_at=excluded.updated_at`)
          .run(h.agentId, JSON.stringify(h.transcript.slice(-500)))
        h.persistedSig = sig
      } catch { /* history persistence is best-effort */ }
    }
  }

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

  async providerCatalog(): Promise<AgentProviderCatalog[]> {
    const live = [...this.hired.values()].find((h) => typeof h.query?.supportedModels === 'function')
    if (live) {
      try {
        const raw = await supportedModelsWithTimeout(live.query)
        const models = normalizeProviderModels(raw)
        if (models.length) {
          live.models = Array.isArray(raw) ? raw : []
          const cached = writeProviderModelCache(this.db, models)
          return [claudeProviderCatalog({
            available: true,
            models,
            source: 'live',
            updatedAt: cached?.updated_at ?? new Date().toISOString(),
          })]
        }
      } catch {
        // A provider discovery failure must not make Settings unusable; use the last known catalog below.
      }
    }

    const memoryModels = normalizeProviderModels([...this.hired.values()].flatMap((h) => h.models))
    const cached = readProviderModelCache(this.db) ?? (memoryModels.length
      ? writeProviderModelCache(this.db, memoryModels) : null)
    return [claudeProviderCatalog({
      available: true,
      models: cached?.models ?? [],
      source: cached ? 'cache' : 'unavailable',
      updatedAt: cached?.updated_at ?? null,
      detail: cached ? undefined : 'Start a Claude agent to discover the models available to this account.',
    })]
  }

  // Best-effort catalog refresh with no live agent: spawn a short-lived SDK query
  // against the preferred (newest) Claude CLI purely to read supportedModels(), so a
  // freshly-upgraded CLI surfaces new models at daemon boot instead of on next hire.
  // Never throws; a probe failure (unauthed, missing CLI, timeout) keeps the cache.
  async refreshModelCatalog(cwd: string = process.cwd()): Promise<boolean> {
    if ([...this.hired.values()].some((h) => typeof h.query?.supportedModels === 'function')) {
      return false // a live agent already keeps the catalog fresh on start
    }
    const claudeExecutable = resolvePreferredClaudeExecutableV1()
    const input = createInput()
    let probe: any = null
    try {
      probe = query({
        prompt: input.stream(),
        options: {
          cwd,
          ...(claudeExecutable ? { pathToClaudeCodeExecutable: claudeExecutable } : {}),
        } as any,
      })
      const raw = await supportedModelsWithTimeout(probe)
      const models = normalizeProviderModels(raw)
      if (models.length) {
        writeProviderModelCache(this.db, models)
        return true
      }
      return false
    } catch {
      return false
    } finally {
      try { input.end() } catch { /* stream already closed */ }
      try { await probe?.interrupt?.() } catch { /* already stopped */ }
    }
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
    const configured = process.env.ORCHESTRA_MAX_LAUNCHED
    if (configured === undefined || configured.trim() === '') return Number.POSITIVE_INFINITY
    const n = Number(configured)
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : Number.POSITIVE_INFINITY
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
    // a queued wake re-enters here when a slot frees — resume, don't mint a fresh agent
    if (req.wakeAgentId !== undefined) return { woken: this.wakeOne(req.wakeAgentId) === 'woken' }
    // autoship isolates each ticket in its own worktree+branch so the daemon can later
    // merge it test-gated; falling back to the shared checkout just disables auto-merge
    let cwd = req.cwd
    let branch: string | null = null
    if (autoshipEnabled()) {
      const name = `card-${req.cardId}`
      const wt = cardWorktree(req.cwd, req.cardId)
      try {
        if (!existsSync(wt)) {
          try { execFileSync('git', ['worktree', 'add', wt, '-b', name], { cwd: req.cwd, timeout: 30_000 }) }
          catch { execFileSync('git', ['worktree', 'add', wt, name], { cwd: req.cwd, timeout: 30_000 }) } // relaunch reuses the branch
        }
        cwd = wt
        branch = name
      } catch { /* not a git repo or worktree failed — shared checkout, no auto-merge */ }
    }
    const agent = this.hire({
      boardId: req.boardId,
      cwd,
      cardId: req.cardId,
      provider: req.provider,
      model: req.model,
      effort: req.effort,
      permissionMode: req.permissionMode,
      accessProfile: req.accessProfile,
    })
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

  // a usage-limit death is a nap, not an exit: keep sdk_session and card ownership so
  // wake() can resume the same conversation. No card pruning, no dead-letter bounce (the
  // agent is coming back — mail stays queued for the wake-time hire(), per the #61 seam),
  // and no queue drain (a spent window would just kill whatever launches next).
  private pauseForLimit(h: Hired): void {
    if (h.cardId !== null) {
      const card = this.cardRow(h.cardId)
      if (card && card.column !== 'done') {
        this.db.prepare(`UPDATE cards SET column_name='blocked', updated_at=datetime('now') WHERE id=?`).run(h.cardId)
        this.logCardEvent(h.cardId, h.agentId, 'limit_paused', { reason: 'usage-limit', agent: h.name })
        this.emit(h.boardId, 'card', this.cardRow(h.cardId))
        this.emit(h.boardId, 'launch', { card_id: h.cardId, agent_id: h.agentId, agent_name: h.name, status: 'paused', reason: 'usage-limit' })
      }
    }
    this.db.prepare(`UPDATE agents SET status='paused_limit' WHERE id=?`).run(h.agentId)
    this.emit(h.boardId, 'agent', this.db.prepare(`SELECT * FROM agents WHERE id=?`).get(h.agentId))
    this.emit(h.boardId, 'limit_pause', { agent_id: h.agentId, agent_name: h.name, card_id: h.cardId })
  }

  // resume one limit-paused agent through the ordinary hire() chokepoint (where the #61
  // mail seam re-delivers queued mail) — same session, same ticket, same identity
  private wakeOne(agentId: number): 'woken' | 'skipped' {
    if (this.hired.has(agentId)) return 'skipped' // already live — wake is idempotent
    const a = this.db.prepare(`
      SELECT a.*, b.project_path FROM agents a JOIN boards b ON b.id = a.board_id
      WHERE a.id=? AND a.status='paused_limit'
        AND (a.role IS NULL OR a.role NOT IN ('auditor','verifier'))`).get(agentId) as any
    if (!a) return 'skipped'
    const card = this.db.prepare(`
      SELECT c.id, c.branch FROM cards c
      JOIN card_events e ON e.card_id=c.id AND e.type='limit_paused' AND e.agent_id=?
      WHERE c.owner_agent_id=? AND c.column_name='blocked' ORDER BY c.id LIMIT 1`).get(agentId, agentId) as any
    // resume inside the ticket's autoship worktree while it still exists (#59);
    // a pruned worktree falls back to the shared checkout
    let cwd = a.project_path
    if (card?.branch) {
      const wt = cardWorktree(a.project_path, card.id)
      if (existsSync(wt)) cwd = wt
    }
    this.hire({
      boardId: a.board_id, cwd, name: a.name, role: a.role ?? undefined,
      resumeSession: a.sdk_session ?? undefined, permissionMode: a.permission_mode ?? undefined,
      model: a.model ?? undefined, effort: a.effort ?? undefined, cardId: card?.id,
    })
    const h = this.hired.get(agentId)
    if (!h) return 'skipped'
    if (card) {
      h.branch = card.branch ?? null
      this.db.prepare(`UPDATE cards SET column_name='in_progress', updated_at=datetime('now') WHERE id=?`).run(card.id)
      this.adoptLaunch(agentId)
      this.logCardEvent(card.id, agentId, 'limit_resumed', { agent: a.name })
      this.emit(a.board_id, 'card', this.cardRow(card.id))
    }
    h.push(`The Claude usage window that paused you has reset — your session is resumed with memory intact. Continue where you left off${card ? ` on card #${card.id}` : ''}.`)
    this.touch(agentId, 'active')
    return 'woken'
  }

  // wake every limit-paused agent on the board, oldest ticket first; ticket-carrying wakes
  // beyond maxLaunched ride the existing launch queue and start as live slots free up
  wake(boardId: number): { woke: string[]; queued: string[]; skipped: string[] } {
    const rows = this.db.prepare(`
      SELECT a.id, a.name, MIN(c.id) AS card_id FROM agents a
      LEFT JOIN card_events e ON e.agent_id=a.id AND e.type='limit_paused'
      LEFT JOIN cards c ON c.id=e.card_id AND c.owner_agent_id=a.id AND c.column_name='blocked'
      WHERE a.board_id=? AND a.kind='hired' AND a.status='paused_limit'
        AND (a.role IS NULL OR a.role NOT IN ('auditor','verifier'))
      GROUP BY a.id, a.name
      ORDER BY (MIN(c.id) IS NULL), MIN(c.id), a.id`).all(boardId) as any[]
    const woke: string[] = []; const queued: string[] = []; const skipped: string[] = []
    for (const r of rows) {
      if (this.hired.has(r.id)) { skipped.push(r.name); continue }
      if (r.card_id !== null && this.launchedCount() >= this.maxLaunched()) {
        if (!this.launchQueue.some((q) => q.cardId === r.card_id))
          this.launchQueue.push({ boardId, cardId: r.card_id, cwd: '', brief: '', wakeAgentId: r.id })
        queued.push(r.name)
        continue
      }
      if (this.wakeOne(r.id) === 'woken') woke.push(r.name); else skipped.push(r.name)
    }
    return { woke, queued, skipped }
  }

  hire(opts: { boardId: number; cwd: string; env?: Record<string, string | undefined>; name?: string; provider?: string; model?: string; role?: 'strategist' | 'auditor' | 'verifier'; ephemeral?: boolean; resumeSession?: string; permissionMode?: string; accessProfile?: string; effort?: string; cardId?: number; maxBudgetUsd?: number; taskBudgetTokens?: number; agentHome?: ClaudeAgentHomeBinding; restoreTranscript?: boolean }): any {
    if (opts.provider && opts.provider !== DEFAULT_AGENT_PROVIDER)
      throw new Error(`provider ${opts.provider} must be routed through ProviderAgentManager`)
    const providerEnvironment = prepareManagedSubscriptionEnvironmentV1(
      'claude',
      opts.env ?? process.env,
    )
    // re-hiring an already-live name returns the existing session instead of leaking a new one
    if (opts.name) {
      const existing = [...this.hired.values()].find((h) => h.boardId === opts.boardId && h.name === opts.name)
      if (existing) return this.db.prepare(`SELECT * FROM agents WHERE id=?`).get(existing.agentId)
    }
    // Defaults only seed fresh sessions. Resume, wake, and effort-handoff paths carry their
    // persisted configuration explicitly and must not change when an operator edits settings.
    const profile = opts.resumeSession || opts.provider ? null : defaultsForRole(this.db, opts.role)
    if (profile && profile.provider !== DEFAULT_AGENT_PROVIDER)
      throw new Error(`provider ${profile.provider} must be routed through ProviderAgentManager`)
    const model = opts.model ?? profile?.model ?? undefined
    const cachedModels = readProviderModelCache(this.db)?.models ?? []
    const requestedEffort = opts.effort ?? profile?.effort ?? undefined
    const effort: EffortLevel | null = EFFORT_LEVELS.includes(requestedEffort as EffortLevel)
      ? requestedEffort as EffortLevel : null
    let permissionMode: HiredPermissionMode = PERMISSION_MODES.includes(opts.permissionMode as HiredPermissionMode)
      ? opts.permissionMode as HiredPermissionMode : 'bypassPermissions'
    let name = opts.name
    if (!name) {
      do { name = generateName() } while (
        this.db.prepare(`SELECT 1 FROM agents WHERE board_id=? AND name=?`).get(opts.boardId, name))
    }
    // The mastermind designs teams and nothing else (#154). bypassPermissions skips
    // canUseTool entirely, so its scope guard only binds in an asking mode — the guard
    // then answers every request itself, so this costs the operator no approval prompts.
    const teamsScoped = isMastermindName(name)
    if (teamsScoped && permissionMode === 'bypassPermissions') permissionMode = 'default'
    const bootstrap = issueManagedAgentLaunchBootstrap()
    this.db.prepare(`
      INSERT INTO agents (
        board_id, name, session_id, status, kind, role, provider, sdk_session,
        external_session_id, hook_token_hash
      ) VALUES (?, ?, ?, 'idle', 'hired', ?, 'claude', ?, ?, ?)
      ON CONFLICT(board_id, name) DO UPDATE SET status='idle', last_seen=datetime('now'),
        session_id=excluded.session_id, kind='hired', role=excluded.role, provider='claude',
        sdk_session=excluded.sdk_session, external_session_id=excluded.external_session_id,
        provider_state_json='{}', hook_token_hash=excluded.hook_token_hash
    `).run(
      opts.boardId,
      name,
      `hired:${Date.now()}`,
      opts.role ?? null,
      opts.resumeSession ?? null,
      opts.resumeSession ?? null,
      bootstrap.hash,
    )
    const agent = this.db.prepare(`SELECT * FROM agents WHERE board_id=? AND name=?`).get(opts.boardId, name) as any

    const capture = (
      event: Omit<ClaudeNativeEvent, 'agentId' | 'agentName' | 'agentHome' | 'resumed'>,
    ): void => {
      this.options.nativeEventSink?.append({
        ...event,
        agentId: Number(agent.id),
        agentName: String(name),
        ...(opts.agentHome ? { agentHome: opts.agentHome } : {}),
        resumed: !!opts.resumeSession,
      })
    }
    try {
      capture({
        captureId: randomUUID(),
        kind: 'session_start',
        direction: 'lifecycle',
        at: new Date().toISOString(),
        providerSessionId: opts.resumeSession ?? null,
        payload: {
          resume_requested: !!opts.resumeSession,
          model: model ?? null,
          effort,
          permission_mode: permissionMode,
          access_profile: opts.accessProfile ?? null,
          provider_environment: providerEnvironment.toJSON(),
        },
      })
    } catch (error) {
      this.db.prepare("UPDATE agents SET status='gone', last_seen=datetime('now') WHERE id=?").run(agent.id)
      throw error
    }

    const input = createInput()
    const transcript: TranscriptLine[] = []
    // a resumed session keeps its drawer history across daemon restarts; the
    // setEffort internal restart carries its own lines and opts out. The SDK's
    // own session file is the deeper source when the daemon store is behind.
    if (opts.resumeSession && opts.restoreTranscript !== false) {
      const stored = loadStoredTranscript(this.db, agent.id)
      const sdk = loadSdkSessionTranscript(opts.cwd, opts.resumeSession)
      const restored = sdk.length > stored.length ? sdk : stored
      if (restored.length) {
        transcript.push(...restored.slice(-500))
        transcript.push({ at: new Date().toISOString(), kind: 'status', text: 'conversation restored after daemon restart' })
      }
    }
    const log = (kind: TranscriptLine['kind'], text: string) => {
      transcript.push({ at: new Date().toISOString(), kind, text })
      if (transcript.length > 500) transcript.shift()
      this.emit(opts.boardId, 'transcript', { agent_id: agent.id })
    }

    const accessProfile = opts.accessProfile ?? (permissionMode === 'plan' ? 'read_only'
      : permissionMode === 'bypassPermissions' ? 'full_access' : 'workspace_write')
    this.db.prepare("UPDATE agents SET provider='claude', permission_mode=?, access_profile=?, model=?, effort=? WHERE id=?")
      .run(permissionMode, accessProfile, model ?? null, effort, agent.id)
    const pending = new Map<string, PendingPermission>()
    // non-bypass modes deny tools unless a canUseTool handler answers — park each ask as a
    // pending request the board resolves via approve/deny buttons in the terminal
    const canUseTool = (toolName: string, toolInput: Record<string, unknown>, o: any): Promise<any> => {
      const id = String(o?.toolUseID ?? o?.requestId ?? `${Date.now()}-${pending.size}`)
      // teams-only scope: decided here so it cannot be waived by policy or by the operator
      const scope = teamsScoped ? mastermindToolDecision(toolName, toolInput) : null
      if (scope) {
        log('status', scope.allow ? `scope allowed: ${toolSummary(toolName, toolInput)}` : `scope denied: ${scope.message}`)
        return Promise.resolve(scope.allow
          ? { behavior: 'allow', updatedInput: toolInput }
          : { behavior: 'deny', message: scope.message })
      }
      const questions = toolName === 'AskUserQuestion' ? askUserQuestions(toolInput) : null
      const summary = questions
        ? questions.map((question) => question.question).join(' · ')
        : toolSummary(toolName, toolInput)
      const requestId = typeof o?.requestId === 'string' ? o.requestId : id
      const toolUseId = typeof o?.toolUseID === 'string' ? o.toolUseID : null
      const providerSessionId = (this.db.prepare('SELECT sdk_session FROM agents WHERE id=?')
        .get(agent.id) as { sdk_session: string | null } | undefined)?.sdk_session ?? opts.resumeSession ?? null
      capture({
        captureId: `approval:${requestId}:request`,
        kind: 'approval_request',
        direction: 'inbound',
        at: new Date().toISOString(),
        providerSessionId,
        payload: {
          request_id: requestId,
          tool_use_id: toolUseId,
          tool_name: toolName,
          input: toolInput,
          title: o?.title ?? null,
          display_name: o?.displayName ?? null,
          description: o?.description ?? null,
          blocked_path: o?.blockedPath ?? null,
          decision_reason: o?.decisionReason ?? null,
          agent_id: o?.agentID ?? null,
        },
      })
      const captureDecision = (allow: boolean, source: string, message?: string): void => {
        capture({
          captureId: `approval:${requestId}:response`,
          kind: 'approval_response',
          direction: 'outbound',
          at: new Date().toISOString(),
          providerSessionId,
          payload: {
            request_id: requestId,
            tool_use_id: toolUseId,
            tool_name: toolName,
            behavior: allow ? 'allow' : 'deny',
            source,
            message: message ?? null,
          },
        })
      }
      const linkedCardId = opts.cardId ?? (this.db.prepare(`SELECT id FROM cards
        WHERE owner_agent_id=? AND column_name IN ('in_progress','blocked','review') ORDER BY updated_at DESC, id DESC LIMIT 1`)
        .get(agent.id) as { id: number } | undefined)?.id
      const policy = linkedCardId ? this.db.prepare(`SELECT j.policy_id AS job_policy_id,
          j.contract_version, tc.policy_id AS contract_policy_id
        FROM task_contracts tc LEFT JOIN jobs j ON j.id=(
          SELECT id FROM jobs WHERE card_id=tc.card_id AND status IN ('running','cancelling')
          ORDER BY started_at DESC, rowid DESC LIMIT 1
        ) WHERE tc.card_id=?`).get(linkedCardId) as {
          job_policy_id: string | null
          contract_version: number | null
          contract_policy_id: string | null
        } | undefined : undefined
      const policyId = policy?.contract_version == null ? policy?.contract_policy_id : policy.job_policy_id
      if (policyId) {
        try {
          const evaluation = evaluatePolicy(this.db, policyId, policyOperationForTool(toolName, toolInput, opts.cwd))
          log('status', `policy ${evaluation.decision}: ${summary} — ${evaluation.reason}`)
          this.emit(opts.boardId, 'policy', {
            agent_id: agent.id,
            card_id: linkedCardId ?? null,
            request_id: id,
            tool: toolName,
            ...evaluation,
          })
          if (evaluation.decision === 'allow') {
            captureDecision(true, 'policy', evaluation.reason)
            return Promise.resolve({ behavior: 'allow', updatedInput: toolInput })
          }
          if (evaluation.decision === 'deny') {
            captureDecision(false, 'policy', evaluation.reason)
            return Promise.resolve({ behavior: 'deny', message: evaluation.reason })
          }
        } catch (error) {
          // A malformed or missing policy never silently opens access; the ordinary human ask is the fallback.
          log('status', `policy evaluation needs review: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      log('status', questions
        ? `input requested: ${summary}`
        : `permission requested: ${o?.title ?? summary}`)
      this.emit(opts.boardId, 'permission', { agent_id: agent.id, request_id: id, tool: toolName, summary, title: o?.title ?? null, status: 'pending' })
      return new Promise((resolve) => {
        pending.set(id, {
          id, tool: toolName, summary, title: o?.title ?? null, at: new Date().toISOString(),
          ...(questions ? { approvalKind: 'user-input' as const, questions } : {}),
          finish: (allow, message, answers) => {
            let effectiveAllow = allow
            let effectiveMessage = message
            try {
              captureDecision(allow, 'operator', message)
            } catch (error) {
              effectiveAllow = false
              effectiveMessage = `permission denied because durable capture failed: ${
                error instanceof Error ? error.message : String(error)
              }`
            }
            pending.delete(id)
            log('status', `permission ${effectiveAllow ? 'allowed' : 'denied'}: ${summary}`)
            this.emit(opts.boardId, 'permission', {
              agent_id: agent.id,
              request_id: id,
              status: effectiveAllow ? 'allowed' : 'denied',
            })
            const answered = effectiveAllow && questions && answers
              ? askUserQuestionInput(toolInput, questions, answers)
              : toolInput
            resolve(effectiveAllow
              ? { behavior: 'allow', updatedInput: answered }
              : { behavior: 'deny', message: effectiveMessage || 'denied from the board' })
          },
        })
        // an interrupted turn withdraws its asks — fail closed, leave no orphan buttons
        o?.signal?.addEventListener?.('abort', () => {
          if (!pending.delete(id)) return
          try { captureDecision(false, 'abort', 'permission request aborted') } catch { /* capture sink marked the gap */ }
          this.emit(opts.boardId, 'permission', { agent_id: agent.id, request_id: id, status: 'withdrawn' })
          resolve({ behavior: 'deny', message: 'permission request aborted' })
        })
      })
    }

    // ORCHESTRA_NAME makes the in-session hooks re-register this same identity
    // instead of minting a second "session" agent for the SDK subprocess
    const env: Record<string, string | undefined> = {
      ...providerEnvironment.forSpawn(),
      ORCHESTRA_PORT: String(Number(process.env.ORCHESTRA_PORT ?? 4750)),
      ORCHESTRA_AGENT: name,
      ORCHESTRA_NAME: name,
      ORCHESTRA_MANAGED_AGENT: '1',
      ORCHESTRA_AGENT_ID: String(agent.id),
      ORCHESTRA_BOARD_ID: String(opts.boardId),
      [MANAGED_AGENT_BOOTSTRAP_ENV]: bootstrap.nonce,
      ...(opts.agentHome
        ? { [MANAGED_AGENT_HOME_SESSION_ENV]: opts.agentHome.agentHomeSessionId }
        : {}),
    }
    // A launch-bound nonce is the only pre-registration bearer available inside
    // the provider. Ambient daemon/operator credentials never cross this boundary.
    delete env.ORCHESTRA_AGENT_TOKEN
    delete env.ORCHESTRA_TOKEN
    // auditors author tickets meant to outlive them — without ORCHESTRA_AGENT the cli
    // cannot auto-claim ownership, so their cards are born unowned
    if (opts.role === 'auditor' || opts.role === 'verifier') delete env.ORCHESTRA_AGENT
    // prefer a newer PATH-installed Claude CLI over the SDK's bundled one, so the
    // model catalog (supportedModels) reflects the operator's current CLI
    const claudeExecutable = resolvePreferredClaudeExecutableV1()
    const q = query({
      prompt: input.stream(),
      options: {
        cwd: opts.cwd,
        ...(claudeExecutable ? { pathToClaudeCodeExecutable: claudeExecutable } : {}),
        ...(model ? { model } : {}),
        ...(opts.resumeSession ? { resume: opts.resumeSession } : {}),
        ...(effort ? { effort } : {}),
        permissionMode,
        canUseTool,
        ...(opts.maxBudgetUsd !== undefined ? { maxBudgetUsd: opts.maxBudgetUsd } : {}),
        ...(opts.taskBudgetTokens !== undefined ? { taskBudget: { total: opts.taskBudgetTokens } } : {}),
        systemPrompt: { type: 'preset', preset: 'claude_code', append: (teamsScoped ? mastermindRules : opts.role === 'strategist' ? strategistRules : opts.role === 'auditor' ? auditorRules : opts.role === 'verifier' ? verifierRules : rules)(name) },
        env,
      } as any,
    })

    const hired: Hired = {
      agentId: agent.id, boardId: opts.boardId, name, cwd: opts.cwd,
      push: (text: string, excludeMessageId?: number) => {
        // SDK slash commands are recognized only when `/command` begins the user message.
        // Keep queued notifications for the next ordinary prompt instead of prefixing them
        // and silently turning a supported command into plain text.
        const notifications = /^\s*\//.test(text) ? [] : this.pendingNotifications(agent.id, excludeMessageId)
        const noticeText = notifications.map((m) =>
          `orchestra notification #${m.id} from ${m.from_name ?? 'human'}: "${m.body}" — no reply required.`).join('\n')
        const payload = noticeText ? `${noticeText}\n\n${text}` : text
        const providerSessionId = (this.db.prepare('SELECT sdk_session FROM agents WHERE id=?')
          .get(agent.id) as { sdk_session: string | null } | undefined)?.sdk_session ?? opts.resumeSession ?? null
        capture({
          captureId: randomUUID(),
          kind: 'outbound_user',
          direction: 'outbound',
          at: new Date().toISOString(),
          providerSessionId,
          payload: {
            text: payload,
            source: 'orchestra',
            notification_ids: notifications.map((message) => Number(message.id)),
          },
        })
        log('user', payload)
        if (hired.turnStart === null) { hired.turnStart = Date.now(); hired.turnTokens = 0 }
        // a compaction turn produces no assistant text — without this the drawer would just
        // sit on "Working…" for the whole summarization
        if (compactCommandPrompt(payload)) hired.turnKind = 'compact'
        input.push(payload)
        if (notifications.length) this.markNotifications(agent.id, notifications.map((m) => m.id))
      },
      end: input.end,
      interrupt: async () => { try { await (q as any).interrupt() } catch { /* already stopped */ } },
      query: q,
      permissionMode,
      pending,
      commands: [],
      transcript,
      persistedSig: transcriptSig(transcript),
      turnStart: null, turnKind: 'work', turnTokens: 0, sessionTokens: 0, turnUsage: emptyUsage(), sessionUsage: emptyUsage(), sessionCostUsd: 0,
      model: model ?? null, ephemeral: opts.ephemeral ?? false, subs: new Map(),
      effort, models: cachedModels, role: opts.role, handoff: false, limitHit: false,
      cardId: opts.cardId ?? null, branch: null, outcome: null, reason: '', summary: '',
      autoCardId: null, turnEdits: 0,
    }
    this.hired.set(agent.id, hired)
    // every (re-)registration — fresh hire, effort-restart handoff, daemon resurrection, wake —
    // drains mail that arrived while no live session could hear it (gone ⇒ bounce, alive ⇒ deliver)
    this.deliverPending(agent.id)
    log('status', opts.resumeSession ? `resumed in ${opts.cwd} (previous session continues)` : `hired in ${opts.cwd}`)

    void (async () => {
      try {
        for await (const m of q as AsyncIterable<any>) {
          const providerSessionId = typeof m?.session_id === 'string'
            ? m.session_id
            : (this.db.prepare('SELECT sdk_session FROM agents WHERE id=?')
                .get(agent.id) as { sdk_session: string | null } | undefined)?.sdk_session
              ?? opts.resumeSession
              ?? null
          capture({
            captureId: typeof m?.uuid === 'string' && m.uuid ? m.uuid : randomUUID(),
            kind: 'provider_message',
            direction: 'inbound',
            at: new Date().toISOString(),
            providerSessionId,
            payload: m,
          })
          if (m.type === 'system' && m.subtype === 'init') {
            hired.model = m.model ?? null
            // remember the sdk session so a daemon restart can resume this agent with its memory intact
            if (m.session_id) this.db.prepare(`UPDATE agents SET sdk_session=?, external_session_id=? WHERE id=?`)
              .run(m.session_id, m.session_id, agent.id)
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
            void Promise.resolve((q as any).supportedModels?.()).then((ms) => {
              hired.models = Array.isArray(ms) ? ms : []
              writeProviderModelCache(this.db, ms)
            }).catch(() => {})
            log('status', `session started · ${m.model ?? ''} · ${opts.cwd}`)
          } else if (m.type === 'system' && m.subtype === 'commands_changed') {
            // mid-session push (e.g. skills discovered while working) — REPLACE the cached list
            hired.commands = (m.commands ?? []).map((c: any) => ({ name: c.name, description: c.description ?? '' }))
          } else if (m.type === 'system' && m.subtype === 'compact_boundary') {
            // the SDK reports the boundary once the summary has replaced the context — this is
            // the only visible trace a compaction leaves, for /compact and for auto-compaction
            const meta = m.compact_metadata ?? {}
            const pre = Number(meta.pre_tokens)
            const detail = Number.isFinite(pre) && pre > 0
              ? ` · ${pre >= 1000 ? `${(pre / 1000).toFixed(1)}k` : pre} tokens summarized`
              : ''
            log('status', `✻ Context compacted (${meta.trigger === 'auto' ? 'automatic' : 'manual'})${detail}`)
            hired.turnKind = 'work'
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
                if (EDIT_TOOLS.has(b.name)) hired.turnEdits++
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
            if (Number.isFinite(Number(m.total_cost_usd)) && Number(m.total_cost_usd) > 0) {
              hired.sessionCostUsd += Number(m.total_cost_usd)
            }
            hired.turnUsage = emptyUsage()
            hired.turnStart = null
            hired.turnKind = 'work'
            hired.turnTokens = 0
            hired.subs.clear()
            this.touch(agent.id, 'idle')
            // a clean turn resolves the ask's auto-card; an errored/limit-hit turn
            // keeps it — the work was interrupted, not answered
            this.resolveAutoCard(hired, m.subtype === 'success')
            hired.turnEdits = 0
            // a spent usage window ends the turn with limit text — flag it so the exit
            // path parks the session (paused_limit) instead of pruning it, and stop
            // sessions that would otherwise idle forever against a dead window
            if (m.subtype !== 'success' &&
                isUsageLimitError(`${m.subtype ?? ''} ${typeof m.result === 'string' ? m.result : ''}`)) {
              hired.limitHit = true
              if (hired.cardId === null && !hired.ephemeral) void this.fire(agent.id)
            }
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
        try {
          capture({
            captureId: randomUUID(),
            kind: 'error',
            direction: 'inbound',
            at: new Date().toISOString(),
            providerSessionId: (this.db.prepare('SELECT sdk_session FROM agents WHERE id=?')
              .get(agent.id) as { sdk_session: string | null } | undefined)?.sdk_session ?? opts.resumeSession ?? null,
            payload: {
              name: typeof e?.name === 'string' ? e.name : 'Error',
              message: String(e?.message ?? e),
            },
          })
        } catch { /* the native sink already marked the durable capture gap */ }
        log('error', String(e?.message ?? e))
        if (isUsageLimitError(String(e?.message ?? e))) hired.limitHit = true
        if (hired.cardId !== null && hired.outcome === null) {
          hired.outcome = 'error'
          hired.reason = String(e?.message ?? e)
        }
      } finally {
        try {
          capture({
            captureId: randomUUID(),
            kind: 'session_end',
            direction: 'lifecycle',
            at: new Date().toISOString(),
            providerSessionId: (this.db.prepare('SELECT sdk_session FROM agents WHERE id=?')
              .get(agent.id) as { sdk_session: string | null } | undefined)?.sdk_session ?? opts.resumeSession ?? null,
            payload: {
              handoff: hired.handoff,
              limit_hit: hired.limitHit,
              outcome: hired.outcome,
              reason: hired.reason || null,
            },
          })
        } catch { /* the native sink already marked the durable capture gap */ }
        // a session that dies mid-turn (error, fire, effort handoff) still consumed real
        // tokens — flush the in-flight accrual so the daily rollup never undercounts
        if (hasUsage(hired.turnUsage)) {
          recordUsage(this.db, opts.boardId, agent.id, hired.turnUsage)
          addUsage(hired.sessionUsage, hired.turnUsage)
          hired.turnUsage = emptyUsage()
        }
        hired.pending.clear()
        this.completedAccounting.delete(agent.id)
        this.completedAccounting.set(agent.id, { usage: { ...hired.sessionUsage }, costUsd: hired.sessionCostUsd })
        while (this.completedAccounting.size > 200) this.completedAccounting.delete(this.completedAccounting.keys().next().value!)
        this.hired.delete(agent.id)
        // an effort restart supersedes this session: the replacement re-registers the same
        // agent row and inherits the ticket, so the exit path must not park, prune, or drain —
        // and its mail is still deliverable, so it must not bounce either (gone ⇒ bounce, alive ⇒ deliver)
        if (!hired.handoff) {
          // one-shot roles stay dead on limit death (a resumed verifier could post a
          // stale newest-wins verdict into the ship gate) — #52's staleness cutoff covers them
          if (hired.limitHit && !hired.ephemeral && hired.role !== 'auditor' && hired.role !== 'verifier') {
            this.pauseForLimit(hired)
          } else {
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
      }
    })()

    return agent
  }

  // catch-up: undelivered mail for an agent that just (re-)registered — a message posted during
  // an effort-restart swap gap or daemon downtime is never in any instant-delivery target set and
  // would strand silently (alive agents aren't dead_letters). Mail already dead-lettered while the
  // agent was gone (has a system bounce reply) stays quiet — the sender was told it went nowhere.
  // Notifications deliberately stay queued until some other prompt creates a natural turn.
  private deliverPending(agentId: number): void {
    const pending = this.db.prepare(`
      SELECT m.*, fa.name AS from_name FROM messages m
      LEFT JOIN agents fa ON fa.id = m.from_agent_id
      WHERE m.to_agent_id=? AND m.delivered_at IS NULL AND m.kind IN ('ask', 'reply', 'task')
        AND NOT EXISTS (SELECT 1 FROM messages r WHERE r.reply_to = m.id AND r.from_agent_id IS NULL)
      ORDER BY m.id`).all(agentId) as any[]
    const stampDelivery = this.db.prepare(`INSERT OR IGNORE INTO deliveries (message_id, agent_id) VALUES (?, ?)`)
    const stampMessage = this.db.prepare(`UPDATE messages SET delivered_at=coalesce(delivered_at, datetime('now')) WHERE id=?`)
    for (const m of pending) {
      if (!this.deliver(agentId, m)) return
      stampDelivery.run(m.id, agentId)
      stampMessage.run(m.id)
    }
  }

  private pendingNotifications(agentId: number, excludeMessageId?: number): any[] {
    return this.db.prepare(`
      SELECT m.*, fa.name AS from_name FROM messages m
      LEFT JOIN agents fa ON fa.id=m.from_agent_id
      WHERE m.to_agent_id=? AND m.kind='notify' AND m.delivered_at IS NULL
        AND (? IS NULL OR m.id != ?)
      ORDER BY m.id`).all(agentId, excludeMessageId ?? null, excludeMessageId ?? null) as any[]
  }

  private markNotifications(agentId: number, messageIds: number[]): void {
    const mark = this.db.prepare(`INSERT OR IGNORE INTO deliveries (message_id, agent_id) VALUES (?, ?)`)
    const stamp = this.db.prepare(`UPDATE messages SET delivered_at=coalesce(delivered_at, datetime('now')) WHERE id=?`)
    this.db.transaction(() => messageIds.forEach((id) => { mark.run(id, agentId); stamp.run(id) }))()
  }

  // an operator ask auto-creates a card so the board shows what the agent is on (#143).
  // Skipped for slash commands, launched/ephemeral/role agents, and agents that already
  // own an in_progress card (follow-ups refine current work, they don't fork trackers).
  private maybeAutoCard(h: Hired, body: string): number | null {
    if (h.cardId !== null || h.ephemeral || h.role) return null
    if (h.autoCardId !== null || /^\s*\//.test(body)) return null
    const condensed = body.replace(/\s+/g, ' ').trim()
    if (!condensed) return null
    const active = this.db.prepare(
      `SELECT id FROM cards WHERE owner_agent_id=? AND column_name='in_progress' LIMIT 1`).get(h.agentId)
    if (active) return null
    const title = condensed.length > 80 ? `${condensed.slice(0, 79)}…` : condensed
    const { lastInsertRowid } = this.db.prepare(`
      INSERT INTO cards (board_id, title, description, column_name, owner_agent_id, paths)
      VALUES (?, ?, ?, 'in_progress', ?, '[]')`)
      .run(h.boardId, title, `Auto-created from an operator ask:\n\n${body}`, h.agentId)
    const cardId = Number(lastInsertRowid)
    this.db.prepare(`INSERT INTO card_events (card_id, agent_id, type, payload) VALUES (?, ?, 'created', ?)`)
      .run(cardId, h.agentId, JSON.stringify({ title, auto: true }))
    const card = this.db.prepare(
      `SELECT c.*, a.name AS owner FROM cards c LEFT JOIN agents a ON a.id=c.owner_agent_id WHERE c.id=?`)
      .get(cardId) as any
    if (card) this.emit(h.boardId, 'card', { ...card, column: card.column_name, paths: JSON.parse(card.paths) })
    h.autoCardId = cardId
    return cardId
  }

  // turn end: keep the auto-card when the turn did file work or the agent engaged with
  // the card (moved it, set paths — anything beyond the 'created' event); otherwise the
  // ask was just a question, so the tracker is deleted outright — it never enters review
  private resolveAutoCard(h: Hired, cleanTurn: boolean): void {
    const cardId = h.autoCardId
    if (cardId === null) return
    h.autoCardId = null
    if (!cleanTurn || h.turnEdits > 0) return
    const card = this.db.prepare(`SELECT * FROM cards WHERE id=?`).get(cardId) as any
    if (!card || card.column_name !== 'in_progress' || card.owner_agent_id !== h.agentId) return
    const events = this.db.prepare(`SELECT COUNT(*) AS c FROM card_events WHERE card_id=?`).get(cardId) as any
    if (Number(events?.c ?? 0) > 1) return
    this.db.prepare(`DELETE FROM card_events WHERE card_id=?`).run(cardId)
    this.db.prepare(`UPDATE messages SET card_id=NULL WHERE card_id=?`).run(cardId)
    this.db.prepare(`DELETE FROM cards WHERE id=?`).run(cardId)
    this.emit(h.boardId, 'card', { deleted: cardId })
  }

  private autoCardNote(cardId: number, name: string): string {
    return `[board] card #${cardId} was auto-created to track this ask — keep it current (orchestra card update ${cardId} … --agent ${name}) and move it to review when the work ships; it is removed automatically if this turn ends with no file changes.`
  }

  // instant delivery — no hooks, straight into the agent's conversation
  deliver(agentId: number, msg: { id: number; body: string; kind?: string; from_name?: string | null; reply_to?: number | null }): boolean {
    const h = this.hired.get(agentId)
    if (!h) return false
    let text: string
    if (msg.reply_to || msg.kind === 'reply') {
      text = `orchestra reply from ${msg.from_name ?? 'human'}: "${msg.body}" (answers your msg #${msg.reply_to}) — no response required unless a follow-up is materially needed.`
    } else if (msg.kind === 'task') {
      text = `orchestra task from ${msg.from_name ?? 'human'}: "${msg.body}" — act on it; do not send an acknowledgment-only reply.`
    } else if (msg.kind === 'notify') {
      text = `orchestra notification #${msg.id} from ${msg.from_name ?? 'human'}: "${msg.body}" — no reply required.`
    } else if (msg.kind === 'swarm') {
      text = `explicit orchestra swarm request from ${msg.from_name ?? 'human'}: "${msg.body}" — reply only with a substantive result using: orchestra reply ${msg.id} '<answer>' --from ${h.name}; never send an acknowledgment-only reply.`
    } else {
      text = `direct orchestra ask from ${msg.from_name ?? 'human'}: "${msg.body}" — reply required with: orchestra reply ${msg.id} '<answer>' --from ${h.name}; no acknowledgment-only reply.`
    }
    // operator-sent asks/tasks (from_name null) get a tracking card by default (#143)
    if (!msg.from_name && !msg.reply_to && (msg.kind === 'ask' || msg.kind === 'task' || !msg.kind)) {
      const cardId = this.maybeAutoCard(h, msg.body)
      if (cardId !== null) text = `${text}\n\n${this.autoCardNote(cardId, h.name)}`
    }
    h.push(text, msg.id)
    this.touch(agentId, 'active')
    return true
  }

  task(agentId: number, text: string): boolean {
    const h = this.hired.get(agentId)
    if (!h) return false
    const cardId = this.maybeAutoCard(h, text)
    h.push(cardId !== null ? `${text}\n\n${this.autoCardNote(cardId, h.name)}` : text)
    this.touch(agentId, 'active')
    return true
  }

  transcript(agentId: number): { lines: TranscriptLine[]; working: { secs: number; tokens: number; kind: TurnKind } | null; info?: { model: string | null; cwd: string; tokens: number; permissionMode: string; commands: { name: string; description: string }[]; effort: string | null; models: any[]; costUsd: number; usage: { turn: UsageSplit; session: UsageSplit } }; permissions?: Omit<PendingPermission, 'finish'>[] } {
    const h = this.hired.get(agentId)
    if (!h) return { lines: [], working: null }
    return {
      lines: h.transcript,
      working: h.turnStart
        ? { secs: Math.round((Date.now() - h.turnStart) / 1000), tokens: h.turnTokens, kind: h.turnKind }
        : null,
      info: { model: h.model, cwd: h.cwd, tokens: h.sessionTokens, permissionMode: h.permissionMode, commands: h.commands, effort: h.effort, models: h.models,
        costUsd: h.sessionCostUsd, usage: { turn: h.turnUsage, session: h.sessionUsage } },
      permissions: [...h.pending.values()].map(({ finish: _f, ...p }) => p),
    }
  }

  async mcpStatus(agentId: number): Promise<unknown | null> {
    const h = this.hired.get(agentId)
    if (!h) return null
    return h.query.mcpServerStatus()
  }

  async toggleMcpServer(agentId: number, name: string, enabled: boolean): Promise<unknown | null> {
    const h = this.hired.get(agentId)
    if (!h) return null
    await h.query.toggleMcpServer(name, enabled)
    return h.query.mcpServerStatus()
  }

  async reconnectMcpServer(agentId: number, name: string): Promise<unknown | null> {
    const h = this.hired.get(agentId)
    if (!h) return null
    await h.query.reconnectMcpServer(name)
    return h.query.mcpServerStatus()
  }

  async reloadPlugins(agentId: number): Promise<unknown | null> {
    const h = this.hired.get(agentId)
    if (!h) return null
    const result = await h.query.reloadPlugins()
    if (Array.isArray(result?.commands)) {
      h.commands = result.commands
        .filter((command: any) => typeof command?.name === 'string')
        .map((command: any) => ({ name: command.name, description: command.description ?? '' }))
      this.emit(h.boardId, 'transcript', { agent_id: agentId })
    }
    return result
  }

  sessionAccounting(agentId: number): { usage: UsageSplit; costUsd: number } | null {
    const active = this.hired.get(agentId)
    if (active) return { usage: { ...active.sessionUsage }, costUsd: active.sessionCostUsd }
    const completed = this.completedAccounting.get(agentId)
    return completed ? { usage: { ...completed.usage }, costUsd: completed.costUsd } : null
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
    const row = this.db.prepare(`SELECT sdk_session, model FROM agents WHERE id=?`).get(agentId) as any
    if (!row?.sdk_session) return 'no-session' // nothing to resume — a restart would drop the conversation

    const prior = { cardId: h.cardId, branch: h.branch, model: row.model ?? null, permissionMode: h.permissionMode, role: h.role, lines: [...h.transcript] }
    h.handoff = true
    await h.interrupt()
    h.end() // input stream closes → query ends → finally tears down without touching cards
    for (let i = 0; i < 250 && this.hired.has(agentId); i++) await new Promise((r) => setTimeout(r, 20))
    if (this.hired.has(agentId)) { h.handoff = false; return 'busy' } // teardown stuck; leave the session alone

    this.hire({
      boardId: h.boardId, cwd: h.cwd, name: h.name, role: prior.role,
      resumeSession: row.sdk_session, permissionMode: prior.permissionMode,
      model: prior.model ?? undefined, effort: level, cardId: prior.cardId ?? undefined,
      restoreTranscript: false, // prior.lines below carry the live history verbatim
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

  // keep the live session's board addressing in sync after an operator rename
  renameAgent(agentId: number, name: string): void {
    const h = this.hired.get(agentId)
    if (h) h.name = name
  }

  resolvePermission(agentId: number, requestId: string, behavior: 'allow' | 'deny', message?: string, answers?: Record<string, string[]>): boolean {
    const p = this.hired.get(agentId)?.pending.get(requestId)
    if (!p) return false
    p.finish(behavior === 'allow', message, answers)
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

  /** End local SDK streams while preserving provider sessions and board ownership for daemon resume. */
  async detachAll(): Promise<void> {
    this.flushTranscripts() // graceful restarts keep every last drawer line
    const active = [...this.hired.values()]
    await Promise.all(active.map(async (h) => {
      h.handoff = true
      await h.interrupt()
      h.end()
    }))
    for (let i = 0; i < 250 && this.hired.size > 0; i++)
      await new Promise((resolve) => setTimeout(resolve, 20))
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.hired.keys()].map((id) => this.fire(id)))
  }
}
