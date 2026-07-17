import React, { useEffect, useRef, useState } from 'react'
import { api, Agent, Thread, agentInk, agentWash, initials } from './api'

type Line = { at?: string; kind: 'text' | 'status' | 'error' | 'user' | 'tool' | 'tool_result'; text: string }

export function AgentTerminal({ agent, boardId, threads, onClose, onChange }:
  { agent: Agent; boardId: number; threads: Thread[]; onClose: () => void; onChange: () => void }) {
  const hired = agent.kind === 'hired'
  const [lines, setLines] = useState<Line[]>([])
  const [input, setInput] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)

  // hired agents stream their real transcript; terminal agents show the board conversation
  useEffect(() => {
    if (!hired) return
    let alive = true
    const load = () => api('GET', `/agents/${agent.id}/transcript`).then((l) => { if (alive) setLines(l) }).catch(() => {})
    load()
    const t = setInterval(load, 1000)
    return () => { alive = false; clearInterval(t) }
  }, [agent.id, hired])

  const convo: Line[] = hired ? lines : threads
    .filter((t) => (t.from_name === agent.name || t.to_name === agent.name))
    .flatMap((t) => [
      { kind: (t.from_name === agent.name ? 'text' : 'user') as Line['kind'],
        text: `${t.from_name ?? 'you'}: ${t.body}` },
      ...t.replies.map((r) => ({
        kind: (r.from_name === agent.name ? 'text' : 'user') as Line['kind'],
        text: `${r.from_name ?? 'you'}: ${r.body}`,
      })),
    ])

  const working = hired && agent.status === 'active'

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
    if (hired) { await api('POST', `/agents/${agent.id}/interrupt`); onChange() }
  }

  const renderLine = (l: Line, i: number) => {
    switch (l.kind) {
      case 'user':
        return <p key={i} className="cc-user"><span className="cc-caret">&gt;</span> {l.text}</p>
      case 'tool': {
        const paren = l.text.indexOf('(')
        const name = paren === -1 ? l.text : l.text.slice(0, paren)
        const args = paren === -1 ? '' : l.text.slice(paren)
        return <p key={i} className="cc-tool"><span className="cc-bullet">⏺</span> <b>{name}</b>{args}</p>
      }
      case 'tool_result':
        return <p key={i} className="cc-result">  ⎿  {l.text}</p>
      case 'status':
        return <p key={i} className="cc-status">{l.text}</p>
      case 'error':
        return <p key={i} className="cc-error">✗ {l.text}</p>
      default:
        return <p key={i} className="cc-text"><span className="cc-bullet">⏺</span> {l.text}</p>
    }
  }

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="terminal" onKeyDown={(e) => { if (e.key === 'Escape') interrupt() }}>
        <header className="terminal-head">
          <i className="avatar mini" style={{ background: agentWash(agent.name), color: agentInk(agent.name) }}>{initials(agent.name)}</i>
          <span className="terminal-title">{agent.name}</span>
          <span className={`status-chip ${agent.status === 'active' ? 'chip-answered' : 'chip-open'}`}>
            {hired ? agent.status : `${agent.status} · terminal session`}
          </span>
          {hired && working && <button className="cc-interrupt" onClick={interrupt}>esc to interrupt</button>}
          <button className="close" onClick={onClose} aria-label="Close">×</button>
        </header>
        <div className="terminal-scroll" ref={scrollRef}>
          {convo.map(renderLine)}
          {convo.length === 0 && (
            <p className="cc-status">
              {hired ? 'No activity yet — send this agent a task below.'
                : 'No board conversation with this agent yet — say something below.'}
            </p>
          )}
          {working && <p className="cc-spinner"><span className="cc-star">✳</span> Working…</p>}
        </div>
        <div className="terminal-input cc-inputbox">
          <span className="cc-caret big">&gt;</span>
          <textarea autoFocus value={input} rows={2}
            placeholder={hired ? 'Type a prompt — Enter to send, Esc to interrupt' : `Message ${agent.name} — delivered on its next turn`}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }} />
          <button className="btn primary" onClick={send}>Send</button>
        </div>
      </aside>
    </>
  )
}
