import React, { useState } from 'react'
import { api, Card, Snapshot, agentInk, agentWash, initials, timeAgo } from './api'
import { CardDrawer } from './CardDrawer'

export const STATUS: Record<string, { label: string; bg: string; ink: string }> = {
  backlog: { label: 'Queued', bg: '#F1F0EC', ink: '#787774' },
  in_progress: { label: 'Working', bg: '#FBF3DB', ink: '#956400' },
  blocked: { label: 'Blocked', bg: '#FDEBEC', ink: '#9F2F2D' },
  review: { label: 'Review', bg: '#E1F3FE', ink: '#1F6C9F' },
  done: { label: 'Done', bg: '#EDF3EC', ink: '#346538' },
}
const ORDER = ['in_progress', 'blocked', 'review', 'backlog', 'done']

export function ProjectGrid({ snaps, onChange }: { snaps: Snapshot[]; onChange: () => void }) {
  const [open, setOpen] = useState<{ card: Card; boardId: number } | null>(null)
  const [askTo, setAskTo] = useState<{ name: string; boardId: number } | null>(null)
  const [askBody, setAskBody] = useState('')
  const [adding, setAdding] = useState<number | null>(null)
  const [newTitle, setNewTitle] = useState('')

  const ask = async () => {
    if (!askTo || !askBody.trim()) return
    await api('POST', '/messages', { board_id: askTo.boardId, to: askTo.name, body: askBody.trim() })
    setAskBody(''); setAskTo(null); onChange()
  }

  const addCard = async (boardId: number) => {
    if (!newTitle.trim()) { setAdding(null); return }
    await api('POST', '/cards', { board_id: boardId, title: newTitle.trim(), column: 'backlog' })
    setNewTitle(''); setAdding(null); onChange()
  }

  const askable = snaps.flatMap((s) =>
    s.agents.filter((a) => a.status !== 'gone').map((a) => ({ ...a, boardId: s.board.id, project: s.board.name })))

  const openCard = open
    ? snaps.find((s) => s.board.id === open.boardId)?.cards.find((c) => c.id === open.card.id) ?? open.card
    : null

  return (
    <>
      <main className="projects">
        {snaps.map((s) => {
          const agents = s.agents.filter((a) => a.status !== 'gone')
          const cards = [...s.cards].sort((a, b) => ORDER.indexOf(a.column) - ORDER.indexOf(b.column))
          const openQs = s.open_questions
          return (
            <section key={s.board.id} className="project">
              <header className="project-head">
                <h2>{s.board.name}</h2>
                <div className="project-crew">
                  {agents.map((a) => (
                    <span key={a.id} className={`avatar ${a.status}`} title={`${a.name} · ${a.status}`}
                      style={{ background: agentWash(a.name), color: agentInk(a.name) }}>
                      {initials(a.name)}
                      <i className="presence" />
                    </span>
                  ))}
                  {agents.length === 0 && <span className="ask-none">no agents online</span>}
                </div>
              </header>

              {openQs.length > 0 && (
                <div className="project-questions">
                  {openQs.map((q: any) => (
                    <p key={q.id} className="question-line" title={q.body}>
                      <b>{q.from_name ?? 'you'}</b> asked <b>{q.to_name ?? 'everyone'}</b>: {q.body}
                    </p>
                  ))}
                </div>
              )}

              <div className="project-cards">
                {cards.map((c, i) => {
                  const st = STATUS[c.column] ?? STATUS.backlog
                  return (
                    <article key={c.id} className={`card ${c.column === 'done' ? 'is-done' : ''}`}
                      style={{ ['--i' as any]: i }}
                      onClick={() => setOpen({ card: c, boardId: s.board.id })}>
                      <div className="card-top">
                        <h4>{c.title}</h4>
                        <span className="status-chip" style={{ background: st.bg, color: st.ink }}>{st.label}</span>
                      </div>
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
                  )
                })}
                {cards.length === 0 && <p className="col-empty">No work posted yet</p>}
              </div>

              {adding === s.board.id ? (
                <div className="add-form">
                  <input autoFocus value={newTitle} placeholder="What needs doing?"
                    onChange={(e) => setNewTitle(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') addCard(s.board.id); if (e.key === 'Escape') setAdding(null) }} />
                  <button className="btn primary" onClick={() => addCard(s.board.id)}>Add</button>
                </div>
              ) : (
                <button className="add-card" onClick={() => { setAdding(s.board.id); setNewTitle('') }}>+ New card</button>
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
        onClose={() => setOpen(null)} onChange={onChange} />}
    </>
  )
}
