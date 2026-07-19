import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { api, Agent, Card, Thread } from './api'
import { BOARD_COMMANDS, isBoardCommand, runBoardCommand } from './boardCommands'
import { followIntent } from './follow'
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
import './agentTerminal.css'

type Line = { at?: string; kind: 'text' | 'status' | 'error' | 'user' | 'tool' | 'tool_result' | 'thinking'; text: string }

const fmtTokens = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)

// real API token split (input / cache-read / cache-creation / output) — from result-message
// usage, NOT the injected-context estimate the board meter shows
type UsageSplit = { input_tokens: number; cache_read: number; cache_creation: number; output_tokens: number }
const usageIn = (u: UsageSplit) => u.input_tokens + u.cache_read + u.cache_creation
const usageSum = (u?: UsageSplit) => (u ? usageIn(u) + u.output_tokens : 0)
const fmtSecs = (s: number) => s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`
const readableError = (cause: unknown) => {
  const raw = cause instanceof Error ? cause.message : 'The action could not be completed.'
  try { return JSON.parse(raw).error ?? raw } catch { return raw }
}

// a tool ask parked by the daemon's canUseTool handler, waiting for allow/deny
type PendingPermission = { id: string; tool: string; summary: string; title: string | null; at: string }

// a slash-menu entry; source 'sdk' = the session's real command list, anything else
// (e.g. 'orchestra' from card #44's extraCommands) renders a .cc-cmd-badge
export type CommandItem = { name: string; description: string; source: string }

const LOCAL_CONSOLE_COMMANDS: CommandItem[] = [
  { name: 'commands', description: 'show only the actions available in this console', source: 'orchestra' },
  { name: 'status', description: 'show this session’s model, mode, and location', source: 'orchestra' },
  { name: 'usage', description: 'show token and cost accounting for this session', source: 'orchestra' },
  { name: 'clear', description: 'clear this console view without erasing session memory', source: 'orchestra' },
]

// permission modes the daemon accepts (POST /agents/:id/permission-mode)
const PERMISSION_MODES = [
  { value: 'bypassPermissions', label: 'autonomous', hint: 'runs without approval prompts' },
  { value: 'acceptEdits', label: 'edit', hint: 'edits auto-approved · other tools ask below' },
  { value: 'plan', label: 'plan', hint: 'read-only · tools ask below' },
]

// Model catalogs use `value`; `model` remains accepted for older daemon payloads.
type ModelInfo = { value?: string; model?: string; resolvedModel?: string; displayName?: string; supportedEffortLevels?: string[] }

function ModelEffortControls({ agentId, info, working, onChange, onError }: {
  agentId: number
  info: { model: string | null; effort?: string | null; models?: ModelInfo[] } | null
  working: boolean
  onChange: () => void
  onError: (error: unknown) => void
}) {
  const models = info?.models ?? []
  if (models.length === 0) return null
  const current = models.find((model) => {
    const value = sessionModelValue(model)
    return value === info?.model || model.resolvedModel === info?.model
  })
  const currentValue = current ? sessionModelValue(current) : info?.model ?? ''
  const levels = current?.supportedEffortLevels ?? []
  return (
    <span className="cc-model-effort">
      <select className="cc-mode-select" value={currentValue} aria-label="Model"
        title="Model used by this session"
        onChange={async (event) => {
          if (!event.target.value) return
          try {
            await api('POST', `/agents/${agentId}/model`, { model: event.target.value })
            onChange()
          } catch (cause) { onError(cause) }
        }}>
        {!current && currentValue && <option value={currentValue}>{currentValue}</option>}
        {models.map((model, index) => {
          const value = sessionModelValue(model)
          return value ? <option key={value || index} value={value}>{model.displayName ?? value}</option> : null
        })}
      </select>
      {levels.length > 0 && (
        <span className="cc-effort" role="group" aria-label="Reasoning effort"
          title={working ? 'Wait for the current turn to finish' : 'Change reasoning effort'}>
          {levels.map((level) => (
            <button type="button" key={level} disabled={working}
              className={`cc-effort-btn${(info?.effort ?? '') === level ? ' cc-effort-on' : ''}`}
              onClick={async () => {
                if ((info?.effort ?? '') === level) return
                try {
                  await api('POST', `/agents/${agentId}/effort`, { level })
                  onChange()
                } catch (cause) { onError(cause) }
              }}>{level === 'medium' ? 'med' : level}</button>
          ))}
        </span>
      )}
    </span>
  )
}

function PermissionModeHint({ agentId, mode, onChange, onError }: {
  agentId: number
  mode: string
  onChange: () => void
  onError: (error: unknown) => void
}) {
  const m = PERMISSION_MODES.find((x) => x.value === mode) ?? PERMISSION_MODES[0]
  return (
    <span className="cc-mode">
      <span className="cc-mode-dot" aria-hidden="true" />
      <select className="cc-mode-select" value={m.value} aria-label="Permission mode"
        title={`${m.hint}. Shift+Tab also cycles modes.`}
        onChange={async (event) => {
          try {
            await api('POST', `/agents/${agentId}/permission-mode`, { mode: event.target.value })
            onChange()
          } catch (cause) { onError(cause) }
        }}>
        {PERMISSION_MODES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
      </select>
      <span className="cc-dim">{m.hint}</span>
    </span>
  )
}

export function AgentTerminal({ agent, boardId, threads, cards = [], embedded = false, extraCommands = BOARD_COMMANDS, onClose, onChange }:
  { agent: Agent; boardId: number; threads: Thread[]; cards?: Card[]; embedded?: boolean; extraCommands?: CommandItem[]; onClose: () => void; onChange: () => void }) {
  const hired = agent.kind === 'hired'
  const [lines, setLines] = useState<Line[]>([])
  const [turn, setTurn] = useState<{ secs: number; tokens: number } | null>(null)
  const [info, setInfo] = useState<{ model: string | null; cwd: string; tokens: number; permissionMode?: string; commands?: { name: string; description: string }[]; effort?: string | null; models?: ModelInfo[]; costUsd?: number; usage?: { turn: UsageSplit; session: UsageSplit } } | null>(null)
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
        const i = r.info ?? null
        if (prev && i && prev.tokens === i.tokens && prev.model === i.model && prev.permissionMode === i.permissionMode &&
          (prev.commands?.length ?? 0) === (i.commands?.length ?? 0) &&
          prev.commands?.[0]?.description === i.commands?.[0]?.description &&
          prev.effort === i.effort && (prev.models?.length ?? 0) === (i.models?.length ?? 0) &&
          usageSum(prev.usage?.session) + usageSum(prev.usage?.turn) === usageSum(i.usage?.session) + usageSum(i.usage?.turn)) return prev
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
  }, [agent.id, hired])

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

  const cyclePermissionMode = async () => {
    if (!hired) return
    const current = PERMISSION_MODES.findIndex((mode) => mode.value === (info?.permissionMode ?? 'bypassPermissions'))
    const next = PERMISSION_MODES[(current + 1 + PERMISSION_MODES.length) % PERMISSION_MODES.length]
    try { await api('POST', `/agents/${agent.id}/permission-mode`, { mode: next.value }) } catch { /* agent gone or daemon too old */ }
    onChange()
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
        `Access: ${info?.permissionMode ?? 'initializing'}`,
        cwdLabel ? `Workspace: ${cwdLabel}` : '',
      ].filter(Boolean).join('\n'))
      return
    }

    const session = info?.usage?.session
    const active = info?.usage?.turn
    const inputTokens = (session ? usageIn(session) : 0) + (active ? usageIn(active) : 0)
    const outputTokens = (session?.output_tokens ?? 0) + (active?.output_tokens ?? 0)
    const cost = typeof info?.costUsd === 'number' && info.costUsd > 0 ? ` · $${info.costUsd.toFixed(4)}` : ''
    echoLocal('status', `Session usage: ${fmtTokens(inputTokens)} input · ${fmtTokens(outputTokens)} output${cost}`)
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
      setSubmitError(readableError(cause))
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
    if (hired && working) { await api('POST', `/agents/${agent.id}/interrupt`); onChange() }
  }

  const decide = async (requestId: string, behavior: 'allow' | 'deny') => {
    try { await api('POST', `/agents/${agent.id}/permissions/${encodeURIComponent(requestId)}`, { behavior }) } catch { /* already resolved */ }
    setPerms((prev) => prev.filter((p) => p.id !== requestId))
  }

  const renderLine = (l: Line, i: number) => {
    switch (l.kind) {
      case 'user':
        return <p key={i} className="cc-user">{l.text}</p>
      case 'tool': {
        const paren = l.text.indexOf('(')
        const name = paren === -1 ? l.text : l.text.slice(0, paren)
        const args = paren === -1 ? '' : l.text.slice(paren)
        return <p key={i} className="cc-tool"><b>{name}</b>{args}</p>
      }
      case 'tool_result':
        return <p key={i} className={`cc-result${transcriptExpanded ? '' : ' is-collapsed'}`}
          title={transcriptExpanded ? undefined : 'Ctrl+O to expand transcript details'}>{l.text}</p>
      case 'thinking':
        return <p key={i} className={`cc-thinking${transcriptExpanded ? '' : ' is-collapsed'}`}>{l.text}</p>
      case 'status':
        return <p key={i} className="cc-status">{l.text}</p>
      case 'error':
        return <p key={i} className="cc-error">{l.text}</p>
      default:
        return <p key={i} className="cc-text">{l.text}</p>
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
            e.preventDefault(); void cyclePermissionMode(); return
          }
          if (e.altKey && key === 'p' && hired) {
            e.preventDefault(); setControlPanel('model'); return
          }
          if (e.ctrlKey && key === 'o') {
            e.preventDefault(); setTranscriptExpanded((expanded) => !expanded); return
          }
          if (e.ctrlKey && key === 'l') {
            e.preventDefault(); jumpToLatest(); return
          }
          if (e.key === 'Escape') {
            e.preventDefault()
            if (hired && working) void interrupt()
            else if (!embedded) onClose()
          }
        }}>
        <div className="terminal-col">
          <header className="cc-head">
            <span className="cc-head-status" aria-hidden="true" />
            <strong>{agent.name}</strong>
            <span className="cc-head-dim">{hired ? `hired agent · ${agent.status}` : `board conversation · ${agent.status}`}</span>
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
              {hired && (
                <button type="button" className="cc-head-action cc-head-stop"
                  title="Stop this agent — terminates its session; a launched ticket moves to blocked"
                  onClick={async () => { await api('POST', `/agents/${agent.id}/fire`); onChange(); onClose() }}>stop</button>
              )}
              {!embedded && <button type="button" className="cc-head-close" onClick={onClose} aria-label="Close console" title="Close console">close</button>}
            </div>
          </header>

          <div className="cc-history-shell">
            <div className="terminal-scroll" ref={scrollRef} onScroll={onScroll} onWheel={onWheel}>
              <div className="terminal-feed" ref={feedRef}>
                {hired && !hasConversationActivity && (
                  <div className="cc-welcome">
                    <p>Welcome to <b>Orchestra</b></p>
                    <p className="cc-welcome-sub">{agent.name} · {agent.status} · autonomous session</p>
                  </div>
                )}
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
                    <p className="cc-perm-kicker">Agent requests access to {p.tool}</p>
                    <p className="cc-perm-title"><b>{p.title ?? p.summary}</b></p>
                    <div className="cc-perm-actions">
                      <button className="cc-perm-allow" onClick={() => decide(p.id, 'allow')}><span>1.</span> Allow once</button>
                      <button className="cc-perm-deny" onClick={() => decide(p.id, 'deny')}><span>2.</span> Deny</button>
                    </div>
                    <p className="cc-perm-help">Choose an option to continue</p>
                  </div>
                ))}
                {working && turn && (
                  <div className="cc-working" role="status">
                    <span className="cc-working-dot" aria-hidden="true" />
                    <span>Working · {fmtSecs(turn.secs)}{turn.tokens > 0 && <> · {fmtTokens(turn.tokens)} output tokens</>}</span>
                    <button type="button" onClick={interrupt}>Interrupt</button>
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
                {visibleCommands.map((c, i) => (
                  <button type="button" key={`${c.source}:${c.name}`} role="option" aria-selected={i === menuIdx}
                    className={i === menuIdx ? 'cc-slash-item active' : 'cc-slash-item'}
                    onMouseEnter={() => setMenuIdx(i)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => activateCommand(c)}>
                    <span className="cc-slash-name">/{c.name}</span>
                    {c.source !== 'session' && <span className="cc-cmd-badge" data-source={c.source}>{c.source}</span>}
                    <span className="cc-slash-desc">{c.description}</span>
                  </button>
                ))}
                {filtered.length > 10 && <div className="cc-slash-more">{filtered.length - 10} more · keep typing</div>}
              </div>
            )}
            <div className="cc-promptbox" data-mode={info?.permissionMode ?? 'bypassPermissions'}>
              <span className="cc-prompt-caret" aria-hidden="true">›</span>
              <textarea ref={inputRef} autoFocus value={input} rows={1}
                placeholder={convo.length === 0 ? (hired ? 'Describe what this agent should do…' : `Message ${agent.name}`) : 'Write a follow-up…'}
                onChange={(e) => { setInput(e.target.value); setHistoryIdx(null); setSubmitError(null) }}
                onKeyDown={promptKeys} />
              <button type="button" className="cc-send" disabled={!input.trim() || sending}
                onClick={() => void send()}>{sending ? 'sending' : 'send'}</button>
            </div>
            {submitError && <p className="cc-submit-error" role="alert">{submitError}</p>}
          </div>
          <div className="cc-hints">
            {hired
              ? <span className="cc-controls">
                  <PermissionModeHint agentId={agent.id} mode={info?.permissionMode ?? 'bypassPermissions'}
                    onChange={onChange} onError={(cause) => setSubmitError(readableError(cause))} />
                  <ModelEffortControls agentId={agent.id} info={info} working={working} onChange={onChange}
                    onError={(cause) => setSubmitError(readableError(cause))} />
                </span>
              : <span>enter to send · shift+enter for newline</span>}
            <span className="cc-session-meta" title={info?.cwd}>
              {cwdLabel || info?.cwd || ''}{info?.model && !(info?.models?.length) ? ` · ${info.model}` : ''}
              {info?.usage && usageSum(info.usage.session) + usageSum(info.usage.turn) > 0 ? (() => {
                // live turn accrual counts toward the session display so the split never lags the ↓ number
                const s = info.usage.session, t = info.usage.turn
                const inTok = usageIn(s) + usageIn(t), outTok = s.output_tokens + t.output_tokens
                const cached = inTok > 0 ? Math.round(100 * (s.cache_read + t.cache_read) / inTok) : 0
                const tip = `real API tokens this session — input ${fmtTokens(s.input_tokens + t.input_tokens)} · cache read ${fmtTokens(s.cache_read + t.cache_read)} · cache write ${fmtTokens(s.cache_creation + t.cache_creation)} · output ${fmtTokens(outTok)} (distinct from the board meter's injected-context estimate)`
                return <span title={tip}> · {fmtTokens(inTok)} in · {cached}% cached · {fmtTokens(outTok)} out</span>
              })() : info && info.tokens > 0 ? ` · ${fmtTokens(info.tokens)} output tokens` : ''}
              {!hired ? ' · delivered on its next turn' : ''}
            </span>
          </div>
        </div>
      </aside>
    </>
  )
}
