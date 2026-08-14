import React, { useEffect, useRef, useState } from 'react'
import { api, Agent, Card, Snapshot, Thread, agentInk, agentWash, initials, timeAgo } from './api'
import { CardDrawer } from './CardDrawer'
import { AgentTerminal } from './AgentTerminal'
import { NetworkView } from './NetworkView'
import { ProviderBadge } from './ProviderBadge'
import { ProviderLaunchControl } from './ProviderLaunchControl'
import { HireControl } from './HireModal'
// the mastermind lives in the Teams tab only — it never renders as Overview crew
import { isMastermind } from './mastermind'
import { AgentProviderCatalog, osApi } from './osApi'
import { boardIdFromSearch, cardDrawerDeepLink, cardIdFromSearch } from './boardDeepLink'
import {
  CanvasPoint,
  CanvasViewport,
  canvasViewportStorageKey,
  canvasGrid,
  clampCanvasZoom,
  defaultCanvasViewport,
  panCanvasBy,
  screenToCanvasLocal,
  zoomCanvasAt,
} from './canvasViewport'

export const STATUS: Record<string, { label: string; bg: string; ink: string }> = {
  backlog: { label: 'Queued', bg: '#F1F0EC', ink: '#686762' },
  in_progress: { label: 'Working', bg: '#FBF3DB', ink: '#956400' },
  blocked: { label: 'Blocked', bg: '#FDEBEC', ink: '#9F2F2D' },
  review: { label: 'Review', bg: '#E1F3FE', ink: '#1F6C9F' },
  done: { label: 'Done', bg: '#EDF3EC', ink: '#346538' },
}

// every hired agent spawns in the spawn pool under the + Hire bar: its "new" tag
// clears the first time the operator opens it, and it only leaves the pool when
// dragged out (activation) — both persist per browser in localStorage
const SEEN_HIRES_KEY = 'orchestra-seen-hired-agents'
const ACTIVATED_HIRES_KEY = 'orchestra-activated-hires'
// agents older than this at seed time are pre-existing crew, not unseen new hires
const SEED_GRACE_MS = 10 * 60 * 1000

function loadIdSet(key: string): Set<number> | null {
  try {
    const raw = localStorage.getItem(key)
    if (raw === null) return null
    return new Set((JSON.parse(raw) as number[]).filter((id) => Number.isFinite(id)))
  } catch { return null }
}

function saveIdSet(key: string, ids: Set<number>) {
  try { localStorage.setItem(key, JSON.stringify([...ids])) } catch { /* private mode */ }
}

function hiredAgo(a: Agent): number {
  return a.created_at ? Date.now() - new Date(a.created_at.replace(' ', 'T') + 'Z').getTime() : Infinity
}

// a pooled agent looks like a regular network node — round avatar + name — with a
// "new" tag until first opened. It drags like canvas agents (the node follows the
// pointer); releasing it outside the pool activates it, a plain tap opens it.
// The release point is handed to the graph so the agent lands where it was dropped.
function PoolNode({ a, isNew, viewport, onOpen, onActivate }: {
  a: Agent
  isNew?: boolean
  viewport: CanvasViewport
  onOpen: () => void
  onActivate: (dropAt: { x: number; y: number } | null) => void
}) {
  const [drag, setDrag] = useState<{ dx: number; dy: number } | null>(null)
  const origin = useRef<{ x: number; y: number } | null>(null)
  const moved = useRef(false)
  const node = useRef<HTMLDivElement>(null)

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    try { (e.target as Element).setPointerCapture?.(e.pointerId) } catch { /* synthetic pointer */ }
    origin.current = { x: e.clientX, y: e.clientY }
    moved.current = false
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (!origin.current) return
    const dx = e.clientX - origin.current.x
    const dy = e.clientY - origin.current.y
    if (!moved.current && Math.hypot(dx, dy) < 4) return
    moved.current = true
    setDrag({ dx, dy })
  }
  const finishDrag = (e: React.PointerEvent, cancelled: boolean) => {
    if (!origin.current) return
    const wasDrag = moved.current
    origin.current = null
    moved.current = false
    setDrag(null)
    if (cancelled) return
    if (!wasDrag) { onOpen(); return }
    const pool = node.current?.closest('.hire-pool')?.getBoundingClientRect()
    const outside = !pool || e.clientX < pool.left || e.clientX > pool.right
      || e.clientY < pool.top || e.clientY > pool.bottom
    if (outside) onActivate(dropNorm(e))
  }

  // release point → the graph's normalized coords (same math as NetworkView.onMove)
  const dropNorm = (e: React.PointerEvent): { x: number; y: number } | null => {
    const project = node.current?.closest('.project')
    const network = project?.querySelector('.network')
    const board = project?.closest('.board-canvas')
    if (!network || !board) return null
    const nRect = network.getBoundingClientRect()
    const bRect = board.getBoundingClientRect()
    if (nRect.width <= 0 || nRect.height <= 0) return null
    const local = screenToCanvasLocal(
      viewport,
      { x: e.clientX - bRect.left, y: e.clientY - bRect.top },
      { x: nRect.left - bRect.left, y: nRect.top - bRect.top },
    )
    return {
      x: Math.min(4, Math.max(-3, local.x / nRect.width)),
      y: Math.min(4, Math.max(-3, local.y / nRect.height)),
    }
  }

  return (
    <div ref={node} className={`pool-node ${drag ? 'dragging' : ''}`}
      style={drag ? { transform: `translate(${drag.dx}px, ${drag.dy}px)` } : undefined}>
      {isNew && <i className="new-tag">new</i>}
      <span className={`net-avatar round ${a.status} ${a.kind === 'hired' ? 'hired' : ''}`}
        title={`${a.name} · click to open, drag out of the pool to activate`}
        role="button" tabIndex={0} aria-label={`Open ${a.name}'s console`}
        style={{ background: agentWash(a.name), color: agentInk(a.name) }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(e) => finishDrag(e, false)}
        onPointerCancel={(e) => finishDrag(e, true)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen() } }}>
        {initials(a.name)}
        <i className={`presence ${a.status}`} />
      </span>
      <span className="net-name">{a.name} <ProviderBadge provider={a.provider} compact /></span>
    </div>
  )
}

