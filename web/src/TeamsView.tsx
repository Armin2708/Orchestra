import React, { useEffect, useRef, useState } from 'react'
import { api, Agent, Card, Snapshot, Thread, agentInk, agentWash, initials } from './api'
import { agentActivity, AgentActivity } from './agentActivity'
import { AgentTerminal } from './AgentTerminal'
import { BoardCanvas } from './Board'
import { CanvasPoint, CanvasViewport, canvasSceneOffset, screenToCanvasLocal } from './canvasViewport'
import { ProviderBadge } from './ProviderBadge'
import './teams.css'

// Teams tab: a copy of the Overview board canvas, one panel per designed team.
// Roles are draggable graph nodes wired by reports_to edges; the mastermind agent
// designs and refines teams conversationally; approved designs quick-hire later.
// Spec: docs/superpowers/specs/2026-08-04-teams-tab-design.md (reworked per operator)

type TeamRole = {
  key: string
  title: string
  charter: string
  reports_to: string | null
  max_agents: number
}

type TeamSpec = {
  roles: TeamRole[]
  workflow: Array<{ stage: string; role: string; gate?: string }>
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

const AgentHome = React.lazy(() => import('./AgentHome').then((m) => ({ default: m.AgentHome })))
const MASTERMIND = 'mastermind'

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

function RoleEditor({ team, role, onClose, onChange }: {
  team: Team; role: TeamRole; onClose: () => void; onChange: () => void
}) {
  const [title, setTitle] = useState(role.title)
  const [charter, setCharter] = useState(role.charter)
  const [maxAgents, setMaxAgents] = useState(role.max_agents)
  const [busy, setBusy] = useState(false)
  const patch = async (spec: TeamSpec) => {
    setBusy(true)
    try { await api('PATCH', `/teams/${team.id}`, { spec }); onChange(); onClose() } finally { setBusy(false) }
  }
  const save = () => patch({
    ...team.spec,
    roles: team.spec.roles.map((r) => r.key === role.key
      ? { ...r, title: title.trim() || r.title, charter: charter.trim() || r.charter, max_agents: Math.max(1, maxAgents) }
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
  const remove = () => {
    const doomed = new Set([role.key])
    let grew = true // remove the whole subtree so no role is left reporting to nothing
    while (grew) {
      grew = false
      for (const r of team.spec.roles) {
        if (r.reports_to && doomed.has(r.reports_to) && !doomed.has(r.key)) { doomed.add(r.key); grew = true }
      }
    }
    patch({
      ...team.spec,
      roles: team.spec.roles.filter((r) => !doomed.has(r.key)),
      workflow: team.spec.workflow.filter((w) => !doomed.has(w.role)),
    })
  }
  return (
    <div className="teams-role-editor" onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
      <label>Title<input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus /></label>
      <label>Charter<textarea rows={3} value={charter} onChange={(e) => setCharter(e.target.value)} /></label>
      <label>Max agents<input type="number" min={1} value={maxAgents}
        onChange={(e) => setMaxAgents(Number(e.target.value) || 1)} /></label>
      <div className="teams-editor-actions">
        <button className="teams-primary" disabled={busy} onClick={save}>Save</button>
        <button disabled={busy} onClick={addReport}>+ Report</button>
        {role.reports_to !== null && <button className="teams-danger" disabled={busy} onClick={remove}>Remove</button>}
        <button disabled={busy} onClick={onClose}>×</button>
      </div>
    </div>
  )
}

function TeamGraph({ team, viewport, activityOf, liveByName, onOpenAgent, onChange }: {
  team: Team
  viewport: CanvasViewport
  activityOf: (member: { id: number; status: string }) => AgentActivity
  liveByName: Map<string, Agent>
  onOpenAgent: (a: Agent) => void
  onChange: () => void
}) {
  const wrap = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 800, h: 420 })
  const [boardOrigin, setBoardOrigin] = useState<CanvasPoint>({ x: 0, y: 0 })
  const [pos, setPos] = useState<Record<string, Norm>>(() => loadPos(team.id))
  const [editing, setEditing] = useState<string | null>(null)
  const drag = useRef<{ key: string; moved: boolean; start: Point } | null>(null)

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
    // click: staffed node opens the member console; unstaffed node opens the role editor
    const staffed = team.members.filter((m) => m.team_role === role.key && m.status !== 'gone')
    const live = staffed.length ? liveByName.get(staffed[0].name) : undefined
    if (live) onOpenAgent(live)
    else if (team.status !== 'hired') setEditing(role.key)
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
                  : `${role.title} — unstaffed (0/${role.max_agents})${team.status === 'hired' ? '' : ' — drag to move, click to edit'}`}
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

function TeamPanel({ team, viewport, activityOf, liveByName, onOpenAgent, onChange }: {
  team: Team
  viewport: CanvasViewport
  activityOf: (member: { id: number; status: string }) => AgentActivity
  liveByName: Map<string, Agent>
  onOpenAgent: (a: Agent) => void
  onChange: () => void
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const [refine, setRefine] = useState('')
  const [refining, setRefining] = useState(false)
  const act = async (label: string, method: string, path: string) => {
    setBusy(label)
    try { await api(method, path); onChange() } finally { setBusy(null) }
  }
  const sendRefine = async () => {
    if (!refine.trim()) return
    setRefining(true)
    try { await api('POST', `/teams/${team.id}/refine`, { instruction: refine.trim() }); setRefine(''); onChange() }
    finally { setRefining(false) }
  }
  const workingCount = team.members.filter((m) => m.status !== 'gone' && activityOf(m) === 'working').length
  return (
    <section className={`project network-mode teams-panel teams-panel-${team.status}`}>
      <header className="project-head teams-panel-head">
        <div className="teams-panel-title">
          <h2>{team.name}</h2>
          <span className={`teams-status teams-status-${team.status}`}>{STATUS_LABEL[team.status]}</span>
          {workingCount > 0 && (
            <span className="teams-working-now"><span className="teams-dot teams-dot-working" />{workingCount} working</span>
          )}
          {team.goal && <span className="teams-goal">{team.goal}</span>}
        </div>
        <div className="teams-panel-actions">
          {team.status === 'draft' && (
            <button disabled={busy !== null} onClick={() => act('approve', 'POST', `/teams/${team.id}/approve`)}>
              {busy === 'approve' ? 'Approving…' : 'Approve'}
            </button>
          )}
          {team.status === 'approved' && (
            <button className="teams-primary" disabled={busy !== null} onClick={() => act('hire', 'POST', `/teams/${team.id}/hire`)}>
              {busy === 'hire' ? 'Hiring lead…' : 'Hire team'}
            </button>
          )}
          <button className="teams-danger" disabled={busy !== null} onClick={() => act('archive', 'DELETE', `/teams/${team.id}`)}>
            {busy === 'archive' ? '…' : 'Archive'}
          </button>
        </div>
      </header>
      <div className="net-wrap teams-net-wrap">
        <TeamGraph team={team} viewport={viewport} activityOf={activityOf}
          liveByName={liveByName} onOpenAgent={onOpenAgent} onChange={onChange} />
      </div>
      {team.status !== 'hired' && (
        <div className="teams-refine">
          <input value={refine} placeholder="Tell the mastermind what to change — it updates this design"
            onChange={(e) => setRefine(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void sendRefine() }} />
          <button disabled={refining || !refine.trim()} onClick={() => void sendRefine()}>
            {refining ? 'Sent…' : 'Refine'}
          </button>
        </div>
      )}
    </section>
  )
}

const BLANK_SPEC: TeamSpec = {
  roles: [{ key: 'lead', title: 'Team Lead', charter: 'Own delivery: decompose, delegate, review, report.', reports_to: null, max_agents: 1 }],
  workflow: [{ stage: 'deliver', role: 'lead' }],
}

export function TeamsView({ snaps, onChange }: { snaps: Snapshot[]; onChange: () => void }) {
  const [teams, setTeams] = useState<Team[]>([])
  const [goal, setGoal] = useState('')
  const [designing, setDesigning] = useState(false)
  const [console_, setConsole] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [terminal, setTerminal] = useState<{ agent: Agent; boardId: number } | null>(null)

  const boardId = snaps[0]?.board.id

  const load = React.useCallback(async () => {
    try {
      const results = await Promise.all(snaps.map((s) => api('GET', `/boards/${s.board.id}/teams`)))
      setTeams(results.flatMap((r) => r.teams as Team[]))
      setError(null)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }, [snaps.map((s) => s.board.id).join(',')])

  useEffect(() => { void load() }, [load, snaps])

  const design = async () => {
    if (!goal.trim() || !boardId) return
    setDesigning(true)
    try {
      await api('POST', `/boards/${boardId}/teams/design`, { goal: goal.trim() })
      setGoal('')
      onChange()
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setDesigning(false) }
  }

  const newBlankTeam = async () => {
    if (!boardId) return
    let n = teams.length + 1
    while (teams.some((t) => t.name === `Team ${n}`)) n++
    try {
      await api('POST', `/boards/${boardId}/teams`, { name: `Team ${n}`, spec: BLANK_SPEC })
      await load()
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  const allAgents = snaps.flatMap((s) => s.agents)
  const liveByName = new Map(allAgents.filter((a) => a.status !== 'gone').map((a) => [a.name, a]))
  const liveById = new Map(allAgents.map((a) => [a.id, a]))
  const activityOf = (member: { id: number; status: string }) => agentActivity(liveById.get(member.id) ?? member)

  const chatMastermind = async () => {
    const mm = liveByName.get(MASTERMIND)
    if (mm) { setTerminal({ agent: mm, boardId: mm.board_id ?? boardId }); return }
    if (!boardId) return
    try {
      const r = await api('POST', `/boards/${boardId}/teams/design`, {
        goal: 'Introduce yourself to the operator and stand by to design or refine teams as instructed in chat.',
      })
      setTerminal({ agent: r.agent as Agent, boardId })
      onChange()
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  const teamAgentIds = new Set(teams.flatMap((t) => t.members.map((m) => m.id)))
  const solo = allAgents.filter((a) => a.status !== 'gone' && !teamAgentIds.has(a.id) && a.name !== MASTERMIND)

  const openAgent = (a: Agent) => setTerminal({ agent: a, boardId: a.board_id ?? boardId })

  if (console_) {
    return (
      <div className="teams-view">
        <div className="teams-toolbar">
          <button className="teams-toggle" onClick={() => setConsole(false)}>← Back to teams</button>
        </div>
        <React.Suspense fallback={<div className="os-view-loading" aria-label="Loading agent console"><span /><span /><span /></div>}>
          <AgentHome snaps={snaps} onChange={onChange} />
        </React.Suspense>
      </div>
    )
  }

  return (
    <div className="teams-view teams-canvas-view">
      <div className="teams-toolbar">
        <div className="teams-design">
          <input value={goal}
            placeholder="Describe a goal — the mastermind designs a team, you fine-tune and approve"
            onChange={(e) => setGoal(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void design() }} />
          <button className="teams-primary" disabled={designing || !goal.trim()} onClick={() => void design()}>
            {designing ? 'Briefing…' : 'Design team'}
          </button>
        </div>
        <button className="teams-toggle" onClick={() => void chatMastermind()}>
          <i className="avatar mini" style={{ background: agentWash(MASTERMIND), color: agentInk(MASTERMIND) }}>{initials(MASTERMIND)}</i>
          Chat with mastermind
        </button>
        <button className="teams-toggle" onClick={() => void newBlankTeam()}>+ Blank team</button>
        <button className="teams-toggle" onClick={() => setConsole(true)}>Agent console</button>
      </div>
      {error && <div className="teams-error">{error}</div>}

      {teams.length === 0
        ? <div className="teams-empty">No teams yet. Give the mastermind a goal, chat with it, or start a blank team — design as many as you like and hire them whenever.</div>
        : (
          <BoardCanvas focused={false} storageKey="teams-canvas">
            {(viewport) => teams.map((t) => (
              <TeamPanel key={t.id} team={t} viewport={viewport} activityOf={activityOf}
                liveByName={liveByName} onOpenAgent={openAgent}
                onChange={() => { void load(); onChange() }} />
            ))}
          </BoardCanvas>
        )}

      {solo.length > 0 && (
        <section className="teams-solo">
          <h4>Individual contributors</h4>
          <div className="teams-solo-list">
            {solo.map((a) => {
              const act = agentActivity(a)
              return (
                <button key={a.id} className={`teams-solo-agent teams-solo-${act}`} onClick={() => openAgent(a)}>
                  <span className={`teams-dot teams-dot-${act}`} />
                  {a.name}
                  {act === 'working' && <em className="teams-working-label">working</em>}
                  <em>{a.provider ?? 'claude'}</em>
                </button>
              )
            })}
          </div>
        </section>
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
