import React, { useEffect, useRef, useState } from 'react'
import { api, Agent, Card, Snapshot, Thread, agentInk, agentWash, initials } from './api'
import { agentActivity, AgentActivity } from './agentActivity'
import { AgentTerminal } from './AgentTerminal'
import { BoardCanvas } from './Board'
import { CanvasPoint, CanvasViewport, canvasSceneOffset, screenToCanvasLocal } from './canvasViewport'
import { hasAgentCapability, orderEffortLevels, providerLaunchBody } from './agentProviderUi'
import { AgentProviderCatalog, osApi } from './osApi'
import { ProviderBadge } from './ProviderBadge'
import './teams.css'

// Teams tab: left rail of designed teams, centre board that is a literal copy of the
// Overview agent board (same canvas, same header, same crew row, same nodes), right
// pane a chat with the mastermind — the only agent allowed to design teams, and allowed
// to do nothing else (src/mastermind-scope.ts). Every mastermind action is also doable by
// hand on the canvas. Spec: docs/superpowers/specs/2026-08-04-teams-tab-design.md

type TeamRole = {
  key: string
  title: string
  charter: string
  reports_to: string | null
  max_agents: number
}

type WorkflowStage = { stage: string; role: string; gate?: 'review' | 'none' }

type TeamSpec = {
  roles: TeamRole[]
  workflow: WorkflowStage[]
  norms?: string
}

type Team = {
  id: number
  board_id: number
  name: string
  goal: string
  status: 'draft' | 'approved' | 'hired' | 'archived'
  lead_agent: string | null
  spec: TeamSpec
  members: Array<{ id: number; name: string; status: string; team_role: string | null; provider?: string }>
}

type Norm = { x: number; y: number }
type Point = { x: number; y: number }

const MASTERMIND = 'mastermind'
const SELECTED_KEY = 'orchestra-teams-selected'
const CHAT_KEY = 'orchestra-teams-chat-open'
const RUNTIME_KEY = 'orchestra-mastermind-runtime'
const RAIL_KEY = 'orchestra-teams-panel'

const STATUS_LABEL: Record<Team['status'], string> = {
  draft: 'draft',
  approved: 'ready to hire',
  hired: 'live',
  archived: 'archived',
}

const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)

function loadPos(teamId: number): Record<string, Norm> {
  try { return JSON.parse(localStorage.getItem(`orchestra-team-net-${teamId}`) ?? '{}') } catch { return {} }
}

// default org-chart layout: lead centered on top, each report level fanned below
function treeLayout(roles: TeamRole[]): Record<string, Norm> {
  const levels: string[][] = []
  let current = roles.filter((r) => r.reports_to == null).map((r) => r.key)
  const seen = new Set<string>()
  while (current.length) {
    levels.push(current)
    current.forEach((k) => seen.add(k))
    current = roles.filter((r) => r.reports_to != null && current.includes(r.reports_to) && !seen.has(r.key))
      .map((r) => r.key)
  }
  const stranded = roles.filter((r) => !seen.has(r.key)).map((r) => r.key)
  if (stranded.length) levels.push(stranded)
  const out: Record<string, Norm> = {}
  levels.forEach((level, depth) => {
    level.forEach((key, i) => {
      out[key] = {
        x: (i + 1) / (level.length + 1),
        y: Math.min(0.86, 0.16 + depth * (levels.length > 2 ? 0.3 : 0.36)),
      }
    })
  })
  return out
}

// every role that would be orphaned by removing this one
function subtree(roles: TeamRole[], key: string): Set<string> {
  const doomed = new Set([key])
  let grew = true
  while (grew) {
    grew = false
    for (const r of roles) {
      if (r.reports_to && doomed.has(r.reports_to) && !doomed.has(r.key)) { doomed.add(r.key); grew = true }
    }
  }
  return doomed
}

