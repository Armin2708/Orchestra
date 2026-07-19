import { execFile } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { createAgentOsRuntime, type AgentOsRuntime } from '../src/agent-os/runtime-integration.js'
import { openDb } from '../src/db.js'
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

    expect(db.prepare("SELECT provider, status FROM agent_sessions WHERE json_extract(context_json, '$.job_id')=?").get(jobId))
      .toMatchObject({ provider: 'shell', status: 'stopped' })
    const output = (db.prepare(`SELECT o.data FROM process_output o JOIN processes p ON p.id=o.process_id
      WHERE p.workspace_id=? ORDER BY o.seq`).all(workspace.id) as Array<{ data: string }>).map((row) => row.data).join('')
    expect(output).toContain('verified')
    expect((db.prepare("SELECT COUNT(*) AS count FROM os_events WHERE kind='driver.exit' AND card_id=?").get(cardId) as { count: number }).count)
      .toBe(1)
  }, 25_000)

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
})
