import React, { useState } from 'react'
import { api, Card, Snapshot } from './api'
import { CardDrawer } from './CardDrawer'

const COLUMNS = ['backlog', 'in_progress', 'blocked', 'review', 'done']
const LABEL: Record<string, string> = { backlog: 'Backlog', in_progress: 'In Progress', blocked: 'Blocked', review: 'Review', done: 'Done' }

export function Board({ snap, onChange }: { snap: Snapshot; onChange: () => void }) {
  const [open, setOpen] = useState<Card | null>(null)
  const [askTo, setAskTo] = useState(''); const [askBody, setAskBody] = useState('')

  const drop = async (col: string, e: React.DragEvent) => {
    e.preventDefault()
    const id = e.dataTransfer.getData('text/card-id')
    if (id) { await api('POST', `/cards/${id}/move`, { column: col }); onChange() }
  }
  const ask = async () => {
    if (!askTo || !askBody) return
    await api('POST', '/messages', { board_id: snap.board.id, to: askTo, body: askBody })
    setAskBody(''); onChange()
  }

  return (
    <div className="layout">
      <aside>
        <h2>Agents</h2>
        {snap.agents.map((a) => (
          <div key={a.id} className={`agent ${a.status}`}>
            <span className="dot" /> {a.name} <small>{a.status}</small>
          </div>
        ))}
        <h2>Ask an agent</h2>
        <select value={askTo} onChange={(e) => setAskTo(e.target.value)}>
          <option value="">choose…</option>
          {snap.agents.filter((a) => a.status !== 'gone').map((a) => <option key={a.id}>{a.name}</option>)}
        </select>
        <textarea value={askBody} onChange={(e) => setAskBody(e.target.value)} placeholder="question…" />
        <button onClick={ask}>Send</button>
        {snap.open_questions.length > 0 && <>
          <h2>Open questions</h2>
          {snap.open_questions.map((q) => (
            <div key={q.id} className="question">
              <b>{q.from_name ?? 'you'} → {q.to_name ?? 'all'}:</b> {q.body}
            </div>))}
        </>}
      </aside>
      <main>
        {COLUMNS.map((col) => (
          <section key={col} onDragOver={(e) => e.preventDefault()} onDrop={(e) => drop(col, e)}>
            <h3>{LABEL[col]} <small>{snap.cards.filter((c) => c.column === col).length}</small></h3>
            {snap.cards.filter((c) => c.column === col).map((c) => (
              <article key={c.id} draggable onClick={() => setOpen(c)}
                onDragStart={(e) => e.dataTransfer.setData('text/card-id', String(c.id))}>
                <b>{c.title}</b>
                <small>{c.owner ?? 'unowned'}</small>
                {c.paths.length > 0 && <code>{c.paths.join(' ')}</code>}
              </article>
            ))}
          </section>
        ))}
      </main>
      {open && <CardDrawer card={open} boardId={snap.board.id} agents={snap.agents}
        onClose={() => setOpen(null)} onChange={onChange} />}
    </div>
  )
}