function RoleEditor({ team, role, onClose, onChange }: {
  team: Team; role: TeamRole; onClose: () => void; onChange: () => void
}) {
  const [title, setTitle] = useState(role.title)
  const [charter, setCharter] = useState(role.charter)
  const [maxAgents, setMaxAgents] = useState(role.max_agents)
  const [reportsTo, setReportsTo] = useState(role.reports_to)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const isLead = role.reports_to === null
  // re-parenting may not create a cycle: only roles outside this one's subtree qualify
  const doomed = subtree(team.spec.roles, role.key)
  const parents = team.spec.roles.filter((r) => !doomed.has(r.key))

  const patch = async (spec: TeamSpec) => {
    setBusy(true)
    setError(null)
    try { await api('PATCH', `/teams/${team.id}`, { spec }); onChange(); onClose() }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }
  const save = () => patch({
    ...team.spec,
    roles: team.spec.roles.map((r) => r.key === role.key
      ? {
        ...r,
        title: title.trim() || r.title,
        charter: charter.trim() || r.charter,
        max_agents: Math.max(1, maxAgents),
        reports_to: isLead ? null : reportsTo,
      }
      : r),
  })
  const addReport = () => {
    let n = 1
    while (team.spec.roles.some((r) => r.key === `role-${n}`)) n++
    patch({
      ...team.spec,
      roles: [...team.spec.roles, {
        key: `role-${n}`, title: 'New Role', charter: 'Describe what this role owns.',
        reports_to: role.key, max_agents: 1,
      }],
    })
  }
  const remove = () => patch({
    ...team.spec,
    roles: team.spec.roles.filter((r) => !doomed.has(r.key)),
    workflow: team.spec.workflow.filter((w) => !doomed.has(w.role)),
  })

  return (
    <div className="teams-role-editor" onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
      <label>Title<input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus /></label>
      <label>Charter<textarea rows={3} value={charter} onChange={(e) => setCharter(e.target.value)} /></label>
      {!isLead && (
        <label>Reports to
          <select value={reportsTo ?? ''} onChange={(e) => setReportsTo(e.target.value)}>
            {parents.map((r) => <option key={r.key} value={r.key}>{r.title}</option>)}
          </select>
        </label>
      )}
      <label>Max agents<input type="number" min={1} value={maxAgents}
        onChange={(e) => setMaxAgents(Number(e.target.value) || 1)} /></label>
      {error && <em className="teams-editor-error">{error}</em>}
      <div className="teams-editor-actions">
        <button className="teams-primary" disabled={busy} onClick={save}>Save</button>
        <button disabled={busy} onClick={addReport}>+ Report</button>
        {!isLead && <button className="teams-danger" disabled={busy} onClick={remove}>Remove</button>}
        <button disabled={busy} onClick={onClose}>×</button>
      </div>
    </div>
  )
}

