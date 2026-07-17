import React, { useEffect, useRef, useState } from 'react'
import { api, Agent, agentInk, agentWash, initials } from './api'

type Line = { at: string; kind: 'text' | 'status' | 'error' | 'user'; text: string }

export function AgentTerminal({ agent, onClose, onChange }:
  { agent: Agent; onClose: () => void; onChange: () => void }) {
  const [lines, setLines] = useState<Line[]>([])
  const [input, setInput] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let alive = true
    const load = () => api('GET', `/agents/${agent.id}/transcript`).then((l) => { if (alive) setLines(l) }).catch(() => {})
    load()
    const t = setInterval(load, 2000)
    return () => { alive = false; clearInterval(t) }
  }, [agent.id])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [lines.length])

  const send = async () => {
    if (!input.trim()) return
    await api('POST', `/agents/${agent.id}/task`, { text: input.trim() })
    setInput(''); onChange()
  }

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="terminal">
        <header className="terminal-head">
          <i className="avatar mini" style={{ background: agentWash(agent.name), color: agentInk(agent.name) }}>{initials(agent.name)}</i>
          <span className="terminal-title">{agent.name}</span>
          <span className={`status-chip ${agent.status === 'active' ? 'chip-answered' : 'chip-open'}`}>{agent.status}</span>
          <button className="close" onClick={onClose} aria-label="Close">×</button>
        </header>
        <div className="terminal-scroll" ref={scrollRef}>
          {lines.map((l, i) => (
            <p key={i} className={`tl-${l.kind}`}>
              {l.kind === 'user' ? '❯ ' : ''}{l.text}
            </p>
          ))}
          {lines.length === 0 && <p className="tl-status">No activity yet — send this agent a task below.</p>}
        </div>
        <div className="terminal-input">
          <textarea autoFocus value={input} rows={2}
            placeholder={`Message ${agent.name} — delivered instantly`}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }} />
          <button className="btn primary" onClick={send}>Send</button>
        </div>
      </aside>
    </>
  )
}
