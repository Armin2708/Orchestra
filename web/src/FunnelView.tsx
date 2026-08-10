import React, { useState } from 'react'
import { api, Card, Milestone, Snapshot, agentInk, agentWash, initials } from './api'
import { STATUS } from './Board'
import { CardDrawer } from './CardDrawer'
import './funnel.css'

// The backlog funnel: work descends one altitude at a time, the way an engineering org
// decomposes it — epic, then what problem we are solving (feature spec), then how it will
// be built (tech spec), then the implementable tasks. Each level has an owning role, its
// own Definition of Ready, and a gate: nothing below a spec starts until the spec is Ready.
// Server model in src/funnel.ts; all classes here are .fnl-*.

type Level = { kind: string; label: string; role: string; blurb: string; ready: string }

const LEVELS: Level[] = [
  {
    kind: 'feature',
    label: 'Feature specs',
    role: 'product',
    blurb: 'What problem, for whom, and how we know it worked.',
    ready: 'Ready when it has an objective and at least one success metric.',
  },
  {
    kind: 'tech_spec',
    label: 'Tech specs',
    role: 'architect',
    blurb: 'How it gets built: interfaces, data, risks, test plan.',
    ready: 'Ready when it has an objective, acceptance criteria and the files it touches.',
  },
  {
    kind: 'task',
    label: 'Tasks',
    role: 'engineer',
    blurb: 'Implementable units an agent can pick up and finish.',
    ready: 'Ready when it has an objective, acceptance criteria and the files it touches.',
  },
]

const kindOf = (c: Card) => c.kind ?? 'task'
const isReady = (c: Card) => c.funnel_ready ?? false

function Node({ card, selected, blocked, onSelect, onOpen, onBreakdown }: {
  card: Card
  selected: boolean
  blocked: boolean
  onSelect: () => void
  onOpen: () => void
  onBreakdown: () => void
}) {
  const st = STATUS[card.column] ?? STATUS.backlog
  return (
    <div className={`fnl-node ${selected ? 'selected' : ''} ${isReady(card) ? 'is-ready' : 'is-draft'}`}>
      <button className="fnl-node-main" onClick={onSelect} onDoubleClick={onOpen}
        title={card.description || card.title}>
        <span className="fnl-node-title">{card.title}</span>
        <span className="fnl-node-meta">
          <span className="fnl-state">{isReady(card) ? 'Ready' : 'Draft'}</span>
          <span className="status-chip" style={{ background: st.bg, color: st.ink }}>{st.label}</span>
          {blocked && <span className="fnl-blocked" title="its parent spec is not Ready — work here is gated">gated</span>}
          {card.owner && (
            <i className="avatar mini" title={card.owner}
              style={{ background: agentWash(card.owner), color: agentInk(card.owner) }}>{initials(card.owner)}</i>
          )}
        </span>
      </button>
      <div className="fnl-node-tools">
        <button className="fnl-icon" title="Open the ticket" onClick={onOpen}>↗</button>
        {kindOf(card) !== 'task' && (
          <button className="fnl-icon" title="Break down into the next level" onClick={onBreakdown}>+</button>
        )}
      </div>
    </div>
  )
}

function Column({ level, cards, selectedId, parentTitle, parentReady, onSelect, onOpen, onAdd, onBreakdown }: {
  level: Level
  cards: Card[]
  selectedId: number | null
  parentTitle: string | null
  parentReady: boolean
  onSelect: (c: Card) => void
  onOpen: (c: Card) => void
  onAdd: (title: string) => void
  onBreakdown: (c: Card) => void
}) {
  const [draft, setDraft] = useState('')
  const add = () => {
    if (!draft.trim()) return
    onAdd(draft.trim())
    setDraft('')
  }
  const ready = cards.filter(isReady).length

  return (
    <section className="fnl-col">
      <header className="fnl-col-head">
        <div className="fnl-col-title">
          <h4>{level.label}</h4>
          <span className="fnl-role" title={`owned by the ${level.role} role`}>{level.role}</span>
        </div>
        <p className="fnl-col-blurb">{level.blurb}</p>
        <span className="fnl-col-stat">{ready}/{cards.length} ready</span>
      </header>

      <div className="fnl-col-body">
        {cards.map((c) => (
          <Node key={c.id} card={c} selected={selectedId === c.id} blocked={!parentReady && !!c.parent_card_id}
            onSelect={() => onSelect(c)} onOpen={() => onOpen(c)} onBreakdown={() => onBreakdown(c)} />
        ))}
        {cards.length === 0 && (
          <p className="fnl-empty">
            {parentTitle
              ? `Nothing under "${parentTitle}" yet.`
              : level.kind === 'feature' ? 'No feature specs yet.' : 'Pick something on the left first.'}
          </p>
        )}
      </div>

      {(level.kind === 'feature' || parentTitle) && (
        <div className="fnl-col-add">
          <input value={draft} aria-label={`Add a ${level.label}`}
            placeholder={level.kind === 'feature' ? '+ feature spec' : `+ ${level.kind === 'tech_spec' ? 'tech spec' : 'task'}`}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') add() }} />
        </div>
      )}
      <p className="fnl-col-foot">{level.ready}</p>
    </section>
  )
}