function TeamGraph({ team, viewport, activityOf, liveByName, editable, onOpenAgent, onChange }: {
  team: Team
  viewport: CanvasViewport
  activityOf: (member: { id: number; status: string }) => AgentActivity
  liveByName: Map<string, Agent>
  editable: boolean
  onOpenAgent: (a: Agent) => void
  onChange: () => void
}) {
  const wrap = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 800, h: 420 })
  const [boardOrigin, setBoardOrigin] = useState<CanvasPoint>({ x: 0, y: 0 })
  const [pos, setPos] = useState<Record<string, Norm>>(() => loadPos(team.id))
  const [editing, setEditing] = useState<string | null>(null)
  const drag = useRef<{ key: string; moved: boolean; start: Point } | null>(null)

  useEffect(() => { setPos(loadPos(team.id)); setEditing(null) }, [team.id])

  useEffect(() => {
    if (!wrap.current) return
    const network = wrap.current
    const board = network.closest('.board-canvas') as HTMLElement | null
    if (!board) return
    const measure = () => {
      const rect = network.getBoundingClientRect()
      const boardRect = board.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) {
        setSize((c) => Math.abs(c.w - rect.width) < 0.5 && Math.abs(c.h - rect.height) < 0.5
          ? c : { w: rect.width, h: rect.height })
      }
      const next = { x: rect.left - boardRect.left, y: rect.top - boardRect.top }
      setBoardOrigin((c) => Math.abs(c.x - next.x) < 0.5 && Math.abs(c.y - next.y) < 0.5 ? c : next)
    }
    const ro = new ResizeObserver(measure)
    ;[network, board, network.closest('.project')].forEach((el) => el && ro.observe(el))
    window.addEventListener('resize', measure)
    measure()
    return () => { ro.disconnect(); window.removeEventListener('resize', measure) }
  }, [team.id])

  const W = size.w, H = size.h
  const defaults = treeLayout(team.spec.roles)
  const P = (key: string): Norm => pos[key] ?? defaults[key] ?? { x: 0.5, y: 0.5 }

  const startDrag = (key: string) => (e: React.PointerEvent) => {
    e.preventDefault(); e.stopPropagation()
    drag.current = { key, moved: false, start: { x: e.clientX, y: e.clientY } }
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
  }
  const onMove = (e: React.PointerEvent) => {
    if (!drag.current || !wrap.current) return
    if (!drag.current.moved && distance(drag.current.start, { x: e.clientX, y: e.clientY }) < 3) return
    const board = wrap.current.closest('.board-canvas') as HTMLElement | null
    if (!board) return
    const rect = board.getBoundingClientRect()
    const local = screenToCanvasLocal(viewport, { x: e.clientX - rect.left, y: e.clientY - rect.top }, boardOrigin)
    drag.current.moved = true
    const next = { x: Math.min(0.96, Math.max(0.04, local.x / W)), y: Math.min(0.9, Math.max(0.08, local.y / H)) }
    setPos((p) => ({ ...p, [drag.current!.key]: next }))
  }
  const endDrag = (role?: TeamRole) => () => {
    if (!drag.current) return
    const wasDrag = drag.current.moved
    drag.current = null
    setPos((p) => { localStorage.setItem(`orchestra-team-net-${team.id}`, JSON.stringify(p)); return p })
    if (wasDrag || !role) return
    // click: a staffed node opens that agent's console, an empty one opens the role editor
    const staffed = team.members.filter((m) => m.team_role === role.key && m.status !== 'gone')
    const live = staffed.length ? liveByName.get(staffed[0].name) : undefined
    if (live) onOpenAgent(live)
    else if (editable) setEditing(role.key)
  }

  const graphOffset = canvasSceneOffset(viewport, boardOrigin)
  const graphStyle = {
    width: W, height: H, transformOrigin: '0 0',
    transform: `translate3d(${graphOffset.x}px, ${graphOffset.y}px, 0) scale(${viewport.zoom})`,
  }

  return (
    <div className="network teams-network" ref={wrap} onPointerMove={onMove} onPointerUp={endDrag()} onPointerCancel={endDrag()}>
      <div className="network-scene" style={graphStyle}>
        <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H}>
          {team.spec.roles.filter((r) => r.reports_to != null).map((r) => {
            const a = P(r.reports_to!), b = P(r.key)
            return (
              <line key={r.key} className="teams-edge"
                x1={a.x * W} y1={a.y * H + 18} x2={b.x * W} y2={b.y * H - 18}
                vectorEffect="non-scaling-stroke" />
            )
          })}
        </svg>

        {team.spec.roles.map((role) => {
          const p = P(role.key)
          const staffed = team.members.filter((m) => m.team_role === role.key && m.status !== 'gone')
          const first = staffed[0]
          const act: AgentActivity | null = first ? activityOf(first) : null
          const display = first ? first.name : role.title
          const isLead = role.reports_to == null
          return (
            <div key={role.key} className="net-node" style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%` }}>
              <span
                className={first
                  ? `net-avatar round hired ${act === 'working' ? 'working' : ''}`
                  : 'net-avatar round teams-ghost'}
                style={first ? { background: agentWash(first.name), color: agentInk(first.name) } : undefined}
                title={first
                  ? `${display} — ${role.title}${act === 'working' ? ' · working now' : ''} — drag to move, click to open console`
                  : `${role.title} — unstaffed (0/${role.max_agents})${editable ? ' — drag to move, click to edit' : ''}`}
                onPointerDown={startDrag(role.key)} onPointerUp={endDrag(role)}>
                {initials(display)}
                {first && <i className={`presence ${liveByName.get(first.name)?.status ?? first.status}`} />}
                {staffed.length > 1 && <i className="net-sub more">{staffed.length}</i>}
              </span>
              <span className="net-name">
                {first ? first.name : role.title}
                {first && <ProviderBadge provider={first.provider} compact />}
              </span>
              <span className="teams-node-role">{isLead ? '★ ' : ''}{first ? role.title : `0/${role.max_agents} staffed`}</span>
              {editing === role.key && (
                <RoleEditor team={team} role={role} onClose={() => setEditing(null)} onChange={onChange} />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// the workflow the team routes every task through — editable by hand, same data the
// mastermind writes, same data the hired lead is briefed with
function WorkflowStrip({ team, editable, onChange }: { team: Team; editable: boolean; onChange: () => void }) {
  const [busy, setBusy] = useState(false)
  const patch = async (workflow: WorkflowStage[]) => {
    setBusy(true)
    try { await api('PATCH', `/teams/${team.id}`, { spec: { ...team.spec, workflow } }); onChange() }
    finally { setBusy(false) }
  }
  const stages = team.spec.workflow
  const roleTitle = (key: string) => team.spec.roles.find((r) => r.key === key)?.title ?? key
  return (
    <div className="teams-flow">
      <span className="teams-flow-label">Workflow</span>
      {stages.length === 0 && <em className="teams-flow-empty">no stages yet</em>}
      {stages.map((stage, i) => (
        <span key={`${stage.stage}-${i}`} className={`teams-stage ${stage.gate === 'review' ? 'gated' : ''}`}>
          {editable ? (
            <input className="teams-stage-name" value={stage.stage} disabled={busy}
              onChange={(e) => patch(stages.map((s, j) => j === i ? { ...s, stage: e.target.value } : s))} />
          ) : stage.stage}
          {editable ? (
            <select value={stage.role} disabled={busy}
              onChange={(e) => patch(stages.map((s, j) => j === i ? { ...s, role: e.target.value } : s))}>
              {team.spec.roles.map((r) => <option key={r.key} value={r.key}>{r.title}</option>)}
            </select>
          ) : <em>{roleTitle(stage.role)}</em>}
          {editable && (
            <>
              <button className="teams-stage-gate" title="Toggle review gate" disabled={busy}
                onClick={() => patch(stages.map((s, j) => j === i ? { ...s, gate: s.gate === 'review' ? 'none' : 'review' } : s))}>
                {stage.gate === 'review' ? '⚑ review' : 'no gate'}
              </button>
              <button className="teams-stage-x" title="Remove stage" disabled={busy}
                onClick={() => patch(stages.filter((_, j) => j !== i))}>×</button>
            </>
          )}
          {!editable && stage.gate === 'review' && <b>⚑</b>}
        </span>
      ))}
      {editable && team.spec.roles.length > 0 && (
        <button className="teams-stage-add" disabled={busy}
          onClick={() => patch([...stages, { stage: `stage ${stages.length + 1}`, role: team.spec.roles[0].key, gate: 'none' }])}>
          + Stage
        </button>
      )}
    </div>
  )
}

// The Overview board's crew chip, rendered here from the same classes so the two rows are
// visually identical. (Board.tsx keeps its copy module-private; when that export lands this
// can be swapped for the shared component with no markup change.)
function TeamCrewSlot({ a, onOpen, onChange }: { a: Agent; onOpen: () => void; onChange: () => void }) {
  return (
    <span className="crew-slot">
      <span className={`avatar clickable ${a.status} hired`}
        title={`${a.name} · ${a.status} · open console`}
        role="button" tabIndex={0} aria-label={`Open ${a.name}'s console`}
        style={{ background: agentWash(a.name), color: agentInk(a.name) }}
        onClick={onOpen}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen() } }}>
        {initials(a.name)}
        <i className="presence" />
      </span>
      <ProviderBadge provider={a.provider} compact />
      <button className="icon-x fire" title={`Fire ${a.name}`} aria-label={`Fire ${a.name}`}
        onClick={async () => {
          if (!window.confirm(`Fire ${a.name}? Its running session is killed.`)) return
          await api('POST', `/agents/${a.id}/fire`); onChange()
        }}>×</button>
    </span>
  )
}