// the pool collapses away (shrinks to nothing) once its last agent is dragged out
function SpawnPool({ pooled, isNewHire, viewport, onOpen, onActivate }: {
  pooled: Agent[]
  isNewHire: (a: Agent) => boolean
  viewport: CanvasViewport
  onOpen: (a: Agent) => void
  onActivate: (a: Agent, dropAt: { x: number; y: number } | null) => void
}) {
  const [ghost, setGhost] = useState(false)
  const hadAgents = useRef(pooled.length > 0)
  useEffect(() => {
    if (pooled.length === 0 && hadAgents.current) {
      setGhost(true)
      const t = setTimeout(() => setGhost(false), 340)
      hadAgents.current = false
      return () => clearTimeout(t)
    }
    hadAgents.current = pooled.length > 0
  }, [pooled.length])

  if (pooled.length === 0 && !ghost) return null
  return (
    <div className={`hire-pool ${pooled.length === 0 ? 'collapsing' : ''}`}
      aria-label="Spawn pool — drag an agent out to activate it">
      {pooled.map((a) => (
        <PoolNode key={a.id} a={a} isNew={isNewHire(a)} viewport={viewport}
          onOpen={() => onOpen(a)} onActivate={(dropAt) => onActivate(a, dropAt)} />
      ))}
      <i className="pool-hint">drag out to activate</i>
    </div>
  )
}

function CrewSlot({ a, isNew, onOpen, onChange }: {
  a: Agent
  isNew?: boolean
  onOpen: () => void
  onChange: () => void
}) {
  return (
    <span className="crew-slot">
      {isNew && <i className="new-tag">new</i>}
      <span className={`avatar clickable ${a.status} ${a.kind === 'hired' ? 'hired' : ''}`}
        title={`${a.name} · ${a.status} · open console`}
        role="button" tabIndex={0} aria-label={`Open ${a.name}'s console`}
        style={{ background: agentWash(a.name), color: agentInk(a.name) }}
        onClick={onOpen}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen() } }}>
        {initials(a.name)}
        <i className="presence" />
      </span>
      <ProviderBadge provider={a.provider} compact />
      {a.kind === 'hired' && (
        <button className="icon-x fire" title={`Fire ${a.name}`} aria-label={`Fire ${a.name}`}
          onClick={async () => {
            if (!window.confirm(`Fire ${a.name}? Its running session is killed.`)) return
            await api('POST', `/agents/${a.id}/fire`); onChange()
          }}>×</button>
      )}
    </span>
  )
}

// the rail lists open tickets in the order an operator triages them
const RAIL_GROUP_ORDER = ['in_progress', 'review', 'blocked', 'backlog']

