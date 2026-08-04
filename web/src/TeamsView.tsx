import React from 'react'
import { api, Snapshot } from './api'
import { agentActivity, AgentActivity } from './agentActivity'
import './teams.css'

// Teams tab: mastermind-designed org structures hired as a unit (lead-first).
// Spec: docs/superpowers/specs/2026-08-04-teams-tab-design.md

type TeamRole = {
  key: string
  title: string
  charter: string
  reports_to: string | null
  max_agents: number
}

type Team = {
  id: number
  board_id: number
  name: string
  goal: string
  status: 'draft' | 'approved' | 'hired' | 'archived'
  lead_agent: string | null
  spec: {
    roles: TeamRole[]
    workflow: Array<{ stage: string; role: string; gate?: string }>
    norms?: string
  }
  members: Array<{ id: number; name: string; status: string; team_role: string | null }>
}

const AgentHome = React.lazy(() => import('./AgentHome').then((m) => ({ default: m.AgentHome })))

const STATUS_LABEL: Record<Team['status'], string> = {
  draft: 'Draft — awaiting approval',
  approved: 'Approved — ready to hire',
  hired: 'Hired — live',
  archived: 'Archived',
}

function RoleTree({ roles, members, parent, activityOf }: {
  roles: TeamRole[]; members: Team['members']; parent: string | null
  activityOf: (member: { id: number; status: string }) => AgentActivity
}) {
  const level = roles.filter((r) => (r.reports_to ?? null) === parent)
  if (!level.length) return null
  return (
    <ul className="teams-role-tree">
      {level.map((role) => {
        const live = members.filter((m) => m.team_role === role.key)
        return (
          <li key={role.key}>
            <div className="teams-role-node">
              <span className="teams-role-title">{role.title}</span>
              <span className="teams-role-key">{role.key}</span>
              <span className={live.length ? 'teams-role-live on' : 'teams-role-live'}>
                {live.length ? live.map((m) => {
                  const act = activityOf(m)
                  return (
                    <span key={m.id} className={`teams-member teams-member-${act}`}>
                      <span className={`teams-dot teams-dot-${act}`} />
                      {m.name}
                      {act === 'working' && <em className="teams-working-label">working</em>}
                    </span>
                  )
                }) : `0/${role.max_agents} staffed`}
              </span>
            </div>
            <div className="teams-role-charter">{role.charter}</div>
            <RoleTree roles={roles} members={members} parent={role.key} activityOf={activityOf} />
          </li>
        )
      })}
    </ul>
  )
}

function TeamCard({ team, onChange, activityOf }: {
  team: Team; onChange: () => void
  activityOf: (member: { id: number; status: string }) => AgentActivity
}) {
  const [open, setOpen] = React.useState(false)
  const [busy, setBusy] = React.useState<string | null>(null)
  const act = async (label: string, method: string, path: string) => {
    setBusy(label)
    try { await api(method, path); onChange() } finally { setBusy(null) }
  }
  const liveCount = team.members.filter((m) => m.status !== 'gone').length
  const workingCount = team.members.filter((m) => activityOf(m) === 'working').length
  return (
    <article className={`teams-card teams-card-${team.status}${workingCount ? ' teams-card-busy' : ''}`}>
      <header className="teams-card-head" onClick={() => setOpen(!open)}>
        <div>
          <h3>{team.name}</h3>
          {team.goal && <p className="teams-goal">{team.goal}</p>}
        </div>
        <div className="teams-card-meta">
          {workingCount > 0 && (
            <span className="teams-working-now"><span className="teams-dot teams-dot-working" />{workingCount} working</span>
          )}
          <span className={`teams-status teams-status-${team.status}`}>{STATUS_LABEL[team.status]}</span>
          <span className="teams-counts">{team.spec.roles.length} roles · {liveCount} live{team.lead_agent ? ` · lead ${team.lead_agent}` : ''}</span>
        </div>
      </header>
      {open && (
        <div className="teams-card-body">
          <RoleTree roles={team.spec.roles} members={team.members} parent={null} activityOf={activityOf} />
          {team.spec.workflow.length > 0 && (
            <div className="teams-workflow">
              {team.spec.workflow.map((w, i) => (
                <span key={i} className={w.gate === 'review' ? 'teams-stage gated' : 'teams-stage'}>
                  {w.stage} <em>{w.role}</em>
                </span>
              ))}
            </div>
          )}
          {team.spec.norms && <p className="teams-norms">{team.spec.norms}</p>}
        </div>
      )}
      <footer className="teams-card-actions">
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
          {busy === 'archive' ? 'Archiving…' : 'Archive'}
        </button>
      </footer>
    </article>
  )
}

export function TeamsView({ snaps, onChange }: { snaps: Snapshot[]; onChange: () => void }) {
  const [teams, setTeams] = React.useState<Team[]>([])
  const [goal, setGoal] = React.useState('')
  const [designing, setDesigning] = React.useState(false)
  const [console_, setConsole] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const load = React.useCallback(async () => {
    try {
      const results = await Promise.all(snaps.map((s) => api('GET', `/boards/${s.board.id}/teams`)))
      setTeams(results.flatMap((r) => r.teams as Team[]))
      setError(null)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }, [snaps.map((s) => s.board.id).join(',')])

  React.useEffect(() => { void load() }, [load, snaps])

  const design = async () => {
    if (!goal.trim() || !snaps.length) return
    setDesigning(true)
    try {
      await api('POST', `/boards/${snaps[0].board.id}/teams/design`, { goal: goal.trim() })
      setGoal('')
      onChange()
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setDesigning(false) }
  }

  const teamAgentIds = new Set(teams.flatMap((t) => t.members.map((m) => m.id)))
  const solo = snaps.flatMap((s) => s.agents).filter((a) => a.status !== 'gone' && !teamAgentIds.has(a.id))
  // Board snapshot rows carry last_seen; team member rows don't. Prefer the live row.
  const liveById = new Map(snaps.flatMap((s) => s.agents).map((a) => [a.id, a]))
  const activityOf = (member: { id: number; status: string }) => agentActivity(liveById.get(member.id) ?? member)

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
    <div className="teams-view">
      <div className="teams-toolbar">
        <div className="teams-design">
          <input
            value={goal}
            placeholder="Describe a goal — the mastermind designs the team, you approve it"
            onChange={(e) => setGoal(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void design() }}
          />
          <button className="teams-primary" disabled={designing || !goal.trim()} onClick={() => void design()}>
            {designing ? 'Briefing mastermind…' : 'Design team'}
          </button>
        </div>
        <button className="teams-toggle" onClick={() => setConsole(true)}>Agent console</button>
      </div>
      {error && <div className="teams-error">{error}</div>}

      {teams.length === 0
        ? <div className="teams-empty">No teams yet. Give the mastermind a goal above — it drafts a team structure with roles, hierarchy, and workflow for you to approve.</div>
        : <div className="teams-grid">{teams.map((t) => <TeamCard key={t.id} team={t} activityOf={activityOf} onChange={() => { void load(); onChange() }} />)}</div>}

      {solo.length > 0 && (
        <section className="teams-solo">
          <h4>Individual contributors</h4>
          <div className="teams-solo-list">
            {solo.map((a) => {
              const act = agentActivity(a)
              return (
                <button key={a.id} className={`teams-solo-agent teams-solo-${act}`} onClick={() => setConsole(true)}>
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
    </div>
  )
}
