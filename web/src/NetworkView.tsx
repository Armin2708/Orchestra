import React from 'react'
import { Agent, Card, Snapshot, Thread, agentInk, agentWash, initials } from './api'
import { STATUS } from './Board'

type Pos = { x: number; y: number }

export function NetworkView({ snap, onOpenCard, onOpenAgent }:
  { snap: Snapshot; onOpenCard: (c: Card) => void; onOpenAgent: (a: Agent) => void }) {
  const W = 860, H = 520
  const agents = snap.agents.filter((a) => a.status !== 'gone')

  // "you" sits at the center; agents ring around it
  const pos = new Map<string, Pos>()
  pos.set('you', { x: W / 2, y: H / 2 })
  agents.forEach((a, i) => {
    const angle = (2 * Math.PI * i) / Math.max(agents.length, 1) - Math.PI / 2
    pos.set(a.name, {
      x: W / 2 + Math.cos(angle) * (W / 2 - 150),
      y: H / 2 + Math.sin(angle) * (H / 2 - 110),
    })
  })

  // aggregate threads into edges between participants
  type Edge = { a: string; b: string; total: number; open: number }
  const edges = new Map<string, Edge>()
  for (const t of snap.threads as Thread[]) {
    const a = t.from_name ?? 'you'
    const b = t.to_name ?? 'you'
    if (a === b || !pos.has(a) || !pos.has(b)) continue
    const key = [a, b].sort().join('→')
    const e = edges.get(key) ?? { a, b, total: 0, open: 0 }
    e.total++
    if (!t.answered) e.open++
    edges.set(key, e)
  }

  const cardsFor = (name: string) =>
    snap.cards.filter((c) => c.owner === name && c.column !== 'done').slice(0, 3)

  return (
    <div className="network" style={{ aspectRatio: `${W} / ${H}` }}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
        {[...edges.values()].map((e) => {
          const pa = pos.get(e.a)!, pb = pos.get(e.b)!
          const mx = (pa.x + pb.x) / 2, my = (pa.y + pb.y) / 2
          return (
            <g key={`${e.a}${e.b}`}>
              <line x1={pa.x} y1={pa.y} x2={pb.x} y2={pb.y}
                className={e.open > 0 ? 'edge open' : 'edge'} />
              <circle cx={mx} cy={my} r={13} className={e.open > 0 ? 'edge-bubble open' : 'edge-bubble'} />
              <text x={mx} y={my + 4} className="edge-count">{e.open > 0 ? e.open : e.total}</text>
            </g>
          )
        })}
      </svg>

      {/* you */}
      <div className="net-node you" style={{ left: `${(pos.get('you')!.x / W) * 100}%`, top: `${(pos.get('you')!.y / H) * 100}%` }}>
        <span className="net-avatar human">you</span>
      </div>

      {agents.map((a) => {
        const p = pos.get(a.name)!
        const mine = cardsFor(a.name)
        return (
          <div key={a.id} className="net-node" style={{ left: `${(p.x / W) * 100}%`, top: `${(p.y / H) * 100}%` }}>
            <span className={`net-avatar ${a.status} ${a.kind === 'hired' ? 'hired clickable' : ''}`}
              style={{ background: agentWash(a.name), color: agentInk(a.name) }}
              title={a.kind === 'hired' ? `${a.name} · open console` : a.name}
              onClick={a.kind === 'hired' ? () => onOpenAgent(a) : undefined}>
              {initials(a.name)}
              <i className={`presence ${a.status}`} />
            </span>
            <span className="net-name">{a.name}</span>
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
              {mine.length === 0 && <span className="net-idle">no active task</span>}
            </div>
          </div>
        )
      })}

      {agents.length === 0 && <p className="col-empty net-empty">No agents online — hire one or open a Claude session here.</p>}

      <div className="net-legend">
        <span><i className="leg-line open" /> open question</span>
        <span><i className="leg-line" /> answered</span>
        <span><i className="net-dot" style={{ background: '#956400' }} /> working</span>
      </div>
    </div>
  )
}
