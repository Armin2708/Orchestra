import type Database from 'better-sqlite3'

// Teams: operator-approved specs (designed by the mastermind or by hand) that hire as a unit.
// Hiring spawns only the lead; the lead staffs the rest of the spec on demand.
// Spec: docs/superpowers/specs/2026-08-04-teams-tab-design.md

export type TeamRole = {
  key: string
  title: string
  charter: string
  provider?: string
  model?: string
  effort?: string
  reports_to: string | null
  max_agents: number
}

export type WorkflowStage = {
  stage: string
  role: string
  gate?: 'review' | 'none'
}

export type TeamSpec = {
  roles: TeamRole[]
  workflow: WorkflowStage[]
  norms?: string
}

export type TeamStatus = 'draft' | 'approved' | 'hired' | 'archived'

export type TeamRow = {
  id: number
  board_id: number
  name: string
  goal: string
  status: TeamStatus
  lead_agent: string | null
  spec_json: string
  created_at: string
  updated_at: string
}

const ROLE_KEY = /^[a-z0-9][a-z0-9-]{0,39}$/

export function validateTeamSpec(spec: unknown): string[] {
  const errors: string[] = []
  const s = spec as TeamSpec
  if (!s || typeof s !== 'object') return ['spec must be an object']
  if (!Array.isArray(s.roles) || s.roles.length === 0) return ['spec.roles must be a non-empty array']

  const keys = new Set<string>()
  for (const role of s.roles) {
    if (!role || typeof role !== 'object') { errors.push('every role must be an object'); continue }
    if (typeof role.key !== 'string' || !ROLE_KEY.test(role.key)) errors.push(`role key "${String(role.key)}" must match ${ROLE_KEY}`)
    else if (keys.has(role.key)) errors.push(`duplicate role key "${role.key}"`)
    else keys.add(role.key)
    if (typeof role.title !== 'string' || !role.title.trim()) errors.push(`role "${role.key}" needs a title`)
    if (typeof role.charter !== 'string' || !role.charter.trim()) errors.push(`role "${role.key}" needs a charter`)
    if (!Number.isInteger(role.max_agents) || role.max_agents < 1) errors.push(`role "${role.key}" max_agents must be a positive integer`)
  }

  const leads = s.roles.filter((r) => r?.reports_to === null || r?.reports_to === undefined)
  if (leads.length !== 1) errors.push(`exactly one role must have reports_to: null (the lead); found ${leads.length}`)
  for (const role of s.roles) {
    if (role?.reports_to != null && !keys.has(role.reports_to))
      errors.push(`role "${role.key}" reports_to unknown role "${role.reports_to}"`)
    if (role?.reports_to === role?.key) errors.push(`role "${role.key}" cannot report to itself`)
  }

  // reports_to must form a tree rooted at the lead: walk up from each role, flag cycles
  const parent = new Map(s.roles.filter((r) => r?.key).map((r) => [r.key, r.reports_to ?? null]))
  for (const role of s.roles) {
    if (!role?.key) continue
    const seen = new Set<string>([role.key])
    let up = parent.get(role.key) ?? null
    while (up !== null) {
      if (seen.has(up)) { errors.push(`reports_to cycle involving "${role.key}"`); break }
      seen.add(up)
      up = parent.get(up) ?? null
    }
  }

  if (!Array.isArray(s.workflow)) errors.push('spec.workflow must be an array')
  else for (const stage of s.workflow) {
    if (!stage || typeof stage.stage !== 'string' || !stage.stage.trim()) errors.push('every workflow stage needs a stage name')
    if (!stage || typeof stage.role !== 'string' || !keys.has(stage.role))
      errors.push(`workflow stage "${stage?.stage}" references unknown role "${stage?.role}"`)
    if (stage?.gate !== undefined && stage.gate !== 'review' && stage.gate !== 'none')
      errors.push(`workflow stage "${stage.stage}" gate must be 'review' or 'none'`)
  }

  if (s.norms !== undefined && typeof s.norms !== 'string') errors.push('spec.norms must be a string')
  return errors
}

export function leadRole(spec: TeamSpec): TeamRole {
  const lead = spec.roles.find((r) => r.reports_to == null)
  if (!lead) throw new Error('spec has no lead role')
  return lead
}

export function createTeam(
  db: Database.Database,
  boardId: number,
  input: { name: string; goal?: string; spec: TeamSpec },
): TeamRow {
  const errors = validateTeamSpec(input.spec)
  if (errors.length) throw new TeamSpecError(errors)
  const { lastInsertRowid } = db.prepare(`
    INSERT INTO teams (board_id, name, goal, status, spec_json) VALUES (?, ?, ?, 'draft', ?)`)
    .run(boardId, input.name, input.goal ?? '', JSON.stringify(input.spec))
  return getTeam(db, Number(lastInsertRowid))!
}

export class TeamSpecError extends Error {
  errors: string[]
  constructor(errors: string[]) {
    super(`invalid team spec: ${errors.join('; ')}`)
    this.errors = errors
  }
}

export function getTeam(db: Database.Database, id: number): TeamRow | undefined {
  return db.prepare(`SELECT * FROM teams WHERE id=?`).get(id) as TeamRow | undefined
}

export type TeamMember = {
  id: number
  name: string
  status: string
  team_role: string | null
  provider: string
  model: string | null
}

