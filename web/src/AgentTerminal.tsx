import React, { useEffect, useRef, useState } from 'react'
import { api, Agent, Thread } from './api'

type Line = { at?: string; kind: 'text' | 'status' | 'error' | 'user' | 'tool' | 'tool_result' | 'thinking'; text: string }

// claude-code's whimsical working gerunds
const GERUNDS = ['Pondering', 'Cerebrating', 'Noodling', 'Waddling', 'Percolating', 'Ruminating',
  'Marinating', 'Brewing', 'Conjuring', 'Scheming', 'Tinkering', 'Musing', 'Whirring', 'Puzzling',
  'Simmering', 'Crunching', 'Weaving', 'Hatching', 'Composing', 'Orchestrating', 'Grooving', 'Vibing']

const fmtTokens = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
const fmtSecs = (s: number) => s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`

// the claude spinner glyph frames
const STARS = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢']
const BOOT_MSGS = [
  'Warming up the orchestra…', 'Tuning instruments…', 'Raising the baton…',
  'Finding a seat in the pit…', 'Rosining the bow…', 'Clearing the throat…',
]

export function AgentTerminal({ agent, boardId, threads, onClose, onChange }:
  { agent: Agent; boardId: number; threads: Thread[]; onClose: () => void; onChange: () => void }) {
  const hired = agent.kind === 'hired'
  const [lines, setLines] = useState<Line[]>([])
  const [turn, setTurn] = useState<{ secs: number; tokens: number } | null>(null)
  const [info, setInfo] = useState<{ model: string | null; cwd: string; tokens: number } | null>(null)
  const [input, setInput] = useState('')
  const [gerund, setGerund] = useState(() => GERUNDS[Math.floor(Math.random() * GERUNDS.length)])
  const scrollRef = useRef<HTMLDivElement>(null)

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
        if (prev && i && prev.tokens === i.tokens && prev.model === i.model) return prev
        return i
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

  const convo: Line[] = hired ? lines : [...threads]
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

  // auto-follow only when already near the bottom — manual scrolling stays untouched
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 140
    if (nearBottom) el.scrollTo({ top: el.scrollHeight })
  }, [convo.length, working])

  const send = async () => {
    if (!input.trim()) return
    if (hired) await api('POST', `/agents/${agent.id}/task`, { text: input.trim() })
    else await api('POST', '/messages', { board_id: boardId, to: agent.name, body: input.trim() })
    setInput(''); onChange()
  }

  const interrupt = async () => {
    if (hired && working) { await api('POST', `/agents/${agent.id}/interrupt`); onChange() }
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
      <div className="scrim" onClick={onClose} />
      <aside className="terminal" onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); interrupt() } }}>
        <div className="terminal-col">
          <header className="cc-head">
            <span className="cc-head-star">✻</span>
            <span>{agent.name}</span>
            <span className="cc-head-dim">{hired ? `hired agent · ${agent.status}` : `terminal session · ${agent.status}`}</span>
            <button className="cc-close" onClick={onClose} aria-label="Close">esc·close ×</button>
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
            {working && turn && (
              <p className="cc-spinner">
                <span className="cc-star-frame">{star}</span> {gerund}… (<button className="cc-esc" onClick={interrupt}>esc</button> to interrupt · {fmtSecs(turn.secs)}
                {turn.tokens > 0 && <> · ↓ {fmtTokens(turn.tokens)} tokens</>})
              </p>
            )}
          </div>

          <div className="cc-promptbox">
            <span className="cc-prompt-caret">&gt;</span>
            <textarea autoFocus value={input} rows={1}
              placeholder=""
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }} />
          </div>
          <div className="cc-hints">
            {hired
              ? <span className="cc-mode">⏵⏵ bypass permissions on <span className="cc-dim">(hired agents run autonomously)</span></span>
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
