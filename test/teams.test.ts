import { expect, it } from 'vitest'
import { openDb } from '../src/db.js'
import { buildServer, Bus, ConductorLike } from '../src/server.js'
import { validateTeamSpec, leadBrief, type TeamSpec, type TeamRow } from '../src/teams.js'

const spec = (over: Partial<TeamSpec> = {}): TeamSpec => ({
  roles: [
    { key: 'lead', title: 'Engineering Lead', charter: 'Own delivery end to end.', reports_to: null, max_agents: 1 },
    { key: 'eng', title: 'Staff Engineer', charter: 'Implement scoped tasks.', reports_to: 'lead', max_agents: 2 },
    { key: 'reviewer', title: 'Code Reviewer', charter: 'Review every change.', reports_to: 'lead', max_agents: 1 },
  ],
  workflow: [
    { stage: 'design', role: 'lead' },
    { stage: 'implement', role: 'eng' },
    { stage: 'review', role: 'reviewer', gate: 'review' },
  ],
  norms: 'Small diffs. Tests with every change.',
  ...over,
})

it('validates team specs: lead, cycles, references', () => {
  expect(validateTeamSpec(spec())).toEqual([])
  expect(validateTeamSpec({ roles: [], workflow: [] })).toContain('spec.roles must be a non-empty array')

  const noLead = spec({ roles: spec().roles.map((r) => ({ ...r, reports_to: r.reports_to ?? 'eng' })) })
  expect(validateTeamSpec(noLead).join()).toMatch(/exactly one role/)

  const cycle = spec({
    roles: [
      { key: 'lead', title: 'L', charter: 'c', reports_to: null, max_agents: 1 },
      { key: 'a', title: 'A', charter: 'c', reports_to: 'b', max_agents: 1 },
      { key: 'b', title: 'B', charter: 'c', reports_to: 'a', max_agents: 1 },
    ],
  })
  expect(validateTeamSpec(cycle).join()).toMatch(/cycle/)

  const badRef = spec({ workflow: [{ stage: 'qa', role: 'ghost' }] })
  expect(validateTeamSpec(badRef).join()).toMatch(/unknown role "ghost"/)

  const dupe = spec()
  dupe.roles = [...dupe.roles, { ...dupe.roles[1] }]
  expect(validateTeamSpec(dupe).join()).toMatch(/duplicate role key/)
})

it('lead brief carries goal, org chart, workflow, and norms', () => {
  const team = { id: 1, name: 'Core Platform', goal: 'Ship the sync engine' } as unknown as TeamRow
  const brief = leadBrief(team, spec())
  expect(brief).toContain('Engineering Lead')
  expect(brief).toContain('Ship the sync engine')
  expect(brief).toContain('reports to lead')
  expect(brief).toContain('[review gate]')
  expect(brief).toContain('Small diffs.')
  expect(brief).toContain('ON DEMAND')
})

function stubConductor(db: any): ConductorLike & { tasks: Array<{ id: number; text: string }> } {
  const tasks: Array<{ id: number; text: string }> = []
  return {
    tasks,
    isHired: (id) => Boolean(db.prepare(`SELECT 1 FROM agents WHERE id=? AND kind='hired'`).get(id)),
    hire: ({ boardId, name }) => {
      db.prepare(`INSERT INTO agents (board_id, name, kind) VALUES (?, ?, 'hired')`).run(boardId, name ?? 'stub-lead')
      return db.prepare(`SELECT * FROM agents WHERE board_id=? AND name=?`).get(boardId, name ?? 'stub-lead')
    },
    deliver: () => true,
    task: (id, text) => { tasks.push({ id, text }); return true },
    transcript: () => ({ lines: [], working: null }),
    subagents: () => [],
    interruptAgent: async () => true,
    fire: async () => true,
    launch: () => ({ queued: false }),
    isLaunched: () => false,
  }
}

const boot = async (withMaestro = true) => {
  const db = openDb(':memory:')
  let stub: ReturnType<typeof stubConductor> | undefined
  const server = withMaestro
    ? buildServer(db, (_bus: Bus) => { stub = stubConductor(db); return stub! })
    : buildServer(db)
  await server.ready()
  await server.inject({ method: 'POST', url: '/api/v1/boards/resolve', payload: { project_path: '/p' } })
  return { db, server, stub: () => stub! }
}

