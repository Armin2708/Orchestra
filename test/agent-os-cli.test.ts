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
    attachProcess: vi.fn(async () => {}),
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

  it('preserves opaque Agent OS ids instead of coercing them to legacy integers', async () => {
    const { calls, run } = setup({ ok: true })

    await run('process', 'signal', 'f5c293c8-7009-4d56-9b61-4ab7cb610e25', 'SIGINT')
    await run('events', '--after', '3d58bcee-e748-48e2-b61b-c15ea9589b81')

    expect(calls).toEqual([
      {
        method: 'POST',
        path: '/os/processes/f5c293c8-7009-4d56-9b61-4ab7cb610e25/signal',
        body: { signal: 'SIGINT' },
      },
      {
        method: 'GET',
        path: '/os/boards/42/events?limit=100&after=3d58bcee-e748-48e2-b61b-c15ea9589b81',
        body: undefined,
      },
    ])
  })

  it('prints ordered process output as raw terminal bytes', async () => {
    const { output, run } = setup({ output: [{ seq: 1, data: 'hello ' }, { seq: 2, data: 'world\n' }] })

    await run('process', 'output', '8', '--after', '0')

    expect(output).toEqual(['hello world\n'])
  })

  it('attaches the current terminal and restarts processes through opaque ids', async () => {
    const { calls, deps, run } = setup({ process: { id: 'replacement' } })

    await run('process', 'attach', 'proc/a')
    await run('process', 'restart', 'proc/a')

    expect(deps.attachProcess).toHaveBeenCalledWith('proc/a')
    expect(calls).toEqual([{ method: 'POST', path: '/os/processes/proc%2Fa/restart', body: undefined }])
  })

  it('writes structured task contracts through the compatibility card bridge', async () => {
    const { calls, run } = setup({ card_id: 2 })

    await run(
      'contract', 'set', '2',
      '--objective', 'ship it',
      '--deliverables', '[{"id":"deliverable-1","text":"Ship the feature","required":true}]',
      '--accept', '["tests pass",{"kind":"visual"}]',
      '--non-goals', '["redesign the shell"]',
      '--risks', '["provider output may be incomplete"]',
      '--depends', '1,3',
      '--verify', '["npm test"]',
      '--tokens', '5000',
    )

    expect(calls[0]).toEqual({
      method: 'PUT',
      path: '/os/cards/2/contract',
      body: {
        objective: 'ship it',
        deliverables: [{ id: 'deliverable-1', text: 'Ship the feature', required: true }],
        acceptance_criteria: ['tests pass', { kind: 'visual' }],
        non_goals: ['redesign the shell'],
        risks: ['provider output may be incomplete'],
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

  it('creates card work through the canonical jobs API with a replay key', async () => {
    const { calls, output, run } = setup({
      mode: 'canonical',
      job: { id: 'job-1', status: 'queued', workspace_id: 'workspace-1' },
      orchestration: {
        lifecycle: 'canonical', contract_attached: true, job_id: 'job-1',
        workspace_id: 'workspace-1', session_id: 'session-1',
      },
    })

    await run(
      'job', 'create', '7',
      '--board', '42',
      '--provider', 'codex',
      '--model', 'gpt-route',
      '--attempts', '3',
      '--idempotency-key', 'cli-request-1',
    )

    expect(calls).toEqual([{
      method: 'POST',
      path: '/os/boards/42/jobs',
      body: {
        card_id: 7,
        provider: 'codex',
        model: 'gpt-route',
        max_attempts: 3,
        idempotency_key: 'cli-request-1',
      },
    }])
    expect(output).toEqual([
      'mode=canonical job_id="job-1" status="queued" workspace_id="workspace-1" session_id="session-1"',
    ])
  })

  it('submits structured delivery items, criterion outcomes, and evidence for a job', async () => {
    const { calls, run } = setup({ delivery: { id: 'delivery-1', status: 'verified' } })

    await run(
      'delivery', 'submit', 'job/a',
      '--actor', 'codex-agent',
      '--summary', 'Implemented the delivery',
      '--items', '[{"deliverableId":"del-1","status":"delivered"}]',
      '--criteria', '[{"criterionId":"criterion-1","outcome":"met","evidence":["commit:abc"]}]',
      '--evidence', '{"commits":["abc"],"artifacts":["artifact-1"]}',
      '--claims', '["all requested behavior is present"]',
      '--files', '["src/agent-os-cli.ts"]',
      '--commits', '["abc"]',
      '--artifacts', '["artifact-1"]',
      '--gaps', '["visual QA remains"]',
    )

    expect(calls).toEqual([{
      method: 'POST',
      path: '/os/jobs/job%2Fa/deliveries/submit',
      body: {
        actor: 'codex-agent',
        summary: 'Implemented the delivery',
        delivered_items: [{ deliverableId: 'del-1', status: 'delivered' }],
        criteria: [{ criterionId: 'criterion-1', outcome: 'met', evidence: ['commit:abc'] }],
        evidence: { commits: ['abc'], artifacts: ['artifact-1'] },
        claims: ['all requested behavior is present'],
        changed_files: ['src/agent-os-cli.ts'],
        commits: ['abc'],
        artifact_ids: ['artifact-1'],
        gaps: ['visual QA remains'],
      },
    }])
  })

  it('accepts a plain stdin delivery summary and exposes review lifecycle commands', async () => {
    const { calls, run } = setup({ delivery: { id: 'delivery-1' } })

    await run('delivery', 'submit', 'job-1', '--stdin')
    await run('delivery', 'verify', 'delivery-1', '--criteria', '[{"text":"works","met":"unverifiable"}]')
    await run('delivery', 'accept', 'delivery-1', '--note', 'reviewed')
    await run('delivery', 'reject', 'delivery-2', '--reason', 'missing evidence')
    await run('delivery', 'revise', 'delivery-2')
    await run('delivery', 'show', '7')

    expect(calls).toEqual([
      { method: 'POST', path: '/os/jobs/job-1/deliveries/submit', body: {
        actor: 'agent', summary: 'exact\nbytes',
      } },
      { method: 'POST', path: '/os/deliveries/delivery-1/verify', body: {
        actor: 'verifier', results: [{ text: 'works', met: 'unverifiable' }],
      } },
      { method: 'POST', path: '/os/deliveries/delivery-1/accept', body: {
        actor: 'human', note: 'reviewed',
      } },
      { method: 'POST', path: '/os/deliveries/delivery-2/reject', body: {
        actor: 'human', reason: 'missing evidence',
      } },
      { method: 'POST', path: '/os/deliveries/delivery-2/revise', body: { actor: 'agent' } },
      { method: 'GET', path: '/os/cards/7/deliveries', body: undefined },
    ])
  })

  it('exports human trackbook text by default and canonical JSON on request', async () => {
    const human = setup('# Delivery delivery-1\nStatus: submitted\n')
    await human.run('delivery', 'export', 'delivery-1')
    expect(human.output).toEqual(['# Delivery delivery-1\nStatus: submitted\n'])
    expect(human.calls[0]).toMatchObject({ method: 'GET', path: '/os/deliveries/delivery-1/export?format=human' })

    const json = setup({ delivery: { id: 'delivery-1', status: 'submitted' } })
    await json.run('delivery', 'export', 'delivery-1', '--json')
    expect(json.calls[0]).toMatchObject({ method: 'GET', path: '/os/deliveries/delivery-1/export?format=json' })
    expect(json.output[0]).toContain('"status": "submitted"')
  })
})

it('rejects malformed JSON options before issuing a request', () => {
  expect(() => parseJsonOption('{bad', '--env')).toThrow('--env must be valid JSON')
})
