import React, { useEffect, useRef, useState } from 'react'
import { api, Agent, Thread } from './api'

type Line = { at?: string; kind: 'text' | 'status' | 'error' | 'user' | 'tool' | 'tool_result' | 'thinking'; text: string }

// claude-code's whimsical working gerunds
const GERUNDS = ['Pondering', 'Cerebrating', 'Noodling', 'Waddling', 'Percolating', 'Ruminating',
  'Marinating', 'Brewing', 'Conjuring', 'Scheming', 'Tinkering', 'Musing', 'Whirring', 'Puzzling',
  'Simmering', 'Crunching', 'Weaving', 'Hatching', 'Composing', 'Orchestrating', 'Grooving', 'Vibing']

const fmtTokens = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
const fmtSecs = (s: number) => s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`

export function AgentTerminal({ agent, boardId, threads, onClose, onChange }:
  { agent: Agent; boardId: number; threads: Thread[]; onClose: () => void; onChange: () => void }) {
  const hired = agent.kind === 'hired'
  const [lines, setLines] = useState<Line[]>([])
  const [turn, setTurn] = useState<{ secs: number; tokens: number } | null>(null)
  const [input, setInput] = useState('')
  const [gerund, setGerund] = useState(() => GERUNDS[Math.floor(Math.random() * GERUNDS.length)])
  const scrollRef = useRef<HTMLDivElement>(null)

  // hired agents stream their real transcript; terminal agents show the board conversation
  useEffect(() => {
    if (!hired) return
    let alive = true
    const load = () => api('GET', `/agents/${agent.id}/transcript`).then((r) => {
      if (!alive) return
      setLines(r.lines ?? r)
      setTurn(r.working ?? null)
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

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
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
            {convo.map(renderLine)}
            {convo.length === 0 && (
              <p className="cc-status">
                {hired ? 'No activity yet — type a prompt below.' : 'No board conversation with this agent yet.'}
              </p>
            )}
            {working && turn && (
              <p className="cc-spinner">
                <span className="cc-star">✳</span> {gerund}… ({fmtSecs(turn.secs)}
                {turn.tokens > 0 && <> · ↓ {fmtTokens(turn.tokens)} tokens</>}
                {' · '}<button className="cc-esc" onClick={interrupt}>esc</button> to interrupt)
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
            <span>enter to send · shift+enter for newline{hired ? ' · esc to interrupt' : ''}</span>
            <span>{hired ? 'delivered instantly' : 'delivered on its next turn'}</span>
          </div>
        </div>
      </aside>
    </>
  )
}
