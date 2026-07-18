import React, { useEffect, useRef, useState } from 'react'
import { api, Agent, Card, Snapshot, Thread, agentInk, agentWash, initials } from './api'
import { STATUS } from './Board'

type Norm = { x: number; y: number }

function loadPos(boardId: number): Record<string, Norm> {
  try { return JSON.parse(localStorage.getItem(`orchestra-net-${boardId}`) ?? '{}') } catch { return {} }
}

const ageMs = (sqlUtc: string) => Date.now() - new Date(sqlUtc.replace(' ', 'T') + 'Z').getTime()

export function NetworkView({ snap, onOpenCard, onOpenAgent, onChange }:
  { snap: Snapshot; onOpenCard: (c: Card) => void; onOpenAgent: (a: Agent) => void; onChange?: () => void }) {
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const boardId = snap.board.id
  const agents = snap.agents.filter((a) => a.status !== 'gone')
  const wrap = useRef<HTMLDivElement>(null)
  // real pixel size of the canvas — svg renders 1:1, so text and arrows never distort
  const [size, setSize] = useState({ w: 1000, h: 600 })
  useEffect(() => {
    if (!wrap.current) return
    const ro = new ResizeObserver(([e]) => {
      const { width, height } = e.contentRect
      if (width > 0 && height > 0) setSize({ w: width, h: height })
    })
    ro.observe(wrap.current)
    return () => ro.disconnect()
  }, [])
  const W = size.w, H = size.h
  const [pos, setPos] = useState<Record<string, Norm>>(() => loadPos(boardId))
  const [openThread, setOpenThread] = useState<Thread | null>(null)
  const [promptFor, setPromptFor] = useState<Agent | null>(null)
  const [prompt, setPrompt] = useState('')
  const [reply, setReply] = useState('')
  const drag = useRef<{ name: string; moved: boolean } | null>(null)

  useEffect(() => setPos(loadPos(boardId)), [boardId])

  // default layout: you center, agents ringed
  const place = (name: string, i: number, n: number): Norm => {
    if (pos[name]) return pos[name]
    if (name === 'you') return { x: 0.5, y: 0.5 }
    const angle = (2 * Math.PI * i) / Math.max(n, 1) - Math.PI / 2
    return { x: 0.5 + Math.cos(angle) * 0.34, y: 0.5 + Math.sin(angle) * 0.36 }
  }
  const nodes = new Map<string, Norm>()
  nodes.set('you', place('you', 0, 1))
  agents.forEach((a, i) => nodes.set(a.name, place(a.name, i, agents.length)))

  const startDrag = (name: string) => (e: React.PointerEvent) => {
    e.preventDefault()
    drag.current = { name, moved: false }
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
  }
  const onMove = (e: React.PointerEvent) => {
    if (!drag.current || !wrap.current) return
    const r = wrap.current.getBoundingClientRect()
    drag.current.moved = true
    const next = {
      x: Math.min(0.96, Math.max(0.04, (e.clientX - r.left) / r.width)),
      y: Math.min(0.92, Math.max(0.06, (e.clientY - r.top) / r.height)),
    }
    setPos((p) => ({ ...p, [drag.current!.name]: next }))
  }
  const endDrag = (a?: Agent) => () => {
    if (!drag.current) return
    const wasDrag = drag.current.moved
    drag.current = null
    setPos((p) => { localStorage.setItem(`orchestra-net-${boardId}`, JSON.stringify(p)); return p })
    if (!wasDrag && a) onOpenAgent(a) // click (no movement) opens the console
  }

  // one edge per question; answered ones linger green for 3 minutes, then vanish
  const edges = (snap.threads as Thread[]).filter((t) => {
    const src = t.from_name ?? 'you', dst = t.to_name ?? 'you'
    if (src === dst || !nodes.has(src) || !nodes.has(dst)) return false
    if (!t.answered) return true
    const last = t.replies[t.replies.length - 1]
    return last ? ageMs(last.created_at) < 180_000 : false
  })

  const sendPrompt = async () => {
    if (!promptFor || !prompt.trim()) return
    await api('POST', '/messages', { board_id: boardId, to: promptFor.name, body: prompt.trim() })
    setPrompt(''); setPromptFor(null)
  }
  const sendReply = async () => {
    if (!openThread || !reply.trim()) return
    await api('POST', '/messages', { board_id: boardId, body: reply.trim(), reply_to: openThread.id })
    setReply(''); setOpenThread(null)
  }

  const cardsFor = (name: string) =>
    snap.cards.filter((c) => c.owner === name && c.column !== 'done').slice(0, 3)

  const P = (name: string) => nodes.get(name)!

  return (
    <div className="network" ref={wrap} onPointerMove={onMove} onPointerUp={endDrag()}>
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H}>
        <defs>
          <marker id="arrow-open" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#d9a13b" />
          </marker>
          <marker id="arrow-done" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#3a9e5f" />
          </marker>
        </defs>
        {(() => {
          // spread multiple questions between the same pair onto parallel curves
          const byPair = new Map<string, number>()
          return edges.map((t) => {
            const src = t.from_name ?? 'you', dst = t.to_name ?? 'you'
            const key = [src, dst].sort().join('→')
            const idx = byPair.get(key) ?? 0
            byPair.set(key, idx + 1)
            const a = P(src), b = P(dst)
            const x1 = (a.x + (b.x - a.x) * 0.12) * W, y1 = (a.y + (b.y - a.y) * 0.14) * H
            const x2 = (a.x + (b.x - a.x) * 0.86) * W, y2 = (a.y + (b.y - a.y) * 0.84) * H
            // perpendicular offset: 0, +52, -52, +104, ...
            const off = (idx % 2 === 0 ? 1 : -1) * Math.ceil(idx / 2) * 104 + (idx === 0 ? 0 : 0)
            const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1
            const nx = -dy / len, ny = dx / len
            const cx = (x1 + x2) / 2 + nx * off * 1.6, cy = (y1 + y2) / 2 + ny * off * 1.6
            // stagger boxes along the curve so parallel questions never collide
            const bt = idx === 0 ? 0.5 : idx % 2 ? 0.3 : 0.7
            const mx = (1 - bt) ** 2 * x1 + 2 * (1 - bt) * bt * cx + bt ** 2 * x2
            const my = (1 - bt) ** 2 * y1 + 2 * (1 - bt) * bt * cy + bt ** 2 * y2
            const label = t.body.length > 26 ? t.body.slice(0, 26) + '…' : t.body
            const cls = t.answered ? 'done' : 'open'
            return (
              <g key={t.id} className={`q-edge ${cls}`} onClick={() => { setOpenThread(t); setReply('') }}>
                <path d={`M ${x1} ${y1} Q ${cx} ${cy} ${x2} ${y2}`} fill="none" className={`edge ${cls}`} markerEnd={`url(#arrow-${cls})`} />
                <rect x={mx - 92} y={my - 15} width={184} height={30} rx={7} className={`q-box ${cls}`} />
                <text x={mx} y={my + 4} className={`q-text ${cls}`}>{label}</text>
              </g>
            )
          })
        })()}
      </svg>

      {/* you */}
      <div className="net-node" style={{ left: `${P('you').x * 100}%`, top: `${P('you').y * 100}%` }}>
        <span className="net-avatar human" onPointerDown={startDrag('you')} onPointerUp={endDrag()}>you</span>
      </div>

      {agents.map((a) => {
        const p = P(a.name)
        const mine = cardsFor(a.name)
        const asking = (snap.threads as Thread[]).some((t) => !t.answered && t.from_name === a.name)
        const free = a.status !== 'active' && mine.length === 0
        const subs = a.subagents ?? []
        return (
          <div key={a.id} className="net-node" style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%` }}>
            <span className={`net-avatar round ${a.status} ${a.kind === 'hired' ? 'hired' : ''} ${asking ? 'asking' : ''} ${dropTarget === a.name ? 'droptarget' : ''}`}
              style={{ background: agentWash(a.name), color: agentInk(a.name) }}
              title={`${a.name} — drag to move, click to open console, drop a ticket to assign`}
              onPointerDown={startDrag(a.name)} onPointerUp={endDrag(a)}
              onDragOver={(e) => { if (a.name === 'strategist' || a.name.startsWith('auditor-')) return; e.preventDefault(); setDropTarget(a.name) }}
              onDragLeave={() => setDropTarget(null)}
              onDrop={async (e) => {
                e.preventDefault(); setDropTarget(null)
                if (a.name === 'strategist' || a.name.startsWith('auditor-')) return
                const id = Number(e.dataTransfer.getData('text/ticket-id'))
                if (!id) return
                try { await api('POST', `/cards/${id}/assign`, { agent: a.name }) } catch { /* locked */ }
                onChange?.()
              }}>
              {initials(a.name)}
              <i className={`presence ${a.status}`} />
              {asking && <i className="net-badge ask">?</i>}
              {!asking && free && <i className="net-badge free">✓</i>}
              {subs.slice(0, 3).map((sb, i) => (
                <i key={sb.key} className={`net-sub s${i}`} title={`subagent: ${sb.label}`} />
              ))}
              {subs.length > 3 && <i className="net-sub more" title={`${subs.length} subagents`}>{subs.length}</i>}
            </span>
            <span className="net-name">{a.name}{subs.length > 0 ? ` +${subs.length}` : ''}</span>
            <div className="net-cards">
              {mine.map((c) => {
                const st = STATUS[c.column] ?? STATUS.backlog
                return (
                  <button key={c.id} className="net-card" onClick={() => onOpenCard(c)} title={c.title}>
                    <i className="net-dot" style={{ background: st.ink }} />
                    {c.title}
                  </button>
                )
              })}
            </div>
          </div>
        )
      })}

      {agents.length === 0 && <p className="col-empty net-empty">No agents online — hire one or open a Claude session here.</p>}

      {promptFor && (
        <div className="net-prompt">
          <span className="net-prompt-title">
            <i className="avatar mini" style={{ background: agentWash(promptFor.name), color: agentInk(promptFor.name) }}>{initials(promptFor.name)}</i>
            {promptFor.name}
          </span>
          <input autoFocus value={prompt}
            placeholder={promptFor.kind === 'hired' ? 'Prompt this agent — delivered instantly' : 'Ask or instruct — delivered via its next turn'}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') sendPrompt(); if (e.key === 'Escape') setPromptFor(null) }} />
          <button className="btn primary" onClick={sendPrompt}>Send</button>
          {promptFor.kind === 'hired' && <button className="btn ghost" onClick={() => { onOpenAgent(promptFor); setPromptFor(null) }}>Console</button>}
          <button className="btn ghost" onClick={() => setPromptFor(null)}>×</button>
        </div>
      )}

      {openThread && (
        <div className="net-thread">
          <p className="net-thread-q"><b>{openThread.from_name ?? 'you'}</b> → <b>{openThread.to_name ?? 'everyone'}</b>: {openThread.body}</p>
          {openThread.replies.map((r) => (
            <p key={r.id} className="thread-a"><b>{r.from_name ?? 'you'}</b>: {r.body}</p>
          ))}
          {!openThread.answered && (
            <div className="add-form">
              <input autoFocus value={reply} placeholder="Answer this question"
                onChange={(e) => setReply(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') sendReply(); if (e.key === 'Escape') setOpenThread(null) }} />
              <button className="btn primary" onClick={sendReply}>Reply</button>
            </div>
          )}
          <button className="btn ghost" onClick={() => setOpenThread(null)}>Close</button>
        </div>
      )}

      <div className="net-legend">
        <span><i className="leg-line open" /> open question</span>
        <span><i className="leg-line done" /> answered (fades after 3 min)</span>
        <span>drag circles · click to open console</span>
      </div>
    </div>
  )
}
