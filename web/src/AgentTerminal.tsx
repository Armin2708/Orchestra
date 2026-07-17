import React, { useEffect, useRef, useState } from 'react'
import { api, Agent, Thread, agentInk, agentWash, initials } from './api'

type Line = { at?: string; kind: 'text' | 'status' | 'error' | 'user'; text: string }

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
    const t = setInterval(load, 2000)
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

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [convo.length])

  const send = async () => {
    if (!input.trim()) return
    if (hired) await api('POST', `/agents/${agent.id}/task`, { text: input.trim() })
    else await api('POST', '/messages', { board_id: boardId, to: agent.name, body: input.trim() })
    setInput(''); onChange()
  }

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="terminal">
        <header className="terminal-head">
          <i className="avatar mini" style={{ background: agentWash(agent.name), color: agentInk(agent.name) }}>{initials(agent.name)}</i>
          <span className="terminal-title">{agent.name}</span>
          <span className={`status-chip ${agent.status === 'active' ? 'chip-answered' : 'chip-open'}`}>
            {hired ? agent.status : `${agent.status} · terminal session`}
          </span>
          <button className="close" onClick={onClose} aria-label="Close">×</button>
        </header>
        <div className="terminal-scroll" ref={scrollRef}>
          {convo.map((l, i) => (
            <p key={i} className={`tl-${l.kind}`}>
              {l.kind === 'user' ? '❯ ' : ''}{l.text}
            </p>
          ))}
          {convo.length === 0 && (
            <p className="tl-status">
              {hired ? 'No activity yet — send this agent a task below.'
                : 'No board conversation with this agent yet — say something below.'}
            </p>
          )}
        </div>
        <div className="terminal-input">
          <textarea autoFocus value={input} rows={2}
            placeholder={hired
              ? `Message ${agent.name} — delivered instantly`
              : `Message ${agent.name} — delivered on its next turn or tool use`}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }} />
          <button className="btn primary" onClick={send}>Send</button>
        </div>
      </aside>
    </>
  )
}
