import React, { useEffect, useState } from 'react'
import { api, Card, ShipCommit, ShipLog, Snapshot, agentInk, agentWash, initials } from './api'
import { CardDrawer } from './CardDrawer'

// Shipped tab: the project's commit history, each entry explained by the
// card/agent that produced it — matched commits carry the story, unmatched
// commits are listed plainly and muted.

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

function ShipEntry({ commit, cards, onOpenCard }:
  { commit: ShipCommit; cards: Card[]; onOpenCard: (c: Card) => void }) {
  const [open, setOpen] = useState(false)
  const matched = commit.cards.length > 0
  return (
    <div className={matched ? 'shiplog-entry' : 'shiplog-entry unmatched'}>
      <button className="shiplog-row" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="shiplog-caret">{open ? '▾' : '▸'}</span>
        <code className="shiplog-hash">{commit.short}</code>
        <span className="shiplog-subject">{commit.subject}</span>
        {commit.cards.map((c) => (
          <span key={c.id} className="shiplog-card-chip" title={c.summary ?? c.title}>
            {c.agent && <i className="avatar mini" style={{ background: agentWash(c.agent), color: agentInk(c.agent) }}>{initials(c.agent)}</i>}
            #{c.id}
          </span>
        ))}
        <span className="shiplog-stat">+{commit.insertions} −{commit.deletions}</span>
        <time className="shiplog-date">{fmtDate(commit.date)}</time>
      </button>
      {open && (
        <div className="shiplog-detail">
          {commit.cards.map((c) => {
            const live = cards.find((x) => x.id === c.id)
            return (
              <div key={c.id} className="shiplog-card">
                <div className="shiplog-card-head">
                  {live
                    ? <button className="shiplog-card-link" onClick={() => onOpenCard(live)}>#{c.id} {c.title}</button>
                    : <span className="shiplog-card-title">#{c.id} {c.title}</span>}
                  {c.agent && <span className="owner"><i className="avatar mini" style={{ background: agentWash(c.agent), color: agentInk(c.agent) }}>{initials(c.agent)}</i>{c.agent}</span>}
                  {c.decision && <span className={`shiplog-decision ${c.decision}`}>{c.decision === 'approve' ? '✓ approved' : '↩ sent back'}</span>}
                  {c.matched_by === 'shipped' && <span className="shiplog-verified" title="recorded at merge time via orchestra shipped">⚓ recorded</span>}
                </div>
                {c.summary && <p className="shiplog-summary">{c.summary}</p>}
              </div>
            )
          })}
          {commit.body && <pre className="shiplog-body">{commit.body}</pre>}
          {commit.files.length > 0 && (
            <ul className="shiplog-files">
              {commit.files.map((f) => (
                <li key={f.path}><code>{f.path}</code> <span className="shiplog-stat">+{f.insertions} −{f.deletions}</span></li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

function ProjectShiplog({ snap, onChange }: { snap: Snapshot; onChange: () => void }) {
  const [log, setLog] = useState<ShipLog | null>(null)
  const [commits, setCommits] = useState<ShipCommit[]>([])
  const [loading, setLoading] = useState(false)
  const [openCard, setOpenCard] = useState<Card | null>(null)

  const load = async (offset: number) => {
    setLoading(true)
    try {
      const page: ShipLog = await api('GET', `/boards/${snap.board.id}/shipped?offset=${offset}&limit=50`)
      setLog(page)
      setCommits((prev) => offset === 0 ? page.commits : [...prev, ...page.commits])
    } catch { /* daemon without the route — leave empty */ }
    finally { setLoading(false) }
  }

  // initial load + a slow poll; the daemon caches per HEAD so polling is cheap
  useEffect(() => {
    load(0)
    const t = setInterval(() => load(0), 60_000)
    return () => clearInterval(t)
  }, [snap.board.id])

  return (
    <section className="shiplog-project">
      <h2>{snap.board.name}</h2>
      {log?.error && <p className="col-empty">{log.error}</p>}
      {!log && !loading && <p className="col-empty">Loading history…</p>}
      <div className="shiplog-list">
        {commits.map((c) => (
          <ShipEntry key={c.hash} commit={c} cards={snap.cards} onOpenCard={setOpenCard} />
        ))}
      </div>
      {log && !log.error && commits.length === 0 && <p className="col-empty">No commits yet.</p>}
      {log?.has_more && (
        <button className="btn ghost shiplog-more" disabled={loading}
          onClick={() => load(commits.length)}>
          {loading ? 'Loading…' : 'Load older commits'}
        </button>
      )}
      {openCard && <CardDrawer card={snap.cards.find((c) => c.id === openCard.id) ?? openCard}
        boardId={snap.board.id}
        agents={snap.agents.filter((a) => a.status !== 'gone' && a.name !== 'strategist' && !a.name.startsWith('auditor-'))}
        onClose={() => setOpenCard(null)} onChange={onChange} />}
    </section>
  )
}

export function ShippedView({ snaps, focused = false, onChange }:
  { snaps: Snapshot[]; focused?: boolean; onChange: () => void }) {
  return (
    <main className={focused ? 'shiplog focused' : 'shiplog'}>
      {snaps.map((s) => <ProjectShiplog key={s.board.id} snap={s} onChange={onChange} />)}
    </main>
  )
}
