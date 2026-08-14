import React, { useState } from 'react'
import { api, Agent, Card, Idea, Snapshot, Thread, timeAgo } from './api'
import { AgentTerminal } from './AgentTerminal'
import { BoardCanvas } from './Board'
import { CardDrawer } from './CardDrawer'
import { RoadmapBoard } from './RoadmapCanvas'
import './roadmap.css'

// The roadmap: milestones as stations on one left-to-right line, drawn on the same canvas
// as the Overview board. The strategist dock on the right is where a plan gets written;
// the canvas on the left is where it gets ordered.

function IdeaModal({ idea, boardId, auditor, onWatch, onClose, onChange }:
  { idea: Idea; boardId: number; auditor?: Agent; onWatch?: (a: Agent) => void; onClose: () => void; onChange: () => void }) {
  const [title, ...rest] = idea.text.split('\n')
  const body = rest.join('\n').trim()
  const [sending, setSending] = useState(false)
  const sendToStrategist = async () => {
    if (sending) return
    setSending(true)
    try {
      // each idea gets its own one-shot auditor so several audits run in parallel
      const agent = await api('POST', `/boards/${boardId}/hire`, { name: `auditor-${idea.id}`, role: 'auditor', ephemeral: true })
      await api('POST', `/agents/${agent.id}/task`, {
        text: `Ticket request: turn roadmap idea #${idea.id} into a proper ticket. Idea text: <<<${idea.text}>>>. Audit it against the repo, enrich it, create the ticket in your format with the right --paths, then remove the idea with orchestra idea-done ${idea.id} and report the ticket id. This is your only task.`,
      })
      onClose(); onChange()
    } finally { setSending(false) }
  }
  return (
    <>
      <div className="idea-scrim" onClick={onClose} />
      <div className="idea-modal" role="dialog">
        <span className="idea-modal-kicker">✳ roadmap idea · {timeAgo(idea.created_at)}</span>
        <h3>{title}</h3>
        {body ? <p className="idea-modal-body">{body}</p> : <p className="idea-modal-body empty">No details yet — send it to the strategist to audit and spec it.</p>}
        <div className="idea-modal-actions">
          {auditor ? (
            <>
              <button className="btn primary" onClick={() => { onWatch?.(auditor); onClose() }}>
                <span className="rm-idea-star">✳</span> Auditor at work — watch
              </button>
              <span className="idea-modal-hint">it's validating this idea against the repo right now</span>
            </>
          ) : (<>
          <button className="btn primary" disabled={sending} onClick={sendToStrategist}>
            {sending ? '✳ Spawning auditor…' : '✳ Audit → ticket'}
          </button>
          <span className="idea-modal-hint">spawns a dedicated auditor — audit several ideas in parallel</span>
          </>)}
          <span className="idea-modal-spacer" />
          <button className="btn ghost danger-text" onClick={async () => {
            await api('DELETE', `/ideas/${idea.id}`); onClose(); onChange()
          }}>Delete</button>
        </div>
      </div>
    </>
  )
}

const MODES: { key: string; label: string; prompt: string }[] = [
  { key: 'milestone', label: '⛳ Milestone', prompt: 'MODE: Milestone planning. Interview me briefly about the goal, propose an ordered step plan, and once I agree create it with orchestra milestone + orchestra step (each step in your ticket prompt format).' },
  { key: 'feature', label: '✦ Feature', prompt: 'MODE: Feature brainstorm. Explore the feature with me, research the repo for grounding, record promising directions with orchestra idea, and turn well-defined ones into tickets in your prompt format.' },
  { key: 'tickets', label: '▤ Tickets', prompt: 'MODE: Ticket writing. Turn what we discuss into tickets using your OBJECTIVE/CONTEXT/REQUIREMENTS/DONE WHEN format with researched paths.' },
  { key: 'debug', label: '⚑ Debug', prompt: 'MODE: Debug. Ask me for the symptoms, investigate the repo read-only, and produce a diagnosis ticket: findings in CONTEXT, fix plan in REQUIREMENTS, verification in DONE WHEN.' },
  { key: 'refine', label: '✎ Refine', prompt: 'MODE: Refine. Ask me which ticket to refine (id or title), read the board, then rewrite it with orchestra card update in your prompt format and summarize the changes.' },
]

