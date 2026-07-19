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
import { panelForSlashCommand, panelForSlashInput, type AgentControlPanelName } from './agentTerminalControls'

type Line = { at?: string; kind: 'text' | 'status' | 'error' | 'user' | 'tool' | 'tool_result' | 'thinking'; text: string }

// Friendly progress copy shared by every model-backed provider.
const GERUNDS = ['Pondering', 'Cerebrating', 'Noodling', 'Waddling', 'Percolating', 'Ruminating',
  'Marinating', 'Brewing', 'Conjuring', 'Scheming', 'Tinkering', 'Musing', 'Whirring', 'Puzzling',
  'Simmering', 'Crunching', 'Weaving', 'Hatching', 'Composing', 'Orchestrating', 'Grooving', 'Vibing']

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

// Provider model catalogs may use the legacy Claude `model` key or the neutral `value` key.
type ModelInfo = {
  model?: string
  value?: string
  resolvedModel?: string
  displayName?: string
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
  usage?: { turn: ProviderTokenUsage; session: ProviderTokenUsage }
}

const modelValue = (model: ModelInfo) => model.value ?? model.model ?? model.resolvedModel ?? ''

// model dropdown + segmented effort control — slots in beside PermissionModeHint (#45 contract).
// Provider controls persist immediately and apply to the next turn.
function ModelEffortControls({ agentId, info, working, canSelectModel, canSetEffort, onChange, onError }: {
  agentId: number
  info: { model: string | null; effort?: string | null; models?: ModelInfo[] } | null
  working: boolean
  canSelectModel: boolean
  canSetEffort: boolean
  onChange: () => void
  onError: (message: string | null) => void
}) {
  const models = info?.models ?? []
  if (models.length === 0 || (!canSelectModel && !canSetEffort)) return null
  const current = models.find((model) => modelValue(model) === info?.model || model.resolvedModel === info?.model)
  const levels = canSetEffort && current?.supportsEffort !== false ? current?.supportedEffortLevels ?? [] : []
  return (
    <span className="cc-model-effort">
      {canSelectModel && (
        <select className="cc-mode-select" value={current ? modelValue(current) : ''} aria-label="Model"
          title="Model — applies from the next turn"
          onChange={async (e) => {
            try {
              await api('POST', `/agents/${agentId}/model`, { model: e.target.value })
              onError(null); onChange()
            } catch (error) { onError(controlErrorText(error)) }
          }}>
          {!current && <option value="">{info?.model ?? 'model…'}</option>}
          {models.map((model) => {
            const value = modelValue(model)
            return <option key={value} value={value}>{model.displayName ?? value}</option>
          })}
        </select>
      )}
      {levels.length > 0 && (
        <span className="cc-effort" role="group" aria-label="Reasoning effort"
          title={working ? 'Effort — wait for the turn to finish' : 'Effort — applies from the next turn'}>
          {levels.map((l) => (
            <button key={l} disabled={working}
              className={`cc-effort-btn${(info?.effort ?? '') === l ? ' cc-effort-on' : ''}`}
              onClick={async () => {
                if ((info?.effort ?? '') === l) return
                try {
                  await api('POST', `/agents/${agentId}/effort`, { level: l })
                  onError(null); onChange()
                } catch (error) { onError(controlErrorText(error)) }
              }}>{l === 'medium' ? 'med' : l}</button>
          ))}
        </span>
      )}
    </span>
  )
}

// Neutral access profiles map to each provider's native sandbox and approval policy.
function PermissionModeHint({ agentId, profile, onChange, onError }: {
  agentId: number
  profile: AccessProfile
  onChange: () => void
  onError: (message: string | null) => void
}) {
  const selected = ACCESS_PROFILES.find((candidate) => candidate.value === profile) ?? ACCESS_PROFILES[1]
  return (
    <span className={`cc-mode${profile === 'full_access' ? ' cc-mode-danger' : ''}`}>
      {selected.icon}{' '}
      <select className="cc-mode-select" value={selected.value} aria-label="Access profile"
        title="Access profile — applies from the next provider turn"
        onChange={async (e) => {
          const next = e.target.value as AccessProfile
          if (next === 'full_access' && !window.confirm('Full access removes provider sandbox restrictions for this agent. Continue only if you trust the workspace and task.')) return
          try {
            await api('POST', `/agents/${agentId}/access-profile`, { profile: next })
            onError(null); onChange()
          } catch (error) { onError(controlErrorText(error)) }
        }}>
        {ACCESS_PROFILES.map((candidate) => <option key={candidate.value} value={candidate.value}>{candidate.label}</option>)}
      </select>
      <span className="cc-dim">({selected.hint})</span>
    </span>
  )
}

