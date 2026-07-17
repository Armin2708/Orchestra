import React, { useCallback, useEffect, useState } from 'react'
import { api, Snapshot } from './api'
import { ProjectGrid } from './Board'

export const Mark = () => (
  <svg className="mark" viewBox="0 0 32 32" aria-hidden="true">
    <rect width="32" height="32" rx="8" fill="#111"/>
    <rect x="7" y="9" width="5" height="14" rx="1.5" fill="#F7F6F3"/>
    <rect x="14" y="9" width="5" height="9" rx="1.5" fill="#F7F6F3"/>
    <rect x="21" y="9" width="5" height="11" rx="1.5" fill="#F7F6F3"/>
  </svg>
)

export function App() {
  const [snaps, setSnaps] = useState<Snapshot[]>([])
  const [loaded, setLoaded] = useState(false)
  const [focus, setFocus] = useState<number | 'all'>(() => {
    const saved = localStorage.getItem('orchestra-focus')
    return saved && saved !== 'all' ? Number(saved) : 'all'
  })
  const [menuOpen, setMenuOpen] = useState(false)
  const pick = (f: number | 'all') => { setFocus(f); setMenuOpen(false); localStorage.setItem('orchestra-focus', String(f)) }

  // default to the first project (network view) rather than the all-projects grid
  useEffect(() => {
    if (focus === 'all' && !localStorage.getItem('orchestra-focus') && snaps[0]) pick(snaps[0].board.id)
  }, [snaps.length])

  const refresh = useCallback(async () => {
    const boards = await api('GET', '/boards')
    const all = await Promise.all(boards.map((b: any) => api('GET', `/boards/${b.id}/snapshot`)))
    setSnaps(all)
    setLoaded(true)
    return boards
  }, [])

  useEffect(() => {
    let sources: EventSource[] = []
    refresh().then((boards) => {
      sources = boards.map((b: any) => {
        const es = new EventSource(`/api/v1/boards/${b.id}/events`)
        es.onmessage = () => refresh()
        return es
      })
    }).catch(() => setLoaded(true))
    const poll = setInterval(refresh, 30_000) // pick up newly created boards
    return () => { sources.forEach((s) => s.close()); clearInterval(poll) }
  }, [refresh])

  if (loaded && snaps.length === 0) return <GettingStarted />

  const agents = snaps.flatMap((s) => s.agents.filter((a) => a.status !== 'gone'))
  const cards = snaps.flatMap((s) => s.cards)
  const visible = focus === 'all' ? snaps : snaps.filter((s) => s.board.id === focus)
  const shown = visible.length > 0 ? visible : snaps // focused board was removed — fall back

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <Mark />
          <div className="brand-picker">
            <button className="brand-btn" onClick={() => setMenuOpen((o) => !o)}>
              <h1>{focus === 'all' ? 'All projects' : shown[0]?.board.name ?? 'Orchestra'}</h1>
              <span className="brand-caret">▾</span>
            </button>
            <p className="sub">
              {snaps.length} project{snaps.length === 1 ? '' : 's'} · {agents.length} agent{agents.length === 1 ? '' : 's'} active · {cards.length} card{cards.length === 1 ? '' : 's'}
            </p>
            {menuOpen && (
              <div className="brand-menu">
                <button className={focus === 'all' ? 'brand-item active' : 'brand-item'} onClick={() => pick('all')}>All projects</button>
                {snaps.map((s) => (
                  <button key={s.board.id} className={focus === s.board.id ? 'brand-item active' : 'brand-item'}
                    onClick={() => pick(s.board.id)}>
                    {s.board.name}
                    <span className="brand-count">{s.agents.filter((a) => a.status !== 'gone').length}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </header>
      <ProjectGrid snaps={shown} focused={focus !== 'all' && visible.length === 1} onChange={refresh} />
    </div>
  )
}

function GettingStarted() {
  return (
    <div className="empty-hero">
      <div className="empty-card">
        <Mark />
        <h1>No projects yet</h1>
        <p>A project appears the moment an agent joins it. Open a Claude Code session in any repo and it joins on its own:</p>
        <pre>cd your-project{'\n'}claude</pre>
        <p className="hint">This page updates live — leave it open.</p>
      </div>
    </div>
  )
}
