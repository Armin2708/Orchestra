import { Command } from 'commander'
import { describe, expect, it, vi } from 'vitest'
import { registerAgentOsCommands, type AgentOsCliDeps } from '../src/agent-os-cli.js'

type Call = { method: string; path: string; body?: unknown }

function fixture() {
  const calls: Call[] = []
  const output = vi.fn()
  const deps: AgentOsCliDeps = {
    api: vi.fn(async (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, body })
      if (path.endsWith('/current')) return { assignment: null }
      return { assignments: [], assignment: { id: 'assignment-1', status: 'active' } }
    }),
    ensureReady: vi.fn(async () => {}),
    resolveBoard: vi.fn(async () => ({ id: 17 })),
    output,
  }
  const program = new Command().name('orchestra').exitOverride()
  program.configureOutput({ writeErr: () => {}, writeOut: () => {} })
  registerAgentOsCommands(program, deps)
  const run = (...args: string[]) => program.parseAsync(['node', 'orchestra', ...args])
  return { calls, deps, output, program, run }
}

describe('Job Market assignment CLI', () => {
  it('attaches once beneath the existing job command and exposes board, history, and current reads', async () => {
    const { calls, program, run } = fixture()
    expect(program.commands.filter((command) => command.name() === 'job')).toHaveLength(1)

    await run(
      'job',
      'assignment',
      'list',
      '--board',
      '23',
      '--status',
      'active',
      '--profile',
      'profile/one',
      '--workspace',
      'work tree',
    )
    await run('job', 'assignment', 'list', '42')
    await run('job', 'assignment', 'current', '42', '--json')

    expect(calls).toEqual([
      {
        method: 'GET',
        path: '/os/boards/23/assignments?status=active&profile_id=profile%2Fone&workspace_id=work+tree',
        body: undefined,
      },
      {
        method: 'GET',
        path: '/os/cards/42/assignments',
        body: undefined,
      },
      {
        method: 'GET',
        path: '/os/cards/42/assignments/current',
        body: undefined,
      },
    ])
  })

  it('sends claim and operator assignment intent with body idempotency keys', async () => {
    const { calls, run } = fixture()

    await run(
      'job',
      'assignment',
      'claim',
      '42',
      'profile-a',
      '--expected-market-version',
      '3',
      '--workspace',
      'workspace-a',
      '--reason',
      'volunteered',
      '--idempotency',
      'claim-once',
    )
    await run(
      'job',
      'assignment',
      'assign',
      '43',
      'profile-b',
      '--expected-market-version',
      '1',
      '--idempotency',
      'assign-once',
    )

    expect(calls).toEqual([
      {
        method: 'POST',
        path: '/os/cards/42/assignments/claim',
        body: {
          profile_id: 'profile-a',
          workspace_id: 'workspace-a',
          expected_market_version: 3,
          reason: 'volunteered',
          idempotency_key: 'claim-once',
        },
      },
      {
        method: 'POST',
        path: '/os/cards/43/assignments/assign',
        body: {
          profile_id: 'profile-b',
          expected_market_version: 1,
          idempotency_key: 'assign-once',
        },
      },
    ])
  })

  it('sends release and reassignment compare-and-set versions without a client actor', async () => {
    const { calls, run } = fixture()

    await run(
      'job',
      'assignment',
      'release',
      '42',
      'assignment/one',
      '--expected-market-version',
      '8',
      '--expected-assignment-version',
      '2',
      '--reason',
      'work returned',
      '--idempotency',
      'release-once',
    )
    await run(
      'job',
      'assignment',
      'reassign',
      '42',
      'assignment/one',
      'profile-c',
      '--expected-market-version',
      '9',
      '--expected-assignment-version',
      '3',
      '--workspace',
      'workspace-c',
      '--reason',
      'capability match',
      '--idempotency',
      'reassign-once',
    )

    expect(calls).toEqual([
      {
        method: 'POST',
        path: '/os/cards/42/assignments/assignment%2Fone/release',
        body: {
          expected_market_version: 8,
          expected_assignment_version: 2,
          reason: 'work returned',
          idempotency_key: 'release-once',
        },
      },
      {
        method: 'POST',
        path: '/os/cards/42/assignments/assignment%2Fone/reassign',
        body: {
          profile_id: 'profile-c',
          workspace_id: 'workspace-c',
          expected_market_version: 9,
          expected_assignment_version: 3,
          reason: 'capability match',
          idempotency_key: 'reassign-once',
        },
      },
    ])
  })

  it('generates an idempotency key when the caller omits one', async () => {
    const { calls, run } = fixture()
    await run(
      'job',
      'assignment',
      'claim',
      '42',
      'profile-a',
      '--expected-market-version',
      '1',
    )

    expect(calls).toHaveLength(1)
    expect(calls[0]?.body).toMatchObject({
      idempotency_key: expect.stringMatching(
        /^orchestra-cli:job-assignment-claim:42:profile-a:[0-9a-f-]{36}$/,
      ),
    })
  })

  it('prints none for a card without an active assignment', async () => {
    const { output, run } = fixture()
    await run('job', 'assignment', 'current', '42')
    expect(output).toHaveBeenCalledWith('none')
  })

  it('rejects invalid identifiers and versions before an API request', async () => {
    const invalidCard = fixture()
    await expect(invalidCard.run('job', 'assignment', 'current', '0'))
      .rejects.toThrow(/expected a positive integer/)
    expect(invalidCard.calls).toEqual([])

    const invalidMarketVersion = fixture()
    await expect(invalidMarketVersion.run(
      'job',
      'assignment',
      'claim',
      '42',
      'profile-a',
      '--expected-market-version',
      '0',
    )).rejects.toThrow(/expected a positive integer/)
    expect(invalidMarketVersion.calls).toEqual([])

    const invalidAssignmentVersion = fixture()
    await expect(invalidAssignmentVersion.run(
      'job',
      'assignment',
      'release',
      '42',
      'assignment-a',
      '--expected-market-version',
      '2',
      '--expected-assignment-version',
      '0',
    )).rejects.toThrow(/expected a positive integer/)
    expect(invalidAssignmentVersion.calls).toEqual([])

    const emptyProfile = fixture()
    await expect(emptyProfile.run(
      'job',
      'assignment',
      'assign',
      '42',
      '',
      '--expected-market-version',
      '2',
    )).rejects.toThrow(/resource id cannot be empty/)
    expect(emptyProfile.calls).toEqual([])
  })
})
