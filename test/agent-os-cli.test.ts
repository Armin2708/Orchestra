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
  it('manages Agent Home identities through authenticated profile APIs', async () => {
    const { calls, run } = setup({ profile: { id: 'agent/a', name: 'Builder' } })

    await run(
      'agent', 'create', 'Builder',
      '--board', '42',
      '--role', 'implementation',
      '--provider', 'codex',
      '--model', 'gpt-codex',
      '--effort', 'high',
      '--access', 'workspace_write',
      '--capabilities', 'code,review',
      '--idempotency', 'agent-create-1',
    )
    await run('agent', 'show', 'agent/a')
    await run('agent', 'home', 'agent/a')
    await run('agent', 'rename', 'agent/a', 'Senior Builder', '--idempotency', 'agent-rename-1')
    await run('agent', 'archive', 'agent/a', '--idempotency', 'agent-archive-1')

    expect(calls).toEqual([
      {
        method: 'POST',
        path: '/os/boards/42/agent-profiles',
        body: {
          name: 'Builder',
          role: 'implementation',
          default_provider: 'codex',
          default_model: 'gpt-codex',
          default_effort: 'high',
          default_access_profile: 'workspace_write',
          capabilities: ['code', 'review'],
          idempotency_key: 'agent-create-1',
        },
      },
      { method: 'GET', path: '/os/agent-profiles/agent%2Fa', body: undefined },
      { method: 'GET', path: '/os/agent-profiles/agent%2Fa/home', body: undefined },
      {
        method: 'PATCH',
        path: '/os/agent-profiles/agent%2Fa',
        body: { name: 'Senior Builder', idempotency_key: 'agent-rename-1' },
      },
      {
        method: 'POST',
        path: '/os/agent-profiles/agent%2Fa/archive',
        body: { idempotency_key: 'agent-archive-1' },
      },
    ])
  })

  it('controls, searches, and exports sessions through the same Agent Home APIs', async () => {
    const { calls, run } = setup({ events: [] })

    await run('session', 'pause', 'session/a', '--idempotency', 'session-pause-1')
    await run('session', 'rename', 'session/a', 'Review session', '--idempotency', 'session-rename-1')
    await run(
      'session', 'search', 'session/a',
      '--query', 'compile',
      '--after', '7',
      '--limit', '25',
      '--kind', 'tool,status',
      '--actor-type', 'agent',
      '--actor-id', 'codex',
      '--tool', 'terminal',
      '--status', 'succeeded',
      '--from', '2026-07-24T10:00:00.000Z',
      '--to', '2026-07-24T12:00:00.000Z',
      '--archived',
    )
    await run(
      'session', 'export', 'session/a',
      '--artifact',
      '--idempotency', 'session-export-1',
    )

    expect(calls).toEqual([
      {
        method: 'POST',
        path: '/os/sessions/session%2Fa/pause',
        body: { idempotency_key: 'session-pause-1' },
      },
      {
        method: 'POST',
        path: '/os/sessions/session%2Fa/rename',
        body: {
          name: 'Review session',
          idempotency_key: 'session-rename-1',
        },
      },
      {
        method: 'GET',
        path: '/os/sessions/session%2Fa/search'
          + '?limit=25&query=compile&after=7&kind=tool%2Cstatus&actor_type=agent'
          + '&actor_id=codex&tool=terminal&status=succeeded'
          + '&from=2026-07-24T10%3A00%3A00.000Z'
          + '&to=2026-07-24T12%3A00%3A00.000Z&archived=true',
        body: undefined,
      },
      {
        method: 'POST',
        path: '/os/sessions/session%2Fa/export',
        body: {
          format: 'human',
          idempotency_key: 'session-export-1',
        },
      },
    ])
  })

  it('configures and runs Agent Home retention through operator APIs', async () => {
    const { calls, run } = setup({ policy: {}, run: {} })

    await run('retention', 'show', '--board', '42')
    await run(
      'retention', 'set',
      '--board', '42',
      '--transcript-days', '120',
      '--ephemeral-days', '14',
      '--raw-artifact-days', '45',
      '--idempotency', 'retention-set-1',
    )
    await run(
      'retention', 'run',
      '--board', '42',
      '--as-of', '2026-07-25T12:00:00.000Z',
      '--idempotency', 'retention-run-1',
    )

    expect(calls).toEqual([
      {
        method: 'GET',
        path: '/os/boards/42/retention',
        body: undefined,
      },
      {
        method: 'PUT',
        path: '/os/boards/42/retention',
        body: {
          transcript_days: 120,
          ephemeral_days: 14,
          raw_artifact_days: 45,
          idempotency_key: 'retention-set-1',
        },
      },
      {
        method: 'POST',
        path: '/os/boards/42/retention/run',
        body: {
          as_of: '2026-07-25T12:00:00.000Z',
          idempotency_key: 'retention-run-1',
        },
      },
    ])
  })

  it('reconciles an outcome-unknown fork through an explicit operator decision', async () => {
    const { calls, run } = setup({ reconciliation: { id: 'reconciliation/1' } })

    await run(
      'session',
      'reconcile-fork',
      'action/a',
      '--resolution',
      'verify_adopt',
      '--note',
      'Verified through the provider read API',
      '--idempotency',
      'fork-reconciliation-1',
    )

    expect(calls).toEqual([{
      method: 'POST',
      path: '/os/session-actions/action%2Fa/reconcile',
      body: {
        resolution: 'verify_adopt',
        note: 'Verified through the provider read API',
        idempotency_key: 'fork-reconciliation-1',
      },
    }])
  })

  it('rejects ambiguous fork reconciliation choices before making an API request', async () => {
    const { calls, run } = setup()

    await expect(run(
      'session',
      'reconcile-fork',
      'action/a',
      '--resolution',
      'retry',
    )).rejects.toThrow('resolution must be verify_adopt or confirm_absent')
    expect(calls).toEqual([])
  })

  it('creates an isolated workspace on the resolved project board', async () => {
    const { calls, deps, run } = setup({ id: 9, name: 'fix-auth' })

    await run(
      'workspace',
      'create',
      'fix-auth',
      '--card',
      '7',
      '--base',
      'main',
      '--env',
      '{"MODE":"test"}',
      '--idempotency',
      'workspace-create-1',
    )

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
        idempotency_key: 'workspace-create-1',
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

  it('covers checkpoint creation, job cancellation, and policy creation with replay keys', async () => {
    const { calls, run } = setup({ id: 'result-1' })

    await run(
      'checkpoint', 'create', 'workspace/a', 'before-refactor',
      '--context', '{"branch":"main"}',
      '--recipes', '[{"name":"tests","command":"npm test"}]',
      '--idempotency', 'checkpoint-create-1',
    )
    await run('job', 'cancel', 'job/a', '--idempotency', 'job-cancel-1')
    await run(
      'policy', 'create', 'restricted',
      '--board', '42',
      '--files', 'src/**,test/**',
      '--commands', 'npm test',
      '--hosts', 'example.com',
      '--secrets', 'CI',
      '--approval', 'ask',
      '--idempotency', 'policy-create-1',
    )

    expect(calls).toEqual([
      {
        method: 'POST',
        path: '/os/workspaces/workspace%2Fa/checkpoints',
        body: {
          name: 'before-refactor',
          context: { branch: 'main' },
          process_recipes: [{ name: 'tests', command: 'npm test' }],
          idempotency_key: 'checkpoint-create-1',
        },
      },
      {
        method: 'POST',
        path: '/os/jobs/job%2Fa/cancel',
        body: { idempotency_key: 'job-cancel-1' },
      },
      {
        method: 'POST',
        path: '/os/boards/42/policies',
        body: {
          name: 'restricted',
          file_globs: ['src/**', 'test/**'],
          command_globs: ['npm test'],
          network_hosts: ['example.com'],
          secret_names: ['CI'],
          approval_scope: 'ask',
          idempotency_key: 'policy-create-1',
        },
      },
    ])
  })

  it('generates a unique replay key when job creation omits one', async () => {
    const { calls, run } = setup({ job: { id: 'job-1', status: 'queued' } })

    await run('job', 'create', '7', '--board', '42')

    expect(calls[0]).toMatchObject({
      method: 'POST',
      path: '/os/boards/42/jobs',
      body: {
        card_id: 7,
        provider: 'claude',
        idempotency_key: expect.stringMatching(
          /^orchestra-cli:job-create:42:7:[0-9a-f-]{36}$/,
        ),
      },
    })
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
      '--idempotency', 'delivery-submit-1',
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
        idempotency_key: 'delivery-submit-1',
      },
    }])
  })

  it('accepts a plain stdin delivery summary and exposes review lifecycle commands', async () => {
    const { calls, run } = setup({ delivery: { id: 'delivery-1' } })

    await run(
      'delivery',
      'submit',
      'job-1',
      '--stdin',
      '--idempotency',
      'delivery-submit-stdin-1',
    )
    await run('delivery', 'verify', 'delivery-1', '--criteria', '[{"text":"works","met":"unverifiable"}]')
    await run(
      'delivery',
      'accept',
      'delivery-1',
      '--note',
      'reviewed',
      '--idempotency',
      'accept-1',
    )
    await run('delivery', 'reject', 'delivery-2', '--reason', 'missing evidence')
    await run('delivery', 'revise', 'delivery-2')
    await run('delivery', 'show', '7')

    expect(calls).toEqual([
      { method: 'POST', path: '/os/jobs/job-1/deliveries/submit', body: {
        actor: 'agent', summary: 'exact\nbytes',
        idempotency_key: 'delivery-submit-stdin-1',
      } },
      { method: 'POST', path: '/os/deliveries/delivery-1/verify', body: {
        actor: 'verifier', results: [{ text: 'works', met: 'unverifiable' }],
      } },
      { method: 'POST', path: '/os/deliveries/delivery-1/accept', body: {
        actor: 'human', note: 'reviewed',
        idempotency_key: 'accept-1',
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
