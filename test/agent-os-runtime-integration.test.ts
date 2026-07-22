import { execFile } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { createAgentOsRuntime, type AgentOsRuntime } from '../src/agent-os/runtime-integration.js'
import { DeliveryReportService } from '../src/agent-os/delivery-reports.js'
import { openDb } from '../src/db.js'
import type { AgentDriver, DriverLaunchRequest } from '../src/runtime/index.js'
import { buildServer } from '../src/server.js'

const roots: string[] = []
const servers: FastifyInstance[] = []
const runtimes: AgentOsRuntime[] = []

const command = (file: string, args: string[], cwd: string) => new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
  execFile(file, args, { cwd }, (error, stdout, stderr) => {
    if (error) reject(error)
    else resolve({ stdout: String(stdout), stderr: String(stderr) })
  })
})

const git = (cwd: string, ...args: string[]) => command('git', args, cwd)
const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`

const until = async (condition: () => boolean | Promise<boolean>, timeoutMs = 15_000) => {
  const start = Date.now()
  while (!(await condition())) {
    if (Date.now() - start > timeoutMs) throw new Error('condition never became true')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

async function repository() {
  const base = await mkdtemp(path.join(os.tmpdir(), 'orchestra-agent-os-integration-'))
  roots.push(base)
  const repo = path.join(base, 'repo')
  await mkdir(repo)
  await git(repo, 'init', '-b', 'main')
  await git(repo, 'config', 'user.email', 'agent-os@test.invalid')
  await git(repo, 'config', 'user.name', 'Agent OS Test')
  await writeFile(path.join(repo, 'README.md'), 'base\n')
  await git(repo, 'add', 'README.md')
  await git(repo, 'commit', '-m', 'initial')
  return { base, repo }
}

async function fixture() {
  const { base, repo } = await repository()
  const db = openDb(':memory:')
  const boardId = Number(db.prepare('INSERT INTO boards (project_path, name) VALUES (?, ?)').run(repo, 'Agent OS').lastInsertRowid)
  const cardId = Number(db.prepare(`INSERT INTO cards (board_id, title, description)
    VALUES (?, 'Integrated task', 'exercise the complete runtime')`).run(boardId).lastInsertRowid)
  const runtime = createAgentOsRuntime(db)
  runtimes.push(runtime)
  const server = buildServer(db, undefined, {
    agentOs: {
      runtime: runtime.adapter,
      jobExecutor: runtime.jobExecutor,
      scheduler: runtime.scheduler,
      drivers: () => runtime.descriptors(),
    },
  })
  runtime.setBus(server.bus)
  servers.push(server)
  await server.ready()
  return { base, repo, db, boardId, cardId, runtime, server }
}

afterEach(async () => {
  await Promise.allSettled(servers.splice(0).map((server) => server.close()))
  await Promise.allSettled(runtimes.splice(0).map((runtime) => runtime.shutdown()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('Agent OS daemon runtime integration', () => {
  it('persists a real PTY lifecycle while preserving terminal input bytes and ordered output', async () => {
    const { db, boardId, repo, server } = await fixture()
    const workspaceResponse = await server.inject({
      method: 'POST',
      url: `/api/v1/os/boards/${boardId}/workspaces`,
      payload: { name: 'terminal', kind: 'shared', root_path: repo },
    })
    expect(workspaceResponse.statusCode).toBe(201)
    const workspace = workspaceResponse.json().workspace
    const script = [
      `process.stdout.write('ready\\n')`,
      `process.stdin.once('data',d=>{process.stdout.write('got:'+JSON.stringify(d.toString()));process.exit(0)})`,
    ].join(';')
    const started = await server.inject({
      method: 'POST',
      url: `/api/v1/os/workspaces/${workspace.id}/processes`,
      payload: {
        name: 'interactive-node',
        command: `${quote(process.execPath)} -e ${quote(script)}`,
        cols: 91,
        rows: 27,
        restartable: true,
      },
    })
    expect(started.statusCode).toBe(201)
    const processId = started.json().process.id as string
    expect(processId).toMatch(/^[0-9a-f-]{36}$/)

    await until(async () => {
      const page = await server.inject({ method: 'GET', url: `/api/v1/os/processes/${processId}/output` })
      return page.json().output.some((chunk: any) => chunk.data.includes('ready'))
    })
    expect((await server.inject({
      method: 'POST',
      url: `/api/v1/os/processes/${processId}/resize`,
      payload: { cols: 133, rows: 41 },
    })).statusCode).toBe(200)

    const exactInput = 'hello\tworld\r'
    expect((await server.inject({
      method: 'POST',
      url: `/api/v1/os/processes/${processId}/input`,
      payload: { data: exactInput },
    })).statusCode).toBe(200)
    await until(() => {
      const row = db.prepare('SELECT status FROM processes WHERE id=?').get(processId) as { status: string }
      return ['exited', 'failed'].includes(row.status)
    })

    const page = (await server.inject({ method: 'GET', url: `/api/v1/os/processes/${processId}/output?after=0` })).json()
    expect(page.output.map((chunk: any) => chunk.seq)).toEqual(page.output.map((_: any, index: number) => index + 1))
    expect(page.output.map((chunk: any) => chunk.data).join('')).toContain('got:')
    expect(db.prepare('SELECT status, exit_code, cols, rows FROM processes WHERE id=?').get(processId))
      .toMatchObject({ status: 'exited', exit_code: 0, cols: 133, rows: 41 })
    const inputEvents = db.prepare("SELECT payload FROM os_events WHERE process_id=? AND kind='process.input'").all(processId) as Array<{ payload: string }>
    expect(inputEvents).toHaveLength(1)
    expect(inputEvents.some((event) => JSON.parse(event.payload).bytes === Buffer.byteLength(exactInput))).toBe(true)
    expect(inputEvents.every((event) => !event.payload.includes('hello'))).toBe(true)
  }, 25_000)

  it('starts the host interactive shell and accepts typed commands immediately', async () => {
    const { boardId, repo, db, server } = await fixture()
    const workspace = (await server.inject({
      method: 'POST', url: `/api/v1/os/boards/${boardId}/workspaces`,
      payload: { name: 'host-shell', kind: 'shared', root_path: repo },
    })).json().workspace
    const started = await server.inject({
      method: 'POST', url: `/api/v1/os/workspaces/${workspace.id}/processes`,
      payload: { interactive: true, restartable: true, cols: 100, rows: 30 },
    })
    expect(started.statusCode).toBe(201)
    expect(started.json().process).toMatchObject({ name: 'shell', status: 'running', restartable: true })
    const processId = started.json().process.id as string

    const command = process.platform === 'win32' ? 'echo ORCHESTRA_INTERACTIVE_OK\r' : 'echo $((20+22))\r'
    expect((await server.inject({
      method: 'POST', url: `/api/v1/os/processes/${processId}/input`, payload: { data: command },
    })).statusCode).toBe(200)
    await until(async () => {
      const page = await server.inject({ method: 'GET', url: `/api/v1/os/processes/${processId}/output` })
      const output = page.json().output.map((chunk: any) => chunk.data).join('')
      return process.platform === 'win32' ? output.includes('ORCHESTRA_INTERACTIVE_OK') : output.includes('42\r\n')
    })

    const recipe = JSON.parse((db.prepare('SELECT recipe_json FROM processes WHERE id=?').get(processId) as { recipe_json: string }).recipe_json)
    expect(recipe).toMatchObject({ shell: false, args: process.platform === 'win32' ? [] : ['-l'], restartable: true })
    await server.inject({ method: 'POST', url: `/api/v1/os/processes/${processId}/input`, payload: { data: 'exit\r' } })
    await until(() => {
      const row = db.prepare('SELECT status FROM processes WHERE id=?').get(processId) as { status: string }
      return ['exited', 'failed'].includes(row.status)
    })
  }, 25_000)

  it('captures tracked and untracked changes, then forks and reapplies the checkpoint patch safely', async () => {
    const { boardId, cardId, repo, db, server } = await fixture()
    const created = await server.inject({
      method: 'POST',
      url: `/api/v1/os/boards/${boardId}/workspaces`,
      payload: {
        name: 'checkpoint-source',
        kind: 'worktree',
        card_id: cardId,
        root_path: repo,
        branch: 'agent-os/checkpoint-source',
      },
    })
    expect(created.statusCode).toBe(201)
    const source = created.json().workspace
    await writeFile(path.join(source.worktree_path, 'README.md'), 'modified\n')
    await writeFile(path.join(source.worktree_path, 'new file.txt'), 'untracked\n')

    const captured = await server.inject({
      method: 'POST',
      url: `/api/v1/os/workspaces/${source.id}/checkpoints`,
      payload: { name: 'before-experiment', context: { focus: 'checkpoint replay' } },
    })
    expect(captured.statusCode).toBe(201)
    const checkpoint = captured.json().checkpoint
    expect(checkpoint.patch_artifact_id).toMatch(/^[0-9a-f-]{36}$/)
    const patch = db.prepare('SELECT content FROM artifacts WHERE id=?').get(checkpoint.patch_artifact_id) as { content: string }
    expect(patch.content).toContain('README.md')
    expect(patch.content).toContain('new file.txt')

    const forked = await server.inject({
      method: 'POST',
      url: `/api/v1/os/checkpoints/${checkpoint.id}/fork`,
      payload: { name: 'checkpoint-fork', branch: 'agent-os/checkpoint-fork' },
    })
    expect(forked.statusCode).toBe(201)
    const fork = forked.json().workspace
    expect(await readFile(path.join(fork.worktree_path, 'README.md'), 'utf8')).toBe('modified\n')
    expect(await readFile(path.join(fork.worktree_path, 'new file.txt'), 'utf8')).toBe('untracked\n')
    expect((await git(repo, 'branch', '--show-current')).stdout.trim()).toBe('main')
    expect(fork.worktree_path).not.toBe(source.worktree_path)
  }, 25_000)

  it('runs a durable shell job to completion through the provider-neutral scheduler', async () => {
    const { boardId, cardId, repo, db, server } = await fixture()
    const workspace = (await server.inject({
      method: 'POST',
      url: `/api/v1/os/boards/${boardId}/workspaces`,
      payload: { name: 'verification', kind: 'shared', card_id: cardId, root_path: repo },
    })).json().workspace
    const commandText = `${quote(process.execPath)} -e ${quote(`process.stdout.write('verified\\n')`)}`
    const contract = await server.inject({
      method: 'PUT',
      url: `/api/v1/os/cards/${cardId}/contract`,
      payload: { workspace_id: workspace.id, verify_commands: [commandText] },
    })
    expect(contract.statusCode).toBe(200)

    const response = await server.inject({
      method: 'POST',
      url: `/api/v1/os/boards/${boardId}/jobs`,
      payload: { card_id: cardId, workspace_id: workspace.id, provider: 'shell', max_attempts: 1 },
    })
    expect(response.statusCode).toBe(201)
    const jobId = response.json().job.id as string
    await until(() => (db.prepare('SELECT status FROM jobs WHERE id=?').get(jobId) as { status: string }).status === 'succeeded')
    await until(() => (db.prepare('SELECT column_name FROM cards WHERE id=?').get(cardId) as { column_name: string }).column_name === 'review')

    expect(db.prepare("SELECT provider, status FROM agent_sessions WHERE json_extract(context_json, '$.job_id')=?").get(jobId))
      .toMatchObject({ provider: 'shell', status: 'stopped' })
    const output = (db.prepare(`SELECT o.data FROM process_output o JOIN processes p ON p.id=o.process_id
      WHERE p.workspace_id=? ORDER BY o.seq`).all(workspace.id) as Array<{ data: string }>).map((row) => row.data).join('')
    expect(output).toContain('verified')
    expect((db.prepare("SELECT COUNT(*) AS count FROM os_events WHERE kind='driver.exit' AND card_id=?").get(cardId) as { count: number }).count)
      .toBe(1)
    const delivery = new DeliveryReportService(db).currentForCard(cardId)
    expect(delivery).toMatchObject({ job_id: jobId, status: 'submitted' })
    expect(delivery?.claims.map((claim) => claim.text).join('\n')).toContain('verified')
    expect(delivery?.criterion_results.every((result) => result.outcome === 'unverifiable')).toBe(true)
    expect(delivery?.artifact_ids).toHaveLength(1)
  }, 25_000)

  it('attaches a runtime-created workspace and session to the prepared delivery report', async () => {
    const { boardId, cardId, db, server } = await fixture()
    const commandText = `${quote(process.execPath)} -e ${quote(`process.stdout.write('runtime scope\\n')`)}`
    expect((await server.inject({
      method: 'PUT', url: `/api/v1/os/cards/${cardId}/contract`, payload: { verify_commands: [commandText] },
    })).statusCode).toBe(200)

    const response = await server.inject({
      method: 'POST', url: `/api/v1/os/boards/${boardId}/jobs`,
      payload: { card_id: cardId, provider: 'shell', max_attempts: 1 },
    })
    expect(response.statusCode).toBe(201)
    const jobId = response.json().job.id as string
    await until(() => (db.prepare('SELECT status FROM jobs WHERE id=?').get(jobId) as { status: string }).status === 'succeeded')

    const job = db.prepare('SELECT workspace_id FROM jobs WHERE id=?').get(jobId) as { workspace_id: string }
    const session = db.prepare(`SELECT id, workspace_id FROM agent_sessions
      WHERE json_extract(context_json, '$.job_id')=?`).get(jobId) as { id: string; workspace_id: string }
    const delivery = new DeliveryReportService(db).currentForCard(cardId)
    expect(job.workspace_id).toBeTruthy()
    expect(session.workspace_id).toBe(job.workspace_id)
    expect(delivery).toMatchObject({ job_id: jobId, workspace_id: job.workspace_id, session_id: session.id })
  }, 25_000)

  it('launches managed agent jobs with least-privilege defaults', async () => {
    const { boardId, repo, db, runtime, server } = await fixture()
    const requests: DriverLaunchRequest[] = []
    const driver: AgentDriver = {
      id: 'claude',
      capabilities: () => ({
        attach: true, streaming: true, interrupt: true, stop: true, rawTerminal: false, resume: true,
      }),
      launch: async (request) => {
        requests.push(request)
        return {
          id: 'claude:least-privilege', externalId: 'least-privilege', driverId: 'claude',
          workspaceId: request.workspaceId, status: 'running', startedAt: new Date().toISOString(), metadata: {},
        }
      },
      attach: async () => null,
      send: async () => undefined,
      interrupt: async () => undefined,
      stop: async () => undefined,
      events: async function* (sessionId) {
        yield { sessionId, seq: 1, type: 'exit', at: new Date().toISOString(), data: 'completed' }
      },
    }
    runtime.registerDriver(driver)
    const workspace = (await server.inject({
      method: 'POST', url: `/api/v1/os/boards/${boardId}/workspaces`,
      payload: { name: 'least-privilege', kind: 'shared', root_path: repo },
    })).json().workspace
    const response = await server.inject({
      method: 'POST', url: `/api/v1/os/boards/${boardId}/jobs`,
      payload: { workspace_id: workspace.id, provider: 'claude', max_attempts: 1 },
    })
    expect(response.statusCode).toBe(201)
    const jobId = response.json().job.id as string
    await until(() => (db.prepare('SELECT status FROM jobs WHERE id=?').get(jobId) as { status: string }).status === 'succeeded')

    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ accessProfile: 'workspace_write', permissionMode: 'default' })
    expect(db.prepare("SELECT access_profile FROM agents WHERE session_id=?").get(`agent-os:${jobId}`))
      .toMatchObject({ access_profile: 'workspace_write' })
  })

  it('hands agents the frozen Asked contract and idempotently converts final output into a review report', async () => {
    const { boardId, cardId, repo, db, runtime, server } = await fixture()
    const requests: DriverLaunchRequest[] = []
    const driver: AgentDriver = {
      id: 'test-agent',
      capabilities: () => ({
        attach: true, streaming: true, interrupt: true, stop: true, rawTerminal: false, resume: true,
      }),
      launch: async (request) => {
        requests.push(request)
        return {
          id: 'test-agent:delivery', externalId: 'delivery-thread', driverId: 'test-agent',
          workspaceId: request.workspaceId, status: 'running', startedAt: new Date().toISOString(), metadata: {},
        }
      },
      attach: async () => null,
      send: async () => undefined,
      interrupt: async () => undefined,
      stop: async () => undefined,
      events: async function* (sessionId) {
        yield {
          sessionId, seq: 1, type: 'output', at: new Date().toISOString(),
          data: 'Delivery summary: implemented the frozen contract.\nEvidence: npm test passed.',
        }
        yield { sessionId, seq: 2, type: 'exit', at: new Date().toISOString(), data: 'completed' }
      },
    }
    runtime.registerDriver(driver)
    const workspace = (await server.inject({
      method: 'POST', url: `/api/v1/os/boards/${boardId}/workspaces`,
      payload: { name: 'delivery-runtime', kind: 'shared', card_id: cardId, root_path: repo },
    })).json().workspace
    const contract = await server.inject({
      method: 'PUT', url: `/api/v1/os/cards/${cardId}/contract`,
      payload: {
        workspace_id: workspace.id,
        deliverables: [{ id: 'deliverable-stable', text: 'Implement the runtime bridge', required: true }],
        acceptance_criteria: [{
          id: 'criterion-stable', text: 'The report reaches review', required: true,
          deliverable_ids: ['deliverable-stable'],
        }],
        verify_commands: ['npm test'],
      },
    })
    expect(contract.statusCode).toBe(200)

    const response = await server.inject({
      method: 'POST', url: `/api/v1/os/boards/${boardId}/jobs`,
      payload: { card_id: cardId, workspace_id: workspace.id, provider: 'test-agent' },
    })
    expect(response.statusCode).toBe(201)
    const jobId = response.json().job.id as string
    await until(() => (db.prepare('SELECT status FROM jobs WHERE id=?').get(jobId) as { status: string }).status === 'succeeded')
    await until(() => (db.prepare('SELECT column_name FROM cards WHERE id=?').get(cardId) as { column_name: string }).column_name === 'review')

    expect(requests).toHaveLength(1)
    expect(requests[0].prompt).toContain('[deliverable-stable] Implement the runtime bridge')
    expect(requests[0].prompt).toContain('[criterion-stable] The report reaches review')
    expect(requests[0].prompt).toContain('Required verification commands:\n- npm test')
    expect(requests[0].prompt).toContain('Delivery summary:')
    expect(requests[0].prompt).toContain('Evidence:')

    const reports = new DeliveryReportService(db)
    const delivery = reports.currentForCard(cardId)!
    expect(delivery).toMatchObject({ job_id: jobId, status: 'submitted' })
    expect(delivery.summary).toContain('implemented the frozen contract')
    expect(delivery.claims).toEqual([expect.objectContaining({
      text: expect.stringContaining('Evidence: npm test passed'),
    })])
    expect(delivery.deliverable_results).toEqual([
      expect.objectContaining({ deliverable_id: 'deliverable-stable', outcome: 'unverifiable' }),
    ])
    expect(delivery.criterion_results).toEqual([
      expect.objectContaining({ criterion_id: 'criterion-stable', outcome: 'unverifiable' }),
    ])

    const session = db.prepare(`SELECT id FROM agent_sessions
      WHERE json_extract(context_json, '$.job_id')=?`).get(jobId) as { id: string }
    const job = runtime.scheduler.get(jobId)!
    ;(runtime.jobExecutor as any).finalizeManagedAgent(job, session.id, undefined, 'succeeded')
    ;(runtime.jobExecutor as any).finalizeManagedAgent(job, session.id, undefined, 'succeeded')

    expect(new DeliveryReportService(db).listCard(cardId)).toHaveLength(1)
    expect((db.prepare("SELECT COUNT(*) AS count FROM os_events WHERE card_id=? AND kind='delivery.runtime_evidence'")
      .get(cardId) as { count: number }).count).toBe(1)
    expect((db.prepare("SELECT COUNT(*) AS count FROM artifacts WHERE card_id=? AND kind='evidence_bundle'")
      .get(cardId) as { count: number }).count).toBe(1)
    expect((db.prepare("SELECT COUNT(*) AS count FROM card_events WHERE card_id=? AND type='agent_os_job_finished'")
      .get(cardId) as { count: number }).count).toBe(1)
  })

  it('blocks the card and raises attention when a successful provider cannot produce a review-ready report', async () => {
    const { boardId, cardId, repo, db, runtime, server } = await fixture()
    const driver: AgentDriver = {
      id: 'missing-report-agent',
      capabilities: () => ({
        attach: true, streaming: true, interrupt: true, stop: true, rawTerminal: false, resume: true,
      }),
      launch: async (request) => ({
        id: 'missing-report:session', externalId: 'missing-report-thread', driverId: 'missing-report-agent',
        workspaceId: request.workspaceId, status: 'running', startedAt: new Date().toISOString(), metadata: {},
      }),
      attach: async () => null,
      send: async () => undefined,
      interrupt: async () => undefined,
      stop: async () => undefined,
      events: async function* (sessionId) {
        yield { sessionId, seq: 1, type: 'output', at: new Date().toISOString(), data: 'I finished the task.' }
        yield { sessionId, seq: 2, type: 'exit', at: new Date().toISOString(), data: 'completed' }
      },
    }
    runtime.registerDriver(driver)
    const workspace = (await server.inject({
      method: 'POST', url: `/api/v1/os/boards/${boardId}/workspaces`,
      payload: { name: 'missing-report', kind: 'shared', card_id: cardId, root_path: repo },
    })).json().workspace
    ;(runtime.jobExecutor as any).deliveries.completeRuntime = () => {
      throw new Error('structured delivery report is unavailable')
    }

    const response = await server.inject({
      method: 'POST', url: `/api/v1/os/boards/${boardId}/jobs`,
      payload: { card_id: cardId, workspace_id: workspace.id, provider: 'missing-report-agent' },
    })
    const jobId = response.json().job.id as string
    await until(() => (db.prepare('SELECT status FROM jobs WHERE id=?').get(jobId) as { status: string }).status === 'succeeded')
    await until(() => (db.prepare('SELECT column_name FROM cards WHERE id=?').get(cardId) as { column_name: string }).column_name === 'blocked')

    expect(new DeliveryReportService(db).currentForCard(cardId)).toMatchObject({ job_id: jobId, status: 'draft' })
    expect(db.prepare(`SELECT kind, severity, detail FROM attention_items WHERE card_id=? AND status='open'`).get(cardId))
      .toMatchObject({
        kind: 'delivery.report_blocked',
        severity: 'high',
        detail: 'structured delivery report is unavailable',
      })
    expect((db.prepare("SELECT COUNT(*) AS count FROM card_events WHERE card_id=? AND type='review_request'")
      .get(cardId) as { count: number }).count).toBe(0)
  })

  it('reconciles orphaned process records as lost and raises durable attention', async () => {
    const { boardId, repo, db, runtime, server } = await fixture()
    const workspace = (await server.inject({
      method: 'POST',
      url: `/api/v1/os/boards/${boardId}/workspaces`,
      payload: { name: 'restart-recovery', kind: 'shared', root_path: repo },
    })).json().workspace
    db.prepare(`INSERT INTO processes
      (id, workspace_id, name, command, cwd, status, pid, restartable, started_at)
      VALUES ('orphaned-process', ?, 'dev server', 'npm run dev', ?, 'running', 999999, 1, datetime('now'))`)
      .run(workspace.id, repo)

    const lost = await runtime.reconcileLost()

    expect(lost).toEqual([expect.objectContaining({ id: 'orphaned-process', status: 'lost', pid: null })])
    expect(db.prepare("SELECT kind, severity, status FROM attention_items WHERE workspace_id=?").get(workspace.id))
      .toMatchObject({ kind: 'process.lost', severity: 'high', status: 'open' })
  })

  it('persists exact restart recipes, keeps environment overrides, and rejects cwd escapes', async () => {
    const { boardId, repo, db, server } = await fixture()
    const workspace = (await server.inject({
      method: 'POST',
      url: `/api/v1/os/boards/${boardId}/workspaces`,
      payload: { name: 'restartable', kind: 'shared', root_path: repo, env: { WORKSPACE_VALUE: 'workspace' } },
    })).json().workspace
    expect((db.prepare("SELECT COUNT(*) AS count FROM os_events WHERE workspace_id=? AND kind='workspace.created'")
      .get(workspace.id) as { count: number }).count).toBe(1)

    const escaped = await server.inject({
      method: 'POST',
      url: `/api/v1/os/workspaces/${workspace.id}/processes`,
      payload: { command: 'pwd', cwd: path.dirname(repo) },
    })
    expect(escaped.statusCode).toBe(400)
    expect((db.prepare('SELECT COUNT(*) AS count FROM processes WHERE workspace_id=?').get(workspace.id) as { count: number }).count)
      .toBe(0)

    const script = `process.stdout.write(process.env.RESTART_VALUE+'/'+process.env.WORKSPACE_VALUE+'\\n')`
    const started = await server.inject({
      method: 'POST',
      url: `/api/v1/os/workspaces/${workspace.id}/processes`,
      payload: {
        name: 'restart-env',
        command: `${quote(process.execPath)} -e ${quote(script)}`,
        env: { RESTART_VALUE: 'exact' },
        restartable: true,
      },
    })
    expect(started.statusCode).toBe(201)
    const firstId = started.json().process.id as string
    await until(() => (db.prepare('SELECT status FROM processes WHERE id=?').get(firstId) as { status: string }).status === 'exited')
    expect(JSON.parse((db.prepare('SELECT recipe_json FROM processes WHERE id=?').get(firstId) as { recipe_json: string }).recipe_json).env)
      .toMatchObject({ RESTART_VALUE: 'exact', WORKSPACE_VALUE: 'workspace' })

    const restarted = await server.inject({ method: 'POST', url: `/api/v1/os/processes/${firstId}/restart` })
    expect(restarted.statusCode).toBe(201)
    const restartedId = restarted.json().process.id as string
    expect(restartedId).not.toBe(firstId)
    await until(() => (db.prepare('SELECT status FROM processes WHERE id=?').get(restartedId) as { status: string }).status === 'exited')
    const output = (await server.inject({ method: 'GET', url: `/api/v1/os/processes/${restartedId}/output` })).json().output
    expect(output.map((chunk: any) => chunk.data).join('')).toContain('exact/workspace')
  }, 25_000)

  it('recovers orphaned running jobs instead of leaving them permanently active', async () => {
    const { boardId, repo, db, runtime, server } = await fixture()
    const workspace = (await server.inject({
      method: 'POST',
      url: `/api/v1/os/boards/${boardId}/workspaces`,
      payload: { name: 'job-recovery', kind: 'shared', root_path: repo },
    })).json().workspace
    const job = runtime.scheduler.create({ boardId, workspaceId: workspace.id, provider: 'shell', maxAttempts: 1 })
    db.prepare("UPDATE jobs SET status='running', attempts=1, started_at=datetime('now') WHERE id=?").run(job.id)
    db.prepare(`INSERT INTO agent_sessions
      (id, workspace_id, provider, status, context_json, created_at, updated_at)
      VALUES ('orphaned-session', ?, 'shell', 'running', ?, datetime('now'), datetime('now'))`)
      .run(workspace.id, JSON.stringify({ job_id: job.id }))

    const recovered = await runtime.reconcileJobs()

    expect(recovered).toEqual({ resumed: [], recovered: [job.id] })
    expect(runtime.scheduler.get(job.id)).toMatchObject({ status: 'blocked', attempts: 1 })
    expect(db.prepare("SELECT status FROM agent_sessions WHERE id='orphaned-session'")).toBeTruthy()
    expect((db.prepare("SELECT status FROM agent_sessions WHERE id='orphaned-session'").get() as { status: string }).status).toBe('failed')
  })

  it('keeps a recovered canonical job out of review and preserves its draft for revision', async () => {
    const { boardId, cardId, repo, db, runtime, server } = await fixture()
    const workspace = (await server.inject({
      method: 'POST', url: `/api/v1/os/boards/${boardId}/workspaces`,
      payload: { name: 'canonical-recovery', kind: 'shared', card_id: cardId, root_path: repo },
    })).json().workspace
    const job = runtime.scheduler.create({
      boardId, cardId, workspaceId: workspace.id, provider: 'shell', maxAttempts: 1,
    })
    const delivery = new DeliveryReportService(db).prepareForJob(job.id)
    db.prepare("UPDATE jobs SET status='running', attempts=1, started_at=datetime('now') WHERE id=?").run(job.id)
    db.prepare("UPDATE cards SET column_name='in_progress' WHERE id=?").run(cardId)
    db.prepare(`INSERT INTO agent_sessions
      (id, workspace_id, provider, status, context_json, created_at, updated_at)
      VALUES ('canonical-orphan', ?, 'shell', 'running', ?, datetime('now'), datetime('now'))`)
      .run(workspace.id, JSON.stringify({ job_id: job.id, card_id: cardId }))

    expect(await runtime.reconcileJobs()).toEqual({ resumed: [], recovered: [job.id] })
    expect(await runtime.reconcileJobs()).toEqual({ resumed: [], recovered: [] })
    expect(runtime.scheduler.get(job.id)?.status).toBe('blocked')
    expect((db.prepare('SELECT column_name FROM cards WHERE id=?').get(cardId) as { column_name: string }).column_name)
      .toBe('blocked')
    expect(new DeliveryReportService(db).get(delivery.id).status).toBe('draft')
    expect((db.prepare("SELECT COUNT(*) AS count FROM card_events WHERE card_id=? AND type='agent_os_job_finished'")
      .get(cardId) as { count: number }).count).toBe(1)
    expect((db.prepare("SELECT COUNT(*) AS count FROM card_events WHERE card_id=? AND type='review_request'")
      .get(cardId) as { count: number }).count).toBe(0)
  })

  it('continues a resumable Claude job after daemon restart instead of attaching it idle', async () => {
    const { boardId, repo, db, runtime, server } = await fixture()
    const sent: Array<[string, string]> = []
    const driver: AgentDriver = {
      id: 'claude',
      capabilities: () => ({
        attach: true, streaming: true, interrupt: true, stop: true, rawTerminal: false, resume: true,
      }),
      launch: async () => { throw new Error('not used') },
      attach: async () => ({
        id: 'claude:resumed', externalId: 'claude-thread', driverId: 'claude', workspaceId: 'restart-workspace',
        status: 'idle', startedAt: new Date().toISOString(), metadata: {},
      }),
      send: async (sessionId, text) => { sent.push([sessionId, text]) },
      interrupt: async () => undefined,
      stop: async () => undefined,
      events: async function* (sessionId) {
        yield { sessionId, seq: 1, type: 'exit', at: new Date().toISOString(), data: 'Claude session stopped' }
      },
    }
    runtime.registerDriver(driver)
    const workspace = (await server.inject({
      method: 'POST', url: `/api/v1/os/boards/${boardId}/workspaces`,
      payload: { id: 'restart-workspace', name: 'restart-claude', kind: 'shared', root_path: repo },
    })).json().workspace
    const job = runtime.scheduler.create({ boardId, workspaceId: workspace.id, provider: 'claude', maxAttempts: 1 })
    db.prepare("UPDATE jobs SET status='running', attempts=1, started_at=datetime('now') WHERE id=?").run(job.id)
    db.prepare(`INSERT INTO agent_sessions
      (id, workspace_id, provider, external_id, status, context_json, created_at, updated_at)
      VALUES ('resumable-claude-session', ?, 'claude', 'claude-thread', 'running', ?, datetime('now'), datetime('now'))`)
      .run(workspace.id, JSON.stringify({ job_id: job.id }))

    expect(await runtime.reconcileJobs()).toEqual({ resumed: [job.id], recovered: [] })
    expect(sent).toEqual([[
      'claude:resumed',
      expect.stringMatching(/daemon restarted.*continue the existing job/i),
    ]])
  })
})
