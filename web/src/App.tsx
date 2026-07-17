import React, { useCallback, useEffect, useState } from 'react'
import { api, Snapshot } from './api'
import { Board } from './Board'

export function App() {
  const [boards, setBoards] = useState<any[]>([])
  const [boardId, setBoardId] = useState<number | null>(null)
  const [snap, setSnap] = useState<Snapshot | null>(null)

  const refresh = useCallback(async (id: number) => setSnap(await api('GET', `/boards/${id}/snapshot`)), [])

  useEffect(() => {
    api('GET', '/boards').then((bs) => { setBoards(bs); if (bs[0]) setBoardId(bs[0].id) })
  }, [])

  useEffect(() => {
    if (boardId == null) return
    refresh(boardId)
    const es = new EventSource(`/api/v1/boards/${boardId}/events`)
    es.onmessage = () => refresh(boardId)
    return () => es.close()
  }, [boardId, refresh])

  return (
    <div className="app">
      <header>
        <h1>agentboard</h1>
        <select value={boardId ?? ''} onChange={(e) => setBoardId(Number(e.target.value))}>
          {boards.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
      </header>
      {snap && <Board snap={snap} onChange={() => refresh(snap.board.id)} />}
    </div>
  )
}
