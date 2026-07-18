import React, { useState } from 'react'
import { api, Agent, Card, Idea, Milestone, Snapshot, Thread, agentInk, agentWash, initials, timeAgo } from './api'
import { AgentTerminal } from './AgentTerminal'
import { STATUS } from './Board'

const ORDER = ['backlog', 'in_progress', 'blocked', 'review', 'done']

function MilestoneQuest({ m, cards, agents, onChange }:
  { m: Milestone; cards: Card[]; agents: { id: number; name: string }[]; onChange: () => void }) {
  const [stepTitle, setStepTitle] = useState('')
  const steps = cards.filter((c) => c.milestone_id === m.id)
    .sort((a, b) => (a.step_order ?? 0) - (b.step_order ?? 0))
  const done = steps.filter((s) => s.column === 'done').length
  const pct = steps.length ? Math.round((done / steps.length) * 100) : 0
  const complete = steps.length > 0 && done === steps.length

  const addStep = async () => {
    if (!stepTitle.trim()) return
    await api('POST', `/milestones/${m.id}/steps`, { title: stepTitle.trim() })
    setStepTitle(''); onChange()
  }
  const assign = async (cardId: number, agent: string) => {
    if (!agent) return
    try { await api('POST', `/cards/${cardId}/assign`, { agent }) } catch { /* locked */ }
    onChange()
  }

  let blocked = false
  return (
    <div className={complete ? 'quest complete' : 'quest'}>
      <div className="quest-head">
        <span className="quest-flag">{complete ? '🏆' : '⛳'}</span>
        <div className="quest-title">
          <h4>{m.title}</h4>
          {m.description && <p>{m.description}</p>}
        </div>
        {complete && <span className="quest-badge">Complete!</span>}
        <button className="icon-x" title="Delete milestone (steps become normal tickets)"
          onClick={async () => { await api('DELETE', `/milestones/${m.id}`); onChange() }}>×</button>
      </div>
      <div className="quest-progress">
        <div className="quest-track"><div className="quest-fill" style={{ width: `${pct}%` }} /></div>
        <span className="quest-pct">{done}/{steps.length}</span>
      </div>
      <ol className="quest-steps">
        {steps.map((s) => {
          const locked = blocked
          if (s.column !== 'done') blocked = true
          const state = s.column === 'done' ? 'done' : locked ? 'locked' : s.column === 'in_progress' ? 'active' : 'open'
          return (
            <li key={s.id} className={`quest-step ${state}`}>
              <span className="step-mark">
                {state === 'done' ? '✓' : state === 'locked' ? '🔒' : state === 'active' ? '●' : '○'}
              </span>
              <span className="step-title">{s.title}</span>
              {s.owner && <span className="owner"><i className="avatar mini" style={{ background: agentWash(s.owner), color: agentInk(s.owner) }}>{initials(s.owner)}</i>{s.owner}</span>}
              {state !== 'done' && !locked && agents.length > 0 && (
                <select className="assign-select" defaultValue=""
                  onChange={(e) => { assign(s.id, e.target.value); e.target.value = '' }}>
                  <option value="" disabled>assign…</option>
                  {agents.filter((a) => a.name !== s.owner).map((a) => <option key={a.id} value={a.name}>{a.name}</option>)}
                </select>
              )}
              {locked && <span className="step-lockhint">complete previous step</span>}
            </li>
          )
        })}
      </ol>
      <div className="quest-add">
        <input value={stepTitle} placeholder="+ add a step (unlocks in order)"
          onChange={(e) => setStepTitle(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') addStep() }} />
      </div>
    </div>
  )
}

function ProjectRoadmap({ snap, onChange, onOpenAgent, hideBrainstorm = false }: { snap: Snapshot; onChange: () => void; onOpenAgent: (a: Agent) => void; hideBrainstorm?: boolean }) {
  const [text, setText] = useState('')
  const [openIdea, setOpenIdea] = useState<Idea | null>(null)
  const [brainstorm, setBrainstorm] = useState('')
  const [briefing, setBriefing] = useState(false)
  const allLive = snap.agents.filter((a) => a.status !== 'gone')
  const strategist = allLive.find((a) => a.name === 'strategist')
  const agents = allLive.filter((a) => a.name !== 'strategist') // the strategist writes tickets, it doesn't take them

  const askStrategist = async () => {
    if (!brainstorm.trim() || briefing) return
    setBriefing(true)
    try {
      let agent = strategist
      if (!agent) agent = await api('POST', `/boards/${snap.board.id}/hire`, { name: 'strategist', role: 'strategist' })
      await api('POST', `/agents/${agent!.id}/task`, {
        text: `Brainstorm request from the roadmap: "${brainstorm.trim()}". Research the repo as needed, think with me, and add your ideas to the roadmap with orchestra idea (or tickets in your prompt format when they're well-defined). Finish with a one-line summary.`,
      })
      setBrainstorm('')
      onOpenAgent(agent!) // watch the whole conversation in its console
    } finally { setBriefing(false); onChange() }
  }

  const add = async () => {
    if (!text.trim()) return
    await api('POST', '/ideas', { board_id: snap.board.id, text: text.trim() })
    setText(''); onChange()
  }
  const assign = async (cardId: number, agent: string) => {
    if (!agent) return
    await api('POST', `/cards/${cardId}/assign`, { agent })
    onChange()
  }

  const tickets = snap.cards.filter((c) => !c.milestone_id).sort((a, b) => ORDER.indexOf(a.column) - ORDER.indexOf(b.column))

  return (
    <section className="rm-project">
      <h2>{snap.board.name}</h2>

      {!hideBrainstorm && <div className="rm-brainstorm">
        <span className="rm-spark">✻</span>
        <input value={brainstorm}
          placeholder={strategist ? `Ask ${'strategist'} to brainstorm — it researches the repo and adds ideas below` : 'Ask Claude to brainstorm — hires a strategist agent for this project'}
          onChange={(e) => setBrainstorm(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') askStrategist() }} />
        {strategist && (
          <button className="agent-chip" title="Open the strategist's console"
            onClick={() => onOpenAgent(strategist)}>
            <i className="avatar mini" style={{ background: agentWash(strategist.name), color: agentInk(strategist.name) }}>{initials(strategist.name)}</i>
            console
          </button>
        )}
        <button className="btn primary" disabled={briefing} onClick={askStrategist}>
          {briefing ? 'Briefing…' : strategist?.status === 'active' ? 'Working…' : 'Brainstorm'}
        </button>
      </div>}

      <div className="rm-composer">
        <textarea value={text} rows={2}
          placeholder={'Or jot an idea yourself — first line becomes the ticket title, the rest its scope.\nEnter to save, Shift+Enter for a new line.'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); add() } }} />
      </div>

      <h3 className="rm-h">Milestones <span className="rm-count">{(snap.milestones ?? []).length}</span></h3>
      <NewMilestone boardId={snap.board.id} onChange={onChange} />
      <div className="quests">
        {(snap.milestones ?? []).map((m) => (
          <MilestoneQuest key={m.id} m={m} cards={snap.cards} agents={agents} onChange={onChange} />
        ))}
      </div>

      <h3 className="rm-h">Ideas <span className="rm-count">{(snap.ideas ?? []).length}</span></h3>
      <div className="rm-ideas">
        {(snap.ideas ?? []).map((i) => (
          <button key={i.id} className="rm-idea" onClick={() => setOpenIdea(i)}>
            <p className="rm-idea-title">{i.text.split('\n')[0]}</p>
            {i.text.includes('\n') && <p className="rm-idea-desc">{i.text.split('\n').slice(1).join(' ')}</p>}
            <span className="rm-idea-open">open ›</span>
          </button>
        ))}
        {(snap.ideas ?? []).length === 0 && <p className="col-empty">No ideas yet — brainstorm above.</p>}
      </div>
      {openIdea && <IdeaModal idea={(snap.ideas ?? []).find((x) => x.id === openIdea.id) ?? openIdea}
        agents={agents} onClose={() => setOpenIdea(null)} onChange={onChange} />}

      <h3 className="rm-h">Tickets <span className="rm-count">{tickets.length}</span></h3>
      <div className="rm-tickets">
        {tickets.map((c) => {
          const st = STATUS[c.column] ?? STATUS.backlog
          return (
            <div key={c.id} className={`rm-ticket ${c.column === 'done' ? 'is-done' : ''}`}>
              <span className="status-chip" style={{ background: st.bg, color: st.ink }}>{st.label}</span>
              <span className="rm-ticket-title" title={c.description || c.title}>{c.title}</span>
              {c.owner
                ? <span className="owner"><i className="avatar mini" style={{ background: agentWash(c.owner), color: agentInk(c.owner) }}>{initials(c.owner)}</i>{c.owner}</span>
                : <span className="owner unowned">unassigned</span>}
              <time>{timeAgo(c.updated_at)}</time>
              {agents.length > 0 && (
                <select className="assign-select" defaultValue=""
                  onChange={(e) => { assign(c.id, e.target.value); e.target.value = '' }}>
                  <option value="" disabled>assign…</option>
                  {agents.filter((a) => a.name !== c.owner).map((a) => <option key={a.id} value={a.name}>{a.name}</option>)}
                </select>
              )}
            </div>
          )
        })}
        {tickets.length === 0 && <p className="col-empty">No tickets yet — promote an idea.</p>}
      </div>
    </section>
  )
}

function NewMilestone({ boardId, onChange }: { boardId: number; onChange: () => void }) {
  const [title, setTitle] = useState('')
  const add = async () => {
    if (!title.trim()) return
    await api('POST', '/milestones', { board_id: boardId, title: title.trim() })
    setTitle(''); onChange()
  }
  return (
    <div className="quest-new">
      <input value={title} placeholder="🎯 New milestone — a major goal made of ordered steps"
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') add() }} />
    </div>
  )
}

function IdeaModal({ idea, agents, onClose, onChange }:
  { idea: Idea; agents: { id: number; name: string }[]; onClose: () => void; onChange: () => void }) {
  const [title, ...rest] = idea.text.split('\n')
  const body = rest.join('\n').trim()
  const promote = async (agent: string) => {
    await api('POST', `/ideas/${idea.id}/promote`, agent ? { agent } : {})
    onClose(); onChange()
  }
  return (
    <>
      <div className="idea-scrim" onClick={onClose} />
      <div className="idea-modal" role="dialog">
        <span className="idea-modal-kicker">✳ roadmap idea · {timeAgo(idea.created_at)}</span>
        <h3>{title}</h3>
        {body ? <p className="idea-modal-body">{body}</p> : <p className="idea-modal-body empty">No details yet — promote it or refine it with the strategist.</p>}
        <div className="idea-modal-actions">
          <button className="btn primary" onClick={() => promote('')}>→ Ticket</button>
          {agents.map((a) => (
            <button key={a.id} className="agent-chip" onClick={() => promote(a.name)}>→ {a.name}</button>
          ))}
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

function BrainstormWorkspace({ snap, onChange }: { snap: Snapshot; onChange: () => void }) {
  const [busy, setBusy] = useState(false)
  const strategist = snap.agents.find((a) => a.name === 'strategist' && a.status !== 'gone')

  const ensureStrategist = async (): Promise<Agent> => {
    if (strategist) return strategist
    return api('POST', `/boards/${snap.board.id}/hire`, { name: 'strategist', role: 'strategist' })
  }
  const startMode = async (prompt: string) => {
    if (busy) return
    setBusy(true)
    try {
      const agent = await ensureStrategist()
      await api('POST', `/agents/${agent.id}/task`, { text: prompt })
    } finally { setBusy(false); onChange() }
  }

  return (
    <div className="rm-right">
      <div className="rm-modes">
        {MODES.map((m) => (
          <button key={m.key} className="mode-chip" disabled={busy} onClick={() => startMode(m.prompt)}>{m.label}</button>
        ))}
      </div>
      {strategist ? (
        <AgentTerminal embedded agent={strategist} boardId={snap.board.id}
          threads={snap.threads as Thread[]} cards={snap.cards}
          onClose={() => {}} onChange={onChange} />
      ) : (
        <div className="rm-placeholder">
          <p><span className="rm-spark">✻</span> Pick a mode above to wake the strategist.</p>
          <p className="rm-placeholder-sub">It researches this repo, brainstorms with you, and builds the roadmap on the left as you talk.</p>
        </div>
      )}
    </div>
  )
}

export function RoadmapView({ snaps, focused = false, onChange }: { snaps: Snapshot[]; focused?: boolean; onChange: () => void }) {
  const [term, setTerm] = useState<{ agent: Agent; boardId: number } | null>(null)
  const liveAgent = term
    ? snaps.find((s) => s.board.id === term.boardId)?.agents.find((a) => a.id === term.agent.id) ?? term.agent
    : null

  if (focused && snaps.length === 1) {
    const s = snaps[0]
    return (
      <main className="rm-split">
        <div className="rm-left">
          <ProjectRoadmap snap={s} onChange={onChange} hideBrainstorm
            onOpenAgent={(a) => setTerm({ agent: a, boardId: s.board.id })} />
        </div>
        <BrainstormWorkspace snap={s} onChange={onChange} />
        {term && liveAgent && <AgentTerminal
          agent={liveAgent} boardId={term.boardId}
          threads={(snaps.find((x) => x.board.id === term.boardId)?.threads ?? []) as Thread[]}
          cards={snaps.find((x) => x.board.id === term.boardId)?.cards ?? []}
          onClose={() => setTerm(null)} onChange={onChange} />}
      </main>
    )
  }

  return (
    <main className={focused ? 'roadmap focused' : 'roadmap'}>
      {snaps.map((s) => <ProjectRoadmap key={s.board.id} snap={s} onChange={onChange}
        onOpenAgent={(a) => setTerm({ agent: a, boardId: s.board.id })} />)}
      {term && liveAgent && <AgentTerminal
        agent={liveAgent}
        boardId={term.boardId}
        threads={(snaps.find((s) => s.board.id === term.boardId)?.threads ?? []) as Thread[]}
        cards={snaps.find((s) => s.board.id === term.boardId)?.cards ?? []}
        onClose={() => setTerm(null)} onChange={onChange} />}
    </main>
  )
}