function RailCard({ c, isLocked, providers, onOpen, onChange }: {
  c: Card
  isLocked: boolean
  providers: AgentProviderCatalog[]
  onOpen: (c: Card) => void
  onChange?: () => void
}) {
  const st = STATUS[c.column] ?? STATUS.backlog
  return (
    <article className={`t-card ${isLocked ? 'chained' : ''}`}
      draggable
      role="button" tabIndex={0}
      onClick={() => onOpen(c)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(c) } }}
      onDragStart={(e) => e.dataTransfer.setData('text/ticket-id', String(c.id))}
      style={{ ['--st' as any]: st.ink }}
      title={isLocked ? 'Has open prerequisite steps — the assignee will coordinate with their owners' : 'Drag onto an agent to assign'}>
      <div className="t-top">
        <span className="t-id">#{c.id}</span>
        <span className="status-chip" style={{ background: st.bg, color: st.ink }}>{isLocked ? '⛓ ' : ''}{st.label}</span>
        {c.column === 'review' && c.verification && (
          <span className={`verify-badge vb-${c.verification.running ? 'running' : c.verification.verdict}`}
            title={c.verification.running ? 'verifier running' : `verifier verdict: ${c.verification.verdict}`}>
            {c.verification.running ? '◌' : c.verification.verdict === 'pass' ? '✓' : c.verification.verdict === 'gaps' ? '△' : c.verification.verdict === 'fail' ? '✗' : ''}
          </span>
        )}
        {!c.owner && c.column !== 'done' && (
          <ProviderLaunchControl providers={providers} variant="card" stopPropagation
            label="▶ Launch" title="Launch an autonomous agent on this ticket"
            onLaunch={async (body) => { await api('POST', `/cards/${c.id}/launch`, body); onChange?.() }} />
        )}
      </div>
      <h4>{c.title}</h4>
      {c.description && <p className="t-desc">{c.description}</p>}
      <footer>
        {c.owner
          ? <span className="owner"><i className="avatar mini" style={{ background: agentWash(c.owner), color: agentInk(c.owner) }}>{initials(c.owner)}</i>{c.owner.split('-')[0]}</span>
          : <span className="owner unowned">drag → agent</span>}
        <time>{timeAgo(c.updated_at)}</time>
      </footer>
    </article>
  )
}

