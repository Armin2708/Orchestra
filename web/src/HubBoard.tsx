import React, { useEffect, useState } from 'react'
import { agentInk, agentWash, initials } from './api'
import { agentActivity } from './agentActivity'
import {
  HubAgent, HubApiError, HubCard, HubCardColumn, listHubAgents, listHubCards,
} from './hubApi'
import { STATUS } from './Board'
import './kanban.css'
import './hubBoard.css'

// One shared project board per org (Plan 3's pitch: "several people's local
// daemons share one project board") — the hub schema allows multiple `projects`/
// `boards` rows per org for future flexibility, but there is no boards-listing
// route yet (see the report), so this renders every card/agent in the org flat,
// same lanes `STATUS` (Board.tsx) already defines for the local board.
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
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const [nextCards, nextAgents] = await Promise.all([listHubCards(orgId), listHubAgents(orgId)])
        if (cancelled) return
        setCards(nextCards)
        setAgents(nextAgents)
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
                    <HubCardChip key={card.id} card={card} owner={card.owner_agent ? agentByName.get(card.owner_agent) ?? null : null} />
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      </section>

      <aside className="hub-agent-roster" aria-label="Agents">
        <h3>Agents</h3>
        {agents.length === 0 && <p className="hub-agent-empty">No agents connected yet.</p>}
        <ul>
          {agents.map((a) => <HubAgentRow key={a.id} agent={a} />)}
        </ul>
      </aside>
    </div>
  )
}

function HubCardChip({ card, owner }: { card: HubCard; owner: HubAgent | null }) {
  const ownerWorking = owner !== null && hubAgentActivity(owner) === 'working'
  return (
    <article className="kanban-card">
      <header>
        <span className="kanban-card-id">#{card.number}</span>
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

function HubAgentRow({ agent }: { agent: HubAgent }) {
  const activity = hubAgentActivity(agent)
  return (
    <li className="hub-agent-row">
      <span className={`avatar mini ${activity === 'idle' ? 'idle' : ''} ${activity === 'gone' ? 'offline' : ''}`}
        style={{ background: agentWash(agent.name), color: agentInk(agent.name) }}>
        {initials(agent.name)}
        <i className="presence" />
      </span>
      <div className="hub-agent-meta">
        <span className="hub-agent-name">{agent.name}</span>
        <span className="hub-agent-activity">{agent.activity || (agent.state === 'offline' ? 'offline' : 'idle')}</span>
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
