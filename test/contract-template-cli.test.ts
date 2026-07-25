import { Command } from 'commander'
import { describe, expect, it, vi } from 'vitest'
import { registerAgentOsCommands, type AgentOsCliDeps } from '../src/agent-os-cli.js'

type Call = { method: string; path: string; body?: unknown }

function fixture() {
  const calls: Call[] = []
  const deps: AgentOsCliDeps = {
    api: vi.fn(async (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, body })
      return path === '/os/contract-templates'
        ? { templates: [{ id: 'bug-fix', name: 'Bug fix' }] }
        : { changed: true, template: { id: 'bug-fix' } }
    }),
    ensureReady: vi.fn(async () => {}),
    resolveBoard: vi.fn(async () => ({ id: 1 })),
    output: vi.fn(),
  }
  const program = new Command().name('orchestra').exitOverride()
  program.configureOutput({ writeErr: () => {}, writeOut: () => {} })
  registerAgentOsCommands(program, deps)
  const run = (...args: string[]) => program.parseAsync(['node', 'orchestra', ...args])
  return { calls, deps, run }
}

const vars = JSON.stringify({
  objective: 'Stop duplicate dispatch',
  affected_area: 'the scheduler dispatch loop',
  reproduction: 'Two workers claim the same exclusive job',
})

describe('task contract template CLI', () => {
  it('lists and previews built-in templates through the Agent OS API', async () => {
    const { calls, run } = fixture()
    await run('contract-template', 'list')
    await run('contract-template', 'preview', 'bug-fix', '--vars', vars)

    expect(calls).toEqual([
      { method: 'GET', path: '/os/contract-templates', body: undefined },
      {
        method: 'POST',
        path: '/os/contract-templates/bug-fix/preview',
        body: {
          variables: {
            objective: 'Stop duplicate dispatch',
            affected_area: 'the scheduler dispatch loop',
            reproduction: 'Two workers claim the same exclusive job',
          },
        },
      },
    ])
  })

  it('defaults apply to conflict rejection and sends replace only after explicit --replace intent', async () => {
    const { calls, run } = fixture()
    await run(
      'contract-template',
      'apply',
      '7',
      'bug-fix',
      '--vars',
      vars,
      '--actor',
      'agent:planner',
    )
    await run(
      'contract-template',
      'apply',
      '7',
      'bug-fix',
      '--vars',
      vars,
      '--replace',
      '--actor',
      'agent:planner',
    )

    expect(calls).toEqual([
      {
        method: 'POST',
        path: '/os/cards/7/contract/templates/bug-fix/apply',
        body: {
          variables: {
            objective: 'Stop duplicate dispatch',
            affected_area: 'the scheduler dispatch loop',
            reproduction: 'Two workers claim the same exclusive job',
          },
          conflict_strategy: 'reject',
          actor: 'agent:planner',
        },
      },
      {
        method: 'POST',
        path: '/os/cards/7/contract/templates/bug-fix/apply',
        body: {
          variables: {
            objective: 'Stop duplicate dispatch',
            affected_area: 'the scheduler dispatch loop',
            reproduction: 'Two workers claim the same exclusive job',
          },
          conflict_strategy: 'replace',
          actor: 'agent:planner',
        },
      },
    ])
  })

  it('rejects invalid variable JSON before making an API request', async () => {
    const { calls, run } = fixture()
    await expect(run('contract-template', 'preview', 'bug-fix', '--vars', '{bad'))
      .rejects.toThrow(/--vars must be valid JSON/)
    expect(calls).toEqual([])
  })
})
