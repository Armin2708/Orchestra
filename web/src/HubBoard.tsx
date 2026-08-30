import React, { useCallback, useEffect, useState } from 'react'
import { agentInk, agentWash, initials } from './api'
import { agentActivity } from './agentActivity'
import {
  HubAgent, HubApiError, HubBoardSummary, HubCard, HubCardColumn, HubDeviceSummary, HubMilestone,
  createHubProject, hubOp, listHubAgents, listHubBoards, listHubCards, listHubDevices, listHubMilestones,
} from './hubApi'
import { STATUS } from './Board'
import './kanban.css'
import './hubBoard.css'

// Same lanes as the local board (`STATUS`, Board.tsx) so the cloud board reads as the
// same product — one shared org-wide view instead of one per machine.
const LANES: HubCardColumn[] = ['backlog', 'in_progress', 'blocked', 'review', 'done']

const POLL_MS = 5000

/**
 * The org board people actually WORK on — not a read-only mirror. Every mutation goes
 * through the hub's ops endpoint (`hubOp`), the same event-sourced channel the daemons
 * speak, so a card moved here lands on every connected machine's local board and vice
 * versa. Stale writes 409 on the hub; the next poll repairs the view, so conflicts
 * lose an edit, never corrupt the board.
 */
export function HubBoard({ orgId, userId }: { orgId: string; userId?: string }) {
  const [cards, setCards] = useState<HubCard[] | null>(null)
  const [agents, setAgents] = useState<HubAgent[] | null>(null)
  const [milestones, setMilestones] = useState<HubMilestone[]>([])
  const [boards, setBoards] = useState<HubBoardSummary[]>([])
  const [devices, setDevices] = useState<HubDeviceSummary[]>([])
  const [error, setError] = useState<string | null>(null)
  const [openCardId, setOpenCardId] = useState<string | null>(null)
  const [draggingId, setDraggingId] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const [nextCards, nextAgents, nextMilestones, nextDevices] = await Promise.all([
        listHubCards(orgId), listHubAgents(orgId),
        // An older hub without the milestones route must not blank the whole board.
        listHubMilestones(orgId).catch(() => [] as HubMilestone[]),
        listHubDevices(orgId).catch(() => [] as HubDeviceSummary[]),
      ])
      setCards(nextCards)
      setAgents(nextAgents)
      setMilestones(nextMilestones)
      setDevices(nextDevices)
      setError(null)
    } catch (e) {
      setError(e instanceof HubApiError ? e.message : 'failed to load the board')
    }
  }, [orgId])

  useEffect(() => {
    let cancelled = false
    const tick = () => { if (!cancelled) void load() }
    tick()
    const timer = setInterval(tick, POLL_MS)
    return () => { cancelled = true; clearInterval(timer) }
  }, [load])

  useEffect(() => {
    listHubBoards(orgId).then(setBoards).catch(() => {})
  }, [orgId])

  /** Run one hub op, surface its refusal verbatim, and re-poll either way. */
  const act = useCallback(async (op: string, payload: Record<string, unknown>) => {
    try {
      await hubOp(orgId, op, payload)
      setError(null)
    } catch (e) {
      setError(e instanceof HubApiError ? e.message : 'the hub refused the change')
    }
    await load()
  }, [orgId, load])

  const defaultBoardId = boards[0]?.id ?? cards?.[0]?.board_id ?? null

  const agentByName = new Map((agents ?? []).map((a) => [a.name, a]))
  const cardById = new Map((cards ?? []).map((c) => [c.id, c]))
  const milestoneById = new Map(milestones.map((m) => [m.id, m]))
  const openCard = openCardId ? cardById.get(openCardId) ?? null : null

  if (error && cards === null) {
    return <div className="hub-board-error" role="alert">{error}</div>
  }
  if (cards === null || agents === null) {
    return <div className="hub-board-loading" aria-label="Loading board">Loading…</div>
  }

  const drop = (lane: HubCardColumn) => (event: React.DragEvent) => {
    event.preventDefault()
    const id = draggingId ?? event.dataTransfer.getData('text/hub-card')
    setDraggingId(null)
    const card = id ? cardById.get(id) : null
    if (!card || card.column === lane) return
    void act('card.move', { card_id: card.id, expected_version: card.version, column: lane })
  }

  return (
    <div className="hub-board">
      <section className="kanban-board" aria-label="Org board">
        {error && <span className="kanban-error" role="alert">{error}</span>}
        <MilestoneStrip milestones={milestones} cards={cards} boardId={defaultBoardId} act={act} />
        <div className="kanban-lanes">
          {LANES.map((lane) => {
            const laneCards = cards.filter((c) => c.column === lane)
            const status = STATUS[lane]
            return (
              <div key={lane} className={`kanban-lane kanban-lane-${lane}`}
                onDragOver={(e) => e.preventDefault()} onDrop={drop(lane)}>
                <div className="kanban-lane-head">
                  <span className={`kanban-lane-dot dot-${lane}`} aria-hidden="true" />
                  <span>{status?.label ?? lane}</span>
                  <span className="kanban-lane-count">{laneCards.length}</span>
                </div>
                <div className="kanban-lane-body">
                  {lane === 'backlog' && defaultBoardId && (
                    <NewCardForm boardId={defaultBoardId} act={act} />
                  )}
                  {laneCards.length === 0 && lane !== 'backlog' && <p className="kanban-empty">No cards</p>}
                  {laneCards.map((card) => (
                    <HubCardChip key={card.id} card={card}
                      owner={card.owner_agent ? agentByName.get(card.owner_agent) ?? null : null}
                      milestone={card.milestone_id ? milestoneById.get(card.milestone_id) ?? null : null}
                      dragging={draggingId === card.id}
                      onOpen={() => setOpenCardId(card.id)}
                      onDragStart={(e) => {
                        e.dataTransfer.setData('text/hub-card', card.id)
                        e.dataTransfer.effectAllowed = 'move'
                        setDraggingId(card.id)
                      }}
                      onDragEnd={() => setDraggingId(null)} />
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      </section>

      <aside className="hub-side-panels">
        <MachinesPanel devices={devices} userId={userId} />
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

      {openCard && (
        <HubCardDrawer card={openCard} agents={agents} milestones={milestones}
          act={act} onClose={() => setOpenCardId(null)} />
      )}
    </div>
  )
}

/**
 * Every row is one person's daemon on one machine — the whole point of the org board
 * is that several people connect their own CLIs to the same project, so "whose
 * machine is on right now" is first-class, with the viewer's own device called out.
 */
function MachinesPanel({ devices, userId }: { devices: HubDeviceSummary[]; userId?: string }) {
  const active = devices.filter((d) => !d.revoked_at)
  if (active.length === 0) return null
  return (
    <section className="hub-machines" aria-label="Connected machines">
      <h3>Machines</h3>
      <ul>
        {active.map((d) => {
          const person = d.owner_display_name || d.owner_email || 'unassigned'
          const you = userId !== undefined && d.owner_user_id === userId
          return (
            <li key={d.id} className="hub-machine-row">
              <i className={`hub-machine-dot${d.connected ? ' on' : ''}`} aria-hidden="true" />
              <span className="hub-machine-name">{d.name}</span>
              <span className="hub-machine-owner">{you ? 'you' : person}</span>
              <span className={`hub-machine-state${d.connected ? ' on' : ''}`}>
                {d.connected ? 'connected' : 'offline'}
              </span>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

function MilestoneStrip({ milestones, cards, boardId, act }: {
  milestones: HubMilestone[]
  cards: HubCard[]
  boardId: string | null
  act: (op: string, payload: Record<string, unknown>) => Promise<void>
}) {
  const [adding, setAdding] = useState(false)
  const [title, setTitle] = useState('')
  const open = milestones.filter((m) => m.status === 'open')
  const create = async (event: React.FormEvent) => {
    event.preventDefault()
    const trimmed = title.trim()
    if (!trimmed || !boardId) return
    setTitle('')
    setAdding(false)
    await act('milestone.create', { board_id: boardId, title: trimmed })
  }
  return (
    <div className="hub-milestone-strip" aria-label="Milestones">
      {open.map((m) => {
        const steps = cards.filter((c) => c.milestone_id === m.id)
        const done = steps.filter((c) => c.column === 'done').length
        return (
          <span key={m.id} className="hub-milestone-chip" title={m.description || m.title}>
            <strong>{m.title}</strong>
            <span className="hub-milestone-count">{done}/{steps.length}</span>
          </span>
        )
      })}
      {adding ? (
        <form className="hub-milestone-add" onSubmit={create}>
          <input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus
            className="hub-inline-input" placeholder="Milestone title" aria-label="Milestone title" />
          <button type="submit" className="btn primary" disabled={!title.trim()}>Add</button>
          <button type="button" className="btn ghost" onClick={() => { setAdding(false); setTitle('') }}>Cancel</button>
        </form>
      ) : (
        <button type="button" className="hub-milestone-chip hub-milestone-new"
          disabled={!boardId} onClick={() => setAdding(true)}>+ milestone</button>
      )}
    </div>
  )
}

function NewCardForm({ boardId, act }: {
  boardId: string
  act: (op: string, payload: Record<string, unknown>) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    const trimmed = title.trim()
    if (!trimmed) return
    setTitle('')
    setOpen(false)
    await act('card.create', { board_id: boardId, title: trimmed })
  }
  if (!open) {
    return (
      <button type="button" className="hub-new-card" onClick={() => setOpen(true)}>+ New card</button>
    )
  }
  return (
    <form className="hub-new-card-form" onSubmit={submit}>
      <input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus
        className="hub-inline-input" placeholder="Card title" aria-label="New card title"
        onKeyDown={(e) => { if (e.key === 'Escape') { setOpen(false); setTitle('') } }} />
      <div className="hub-new-card-actions">
        <button type="submit" className="btn primary" disabled={!title.trim()}>Add</button>
        <button type="button" className="btn ghost" onClick={() => { setOpen(false); setTitle('') }}>Cancel</button>
      </div>
    </form>
  )
}

/**
 * Edit surface for one shared card. Saves address the version the drawer was showing —
 * if a teammate (or their agent) got there first, the hub 409s with its own message and
 * the next poll shows their change instead of silently overwriting it.
 */
function HubCardDrawer({ card, agents, milestones, act, onClose }: {
  card: HubCard
  agents: HubAgent[]
  milestones: HubMilestone[]
  act: (op: string, payload: Record<string, unknown>) => Promise<void>
  onClose: () => void
}) {
  const [title, setTitle] = useState(card.title)
  const [description, setDescription] = useState(card.description)
  const [claimAs, setClaimAs] = useState('')

  const dirty = title.trim() !== card.title || description !== card.description
  const save = async () => {
    if (!dirty || !title.trim()) return
    await act('card.update', {
      card_id: card.id, expected_version: card.version,
      title: title.trim(), description,
    })
  }
  const claim = async () => {
    const agent = claimAs.trim()
    if (!agent) return
    setClaimAs('')
    await act('card.claim', { card_id: card.id, agent })
  }
  const setMilestone = async (milestoneId: string) => {
    await act('card.milestone', {
      card_id: card.id, expected_version: card.version,
      milestone_id: milestoneId || null,
    })
  }
  const move = async (column: HubCardColumn) => {
    if (column === card.column) return
    await act('card.move', { card_id: card.id, expected_version: card.version, column })
  }

  return (
    <div className="hub-drawer-scrim" onClick={onClose}>
      <aside className="hub-drawer" aria-label={`Card #${card.number}`} onClick={(e) => e.stopPropagation()}>
        <header className="hub-drawer-head">
          <span className="kanban-card-id">#{card.number}</span>
          <button type="button" className="hub-drawer-close" aria-label="Close" onClick={onClose}>×</button>
        </header>
        <label className="hub-drawer-label">Title
          <input className="hub-inline-input" value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label className="hub-drawer-label">Description
          <textarea className="hub-inline-input hub-drawer-desc" rows={5}
            value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        {dirty && <button type="button" className="btn primary" onClick={() => void save()}>Save</button>}
        <label className="hub-drawer-label">Column
          <select className="hub-inline-input" value={card.column}
            onChange={(e) => void move(e.target.value as HubCardColumn)}>
            {LANES.map((lane) => <option key={lane} value={lane}>{STATUS[lane]?.label ?? lane}</option>)}
          </select>
        </label>
        <label className="hub-drawer-label">Milestone
          <select className="hub-inline-input" value={card.milestone_id ?? ''}
            onChange={(e) => void setMilestone(e.target.value)}>
            <option value="">— none —</option>
            {milestones.map((m) => <option key={m.id} value={m.id}>{m.title}</option>)}
          </select>
        </label>
        <div className="hub-drawer-claim">
          <span className="hub-drawer-label">Owner: {card.owner_agent ?? 'unclaimed'}</span>
          <div className="hub-drawer-claim-row">
            <input className="hub-inline-input" list="hub-agent-names" value={claimAs}
              onChange={(e) => setClaimAs(e.target.value)} placeholder="Assign to agent…"
              aria-label="Assign to agent" />
            <datalist id="hub-agent-names">
              {agents.map((a) => <option key={a.id} value={a.name} />)}
            </datalist>
            <button type="button" className="btn" disabled={!claimAs.trim()} onClick={() => void claim()}>Claim</button>
          </div>
        </div>
        {card.paths.length > 0 && (
          <p className="hub-drawer-paths" title={card.paths.join(', ')}>paths: {card.paths.join(', ')}</p>
        )}
      </aside>
    </div>
  )
}

/**
 * The org's projects and boards, with a create form.
 *
 * A new org gets one automatically (the Clerk `organization.created` webhook seeds it),
 * and this is where a member sees that board's id — which their daemon needs verbatim —
 * and adds more. Creating is a write, so a never-subscribed or suspended org gets the
 * server's own refusal text here rather than a generic error.
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

function HubCardChip({ card, owner, milestone, dragging, onOpen, onDragStart, onDragEnd }: {
  card: HubCard
  owner: HubAgent | null
  milestone: HubMilestone | null
  dragging: boolean
  onOpen: () => void
  onDragStart: (event: React.DragEvent) => void
  onDragEnd: () => void
}) {
  const ownerWorking = owner !== null && hubAgentActivity(owner) === 'working'
  return (
    <article className={`kanban-card${dragging ? ' dragging' : ''}`} draggable
      onDragStart={onDragStart} onDragEnd={onDragEnd}
      onClick={onOpen} role="button" tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen() } }}>
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
