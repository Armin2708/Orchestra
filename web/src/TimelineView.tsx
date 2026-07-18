import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Snapshot, TimelineItem, agentInk, agentWash, fetchTimeline, initials, streamUrl, timeAgo } from './api'

const TYPE_FILTERS = ['created', 'moved', 'shipped', 'launched', 'review', 'message', 'milestone']
const itemKey = (boardId: number, i: TimelineItem) => `${boardId}:${i.source}:${i.id}`

const SOURCE_ICON: Record<TimelineItem['source'], string> = {
  card: '🗂', review: '👀', message: '💬', milestone: '⛳',
}

// one lane per board; multi-board view merge-sorts client-side
type Lane = { boardId: number; boardName: string; items: TimelineItem[]; cursor: string | null; hasMore: boolean }

export function TimelineView({ snaps }: { snaps: Snapshot[]; focused?: boolean; onChange?: () => void }) {
  const [lanes, setLanes] = useState<Lane[]>([])
  const [agent, setAgent] = useState('')
  const [type, setType] = useState('')
  const [card, setCard] = useState('')
  const [loading, setLoading] = useState(false)
  const sentinel = useRef<HTMLDivElement>(null)
  const boardKey = snaps.map((s) => s.board.id).join(',')
  const filters = { agent: agent || undefined, type: type || undefined, card: card ? Number(card) : undefined }
  const filterKey = `${agent}|${type}|${card}`

  const loadHead = useCallback(async () => {
    setLoading(true)
    try {
      const pages = await Promise.all(snaps.map(async (s) => ({
        boardId: s.board.id, boardName: s.board.name,
        page: await fetchTimeline(s.board.id, { ...filters, limit: 50 }).catch(() => null),
      })))
      setLanes((prev) => pages.filter((p) => p.page).map(({ boardId, boardName, page }) => {
        const old = prev.find((l) => l.boardId === boardId)
        // live prepend: merge new head into what's already loaded, dedupe by source+id
        const seen = new Set(page!.items.map((i) => itemKey(boardId, i)))
        const kept = (old?.items ?? []).filter((i) => !seen.has(itemKey(boardId, i)))
        const merged = old ? [...page!.items, ...kept] : page!.items
        return {
          boardId, boardName, items: merged,
          cursor: old?.cursor ?? page!.next_cursor,
          hasMore: old ? old.hasMore : page!.has_more,
        }
      }))
    } finally { setLoading(false) }
  }, [boardKey, filterKey, snaps.length])

  // filters or visible boards changed — reset and refetch from the top
  useEffect(() => { setLanes([]); loadHead() }, [boardKey, filterKey])

  // live updates ride the existing SSE stream; any board event refreshes the head (debounced)
  useEffect(() => {
    const es = new EventSource(streamUrl())
    let pending: number | undefined
    es.onmessage = () => {
      if (pending) return
      pending = window.setTimeout(() => { pending = undefined; loadHead() }, 500)
    }
    return () => { es.close(); if (pending) clearTimeout(pending) }
  }, [loadHead])

  const loadMore = useCallback(async () => {
    if (loading) return
    const lane = lanes.find((l) => l.hasMore)
    if (!lane) return
    setLoading(true)
    try {
      const page = await fetchTimeline(lane.boardId, { ...filters, cursor: lane.cursor ?? undefined, limit: 50 })
      setLanes((prev) => prev.map((l) => l.boardId === lane.boardId
        ? { ...l, items: [...l.items, ...page.items], cursor: page.next_cursor, hasMore: page.has_more }
        : l))
    } finally { setLoading(false) }
  }, [lanes, loading, filterKey])

  // cursor infinite scroll
  useEffect(() => {
    const el = sentinel.current
    if (!el) return
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) loadMore() })
    io.observe(el)
    return () => io.disconnect()
  }, [loadMore])

  const agents = [...new Set(snaps.flatMap((s) => s.agents.map((a) => a.name)))].sort()
  const multi = snaps.length > 1
  const rows = lanes
    .flatMap((l) => l.items.map((i) => ({ ...i, boardId: l.boardId, boardName: l.boardName })))
    .sort((a, b) => (a.ts === b.ts ? b.id - a.id : a.ts < b.ts ? 1 : -1))
  const hasMore = lanes.some((l) => l.hasMore)

  return (
    <div className="timeline">
      <div className="timeline-filters">
        <select className="timeline-filter" value={agent} onChange={(e) => setAgent(e.target.value)}>
          <option value="">all agents</option>
          {agents.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
        <select className="timeline-filter" value={type} onChange={(e) => setType(e.target.value)}>
          <option value="">all activity</option>
          {TYPE_FILTERS.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <input className="timeline-filter timeline-card-input" placeholder="card #" inputMode="numeric"
          value={card} onChange={(e) => setCard(e.target.value.replace(/\D/g, ''))} />
        {(agent || type || card) && (
          <button className="btn ghost timeline-clear" onClick={() => { setAgent(''); setType(''); setCard('') }}>clear</button>
        )}
      </div>
      <ol className="timeline-feed">
        {rows.map((r) => (
          <li key={itemKey(r.boardId, r)} className={`timeline-item src-${r.source}`}>
            <span className="timeline-icon" title={r.source}>{SOURCE_ICON[r.source]}</span>
            <div className="timeline-body">
              <p className="timeline-summary">
                {r.agent && (
                  <span className="owner">
                    <i className="avatar mini" style={{ background: agentWash(r.agent), color: agentInk(r.agent) }}>{initials(r.agent)}</i>
                  </span>
                )}
                {r.summary}
              </p>
              <p className="timeline-meta">
                {multi && <span className="timeline-board">{r.boardName}</span>}
                {r.card_id && <span className="timeline-ref">#{r.card_id}</span>}
                <span className="timeline-when" title={r.ts}>{timeAgo(r.ts)}</span>
              </p>
            </div>
          </li>
        ))}
      </ol>
      {rows.length === 0 && !loading && <p className="timeline-empty">No activity yet{agent || type || card ? ' for these filters' : ''}.</p>}
      <div ref={sentinel} className="timeline-sentinel">
        {loading ? 'loading…' : hasMore ? '' : rows.length > 0 ? '· end of history ·' : ''}
      </div>
    </div>
  )
}