function TicketRail({ snap, providers, onOpen, onChange }: {
  snap: Snapshot
  providers: AgentProviderCatalog[]
  onOpen: (c: Card) => void
  onChange?: () => void
}) {
  const [collapsed, setCollapsed] = useState<Set<number>>(() => new Set())
  const [showDone, setShowDone] = useState(false)
  const panelKey = `orchestra-task-panel-${snap.board.id}`
  const [panelOpen, setPanelOpen] = useState(() => {
    try { return localStorage.getItem(panelKey) === 'open' } catch { return false }
  })
  const done = snap.cards.filter((c) => c.column === 'done').sort((a, b) => b.id - a.id)
  const toggle = (id: number) => setCollapsed((prev) => {
    const next = new Set(prev)
    next.has(id) ? next.delete(id) : next.add(id)
    return next
  })
  const locked = (c: Card) => Boolean(c.milestone_id && snap.cards.some((o) =>
    o.milestone_id === c.milestone_id && (o.step_order ?? 0) < (c.step_order ?? 0) && o.column !== 'done'))
  const loose = snap.cards.filter((c) => c.column !== 'done' && !c.milestone_id)
  // loose tickets read as one undifferentiated wall unless they are grouped by what
  // is actually happening to them — working first, queued last (#158)
  const groups = [...RAIL_GROUP_ORDER.map((column) => ({
    key: column,
    label: (STATUS[column] ?? STATUS.backlog).label,
    cards: loose.filter((c) => c.column === column),
  })), {
    key: 'other',
    label: 'Other',
    cards: loose.filter((c) => !RAIL_GROUP_ORDER.includes(c.column)),
  }].filter((g) => g.cards.length > 0)
  const milestones = (snap.milestones ?? []).map((m) => {
    const steps = snap.cards.filter((c) => c.milestone_id === m.id)
      .sort((a, b) => (a.step_order ?? 0) - (b.step_order ?? 0))
    return { m, steps, open: steps.filter((s) => s.column !== 'done'), done: steps.filter((s) => s.column === 'done').length }
  }).filter((g) => g.steps.length > 0)
  const openCount = snap.cards.filter((c) => c.column !== 'done').length
  const panelId = `task-panel-${snap.board.id}`
  const togglePanel = () => setPanelOpen((current) => {
    const next = !current
    try { localStorage.setItem(panelKey, next ? 'open' : 'closed') } catch { /* optional preference */ }
    return next
  })

  return (
    <div className={`task-panel ${panelOpen ? 'open' : 'closed'}`}>
      <button type="button" className="task-panel-toggle" aria-expanded={panelOpen}
        aria-controls={panelId} aria-label={panelOpen ? 'Close tasks panel' : `Open tasks panel, ${openCount} open tasks`}
        title={panelOpen ? 'Close tasks' : `Open tasks — ${openCount} open on this board`} onClick={togglePanel}>
        <span className="task-panel-bars" aria-hidden="true"><i /><i /><i /></span>
        <span className="task-panel-label">Tasks</span>
        <span className="task-panel-count">{panelOpen ? `${openCount} open` : openCount}</span>
      </button>
      {panelOpen && (
        <aside id={panelId} className="ticket-rail" aria-label={`${snap.board.name} tasks`}>
          {/* the rail is also rendered by the Teams tab with a filtered snapshot (#156),
              so this copy stays scope-neutral */}
          <p className="rail-hint">Open tickets. Drag one onto an agent to assign it, or click it to open the ticket.</p>
          {loose.length === 0 && milestones.length === 0 && (
            <p className="rail-empty">No open tickets yet — add some on the Roadmap, or ask an agent to file one.</p>
          )}
          {milestones.length > 0 && <p className="rail-head">Milestones <span className="rm-count">{milestones.length}</span></p>}
          {milestones.map(({ m, steps, open: openSteps, done }) => (
            <div key={m.id} className="rail-mile">
              <button className="rail-mile-head" onClick={() => toggle(m.id)}>
                <span className="rail-mile-flag">{m.status === 'shipped' ? '🏆' : m.status === 'dropped' ? '✕' : done === steps.length ? '🏆' : '⛳'}</span>
                <span className="rail-mile-title">{m.title}</span>
                {m.status && m.status !== 'open' && <span className="rm-count">{m.status}</span>}
                <span className="rm-count">{done}/{steps.length}</span>
                <span className="thread-caret">{collapsed.has(m.id) ? '▸' : '▾'}</span>
              </button>
              {!collapsed.has(m.id) && (
                <div className="rail-mile-steps">
                  {openSteps.map((c) => <RailCard key={c.id} c={c} isLocked={locked(c)} providers={providers} onOpen={onOpen} onChange={onChange} />)}
                  {openSteps.length === 0 && <p className="rail-empty">All steps complete 🏆</p>}
                </div>
              )}
            </div>
          ))}
          {groups.map((group) => (
            <div key={group.key} className="rail-group">
              <p className="rail-head">{group.label} <span className="rm-count">{group.cards.length}</span></p>
              {group.cards.map((c) => (
                <RailCard key={c.id} c={c} isLocked={false} providers={providers} onOpen={onOpen} onChange={onChange} />
              ))}
            </div>
          ))}
          {done.length > 0 && (
            <div className="rail-mile">
              <button className="rail-mile-head" onClick={() => setShowDone((v) => !v)}>
                <span className="rail-mile-flag">✓</span>
                <span className="rail-mile-title">Completed</span>
                <span className="rm-count">{done.length}</span>
                <span className="thread-caret">{showDone ? '▾' : '▸'}</span>
              </button>
              {showDone && (
                <div className="rail-mile-steps">
                  {done.map((c) => (
                    <div key={c.id} className="rail-done" onClick={() => onOpen(c)}>
                      <span className="rail-done-title">{c.title}</span>
                      {c.owner && <span className="rail-done-owner">{c.owner.split('-')[0]}</span>}
                      <button className="rail-restore" title="Restore to backlog for reassignment"
                        onClick={async (e) => { e.stopPropagation(); await api('POST', `/cards/${c.id}/restore`); onChange?.() }}>↺</button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </aside>
      )}
    </div>
  )
}

const boardCanvasMidpoint = (a: CanvasPoint, b: CanvasPoint): CanvasPoint => ({
  x: (a.x + b.x) / 2,
  y: (a.y + b.y) / 2,
})
const boardCanvasDistance = (a: CanvasPoint, b: CanvasPoint) => Math.hypot(a.x - b.x, a.y - b.y)

function loadBoardViewport(storageKey: string, compact: boolean): CanvasViewport {
  const persistentKey = canvasViewportStorageKey(storageKey, compact)
  try {
    const value = JSON.parse(localStorage.getItem(`orchestra-board-view-${persistentKey}`) ?? 'null')
    if (Number.isFinite(value?.x) && Number.isFinite(value?.y) && Number.isFinite(value?.zoom)) {
      return { x: value.x, y: value.y, zoom: clampCanvasZoom(value.zoom) }
    }
  } catch { /* reset malformed local state */ }
  return defaultCanvasViewport(compact)
}

const BOARD_PAN_EXCLUDE = [
  'button', 'input', 'textarea', 'select', 'a', '[role="button"]', '[draggable="true"]',
  '.q-edge', '.project-head-right', '.task-panel', '.ticket-rail', '.project-cards', '.threads', '.ideas',
  '.add-form', '.net-prompt', '.net-thread',
].join(', ')
const BOARD_NATIVE_SCROLL = '.ticket-rail, .project-cards, .threads, .net-thread'

export function BoardCanvas({ children, focused, storageKey }: {
  children: (viewport: CanvasViewport) => React.ReactNode
  focused: boolean
  storageKey: string
}) {
  const wrap = useRef<HTMLElement>(null)
  const cursorLens = useRef<HTMLDivElement>(null)
  const [compact, setCompact] = useState(() => window.matchMedia('(max-width: 768px)').matches)
  const persistentStorageKey = canvasViewportStorageKey(storageKey, compact)
  const [viewport, setViewportState] = useState<CanvasViewport>(() => loadBoardViewport(storageKey, compact))
  const viewportRef = useRef(viewport)
  const storageKeyRef = useRef(persistentStorageKey)
  const [panning, setPanning] = useState(false)
  const pointers = useRef(new Map<number, CanvasPoint>())
  const pan = useRef<{ pointerId: number; start: CanvasPoint; viewport: CanvasViewport } | null>(null)
  const pinch = useRef<{
    pointerIds: [number, number]
    distance: number
    center: CanvasPoint
    viewport: CanvasViewport
  } | null>(null)

  const applyViewport = (next: CanvasViewport) => {
    viewportRef.current = next
    setViewportState(next)
  }

  useEffect(() => {
    const media = window.matchMedia('(max-width: 768px)')
    const updateCompact = () => setCompact(media.matches)
    media.addEventListener('change', updateCompact)
    return () => media.removeEventListener('change', updateCompact)
  }, [])

  useEffect(() => {
    storageKeyRef.current = persistentStorageKey
    pointers.current.clear()
    pan.current = null
    pinch.current = null
    setPanning(false)
    const next = loadBoardViewport(storageKey, compact)
    viewportRef.current = next
    setViewportState(next)
  }, [compact, persistentStorageKey, storageKey])

  useEffect(() => {
    const key = persistentStorageKey
    const timer = window.setTimeout(() => {
      if (storageKeyRef.current !== key) return
      try { localStorage.setItem(`orchestra-board-view-${key}`, JSON.stringify(viewport)) } catch { /* optional persistence */ }
    }, 120)
    return () => window.clearTimeout(timer)
  }, [persistentStorageKey, viewport])

  useEffect(() => {
    const canvas = wrap.current
    if (!canvas) return
    const handleWheel = (e: WheelEvent) => {
      const target = e.target as Element | null
      if (target?.closest(BOARD_NATIVE_SCROLL) && !e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      const rect = canvas.getBoundingClientRect()
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? rect.height : 1
      const factor = Math.exp(-e.deltaY * unit * 0.0015)
      applyViewport(zoomCanvasAt(
        viewportRef.current,
        viewportRef.current.zoom * factor,
        { x: e.clientX - rect.left, y: e.clientY - rect.top },
      ))
    }
    canvas.addEventListener('wheel', handleWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', handleWheel)
  }, [])

  useEffect(() => {
    const canvas = wrap.current
    const lens = cursorLens.current
    if (!canvas || !lens) return
    if (window.matchMedia('(pointer: coarse)').matches || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return

    const radius = lens.offsetWidth / 2 || 84
    let frame = 0
    let initialized = false
    let current = { x: 0, y: 0 }
    let target = { x: 0, y: 0 }

    const render = () => {
      const dx = target.x - current.x
      const dy = target.y - current.y
      current = { x: current.x + dx * 0.18, y: current.y + dy * 0.18 }
      const residual = Math.hypot(dx, dy)
      const bendX = Math.max(-18, Math.min(18, dx * 0.14))
      const bendY = Math.max(-18, Math.min(18, dy * 0.14))
      lens.style.setProperty('--cursor-lens-left', `${current.x - radius}px`)
      lens.style.setProperty('--cursor-lens-top', `${current.y - radius}px`)
      lens.style.setProperty('--cursor-bend-x', `${bendX}px`)
      lens.style.setProperty('--cursor-bend-y', `${bendY}px`)
      lens.style.setProperty('--cursor-lens-scale', String(1 + Math.min(residual / 1200, 0.035)))
      if (residual > 0.2) frame = window.requestAnimationFrame(render)
      else frame = 0
    }

    const moveLens = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return
      const rect = canvas.getBoundingClientRect()
      target = { x: e.clientX - rect.left, y: e.clientY - rect.top }
      if (!initialized) { current = target; initialized = true }
      lens.classList.add('active')
      if (!frame) frame = window.requestAnimationFrame(render)
    }
    const hideLens = () => lens.classList.remove('active')

    canvas.addEventListener('pointermove', moveLens)
    canvas.addEventListener('pointerleave', hideLens)
    canvas.addEventListener('pointercancel', hideLens)
    return () => {
      canvas.removeEventListener('pointermove', moveLens)
      canvas.removeEventListener('pointerleave', hideLens)
      canvas.removeEventListener('pointercancel', hideLens)
      if (frame) window.cancelAnimationFrame(frame)
    }
  }, [])

  const canvasPoint = (clientX: number, clientY: number): CanvasPoint => {
    const rect = wrap.current!.getBoundingClientRect()
    return { x: clientX - rect.left, y: clientY - rect.top }
  }

  const startPan = (e: React.PointerEvent<HTMLElement>) => {
    if ((e.target as Element).closest(BOARD_PAN_EXCLUDE)) return
    if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 1) return
    e.preventDefault()
    e.currentTarget.focus({ preventScroll: true })
    const point = canvasPoint(e.clientX, e.clientY)
    pointers.current.set(e.pointerId, point)
    e.currentTarget.setPointerCapture(e.pointerId)
    const active = [...pointers.current.entries()]
    if (active.length >= 2) {
      const [first, second] = active
      pinch.current = {
        pointerIds: [first[0], second[0]],
        distance: Math.max(boardCanvasDistance(first[1], second[1]), 1),
        center: boardCanvasMidpoint(first[1], second[1]),
        viewport: viewportRef.current,
      }
      pan.current = null
    } else {
      pinch.current = null
      pan.current = { pointerId: e.pointerId, start: point, viewport: viewportRef.current }
    }
    setPanning(true)
  }

  const moveCanvas = (e: React.PointerEvent<HTMLElement>) => {
    if (!pointers.current.has(e.pointerId)) return
    const point = canvasPoint(e.clientX, e.clientY)
    pointers.current.set(e.pointerId, point)
    const pinchState = pinch.current
    if (pinchState) {
      const a = pointers.current.get(pinchState.pointerIds[0])
      const b = pointers.current.get(pinchState.pointerIds[1])
      if (!a || !b) return
      const center = boardCanvasMidpoint(a, b)
      const ratio = boardCanvasDistance(a, b) / Math.max(pinchState.distance, 1)
      const zoomed = zoomCanvasAt(
        pinchState.viewport,
        pinchState.viewport.zoom * ratio,
        pinchState.center,
      )
      applyViewport(panCanvasBy(zoomed, {
        x: center.x - pinchState.center.x,
        y: center.y - pinchState.center.y,
      }))
      return
    }
    const panState = pan.current
    if (panState?.pointerId === e.pointerId) {
      applyViewport(panCanvasBy(panState.viewport, {
        x: point.x - panState.start.x,
        y: point.y - panState.start.y,
      }))
    }
  }

  const endPan = (e: React.PointerEvent<HTMLElement>) => {
    if (!pointers.current.delete(e.pointerId)) return
    const active = [...pointers.current.entries()]
    if (active.length === 1) {
      pinch.current = null
      pan.current = { pointerId: active[0][0], start: active[0][1], viewport: viewportRef.current }
      return
    }
    if (active.length >= 2) {
      const [first, second] = active
      pinch.current = {
        pointerIds: [first[0], second[0]],
        distance: Math.max(boardCanvasDistance(first[1], second[1]), 1),
        center: boardCanvasMidpoint(first[1], second[1]),
        viewport: viewportRef.current,
      }
      return
    }
    pan.current = null
    pinch.current = null
    setPanning(false)
  }

  const zoomFromCenter = (factor: number) => {
    const rect = wrap.current?.getBoundingClientRect()
    if (!rect) return
    applyViewport(zoomCanvasAt(
      viewportRef.current,
      viewportRef.current.zoom * factor,
      { x: rect.width / 2, y: rect.height / 2 },
    ))
  }
  const resetViewport = () => applyViewport(defaultCanvasViewport(compact))

  const onKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    if (e.target !== e.currentTarget) return
    if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomFromCenter(1.2); return }
    if (e.key === '-') { e.preventDefault(); zoomFromCenter(1 / 1.2); return }
    if (e.key === '0') { e.preventDefault(); resetViewport(); return }
    const step = e.shiftKey ? 120 : 40
    const delta = e.key === 'ArrowLeft' ? { x: step, y: 0 }
      : e.key === 'ArrowRight' ? { x: -step, y: 0 }
        : e.key === 'ArrowUp' ? { x: 0, y: step }
          : e.key === 'ArrowDown' ? { x: 0, y: -step }
            : null
    if (delta) { e.preventDefault(); applyViewport(panCanvasBy(viewportRef.current, delta)) }
  }

  const grid = canvasGrid(viewport)
  const canvasStyle = {
    ['--board-grid-size' as any]: `${grid.size}px`,
    ['--board-grid-x' as any]: `${grid.x}px`,
    ['--board-grid-y' as any]: `${grid.y}px`,
    ['--board-lens-grid-size' as any]: `${Math.max(4, grid.size * 1.14)}px`,
  }

  return (
    <main className={`board-canvas ${panning ? 'panning' : ''}`} ref={wrap} style={canvasStyle}
      role="region" tabIndex={0}
      aria-label="Project board canvas. Drag empty space to pan; use the wheel, pinch gesture, or controls to zoom."
      onPointerDown={startPan} onPointerMove={moveCanvas}
      onPointerUp={endPan} onPointerCancel={endPan} onLostPointerCapture={endPan}
      onKeyDown={onKeyDown}>
      <svg className="board-cursor-filter" aria-hidden="true">
        <defs>
          <filter id="board-cursor-warp" x="-20%" y="-20%" width="140%" height="140%" colorInterpolationFilters="sRGB">
            <feTurbulence type="fractalNoise" baseFrequency="0.012 0.02" numOctaves="2" seed="7" result="noise" />
            <feDisplacementMap in="SourceGraphic" in2="noise" scale="13" xChannelSelector="R" yChannelSelector="B" />
          </filter>
        </defs>
      </svg>
      <div className="board-cursor-lens" ref={cursorLens} aria-hidden="true" />
      <div className="board-canvas-hit" aria-hidden="true" />
      <div className={focused ? 'projects focused' : 'projects'}>{children(viewport)}</div>
      <div className="board-controls" role="group" aria-label="Board zoom controls">
        <button type="button" className="board-control" aria-label="Zoom out" title="Zoom out"
          onClick={() => zoomFromCenter(1 / 1.2)}>−</button>
        <button type="button" className="board-control board-zoom" aria-label="Reset zoom and position"
          title="Reset zoom and position" onClick={resetViewport}>{Math.round(viewport.zoom * 100)}%</button>
        <button type="button" className="board-control" aria-label="Zoom in" title="Zoom in"
          onClick={() => zoomFromCenter(1.2)}>+</button>
      </div>
    </main>
  )
}

export function ProjectGrid({ snaps, focused = false, onChange }: { snaps: Snapshot[]; focused?: boolean; onChange: () => void }) {
  const [open, setOpen] = useState<{ card: Card; boardId: number } | null>(null)
  const [terminal, setTerminal] = useState<{ agent: Agent; boardId: number } | null>(null)
  const [providers, setProviders] = useState<AgentProviderCatalog[]>([])
  const [askTo, setAskTo] = useState<{ name: string; boardId: number } | null>(null)
  const [askBody, setAskBody] = useState('')
  const [seenHires, setSeenHires] = useState<Set<number> | null>(() => loadIdSet(SEEN_HIRES_KEY))
  const [activatedHires, setActivatedHires] = useState<Set<number> | null>(() => loadIdSet(ACTIVATED_HIRES_KEY))

  useEffect(() => {
    let current = true
    osApi.listAgentProviders().then((catalog) => { if (current) setProviders(catalog) }).catch(() => {})
    return () => { current = false }
  }, [])

  // first visit on this browser: everyone already on the boards counts as seen and
  // activated, except agents hired moments ago — those still start in the pool
  useEffect(() => {
    if ((seenHires !== null && activatedHires !== null) || snaps.length === 0) return
    const seeded = new Set(snaps.flatMap((s) => s.agents)
      .filter((a) => hiredAgo(a) >= SEED_GRACE_MS).map((a) => a.id))
    if (seenHires === null) { saveIdSet(SEEN_HIRES_KEY, seeded); setSeenHires(seeded) }
    if (activatedHires === null) { saveIdSet(ACTIVATED_HIRES_KEY, seeded); setActivatedHires(seeded) }
  }, [seenHires, activatedHires, snaps])

  // "new" tag: never opened. Pool: hired but not yet dragged out.
  const isNewHire = (a: Agent) =>
    a.kind === 'hired' && seenHires !== null && !seenHires.has(a.id)
  const inSpawnPool = (a: Agent) =>
    a.kind === 'hired' && activatedHires !== null && !activatedHires.has(a.id)

  const openTerminal = (a: Agent, boardId: number) => {
    if (isNewHire(a)) {
      const next = new Set(seenHires).add(a.id)
      saveIdSet(SEEN_HIRES_KEY, next)
      setSeenHires(next)
    }
    setTerminal({ agent: a, boardId })
  }

  // where the last activated agent was dropped — NetworkView seeds its node there
  const [netSeed, setNetSeed] = useState<{ boardId: number; name: string; x: number; y: number } | null>(null)

  const activateHire = (a: Agent, boardId: number, dropAt: { x: number; y: number } | null) => {
    const next = new Set(activatedHires).add(a.id)
    saveIdSet(ACTIVATED_HIRES_KEY, next)
    setActivatedHires(next)
    if (dropAt) setNetSeed({ boardId, name: a.name, x: dropAt.x, y: dropAt.y })
  }

  const ask = async () => {
    if (!askTo || !askBody.trim()) return
    await api('POST', '/messages', { board_id: askTo.boardId, to: askTo.name, body: askBody.trim() })
    setAskBody(''); setAskTo(null); onChange()
  }

  const askable = snaps.flatMap((s) =>
    s.agents.filter((a) => a.status !== 'gone' && !isMastermind(a))
      .map((a) => ({ ...a, boardId: s.board.id, project: s.board.name })))

  const syncCardUrl = (boardId: number, cardId: number | null) => {
    const next = cardDrawerDeepLink(location.search, { boardId, cardId }, {
      pathname: location.pathname,
      hash: location.hash,
    })
    if (`${location.pathname}${location.search}${location.hash}` !== next) {
      history.replaceState(null, '', next)
    }
  }

  const openCardDrawer = (card: Card, boardId: number) => {
    setOpen({ card, boardId })
    syncCardUrl(boardId, card.id)
  }

  const closeCardDrawer = () => {
    if (open) syncCardUrl(open.boardId, null)
    setOpen(null)
  }

  // Keep a push/deep-linked card in the URL while its drawer is open so refresh restores it.
  const deepLinked = React.useRef(false)
  React.useEffect(() => {
    if (deepLinked.current) return
    const id = cardIdFromSearch(location.search)
    const boardId = boardIdFromSearch(location.search)
    if (!id) { deepLinked.current = true; return }
    for (const s of snaps) {
      if (boardId !== null && s.board.id !== boardId) continue
      const c = s.cards.find((x) => x.id === id)
      if (c) {
        setOpen({ card: c, boardId: s.board.id })
        deepLinked.current = true
        break
      }
    }
  }, [snaps])

  const openCard = open
    ? snaps.find((s) => s.board.id === open.boardId)?.cards.find((c) => c.id === open.card.id) ?? open.card
    : null
  const canvasStorageKey = focused && snaps.length === 1 ? `project-${snaps[0].board.id}` : 'all-projects'

  return (
    <>
      <BoardCanvas focused={focused} storageKey={canvasStorageKey}>
        {(viewport) => snaps.map((s) => {
          const online = s.agents.filter((a) => a.status !== 'gone')
          const agents = online.filter((a) => !isMastermind(a))
          const pooled = agents.filter(inSpawnPool)
          const crew = agents.filter((a) => !inSpawnPool(a))
          return (
            <section key={s.board.id} className="project network-mode">
              <header className="project-head">
                <div className="project-head-col">
                  <div className="project-head-right">
                    <HireControl providers={providers} boardId={s.board.id}
                      takenNames={online.map((a) => a.name)} onHired={onChange} />
                    <div className="project-crew">
                      {crew.map((a) => (
                        <CrewSlot key={a.id} a={a} isNew={isNewHire(a)} onChange={onChange}
                          onOpen={() => openTerminal(a, s.board.id)} />
                      ))}
                      {agents.length === 0 && <span className="ask-none">no agents online</span>}
                    </div>
                  </div>
                  <SpawnPool pooled={pooled} isNewHire={isNewHire} viewport={viewport}
                    onOpen={(a) => openTerminal(a, s.board.id)}
                    onActivate={(a, dropAt) => activateHire(a, s.board.id, dropAt)} />
                </div>
              </header>

              <div className="net-wrap">
                <TicketRail snap={s} providers={providers} onOpen={(c) => openCardDrawer(c, s.board.id)} onChange={onChange} />
                <NetworkView snap={{ ...s, agents: crew }} viewport={viewport}
                  posSeed={netSeed && netSeed.boardId === s.board.id ? netSeed : null}
                  onOpenCard={(c) => openCardDrawer(c, s.board.id)}
                  onOpenAgent={(a) => setTerminal({ agent: a, boardId: s.board.id })}
                  onChange={onChange} />
              </div>
            </section>
          )
        })}
      </BoardCanvas>

      <div className="ask-dock">
        {askTo === null ? (
          <div className="ask-row">
            <span className="ask-label">Ask an agent</span>
            {/* chips own their own wrapping row so the label stays on a line of its own above them */}
            <div className="ask-chips">
              {askable.length === 0 && <span className="ask-none">no one online</span>}
              {askable.map((a) => (
                <button key={`${a.boardId}-${a.id}`} className="agent-chip" onClick={() => setAskTo({ name: a.name, boardId: a.boardId })}>
                  <i className="avatar mini" style={{ background: agentWash(a.name), color: agentInk(a.name) }}>{initials(a.name)}</i>
                  {a.name}
                  {snaps.length > 1 && <small className="chip-project">{a.project}</small>}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="ask-row open">
            <i className="avatar mini" style={{ background: agentWash(askTo.name), color: agentInk(askTo.name) }}>{initials(askTo.name)}</i>
            <input autoFocus value={askBody} placeholder={`Ask ${askTo.name} — delivered into their context`}
              onChange={(e) => setAskBody(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') ask(); if (e.key === 'Escape') setAskTo(null) }} />
            <button className="btn primary" onClick={ask}>Send</button>
            <button className="btn ghost" onClick={() => setAskTo(null)}>Cancel</button>
          </div>
        )}
      </div>

      {open && openCard && <CardDrawer card={openCard} boardId={open.boardId}
        providers={providers}
        agents={(snaps.find((s) => s.board.id === open.boardId)?.agents ?? []).filter((a) => a.status !== 'gone' && a.name !== 'strategist' && !a.name.startsWith('auditor-') && !isMastermind(a))}
        onClose={closeCardDrawer} onChange={onChange} />}
      {terminal && <AgentTerminal
        agent={snaps.find((s) => s.board.id === terminal.boardId)?.agents.find((a) => a.id === terminal.agent.id) ?? terminal.agent}
        boardId={terminal.boardId}
        threads={(snaps.find((s) => s.board.id === terminal.boardId)?.threads ?? []) as Thread[]}
        cards={snaps.find((s) => s.board.id === terminal.boardId)?.cards ?? []}
        onClose={() => setTerminal(null)} onChange={onChange} />}
    </>
  )
}
