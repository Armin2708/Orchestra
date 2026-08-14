import React, { useState } from 'react'
import { api, Card, Idea, Milestone, Snapshot, agentInk, agentWash, initials } from './api'
import { STATUS } from './Board'
import { CanvasViewport, canvasSceneOffset } from './canvasViewport'

// The roadmap is the Overview board's canvas language applied to time: milestones are
// stations on one left-to-right line, their steps chain inside them, and everything not
// planned yet waits in the trays underneath. Every class here is .rmap-* — the canvas
// itself is shared with Overview and Teams, so nothing may leak into their selectors.

const DRAG_CARD = 'application/x-orchestra-card'

// phase reads off position, not dates: the first unfinished station is what's happening now
const PHASES = ['Now', 'Next', 'Later'] as const

type Plan = { milestone: Milestone; steps: Card[]; done: number; phase: string }

export function roadmapPlan(snap: Snapshot): Plan[] {
  const milestones = snap.milestones ?? []
  let openSeen = 0
  return milestones.map((milestone) => {
    const steps = snap.cards
      .filter((c) => c.milestone_id === milestone.id)
      .sort((a, b) => (a.step_order ?? 0) - (b.step_order ?? 0))
    const done = steps.filter((s) => s.column === 'done').length
    const complete = milestone.status === 'shipped' || (steps.length > 0 && done === steps.length)
    const phase = milestone.status === 'dropped' ? 'Dropped'
      : complete ? 'Shipped'
        : PHASES[Math.min(openSeen++, PHASES.length - 1)]
    return { milestone, steps, done, phase }
  })
}

const stepState = (step: Card, steps: Card[]) => {
  if (step.column === 'done') return 'done'
  if (step.column === 'review') return 'review'
  if (step.column === 'in_progress') return 'active'
  if (step.column === 'blocked') return 'blocked'
  const order = step.step_order ?? 0
  return steps.some((s) => (s.step_order ?? 0) < order && s.column !== 'done') ? 'chained' : 'open'
}

function Owner({ name }: { name: string }) {
  return (
    <span className="rmap-owner" title={name}>
      <i className="avatar mini" style={{ background: agentWash(name), color: agentInk(name) }}>{initials(name)}</i>
    </span>
  )
}