it('team lifecycle: draft -> edit -> approve -> hire spawns only the lead with a brief', async () => {
  const { db, server, stub } = await boot()

  const created = await server.inject({ method: 'POST', url: '/api/v1/boards/1/teams', payload: {
    name: 'Core Platform', goal: 'Ship the sync engine', spec: spec(),
  } })
  expect(created.statusCode).toBe(200)
  const team = created.json().team
  expect(team.status).toBe('draft')

  // editing keeps it a draft and validates the new spec
  const badPatch = await server.inject({ method: 'PATCH', url: `/api/v1/teams/${team.id}`, payload: {
    spec: { roles: [], workflow: [] },
  } })
  expect(badPatch.statusCode).toBe(400)
  const patched = await server.inject({ method: 'PATCH', url: `/api/v1/teams/${team.id}`, payload: {
    goal: 'Ship the sync engine v2',
  } })
  expect(patched.json().team.goal).toBe('Ship the sync engine v2')

  // hire refuses before approval
  expect((await server.inject({ method: 'POST', url: `/api/v1/teams/${team.id}/hire` })).statusCode).toBe(409)

  expect((await server.inject({ method: 'POST', url: `/api/v1/teams/${team.id}/approve` })).json().team.status).toBe('approved')

  const hired = (await server.inject({ method: 'POST', url: `/api/v1/teams/${team.id}/hire` })).json()
  expect(hired.team.status).toBe('hired')
  expect(hired.team.lead_agent).toBe(hired.agent.name)

  // only the lead spawned, tagged with team + role, and got the brief as its first task
  const members = db.prepare(`SELECT name, team_role FROM agents WHERE team_id=?`).all(team.id) as any[]
  expect(members).toHaveLength(1)
  expect(members[0].team_role).toBe('lead')
  expect(stub().tasks).toHaveLength(1)
  expect(stub().tasks[0].text).toContain('You are the lead')

  // hired teams are locked: no edits, no re-approve, no double hire
  expect((await server.inject({ method: 'PATCH', url: `/api/v1/teams/${team.id}`, payload: { name: 'X' } })).statusCode).toBe(409)
  expect((await server.inject({ method: 'POST', url: `/api/v1/teams/${team.id}/approve` })).statusCode).toBe(409)
  expect((await server.inject({ method: 'POST', url: `/api/v1/teams/${team.id}/hire` })).statusCode).toBe(409)

  // list joins live members
  const listed = (await server.inject({ url: '/api/v1/boards/1/teams' })).json().teams
  expect(listed).toHaveLength(1)
  expect(listed[0].members).toHaveLength(1)
  expect(listed[0].spec.roles).toHaveLength(3)

  // archive releases members and hides the team from the list
  const archived = (await server.inject({ method: 'DELETE', url: `/api/v1/teams/${team.id}` })).json().team
  expect(archived.status).toBe('archived')
  expect(db.prepare(`SELECT COUNT(*) AS c FROM agents WHERE team_id=?`).get(team.id)).toEqual({ c: 0 })
  expect((await server.inject({ url: '/api/v1/boards/1/teams' })).json().teams).toHaveLength(0)
})

it('rejects invalid specs on create and 404s unknown teams', async () => {
  const { server } = await boot()
  const bad = await server.inject({ method: 'POST', url: '/api/v1/boards/1/teams', payload: {
    name: 'Broken', spec: { roles: [{ key: 'a', title: 'A', charter: 'c', reports_to: 'a', max_agents: 1 }], workflow: [] },
  } })
  expect(bad.statusCode).toBe(400)
  expect(bad.json().details.join()).toMatch(/cannot report to itself|exactly one role/)
  expect((await server.inject({ method: 'POST', url: '/api/v1/boards/1/teams', payload: { name: 'NoSpec' } })).statusCode).toBe(400)
  expect((await server.inject({ url: '/api/v1/teams/999' })).statusCode).toBe(404)
  expect((await server.inject({ method: 'POST', url: '/api/v1/boards/999/teams', payload: { name: 'X', spec: spec() } })).statusCode).toBe(404)
})

it('team hire returns 501 without a conductor', async () => {
  const { server } = await boot(false)
  const team = (await server.inject({ method: 'POST', url: '/api/v1/boards/1/teams', payload: {
    name: 'T', spec: spec(),
  } })).json().team
  await server.inject({ method: 'POST', url: `/api/v1/teams/${team.id}/approve` })
  expect((await server.inject({ method: 'POST', url: `/api/v1/teams/${team.id}/hire` })).statusCode).toBe(501)
})
