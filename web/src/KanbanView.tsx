import React, { useEffect, useMemo, useRef, useState } from 'react'
import { api, Card, Milestone, Snapshot, agentInk, agentWash, initials, timeAgo } from './api'
import { agentActivity } from './agentActivity'
import { CardDrawer } from './CardDrawer'
import './kanban.css'

// Kanban lanes: real columns plus a derived Triage lane — backlog cards that are not yet
// ready (no contract) or not yet ranked. Dropping on Done is an operator accept —
// the server still holds managed jobs to their delivery gate (assertDoneReady).
const LANES = [
  { id: 'triage', label: 'Triage' },
  { id: 'backlog', label: 'Backlog' },
  { id: 'in_progress', label: 'In progress' },
  { id: 'review', label: 'Review' },
  { id: 'blocked', label: 'Blocked' },
  { id: 'done', label: 'Done' },
] as const

type LaneId = typeof LANES[number]['id']

type KanbanCard = Card & { rank?: number | null; ready?: boolean; stale?: boolean }

const laneOf = (card: KanbanCard): LaneId => {
  if (card.column !== 'backlog') return card.column as LaneId
  return card.ready && card.rank != null ? 'backlog' : 'triage'
}

const byRank = (a: KanbanCard, b: KanbanCard) =>
  (a.rank ?? Number.MAX_VALUE) - (b.rank ?? Number.MAX_VALUE) || a.id - b.id

export function KanbanView({ snaps, onChange }: { snaps: Snapshot[]; onChange: () => void }) {
  return (
    <div className="kanban-view">
      {snaps.map((snapshot) => (
        <BoardKanban key={snapshot.board.id} snapshot={snapshot} onChange={onChange} />
      ))}
    </div>
  )
}

// while dragging: which lane the pointer is over, and which card the drop would land above
// (null = end of the lane). Rendered as a GitHub-Projects-style insertion line.
type DropHint = { lane: LaneId; beforeId: number | null }

