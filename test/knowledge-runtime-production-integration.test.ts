import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import {
  KnowledgeService,
  TaskContractService,
  WorkspaceStore,
  knowledgeChunkId,
  knowledgeSourceId,
  type KnowledgeChunk,
  type KnowledgeSource,
} from '../src/agent-os/index.js'
import { createAgentOsRuntime, type AgentOsRuntime } from '../src/agent-os/runtime-integration.js'
import {
  installKnowledgeContextUseActualEvidenceSchema,
} from '../src/agent-os/knowledge-context-use-actual-migration.js'
import { openDb } from '../src/db.js'
import {
  CodexManagedAgentRuntime,
  type ManagedAgentDriver,
} from '../src/provider-agent-manager.js'
import type {
  DriverCapabilities,
  DriverEvent,
  DriverLaunchRequest,
  DriverSession,
} from '../src/runtime/types.js'

type Feed = { queue: DriverEvent[]; waiting: Array<() => void>; closed: boolean }

class RuntimeDriver implements ManagedAgentDriver {
  readonly id = 'codex'
  readonly launches: DriverLaunchRequest[] = []
  readonly sends: Array<[string, string]> = []
  readonly sessions = new Map<string, DriverSession>()
  failLaunches = 0
  private readonly feeds = new Map<string, Feed>()
  private sequence = 0

  capabilities(): DriverCapabilities & { tokenBudget: true; costBudget: true } {
    return {
      attach: true,
      streaming: true,
      interrupt: true,
      stop: true,
      rawTerminal: false,
      resume: true,
      tokenBudget: true,
      costBudget: true,
    }
  }

  async launch(request: DriverLaunchRequest): Promise<DriverSession> {
    this.launches.push(request)
    if (this.failLaunches > 0) {
      this.failLaunches -= 1
      throw new Error('planned provider launch failure')
    }
    const sequence = ++this.sequence
    const session: DriverSession = {
      id: `runtime-session-${sequence}`,
      externalId: request.externalId ?? `runtime-thread-${sequence}`,
      driverId: this.id,
      workspaceId: request.workspaceId,
      status: 'running',
      startedAt: new Date().toISOString(),
      metadata: { ...request.metadata },
    }
    this.sessions.set(session.id, session)
    this.feeds.set(session.id, { queue: [], waiting: [], closed: false })
    return session
  }

  async attach(externalId: string): Promise<DriverSession | null> {
    return [...this.sessions.values()].find((session) => session.externalId === externalId) ?? null
  }

  async send(sessionId: string, text: string): Promise<void> {
    this.sends.push([sessionId, text])
  }

  async interrupt(): Promise<void> {}

  async stop(sessionId: string): Promise<void> {
    this.emit(sessionId, { type: 'exit', data: 'completed' })
  }

  async detach(sessionId: string): Promise<void> {
    const feed = this.feeds.get(sessionId)
    if (!feed) return
    feed.closed = true
    feed.waiting.splice(0).forEach((wake) => wake())
  }

  async *events(sessionId: string): AsyncIterable<DriverEvent> {
    const feed = this.feeds.get(sessionId)
    if (!feed) return
    while (!feed.closed) {
      if (feed.queue.length === 0) {
        await new Promise<void>((resolve) => feed.waiting.push(resolve))
        continue
      }
      const event = feed.queue.shift()!
      yield event
      if (event.type === 'exit') {
        feed.closed = true
        return
      }
    }
  }

  emit(
    sessionId: string,
    event: Pick<DriverEvent, 'type' | 'data'> & { metadata?: Record<string, unknown> },
  ): void {
    const feed = this.feeds.get(sessionId)
    if (!feed) throw new Error(`missing event feed: ${sessionId}`)
    feed.queue.push({
      sessionId,
      seq: feed.queue.length + 1,
      at: new Date().toISOString(),
      ...event,
    })
    feed.waiting.splice(0).forEach((wake) => wake())
  }
}

