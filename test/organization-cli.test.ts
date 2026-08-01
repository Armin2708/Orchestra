import { Command } from 'commander'
import { describe, expect, it } from 'vitest'
import { registerAgentOsCommands, type AgentOsCliDeps } from '../src/agent-os-cli.js'

function setup(responses: Record<string, unknown> = {}) {
  const calls: Array<{ method: string; path: string; body?: unknown }> = []
  const output: string[] = []
  const deps: AgentOsCliDeps = {
    api: async (method, path, body) => {
      calls.push({ method, path, body })
      return responses[path] ?? { result: { id: 'result-1', status: 'active' } }
    },
    ensureReady: async () => undefined,
    resolveBoard: async () => ({ id: 42 }),
    output: (line) => output.push(line),
  }
  const program = new Command().exitOverride().configureOutput({
    writeOut: () => undefined,
    writeErr: () => undefined,
  })
  registerAgentOsCommands(program, deps)
  const run = (...args: string[]) => program.parseAsync(['node', 'orchestra', ...args])
  return { calls, output, run }
}

describe('organization CLI', () => {
  it('lists, creates, and reads an organization control center', async () => {
    const { calls, run } = setup({
      '/os/boards/42/organizations': { organizations: [{ id: 'org-1' }] },
      '/os/organizations/org-1/control-center': {
        organization: { organization: { id: 'org-1' } },
      },
    })
    await run('organization', 'list')
    await run(
      'organization', 'create', 'orchestra', 'Orchestra',
      '--mission', 'Coordinate bounded teams.', '--idempotency', 'org-create',
    )
    await run('organization', 'show', 'org-1', '--json')

    expect(calls).toEqual([
      { method: 'GET', path: '/os/boards/42/organizations', body: undefined },
      {
        method: 'POST',
        path: '/os/boards/42/organizations',
        body: {
          key: 'orchestra',
          name: 'Orchestra',
          mission: 'Coordinate bounded teams.',
          idempotency_key: 'org-create',
        },
      },
      { method: 'GET', path: '/os/organizations/org-1/control-center', body: undefined },
    ])
  })

  it('dispatches every bounded command layer with validated JSON and idempotency', async () => {
    const { calls, run } = setup()
    await run(
      'organization', 'command', 'org/1', 'coordination', 'message.send',
      '--body', '{"intent":"BLOCKER","summary":"Dependency blocked"}',
      '--idempotency', 'message-1', '--json',
    )
    expect(calls).toEqual([{
      method: 'POST',
      path: '/os/organizations/org%2F1/coordination/message.send',
      body: {
        intent: 'BLOCKER',
        summary: 'Dependency blocked',
        idempotency_key: 'message-1',
      },
    }])

    await expect(run(
      'organization', 'command', 'org-1', 'invalid', 'message.send', '--body', '{}',
    )).rejects.toThrow(/layer must be/)
    await expect(run(
      'organization', 'command', 'org-1', 'core', 'team.create', '--body', '[]',
    )).rejects.toThrow(/JSON object/)
    await expect(run(
      'organization', 'command', 'org-1', 'core', 'team.create', '--body', '{bad',
    )).rejects.toThrow(/valid JSON/)
  })
})