function BrainstormDock({ snap, onChange, onCollapse }: {
  snap: Snapshot; onChange: () => void; onCollapse: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [idea, setIdea] = useState('')
  const strategist = snap.agents.find((a) => a.name === 'strategist' && a.status !== 'gone')

  const startMode = async (prompt: string) => {
    if (busy) return
    setBusy(true)
    try {
      const agent = strategist
        ?? await api('POST', `/boards/${snap.board.id}/hire`, { name: 'strategist', role: 'strategist' })
      await api('POST', `/agents/${agent.id}/task`, { text: prompt })
    } finally { setBusy(false); onChange() }
  }
  const jot = async () => {
    if (!idea.trim()) return
    await api('POST', '/ideas', { board_id: snap.board.id, text: idea.trim() })
    setIdea(''); onChange()
  }

  return (
    <aside className="rmap-dock">
      <header className="rmap-dock-head">
        <span className="rmap-dock-title">✻ Plan with the strategist</span>
        <button className="rmap-icon" title="Hide the strategist" onClick={onCollapse}>›</button>
      </header>
      <div className="rmap-modes">
        {MODES.map((m) => (
          <button key={m.key} className="mode-chip" disabled={busy} onClick={() => startMode(m.prompt)}>{m.label}</button>
        ))}
      </div>
      <div className="rmap-jot">
        <textarea value={idea} rows={2} aria-label="Jot an idea"
          placeholder={'Jot an idea — first line is the title, the rest its scope.\nEnter to save.'}
          onChange={(e) => setIdea(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); jot() } }} />
      </div>
      {strategist ? (
        <AgentTerminal embedded agent={strategist} boardId={snap.board.id}
          threads={snap.threads as Thread[]} cards={snap.cards}
          onClose={() => {}} onChange={onChange} />
      ) : (
        <div className="rmap-dock-empty">
          <p><span className="rm-spark">✻</span> Pick a mode to wake the strategist.</p>
          <p className="rmap-dock-sub">It researches this repo, plans with you, and builds the roadmap on the left as you talk.</p>
        </div>
      )}
    </aside>
  )
}

export function RoadmapView({ snaps, focused = false, onChange }: {
  snaps: Snapshot[]; focused?: boolean; onChange: () => void
}) {
  const [openCard, setOpenCard] = useState<{ card: Card; boardId: number } | null>(null)
  const [openIdea, setOpenIdea] = useState<{ idea: Idea; boardId: number } | null>(null)
  const [term, setTerm] = useState<{ agent: Agent; boardId: number } | null>(null)
  const [dockOpen, setDockOpen] = useState(() => {
    try { return localStorage.getItem('orchestra-roadmap-dock') !== 'closed' } catch { return true }
  })
  const setDock = (open: boolean) => {
    setDockOpen(open)
    try { localStorage.setItem('orchestra-roadmap-dock', open ? 'open' : 'closed') } catch { /* private mode */ }
  }

  const single = snaps.length === 1 ? snaps[0] : null
  const canvasKey = single ? `roadmap-${single.board.id}` : 'roadmap-all'
  // the drawer and the terminal follow the live snapshot, so a refresh doesn't stale them
  const liveCard = openCard
    ? snaps.find((s) => s.board.id === openCard.boardId)?.cards.find((c) => c.id === openCard.card.id) ?? openCard.card
    : null
  const liveAgent = term
    ? snaps.find((s) => s.board.id === term.boardId)?.agents.find((a) => a.id === term.agent.id) ?? term.agent
    : null

  return (
    <div className={`rmap-wrap ${dockOpen && single ? 'with-dock' : ''}`}>
      <div className="rmap-canvas">
        <BoardCanvas focused={focused || snaps.length === 1} storageKey={canvasKey}>
          {(viewport) => snaps.map((s) => (
            <RoadmapBoard key={s.board.id} snap={s} viewport={viewport}
              onOpenCard={(c) => setOpenCard({ card: c, boardId: s.board.id })}
              onOpenIdea={(i) => setOpenIdea({ idea: i, boardId: s.board.id })}
              onChange={onChange} />
          ))}
        </BoardCanvas>
        {single && !dockOpen && (
          <button className="rmap-dock-pill" title="Plan with the strategist" onClick={() => setDock(true)}>
            ✻ Strategist
          </button>
        )}
      </div>

      {single && dockOpen && (
        <BrainstormDock snap={single} onChange={onChange} onCollapse={() => setDock(false)} />
      )}

      {openCard && liveCard && (
        <CardDrawer card={liveCard} boardId={openCard.boardId}
          agents={(snaps.find((s) => s.board.id === openCard.boardId)?.agents ?? [])
            .filter((a) => a.status !== 'gone' && a.name !== 'strategist' && !a.name.startsWith('auditor-'))}
          onClose={() => setOpenCard(null)} onChange={onChange} />
      )}
      {openIdea && (
        <IdeaModal
          idea={(snaps.find((s) => s.board.id === openIdea.boardId)?.ideas ?? [])
            .find((x) => x.id === openIdea.idea.id) ?? openIdea.idea}
          boardId={openIdea.boardId}
          auditor={snaps.find((s) => s.board.id === openIdea.boardId)?.agents
            .find((a) => a.name === `auditor-${openIdea.idea.id}` && a.status !== 'gone')}
          onWatch={(a) => setTerm({ agent: a, boardId: openIdea.boardId })}
          onClose={() => setOpenIdea(null)} onChange={onChange} />
      )}
      {term && liveAgent && (
        <AgentTerminal agent={liveAgent} boardId={term.boardId}
          threads={(snaps.find((s) => s.board.id === term.boardId)?.threads ?? []) as Thread[]}
          cards={snaps.find((s) => s.board.id === term.boardId)?.cards ?? []}
          onClose={() => setTerm(null)} onChange={onChange} />
      )}
    </div>
  )
}
