import React, { useEffect, useState } from 'react'
import { agentInk, agentWash, initials } from './api'
import { agentActivity } from './agentActivity'
import {
  HubAgent, HubApiError, HubBoardSummary, HubCard, HubCardColumn, HubMilestone,
  createHubProject, listHubAgents, listHubBoards, listHubCards, listHubMilestones,
} from './hubApi'
import { STATUS } from './Board'
import './kanban.css'
import './hubBoard.css'

// Cards and agents render flat across the org, same lanes `STATUS` (Board.tsx) already
// defines for the local board. The boards panel below is separate on purpose: what a member
// actually needs from it is a board ID to hand a daemon, not a filter — every write op takes
// one, and until the projects/boards routes existed there was no way to see or create one.
const LANES: HubCardColumn[] = ['backlog', 'in_progress', 'blocked', 'review', 'done']

const POLL_MS = 5000

/**
 * The org board: read-only by design (see the report for why — the hub's ops
 * endpoint speaks a different, event-sourced mutation shape than the local
 * daemon's REST-ish `/cards/:id/move`, and forking `KanbanView`/`ProjectGrid`
 * to speak both was explicitly out of scope: "reuse existing board components,
 * do not fork them"). Reuses `kanban.css`'s classes and `STATUS`'s labels/colors
 * from the local board so this reads as the same product, and `agentActivity`
 * (structurally typed — `{ status, last_seen }` — HubAgent's `state`/
 * `last_heartbeat_at` map onto it below) for the same "is this agent actually
 * working right now" pulse the local kanban owner chip uses.
 */
