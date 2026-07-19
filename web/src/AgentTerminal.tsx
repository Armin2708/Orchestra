import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { api, Agent, Card, Thread } from './api'
import { BOARD_COMMANDS, isBoardCommand, runBoardCommand } from './boardCommands'
import { followIntent } from './follow'
import { AgentControlPanel } from './AgentControlPanel'
import { normalizeSlashCommandName, panelForSlashCommand, panelForSlashInput, type AgentControlPanelName } from './agentTerminalControls'
import './claudeTerminal.css'

type Line = { at?: string; kind: 'text' | 'status' | 'error' | 'user' | 'tool' | 'tool_result' | 'thinking'; text: string }

// claude-code's whimsical working gerunds
const GERUNDS = ['Pondering', 'Cerebrating', 'Noodling', 'Waddling', 'Percolating', 'Ruminating',
  'Marinating', 'Brewing', 'Conjuring', 'Scheming', 'Tinkering', 'Musing', 'Whirring', 'Puzzling',
  'Simmering', 'Crunching', 'Weaving', 'Hatching', 'Composing', 'Orchestrating', 'Grooving', 'Vibing']

const fmtTokens = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)

// real API token split (input / cache-read / cache-creation / output) — from result-message
// usage, NOT the injected-context estimate the board meter shows
type UsageSplit = { input_tokens: number; cache_read: number; cache_creation: number; output_tokens: number }
const usageIn = (u: UsageSplit) => u.input_tokens + u.cache_read + u.cache_creation
const usageSum = (u?: UsageSplit) => (u ? usageIn(u) + u.output_tokens : 0)
const fmtSecs = (s: number) => s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`

// a tool ask parked by the daemon's canUseTool handler, waiting for allow/deny
type PendingPermission = { id: string; tool: string; summary: string; title: string | null; at: string }

// a slash-menu entry; source 'sdk' = the session's real command list, anything else
// (e.g. 'orchestra' from card #44's extraCommands) renders a .cc-cmd-badge
export type CommandItem = { name: string; description: string; source: string }

// permission modes the daemon accepts (POST /agents/:id/permission-mode)
const PERMISSION_MODES = [
  { value: 'bypassPermissions', icon: '⏵⏵', label: 'bypass permissions', hint: 'runs autonomously' },
  { value: 'acceptEdits', icon: '⏵', label: 'accept edits', hint: 'edits auto-approved · other tools ask below' },
  { value: 'plan', icon: '⏸', label: 'plan', hint: 'read-only · tools ask below' },
]

// a model entry from the SDK's supportedModels(), surfaced via transcript info
type ModelInfo = { model: string; resolvedModel?: string; displayName?: string; supportedEffortLevels?: string[] }

// Claude Code keeps effort as a compact status above the prompt. Clicking it opens the
// same model picker as /model; the picker owns model and effort changes.
function ModelEffortControls({ info, onOpen }: {
  info: { model: string | null; effort?: string | null; models?: ModelInfo[] } | null
  onOpen: () => void
}) {
  const models = info?.models ?? []
  if (models.length === 0 && !info?.effort) return null
  return (
    <button type="button" className="cc-effort-status" onClick={onOpen}
      aria-label={`Open model and effort picker. Current effort: ${info?.effort ?? 'default'}`}>
      <span aria-hidden="true">●</span> {info?.effort ?? 'default'} <span className="cc-dim">· /effort</span>
    </button>
  )
}

// Claude Code cycles modes instead of exposing a browser-native select. The parent owns the
// API call so click and Shift+Tab share one path.
function PermissionModeHint({ mode, onCycle }: { mode: string; onCycle: () => void }) {
  const m = PERMISSION_MODES.find((x) => x.value === mode) ?? PERMISSION_MODES[0]
  return (
    <button type="button" className={`cc-mode cc-mode-${m.value}`} onClick={onCycle}
      title={`${m.hint}. Shift+Tab to cycle.`}>
      <span aria-hidden="true">{m.icon}</span> {m.label} mode on <span className="cc-dim">(shift+tab to cycle)</span>
    </button>
  )
}

// the claude spinner glyph frames
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
  const [info, setInfo] = useState<{ model: string | null; cwd: string; tokens: number; permissionMode?: string; commands?: { name: string; description: string }[]; effort?: string | null; models?: ModelInfo[]; usage?: { turn: UsageSplit; session: UsageSplit } } | null>(null)
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
  const [gerund, setGerund] = useState(() => GERUNDS[Math.floor(Math.random() * GERUNDS.length)])
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

  // rotate the working word every so often, like the real thing
  useEffect(() => {
    if (!turn) return
    const t = setInterval(() => setGerund(GERUNDS[Math.floor(Math.random() * GERUNDS.length)]), 9000)
    return () => clearInterval(t)
  }, [turn !== null])

  // session is booting until the SDK reports init
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

  const send = async () => {
    const text = input.trim()
    if (!text) return
    setPromptHistory((prev) => prev[prev.length - 1] === text ? prev : [...prev, text].slice(-100))
    setHistoryIdx(null)
    setHistoryDraft('')
    const nativePanel = hired ? panelForSlashInput(text) : null
    if (nativePanel) {
      setInput('')
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
    ...(info?.commands ?? []).map((c) => ({ ...c, name: normalizeSlashCommandName(c.name), source: 'sdk' })),
    ...extraCommands.map((c) => ({ ...c, name: normalizeSlashCommandName(c.name) })),
  ]
  const slashTerm = hired && input.startsWith('/') && !/[\s]/.test(input) ? input.slice(1) : null
  const filtered = slashTerm !== null
    ? menuItems
      .filter((item, index, all) => all.findIndex((candidate) => candidate.name === item.name) === index)
      .filter((c) => c.name.toLowerCase().includes(slashTerm.toLowerCase()))
      .sort((a, b) => Number(!a.name.toLowerCase().startsWith(slashTerm.toLowerCase())) - Number(!b.name.toLowerCase().startsWith(slashTerm.toLowerCase())))
    : []
  const visibleCommands = filtered.slice(0, 10)
  const menuOpen = visibleCommands.length > 0 && !menuHidden
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
        return <div key={i} className="cc-line cc-user"><span className="cc-line-mark" aria-hidden="true">❯</span><p>{l.text}</p></div>
      case 'tool': {
        const paren = l.text.indexOf('(')
        const name = paren === -1 ? l.text : l.text.slice(0, paren)
        const args = paren === -1 ? '' : l.text.slice(paren)
        return <div key={i} className="cc-line cc-tool"><span className="cc-line-mark tool" aria-hidden="true">⏺</span><p><b>{name}</b>{args}</p></div>
      }
      case 'tool_result':
        return <div key={i} className={`cc-line cc-result${transcriptExpanded ? '' : ' is-collapsed'}`}
          title={transcriptExpanded ? undefined : 'Ctrl+O to expand transcript details'}>
          <span className="cc-line-mark" aria-hidden="true">⎿</span><p>{l.text}</p>
        </div>
      case 'thinking':
        return <div key={i} className={`cc-line cc-thinking${transcriptExpanded ? '' : ' is-collapsed'}`}>
          <span className="cc-line-mark" aria-hidden="true">✻</span><p>{l.text}</p>
        </div>
      case 'status':
        return <div key={i} className="cc-line cc-status"><span className="cc-line-mark" /><p>{l.text}</p></div>
      case 'error':
        return <div key={i} className="cc-line cc-error"><span className="cc-line-mark" aria-hidden="true">!</span><p>{l.text}</p></div>
      default:
        return <div key={i} className="cc-line cc-text"><span className="cc-line-mark" aria-hidden="true">⏺</span><p>{l.text}</p></div>
    }
  }

  const currentModel = info?.models?.find((model) => model.model === info.model || model.resolvedModel === info.model)
  const modelLabel = currentModel?.displayName ?? info?.model ?? 'Claude'
  const cwdLabel = info?.cwd?.replace(/^\/(?:Users|home)\/[^/]+/, '~') ?? ''

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
          if (e.key === 'Escape' && hired && working) {
            e.preventDefault(); void interrupt()
          }
        }}>
        <div className="terminal-col">
          <header className="cc-head">
            <div className="cc-head-identity">
              <span className="cc-head-star" aria-hidden="true">✻</span>
              <span><strong>{agent.name}</strong><small>{hired ? 'Claude Code agent' : 'board terminal'} · {agent.status}</small></span>
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
              {hired && (
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
                {hired && (
                  <div className="cc-welcome">
                    <div className="cc-claude-mark" aria-hidden="true">
                      <span>▐▛███▜▌</span>
                      <span>▝▜█████▛▘</span>
                      <span>&nbsp; ▘▘ ▝▝</span>
                    </div>
                    <div className="cc-welcome-copy">
                      <p><b>Claude Code</b></p>
                      <p>{modelLabel}{info?.effort ? ` with ${info.effort} effort` : ''} · {agent.name}</p>
                      <p title={info?.cwd}>{cwdLabel || 'Starting session…'}</p>
                    </div>
                  </div>
                )}
                {convo.map(renderLine)}
                {booting && (
                  <p className="cc-spinner"><span className="cc-star-frame">{star}</span> {bootMsg}</p>
                )}
                {!booting && convo.length === 0 && (
                  <div className="cc-line cc-status"><span className="cc-line-mark" />
                    <p>{hired ? 'No activity yet — type a prompt below.' : 'No board conversation with this agent yet.'}</p>
                  </div>
                )}
                {hired && perms.map((p) => (
                  <div key={p.id} className="cc-perm" role="group" aria-label="Permission request">
                    <p className="cc-perm-kicker">Claude wants to use {p.tool}</p>
                    <p className="cc-perm-title"><b>{p.title ?? p.summary}</b></p>
                    <div className="cc-perm-actions">
                      <button className="cc-perm-allow" onClick={() => decide(p.id, 'allow')}><span>1.</span> Allow once</button>
                      <button className="cc-perm-deny" onClick={() => decide(p.id, 'deny')}><span>2.</span> Deny</button>
                    </div>
                    <p className="cc-perm-help">Choose an option to continue</p>
                  </div>
                ))}
                {working && turn && (
                  <p className="cc-spinner">
                    <span className="cc-star-frame">{star}</span> {gerund}… (<button className="cc-esc" onClick={interrupt}>esc</button> to interrupt · {fmtSecs(turn.secs)}
                    {turn.tokens > 0 && <> · ↓ {fmtTokens(turn.tokens)} tokens</>})
                  </p>
                )}
              </div>
            </div>
            {!following && <button type="button" className="cc-follow-latest" onClick={jumpToLatest}>↓ Jump to latest</button>}
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
                    <span className="cc-slash-marker" aria-hidden="true">{i === menuIdx ? '❯' : ''}</span>
                    <span className="cc-slash-name">/{c.name}</span>
                    {c.source !== 'sdk' && <span className="cc-cmd-badge" data-source={c.source}>[{c.source}]</span>}
                    <span className="cc-slash-desc">{c.description}</span>
                  </button>
                ))}
                <div className="cc-slash-footer">
                  <span>↑/↓ to navigate · Enter to select · Esc to cancel</span>
                  {filtered.length > 10 && <span>{filtered.length - 10} more</span>}
                </div>
              </div>
            )}
            {hired && <div className="cc-prompt-meta">
              <ModelEffortControls info={info} onOpen={() => setControlPanel('model')} />
            </div>}
            <div className="cc-promptbox" data-mode={info?.permissionMode ?? 'bypassPermissions'}>
              <span className="cc-prompt-caret" aria-hidden="true">❯</span>
              <textarea ref={inputRef} autoFocus value={input} rows={1}
                placeholder={convo.length === 0 ? (hired ? 'Try “review the current changes”' : `Message ${agent.name}`) : ''}
                onChange={(e) => { setInput(e.target.value); setHistoryIdx(null) }}
                onKeyDown={promptKeys} />
            </div>
          </div>
          <div className="cc-statusline">
            <span title={info?.cwd}>{modelLabel}{cwdLabel ? ` · ${cwdLabel}` : ''}</span>
            <span>
              {info?.usage && usageSum(info.usage.session) + usageSum(info.usage.turn) > 0 ? (() => {
                // live turn accrual counts toward the session display so the split never lags the ↓ number
                const s = info.usage.session, t = info.usage.turn
                const inTok = usageIn(s) + usageIn(t), outTok = s.output_tokens + t.output_tokens
                const cached = inTok > 0 ? Math.round(100 * (s.cache_read + t.cache_read) / inTok) : 0
                const tip = `real API tokens this session — input ${fmtTokens(s.input_tokens + t.input_tokens)} · cache read ${fmtTokens(s.cache_read + t.cache_read)} · cache write ${fmtTokens(s.cache_creation + t.cache_creation)} · output ${fmtTokens(outTok)} (distinct from the board meter's injected-context estimate)`
                return <span title={tip}>↑ {fmtTokens(inTok)} in · {cached}% cached · ↓ {fmtTokens(outTok)} out</span>
              })() : info && info.tokens > 0 ? `↓ ${fmtTokens(info.tokens)} tokens` : ''}
              {!hired ? ' · delivered on its next turn' : ''}
            </span>
          </div>
          <div className="cc-hints">
            {hired
              ? <PermissionModeHint mode={info?.permissionMode ?? 'bypassPermissions'} onCycle={() => void cyclePermissionMode()} />
              : <span>enter to send · shift+enter for newline</span>}
            <span className="cc-key-hints">
              <button type="button" onClick={() => setTranscriptExpanded((expanded) => !expanded)}>ctrl+o {transcriptExpanded ? 'compact' : 'details'}</button>
              {hired && <button type="button" onClick={() => setControlPanel('model')}>alt+p model</button>}
            </span>
          </div>
        </div>
      </aside>
    </>
  )
}