const roots: string[] = []
const databases: Database.Database[] = []
const runtimes: AgentOsRuntime[] = []
const ambientRuntimes: CodexManagedAgentRuntime[] = []

afterEach(async () => {
  await Promise.allSettled(ambientRuntimes.splice(0).map((runtime) => runtime.shutdown()))
  await Promise.allSettled(runtimes.splice(0).map((runtime) => runtime.shutdown()))
  for (const db of databases.splice(0)) if (db.open) db.close()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const command = (file: string, args: string[], cwd: string) =>
  new Promise<string>((resolve, reject) => {
    execFile(file, args, { cwd }, (error, stdout) => {
      if (error) reject(error)
      else resolve(String(stdout).trim())
    })
  })

const git = (cwd: string, ...args: string[]) => command('git', args, cwd)
const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')

async function repository(): Promise<{ root: string; head: string }> {
  const base = await mkdtemp(path.join(os.tmpdir(), 'orchestra-knowledge-runtime-'))
  roots.push(base)
  const root = path.join(base, 'repo')
  await mkdir(root)
  await git(root, 'init', '-b', 'main')
  await git(root, 'config', 'user.email', 'knowledge-runtime@test.invalid')
  await git(root, 'config', 'user.name', 'Knowledge Runtime Test')
  await writeFile(path.join(root, 'README.md'), 'initial\n')
  await git(root, 'add', 'README.md')
  await git(root, 'commit', '-m', 'initial')
  return { root, head: await git(root, 'rev-parse', 'HEAD') }
}

function putKnowledge(
  db: Database.Database,
  boardId: number,
  head: string,
  label: string,
  content: string,
): void {
  const service = new KnowledgeService(db)
  const now = new Date().toISOString()
  const locator = `docs/${label}.md`
  const sourceValue: Omit<KnowledgeSource, 'id'> = {
    source_kind: 'documentation',
    trust_class: 'reference',
    title: `Runtime knowledge ${label}`,
    locator,
    normalized_locator: locator,
    source_revision: `commit:${head}:${label}`,
    content_sha256: sha256(content),
    freshness_policy: 'commit_exact',
    freshness_state: 'fresh',
    redaction_state: 'none',
    content_state: 'present',
    ingest_state: 'active',
    access_scope: { kind: 'board' },
    targets: {
      board_id: boardId,
      workspace_id: null,
      card_id: null,
      contract_ref: null,
      contract_version: null,
      contract_snapshot_sha256: null,
      job_id: null,
      profile_id: null,
      session_id: null,
      delivery_report_id: null,
    },
    provenance: {
      repository_key: 'runtime-integration-repo',
      base_commit_sha: head,
      worktree_state_hash: null,
      relative_root: '.',
      adapter_id: 'runtime-integration-test',
      adapter_version: '1.0.0',
      adapter_index_commit_sha: null,
      observed_at: now,
    },
    created_at: now,
    updated_at: now,
  }
  const source: KnowledgeSource = {
    ...sourceValue,
    id: knowledgeSourceId({
      repository_key: sourceValue.provenance.repository_key,
      source_kind: sourceValue.source_kind,
      normalized_locator: sourceValue.normalized_locator,
      source_revision: sourceValue.source_revision,
      content_sha256: sourceValue.content_sha256,
    }),
  }
  const range = {
    start_line: 1,
    end_line: 1,
    start_byte: 0,
    end_byte: Buffer.byteLength(content, 'utf8'),
  }
  const chunkValue: Omit<KnowledgeChunk, 'id'> = {
    source_id: source.id,
    ordinal: 0,
    content,
    content_sha256: sha256(content),
    character_count: content.length,
    byte_count: Buffer.byteLength(content, 'utf8'),
    estimated_tokens: Math.max(1, Math.ceil(content.length / 4)),
    source_range: range,
    symbol: null,
    created_at: now,
  }
  service.putSource(source)
  service.putChunk(boardId, {
    ...chunkValue,
    id: knowledgeChunkId({
      source_id: source.id,
      ordinal: 0,
      content_sha256: chunkValue.content_sha256,
      source_range: range,
    }),
  })
  service.synchronizeRetrievalIndex({ board_id: boardId, indexed_at: now })
}

async function until(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const started = Date.now()
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error('condition never became true')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

describe('knowledge runtime production wiring', () => {
  it('recompiles at live HEAD and attributes initial and follow-up contexts from provider input deltas', async () => {
    const repositoryState = await repository()
    const db = openDb(':memory:')
    installKnowledgeContextUseActualEvidenceSchema(db)
    databases.push(db)
    const boardId = Number(db.prepare('INSERT INTO boards (project_path, name) VALUES (?, ?)')
      .run(repositoryState.root, 'Knowledge runtime').lastInsertRowid)
    const cardId = Number(db.prepare(`INSERT INTO cards (board_id, title, description)
      VALUES (?, 'Live head knowledge retry context', 'Live head knowledge retry context')`)
      .run(boardId).lastInsertRowid)
    const contract = new TaskContractService(db).put(cardId, {
      objective: 'Live head knowledge retry context',
      acceptance_criteria: ['Live head knowledge retry context remains exact'],
      verify_commands: ['npm test'],
      budget_tokens: 5_000,
    })
    const workspace = new WorkspaceStore(db).create({
      boardId,
      cardId,
      name: 'Knowledge runtime',
      kind: 'shared',
      rootPath: repositoryState.root,
      status: 'active',
    })
    putKnowledge(db, boardId, repositoryState.head, 'head-one',
      'Live head knowledge retry context HEAD_ONE must never survive a retry.')

    const driver = new RuntimeDriver()
    driver.failLaunches = 1
    const runtime = createAgentOsRuntime(db)
    runtimes.push(runtime)
    runtime.registerDriver(driver)
    const job = runtime.scheduler.create({
      boardId,
      cardId,
      workspaceId: workspace.id,
      provider: 'codex',
      driverId: 'codex',
      contractVersion: contract.version,
      budgetTokens: 5_000,
      maxAttempts: 3,
    })

    const firstTick = await runtime.scheduler.tick()
    expect(driver.launches, JSON.stringify({ firstTick, job: runtime.scheduler.get(job.id) }))
      .toHaveLength(1)
    expect(driver.launches[0].prompt).toContain('HEAD_ONE')
    expect(db.prepare('SELECT outcome FROM context_uses').get()).toEqual({ outcome: 'failed' })

    await writeFile(path.join(repositoryState.root, 'README.md'), 'second\n')
    await git(repositoryState.root, 'add', 'README.md')
    await git(repositoryState.root, 'commit', '-m', 'second')
    const secondHead = await git(repositoryState.root, 'rev-parse', 'HEAD')
    putKnowledge(db, boardId, secondHead, 'head-two',
      'Live head knowledge retry context HEAD_TWO is the only retry context.')

    await runtime.scheduler.tick()
    expect(driver.launches).toHaveLength(2)
    expect(driver.launches[1].prompt).toContain('HEAD_TWO')
    expect(driver.launches[1].prompt).not.toContain('HEAD_ONE')
    const retainedBrief = db.prepare('SELECT agent_brief FROM jobs WHERE id=?').get(job.id) as
      { agent_brief: string }
    expect(retainedBrief.agent_brief).not.toContain('HEAD_ONE')
    expect(retainedBrief.agent_brief).not.toContain('HEAD_TWO')
    const buildBudgets = (db.prepare(`SELECT
      json_extract(request_json, '$.budget.max_tokens') AS max_tokens
      FROM context_builds ORDER BY created_at, rowid`).all() as Array<{ max_tokens: number }>)
      .map((row) => row.max_tokens)
    expect(buildBudgets).toEqual([1_000, 1_000])

    const liveSession = driver.sessions.values().next().value as DriverSession
    const sessionContext = () => JSON.parse((db.prepare(
      'SELECT context_json FROM agent_sessions WHERE job_id=?',
    ).get(job.id) as { context_json: string }).context_json) as Record<string, unknown>
    expect(sessionContext()).not.toHaveProperty('knowledge_context_input_tokens')
    expect(sessionContext()).not.toHaveProperty('knowledge_context_input_source')
    driver.emit(liveSession.id, {
      type: 'output',
      data: 'Initial turn reports authoritative provider input.',
      metadata: {
        tokenUsage: {
          total: {
            total_tokens: 150,
            input_tokens: 120,
            cached_input_tokens: 0,
            output_tokens: 30,
            reasoning_output_tokens: 0,
          },
        },
      },
    })
    await until(() => sessionContext().knowledge_context_input_tokens === 120)
    expect(sessionContext().knowledge_context_input_source).toBe('provider_input_delta')

    putKnowledge(db, boardId, secondHead, 'follow-up',
      'Inspect the new followup delta FOLLOW_UP_ONLY with exact source evidence.')
    const agent = db.prepare('SELECT id FROM agents WHERE session_id=?').get(`agent-os:${job.id}`) as
      { id: number }
    expect(runtime.jobExecutor.taskAgent(agent.id, 'Inspect the new followup delta')).toBe(true)
    await until(() => driver.sends.length === 1)
    expect(driver.sends[0][1]).toContain('WORKING_MEMORY_DELTA')
    expect(driver.sends[0][1]).toContain('FOLLOW_UP_ONLY')
    expect(sessionContext()).not.toHaveProperty('knowledge_context_input_tokens')
    expect(sessionContext()).not.toHaveProperty('knowledge_context_input_source')

    driver.emit(liveSession.id, {
      type: 'output',
      data: 'Delivery summary with cumulative provider totals.',
      metadata: {
        tokenUsage: {
          total: {
            total_tokens: 4_000,
            input_tokens: 3_500,
            cached_input_tokens: 0,
            output_tokens: 500,
            reasoning_output_tokens: 0,
          },
        },
        turnCompleted: true,
      },
    })
    await until(() => {
      const row = db.prepare('SELECT status FROM jobs WHERE id=?').get(job.id) as { status: string }
      return row.status === 'succeeded'
    })
    const uses = db.prepare(`SELECT outcome, estimated_tokens, actual_tokens
      FROM context_uses ORDER BY injected_at, injection_ordinal`).all() as Array<{
        outcome: string
        estimated_tokens: number
        actual_tokens: number | null
      }>
    expect(uses).toHaveLength(3)
    expect(uses.map((use) => use.outcome)).toEqual(['failed', 'completed', 'completed'])
    expect(uses.map((use) => use.actual_tokens)).toEqual([null, 120, 3_380])
    expect(uses[1].actual_tokens).not.toBe(uses[1].estimated_tokens)
    expect(uses[2].actual_tokens).not.toBe(uses[2].estimated_tokens)
    expect(runtime.scheduler.get(job.id)?.spent_tokens).toBe(4_000)
    expect(db.prepare(`SELECT total_tokens, input_tokens, output_tokens
      FROM agent_usage`).get()).toEqual({
      total_tokens: 4_000,
      input_tokens: 3_500,
      output_tokens: 500,
    })
  }, 20_000)

  it('leaves a completed ContextUse actual token count null without provider input evidence', async () => {
    const repositoryState = await repository()
    const db = openDb(':memory:')
    installKnowledgeContextUseActualEvidenceSchema(db)
    databases.push(db)
    const boardId = Number(db.prepare('INSERT INTO boards (project_path, name) VALUES (?, ?)')
      .run(repositoryState.root, 'Knowledge actual usage').lastInsertRowid)
    const cardId = Number(db.prepare(`INSERT INTO cards (board_id, title, description)
      VALUES (?, 'Do not infer actual tokens', 'Do not infer actual tokens')`)
      .run(boardId).lastInsertRowid)
    const contract = new TaskContractService(db).put(cardId, {
      objective: 'Do not infer actual tokens',
      acceptance_criteria: ['Keep actual usage null without provider evidence'],
      verify_commands: ['npm test'],
      budget_tokens: 5_000,
    })
    const workspace = new WorkspaceStore(db).create({
      boardId,
      cardId,
      name: 'Knowledge actual usage',
      kind: 'shared',
      rootPath: repositoryState.root,
      status: 'active',
    })
    putKnowledge(db, boardId, repositoryState.head, 'no-actual',
      'This compiled context has an estimate but no provider token evidence.')

    const driver = new RuntimeDriver()
    const runtime = createAgentOsRuntime(db)
    runtimes.push(runtime)
    runtime.registerDriver(driver)
    const job = runtime.scheduler.create({
      boardId,
      cardId,
      workspaceId: workspace.id,
      provider: 'codex',
      driverId: 'codex',
      contractVersion: contract.version,
      budgetTokens: 5_000,
    })
    await runtime.scheduler.tick()
    const sessionContext = JSON.parse((db.prepare(
      'SELECT context_json FROM agent_sessions WHERE job_id=?',
    ).get(job.id) as { context_json: string }).context_json) as Record<string, unknown>
    expect(sessionContext.knowledge_context_estimated_tokens).toEqual(expect.any(Number))
    expect(sessionContext).not.toHaveProperty('knowledge_context_input_tokens')
    expect(sessionContext).not.toHaveProperty('knowledge_context_input_source')

    const liveSession = driver.sessions.values().next().value as DriverSession
    driver.emit(liveSession.id, {
      type: 'output',
      data: 'Completed without token metadata.',
      metadata: { turnCompleted: true },
    })
    await until(() => runtime.scheduler.get(job.id)?.status === 'succeeded'
      && (db.prepare('SELECT outcome FROM context_uses').get() as { outcome: string }).outcome
        === 'completed')
    expect(db.prepare(`SELECT estimated_tokens, actual_tokens, outcome
      FROM context_uses`).get()).toEqual({
      estimated_tokens: expect.any(Number),
      actual_tokens: null,
      outcome: 'completed',
    })
    expect(runtime.scheduler.get(job.id)?.spent_tokens).toBe(0)
  })

  it('injects ambient SessionStart context through the live Codex provider path without a managed ContextUse', async () => {
    const repositoryState = await repository()
    const db = openDb(':memory:')
    databases.push(db)
    const boardId = Number(db.prepare('INSERT INTO boards (project_path, name) VALUES (?, ?)')
      .run(repositoryState.root, 'Ambient knowledge').lastInsertRowid)
    putKnowledge(db, boardId, repositoryState.head, 'ambient',
      'Investigate ambient startup AMBIENT_SESSION_CONTEXT with exact repository evidence.')
    const driver = new RuntimeDriver()
    const runtime = new CodexManagedAgentRuntime(db, new EventEmitter(), driver)
    ambientRuntimes.push(runtime)
    const agent = runtime.hire({ boardId, cwd: repositoryState.root, name: 'ambient-reviewer' })
    expect(runtime.task(agent.id, 'Investigate ambient startup')).toBe(true)
    await until(() => driver.sends.length === 1)
    expect(driver.sends[0][1]).toContain('AMBIENT_SESSION_CONTEXT')
    expect(driver.sends[0][1]).toContain('Investigate ambient startup')
    expect(db.prepare('SELECT count(*) AS count FROM context_builds').get()).toEqual({ count: 1 })
    expect(db.prepare('SELECT count(*) AS count FROM context_uses').get()).toEqual({ count: 0 })
  })
})
