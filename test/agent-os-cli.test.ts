import { Command } from 'commander'
import { describe, expect, it, vi } from 'vitest'
import { parseJsonOption, registerAgentOsCommands, type AgentOsCliDeps } from '../src/agent-os-cli.js'

type Call = { method: string; path: string; body?: unknown }

const setup = (response: any = { id: 1 }) => {
  const calls: Call[] = []
  const output: string[] = []
  const deps: AgentOsCliDeps = {
    api: vi.fn(async (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, body })
      return response
    }),
    ensureReady: vi.fn(async () => {}),
    resolveBoard: vi.fn(async () => ({ id: 42 })),
    output: (line) => output.push(line),
    readStdin: () => 'exact\nbytes',
  }
  const program = new Command().name('orchestra').exitOverride()
  program.configureOutput({ writeErr: () => {}, writeOut: () => {} })
  registerAgentOsCommands(program, deps)
  const run = (...args: string[]) => program.parseAsync(['node', 'orchestra', ...args])
  return { calls, deps, output, run }
}

describe('Agent OS CLI', () => {
  it('creates an isolated workspace on the resolved project board', async () => {
    const { calls, deps, run } = setup({ id: 9, name: 'fix-auth' })

    await run('workspace', 'create', 'fix-auth', '--card', '7', '--base', 'main', '--env', '{"MODE":"test"}')

    expect(deps.ensureReady).toHaveBeenCalledOnce()
    expect(deps.resolveBoard).toHaveBeenCalledOnce()
    expect(calls).toEqual([{
      method: 'POST',
      path: '/os/boards/42/workspaces',
      body: {
        name: 'fix-auth',
        card_id: 7,
        kind: 'worktree',
        base_ref: 'main',
        env: { MODE: 'test' },
      },
    }])
  })

  it('passes explicit board ids without resolving the current project', async () => {
    const { calls, deps, run } = setup({ workspaces: [] })

    await run('workspace', 'list', '--board', '12', '--status', 'active')

    expect(deps.resolveBoard).not.toHaveBeenCalled()
    expect(calls[0]).toMatchObject({ method: 'GET', path: '/os/boards/12/workspaces?status=active' })
  })

  it('starts a PTY process with terminal geometry and an exact command recipe', async () => {
    const { calls, run } = setup({ id: 3, status: 'running' })

    await run('process', 'start', '5', 'npm', 'test', '--', '--runInBand')

    expect(calls[0]).toEqual({
      method: 'POST',
      path: '/os/workspaces/5/processes',
      body: {
        name: 'terminal',
        command: 'npm test --runInBand',
        cols: 120,
        rows: 32,
        restartable: true,
      },
    })
  })

  it('relays stdin bytes to a managed process without interpolation', async () => {
    const { calls, run } = setup({ ok: true })

    await run('process', 'input', '5', '--stdin')

    expect(calls[0]).toEqual({ method: 'POST', path: '/os/processes/5/input', body: { data: 'exact\nbytes' } })
  })

  it('prints ordered process output as raw terminal bytes', async () => {
    const { output, run } = setup({ output: [{ seq: 1, data: 'hello ' }, { seq: 2, data: 'world\n' }] })

    await run('process', 'output', '8', '--after', '0')

    expect(output).toEqual(['hello world\n'])
  })

  it('writes structured task contracts through the compatibility card bridge', async () => {
    const { calls, run } = setup({ card_id: 2 })

    await run(
      'contract', 'set', '2',
      '--objective', 'ship it',
      '--accept', '["tests pass",{"kind":"visual"}]',
      '--depends', '1,3',
      '--verify', '["npm test"]',
      '--tokens', '5000',
    )

    expect(calls[0]).toEqual({
      method: 'PUT',
      path: '/os/cards/2/contract',
      body: {
        objective: 'ship it',
        acceptance_criteria: ['tests pass', { kind: 'visual' }],
        dependencies: [1, 3],
        verify_commands: ['npm test'],
        budget_tokens: 5000,
      },
    })
  })

  it('exposes driver discovery through the same authenticated API', async () => {
    const { calls, run } = setup({ drivers: [{ id: 'shell' }, { id: 'claude' }] })

    await run('drivers', '--json')

    expect(calls).toEqual([{ method: 'GET', path: '/os/drivers', body: undefined }])
  })
})

it('rejects malformed JSON options before issuing a request', () => {
  expect(() => parseJsonOption('{bad', '--env')).toThrow('--env must be valid JSON')
})