function Station({ plan, index, siblings, dropping, onDropCard, onOpenCard, onChange, onDragStep }: {
  plan: Plan
  index: number
  // every milestone id on this board, in roadmap order — reorder ranks against a neighbour
  siblings: number[]
  dropping: boolean
  onDropCard: (cardId: number, milestoneId: number | null, afterStepId?: number | null) => void
  onOpenCard: (c: Card) => void
  onChange: () => void
  onDragStep: (cardId: number) => void
}) {
  const { milestone: m, steps, done, phase } = plan
  const [stepTitle, setStepTitle] = useState('')
  const [menu, setMenu] = useState(false)
  const [hoverStep, setHoverStep] = useState<number | null>(null)
  const pct = steps.length ? Math.round((done / steps.length) * 100) : 0
  const shipped = phase === 'Shipped'

  const addStep = async () => {
    if (!stepTitle.trim()) return
    await api('POST', `/milestones/${m.id}/steps`, { title: stepTitle.trim() })
    setStepTitle(''); onChange()
  }
  const patch = async (body: Record<string, unknown>) => {
    try { await api('PATCH', `/milestones/${m.id}`, body) } catch { /* raced */ }
    setMenu(false); onChange()
  }
  const total = siblings.length
  const move = (dir: -1 | 1) => {
    const neighbour = dir === -1 ? index - 1 : index + 1
    if (neighbour < 0 || neighbour >= total) return
    // fractional ranks: land before the left neighbour, or after the right one. Neighbours
    // that predate ranking have no rank to sit against, so rank the ends explicitly.
    if (neighbour === 0 && dir === -1) return patch({ top: true })
    if (neighbour === total - 1 && dir === 1) return patch({ bottom: true })
    patch(dir === -1 ? { before: siblings[neighbour] } : { after: siblings[neighbour] })
  }

  return (
    <article
      className={`rmap-station phase-${phase.toLowerCase()} ${dropping ? 'dropping' : ''}`}
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move' }}
      onDrop={(e) => {
        e.preventDefault()
        const id = Number(e.dataTransfer.getData(DRAG_CARD))
        if (id) onDropCard(id, m.id, hoverStep)
        setHoverStep(null)
      }}>
      <header className="rmap-station-head">
        <span className="rmap-phase">{phase}</span>
        <span className="rmap-index">{String(index + 1).padStart(2, '0')}</span>
        <div className="rmap-station-title">
          <h4>{m.title}</h4>
          {m.description && <p>{m.description}</p>}
        </div>
        <div className="rmap-station-tools">
          <button className="rmap-icon" title="Move earlier" disabled={index === 0}
            onClick={() => move(-1)}>‹</button>
          <button className="rmap-icon" title="Move later" disabled={index === total - 1}
            onClick={() => move(1)}>›</button>
          <button className="rmap-icon" title="Milestone actions" onClick={() => setMenu((o) => !o)}>⋯</button>
          {menu && (
            <div className="rmap-menu" role="menu">
              {shipped
                ? <button onClick={() => patch({ status: 'open' })}>Reopen</button>
                : <button onClick={() => patch({ status: 'shipped' })}>Mark shipped</button>}
              <button onClick={() => patch({ status: 'dropped' })}>Drop — frees its open steps</button>
              <button className="danger-text" onClick={async () => {
                await api('DELETE', `/milestones/${m.id}`); setMenu(false); onChange()
              }}>Delete milestone</button>
            </div>
          )}
        </div>
      </header>

      <div className="rmap-progress" title={`${done} of ${steps.length} steps done`}>
        <div className="rmap-track"><div className="rmap-fill" style={{ width: `${pct}%` }} /></div>
        <span className="rmap-count">{done}/{steps.length}</span>
      </div>

      <ol className="rmap-steps">
        {steps.map((s) => {
          const state = stepState(s, steps)
          const st = STATUS[s.column] ?? STATUS.backlog
          return (
            <li key={s.id}
              className={`rmap-step is-${state} ${hoverStep === s.id ? 'insert-after' : ''}`}
              draggable onDragStart={(e) => {
                e.dataTransfer.setData(DRAG_CARD, String(s.id))
                e.dataTransfer.effectAllowed = 'move'
                onDragStep(s.id)
              }}
              onDragOver={(e) => { e.preventDefault(); setHoverStep(s.id) }}
              onDragLeave={() => setHoverStep((h) => (h === s.id ? null : h))}>
              <span className="rmap-step-mark" aria-hidden="true" />
              <button className="rmap-step-open" onClick={() => onOpenCard(s)} title={s.description || s.title}>
                <span className="rmap-step-title">{s.title}</span>
                {/* queued is the default — only say something when the step has moved */}
                {(s.column !== 'backlog' || state === 'chained' || s.owner) && (
                  <span className="rmap-step-meta">
                    {s.column !== 'backlog'
                      && <span className="status-chip" style={{ background: st.bg, color: st.ink }}>{st.label}</span>}
                    {state === 'chained' && <span className="rmap-lock" title="earlier steps are still open">chained</span>}
                    {s.owner && <Owner name={s.owner} />}
                  </span>
                )}
              </button>
            </li>
          )
        })}
        {steps.length === 0 && <li className="rmap-step-empty">No steps yet — add one, or drag a ticket in.</li>}
      </ol>

      <div className="rmap-station-add">
        <input value={stepTitle} aria-label={`Add a step to ${m.title}`}
          placeholder="+ step (runs in order)"
          onChange={(e) => setStepTitle(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') addStep() }} />
      </div>
    </article>
  )
}

function NewStation({ boardId, onChange }: { boardId: number; onChange: () => void }) {
  const [title, setTitle] = useState('')
  const add = async () => {
    if (!title.trim()) return
    await api('POST', '/milestones', { board_id: boardId, title: title.trim() })
    setTitle(''); onChange()
  }
  return (
    <article className="rmap-station rmap-station-new">
      <span className="rmap-phase">New</span>
      <p className="rmap-new-hint">A milestone is a goal made of ordered steps.</p>
      <input value={title} aria-label="Create a milestone"
        placeholder="🎯 New milestone…"
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') add() }} />
    </article>
  )
}

export function RoadmapBoard({ snap, viewport, onOpenCard, onOpenIdea, onChange }: {
  snap: Snapshot
  viewport: CanvasViewport
  onOpenCard: (c: Card) => void
  onOpenIdea: (i: Idea) => void
  onChange: () => void
}) {
  const [dragging, setDragging] = useState<number | null>(null)
  const [trayHot, setTrayHot] = useState(false)
  const plans = roadmapPlan(snap)
  const siblings = plans.map((p) => p.milestone.id)

  const unplanned = snap.cards
    .filter((c) => !c.milestone_id && c.column !== 'done')
    .sort((a, b) => (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER) || a.id - b.id)
  const ideas = snap.ideas ?? []

  const plan = async (cardId: number, milestoneId: number | null, afterStepId?: number | null) => {
    setDragging(null); setTrayHot(false)
    try {
      await api('PATCH', `/cards/${cardId}/milestone`, {
        milestone_id: milestoneId,
        after_step_id: afterStepId ?? null,
      })
    } catch { /* raced — the refresh below shows the truth */ }
    onChange()
  }

  const offset = canvasSceneOffset(viewport, { x: 0, y: 0 })
  const sceneStyle = {
    transformOrigin: '0 0',
    transform: `translate3d(${offset.x}px, ${offset.y}px, 0) scale(${viewport.zoom})`,
  }

  const totalSteps = plans.reduce((n, p) => n + p.steps.length, 0)
  const totalDone = plans.reduce((n, p) => n + p.done, 0)
  const live = plans.find((p) => p.phase === 'Now')

  return (
    <section className="rmap" aria-label={`${snap.board.name} roadmap`}>
      <div className="rmap-scene" style={sceneStyle}>
        <header className="rmap-head">
          <h3>{snap.board.name}</h3>
          <span className="rmap-head-stat">
            {plans.length} milestone{plans.length === 1 ? '' : 's'} · {totalDone}/{totalSteps} steps done
            {live && <> · now: <b>{live.milestone.title}</b></>}
          </span>
        </header>
        <div className="rmap-line" aria-hidden="true" />
        <div className="rmap-spine">
          {plans.map((p, i) => (
            <React.Fragment key={p.milestone.id}>
              {i > 0 && <span className="rmap-link" aria-hidden="true">›</span>}
              <Station plan={p} index={i} siblings={siblings}
                dropping={dragging !== null}
                onDropCard={plan} onOpenCard={onOpenCard} onChange={onChange}
                onDragStep={(id) => setDragging(id)} />
            </React.Fragment>
          ))}
          {plans.length > 0 && <span className="rmap-link" aria-hidden="true">›</span>}
          <NewStation boardId={snap.board.id} onChange={onChange} />
        </div>

        <div className="rmap-trays">
          <div className={`rmap-tray ${trayHot ? 'dropping' : ''}`}
            onDragOver={(e) => { e.preventDefault(); setTrayHot(true) }}
            onDragLeave={() => setTrayHot(false)}
            onDrop={(e) => {
              e.preventDefault()
              const id = Number(e.dataTransfer.getData(DRAG_CARD))
              if (id) plan(id, null)
            }}>
            <h5 className="rmap-tray-h">Unplanned <span className="rmap-count">{unplanned.length}</span>
              <small>drag onto a milestone to schedule it — drop back here to unschedule</small>
            </h5>
            <div className="rmap-tray-body">
              {unplanned.map((c) => {
                const st = STATUS[c.column] ?? STATUS.backlog
                return (
                  <div key={c.id} className={`rmap-ticket ${dragging === c.id ? 'is-dragging' : ''}`}
                    draggable onDragStart={(e) => {
                      e.dataTransfer.setData(DRAG_CARD, String(c.id))
                      e.dataTransfer.effectAllowed = 'move'
                      setDragging(c.id)
                    }}
                    onDragEnd={() => setDragging(null)}>
                    <button className="rmap-ticket-open" onClick={() => onOpenCard(c)} title={c.description || c.title}>
                      <span className="status-dot" style={{ background: st.ink }} aria-hidden="true" />
                      <span className="rmap-ticket-title">{c.title}</span>
                      {c.owner && <Owner name={c.owner} />}
                    </button>
                  </div>
                )
              })}
              {unplanned.length === 0 && <p className="rmap-empty">Everything open is on the roadmap.</p>}
            </div>
          </div>

          <div className="rmap-tray rmap-tray-ideas">
            <h5 className="rmap-tray-h">Ideas <span className="rmap-count">{ideas.length}</span>
              <small>raw thoughts — audit one into a real ticket</small>
            </h5>
            <div className="rmap-tray-body">
              {ideas.map((i) => {
                const auditor = snap.agents.find((a) => a.name === `auditor-${i.id}` && a.status !== 'gone')
                return (
                  <button key={i.id} className={auditor ? 'rmap-idea auditing' : 'rmap-idea'}
                    onClick={() => onOpenIdea(i)}>
                    <span className="rmap-idea-title">{i.text.split('\n')[0]}</span>
                    {auditor && <span className="rmap-idea-auditing">✳ auditing…</span>}
                  </button>
                )
              })}
              {ideas.length === 0 && <p className="rmap-empty">No ideas yet — jot one in the dock.</p>}
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
