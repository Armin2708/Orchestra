import { describe, expect, it } from 'vitest'
import {
  isMastermindName, mastermindRules, mastermindToolDecision, MASTERMIND_SCOPE_HINT,
} from '../src/mastermind-scope.js'

const decide = (tool: string, input: Record<string, unknown> = {}) => mastermindToolDecision(tool, input)
const bash = (command: string) => decide('Bash', { command })

describe('mastermind scope guard', () => {
  it('recognises the reserved name regardless of case and padding', () => {
    expect(isMastermindName('mastermind')).toBe(true)
    expect(isMastermindName(' Mastermind ')).toBe(true)
    expect(isMastermindName('mastermind-2')).toBe(false)
    expect(isMastermindName(null)).toBe(false)
  })

  it('allows reading the repository so designs are grounded in real code', () => {
    for (const tool of ['Read', 'Glob', 'Grep', 'WebFetch']) {
      expect(decide(tool), tool).toEqual({ allow: true })
    }
  })

  it('denies every tool that could change the project or spawn agents', () => {
    for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Task', 'KillShell']) {
      const decision = decide(tool)
      expect(decision, tool).toMatchObject({ allow: false })
      expect((decision as { message: string }).message).toContain('scoped to team design')
    }
  })

  it('leaves operator questions to the ordinary permission flow', () => {
    expect(decide('AskUserQuestion')).toBeNull()
  })

  it('allows the team-design CLI, including the printf --stdin recipe', () => {
    expect(bash('orchestra team list')).toEqual({ allow: true })
    expect(bash("printf '%s' '{\"roles\":[]}' | orchestra team propose 'Core' --goal 'ship' --stdin")).toEqual({ allow: true })
    expect(bash('orchestra team update 4 --stdin')).toEqual({ allow: true })
    expect(bash('orchestra snapshot')).toEqual({ allow: true })
    expect(bash("orchestra mail 'designed a team' 'details' --from mastermind")).toEqual({ allow: true })
  })

  it('denies the commands that would let it staff, approve or run its own designs', () => {
    for (const command of [
      'orchestra team hire-member reviewer',
      'orchestra team assign 12 3',
      'orchestra hire --name helper',
      'orchestra fire mastermind',
      'orchestra card create "do it" --agent mastermind',
    ]) {
      expect(bash(command), command).toMatchObject({ allow: false })
    }
  })

  it('denies arbitrary shell, including anything chained onto an allowed command', () => {
    for (const command of [
      'rm -rf src',
      'node dist/cli.js hire',
      'orchestra team list && rm -rf src',
      'orchestra team list; git commit -am wip',
      'echo $(rm -rf src)',
      'orchestra team list | tee /tmp/out',
      '',
    ]) {
      expect(bash(command), command).toMatchObject({ allow: false })
    }
  })

  it('states the scope in the system prompt so denials are never a surprise', () => {
    const rules = mastermindRules('mastermind')
    expect(rules).toContain('MASTERMIND')
    expect(rules).toContain('orchestra team propose')
    expect(rules).toContain('never approve, hire, staff or assign')
    expect(MASTERMIND_SCOPE_HINT).toContain('Editing files')
  })
})

describe('mastermind permission mode is not the operator\'s to widen', () => {
  it('refuses bypassPermissions for the mastermind but allows it for anyone else', async () => {
    const { openDb } = await import('../src/db.js')
    const { buildServer } = await import('../src/server.js')
    const db = openDb(':memory:')
    const server = buildServer(db, () => ({
      isHired: () => true,
      hire: () => ({}),
      deliver: () => true,
      task: () => true,
      transcript: () => ({ lines: [], working: null }),
      subagents: () => [],
      interruptAgent: async () => true,
      fire: async () => true,
      launch: () => ({ queued: false }),
      isLaunched: () => false,
      setPermissionMode: async () => true,
    }) as any)
    await server.ready()
    await server.inject({ method: 'POST', url: '/api/v1/boards/resolve', payload: { project_path: '/p' , create: true } })
    db.prepare(`INSERT INTO agents (board_id, name, kind) VALUES (1, 'mastermind', 'hired'), (1, 'ordinary', 'hired')`).run()
    const idOf = (name: string) => (db.prepare(`SELECT id FROM agents WHERE name=?`).get(name) as { id: number }).id

    const denied = await server.inject({
      method: 'POST', url: `/api/v1/agents/${idOf('mastermind')}/permission-mode`,
      payload: { mode: 'bypassPermissions' },
    })
    expect(denied.statusCode).toBe(409)
    expect(denied.json().error).toContain('scoped to team design')

    expect((await server.inject({
      method: 'POST', url: `/api/v1/agents/${idOf('mastermind')}/permission-mode`, payload: { mode: 'plan' },
    })).statusCode).toBe(200)
    expect((await server.inject({
      method: 'POST', url: `/api/v1/agents/${idOf('ordinary')}/permission-mode`, payload: { mode: 'bypassPermissions' },
    })).statusCode).toBe(200)
  })
})
