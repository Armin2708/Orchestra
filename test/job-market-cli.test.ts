import { Command } from 'commander'
import { describe, expect, it, vi } from 'vitest'
import { registerAgentOsCommands, type AgentOsCliDeps } from '../src/agent-os-cli.js'

type Call = { method: string; path: string; body?: unknown }

function fixture() {
  const calls: Call[] = []
  const deps: AgentOsCliDeps = {
    api: vi.fn(async (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, body })
      return { job_market: { card_id: 7, status: 'open' } }
    }),
    ensureReady: vi.fn(async () => {}),
    resolveBoard: vi.fn(async () => ({ id: 1 })),
    output: vi.fn(),
  }
  const program = new Command().name('orchestra').exitOverride()
  program.configureOutput({ writeErr: () => {}, writeOut: () => {} })
  registerAgentOsCommands(program, deps)
  const run = (...args: string[]) => program.parseAsync(['node', 'orchestra', ...args])
  return { calls, run }
}

describe('Job Market CLI', () => {
  it('writes every typed constraint and budget through the compatibility contract command', async () => {
    const { calls, run } = fixture()
    await run(
      'contract',
      'set',
      '7',
      '--accept',
      '[{"id":"criterion-1","text":"Pass","description":"Pass tests","verifier":{"kind":"command","command":"npm test"},"required_artifacts":["test-log"],"priority":5,"owner":"agent:reviewer"}]',
      '--dependency-rules',
      '[{"card_id":6,"blocking_reason":"Foundation first","completion_condition":"card_done"}]',
      '--capabilities',
      '["typescript"]',
      '--providers',
      '["codex"]',
      '--models',
      '["gpt-5.4"]',
      '--access',
      '["workspace_write"]',
      '--time',
      '3600',
      '--retries',
      '2',
      '--coordination-tokens',
      '1000',
      '--coordination-messages',
      '12',
      '--actor',
      'agent:planner',
    )

    expect(calls).toEqual([{
      method: 'PUT',
      path: '/os/cards/7/contract',
      body: {
        acceptance_criteria: [{
          id: 'criterion-1',
          text: 'Pass',
          description: 'Pass tests',
          verifier: { kind: 'command', command: 'npm test' },
          required_artifacts: ['test-log'],
          priority: 5,
          owner: 'agent:reviewer',
        }],
        dependency_rules: [{
          card_id: 6,
          blocking_reason: 'Foundation first',
          completion_condition: 'card_done',
        }],
        required_capabilities: ['typescript'],
        provider_constraints: ['codex'],
        model_constraints: ['gpt-5.4'],
        access_needs: ['workspace_write'],
        budget_time_seconds: 3600,
        budget_retries: 2,
        budget_coordination_tokens: 1000,
        budget_coordination_messages: 12,
        actor: 'agent:planner',
      },
    }])
  })

  it('exposes validate, publish, and audited lifecycle transitions', async () => {
    const { calls, run } = fixture()
    await run(
      'contract',
      'validate',
      '7',
      '--mode',
      'launch',
      '--provider',
      'codex',
      '--model',
      'gpt-5.4',
      '--access',
      'workspace_write',
    )
    await run('contract', 'publish', '7', '--actor', 'human')
    await run('contract', 'transition', '7', 'assigned', '--actor', 'scheduler', '--reason', 'matched')

    expect(calls).toEqual([
      {
        method: 'GET',
        path: '/os/cards/7/contract/validate?mode=launch&provider=codex&model=gpt-5.4&access_profile=workspace_write',
        body: undefined,
      },
      {
        method: 'POST',
        path: '/os/cards/7/contract/publish',
        body: { actor: 'human' },
      },
      {
        method: 'POST',
        path: '/os/cards/7/contract/transition',
        body: { status: 'assigned', actor: 'scheduler', reason: 'matched' },
      },
    ])
  })
})