function BoardKanban({ snapshot, onChange }: { snapshot: Snapshot; onChange: () => void }) {
  const [query, setQuery] = useState('')
  const [ownerFilter, setOwnerFilter] = useState('')
  const [epicFilter, setEpicFilter] = useState(0)
  const [showDone, setShowDone] = useState(false)
  const [dragging, setDragging] = useState<number | null>(null)
  const [hint, setHint] = useState<DropHint | null>(null)
  const [error, setError] = useState<string | null>(null)
  // card whose details drawer is open; resolved against live cards so edits stay fresh
  const [drawerId, setDrawerId] = useState<number | null>(null)
  // optimistic view of a just-dropped card, keyed by the updated_at we saw at drop time;
  // the override retires as soon as the server confirms with a newer updated_at
  const [overrides, setOverrides] = useState<Record<number, Partial<KanbanCard> & { seen: string }>>({})

  const cards = useMemo(() => (snapshot.cards as KanbanCard[]).map((c) => {
    const patch = overrides[c.id]
    return patch && patch.seen === c.updated_at ? { ...c, ...patch } : c
  }), [snapshot.cards, overrides])
  useEffect(() => {
    setOverrides((current) => {
      const next: typeof current = {}
      let dropped = false
      for (const [id, patch] of Object.entries(current)) {
        const card = (snapshot.cards as KanbanCard[]).find((c) => c.id === Number(id))
        if (card && card.updated_at === patch.seen) next[Number(id)] = patch
        else dropped = true
      }
      return dropped ? next : current
    })
  }, [snapshot.cards])
  const epics = snapshot.milestones ?? []
  const workingOwners = useMemo(() =>
    new Set(snapshot.agents.filter((a) => agentActivity(a) === 'working').map((a) => a.name)),
  [snapshot.agents])
  const owners = useMemo(
    () => [...new Set(cards.map((c) => c.owner).filter(Boolean))] as string[],
    [cards])
  const visible = useMemo(() => cards.filter((c) =>
    (!query || `${c.id} ${c.title}`.toLowerCase().includes(query.toLowerCase()))
    && (!ownerFilter || c.owner === ownerFilter)
    && (!epicFilter || c.milestone_id === epicFilter)), [cards, query, ownerFilter, epicFilter])
  const staleCount = cards.filter((c) => c.stale).length

  const act = async (run: () => Promise<unknown>, revertId?: number) => {
    setError(null)
    try { await run(); onChange() } catch (e) {
      if (revertId !== undefined) setOverrides(({ [revertId]: gone, ...rest }) => rest)
      setError(e instanceof Error ? e.message : 'action failed')
    }
  }
  // paint the drop immediately; the server round-trip only has to agree later
  const applyLocal = (card: KanbanCard, patch: Partial<KanbanCard>) =>
    setOverrides((current) => ({ ...current, [card.id]: { ...patch, seen: card.updated_at } }))
  const optimisticRank = (beforeId: number | null): number => {
    const ranked = cards.filter((c) => laneOf(c) === 'backlog').sort(byRank)
    if (beforeId === null) return ranked.length ? (ranked.at(-1)!.rank ?? 0) + 1024 : 0
    const index = ranked.findIndex((c) => c.id === beforeId)
    if (index < 0) return 0
    const hi = ranked[index].rank ?? 0
    const lo = index > 0 ? ranked[index - 1].rank ?? hi - 2048 : hi - 2048
    return (lo + hi) / 2
  }
  // drop() must read the hint set by the very last dragover, not the last render's — a
  // fast drop can outrun React's state flush, so the ref carries the live value
  const hintRef = useRef<DropHint | null>(null)
  const moveHint = (next: DropHint | null) => {
    hintRef.current = next
    setHint((current) => (
      current?.lane === next?.lane && current?.beforeId === next?.beforeId ? current : next
    ))
  }
  const clearDrag = () => { setDragging(null); moveHint(null) }

  const overLane = (lane: LaneId) => (event: React.DragEvent) => {
    event.preventDefault()
    moveHint({ lane, beforeId: null })
  }
  const overCard = (lane: LaneId, laneCards: KanbanCard[], index: number) => (event: React.DragEvent) => {
    event.preventDefault()
    event.stopPropagation()
    if (lane === 'done') return moveHint({ lane, beforeId: null }) // done is unordered
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
    const beforeId = event.clientY < rect.top + rect.height / 2
      ? laneCards[index].id
      : laneCards[index + 1]?.id ?? null
    moveHint({ lane, beforeId })
  }
  const drop = (event: React.DragEvent) => {
    event.preventDefault()
    event.stopPropagation()
    const id = Number(event.dataTransfer.getData('text/orchestra-card'))
    const target = hintRef.current
    clearDrag()
    if (!id || !target) return
    const card = cards.find((c) => c.id === id)
    if (!card) return
    const sameLane = laneOf(card) === target.lane
    if (target.lane === 'backlog') {
      const reposition = target.beforeId && target.beforeId !== id
        ? { before: target.beforeId }
        : target.beforeId === null ? { bottom: true } : null
      if (card.column !== 'backlog') {
        // entering the backlog from another column: move first, then slot into place
        applyLocal(card, { column: 'backlog', rank: optimisticRank(target.beforeId) })
        return act(async () => {
          await api('POST', `/cards/${id}/move`, { column: 'backlog' })
          if (reposition) await api('POST', `/cards/${id}/rank`, reposition)
        }, id)
      }
      if (!reposition) return
      applyLocal(card, { rank: optimisticRank(target.beforeId) })
      return act(() => api('POST', `/cards/${id}/rank`, reposition), id)
    }
    if (target.lane === 'triage') {
      if (card.column === 'backlog') return
      applyLocal(card, { column: 'backlog', rank: null })
      return act(() => api('POST', `/cards/${id}/move`, { column: 'backlog' }), id)
    }
    if (sameLane) return
    applyLocal(card, { column: target.lane })
    return act(() => api('POST', `/cards/${id}/move`, { column: target.lane }), id)
  }

  return (
    <section className="kanban-board" aria-label={`${snapshot.board.name} kanban`}>
      <header className="kanban-header">
        <h2>{snapshot.board.name}</h2>
        <input className="kanban-search" placeholder="Filter cards…" value={query}
          onChange={(e) => setQuery(e.target.value)} aria-label="Filter cards" />
        <select value={ownerFilter} onChange={(e) => setOwnerFilter(e.target.value)} aria-label="Filter by owner">
          <option value="">All owners</option>
          {owners.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
        <select value={epicFilter} onChange={(e) => setEpicFilter(Number(e.target.value))} aria-label="Filter by epic">
          <option value={0}>All epics</option>
          {epics.map((m) => (
            <option key={m.id} value={m.id}>
              {m.title}{m.status && m.status !== 'open' ? ` (${m.status})` : ''}
            </option>
          ))}
        </select>
        {staleCount > 0 && <span className="kanban-stale-count" title="Cards idle past their column's threshold">{staleCount} stale</span>}
        {error && <span className="kanban-error" role="alert">{error}</span>}
      </header>
      <div className="kanban-lanes">
        {LANES.map((lane) => {
          const laneCards = visible.filter((c) => laneOf(c) === lane.id)
            .sort(lane.id === 'backlog' ? byRank : (a, b) => b.id - a.id)
          const collapsed = lane.id === 'done' && !showDone
          const laneActive = dragging !== null && hint?.lane === lane.id
          const lineBefore = (id: number | null) =>
            laneActive && hint?.beforeId === id && hint.beforeId !== dragging
              && <div className="kanban-drop-line" aria-hidden="true" />
          return (
            <div key={lane.id}
              className={`kanban-lane kanban-lane-${lane.id}${laneActive ? ' drop-target' : ''}`}
              onDragOver={overLane(lane.id)} onDrop={drop}
              onDragLeave={(e) => {
                if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) moveHint(null)
              }}>
              <div className="kanban-lane-head">
                <span className={`kanban-lane-dot dot-${lane.id}`} aria-hidden="true" />
                <span>{lane.label}</span>
                <span className="kanban-lane-count">{laneCards.length}</span>
                {lane.id === 'done' && laneCards.length > 0 && (
                  <button type="button" className="kanban-done-toggle" onClick={() => setShowDone(!showDone)}>
                    {showDone ? 'collapse' : 'show'}
                  </button>
                )}
              </div>
              <div className="kanban-lane-body">
                {!collapsed && laneCards.map((card, index) => (
                  <React.Fragment key={card.id}>
                    {lineBefore(card.id)}
                    <KanbanCardChip card={card} epics={epics} onChange={onChange}
                      ownerWorking={card.owner != null && workingOwners.has(card.owner)}
                      dragging={dragging === card.id}
                      onOpen={() => setDrawerId(card.id)}
                      onDragStart={(e) => {
                        e.dataTransfer.setData('text/orchestra-card', String(card.id))
                        e.dataTransfer.effectAllowed = 'move'
                        setDragging(card.id)
                      }}
                      onDragEnd={clearDrag}
                      onDragOver={overCard(lane.id, laneCards, index)}
                      onDrop={drop} />
                  </React.Fragment>
                ))}
                {lineBefore(null)}
                {lane.id === 'triage' && laneCards.length === 0 && (
                  <p className="kanban-empty">Ungroomed backlog cards land here.</p>
                )}
              </div>
            </div>
          )
        })}
      </div>
      {(() => {
        const drawerCard = drawerId === null ? null : cards.find((c) => c.id === drawerId)
        return drawerCard ? <CardDrawer card={drawerCard} boardId={snapshot.board.id}
          agents={snapshot.agents.filter((a) => a.status !== 'gone')}
          onClose={() => setDrawerId(null)} onChange={onChange} /> : null
      })()}
    </section>
  )
}

