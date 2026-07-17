import React, { useState } from 'react'
import { api, Agent, Card, Idea, Snapshot, Thread, agentInk, agentWash, initials, timeAgo } from './api'
import { CardDrawer } from './CardDrawer'
import { AgentTerminal } from './AgentTerminal'
import { NetworkView } from './NetworkView'

function ThreadView({ t, boardId, onChange }: { t: Thread; boardId: number; onChange: () => void }) {
  const [reply, setReply] = useState('')
  const [replying, setReplying] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const send = async () => {
    if (!reply.trim()) return
    await api('POST', '/messages', { board_id: boardId, to: t.from_name ?? undefined, body: reply.trim(), reply_to: t.id })
    setReply(''); setReplying(false); onChange()
  }
  const title = t.body.length > 64 ? t.body.slice(0, 64) + '…' : t.body
  return (
    <div className={`thread ${t.answered ? 'answered' : ''} ${expanded ? 'expanded' : ''}`}>
      <button className="thread-q" onClick={() => setExpanded(!expanded)}>
        <span className="thread-text">
          <b>{t.from_name ?? 'you'}</b> → <b>{t.to_name ?? 'everyone'}</b>: {expanded ? t.body : title}
        </span>
        <span className={`status-chip ${t.answered ? 'chip-answered' : 'chip-open'}`}>
          {t.answered ? 'Answered' : 'Open'}
        </span>
        <span className="thread-caret">{expanded ? '▾' : '▸'}</span>
        <span className="icon-x" role="button" title="Delete question"
          onClick={async (e) => { e.stopPropagation(); await api('DELETE', `/messages/${t.id}`); onChange() }}>×</span>
      </button>
      {expanded && <>
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
      </>}
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

function IdeaStrip({ snap, onChange }: { snap: Snapshot; onChange: () => void }) {
  const [text, setText] = useState('')
  const agents = snap.agents.filter((a) => a.status !== 'gone')
  const add = async () => {
    if (!text.trim()) return
    await api('POST', '/ideas', { board_id: snap.board.id, text: text.trim() })
    setText(''); onChange()
  }
  const promote = async (idea: Idea, agent: string) => {
    await api('POST', `/ideas/${idea.id}/promote`, agent ? { agent } : {})
    onChange()
  }
  return (
    <div className="ideas">
      <div className="ideas-row">
        <span className="ideas-label">Roadmap</span>
        <input value={text} placeholder="Brainstorm an idea… (Enter to save)"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') add() }} />
      </div>
      {(snap.ideas ?? []).length > 0 && (
        <div className="idea-chips">
          {(snap.ideas ?? []).map((i) => (
            <span key={i.id} className="idea">
              <span className="idea-text" title={i.text}>{i.text.split('\n')[0]}</span>
              <select defaultValue="" title="Turn into a ticket"
                onChange={(e) => { if (e.target.value !== '') promote(i, e.target.value === '·' ? '' : e.target.value) }}>
                <option value="" disabled>→ ticket</option>
                <option value="·">unassigned</option>
                {agents.map((a) => <option key={a.id} value={a.name}>assign {a.name}</option>)}
              </select>
              <button className="icon-x" title="Delete idea"
                onClick={async () => { await api('DELETE', `/ideas/${i.id}`); onChange() }}>×</button>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

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
  const [terminal, setTerminal] = useState<{ agent: Agent; boardId: number } | null>(null)
  const [askTo, setAskTo] = useState<{ name: string; boardId: number } | null>(null)
  const [askBody, setAskBody] = useState('')
  const [adding, setAdding] = useState<number | null>(null)
  const [newTitle, setNewTitle] = useState('')
  const [listView, setListView] = useState<Set<number>>(() => new Set())
  const isNet = (id: number) => !listView.has(id)
  const toggleNet = (id: number) => setListView((prev) => {
    const next = new Set(prev)
    next.has(id) ? next.delete(id) : next.add(id)
    return next
  })

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
                <button className="view-toggle"
                  title="Switch between the network map and the list"
                  onClick={() => toggleNet(s.board.id)}>
                  {isNet(s.board.id) ? 'List' : 'Network'}
                </button>
                <button className="hire-btn" title="Spawn an autonomous agent on this project"
                  onClick={async () => { await api('POST', `/boards/${s.board.id}/hire`, {}); onChange() }}>
                  + Hire
                </button>
                <div className="project-crew">
                  {agents.map((a) => (
                    <span key={a.id} className="crew-slot">
                      <span className={`avatar clickable ${a.status} ${a.kind === 'hired' ? 'hired' : ''}`}
                        title={`${a.name} · ${a.status} · open console`}
                        style={{ background: agentWash(a.name), color: agentInk(a.name) }}
                        onClick={() => setTerminal({ agent: a, boardId: s.board.id })}>
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

              {isNet(s.board.id) ? (
                <NetworkView snap={s}
                  onOpenCard={(c) => setOpen({ card: c, boardId: s.board.id })}
                  onOpenAgent={(a) => setTerminal({ agent: a, boardId: s.board.id })} />
              ) : (<>
              <IdeaStrip snap={s} onChange={onChange} />
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
                      style={{ ['--i' as any]: i, ['--st' as any]: st.ink }}
                      onClick={() => setOpen({ card: c, boardId: s.board.id })}>
                      <span className="status-chip" style={{ background: st.bg, color: st.ink }}>{st.label}</span>
                      <h4>{c.title}</h4>
                      <footer>
                        {c.owner
                          ? <span className="owner">
                              <i className="avatar mini" style={{ background: agentWash(c.owner), color: agentInk(c.owner) }}>{initials(c.owner)}</i>
                              {c.owner.split('-')[0]}
                            </span>
                          : <span className="owner unowned">—</span>}
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
              </>)}
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
        agents={(snaps.find((s) => s.board.id === open.boardId)?.agents ?? []).filter((a) => a.status !== 'gone')}
        onClose={() => setOpen(null)} onChange={onChange} />}
      {terminal && <AgentTerminal
        agent={snaps.find((s) => s.board.id === terminal.boardId)?.agents.find((a) => a.id === terminal.agent.id) ?? terminal.agent}
        boardId={terminal.boardId}
        threads={(snaps.find((s) => s.board.id === terminal.boardId)?.threads ?? []) as Thread[]}
        onClose={() => setTerminal(null)} onChange={onChange} />}
    </>
  )
}
