import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { api, Agent, Card, Thread } from './api'
import { BOARD_COMMANDS, isBoardCommand, runBoardCommand } from './boardCommands'
import { followIntent } from './follow'
import { ProviderBadge } from './ProviderBadge'
import {
  ACCESS_PROFILES,
  AccessProfile,
  hasAgentCapability,
  normalizeProvider,
  providerLabel,
  providerTokenSummary,
  ProviderTokenUsage,
  resolveAccessProfile,
} from './agentProviderUi'
import { AgentControlPanel } from './AgentControlPanel'
import {
  localConsoleCommand,
  normalizeSlashCommandName,
  panelForSlashCommand,
  panelForSlashInput,
  sessionModelValue,
  uniqueSlashCommands,
  type AgentControlPanelName,
} from './agentTerminalControls'
import './claudeTerminal.css'

type Line = { at?: string; kind: 'text' | 'status' | 'error' | 'user' | 'tool' | 'tool_result' | 'thinking'; text: string }

const fmtTokens = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)

const fmtSecs = (s: number) => s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`

const controlErrorText = (error: unknown): string => {
  const raw = error instanceof Error ? error.message : 'Provider control failed'
  try { return JSON.parse(raw).error ?? raw } catch { return raw }
}

type PendingQuestionOption = { label?: string; description?: string }
type PendingQuestion = {
  id: string
  header?: string
  question?: string
  options?: PendingQuestionOption[] | null
  isOther?: boolean
  isSecret?: boolean
  multiple?: boolean
  multiSelect?: boolean
  required?: boolean
  defaultAnswers?: string[]
  inputType?: 'text' | 'number' | 'email' | 'url' | 'date' | 'datetime-local'
  minimum?: number
  maximum?: number
  step?: number
}

// A provider approval or structured user-input request waiting in the terminal.
type PendingPermission = {
  id: string
  tool?: string
  summary: string
  title: string | null
  at: string
  approvalKind?: string
  questions?: PendingQuestion[]
  native?: { questions?: PendingQuestion[] }
  elicitationMode?: string | null
  serverName?: string | null
  url?: string | null
}

const questionsFor = (permission: PendingPermission): PendingQuestion[] =>
  permission.questions ?? permission.native?.questions ?? []

function UserInputApproval({ permission, onSubmit, onCancel }: {
  permission: PendingPermission
  onSubmit: (answers: Record<string, string[]>) => Promise<void>
  onCancel: () => Promise<void>
}) {
  const questions = questionsFor(permission)
  const [answers, setAnswers] = useState<Record<string, string[]>>(() => Object.fromEntries(
    questions.filter((question) => question.defaultAnswers?.length)
      .map((question) => [question.id, question.defaultAnswers!]),
  ))
  const [customAnswers, setCustomAnswers] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState(false)
  const ready = questions.length > 0 && questions.every((question) => question.required === false
    || (answers[question.id] ?? []).some((answer) => answer.trim()))
  const single = (id: string, value: string) => setAnswers((previous) => ({
    ...previous,
    [id]: value ? [value] : [],
  }))
  const toggle = (id: string, value: string, checked: boolean) => setAnswers((previous) => ({
    ...previous,
    [id]: checked
      ? [...(previous[id] ?? []).filter((answer) => answer !== value), value]
      : (previous[id] ?? []).filter((answer) => answer !== value),
  }))
  const choose = (id: string, value: string) => {
    const custom = value === '__orchestra_custom_answer__'
    setCustomAnswers((previous) => ({ ...previous, [id]: custom }))
    single(id, custom ? '' : value)
  }
  return (
    <div className="cc-user-input">
      {questions.map((question) => {
        const options = (question.options ?? []).filter((option) => option.label)
        const multiple = question.multiple === true || question.multiSelect === true
        return (
          <fieldset key={question.id} className="cc-user-input-question">
            <legend>{question.header ?? question.question ?? question.id}</legend>
            {question.header && question.question && <p>{question.question}</p>}
            {options.length > 0 && multiple ? options.map((option) => (
              <label key={option.label} className="cc-user-input-option">
                <input type="checkbox" checked={(answers[question.id] ?? []).includes(option.label!)}
                  onChange={(event) => toggle(question.id, option.label!, event.target.checked)} />
                <span><b>{option.label}</b>{option.description ? ` — ${option.description}` : ''}</span>
              </label>
            )) : options.length > 0 ? (
              <>
                <select value={customAnswers[question.id] ? '__orchestra_custom_answer__' : answers[question.id]?.[0] ?? ''}
                  onChange={(event) => choose(question.id, event.target.value)}>
                  <option value="">Choose…</option>
                  {options.map((option) => <option key={option.label} value={option.label}>{option.label}</option>)}
                  {question.isOther && <option value="__orchestra_custom_answer__">Other…</option>}
                </select>
                {customAnswers[question.id] && (
                  <input type={question.isSecret ? 'password' : 'text'} autoComplete="off"
                    aria-label={`${question.header ?? question.question ?? question.id} custom answer`}
                    value={answers[question.id]?.[0] ?? ''}
                    onChange={(event) => single(question.id, event.target.value)} />
                )}
              </>
            ) : question.isSecret ? (
              <input type="password" autoComplete="off"
                aria-label={question.header ?? question.question ?? question.id}
                value={answers[question.id]?.[0] ?? ''}
                onChange={(event) => single(question.id, event.target.value)} />
            ) : question.inputType && question.inputType !== 'text' ? (
              <input type={question.inputType} autoComplete="off"
                aria-label={question.header ?? question.question ?? question.id}
                min={question.minimum} max={question.maximum} step={question.step}
                value={answers[question.id]?.[0] ?? ''}
                onChange={(event) => single(question.id, event.target.value)} />
            ) : (
              <textarea rows={2} value={answers[question.id]?.[0] ?? ''}
                onChange={(event) => single(question.id, event.target.value)} />
            )}
          </fieldset>
        )
      })}
      <div className="cc-perm-actions">
        <button className="cc-perm-allow" disabled={!ready || busy} onClick={async () => {
          setBusy(true)
          try { await onSubmit(answers) } finally { setBusy(false) }
        }}>✓ submit answers</button>
        <button className="cc-perm-deny" disabled={busy} onClick={onCancel}>cancel</button>
      </div>
    </div>
  )
}

// a slash-menu entry; source 'sdk' = the session's real command list, anything else
// (e.g. 'orchestra' from card #44's extraCommands) renders a .cc-cmd-badge
export type CommandItem = { name: string; description: string; source: string }

const LOCAL_CONSOLE_COMMANDS: CommandItem[] = [
  { name: 'commands', description: 'show only the actions available in this console', source: 'orchestra' },
  { name: 'status', description: 'show this session’s model, access, and location', source: 'orchestra' },
  { name: 'usage', description: 'show token and cost accounting for this session', source: 'orchestra' },
  { name: 'clear', description: 'clear this console view without erasing session memory', source: 'orchestra' },
]

// Provider model catalogs may use the legacy Claude `model` key or the neutral `value` key.
type ModelInfo = {
  model?: string
  value?: string
  resolvedModel?: string
  displayName?: string
  description?: string
  supportsEffort?: boolean
  supportedEffortLevels?: string[]
}

type TranscriptInfo = {
  provider?: string
  capabilities?: string[]
  accessProfile?: string | null
  access_profile?: string | null
  model: string | null
  cwd: string
  tokens: number
  permissionMode?: string
  commands?: { name: string; description: string }[]
  effort?: string | null
  models?: ModelInfo[]
  costUsd?: number
  usage?: { turn: ProviderTokenUsage; session: ProviderTokenUsage }
}

function ModelEffortControls({ info, onOpen, canSelectModel, canSetEffort }: {
  info: { model: string | null; effort?: string | null; models?: ModelInfo[] } | null
  onOpen: () => void
  canSelectModel: boolean
  canSetEffort: boolean
}) {
  const models = info?.models ?? []
  if ((!canSelectModel && !canSetEffort) || (models.length === 0 && !info?.effort)) return null
  return (
    <button type="button" className="cc-effort-status" onClick={onOpen}
      aria-label={`Open model and effort picker. Current effort: ${info?.effort ?? 'default'}`}>
      Effort: {info?.effort ?? 'default'} <span className="cc-dim">· models</span>
    </button>
  )
}

function PermissionModeHint({ profile, onCycle }: {
  profile: AccessProfile
  onCycle: () => void
}) {
  const selected = ACCESS_PROFILES.find((candidate) => candidate.value === profile) ?? ACCESS_PROFILES[1]
  return (
    <button type="button" className={`cc-mode cc-mode-${profile}`} onClick={onCycle}
      title={`${selected.hint}. Shift+Tab to cycle.`}>
      Access: {selected.label} <span className="cc-dim">· Shift+Tab to change</span>
    </button>
  )
}
export function AgentTerminal({ agent, boardId, threads, cards = [], embedded = false, extraCommands = BOARD_COMMANDS, onClose, onChange }:
  { agent: Agent; boardId: number; threads: Thread[]; cards?: Card[]; embedded?: boolean; extraCommands?: CommandItem[]; onClose: () => void; onChange: () => void }) {
  const hired = agent.kind === 'hired'
  const [lines, setLines] = useState<Line[]>([])
  const [turn, setTurn] = useState<{ secs: number; tokens: number } | null>(null)
  const [info, setInfo] = useState<TranscriptInfo | null>(null)
  const [perms, setPerms] = useState<PendingPermission[]>([])
  // board-command echo lives only in this client — the daemon transcript never sees it (zero tokens)
  const [localLines, setLocalLines] = useState<Line[]>([])
  const echoLocal = (kind: Line['kind'], text: string) =>
    setLocalLines((prev) => [...prev.slice(-99), { at: new Date().toISOString(), kind, text }])
  const [input, setInput] = useState('')
  const [promptHistory, setPromptHistory] = useState<string[]>([])
  const [historyIdx, setHistoryIdx] = useState<number | null>(null)
  const [historyDraft, setHistoryDraft] = useState('')
  const [transcriptExpanded, setTranscriptExpanded] = useState(false)
  const [clearedAt, setClearedAt] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const feedRef = useRef<HTMLDivElement>(null)
  const firstScroll = useRef(true)
  // follow intent recorded at user-scroll time — appends fire no scroll event, so any
  // size of growth keeps following until the user deliberately scrolls away (#48)
  const followRef = useRef(true)
  const [following, setFollowing] = useState(true)
  const [controlPanel, setControlPanel] = useState<AgentControlPanelName | null>(null)
  const [controlError, setControlError] = useState<string | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  // grow the prompt box with its content, up to a cap — like the real cli
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`
  }, [input])
  useEffect(() => {
    firstScroll.current = true
    followRef.current = true
    setFollowing(true)
    setControlPanel(null)
    setControlError(null)
    setLocalLines([])
    setPromptHistory([])
    setHistoryIdx(null)
    setHistoryDraft('')
    setTranscriptExpanded(false)
    setClearedAt(null)
    setSending(false)
    setSubmitError(null)
  }, [agent.id])

  // hired agents stream their real transcript; terminal agents show the board conversation
  useEffect(() => {
    if (!hired) return
    let alive = true
    const load = () => api('GET', `/agents/${agent.id}/transcript`).then((r) => {
      if (!alive) return
      const next: Line[] = r.lines ?? r
      // avoid re-rendering the whole history when nothing changed — keeps scrolling smooth
      setLines((prev) => (prev.length === next.length &&
        prev[prev.length - 1]?.text === next[next.length - 1]?.text) ? prev : [...next])
      setTurn((prev) => {
        const w = r.working ?? null
        if (!prev && !w) return prev
        return w
      })
      setInfo((prev) => {
        const i: TranscriptInfo | null = r.info ?? null
        const previousProvider = normalizeProvider(prev?.provider ?? agent.provider)
        const nextProvider = normalizeProvider(i?.provider ?? agent.provider)
        if (prev && i && prev.tokens === i.tokens && prev.model === i.model && prev.permissionMode === i.permissionMode &&
          previousProvider === nextProvider &&
          (prev.accessProfile ?? prev.access_profile) === (i.accessProfile ?? i.access_profile) &&
          (prev.capabilities ?? []).join('|') === (i.capabilities ?? []).join('|') &&
          (prev.commands?.length ?? 0) === (i.commands?.length ?? 0) &&
          prev.commands?.[0]?.description === i.commands?.[0]?.description &&
          prev.effort === i.effort && (prev.models?.length ?? 0) === (i.models?.length ?? 0) &&
          providerTokenSummary(previousProvider, [prev.usage?.session, prev.usage?.turn]).total ===
            providerTokenSummary(nextProvider, [i.usage?.session, i.usage?.turn]).total) return prev
        return i
      })
      setPerms((prev) => {
        const next: PendingPermission[] = r.permissions ?? []
        return (prev.length === next.length && prev.every((p, idx) => p.id === next[idx]?.id)) ? prev : next
      })
    }).catch(() => {})
    load()
    const t = setInterval(load, 1000)
    return () => { alive = false; clearInterval(t) }
  }, [agent.id, agent.provider, hired])

  // interleave local command echo with the streamed transcript by timestamp
  const visibleLines = clearedAt ? lines.filter((line) => !line.at || line.at > clearedAt) : lines
  const convo: Line[] = hired ? (localLines.length
    ? [...visibleLines, ...localLines].sort((a, b) => (a.at ?? '') < (b.at ?? '') ? -1 : 1)
    : visibleLines) : [...threads]
    .sort((a, b) => a.id - b.id) // server serves newest-first; a terminal reads top to bottom
    .filter((t) => (t.from_name === agent.name || t.to_name === agent.name))
    .flatMap((t) => [
      { kind: (t.from_name === agent.name ? 'text' : 'user') as Line['kind'],
        text: t.from_name === agent.name ? t.body : t.body },
      ...t.replies.map((r) => ({
        kind: (r.from_name === agent.name ? 'text' : 'user') as Line['kind'],
        text: r.body,
      })),
    ])

  const provider = normalizeProvider(info?.provider ?? agent.provider)
  const capabilities = info?.capabilities ?? agent.capabilities
  const canAccessProfile = hasAgentCapability(capabilities, 'access_profile', provider)
  const canSelectModel = hasAgentCapability(capabilities, 'model', provider)
  const canSetEffort = hasAgentCapability(capabilities, 'effort', provider)
  const canApprove = hasAgentCapability(capabilities, 'approvals', provider)
  const canInterrupt = hasAgentCapability(capabilities, 'interrupt', provider)
  const canStop = hasAgentCapability(capabilities, 'stop', provider)
  const accessProfile = resolveAccessProfile(
    info?.accessProfile ?? info?.access_profile ?? agent.access_profile,
    info?.permissionMode,
  )
  const working = hired && turn !== null

  // on open: jump straight to the latest messages; afterwards follow the stream while the
  // user's recorded intent says so. Depends on the last line's text too — at the 500-line
  // transcript cap (and for streaming same-line growth) content changes while length doesn't.
  const lastLineText = convo[convo.length - 1]?.text
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    if (firstScroll.current && convo.length > 0) {
      el.scrollTo({ top: el.scrollHeight })
      firstScroll.current = false
      followRef.current = true
      setFollowing(true)
      return
    }
    if (followRef.current) el.scrollTo({ top: el.scrollHeight })
  }, [convo.length, lastLineText, working])

  // Transcript text and tool cards can grow after React commits (font wrapping, async
  // layout, streamed lines). Observe the rendered feed so following tracks its real size.
  useEffect(() => {
    const feed = feedRef.current
    if (!feed || typeof ResizeObserver === 'undefined') return
    let frameId = 0
    const observer = new ResizeObserver(() => {
      if (!followRef.current) return
      cancelAnimationFrame(frameId)
      frameId = requestAnimationFrame(() => {
        const el = scrollRef.current
        if (el && followRef.current) el.scrollTo({ top: el.scrollHeight })
      })
    })
    observer.observe(feed)
    return () => { cancelAnimationFrame(frameId); observer.disconnect() }
  }, [agent.id])

  // intent updates only on real scroll interactions; programmatic scrollTo lands at the
  // bottom and re-records "following", so the two stay consistent
  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    const next = followIntent(el.scrollHeight - el.scrollTop - el.clientHeight, followRef.current)
    followRef.current = next
    setFollowing(next)
  }
  // a wheel-up is an unambiguous "let me read" — honor it before the position crosses the band
  const onWheel = (e: React.WheelEvent) => {
    if (e.deltaY >= 0) return
    followRef.current = false
    setFollowing(false)
  }

  const jumpToLatest = () => {
    followRef.current = true
    setFollowing(true)
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }

  const cycleAccessProfile = async () => {
    if (!hired || !canAccessProfile) return
    const current = ACCESS_PROFILES.findIndex((profile) => profile.value === accessProfile)
    const next = ACCESS_PROFILES[(current + 1 + ACCESS_PROFILES.length) % ACCESS_PROFILES.length]
    if (next.value === 'full_access'
      && !window.confirm('Full access removes provider sandbox restrictions for this agent. Continue only if you trust the workspace and task.')) return
    try {
      await api('POST', `/agents/${agent.id}/access-profile`, { profile: next.value })
      setControlError(null)
      onChange()
    } catch (error) { setControlError(controlErrorText(error)) }
  }

  const navigateHistory = (direction: -1 | 1) => {
    if (promptHistory.length === 0) return
    if (direction === -1) {
      const next = historyIdx === null ? promptHistory.length - 1 : Math.max(0, historyIdx - 1)
      if (historyIdx === null) setHistoryDraft(input)
      setHistoryIdx(next)
      setInput(promptHistory[next])
    } else {
      if (historyIdx === null) return
      const next = historyIdx + 1
      if (next >= promptHistory.length) {
        setHistoryIdx(null)
        setInput(historyDraft)
      } else {
        setHistoryIdx(next)
        setInput(promptHistory[next])
      }
    }
    requestAnimationFrame(() => {
      const el = inputRef.current
      if (el) el.setSelectionRange(el.value.length, el.value.length)
    })
  }

  // slash-command menu: open while a hired agent's input is a bare /prefix (no space yet)
  const [menuIdx, setMenuIdx] = useState(0)
  const [menuHidden, setMenuHidden] = useState(false) // escape dismisses; typing re-opens
  const menuItems: CommandItem[] = uniqueSlashCommands([
    ...LOCAL_CONSOLE_COMMANDS,
    ...extraCommands.map((c) => ({ ...c, name: normalizeSlashCommandName(c.name) })),
    ...(info?.commands ?? []).map((c) => ({ ...c, name: normalizeSlashCommandName(c.name), source: 'session' })),
  ])
  const slashTerm = hired && input.startsWith('/') && !/[\s]/.test(input) ? input.slice(1) : null
  const filtered = slashTerm !== null
    ? menuItems
      .filter((c) => c.name.toLowerCase().includes(slashTerm.toLowerCase()))
      .sort((a, b) => Number(!a.name.toLowerCase().startsWith(slashTerm.toLowerCase())) - Number(!b.name.toLowerCase().startsWith(slashTerm.toLowerCase())))
    : []
  const visibleCommands = filtered.slice(0, 10)
  const menuOpen = visibleCommands.length > 0 && !menuHidden
  useEffect(() => { setMenuIdx(0); setMenuHidden(false) }, [slashTerm])

  const activeModel = info?.model ?? null
  const currentModel = info?.models?.find((model) => {
    const value = sessionModelValue(model)
    return value === activeModel || model.resolvedModel === activeModel
  })
  const modelLabel = currentModel?.displayName ?? info?.model ?? 'Default model'
  const cwdLabel = info?.cwd?.replace(/^\/(?:Users|home)\/[^/]+/, '~') ?? ''
  const accessLabel = ACCESS_PROFILES.find((profile) => profile.value === accessProfile)?.label ?? accessProfile

  const runLocalConsoleCommand = (command: NonNullable<ReturnType<typeof localConsoleCommand>>, text: string) => {
    const at = new Date().toISOString()
    if (command === 'clear') {
      setClearedAt(at)
      setLocalLines([{ at, kind: 'status', text: 'Console view cleared. Session memory is unchanged.' }])
      return
    }

    echoLocal('user', text)
    if (command === 'commands') {
      const available = menuItems.map((item) => `/${item.name} — ${item.description || item.source}`).join('\n')
      echoLocal('status', `Available in this console:\n${available}`)
      return
    }
    if (command === 'status') {
      echoLocal('status', [
        `Agent: ${agent.name} · ${agent.status}`,
        `Model: ${modelLabel}`,
        `Access: ${accessLabel}`,
        cwdLabel ? `Workspace: ${cwdLabel}` : '',
      ].filter(Boolean).join('\n'))
      return
    }

    const usage = providerTokenSummary(provider, [info?.usage?.session, info?.usage?.turn])
    const cost = typeof info?.costUsd === 'number' && info.costUsd > 0 ? ` · $${info.costUsd.toFixed(4)}` : ''
    echoLocal('status', `Session usage: ${fmtTokens(usage.inputTotal)} input · ${fmtTokens(usage.output)} output${cost}`)
  }

  const send = async () => {
    const text = input.trim()
    if (!text || sending) return
    setSending(true)
    setSubmitError(null)
    setPromptHistory((prev) => prev[prev.length - 1] === text ? prev : [...prev, text].slice(-100))
    setHistoryIdx(null)
    setHistoryDraft('')
    try {
      const nativePanel = hired ? panelForSlashInput(text) : null
      if (nativePanel) {
        setInput('')
        if (provider !== 'claude' && nativePanel !== 'model') {
          echoLocal('status', `/${nativePanel} controls are only available for Claude sessions.`)
          return
        }
        if (nativePanel === 'model' && !canSelectModel && !canSetEffort) {
          echoLocal('status', 'Model controls are not available for this provider session.')
          return
        }
        setControlPanel(nativePanel)
        return
      }

      const localCommand = hired ? localConsoleCommand(text) : null
      if (localCommand) {
        setInput('')
        runLocalConsoleCommand(localCommand, text)
        return
      }

      // Orchestra commands run daemon-direct and never enter the model context.
      if (hired && isBoardCommand(text)) {
        setInput('')
        echoLocal('user', text)
        const out = await runBoardCommand(text, { boardId, agent, cards, api })
        out.forEach((line) => echoLocal('status', line))
        onChange()
        return
      }

      const slashName = text.match(/^\/([^\s]+)/)?.[1]?.toLowerCase()
      const advertised = slashName && menuItems.some((item) => item.name.toLowerCase() === slashName)
      if (hired && slashName && !advertised) {
        setInput('')
        echoLocal('user', text)
        echoLocal('error', `/${slashName} is not available in this session. Type /commands to see actions that can run here.`)
        return
      }

      if (hired) await api('POST', `/agents/${agent.id}/task`, { text })
      else await api('POST', '/messages', { board_id: boardId, to: agent.name, body: text })
      setInput('')
      onChange()
    } catch (cause) {
      const raw = cause instanceof Error ? cause.message : 'The message could not be sent.'
      try { setSubmitError(JSON.parse(raw).error ?? raw) } catch { setSubmitError(raw) }
    } finally {
      setSending(false)
    }
  }

  // Selecting a command fills the composer. The explicit Send action makes execution clear.
  const complete = (c: CommandItem) => {
    setInput(`/${c.name}`)
    inputRef.current?.focus()
  }

  const activateCommand = (c: CommandItem) => {
    const nativePanel = panelForSlashCommand(c.name)
    if (nativePanel) {
      setInput('')
      setMenuHidden(true)
      if (provider !== 'claude' && nativePanel !== 'model') {
        echoLocal('status', `/${nativePanel} controls are only available for Claude sessions.`)
        return
      }
      setControlPanel(nativePanel)
      return
    }
    complete(c)
  }

  const promptKeys = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const key = e.key.toLowerCase()
    if (e.ctrlKey && key === 'c' && e.currentTarget.selectionStart === e.currentTarget.selectionEnd) {
      e.preventDefault()
      if (input) {
        setInput('')
        setHistoryIdx(null)
      } else if (working) {
        void interrupt()
      }
      return
    }
    if (menuOpen) {
      if (e.key === 'ArrowDown' || (e.ctrlKey && key === 'n')) { e.preventDefault(); setMenuIdx((i) => (i + 1) % visibleCommands.length); return }
      if (e.key === 'ArrowUp' || (e.ctrlKey && key === 'p')) { e.preventDefault(); setMenuIdx((i) => (i - 1 + visibleCommands.length) % visibleCommands.length); return }
      if ((e.key === 'Tab' && !e.shiftKey) || e.key === 'Enter') { e.preventDefault(); activateCommand(visibleCommands[Math.min(menuIdx, visibleCommands.length - 1)]); return }
      // dismiss the menu only — must not bubble to the terminal's interrupt/close handler
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setMenuHidden(true); return }
    }
    const caret = e.currentTarget.selectionStart ?? input.length
    if ((e.key === 'ArrowUp' || (e.ctrlKey && key === 'p')) && !input.slice(0, caret).includes('\n')) {
      e.preventDefault(); navigateHistory(-1); return
    }
    if ((e.key === 'ArrowDown' || (e.ctrlKey && key === 'n')) && !input.slice(caret).includes('\n')) {
      e.preventDefault(); navigateHistory(1); return
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
  }

  const interrupt = async () => {
    if (hired && working && canInterrupt) { await api('POST', `/agents/${agent.id}/interrupt`); onChange() }
  }

  const decide = async (
    requestId: string,
    decision: 'allow' | 'allow_session' | 'deny' | 'cancel',
    answers?: Record<string, string[]>,
  ) => {
    const path = provider === 'codex'
      ? `/agents/${agent.id}/approvals/${encodeURIComponent(requestId)}`
      : `/agents/${agent.id}/permissions/${encodeURIComponent(requestId)}`
    const body = provider === 'codex' ? { decision, ...(answers ? { answers } : {}) } : { behavior: decision }
    try {
      await api('POST', path, body)
      setControlError(null)
      setPerms((prev) => prev.filter((p) => p.id !== requestId))
    } catch (error) { setControlError(controlErrorText(error)) }
  }

  const renderLine = (l: Line, i: number) => {
    switch (l.kind) {
      case 'user':
        return <div key={i} className="cc-line cc-user"><span className="cc-line-mark">YOU</span><p>{l.text}</p></div>
      case 'tool': {
        const paren = l.text.indexOf('(')
        const name = paren === -1 ? l.text : l.text.slice(0, paren)
        const args = paren === -1 ? '' : l.text.slice(paren)
        return <div key={i} className="cc-line cc-tool"><span className="cc-line-mark">TOOL</span><p><b>{name}</b>{args}</p></div>
      }
      case 'tool_result':
        return <div key={i} className={`cc-line cc-result${transcriptExpanded ? '' : ' is-collapsed'}`}
          title={transcriptExpanded ? undefined : 'Ctrl+O to expand transcript details'}>
          <span className="cc-line-mark">RESULT</span><p>{l.text}</p>
        </div>
      case 'thinking':
        return <div key={i} className={`cc-line cc-thinking${transcriptExpanded ? '' : ' is-collapsed'}`}>
          <span className="cc-line-mark">NOTE</span><p>{l.text}</p>
        </div>
      case 'status':
        return <div key={i} className="cc-line cc-status"><span className="cc-line-mark">SYSTEM</span><p>{l.text}</p></div>
      case 'error':
        return <div key={i} className="cc-line cc-error"><span className="cc-line-mark">ERROR</span><p>{l.text}</p></div>
      default:
        return <div key={i} className="cc-line cc-text"><span className="cc-line-mark">AGENT</span><p>{l.text}</p></div>
    }
  }
  const hasConversationActivity = convo.some((line) => line.kind !== 'status')

  return (
    <>
      {!embedded && <div className="scrim" onClick={onClose} />}
      <aside className={embedded ? 'terminal embedded' : 'terminal'}
        role={embedded ? undefined : 'dialog'} aria-modal={embedded ? undefined : true}
        aria-label={`${agent.name} console`}
        onKeyDown={(e) => {
          const key = e.key.toLowerCase()
          if (e.shiftKey && e.key === 'Tab' && hired) {
            e.preventDefault(); void cycleAccessProfile(); return
          }
          if (e.altKey && key === 'p' && hired && (canSelectModel || canSetEffort)) {
            e.preventDefault(); setControlPanel('model'); return
          }
          if (e.ctrlKey && key === 'o') {
            e.preventDefault(); setTranscriptExpanded((expanded) => !expanded); return
          }
          if (e.ctrlKey && key === 'l') {
            e.preventDefault(); jumpToLatest(); return
          }
          if (e.key === 'Escape' && hired && working) {
            e.preventDefault(); void interrupt()
          }
        }}>
        <div className="terminal-col">
          <header className="cc-head">
            <div className="cc-head-identity">
              <span className="cc-head-kicker">SESSION</span>
              <span>
                <strong>{agent.name}{hired && <> <ProviderBadge provider={provider} compact /></>}</strong>
                <small>{hired ? `${providerLabel(provider)} model session` : 'Board conversation'} · {agent.status}</small>
              </span>
            </div>
            <div className="cc-head-actions">
              {agent.name !== 'strategist' && !agent.name.startsWith('auditor-') && cards.filter((c) => c.column !== 'done' && c.owner !== agent.name).length > 0 && (
                <select className="cc-assign" defaultValue=""
                  title="Assign a ticket — the agent gets briefed and starts"
                  aria-label="Assign ticket"
                  onChange={async (e) => {
                    const id = Number(e.target.value)
                    e.target.value = ''
                    if (!id) return
                    try { await api('POST', `/cards/${id}/assign`, { agent: agent.name }) } catch { /* locked */ }
                    onChange()
                  }}>
                  <option value="" disabled>assign ticket…</option>
                  {cards.filter((c) => c.column !== 'done' && c.owner !== agent.name).map((c) => (
                    <option key={c.id} value={c.id}>#{c.id} {c.title.slice(0, 48)}{c.owner ? ` (${c.owner})` : ''}</option>
                  ))}
                </select>
              )}
              {hired && canStop && (
                <button type="button" className="cc-head-action cc-head-stop"
                  title="Stop this agent — terminates its session; a launched ticket moves to blocked"
                  onClick={async () => { await api('POST', `/agents/${agent.id}/fire`); onChange(); onClose() }}>stop</button>
              )}
              {!embedded && <button type="button" className="cc-head-close" onClick={onClose} aria-label="Close console" title="Close console">×</button>}
            </div>
          </header>

          <div className="cc-history-shell">
            <div className="terminal-scroll" ref={scrollRef} onScroll={onScroll} onWheel={onWheel}>
              <div className="terminal-feed" ref={feedRef}>
                {convo.map(renderLine)}
                {!working && !hasConversationActivity && (
                  <div className="cc-empty">
                    <strong>{hired ? 'Ready for your first prompt' : 'No messages yet'}</strong>
                    <p>{hired
                      ? 'The session is idle and uses no model tokens until you send something. Type / to see actions supported here.'
                      : `Messages to ${agent.name} will appear here.`}</p>
                  </div>
                )}
                {hired && perms.map((p) => (
                  <div key={p.id} className="cc-perm" role="group" aria-label="Permission request">
                    <p className="cc-perm-kicker">
                      {p.approvalKind === 'user-input' ? 'Agent needs your input'
                        : p.approvalKind === 'mcp-elicitation' ? 'External service requests input'
                          : `Agent requests access to ${p.tool ?? 'a provider action'}`}
                    </p>
                    <p className="cc-perm-title"><b>{p.title ?? p.summary}</b></p>
                    {p.approvalKind === 'mcp-elicitation' && p.serverName && (
                      <p className="cc-perm-external">Requested by MCP server <b>{p.serverName}</b>.</p>
                    )}
                    {p.approvalKind === 'mcp-elicitation' && p.url && (
                      <p><a className="cc-perm-link" href={p.url} target="_blank" rel="noreferrer noopener">Open the provider sign-in page ↗</a></p>
                    )}
                    {canApprove && provider === 'codex'
                      && (p.approvalKind === 'user-input' || p.approvalKind === 'mcp-elicitation')
                      && questionsFor(p).length > 0 ? (
                      <UserInputApproval permission={p}
                        onSubmit={(answers) => decide(p.id, 'allow', answers)}
                        onCancel={() => decide(p.id, 'cancel')} />
                    ) : canApprove ? (
                      <div className="cc-perm-actions">
                        <button className="cc-perm-allow" onClick={() => decide(p.id, 'allow')}><span>1.</span> Allow once</button>
                        {provider === 'codex' && p.approvalKind !== 'mcp-elicitation'
                          && <button className="cc-perm-allow" onClick={() => decide(p.id, 'allow_session')}><span>2.</span> Allow for session</button>}
                        <button className="cc-perm-deny" onClick={() => decide(p.id, 'deny')}>
                          <span>{provider === 'codex' && p.approvalKind !== 'mcp-elicitation' ? '3.' : '2.'}</span> Deny
                        </button>
                      </div>
                    ) : <p className="cc-perm-external">Resolve this request in the provider client.</p>}
                    {canApprove && !(provider === 'codex'
                      && (p.approvalKind === 'user-input' || p.approvalKind === 'mcp-elicitation')
                      && questionsFor(p).length > 0) && <p className="cc-perm-help">Choose an option to continue</p>}
                  </div>
                ))}
                {working && turn && (
                  <div className="cc-working" role="status">
                    <span className="cc-working-track" aria-hidden="true"><span /></span>
                    <span>Working · {fmtSecs(turn.secs)}{turn.tokens > 0 && <> · {fmtTokens(turn.tokens)} output tokens</>}</span>
                    {canInterrupt && <button type="button" onClick={interrupt}>Interrupt</button>}
                  </div>
                )}
              </div>
            </div>
            {!following && <button type="button" className="cc-follow-latest" onClick={jumpToLatest}>Latest messages</button>}
          </div>

          <div className="cc-prompt-wrap">
            {controlPanel && <AgentControlPanel agentId={agent.id} panel={controlPanel}
              models={info?.models ?? []} currentModel={info?.model ?? null}
              currentEffort={info?.effort ?? null} working={working}
              onClose={() => { setControlPanel(null); inputRef.current?.focus() }} onChange={onChange} />}
            {menuOpen && (
              <div className="cc-slash-menu" role="listbox" aria-label="Slash commands">
                <div className="cc-slash-heading"><strong>Available actions</strong><span>{filtered.length}</span></div>
                {visibleCommands.map((c, i) => (
                  <button type="button" key={`${c.source}:${c.name}`} role="option" aria-selected={i === menuIdx}
                    className={i === menuIdx ? 'cc-slash-item active' : 'cc-slash-item'}
                    onMouseEnter={() => setMenuIdx(i)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => activateCommand(c)}>
                    <span className="cc-slash-name">/{c.name}</span>
                    <span className="cc-cmd-badge" data-source={c.source}>{c.source}</span>
                    <span className="cc-slash-desc">{c.description}</span>
                  </button>
                ))}
                <div className="cc-slash-footer">
                  <span>Choose an action, then Send to run it</span>
                  {filtered.length > 10 && <span>{filtered.length - 10} more</span>}
                </div>
              </div>
            )}
            {hired && <div className="cc-prompt-meta">
              <ModelEffortControls info={info} canSelectModel={canSelectModel} canSetEffort={canSetEffort}
                onOpen={() => setControlPanel('model')} />
            </div>}
            <div className="cc-promptbox" data-mode={accessProfile}>
              <span className="cc-prompt-label">MESSAGE</span>
              <textarea ref={inputRef} autoFocus value={input} rows={1}
                placeholder={convo.length === 0 ? (hired ? 'Describe what this agent should do…' : `Message ${agent.name}`) : 'Write a follow-up…'}
                onChange={(e) => { setInput(e.target.value); setHistoryIdx(null); setSubmitError(null) }}
                onKeyDown={promptKeys} />
              <button type="button" className="cc-send" disabled={!input.trim() || sending}
                onClick={() => void send()}>{sending ? 'Sending' : 'Send'}</button>
            </div>
            {submitError && <p className="cc-submit-error" role="alert">{submitError}</p>}
          </div>
          <div className="cc-statusline">
            <span title={info?.cwd}>{modelLabel}{cwdLabel ? ` · ${cwdLabel}` : ''}</span>
            <span>
              {info?.usage && providerTokenSummary(provider, [info.usage.session, info.usage.turn]).total > 0 ? (() => {
                // live turn accrual counts toward the session display so the split never lags the ↓ number
                const usage = providerTokenSummary(provider, [info.usage.session, info.usage.turn])
                const cacheWrite = usage.cacheWrite > 0 ? ` · cache write ${fmtTokens(usage.cacheWrite)}` : ''
                const reasoning = usage.reasoningOutput > 0 ? ` · reasoning ${fmtTokens(usage.reasoningOutput)}` : ''
                const tip = `${providerLabel(provider)} API tokens this session — input ${fmtTokens(usage.input)} · cached input ${fmtTokens(usage.cached)}${cacheWrite} · output ${fmtTokens(usage.output)}${reasoning} (distinct from the board meter's injected-context estimate)`
                return <span title={tip}>{fmtTokens(usage.inputTotal)} in · {usage.cachedPercent}% cached · {fmtTokens(usage.output)} out</span>
              })() : info && info.tokens > 0 ? `${fmtTokens(info.tokens)} output tokens` : ''}
              {!hired ? ' · delivered on its next turn' : ''}
            </span>
          </div>
          <div className="cc-hints">
            {hired
              ? <span className="cc-controls">
                  {canAccessProfile && <PermissionModeHint profile={accessProfile} onCycle={() => void cycleAccessProfile()} />}
                  {controlError && <span className="cc-inline-control-error" role="alert">{controlError}</span>}
                </span>
              : <span>enter to send · shift+enter for newline</span>}
            <span className="cc-key-hints">
              <button type="button" onClick={() => setTranscriptExpanded((expanded) => !expanded)}>Details {transcriptExpanded ? 'on' : 'off'}</button>
              {hired && (canSelectModel || canSetEffort)
                && <button type="button" onClick={() => setControlPanel('model')}>Models</button>}
            </span>
          </div>
        </div>
      </aside>
    </>
  )
}