// prefill acceptance criteria from the card description's DONE WHEN section, one per line
const doneWhenLines = (description: string): string[] => {
  const match = /done\s+when:?/i.exec(description)
  if (!match) return []
  return description.slice(match.index + match[0].length).split('\n')
    .map((line) => line.replace(/^[\s•*–—-]+/, '').trim())
    .filter((line) => line && !/^[A-Z ]{4,}:$/.test(line))
    .slice(0, 8)
}

function KanbanCardChip({ card, epics, dragging, ownerWorking, onChange, onOpen, onDragStart, onDragEnd, onDragOver, onDrop }: {
  card: KanbanCard
  epics: Milestone[]
  dragging: boolean
  ownerWorking: boolean
  onChange: () => void
  onOpen: () => void
  onDragStart: (event: React.DragEvent) => void
  onDragEnd: () => void
  onDragOver: (event: React.DragEvent) => void
  onDrop: (event: React.DragEvent) => void
}) {
  const epic = card.milestone_id ? epics.find((m) => m.id === card.milestone_id) : undefined
  const [grooming, setGrooming] = useState(false)
  const [objective, setObjective] = useState('')
  const [criteria, setCriteria] = useState('')
  const [saveError, setSaveError] = useState<string | null>(null)
  const unready = card.column === 'backlog' && !card.ready

  const openGroom = () => {
    setObjective(card.title)
    setCriteria(doneWhenLines(card.description).join('\n'))
    setGrooming(true)
  }
  const saveContract = async () => {
    setSaveError(null)
    try {
      await api('PUT', `/cards/${card.id}/contract`, {
        objective: objective.trim(),
        acceptance_criteria: criteria.split('\n').map((c) => c.trim()).filter(Boolean),
      })
      setGrooming(false)
      onChange()
    } catch (e) { setSaveError(e instanceof Error ? e.message : 'save failed') }
  }

  return (
    <article className={`kanban-card${dragging ? ' dragging' : ''}`} draggable={!grooming}
      onClick={(event) => {
        // buttons and the grooming form keep their own clicks
        if ((event.target as HTMLElement).closest('button, input, textarea, a, .kanban-groom')) return
        onOpen()
      }}
      onDragStart={onDragStart} onDragEnd={onDragEnd}
      onDragOver={onDragOver} onDrop={onDrop}>
      <header>
        <span className="kanban-card-id">#{card.id}</span>
        {card.stale && <span className="kanban-dot-stale" title="Idle past threshold" />}
        {unready && (
          <button type="button" className="kanban-badge-unready"
            title="Needs a contract (objective + acceptance criteria) — click to groom"
            onClick={openGroom}>not ready</button>
        )}
      </header>
      <p className="kanban-card-title">{card.title}</p>
      {grooming && (
        <div className="kanban-groom">
          <input value={objective} onChange={(e) => setObjective(e.target.value)}
            placeholder="Objective" aria-label="Objective" />
          <textarea value={criteria} onChange={(e) => setCriteria(e.target.value)} rows={3}
            placeholder={'Acceptance criteria, one per line'} aria-label="Acceptance criteria" />
          {saveError && <span className="kanban-error">{saveError}</span>}
          <div className="kanban-groom-actions">
            <button type="button" onClick={saveContract}>Make ready</button>
            <button type="button" onClick={() => setGrooming(false)}>Cancel</button>
          </div>
        </div>
      )}
      <footer>
        {epic && <span className="kanban-epic-tag" title={epic.title}>{epic.title}</span>}
        {card.owner && (
          <span className={`kanban-owner${ownerWorking ? ' working' : ''}`}
            title={ownerWorking ? `${card.owner} — working now` : card.owner}
            style={{ background: agentWash(card.owner), color: agentInk(card.owner) }}>
            {initials(card.owner)}
            {ownerWorking && <i className="kanban-owner-pulse" aria-hidden="true" />}
          </span>
        )}
        <span className="kanban-when">{timeAgo(card.updated_at)}</span>
      </footer>
    </article>
  )
}
