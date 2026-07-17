import React, { useState } from 'react'
import { api, Agent, Card, Snapshot, Thread, agentInk, agentWash, initials, timeAgo } from './api'
import { CardDrawer } from './CardDrawer'
import { AgentTerminal } from './AgentTerminal'

function ThreadView({ t, boardId, onChange }: { t: Thread; boardId: number; onChange: () => void }) {
  const [reply, setReply] = useState('')
  const [replying, setReplying] = useState(false)
  const send = async () => {
    if (!reply.trim()) return
    await api('POST', '/messages', { board_id: boardId, to: t.from_name ?? undefined, body: reply.trim(), reply_to: t.id })
    setReply(''); setReplying(false); onChange()
  }
  return (
    <div className={`thread ${t.answered ? 'answered' : ''}`}>
      <div className="thread-q">
        <span className="thread-text">
          <b>{t.from_name ?? 'you'}</b> → <b>{t.to_name ?? 'everyone'}</b>: {t.body}
        </span>
        <span className={`status-chip ${t.answered ? 'chip-answered' : 'chip-open'}`}>
          {t.answered ? 'Answered' : 'Open'}
        </span>
        <button className="icon-x" title="Delete question"
          onClick={async () => { await api('DELETE', `/messages/${t.id}`); onChange() }}>×</button>
      </div>
      {t.replies.map((r) => (
        <p key={r.id} className="thread-a"><b>{r.from_name ?? 'you'}</b>: {r.body}</p>
      ))}
      {!t.answered && (replying ? (
        <div className="add-form">
          <input autoFocus value={reply} placeholder="Answer this question"
            onChange={(e) => setReply(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') send(); if (e.key === 'Escape') setReplying(false) }} />
          <button className="btn primary" onClick={send}>Reply</button>
        </div>
      ) : (
        <button className="thread-reply" onClick={() => setReplying(true)}>Reply</button>
      ))}
    </div>
  )
}

export const STATUS: Record<string, { label: string; bg: string; ink: string }> = {
  backlog: { label: 'Queued', bg: '#F1F0EC', ink: '#787774' },
  in_progress: { label: 'Working', bg: '#FBF3DB', ink: '#956400' },
  blocked: { label: 'Blocked', bg: '#FDEBEC', ink: '#9F2F2D' },
  review: { label: 'Review', bg: '#E1F3FE', ink: '#1F6C9F' },
  done: { label: 'Done', bg: '#EDF3EC', ink: '#346538' },
}
const ORDER = ['in_progress', 'blocked', 'review', 'backlog', 'done']

function RemoveProject({ boardId, onChange }: { boardId: number; onChange: () => void }) {
  const [arming, setArming] = useState(false)
  if (!arming) return <button className="icon-x quiet" title="Remove project from board" onClick={() => setArming(true)}>×</button>
  return (
    <span className="confirm-remove">
      <button className="btn danger" onClick={async () => { await api('DELETE', `/boards/${boardId}`); onChange() }}>Remove?</button>
      <button className="btn ghost" onClick={() => setArming(false)}>Keep</button>
    </span>
  )
}

export function ProjectGrid({ snaps, focused = false, onChange }: { snaps: Snapshot[]; focused?: boolean; onChange: () => void }) {
  const [open, setOpen] = useState<{ card: Card; boardId: number } | null>(null)
  const [terminal, setTerminal] = useState<Agent | null>(null)
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
      <main className={focused ? 'projects focused' : 'projects'}>
        {snaps.map((s) => {
          const agents = s.agents.filter((a) => a.status !== 'gone')
          const cards = [...s.cards].sort((a, b) => ORDER.indexOf(a.column) - ORDER.indexOf(b.column))
          const threads = [...s.threads].sort((a, b) => Number(a.answered) - Number(b.answered)).slice(0, 6)
          return (
            <section key={s.board.id} className="project">
              <header className="project-head">
                <h2>{s.board.name}</h2>
                <RemoveProject boardId={s.board.id} onChange={onChange} />
                <button className="hire-btn" title="Spawn an autonomous agent on this project"
                  onClick={async () => { await api('POST', `/boards/${s.board.id}/hire`, {}); onChange() }}>
                  + Hire
                </button>
                <div className="project-crew">
                  {agents.map((a) => (
                    <span key={a.id} className="crew-slot">
                      <span className={`avatar ${a.status} ${a.kind === 'hired' ? 'hired clickable' : ''}`}
                        title={a.kind === 'hired' ? `${a.name} · ${a.status} · open console` : `${a.name} · ${a.status}`}
                        style={{ background: agentWash(a.name), color: agentInk(a.name) }}
                        onClick={a.kind === 'hired' ? () => setTerminal(a) : undefined}>
                        {initials(a.name)}
                        <i className="presence" />
                      </span>
                      {a.kind === 'hired' && (
                        <button className="icon-x fire" title={`Fire ${a.name}`}
                          onClick={async () => { await api('POST', `/agents/${a.id}/fire`); onChange() }}>×</button>
                      )}
                    </span>
                  ))}
                  {agents.length === 0 && <span className="ask-none">no agents online</span>}
                </div>
              </header>

              {threads.length > 0 && (
                <div className="threads">
                  {threads.map((t) => <ThreadView key={t.id} t={t} boardId={s.board.id} onChange={onChange} />)}
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
      {terminal && <AgentTerminal agent={terminal} onClose={() => setTerminal(null)} onChange={onChange} />}
    </>
  )
}