function BoardFunnel({ snap, onOpenCard, onChange }: {
  snap: Snapshot; onOpenCard: (c: Card) => void; onChange: () => void
}) {
  const [epicId, setEpicId] = useState<number | 'none'>(() => snap.milestones?.[0]?.id ?? 'none')
  const [featureId, setFeatureId] = useState<number | null>(null)
  const [specId, setSpecId] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  const epics: Milestone[] = snap.milestones ?? []
  const inEpic = (c: Card) => (epicId === 'none' ? !c.milestone_id : c.milestone_id === epicId)
  const byKind = (kind: string) => snap.cards.filter((c) => kindOf(c) === kind)

  const features = byKind('feature').filter(inEpic)
  const feature = features.find((f) => f.id === featureId) ?? null
  const specs = byKind('tech_spec').filter((c) => (feature ? c.parent_card_id === feature.id : false))
  const spec = specs.find((s) => s.id === specId) ?? null
  const tasks = byKind('task').filter((c) => (spec ? c.parent_card_id === spec.id : false))
  // tasks nobody has funnelled yet — the pile the funnel exists to drain
  const loose = snap.cards.filter((c) => kindOf(c) === 'task' && !c.parent_card_id && c.column !== 'done')

  const call = async (run: () => Promise<unknown>) => {
    setError(null)
    try { await run() } catch (e) { setError((e as Error).message) }
    onChange()
  }
  const createFeature = (title: string) => call(async () => {
    const { card } = await api('POST', '/cards', {
      board_id: snap.board.id, title, paths: [],
    })
    await api('PATCH', `/cards/${card.id}/funnel`, { kind: 'feature' })
    if (epicId !== 'none') await api('PATCH', `/cards/${card.id}/milestone`, { milestone_id: epicId })
  })
  const breakdown = (parent: Card, title: string) => call(() =>
    api('POST', `/cards/${parent.id}/breakdown`, { title }))
  const promptBreakdown = (parent: Card) => {
    const kind = kindOf(parent) === 'feature' ? 'tech spec' : 'task'
    const title = window.prompt(`New ${kind} under "${parent.title}":`)
    if (title?.trim()) breakdown(parent, title.trim())
  }
  const adopt = (card: Card, parent: Card) => call(() =>
    api('PATCH', `/cards/${card.id}/funnel`, { kind: 'task', parent_card_id: parent.id }))

  return (
    <div className="fnl">
      <header className="fnl-head">
        <div className="fnl-epics">
          <span className="fnl-head-label">Epic</span>
          {epics.map((m) => (
            <button key={m.id} className={epicId === m.id ? 'fnl-epic active' : 'fnl-epic'}
              onClick={() => { setEpicId(m.id); setFeatureId(null); setSpecId(null) }}>{m.title}</button>
          ))}
          <button className={epicId === 'none' ? 'fnl-epic active' : 'fnl-epic'}
            onClick={() => { setEpicId('none'); setFeatureId(null); setSpecId(null) }}>No epic</button>
        </div>
        <p className="fnl-head-hint">
          Each level is owned by a role and only opens the one below it once it is Ready —
          product writes the feature spec, the architect the tech spec, engineers take the tasks.
        </p>
      </header>

      {error && <p className="fnl-error">{error}</p>}

      <div className="fnl-cols">
        <Column level={LEVELS[0]} cards={features} selectedId={feature?.id ?? null}
          parentTitle={null} parentReady
          onSelect={(c) => { setFeatureId(c.id); setSpecId(null) }} onOpen={onOpenCard}
          onAdd={createFeature} onBreakdown={promptBreakdown} />
        <span className="fnl-arrow" aria-hidden="true">›</span>
        <Column level={LEVELS[1]} cards={specs} selectedId={spec?.id ?? null}
          parentTitle={feature?.title ?? null} parentReady={feature ? isReady(feature) : true}
          onSelect={(c) => setSpecId(c.id)} onOpen={onOpenCard}
          onAdd={(title) => feature && breakdown(feature, title)} onBreakdown={promptBreakdown} />
        <span className="fnl-arrow" aria-hidden="true">›</span>
        <Column level={LEVELS[2]} cards={tasks} selectedId={null}
          parentTitle={spec?.title ?? null} parentReady={spec ? isReady(spec) : true}
          onSelect={onOpenCard} onOpen={onOpenCard}
          onAdd={(title) => spec && breakdown(spec, title)} onBreakdown={promptBreakdown} />
      </div>

      <section className="fnl-loose">
        <h5 className="fnl-loose-h">Unfunnelled tickets <span className="fnl-count">{loose.length}</span>
          <small>{spec ? `click one to file it under "${spec.title}"` : 'select a tech spec to file these under it'}</small>
        </h5>
        <div className="fnl-loose-body">
          {loose.map((c) => (
            <button key={c.id} className="fnl-loose-card" disabled={!spec}
              title={spec ? `File under ${spec.title}` : 'Select a tech spec first'}
              onClick={() => spec && adopt(c, spec)}>{c.title}</button>
          ))}
          {loose.length === 0 && <p className="fnl-empty">Every open ticket sits under a spec.</p>}
        </div>
      </section>
    </div>
  )
}

export function FunnelView({ snaps, onChange }: { snaps: Snapshot[]; onChange: () => void }) {
  const [open, setOpen] = useState<{ card: Card; boardId: number } | null>(null)
  const live = open
    ? snaps.find((s) => s.board.id === open.boardId)?.cards.find((c) => c.id === open.card.id) ?? open.card
    : null

  return (
    <div className="fnl-wrap">
      {snaps.map((s) => (
        <BoardFunnel key={s.board.id} snap={s} onChange={onChange}
          onOpenCard={(c) => setOpen({ card: c, boardId: s.board.id })} />
      ))}
      {open && live && (
        <CardDrawer card={live} boardId={open.boardId}
          agents={(snaps.find((s) => s.board.id === open.boardId)?.agents ?? [])
            .filter((a) => a.status !== 'gone' && a.name !== 'strategist' && !a.name.startsWith('auditor-'))}
          onClose={() => setOpen(null)} onChange={onChange} />
      )}
    </div>
  )
}
