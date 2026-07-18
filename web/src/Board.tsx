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
      <div className="thread-head">
        <button className="thread-q" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>
          <span className="thread-text">
            <b>{t.from_name ?? 'you'}</b> → <b>{t.to_name ?? 'everyone'}</b>: {expanded ? t.body : title}
          </span>
          <span className={`status-chip ${t.answered ? 'chip-answered' : 'chip-open'}`}>
            {t.answered ? 'Answered' : 'Open'}
          </span>
          <span className="thread-caret">{expanded ? '▾' : '▸'}</span>
        </button>
        <button className="icon-x" title="Delete question" aria-label="Delete question"
          onClick={async () => { if (!window.confirm('Delete this question?')) return; await api('DELETE', `/messages/${t.id}`); onChange() }}>×</button>
      </div>
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
  const toStrategist = async (idea: Idea) => {
    let agent: any = null
    try { agent = await api('POST', `/boards/${snap.board.id}/hire`, { name: `auditor-${idea.id}`, role: 'auditor', ephemeral: true }) } catch { return }
    await api('POST', `/agents/${agent.id}/task`, {
      text: `Ticket request: turn roadmap idea #${idea.id} into a proper ticket. Idea text: """${idea.text}""". Audit it against the repo, enrich it, create the ticket in your format with the right --paths, then remove the idea with orchestra idea-done ${idea.id} and report the ticket id.`,
    })
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
          {(snap.ideas ?? []).map((i) => {
            const auditing = snap.agents.some((a) => a.name === `auditor-${i.id}` && a.status !== 'gone')
            return (
            <span key={i.id} className={auditing ? 'idea auditing' : 'idea'}>
              <span className="idea-text" title={i.text}>{i.text.split('\n')[0]}</span>
              {auditing
                ? <span className="rm-idea-auditing"><span className="rm-idea-star">✳</span> auditing…</span>
                : <button className="thread-reply" title="An auditor audits it and writes the full ticket"
                onClick={() => toStrategist(i)}>✳ ticket</button>}
              <button className="icon-x" title="Delete idea"
                onClick={async () => { await api('DELETE', `/ideas/${i.id}`); onChange() }}>×</button>
            </span>
            )
          })}
        </div>
      )}
    </div>
  )
}

function RailCard({ c, isLocked, onOpen }: { c: Card; isLocked: boolean; onOpen: (c: Card) => void }) {
  const st = STATUS[c.column] ?? STATUS.backlog
  return (
    <article className={`t-card ${isLocked ? 'locked' : ''}`}
      draggable={!isLocked}
      role="button" tabIndex={0}
      onClick={() => onOpen(c)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(c) } }}
      onDragStart={(e) => e.dataTransfer.setData('text/ticket-id', String(c.id))}
      style={{ ['--st' as any]: st.ink }}
      title={isLocked ? 'Locked — complete the previous milestone step first' : 'Drag onto an agent to assign'}>
      <div className="t-top">
        <span className="status-chip" style={{ background: st.bg, color: st.ink }}>{isLocked ? '🔒 ' : ''}{st.label}</span>
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

function TicketRail({ snap, onOpen }: { snap: Snapshot; onOpen: (c: Card) => void }) {
  const [collapsed, setCollapsed] = useState<Set<number>>(() => new Set())
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
  if (loose.length === 0 && milestones.length === 0) return (
    <aside className="ticket-rail"><p className="rail-empty">No open tickets — add some on the Roadmap.</p></aside>
  )
  return (
    <aside className="ticket-rail">
      {milestones.map(({ m, steps, open: openSteps, done }) => (
        <div key={m.id} className="rail-mile">
          <button className="rail-mile-head" onClick={() => toggle(m.id)}>
            <span className="rail-mile-flag">{done === steps.length ? '🏆' : '⛳'}</span>
            <span className="rail-mile-title">{m.title}</span>
            <span className="rm-count">{done}/{steps.length}</span>
            <span className="thread-caret">{collapsed.has(m.id) ? '▸' : '▾'}</span>
          </button>
          {!collapsed.has(m.id) && (
            <div className="rail-mile-steps">
              {openSteps.map((c) => <RailCard key={c.id} c={c} isLocked={locked(c)} onOpen={onOpen} />)}
              {openSteps.length === 0 && <p className="rail-empty">All steps complete 🏆</p>}
            </div>
          )}
        </div>
      ))}
      {loose.length > 0 && <p className="rail-head">Tickets <span className="rm-count">{loose.length}</span></p>}
      {loose.map((c) => <RailCard key={c.id} c={c} isLocked={false} onOpen={onOpen} />)}
    </aside>
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
                        role="button" tabIndex={0} aria-label={`Open ${a.name}'s console`}
                        style={{ background: agentWash(a.name), color: agentInk(a.name) }}
                        onClick={() => setTerminal({ agent: a, boardId: s.board.id })}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setTerminal({ agent: a, boardId: s.board.id }) } }}>
                        {initials(a.name)}
                        <i className="presence" />
                      </span>
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
              </header>

              {isNet(s.board.id) ? (
                <div className="net-wrap">
                  <TicketRail snap={s} onOpen={(c) => setOpen({ card: c, boardId: s.board.id })} />
                  <NetworkView snap={s}
                    onOpenCard={(c) => setOpen({ card: c, boardId: s.board.id })}
                    onOpenAgent={(a) => setTerminal({ agent: a, boardId: s.board.id })}
                    onChange={onChange} />
                </div>
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
                      role="button" tabIndex={0}
                      onClick={() => setOpen({ card: c, boardId: s.board.id })}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen({ card: c, boardId: s.board.id }) } }}>
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
        agents={(snaps.find((s) => s.board.id === open.boardId)?.agents ?? []).filter((a) => a.status !== 'gone' && a.name !== 'strategist' && !a.name.startsWith('auditor-'))}
        onClose={() => setOpen(null)} onChange={onChange} />}
      {terminal && <AgentTerminal
        agent={snaps.find((s) => s.board.id === terminal.boardId)?.agents.find((a) => a.id === terminal.agent.id) ?? terminal.agent}
        boardId={terminal.boardId}
        threads={(snaps.find((s) => s.board.id === terminal.boardId)?.threads ?? []) as Thread[]}
        cards={snaps.find((s) => s.board.id === terminal.boardId)?.cards ?? []}
        onClose={() => setTerminal(null)} onChange={onChange} />}
    </>
  )
}