export function HubBoard({ orgId }: { orgId: string }) {
  const [cards, setCards] = useState<HubCard[] | null>(null)
  const [agents, setAgents] = useState<HubAgent[] | null>(null)
  const [milestones, setMilestones] = useState<HubMilestone[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const [nextCards, nextAgents, nextMilestones] = await Promise.all([
          listHubCards(orgId), listHubAgents(orgId),
          // An older hub without the milestones route must not blank the whole board.
          listHubMilestones(orgId).catch(() => [] as HubMilestone[]),
        ])
        if (cancelled) return
        setCards(nextCards)
        setAgents(nextAgents)
        setMilestones(nextMilestones)
        setError(null)
      } catch (e) {
        if (cancelled) return
        setError(e instanceof HubApiError ? e.message : 'failed to load the board')
      }
    }
    void load()
    const timer = setInterval(() => void load(), POLL_MS)
    return () => { cancelled = true; clearInterval(timer) }
  }, [orgId])

  const agentByName = new Map((agents ?? []).map((a) => [a.name, a]))
  const cardById = new Map((cards ?? []).map((c) => [c.id, c]))
  const milestoneById = new Map(milestones.map((m) => [m.id, m]))

  if (error && cards === null) {
    return <div className="hub-board-error" role="alert">{error}</div>
  }
  if (cards === null || agents === null) {
    return <div className="hub-board-loading" aria-label="Loading board">Loading…</div>
  }

  return (
    <div className="hub-board">
      <section className="kanban-board" aria-label="Org board">
        {error && <span className="kanban-error" role="alert">{error}</span>}
        {milestones.filter((m) => m.status === 'open').length > 0 && (
          <div className="hub-milestone-strip" aria-label="Milestones">
            {milestones.filter((m) => m.status === 'open').map((m) => {
              const steps = cards.filter((c) => c.milestone_id === m.id)
              const done = steps.filter((c) => c.column === 'done').length
              return (
                <span key={m.id} className="hub-milestone-chip" title={m.description || m.title}>
                  <strong>{m.title}</strong>
                  <span className="hub-milestone-count">{done}/{steps.length}</span>
                </span>
              )
            })}
          </div>
        )}
        <div className="kanban-lanes">
          {LANES.map((lane) => {
            const laneCards = cards.filter((c) => c.column === lane)
            const status = STATUS[lane]
            return (
              <div key={lane} className={`kanban-lane kanban-lane-${lane}`}>
                <div className="kanban-lane-head">
                  <span className={`kanban-lane-dot dot-${lane}`} aria-hidden="true" />
                  <span>{status?.label ?? lane}</span>
                  <span className="kanban-lane-count">{laneCards.length}</span>
                </div>
                <div className="kanban-lane-body">
                  {laneCards.length === 0 && <p className="kanban-empty">No cards</p>}
                  {laneCards.map((card) => (
                    <HubCardChip key={card.id} card={card}
                      owner={card.owner_agent ? agentByName.get(card.owner_agent) ?? null : null}
                      milestone={card.milestone_id ? milestoneById.get(card.milestone_id) ?? null : null} />
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      </section>

      <aside className="hub-side-panels">
        <HubBoardsPanel orgId={orgId} />
        <section className="hub-agent-roster" aria-label="Agents">
          <h3>Agents</h3>
          {agents.length === 0 && <p className="hub-agent-empty">No agents connected yet.</p>}
          <ul>
            {agents.map((a) => (
              <HubAgentRow key={a.id} agent={a}
                currentCard={a.current_card_id ? cardById.get(a.current_card_id) ?? null : null} />
            ))}
          </ul>
        </section>
      </aside>
    </div>
  )
}

/**
 * The org's projects and boards, with a create form.
 *
 * Nothing in the product could create either one before this: every write op requires a
 * `board_id` that already exists, so a customer who paid had nothing to point a daemon at.
 * A new org gets one automatically (the Clerk `organization.created` webhook seeds it), and
 * this is how a member sees that board's id — which their daemon needs verbatim — and adds
 * more. Creating is a write, so a never-subscribed or suspended org gets the server's own
 * refusal text here rather than a generic error.
 */
function HubBoardsPanel({ orgId }: { orgId: string }) {
  const [boards, setBoards] = useState<HubBoardSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)

  const load = async () => {
    try {
      setBoards(await listHubBoards(orgId))
      setError(null)
    } catch (e) {
      setError(e instanceof HubApiError ? e.message : 'failed to load boards')
    }
  }

  // Loaded once per org rather than polled like the cards/agents above: boards change when
  // someone creates one, and `create` refreshes the list itself.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void load() }, [orgId])

  const create = async (event: React.FormEvent) => {
    event.preventDefault()
    const trimmed = name.trim()
    if (!trimmed || busy) return
    setBusy(true); setError(null)
    try {
      await createHubProject(orgId, trimmed)
      setName('')
      await load()
    } catch (e) {
      setError(e instanceof HubApiError ? e.message : 'could not create the project')
    } finally { setBusy(false) }
  }

  return (
    <section className="hub-boards-panel" aria-label="Projects and boards">
      <h3>Boards</h3>
      {boards === null && !error && <p className="hub-agent-empty">Loading…</p>}
      {boards !== null && boards.length === 0 && (
        <p className="hub-agent-empty">No boards yet — create one to give your daemons somewhere to work.</p>
      )}
      <ul className="hub-board-list">
        {(boards ?? []).map((board) => (
          <li key={board.id} className="hub-board-item">
            <span className="hub-board-name">{board.project_name}</span>
            <code className="hub-board-id" title="Board id — your daemon needs this">{board.id}</code>
          </li>
        ))}
      </ul>
      <form className="hub-board-create" onSubmit={create}>
        <input value={name} onChange={(e) => setName(e.target.value)} className="hub-token-input"
          placeholder="New project name" aria-label="New project name" />
        <button type="submit" className="btn primary" disabled={busy || !name.trim()}>
          {busy ? 'Creating…' : 'Create'}
        </button>
      </form>
      {error && <p className="billing-error" role="alert">{error}</p>}
    </section>
  )
}

function HubCardChip({ card, owner, milestone }: {
  card: HubCard; owner: HubAgent | null; milestone: HubMilestone | null
}) {
  const ownerWorking = owner !== null && hubAgentActivity(owner) === 'working'
  return (
    <article className="kanban-card">
      <header>
        <span className="kanban-card-id">#{card.number}</span>
        {milestone && <span className="hub-card-milestone" title={milestone.title}>{milestone.title}</span>}
      </header>
      <p className="kanban-card-title">{card.title}</p>
      <footer>
        {card.owner_agent && (
          <span className={`kanban-owner${ownerWorking ? ' working' : ''}`}
            title={ownerWorking ? `${card.owner_agent} — working now` : card.owner_agent}
            style={{ background: agentWash(card.owner_agent), color: agentInk(card.owner_agent) }}>
            {initials(card.owner_agent)}
            {ownerWorking && <i className="kanban-owner-pulse" aria-hidden="true" />}
          </span>
        )}
      </footer>
    </article>
  )
}

function HubAgentRow({ agent, currentCard }: { agent: HubAgent; currentCard: HubCard | null }) {
  const activity = hubAgentActivity(agent)
  const doing = currentCard
    ? `on #${currentCard.number} ${currentCard.title}`
    : agent.activity || (agent.state === 'offline' ? 'offline' : 'idle')
  return (
    <li className="hub-agent-row">
      <span className={`avatar mini ${activity === 'idle' ? 'idle' : ''} ${activity === 'gone' ? 'offline' : ''}`}
        style={{ background: agentWash(agent.name), color: agentInk(agent.name) }}>
        {initials(agent.name)}
        <i className="presence" />
      </span>
      <div className="hub-agent-meta">
        <span className="hub-agent-name">{agent.name}</span>
        <span className="hub-agent-activity" title={doing}>{doing}</span>
      </div>
    </li>
  )
}

/**
 * `agentActivity` (agentActivity.ts) is structurally typed on `{ status, last_seen }`
 * — the local vocabulary. `HubAgent` speaks a different one (`state`/
 * `last_heartbeat_at`); this maps one onto the other rather than forking the
 * function, so both surfaces derive "is this agent actually working" the same way.
 */
function hubAgentActivity(agent: HubAgent): 'working' | 'idle' | 'gone' {
  if (agent.state === 'offline') return 'gone'
  return agentActivity({
    status: agent.state === 'working' ? 'active' : agent.state,
    last_seen: agent.last_heartbeat_at,
  })
}