export function teamMembers(db: Database.Database, teamId: number): TeamMember[] {
  return db.prepare(`SELECT id, name, status, team_role, provider, model FROM agents
    WHERE team_id=? AND status != 'gone' ORDER BY id`).all(teamId) as TeamMember[]
}

export function listTeams(db: Database.Database, boardId: number): Array<TeamRow & { spec: TeamSpec; members: TeamMember[] }> {
  const rows = db.prepare(`SELECT * FROM teams WHERE board_id=? AND status != 'archived' ORDER BY id`)
    .all(boardId) as TeamRow[]
  return rows.map((row) => ({ ...row, spec: JSON.parse(row.spec_json) as TeamSpec, members: teamMembers(db, row.id) }))
}

export function updateTeam(
  db: Database.Database,
  id: number,
  patch: { name?: string; goal?: string; spec?: TeamSpec },
): TeamRow {
  const team = getTeam(db, id)
  if (!team) throw new Error('team not found')
  if (team.status === 'hired' || team.status === 'archived')
    throw new Error(`cannot edit a ${team.status} team`)
  if (patch.spec !== undefined) {
    const errors = validateTeamSpec(patch.spec)
    if (errors.length) throw new TeamSpecError(errors)
  }
  db.prepare(`UPDATE teams SET
      name=coalesce(?, name), goal=coalesce(?, goal), spec_json=coalesce(?, spec_json),
      status='draft', updated_at=datetime('now')
    WHERE id=?`)
    .run(patch.name ?? null, patch.goal ?? null, patch.spec ? JSON.stringify(patch.spec) : null, id)
  return getTeam(db, id)!
}

export function approveTeam(db: Database.Database, id: number): TeamRow {
  const team = getTeam(db, id)
  if (!team) throw new Error('team not found')
  if (team.status !== 'draft') throw new Error(`only draft teams can be approved (status: ${team.status})`)
  const errors = validateTeamSpec(JSON.parse(team.spec_json))
  if (errors.length) throw new TeamSpecError(errors)
  db.prepare(`UPDATE teams SET status='approved', updated_at=datetime('now') WHERE id=?`).run(id)
  return getTeam(db, id)!
}

export function archiveTeam(db: Database.Database, id: number): TeamRow {
  const team = getTeam(db, id)
  if (!team) throw new Error('team not found')
  db.prepare(`UPDATE agents SET team_id=NULL, team_role=NULL WHERE team_id=?`).run(id)
  db.prepare(`UPDATE teams SET status='archived', updated_at=datetime('now') WHERE id=?`).run(id)
  return getTeam(db, id)!
}

// The lead's standing orders: goal, org structure, workflow, and how to staff on demand.
export function leadBrief(team: TeamRow, spec: TeamSpec): string {
  const lead = leadRole(spec)
  const chart = spec.roles
    .map((r) => `- ${r.key} (${r.title})${r.reports_to ? ` → reports to ${r.reports_to}` : ' — YOU (lead)'} · up to ${r.max_agents} agent(s)\n  charter: ${r.charter}`)
    .join('\n')
  const flow = spec.workflow
    .map((w, i) => `${i + 1}. ${w.stage} — ${w.role}${w.gate === 'review' ? ' [review gate]' : ''}`)
    .join('\n')
  return [
    `You are the lead ("${lead.title}") of team "${team.name}".`,
    lead.charter,
    team.goal ? `\nTeam goal: ${team.goal}` : '',
    `\nTeam structure (hire members ON DEMAND when a task needs them, never all at once):\n${chart}`,
    spec.workflow.length ? `\nWorkflow — route every task through these stages:\n${flow}` : '',
    spec.norms ? `\nTeam norms:\n${spec.norms}` : '',
    `\nOperating rules:`,
    `- You are the single point of contact: the operator assigns cards to the team or messages you directly.`,
    `- Decompose incoming work, delegate stages to the matching role, review results at every review gate before accepting.`,
    `- Staff roles only when work requires them and release members who are idle.`,
    `- Report progress and completion back to the operator; escalate blockers to the operator, not around the hierarchy.`,
  ].filter(Boolean).join('\n')
}

export type TeamHireResult = { team: TeamRow; agent: Record<string, unknown> }

type MaestroLike = {
  hire: (input: { boardId: number; cwd: string; provider?: string; model?: string; effort?: string }) => Record<string, unknown>
  task: (agentId: number, text: string) => boolean
}

export function hireTeam(
  db: Database.Database,
  id: number,
  maestro: MaestroLike,
  cwd: string,
): TeamHireResult {
  const team = getTeam(db, id)
  if (!team) throw new Error('team not found')
  if (team.status !== 'approved') throw new Error(`only approved teams can be hired (status: ${team.status})`)
  const spec = JSON.parse(team.spec_json) as TeamSpec
  const lead = leadRole(spec)
  const agent = maestro.hire({
    boardId: team.board_id,
    cwd,
    provider: lead.provider,
    model: lead.model,
    effort: lead.effort,
  })
  const agentId = Number(agent.id)
  db.prepare(`UPDATE agents SET team_id=?, team_role=? WHERE id=?`).run(id, lead.key, agentId)
  db.prepare(`UPDATE teams SET status='hired', lead_agent=?, updated_at=datetime('now') WHERE id=?`)
    .run(String(agent.name), id)
  maestro.task(agentId, leadBrief(team, spec))
  return { team: getTeam(db, id)!, agent }
}
