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
    isHired: (id) => Boolean(db.prepare(`SELECT 1 FROM agents WHERE id=? AND kind='hired' AND status != 'gone'`).get(id)),
    hire: ({ boardId, name, provider, model, effort }: any) => {
      db.prepare(`INSERT INTO agents (board_id, name, kind, provider, model, effort) VALUES (?, ?, 'hired', ?, ?, ?)
        ON CONFLICT(board_id, name) DO UPDATE SET kind='hired', status='idle',
          provider=excluded.provider, model=excluded.model, effort=excluded.effort`)
        .run(boardId, name ?? 'stub-lead', provider ?? 'claude', model ?? null, effort ?? null)
      return db.prepare(`SELECT * FROM agents WHERE board_id=? AND name=?`).get(boardId, name ?? 'stub-lead')
    },
    deliver: () => true,
    task: (id, text) => { tasks.push({ id, text }); return true },
    transcript: () => ({ lines: [], working: null }),
    subagents: () => [],
    interruptAgent: async () => true,
    fire: async (id: number) => {
      db.prepare(`UPDATE agents SET status='gone' WHERE id=?`).run(id)
      return true
    },
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
  await server.inject({ method: 'POST', url: '/api/v1/boards/resolve', payload: { project_path: '/p' , create: true } })
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

it('design hires the mastermind once, re-tasks it on later goals, and briefs the schema', async () => {
  const { db, server, stub } = await boot()
  expect((await server.inject({ method: 'POST', url: '/api/v1/boards/1/teams/design', payload: {} })).statusCode).toBe(400)

  const first = (await server.inject({ method: 'POST', url: '/api/v1/boards/1/teams/design', payload: {
    goal: 'Ship a realtime sync engine',
  } })).json()
  expect(first.agent.name).toBe('mastermind')
  expect(stub().tasks).toHaveLength(1)
  expect(stub().tasks[0].text).toContain('MASTERMIND')
  expect(stub().tasks[0].text).toContain('orchestra team propose')
  expect(stub().tasks[0].text).toContain('Ship a realtime sync engine')

  const second = (await server.inject({ method: 'POST', url: '/api/v1/boards/1/teams/design', payload: {
    goal: 'Harden auth',
  } })).json()
  expect(second.agent.id).toBe(first.agent.id)
  expect(stub().tasks).toHaveLength(2)
  expect(db.prepare(`SELECT COUNT(*) AS c FROM agents WHERE name='mastermind'`).get()).toEqual({ c: 1 })
})

const hireTeamOverApi = async (server: any) => {
  const team = (await server.inject({ method: 'POST', url: '/api/v1/boards/1/teams', payload: {
    name: 'Core', goal: 'Ship it', spec: spec(),
  } })).json().team
  await server.inject({ method: 'POST', url: `/api/v1/teams/${team.id}/approve` })
  return (await server.inject({ method: 'POST', url: `/api/v1/teams/${team.id}/hire` })).json()
}

it('lead staffs roles on demand within spec bounds; non-leads are refused', async () => {
  const { db, server, stub } = await boot()
  const { team } = await hireTeamOverApi(server)
  const lead = team.lead_agent

  expect((await server.inject({ method: 'POST', url: `/api/v1/teams/${team.id}/hire-member`, payload: {} })).statusCode).toBe(400)
  expect((await server.inject({ method: 'POST', url: `/api/v1/teams/${team.id}/hire-member`, payload: {
    role: 'ghost', requested_by: lead,
  } })).statusCode).toBe(409)
  expect((await server.inject({ method: 'POST', url: `/api/v1/teams/${team.id}/hire-member`, payload: {
    role: 'eng', requested_by: 'impostor',
  } })).statusCode).toBe(409)
  expect((await server.inject({ method: 'POST', url: `/api/v1/teams/${team.id}/hire-member`, payload: {
    role: 'lead', requested_by: lead,
  } })).statusCode).toBe(409)

  // stub always hires the same name, so rename each hire to keep names unique
  let n = 0
  const origHire = stub().hire.bind(stub())
  stub().hire = (input: any) => {
    const agent = origHire({ ...input, name: `member-${++n}` } as any)
    return agent
  }
  const first = (await server.inject({ method: 'POST', url: `/api/v1/teams/${team.id}/hire-member`, payload: {
    role: 'eng', requested_by: lead,
  } })).json()
  expect(first.agent.name).toBe('member-1')
  const memberTask = stub().tasks.find((t) => t.text.startsWith('You are a "Staff Engineer"'))
  expect(memberTask?.text).toContain('you report to')
  expect(memberTask?.text).toContain('do not contact the operator directly')

  await server.inject({ method: 'POST', url: `/api/v1/teams/${team.id}/hire-member`, payload: { role: 'eng', requested_by: lead } })
  const over = await server.inject({ method: 'POST', url: `/api/v1/teams/${team.id}/hire-member`, payload: { role: 'eng', requested_by: lead } })
  expect(over.statusCode).toBe(409)
  expect(over.json().error).toMatch(/fully staffed \(2\/2\)/)
  expect(db.prepare(`SELECT COUNT(*) AS c FROM agents WHERE team_id=? AND team_role='eng'`).get(team.id)).toEqual({ c: 2 })
})

