import React, { useCallback, useEffect, useState } from 'react'
import { api, Snapshot, agentInk, agentWash, initials } from './api'
import { Board } from './Board'

const Mark = () => (
  <svg className="mark" viewBox="0 0 32 32" aria-hidden="true">
    <rect width="32" height="32" rx="8" fill="#111"/>
    <rect x="7" y="9" width="5" height="14" rx="1.5" fill="#F7F6F3"/>
    <rect x="14" y="9" width="5" height="9" rx="1.5" fill="#F7F6F3"/>
    <rect x="21" y="9" width="5" height="11" rx="1.5" fill="#F7F6F3"/>
  </svg>
)

export function App() {
  const [boards, setBoards] = useState<any[]>([])
  const [boardId, setBoardId] = useState<number | null>(null)
  const [snap, setSnap] = useState<Snapshot | null>(null)
  const [loaded, setLoaded] = useState(false)

  const refresh = useCallback(async (id: number) => setSnap(await api('GET', `/boards/${id}/snapshot`)), [])

  useEffect(() => {
    api('GET', '/boards').then((bs) => {
      setBoards(bs)
      if (bs[0]) setBoardId(bs[0].id)
      setLoaded(true)
    }).catch(() => setLoaded(true))
  }, [])

  useEffect(() => {
    if (boardId == null) return
    refresh(boardId)
    const es = new EventSource(`/api/v1/boards/${boardId}/events`)
    es.onmessage = () => refresh(boardId)
    return () => es.close()
  }, [boardId, refresh])

  if (loaded && boards.length === 0) return <GettingStarted />

  const done = snap ? snap.cards.filter((c) => c.column === 'done').length : 0
  const total = snap ? snap.cards.length : 0
  const activeAgents = snap ? snap.agents.filter((a) => a.status !== 'gone') : []

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <Mark />
          <div>
            <h1>{snap?.board.name ?? 'agentboard'}</h1>
            <p className="sub">
              {total} card{total === 1 ? '' : 's'} · {activeAgents.length} agent{activeAgents.length === 1 ? '' : 's'} active
            </p>
          </div>
        </div>
        <div className="progress" title={`${done} of ${total} done`}>
          <div className="progress-track">
            <div className="progress-fill" style={{ width: total ? `${(done / total) * 100}%` : '0%' }} />
          </div>
          <span className="progress-label">{total ? Math.round((done / total) * 100) : 0}%</span>
        </div>
        <div className="crew">
          {activeAgents.map((a) => (
            <span key={a.id} className={`avatar ${a.status}`} title={`${a.name} · ${a.status}`}
              style={{ background: agentWash(a.name), color: agentInk(a.name) }}>
              {initials(a.name)}
              <i className="presence" />
            </span>
          ))}
        </div>
        {boards.length > 1 && (
          <select className="board-picker" value={boardId ?? ''} onChange={(e) => setBoardId(Number(e.target.value))}>
            {boards.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        )}
      </header>
      {snap && <Board snap={snap} onChange={() => refresh(snap.board.id)} />}
    </div>
  )
}

function GettingStarted() {
  return (
    <div className="empty-hero">
      <div className="empty-card">
        <Mark />
        <h1>No boards yet</h1>
        <p>A board appears the moment an agent joins a project. Open a Claude Code session in any repo, or run:</p>
        <pre>cd your-project{'\n'}agentboard join</pre>
        <p className="hint">This page updates live — leave it open.</p>
      </div>
    </div>
  )
}