// The board itself: same canvas, header, crew row, ticket rail and node graph as Overview.
function TeamBoard({ team, snap, providers, activityOf, onChange, onOpenAgent }: {
  team: Team
  snap: Snapshot | undefined
  providers: AgentProviderCatalog[]
  activityOf: (member: { id: number; status: string }) => AgentActivity
  onChange: () => void
  onOpenAgent: (a: Agent) => void
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const editable = team.status === 'draft' || team.status === 'approved'

  const act = async (label: string, method: string, path: string, body?: unknown) => {
    setBusy(label)
    setError(null)
    try { await api(method, path, body); onChange() }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(null) }
  }

  const agents = snap?.agents ?? []
  const liveByName = new Map(agents.filter((a) => a.status !== 'gone').map((a) => [a.name, a]))
  const crew = team.members
    .map((m) => agents.find((a) => a.id === m.id))
    .filter((a): a is Agent => !!a && a.status !== 'gone')
  const unstaffed = team.spec.roles.reduce(
    (n, r) => n + Math.max(0, r.max_agents - team.members.filter((m) => m.team_role === r.key && m.status !== 'gone').length), 0)

  const addRole = () => {
    let n = 1
    while (team.spec.roles.some((r) => r.key === `role-${n}`)) n++
    const lead = team.spec.roles.find((r) => r.reports_to == null)
    void act('role', 'PATCH', `/teams/${team.id}`, {
      spec: {
        ...team.spec,
        roles: [...team.spec.roles, {
          key: `role-${n}`, title: 'New Role', charter: 'Describe what this role owns.',
          reports_to: lead ? lead.key : null, max_agents: 1,
        }],
      },
    })
  }

  return (
    <>
      <WorkflowStrip team={team} editable={editable} onChange={onChange} />
      <BoardCanvas focused storageKey={`teams-${team.id}`}>
        {(viewport) => (
          <section className="project network-mode">
            <header className="project-head">
              <div className="project-head-col">
                <div className="project-head-right">
                  <div className="teams-hire-bar">
                    {team.status === 'draft' && (
                      <button className="hire-btn" disabled={busy !== null}
                        title="Lock this design so it can be hired"
                        onClick={() => act('approve', 'POST', `/teams/${team.id}/approve`)}>
                        {busy === 'approve' ? '…' : '✓ Approve'}
                      </button>
                    )}
                    {team.status === 'approved' && (
                      <button className="hire-btn primary" disabled={busy !== null}
                        title="Hire the lead — it staffs the rest of the team on demand"
                        onClick={() => act('hire', 'POST', `/teams/${team.id}/hire`)}>
                        {busy === 'hire' ? 'Hiring…' : '+ Hire team'}
                      </button>
                    )}
                    {editable && (
                      <button className="hire-btn" disabled={busy !== null} title="Add a role to this team"
                        onClick={addRole}>+ Role</button>
                    )}
                    {team.status === 'hired' && unstaffed > 0 && (
                      <span className="teams-hire-hint" title="The lead hires these when a task needs them">
                        {unstaffed} seat{unstaffed === 1 ? '' : 's'} the lead can staff
                      </span>
                    )}
                  </div>
                  <div className="project-crew">
                    {crew.map((a) => (
                      <TeamCrewSlot key={a.id} a={a} onChange={onChange} onOpen={() => onOpenAgent(a)} />
                    ))}
                    {crew.length === 0 && (
                      <span className="ask-none">
                        {team.status === 'hired' ? 'no team agents online' : 'not hired yet — approve, then hire the lead'}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </header>

            <div className="net-wrap">
              <TeamGraph team={team} viewport={viewport} activityOf={activityOf} liveByName={liveByName}
                editable={editable} onOpenAgent={onOpenAgent} onChange={onChange} />
            </div>
          </section>
        )}
      </BoardCanvas>
      {error && <div className="teams-error">{error}</div>}
    </>
  )
}

type Runtime = { provider: string; model: string; effort: string }
const loadRuntime = (): Runtime => {
  try { return { provider: '', model: '', effort: '', ...JSON.parse(localStorage.getItem(RUNTIME_KEY) ?? '{}') } }
  catch { return { provider: '', model: '', effort: '' } }
}

// The mastermind chat: scoped to team design by the server (src/mastermind-scope.ts).
// The operator picks which provider/model/effort it thinks on.
function MastermindPane({ boardId, snap, team, providers, onChange, onCollapse }: {
  boardId: number | undefined
  snap: Snapshot | undefined
  team: Team | null
  providers: AgentProviderCatalog[]
  onChange: () => void
  onCollapse: () => void
}) {
  const [runtime, setRuntime] = useState<Runtime>(loadRuntime)
  const [tuning, setTuning] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [scope, setScope] = useState<string>('')
  const focused = useRef<number | null>(null)

  const agent = (snap?.agents ?? []).find((a) => a.name === MASTERMIND && a.status !== 'gone') ?? null

  useEffect(() => {
    if (!boardId) return
    api('GET', `/boards/${boardId}/mastermind`).then((r) => {
      setScope(r.scope ?? '')
      if (r.agent) {
        setRuntime((current) => current.provider || current.model || current.effort ? current : {
          provider: r.agent.provider ?? '', model: r.agent.model ?? '', effort: r.agent.effort ?? '',
        })
      }
    }).catch(() => {})
  }, [boardId])

  // the operator selected a team: tell the mastermind what "this team" means now, once
  useEffect(() => {
    if (!team || !agent) return
    if (focused.current === team.id) return
    focused.current = team.id
    api('POST', `/teams/${team.id}/focus`).catch(() => {})
  }, [team?.id, agent?.id])

  const available = providers.filter((p) => p.available)
  const selected = providers.find((p) => p.id === runtime.provider)
  const models = (selected?.models ?? []).filter((m) => m.value.toLowerCase() !== 'default')
  const chosenModel = models.find((m) => m.value === runtime.model)
  const efforts = orderEffortLevels([...new Set(
    (chosenModel ? [chosenModel] : models).flatMap((m) => m.supportedEffortLevels ?? []),
  )])
  const canModel = !!selected?.available && hasAgentCapability(selected.capabilities, 'model', selected.id) && models.length > 0
  const canEffort = !!selected?.available && hasAgentCapability(selected.capabilities, 'effort', selected.id) && efforts.length > 0

  const persist = (next: Runtime) => {
    setRuntime(next)
    try { localStorage.setItem(RUNTIME_KEY, JSON.stringify(next)) } catch { /* optional preference */ }
  }

  // the mastermind is deliberately absent from the Overview board, so this is the only
  // place it can be stopped — never remove it without giving the operator another one
  const stop = async () => {
    if (!agent) return
    if (!window.confirm('Stop the mastermind? Its chat history is lost; you can start it again any time.')) return
    setBusy(true)
    setError(null)
    try { await api('POST', `/agents/${agent.id}/fire`); focused.current = null; onChange() }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }

  const start = async () => {
    if (!boardId) return
    setBusy(true)
    setError(null)
    try {
      const body = providerLaunchBody(runtime.provider, runtime.model, runtime.effort, null)
      await api('POST', `/boards/${boardId}/mastermind`, body)
      focused.current = null
      setTuning(false)
      onChange()
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }

  return (
    <aside className="teams-chat">
      <header className="teams-chat-head">
        <i className="avatar mini" style={{ background: agentWash(MASTERMIND), color: agentInk(MASTERMIND) }}>
          {initials(MASTERMIND)}
        </i>
        <div className="teams-chat-title">
          <strong>Mastermind</strong>
          <em>{team ? `designing “${team.name}”` : 'team design only'}</em>
        </div>
        <button className="teams-chat-tune" title="Provider, model and effort" onClick={() => setTuning((v) => !v)}>
          {runtime.model || runtime.provider || 'runtime'} ⌄
        </button>
        {agent ? (
          <button className="teams-chat-stop" title="Stop the mastermind — the Teams tab is its only control"
            aria-label="Stop the mastermind" disabled={busy} onClick={() => void stop()}>×</button>
        ) : (
          <button className="teams-chat-start" title="Start the mastermind on the selected runtime"
            disabled={busy} onClick={() => void start()}>{busy ? '…' : 'Start'}</button>
        )}
        <button className="teams-chat-x" title="Hide the mastermind" onClick={onCollapse}>›</button>
      </header>

      {tuning && (
        <div className="teams-runtime">
          {available.length > 0 && (
            <div className="hire-seg" role="group" aria-label="Mastermind provider">
              {available.map((p) => (
                <button key={p.id} type="button"
                  className={`hire-seg-btn${runtime.provider === p.id ? ' selected' : ''}`}
                  aria-pressed={runtime.provider === p.id}
                  onClick={() => persist({
                    provider: runtime.provider === p.id ? '' : p.id, model: '', effort: '',
                  })}>
                  {p.name}
                </button>
              ))}
            </div>
          )}
          {canModel && (
            <label>Model
              <select value={runtime.model} onChange={(e) => persist({ ...runtime, model: e.target.value, effort: '' })}>
                <option value="">provider default</option>
                {models.map((m) => <option key={m.value} value={m.value}>{m.displayName || m.value}</option>)}
              </select>
            </label>
          )}
          {canEffort && (
            <label>Effort
              <select value={runtime.effort} onChange={(e) => persist({ ...runtime, effort: e.target.value })}>
                <option value="">default</option>
                {efforts.map((level) => <option key={level} value={level}>{level}</option>)}
              </select>
            </label>
          )}
          <button className="teams-primary" disabled={busy} onClick={() => void start()}>
            {busy ? '…' : agent ? 'Apply — restarts it' : 'Start'}
          </button>
          <p className="teams-scope-note">{scope || 'Scoped to team design: it cannot edit code, hire, or change itself.'}</p>
        </div>
      )}

      {error && <div className="teams-error">{error}</div>}

      {agent && snap ? (
        <div className="teams-chat-body">
          <AgentTerminal embedded agent={agent} boardId={snap.board.id}
            threads={(snap.threads ?? []) as Thread[]} cards={(snap.cards ?? []) as Card[]}
            onClose={() => {}} onChange={onChange} />
        </div>
      ) : null}
    </aside>
  )
}

const BLANK_SPEC: TeamSpec = {
  roles: [{ key: 'lead', title: 'Team Lead', charter: 'Own delivery: decompose, delegate, review, report.', reports_to: null, max_agents: 1 }],
  workflow: [{ stage: 'deliver', role: 'lead' }],
}

export function TeamsView({ snaps, onChange }: { snaps: Snapshot[]; onChange: () => void }) {
  const [teams, setTeams] = useState<Team[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(() => {
    const saved = Number(localStorage.getItem(SELECTED_KEY))
    return Number.isFinite(saved) && saved > 0 ? saved : null
  })
  const [chatOpen, setChatOpen] = useState(() => localStorage.getItem(CHAT_KEY) !== 'closed')
  const [railOpen, setRailOpen] = useState(() => localStorage.getItem(RAIL_KEY) !== 'closed')
  const [error, setError] = useState<string | null>(null)
  const [providers, setProviders] = useState<AgentProviderCatalog[]>([])
  const [terminal, setTerminal] = useState<{ agent: Agent; boardId: number } | null>(null)
  const [renaming, setRenaming] = useState(false)

  const boardId = snaps[0]?.board.id

  useEffect(() => {
    let live = true
    osApi.listAgentProviders().then((catalog) => { if (live) setProviders(catalog) }).catch(() => {})
    return () => { live = false }
  }, [])

  const load = React.useCallback(async () => {
    try {
      const results = await Promise.all(snaps.map((s) => api('GET', `/boards/${s.board.id}/teams`)))
      setTeams(results.flatMap((r) => r.teams as Team[]))
      setError(null)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }, [snaps.map((s) => s.board.id).join(',')])

  useEffect(() => { void load() }, [load, snaps])

  const selected = teams.find((t) => t.id === selectedId) ?? teams[0] ?? null
  useEffect(() => {
    if (selected) localStorage.setItem(SELECTED_KEY, String(selected.id))
  }, [selected?.id])

  const select = (id: number) => { setSelectedId(id); setRenaming(false) }
  const toggleChat = () => setChatOpen((open) => {
    localStorage.setItem(CHAT_KEY, open ? 'closed' : 'open')
    return !open
  })
  const toggleRail = () => setRailOpen((open) => {
    localStorage.setItem(RAIL_KEY, open ? 'closed' : 'open')
    return !open
  })

  const allAgents = snaps.flatMap((s) => s.agents)
  const liveById = new Map(allAgents.map((a) => [a.id, a]))
  const activityOf = (member: { id: number; status: string }) => agentActivity(liveById.get(member.id) ?? member)
  const selectedSnap = snaps.find((s) => s.board.id === selected?.board_id) ?? snaps[0]

  const refresh = () => { void load(); onChange() }

  const newBlankTeam = async () => {
    if (!boardId) return
    let n = teams.length + 1
    while (teams.some((t) => t.name === `Team ${n}`)) n++
    try {
      const created = await api('POST', `/boards/${boardId}/teams`, { name: `Team ${n}`, spec: BLANK_SPEC })
      await load()
      if (created?.team?.id) { setSelectedId(created.team.id); setRenaming(true); setRailOpen(true) }
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  const rename = async (name: string, goalText: string) => {
    if (!selected) return
    setRenaming(false)
    if (name === selected.name && goalText === selected.goal) return
    try { await api('PATCH', `/teams/${selected.id}`, { name, goal: goalText }); refresh() }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  const archive = async () => {
    if (!selected) return
    try { await api('DELETE', `/teams/${selected.id}`); setSelectedId(null); refresh() }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  const openAgent = (a: Agent) => setTerminal({ agent: a, boardId: a.board_id ?? boardId ?? 0 })

  return (
    <div className={`teams-view teams-workspace ${chatOpen ? '' : 'chat-closed'}`}>
      <div className={`teams-panel ${railOpen ? 'open' : 'closed'}`}>
        <button type="button" className="teams-panel-toggle" aria-expanded={railOpen}
          title={railOpen ? 'Close teams' : 'Open teams'} onClick={toggleRail}>
          <span className="task-panel-bars" aria-hidden="true"><i /><i /><i /></span>
          <span className="task-panel-label">Teams</span>
          <span className="task-panel-count">{teams.length}</span>
        </button>
        {railOpen && (
          <button type="button" className="teams-panel-new" title="Create a team"
            onClick={() => void newBlankTeam()}>+ New</button>
        )}
        {railOpen && (
          <div className="teams-panel-body">
            <ul className="teams-list">
              {teams.map((t) => {
                const live = t.members.filter((m) => m.status !== 'gone')
                const working = live.filter((m) => activityOf(m) === 'working').length
                return (
                  <li key={t.id}>
                    <button className={`teams-list-item${selected?.id === t.id ? ' selected' : ''}`} onClick={() => select(t.id)}>
                      <span className="teams-list-name">{t.name}</span>
                      <span className={`teams-status teams-status-${t.status}`}>{STATUS_LABEL[t.status]}</span>
                      <span className="teams-list-meta">
                        {t.spec.roles.length} role{t.spec.roles.length === 1 ? '' : 's'}
                        {live.length > 0 && ` · ${live.length} hired`}
                        {working > 0 && <em className="teams-working-label">{working} working</em>}
                      </span>
                    </button>
                  </li>
                )
              })}
              {teams.length === 0 && <li className="teams-list-empty">No teams yet — hit + New, or ask the mastermind for one.</li>}
            </ul>
          </div>
        )}
      </div>

      <div className="teams-stage-pane">
        {selected ? (
          <>
            <div className="teams-stage-head">
              {renaming ? (
                <TeamIdentityEditor team={selected} onDone={rename} onCancel={() => setRenaming(false)} />
              ) : (
                <>
                  <h2 onDoubleClick={() => setRenaming(true)} title="Double-click to rename">{selected.name}</h2>
                  <span className={`teams-status teams-status-${selected.status}`}>{STATUS_LABEL[selected.status]}</span>
                  {selected.goal && <span className="teams-goal">{selected.goal}</span>}
                  <button className="teams-stage-edit" onClick={() => setRenaming(true)}>Edit</button>
                  <button className="teams-danger teams-stage-edit" onClick={() => void archive()}>Archive</button>
                </>
              )}
            </div>
            <TeamBoard team={selected} snap={selectedSnap} providers={providers} activityOf={activityOf}
              onChange={refresh} onOpenAgent={openAgent} />
          </>
        ) : (
          <div className="teams-empty">
            No team selected. Hit + New in the Teams panel and build the tree yourself — add roles, wire who
            reports to whom, then approve and hire — or ask the mastermind on the right to draft one for you.
          </div>
        )}
        {error && <div className="teams-error">{error}</div>}
      </div>

      {chatOpen ? (
        <MastermindPane boardId={boardId} snap={selectedSnap} team={selected} providers={providers}
          onChange={refresh} onCollapse={toggleChat} />
      ) : (
        <button className="teams-chat-pill" title="Chat with the mastermind" onClick={toggleChat}>
          <i className="avatar mini" style={{ background: agentWash(MASTERMIND), color: agentInk(MASTERMIND) }}>
            {initials(MASTERMIND)}
          </i>
          Mastermind
        </button>
      )}

      {terminal && <AgentTerminal
        agent={snaps.find((s) => s.board.id === terminal.boardId)?.agents.find((a) => a.id === terminal.agent.id) ?? terminal.agent}
        boardId={terminal.boardId}
        threads={(snaps.find((s) => s.board.id === terminal.boardId)?.threads ?? []) as Thread[]}
        cards={(snaps.find((s) => s.board.id === terminal.boardId)?.cards ?? []) as Card[]}
        onClose={() => setTerminal(null)} onChange={onChange} />}
    </div>
  )
}

function TeamIdentityEditor({ team, onDone, onCancel }: {
  team: Team; onDone: (name: string, goal: string) => void; onCancel: () => void
}) {
  const [name, setName] = useState(team.name)
  const [goal, setGoal] = useState(team.goal)
  return (
    <div className="teams-identity">
      <input autoFocus value={name} placeholder="Team name" onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') onDone(name.trim() || team.name, goal.trim()); if (e.key === 'Escape') onCancel() }} />
      <input value={goal} placeholder="What this team is for" onChange={(e) => setGoal(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') onDone(name.trim() || team.name, goal.trim()); if (e.key === 'Escape') onCancel() }} />
      <button className="teams-primary" onClick={() => onDone(name.trim() || team.name, goal.trim())}>Save</button>
      <button onClick={onCancel}>×</button>
    </div>
  )
}