it('assigning a card to a team hands it to the lead with routing orders', async () => {
  const { server, stub } = await boot()
  const { team, agent } = await hireTeamOverApi(server)
  const card = (await server.inject({ method: 'POST', url: '/api/v1/cards', payload: {
    board_id: 1, title: 'Build the sync engine',
  } })).json().card

  const assigned = (await server.inject({ method: 'POST', url: `/api/v1/cards/${card.id}/assign-team`, payload: {
    team_id: team.id,
  } })).json()
  expect(assigned.card.owner).toBe(team.lead_agent)
  expect(assigned.card.column).toBe('in_progress')
  const routing = stub().tasks.filter((t) => t.id === agent.id).map((t) => t.text)
  expect(routing.some((t) => t.includes('Route it through your team workflow'))).toBe(true)

  // draft teams cannot take cards
  const draft = (await server.inject({ method: 'POST', url: '/api/v1/boards/1/teams', payload: {
    name: 'Draft team', spec: spec(),
  } })).json().team
  expect((await server.inject({ method: 'POST', url: `/api/v1/cards/${card.id}/assign-team`, payload: {
    team_id: draft.id,
  } })).statusCode).toBe(409)
  expect((await server.inject({ method: 'POST', url: `/api/v1/cards/${card.id}/assign-team`, payload: {
    team_id: 999,
  } })).statusCode).toBe(404)
})

it('refine hands the current spec + instruction to the mastermind; hired teams refuse', async () => {
  const { server, stub } = await boot()
  const team = (await server.inject({ method: 'POST', url: '/api/v1/boards/1/teams', payload: {
    name: 'Refinable', goal: 'Goal', spec: spec(),
  } })).json().team

  expect((await server.inject({ method: 'POST', url: `/api/v1/teams/${team.id}/refine`, payload: {} })).statusCode).toBe(400)
  const refined = (await server.inject({ method: 'POST', url: `/api/v1/teams/${team.id}/refine`, payload: {
    instruction: 'Add a QA role under the lead',
  } })).json()
  expect(refined.agent.name).toBe('mastermind')
  const brief = stub().tasks.at(-1)!.text
  expect(brief).toContain('Add a QA role under the lead')
  expect(brief).toContain('"reviewer"')
  expect(brief).toContain(`orchestra team update ${team.id} --stdin`)

  const hired = await hireTeamOverApi(server)
  expect((await server.inject({ method: 'POST', url: `/api/v1/teams/${hired.team.id}/refine`, payload: {
    instruction: 'x',
  } })).statusCode).toBe(409)
})

it('team hire returns 501 without a conductor', async () => {
  const { server } = await boot(false)
  const team = (await server.inject({ method: 'POST', url: '/api/v1/boards/1/teams', payload: {
    name: 'T', spec: spec(),
  } })).json().team
  await server.inject({ method: 'POST', url: `/api/v1/teams/${team.id}/approve` })
  expect((await server.inject({ method: 'POST', url: `/api/v1/teams/${team.id}/hire` })).statusCode).toBe(501)
})

