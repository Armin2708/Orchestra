import React, { useEffect, useRef, useState } from 'react'
import { api, Agent, Card, Snapshot, Thread, agentInk, agentWash, initials, timeAgo } from './api'
import { CardDrawer } from './CardDrawer'
import { AgentTerminal } from './AgentTerminal'
import { NetworkView } from './NetworkView'
import { ProviderBadge } from './ProviderBadge'
import { ProviderLaunchControl } from './ProviderLaunchControl'
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
  zoomCanvasAt,
} from './canvasViewport'

export const STATUS: Record<string, { label: string; bg: string; ink: string }> = {
  backlog: { label: 'Queued', bg: '#F1F0EC', ink: '#686762' },
  in_progress: { label: 'Working', bg: '#FBF3DB', ink: '#956400' },
  blocked: { label: 'Blocked', bg: '#FDEBEC', ink: '#9F2F2D' },
  review: { label: 'Review', bg: '#E1F3FE', ink: '#1F6C9F' },
  done: { label: 'Done', bg: '#EDF3EC', ink: '#346538' },
}

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
        title={panelOpen ? 'Close tasks' : 'Open tasks'} onClick={togglePanel}>
        <span className="task-panel-bars" aria-hidden="true"><i /><i /><i /></span>
        <span className="task-panel-label">Tasks</span>
        <span className="task-panel-count">{openCount}</span>
      </button>
      {panelOpen && (
        <aside id={panelId} className="ticket-rail" aria-label={`${snap.board.name} tasks`}>
          {loose.length === 0 && milestones.length === 0 && (
            <p className="rail-empty">No open tickets — add some on the Roadmap.</p>
          )}
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
          {loose.length > 0 && <p className="rail-head">Tickets <span className="rm-count">{loose.length}</span></p>}
          {loose.map((c) => <RailCard key={c.id} c={c} isLocked={false} providers={providers} onOpen={onOpen} onChange={onChange} />)}
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
  '.add-form', '.net-prompt', '.net-thread', '.net-legend',
].join(', ')
const BOARD_NATIVE_SCROLL = '.ticket-rail, .project-cards, .threads, .net-thread'

function BoardCanvas({ children, focused, storageKey }: {
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

  useEffect(() => {
    let current = true
    osApi.listAgentProviders().then((catalog) => { if (current) setProviders(catalog) }).catch(() => {})
    return () => { current = false }
  }, [])

  const ask = async () => {
    if (!askTo || !askBody.trim()) return
    await api('POST', '/messages', { board_id: askTo.boardId, to: askTo.name, body: askBody.trim() })
    setAskBody(''); setAskTo(null); onChange()
  }

  const askable = snaps.flatMap((s) =>
    s.agents.filter((a) => a.status !== 'gone').map((a) => ({ ...a, boardId: s.board.id, project: s.board.name })))

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
          const agents = s.agents.filter((a) => a.status !== 'gone')
          return (
            <section key={s.board.id} className="project network-mode">
              <header className="project-head">
                <div className="project-head-right">
                  <ProviderLaunchControl providers={providers} variant="hire" label="+ Hire"
                    title="Spawn an autonomous agent on this project"
                    onLaunch={async (body) => { await api('POST', `/boards/${s.board.id}/hire`, body); onChange() }} />
                  <div className="project-crew">
                    {agents.map((a) => (
                      <span key={a.id} className="crew-slot">
                        <span className={`avatar clickable ${a.status} ${a.kind === 'hired' ? 'hired' : ''}`}
                          title={`${a.name} · ${a.status} · open console`}
                          role="button" tabIndex={0} aria-label={`Open ${a.name}'s console`}
                          style={{ background: agentWash(a.name), color: agentInk(a.name) }}
                          onClick={() => setTerminal({ agent: a, boardId: s.board.id })}
                          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setTerminal({ agent: a, boardId: s.board.id }) } }}>
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
                    ))}
                    {agents.length === 0 && <span className="ask-none">no agents online</span>}
                  </div>
                </div>
              </header>

              <div className="net-wrap">
                <TicketRail snap={s} providers={providers} onOpen={(c) => openCardDrawer(c, s.board.id)} onChange={onChange} />
                <NetworkView snap={s} viewport={viewport}
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
            {askable.length === 0 && <span className="ask-none">no one online</span>}
            {askable.map((a) => (
              <button key={`${a.boardId}-${a.id}`} className="agent-chip" onClick={() => setAskTo({ name: a.name, boardId: a.boardId })}>
                <i className="avatar mini" style={{ background: agentWash(a.name), color: agentInk(a.name) }}>{initials(a.name)}</i>
                {a.name}
                {snaps.length > 1 && <small className="chip-project">{a.project}</small>}
              </button>
            ))}
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
        agents={(snaps.find((s) => s.board.id === open.boardId)?.agents ?? []).filter((a) => a.status !== 'gone' && a.name !== 'strategist' && !a.name.startsWith('auditor-'))}
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