// Orchestra spinner frames are provider-neutral; provider identity is shown separately.
const STARS = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢']
const BOOT_MSGS = [
  'Warming up the orchestra…', 'Tuning instruments…', 'Raising the baton…',
  'Finding a seat in the pit…', 'Rosining the bow…', 'Clearing the throat…',
]

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
  const [gerund, setGerund] = useState(() => GERUNDS[Math.floor(Math.random() * GERUNDS.length)])
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

  // rotate the working word every so often, like the real thing
  useEffect(() => {
    if (!turn) return
    const t = setInterval(() => setGerund(GERUNDS[Math.floor(Math.random() * GERUNDS.length)]), 9000)
    return () => clearInterval(t)
  }, [turn !== null])

  // A provider session is booting until its normalized transcript reports activity.
  const booting = hired && !lines.some((l) => l.kind === 'status' && l.text.startsWith('session started')) &&
    !lines.some((l) => l.kind === 'text' || l.kind === 'tool')
  const [frame, setFrame] = useState(0)
  useEffect(() => {
    if (!booting && !turn) return
    const t = setInterval(() => setFrame((f) => f + 1), 220)
    return () => clearInterval(t)
  }, [booting, turn !== null])
  const star = STARS[frame % STARS.length]
  const bootMsg = BOOT_MSGS[Math.floor(frame / 14) % BOOT_MSGS.length]

  // interleave local command echo with the streamed transcript by timestamp
  const convo: Line[] = hired ? (localLines.length
    ? [...lines, ...localLines].sort((a, b) => (a.at ?? '') < (b.at ?? '') ? -1 : 1)
    : lines) : [...threads]
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

  const send = async () => {
    const text = input.trim()
    if (!text) return
    const nativePanel = hired ? panelForSlashInput(text) : null
    if (nativePanel) {
      setInput('')
      if (provider !== 'claude' && nativePanel !== 'model') {
        echoLocal('status', `/${nativePanel} controls are only available for Claude sessions.`)
        return
      }
      setControlPanel(nativePanel)
      return
    }
    // orchestra commands run daemon-direct — claimed here, never posted to the agent (#44)
    if (hired && isBoardCommand(text)) {
      setInput('')
      echoLocal('user', text)
      const out = await runBoardCommand(text, { boardId, agent, cards, api })
      out.forEach((t) => echoLocal('status', t))
      onChange()
      return
    }
    if (hired) await api('POST', `/agents/${agent.id}/task`, { text })
    else await api('POST', '/messages', { board_id: boardId, to: agent.name, body: text })
    setInput(''); onChange()
  }

  // slash-command menu: open while a hired agent's input is a bare /prefix (no space yet)
  const [menuIdx, setMenuIdx] = useState(0)
  const [menuHidden, setMenuHidden] = useState(false) // escape dismisses; typing re-opens
  const menuItems: CommandItem[] = [
    ...(info?.commands ?? []).map((c) => ({ ...c, source: 'sdk' })),
    ...extraCommands,
  ]
  const slashTerm = hired && input.startsWith('/') && !/[\s]/.test(input) ? input.slice(1) : null
  const filtered = slashTerm !== null
    ? menuItems.filter((c) => c.name.toLowerCase().startsWith(slashTerm.toLowerCase()))
    : []
  const menuOpen = filtered.length > 0 && !menuHidden
  useEffect(() => { setMenuIdx(0); setMenuHidden(false) }, [slashTerm])

  // complete into the textarea only — never send; execution stays in send() (contract w/ #44)
  const complete = (c: CommandItem) => {
    setInput(`/${c.name} `)
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

  const promptKeys = (e: React.KeyboardEvent) => {
    if (menuOpen) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setMenuIdx((i) => (i + 1) % filtered.length); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); setMenuIdx((i) => (i - 1 + filtered.length) % filtered.length); return }
      if (e.key === 'Tab' || e.key === 'Enter') { e.preventDefault(); activateCommand(filtered[Math.min(menuIdx, filtered.length - 1)]); return }
      // dismiss the menu only — must not bubble to the terminal's interrupt/close handler
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setMenuHidden(true); return }
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
        return <p key={i} className="cc-user">&gt; {l.text}</p>
      case 'tool': {
        const paren = l.text.indexOf('(')
        const name = paren === -1 ? l.text : l.text.slice(0, paren)
        const args = paren === -1 ? '' : l.text.slice(paren)
        return <p key={i} className="cc-tool"><span className="cc-dot tool">⏺</span> <b>{name}</b>{args}</p>
      }
      case 'tool_result':
        return <p key={i} className="cc-result">⎿  {l.text}</p>
      case 'thinking':
        return <p key={i} className="cc-thinking">✻ {l.text}</p>
      case 'status':
        return <p key={i} className="cc-status">{l.text}</p>
      case 'error':
        return <p key={i} className="cc-error">✗ {l.text}</p>
      default:
        return <p key={i} className="cc-text"><span className="cc-dot">⏺</span> {l.text}</p>
    }
  }

  return (
    <>
      {!embedded && <div className="scrim" onClick={onClose} />}
      <aside className={embedded ? 'terminal embedded' : 'terminal'}
        role={embedded ? undefined : 'dialog'} aria-modal={embedded ? undefined : true}
        aria-label={`${agent.name} console`}
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return
          e.preventDefault()
          // esc interrupts a working agent; otherwise it closes, as the header promises
          if (hired && working) interrupt()
          else if (!embedded) onClose()
        }}>
        <div className="terminal-col">
          <header className="cc-head">
            <span className="cc-head-star">✻</span>
            <span>{agent.name}</span>
            {hired && <ProviderBadge provider={provider} compact />}
            <span className="cc-head-dim">{hired ? `agent · ${agent.status}` : `terminal session · ${agent.status}`}</span>
            {agent.name !== 'strategist' && !agent.name.startsWith('auditor-') && cards.filter((c) => c.column !== 'done' && c.owner !== agent.name).length > 0 && (
              <select className="cc-assign" defaultValue=""
                title="Assign a ticket — the agent gets briefed and starts"
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
              <button className="cc-close" title="Stop this agent — terminates its session; a launched ticket moves to blocked"
                onClick={async () => { await api('POST', `/agents/${agent.id}/fire`); onChange(); onClose() }}>■ stop</button>
            )}
            {!embedded && <button className="cc-close" onClick={onClose} aria-label="Close">esc·close ×</button>}
          </header>

          <div className="cc-history-shell">
            <div className="terminal-scroll" ref={scrollRef} onScroll={onScroll} onWheel={onWheel}>
              <div className="terminal-feed" ref={feedRef}>
                {hired && (
                  <div className="cc-welcome">
                    <p><span className="cc-logo">{booting ? star : '✻'}</span> Welcome to <b>Orchestra</b>!</p>
                    <p className="cc-welcome-sub">{agent.name} · {agent.status} · always review the work of autonomous agents</p>
                  </div>
                )}
                {convo.map(renderLine)}
                {booting && (
                  <p className="cc-spinner"><span className="cc-star-frame">{star}</span> {bootMsg}</p>
                )}
                {!booting && convo.length === 0 && (
                  <p className="cc-status">
                    {hired ? 'No activity yet — type a prompt below.' : 'No board conversation with this agent yet.'}
                  </p>
                )}
                {hired && perms.map((p) => (
                  <div key={p.id} className="cc-perm" role="group" aria-label="Permission request">
                    <p className="cc-perm-title">⚠ permission needed · <b>{p.title ?? p.summary}</b></p>
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
                        <button className="cc-perm-allow" onClick={() => decide(p.id, 'allow')}>✓ allow</button>
                        {provider === 'codex' && p.approvalKind !== 'mcp-elicitation'
                          && <button className="cc-perm-allow" onClick={() => decide(p.id, 'allow_session')}>✓ allow session</button>}
                        <button className="cc-perm-deny" onClick={() => decide(p.id, 'deny')}>✗ deny</button>
                      </div>
                    ) : <p className="cc-perm-external">Resolve this request in the provider client.</p>}
                  </div>
                ))}
                {working && turn && (
                  <p className="cc-spinner">
                    <span className="cc-star-frame">{star}</span> {gerund}… ({canInterrupt && <><button className="cc-esc" onClick={interrupt}>esc</button> to interrupt · </>}{fmtSecs(turn.secs)}
                    {turn.tokens > 0 && <> · ↓ {fmtTokens(turn.tokens)} tokens</>})
                  </p>
                )}
              </div>
            </div>
            {!following && <button type="button" className="cc-follow-latest" onClick={jumpToLatest}>↓ Jump to latest</button>}
          </div>

          <div className="cc-prompt-wrap">
            {controlPanel && <AgentControlPanel agentId={agent.id} panel={controlPanel}
              models={(info?.models ?? []).map((model) => ({ ...model, model: modelValue(model) })).filter((model) => model.model)}
              currentModel={info?.model ?? null}
              onClose={() => { setControlPanel(null); inputRef.current?.focus() }} onChange={onChange} />}
            {menuOpen && (
              <div className="cc-slash-menu" role="listbox" aria-label="Slash commands">
                {filtered.slice(0, 10).map((c, i) => (
                  <button type="button" key={`${c.source}:${c.name}`} role="option" aria-selected={i === menuIdx}
                    className={i === menuIdx ? 'cc-slash-item active' : 'cc-slash-item'}
                    onMouseEnter={() => setMenuIdx(i)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => activateCommand(c)}>
                    <span className="cc-slash-name">/{c.name}</span>
                    {c.source !== 'sdk' && <span className="cc-cmd-badge" data-source={c.source}>{c.source}</span>}
                    <span className="cc-slash-desc">{c.description}</span>
                  </button>
                ))}
                {filtered.length > 10 && <div className="cc-slash-more">… {filtered.length - 10} more — keep typing</div>}
              </div>
            )}
            <div className="cc-promptbox">
              <span className="cc-prompt-caret">&gt;</span>
              <textarea ref={inputRef} autoFocus value={input} rows={1}
                placeholder=""
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={promptKeys} />
            </div>
          </div>
          <div className="cc-hints">
            {hired
              ? <span className="cc-controls">
                  {canAccessProfile && <PermissionModeHint agentId={agent.id} profile={accessProfile}
                    onChange={onChange} onError={setControlError} />}
                  <ModelEffortControls agentId={agent.id} info={info} working={working}
                    canSelectModel={canSelectModel} canSetEffort={canSetEffort}
                    onChange={onChange} onError={setControlError} />
                  {controlError && <span className="cc-inline-control-error" role="alert">{controlError}</span>}
                </span>
              : <span>enter to send · shift+enter for newline</span>}
            <span>
              {info?.cwd ?? ''}{info?.model && !(info?.models?.length) ? ` · ${info.model}` : ''}
              {info?.usage && providerTokenSummary(provider, [info.usage.session, info.usage.turn]).total > 0 ? (() => {
                // live turn accrual counts toward the session display so the split never lags the ↓ number
                const usage = providerTokenSummary(provider, [info.usage.session, info.usage.turn])
                const cacheWrite = usage.cacheWrite > 0 ? ` · cache write ${fmtTokens(usage.cacheWrite)}` : ''
                const reasoning = usage.reasoningOutput > 0 ? ` · reasoning ${fmtTokens(usage.reasoningOutput)}` : ''
                const tip = `${providerLabel(provider)} API tokens this session — input ${fmtTokens(usage.input)} · cached input ${fmtTokens(usage.cached)}${cacheWrite} · output ${fmtTokens(usage.output)}${reasoning} (distinct from the board meter's injected-context estimate)`
                return <span title={tip}> · ↑ {fmtTokens(usage.inputTotal)} in · {usage.cachedPercent}% cached · ↓ {fmtTokens(usage.output)} out</span>
              })() : info && info.tokens > 0 ? ` · ↓ ${fmtTokens(info.tokens)} tokens` : ''}
              {!hired ? ' · delivered on its next turn' : ''}
            </span>
          </div>
        </div>
      </aside>
    </>
  )
}