it('mastermind runs on the operator-chosen provider/model/effort and restarts only on change', async () => {
  const { db, server } = await boot()

  const empty = (await server.inject({ url: '/api/v1/boards/1/mastermind' })).json()
  expect(empty.agent).toBeNull()
  expect(empty.live).toBe(false)
  expect(empty.scope).toContain('team design')

  const started = (await server.inject({ method: 'POST', url: '/api/v1/boards/1/mastermind', payload: {
    provider: 'claude', model: 'claude-opus-5', effort: 'high',
  } })).json()
  expect(started.agent.name).toBe('mastermind')
  expect(started.agent.model).toBe('claude-opus-5')
  expect(started.agent.effort).toBe('high')

  // same settings reuse the live session
  const reused = (await server.inject({ method: 'POST', url: '/api/v1/boards/1/mastermind', payload: {
    provider: 'claude', model: 'claude-opus-5', effort: 'high',
  } })).json()
  expect(reused.agent.id).toBe(started.agent.id)

  // a different model re-runs it on the requested runtime
  const switched = (await server.inject({ method: 'POST', url: '/api/v1/boards/1/mastermind', payload: {
    model: 'claude-sonnet-5', effort: 'medium',
  } })).json()
  expect(switched.agent.model).toBe('claude-sonnet-5')
  expect(switched.agent.effort).toBe('medium')
  expect(db.prepare(`SELECT COUNT(*) AS c FROM agents WHERE name='mastermind'`).get()).toEqual({ c: 1 })

  expect((await server.inject({ method: 'POST', url: '/api/v1/boards/1/mastermind', payload: {
    effort: 'not a level!',
  } })).statusCode).toBe(400)
  expect((await server.inject({ method: 'POST', url: '/api/v1/boards/999/mastermind', payload: {} })).statusCode).toBe(404)

  const state = (await server.inject({ url: '/api/v1/boards/1/mastermind' })).json()
  expect(state.live).toBe(true)
  expect(state.agent.model).toBe('claude-sonnet-5')
})

it('design and refine honour the requested mastermind runtime', async () => {
  const { server } = await boot()
  const designed = (await server.inject({ method: 'POST', url: '/api/v1/boards/1/teams/design', payload: {
    goal: 'Ship search', model: 'claude-sonnet-5',
  } })).json()
  expect(designed.agent.model).toBe('claude-sonnet-5')

  const team = (await server.inject({ method: 'POST', url: '/api/v1/boards/1/teams', payload: {
    name: 'Search', spec: spec(),
  } })).json().team
  const refined = (await server.inject({ method: 'POST', url: `/api/v1/teams/${team.id}/refine`, payload: {
    instruction: 'add QA', model: 'claude-opus-5',
  } })).json()
  expect(refined.agent.model).toBe('claude-opus-5')
})

it('focus tells a live mastermind which team the chat is about, once per switch', async () => {
  const { server, stub } = await boot()
  const first = (await server.inject({ method: 'POST', url: '/api/v1/boards/1/teams', payload: {
    name: 'Alpha', goal: 'A', spec: spec(),
  } })).json().team
  const second = (await server.inject({ method: 'POST', url: '/api/v1/boards/1/teams', payload: {
    name: 'Beta', goal: 'B', spec: spec(),
  } })).json().team

  // no mastermind yet: focus is a no-op, never an error and never a spawn
  expect((await server.inject({ method: 'POST', url: `/api/v1/teams/${first.id}/focus` })).json())
    .toEqual({ focused: false, reason: 'mastermind is not live' })

  await server.inject({ method: 'POST', url: '/api/v1/boards/1/mastermind', payload: {} })
  expect((await server.inject({ method: 'POST', url: `/api/v1/teams/${first.id}/focus` })).json().focused).toBe(true)
  const brief = stub().tasks.at(-1)!.text
  expect(brief).toContain('"Alpha"')
  expect(brief).toContain(`orchestra team update ${first.id} --stdin`)

  const before = stub().tasks.length
  expect((await server.inject({ method: 'POST', url: `/api/v1/teams/${first.id}/focus` })).json().repeated).toBe(true)
  expect(stub().tasks).toHaveLength(before)

  expect((await server.inject({ method: 'POST', url: `/api/v1/teams/${second.id}/focus` })).json().team_id).toBe(second.id)
  expect(stub().tasks.at(-1)!.text).toContain('"Beta"')
  expect((await server.inject({ method: 'POST', url: '/api/v1/teams/999/focus' })).statusCode).toBe(404)
})
