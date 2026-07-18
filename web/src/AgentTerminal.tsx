import React, { useEffect, useRef, useState } from 'react'
import { api, Agent, Card, Thread } from './api'
import { BOARD_COMMANDS, isBoardCommand, runBoardCommand } from './boardCommands'

type Line = { at?: string; kind: 'text' | 'status' | 'error' | 'user' | 'tool' | 'tool_result' | 'thinking'; text: string }

// claude-code's whimsical working gerunds
const GERUNDS = ['Pondering', 'Cerebrating', 'Noodling', 'Waddling', 'Percolating', 'Ruminating',
  'Marinating', 'Brewing', 'Conjuring', 'Scheming', 'Tinkering', 'Musing', 'Whirring', 'Puzzling',
  'Simmering', 'Crunching', 'Weaving', 'Hatching', 'Composing', 'Orchestrating', 'Grooving', 'Vibing']

const fmtTokens = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
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
  { value: 'plan', icon: '⏸', label: 'plan mode', hint: 'read-only · tools ask below' },
]

// container for the mode toggle — #40's command menu and #41's model/effort selectors slot in beside it
function PermissionModeHint({ agentId, mode, onChange }: { agentId: number; mode: string; onChange: () => void }) {
  const m = PERMISSION_MODES.find((x) => x.value === mode) ?? PERMISSION_MODES[0]
  return (
    <span className="cc-mode">
      {m.icon}{' '}
      <select className="cc-mode-select" value={m.value} aria-label="Permission mode"
        title="Permission mode — applies live to this agent's session"
        onChange={async (e) => {
          try { await api('POST', `/agents/${agentId}/permission-mode`, { mode: e.target.value }) } catch { /* agent gone or daemon too old */ }
          onChange()
        }}>
        {PERMISSION_MODES.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
      </select>
      <span className="cc-dim">({m.hint})</span>
    </span>
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
  const [info, setInfo] = useState<{ model: string | null; cwd: string; tokens: number; permissionMode?: string; commands?: { name: string; description: string }[] } | null>(null)
  const [perms, setPerms] = useState<PendingPermission[]>([])
  // board-command echo lives only in this client — the daemon transcript never sees it (zero tokens)
  const [localLines, setLocalLines] = useState<Line[]>([])
  const echoLocal = (kind: Line['kind'], text: string) =>
    setLocalLines((prev) => [...prev.slice(-99), { at: new Date().toISOString(), kind, text }])
  const [input, setInput] = useState('')
  const [gerund, setGerund] = useState(() => GERUNDS[Math.floor(Math.random() * GERUNDS.length)])
  const scrollRef = useRef<HTMLDivElement>(null)
  const firstScroll = useRef(true)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  // grow the prompt box with its content, up to a cap — like the real cli
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`
  }, [input])
  useEffect(() => { firstScroll.current = true; setLocalLines([]) }, [agent.id])

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
          prev.commands?.[0]?.description === i.commands?.[0]?.description) return prev
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

  // on open: jump straight to the latest messages; afterwards auto-follow only near the bottom
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    if (firstScroll.current && convo.length > 0) {
      el.scrollTo({ top: el.scrollHeight })
      firstScroll.current = false
      return
    }
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 140
    if (nearBottom) el.scrollTo({ top: el.scrollHeight })
  }, [convo.length, working])

  const send = async () => {
    const text = input.trim()
    if (!text) return
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

  const promptKeys = (e: React.KeyboardEvent) => {
    if (menuOpen) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setMenuIdx((i) => (i + 1) % filtered.length); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); setMenuIdx((i) => (i - 1 + filtered.length) % filtered.length); return }
      if (e.key === 'Tab' || e.key === 'Enter') { e.preventDefault(); complete(filtered[Math.min(menuIdx, filtered.length - 1)]); return }
      // dismiss the menu only — must not bubble to the terminal's interrupt/close handler
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setMenuHidden(true); return }
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
            <span className="cc-head-dim">{hired ? `hired agent · ${agent.status}` : `terminal session · ${agent.status}`}</span>
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
            {hired && (
              <button className="cc-close" title="Stop this agent — terminates its session; a launched ticket moves to blocked"
                onClick={async () => { await api('POST', `/agents/${agent.id}/fire`); onChange(); onClose() }}>■ stop</button>
            )}
            {!embedded && <button className="cc-close" onClick={onClose} aria-label="Close">esc·close ×</button>}
          </header>

          <div className="terminal-scroll" ref={scrollRef}>
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
                <div className="cc-perm-actions">
                  <button className="cc-perm-allow" onClick={() => decide(p.id, 'allow')}>✓ allow</button>
                  <button className="cc-perm-deny" onClick={() => decide(p.id, 'deny')}>✗ deny</button>
                </div>
              </div>
            ))}
            {working && turn && (
              <p className="cc-spinner">
                <span className="cc-star-frame">{star}</span> {gerund}… (<button className="cc-esc" onClick={interrupt}>esc</button> to interrupt · {fmtSecs(turn.secs)}
                {turn.tokens > 0 && <> · ↓ {fmtTokens(turn.tokens)} tokens</>})
              </p>
            )}
          </div>

          <div className="cc-prompt-wrap">
            {menuOpen && (
              <div className="cc-slash-menu" role="listbox" aria-label="Slash commands">
                {filtered.slice(0, 10).map((c, i) => (
                  <div key={`${c.source}:${c.name}`} role="option" aria-selected={i === menuIdx}
                    className={i === menuIdx ? 'cc-slash-item active' : 'cc-slash-item'}
                    onMouseEnter={() => setMenuIdx(i)}
                    onMouseDown={(e) => { e.preventDefault(); complete(c) }}>
                    <span className="cc-slash-name">/{c.name}</span>
                    {c.source !== 'sdk' && <span className="cc-cmd-badge" data-source={c.source}>{c.source}</span>}
                    <span className="cc-slash-desc">{c.description}</span>
                  </div>
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
              ? <PermissionModeHint agentId={agent.id} mode={info?.permissionMode ?? 'bypassPermissions'} onChange={onChange} />
              : <span>enter to send · shift+enter for newline</span>}
            <span>
              {info?.cwd ?? ''}{info?.model ? ` · ${info.model}` : ''}
              {info && info.tokens > 0 ? ` · ↓ ${fmtTokens(info.tokens)} tokens` : ''}
              {!hired ? ' · delivered on its next turn' : ''}
            </span>
          </div>
        </div>
      </aside>
    </>
  )
}
