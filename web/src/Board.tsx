import React, { useState } from 'react'
import { api, Card, Snapshot, agentInk, agentWash, initials, timeAgo } from './api'
import { CardDrawer } from './CardDrawer'

const COLUMNS = ['backlog', 'in_progress', 'blocked', 'review', 'done'] as const
const META: Record<string, { label: string; dot: string; hint: string }> = {
  backlog: { label: 'Backlog', dot: '#8d8a83', hint: 'Queue up work for your agents' },
  in_progress: { label: 'In progress', dot: '#956400', hint: 'Nothing being worked on yet' },
  blocked: { label: 'Blocked', dot: '#9f2f2d', hint: 'No blockers' },
  review: { label: 'Review', dot: '#1f6c9f', hint: 'Nothing waiting on review' },
  done: { label: 'Done', dot: '#346538', hint: 'Finished cards land here' },
}

export function Board({ snap, onChange }: { snap: Snapshot; onChange: () => void }) {
  const [open, setOpen] = useState<Card | null>(null)
  const [askTo, setAskTo] = useState<string | null>(null)
  const [askBody, setAskBody] = useState('')
  const [overCol, setOverCol] = useState<string | null>(null)
  const [adding, setAdding] = useState<string | null>(null)
  const [newTitle, setNewTitle] = useState('')

  const drop = async (col: string, e: React.DragEvent) => {
    e.preventDefault(); setOverCol(null)
    const id = e.dataTransfer.getData('text/card-id')
    if (id) { await api('POST', `/cards/${id}/move`, { column: col }); onChange() }
  }

  const ask = async () => {
    if (!askTo || !askBody.trim()) return
    await api('POST', '/messages', { board_id: snap.board.id, to: askTo, body: askBody.trim() })
    setAskBody(''); setAskTo(null); onChange()
  }

  const addCard = async (col: string) => {
    if (!newTitle.trim()) { setAdding(null); return }
    await api('POST', '/cards', { board_id: snap.board.id, title: newTitle.trim(), column: col })
    setNewTitle(''); setAdding(null); onChange()
  }

  const askable = snap.agents.filter((a) => a.status !== 'gone')

  return (
    <>
      {snap.open_questions.length > 0 && (
        <div className="questions-strip">
          {snap.open_questions.map((q) => (
            <span key={q.id} className="question-chip" title={q.body}>
              <b>{q.from_name ?? 'you'}</b>&nbsp;asked&nbsp;<b>{q.to_name ?? 'everyone'}</b>: {q.body}
            </span>
          ))}
        </div>
      )}

      <main className="board">
        {COLUMNS.map((col) => {
          const m = META[col]
          const cards = snap.cards.filter((c) => c.column === col)
          return (
            <section key={col} className={overCol === col ? 'col drop-target' : 'col'}
              onDragOver={(e) => { e.preventDefault(); setOverCol(col) }}
              onDragLeave={() => setOverCol(null)}
              onDrop={(e) => drop(col, e)}>
              <header className="col-head">
                <span className="col-dot" style={{ background: m.dot }} />
                <h3>{m.label}</h3>
                <span className="col-count">{cards.length}</span>
              </header>

              <div className="col-cards">
                {cards.map((c, i) => (
                  <article key={c.id} className="card" draggable
                    style={{ ['--i' as any]: i }}
                    onClick={() => setOpen(c)}
                    onDragStart={(e) => e.dataTransfer.setData('text/card-id', String(c.id))}>
                    <h4>{c.title}</h4>
                    {c.description && <p className="card-desc">{c.description}</p>}
                    {c.paths.length > 0 && (
                      <div className="tags">
                        {c.paths.slice(0, 3).map((p) => <code key={p}>{p}</code>)}
                        {c.paths.length > 3 && <code>+{c.paths.length - 3}</code>}
                      </div>
                    )}
                    <footer>
                      {c.owner
                        ? <span className="owner">
                            <i className="avatar mini" style={{ background: agentWash(c.owner), color: agentInk(c.owner) }}>{initials(c.owner)}</i>
                            {c.owner}
                          </span>
                        : <span className="owner unowned">unassigned</span>}
                      <time>{timeAgo(c.updated_at)}</time>
                    </footer>
                  </article>
                ))}
                {cards.length === 0 && <p className="col-empty">{m.hint}</p>}
              </div>

              {adding === col ? (
                <div className="add-form">
                  <input autoFocus value={newTitle} placeholder="Card title"
                    onChange={(e) => setNewTitle(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') addCard(col); if (e.key === 'Escape') setAdding(null) }} />
                  <button className="btn primary" onClick={() => addCard(col)}>Add</button>
                </div>
              ) : (
                <button className="add-card" onClick={() => { setAdding(col); setNewTitle('') }}>+ New card</button>
              )}
            </section>
          )
        })}
      </main>

      <div className="ask-dock">
        {askTo === null ? (
          <div className="ask-row">
            <span className="ask-label">Ask an agent</span>
            {askable.length === 0 && <span className="ask-none">no one online</span>}
            {askable.map((a) => (
              <button key={a.id} className="agent-chip" onClick={() => setAskTo(a.name)}>
                <i className="avatar mini" style={{ background: agentWash(a.name), color: agentInk(a.name) }}>{initials(a.name)}</i>
                {a.name}
              </button>
            ))}
          </div>
        ) : (
          <div className="ask-row open">
            <i className="avatar mini" style={{ background: agentWash(askTo), color: agentInk(askTo) }}>{initials(askTo)}</i>
            <input autoFocus value={askBody} placeholder={`Ask ${askTo} — delivered into their context`}
              onChange={(e) => setAskBody(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') ask(); if (e.key === 'Escape') setAskTo(null) }} />
            <button className="btn primary" onClick={ask}>Send</button>
            <button className="btn ghost" onClick={() => setAskTo(null)}>Cancel</button>
          </div>
        )}
      </div>

      {open && <CardDrawer card={snap.cards.find((c) => c.id === open.id) ?? open} boardId={snap.board.id}
        onClose={() => setOpen(null)} onChange={onChange} />}
    </>
  )
}
