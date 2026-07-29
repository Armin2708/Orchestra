import type Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentProfileService } from '../src/agent-os/agent-profiles.js'
import { JobAssignmentService } from '../src/agent-os/job-assignments.js'
import { JobMarketService } from '../src/agent-os/job-market.js'
import {
  OpenWorkService,
  dispatchMatch,
} from '../src/agent-os/open-work.js'
import { OrchestrationService } from '../src/agent-os/orchestration-service.js'
import { JobScheduler } from '../src/agent-os/scheduler.js'
import { WorkspaceStore } from '../src/agent-os/workspace-store.js'
import { openDb } from '../src/db.js'

const actor = { type: 'operator' as const, id: 'open-work-service-test' }
const databases: Database.Database[] = []

afterEach(() => {
  while (databases.length) databases.pop()!.close()
  delete process.env.ORCHESTRA_MAX_LAUNCHED
})

function fixture() {
  const db = openDb(':memory:')
  databases.push(db)
  const boardId = Number(db.prepare(
    "INSERT INTO boards (project_path, name) VALUES ('/open-work', 'Open Work')",
  ).run().lastInsertRowid)
  const otherBoardId = Number(db.prepare(
    "INSERT INTO boards (project_path, name) VALUES ('/other-work', 'Other Work')",
  ).run().lastInsertRowid)
  return { db, boardId, otherBoardId }
}

function card(
  db: Database.Database,
  boardId: number,
  title: string,
  state = 'backlog',
): number {
  return Number(db.prepare(`INSERT INTO cards (board_id, title, description, column_name)
    VALUES (?, ?, ?, ?)`).run(
      boardId,
      title,
      `Objective for ${title}`,
      state,
    ).lastInsertRowid)
}

function workspace(
  db: Database.Database,
  boardId: number,
  cardId: number,
  status = 'active',
): string {
  return new WorkspaceStore(db).create({
    boardId,
    cardId,
    name: `workspace-${cardId}`,
    kind: 'worktree',
    rootPath: '/open-work',
    worktreePath: `/tmp/open-work-${cardId}`,
    branch: `test/open-work-${cardId}`,
    baseRef: 'main',
    status,
  }).id
}

interface ConfigureOptions {
  capabilities?: string[]
  priority?: number
  workspaceId?: string | null
  dependencies?: Array<{ card_id: number; blocking_reason: string }>
  tokens?: number | null
  costCents?: number | null
  timeSeconds?: number | null
}

function configure(
  db: Database.Database,
  cardId: number,
  options: ConfigureOptions = {},
) {
  return new JobMarketService(db).update(cardId, {
    objective: `Ship card ${cardId}`,
    deliverables: [{
      id: `delivery-${cardId}`,
      text: `Delivery for card ${cardId}`,
      required: true,
    }],
    acceptance_criteria: [{
      id: `criterion-${cardId}`,
      text: `Card ${cardId} is verified`,
      required: true,
      deliverable_ids: [`delivery-${cardId}`],
      description: `Run the focused verifier for card ${cardId}`,
      verifier: { kind: 'command', command: `npm test -- card-${cardId}` },
      required_artifacts: [{ kind: 'test-log', name: `card-${cardId}` }],
      priority: 1,
    }],
    dependency_rules: (options.dependencies ?? []).map((dependency) => ({
      ...dependency,
      completion_condition: 'card_done',
    })),
    required_capabilities: options.capabilities ?? ['typescript'],
    provider_constraints: ['codex'],
    model_constraints: ['gpt-5.4'],
    access_needs: ['workspace_write'],
    budget_tokens: options.tokens === undefined ? 1_000 : options.tokens,
    budget_cents: options.costCents === undefined ? 100 : options.costCents,
    budget_time_seconds: options.timeSeconds === undefined ? 300 : options.timeSeconds,
    priority: options.priority ?? 0,
    workspace_id: options.workspaceId ?? null,
    base_ref: 'main',
    verify_commands: [`npm test -- card-${cardId}`],
    non_goals: ['Do not weaken acceptance'],
    risks: ['Concurrent reservation'],
  }, actor.id)
}

function profile(
  db: Database.Database,
  boardId: number,
  name: string,
  patch: {
    provider?: string | null
    model?: string | null
    access?: 'read_only' | 'workspace_write' | 'full_access' | null
    capabilities?: string[]
  } = {},
) {
  return new AgentProfileService(db).create({
    boardId,
    name,
    defaultProvider: patch.provider === undefined ? 'codex' : patch.provider,
    defaultModel: patch.model === undefined ? 'gpt-5.4' : patch.model,
    defaultAccessProfile: patch.access === undefined ? 'workspace_write' : patch.access,
    capabilities: patch.capabilities ?? ['typescript', 'sqlite'],
    actor,
    idempotencyKey: `profile:${boardId}:${name}`,
  })
}

function snapshot(db: Database.Database, cardId: number): string {
  const tables = [
    'task_contracts',
    'job_market_contracts',
    'job_market_criteria',
    'job_market_dependencies',
    'os_events',
  ]
  return JSON.stringify(Object.fromEntries(tables.map((table) => [
    table,
    db.prepare(`SELECT * FROM ${table}
      WHERE card_id=? OR (?='os_events' AND card_id=?)
      ORDER BY rowid`).all(cardId, table, cardId),
  ])))
}

describe('OpenWorkService', () => {
  it('advertises only structurally valid published work and applies exact stable filters', () => {
    const { db, boardId, otherBoardId } = fixture()
    const exact = card(db, boardId, 'Exact priority and capability')
    configure(db, exact, {
      capabilities: ['typescript'],
      priority: 7,
      workspaceId: workspace(db, boardId, exact),
    })
    const higher = card(db, boardId, 'Higher priority')
    configure(db, higher, {
      capabilities: ['typescript'],
      priority: 8,
      workspaceId: workspace(db, boardId, higher),
    })
    const noCapabilities = card(db, boardId, 'No required capabilities')
    configure(db, noCapabilities, {
      capabilities: [],
      priority: 7,
      workspaceId: workspace(db, boardId, noCapabilities),
    })
    const multiCapability = card(db, boardId, 'Multiple capabilities')
    configure(db, multiCapability, {
      capabilities: ['sqlite', 'typescript'],
      priority: 7,
      workspaceId: workspace(db, boardId, multiCapability),
    })
    const draft = card(db, boardId, 'Unpublished draft')
    configure(db, draft, { workspaceId: workspace(db, boardId, draft) })
    db.prepare(`UPDATE job_market_contracts
      SET status='draft', published_at=NULL WHERE card_id=?`).run(draft)
    const malformed = card(db, boardId, 'Malformed contract')
    configure(db, malformed, { workspaceId: workspace(db, boardId, malformed) })
    db.prepare('DELETE FROM job_market_criteria WHERE card_id=?').run(malformed)
    const foreign = card(db, otherBoardId, 'Foreign repository')
    configure(db, foreign, {
      capabilities: ['typescript'],
      priority: 7,
      workspaceId: workspace(db, otherBoardId, foreign),
    })

    const service = new OpenWorkService(db, { supportedProviders: ['codex'] })
    expect(service.query({
      repository: '/open-work',
      capabilities: ['typescript'],
      priority: 7,
      maxTokens: 1_000,
      maxCostCents: 100,
      maxTimeSeconds: 300,
    }).items.map((item) => item.card_id)).toEqual([exact, multiCapability])
    expect(service.query({
      boardId,
      capabilities: ['typescript', 'sqlite'],
      priority: 7,
    }).items.map((item) => item.card_id)).toEqual([multiCapability])
    expect(service.query({ boardId, priority: 8 }).items.map((item) => item.card_id))
      .toEqual([higher])
    expect(service.query({ boardId, maxTokens: 0 }).items).toEqual([])
    expect(service.query({ boardId }).items.map((item) => item.card_id))
      .toEqual([higher, exact, noCapabilities, multiCapability])
  })

  it('returns transitive blocker paths, terminates cycles, and treats done nodes as ready', () => {
    const { db, boardId } = fixture()
    const root = card(db, boardId, 'Root')
    const middle = card(db, boardId, 'Middle')
    const done = card(db, boardId, 'Already done', 'done')
    const staleBlocker = card(db, boardId, 'Stale blocker')
    configure(db, staleBlocker)
    configure(db, done, {
      dependencies: [{
        card_id: staleBlocker,
        blocking_reason: 'This stale edge must not block a done node',
      }],
    })
    configure(db, middle, {
      dependencies: [{
        card_id: done,
        blocking_reason: 'Done dependency',
      }],
    })
    configure(db, root, {
      workspaceId: workspace(db, boardId, root),
      dependencies: [{
        card_id: middle,
        blocking_reason: 'Middle must finish',
      }],
    })

    const service = new OpenWorkService(db, { supportedProviders: ['codex'] })
    const blocked = service.query({ boardId })
    expect(blocked.items.find((item) => item.card_id === root)).toMatchObject({
      dependency_readiness: 'blocked',
      critical_path: [{
        terminal: 'incomplete',
        path: [
          { card_id: root, blocking_reason: null },
          { card_id: middle, blocking_reason: 'Middle must finish' },
        ],
      }],
    })
    expect(blocked.graph.nodes.find((node) => node.card_id === done)).toMatchObject({
      state: 'done',
      readiness: 'ready',
      blocking_reasons: [],
    })

    db.prepare("UPDATE cards SET column_name='done' WHERE id=?").run(middle)
    expect(service.query({ boardId }).items.find((item) => item.card_id === root))
      .toMatchObject({ dependency_readiness: 'ready', critical_path: [] })

    const cycleA = card(db, boardId, 'Cycle A')
    const cycleB = card(db, boardId, 'Cycle B')
    configure(db, cycleA)
    configure(db, cycleB)
    db.prepare('UPDATE task_contracts SET dependencies=? WHERE card_id=?')
      .run(JSON.stringify([cycleB]), cycleA)
    db.prepare('UPDATE task_contracts SET dependencies=? WHERE card_id=?')
      .run(JSON.stringify([cycleA]), cycleB)
    db.prepare(`INSERT INTO job_market_dependencies
      (card_id, dependency_card_id, blocking_reason, completion_condition, updated_at)
      VALUES (?, ?, 'Cycle B blocks A', 'card_done', datetime('now'))`).run(cycleA, cycleB)
    db.prepare(`INSERT INTO job_market_dependencies
      (card_id, dependency_card_id, blocking_reason, completion_condition, updated_at)
      VALUES (?, ?, 'Cycle A blocks B', 'card_done', datetime('now'))`).run(cycleB, cycleA)

    const cyclic = service.query({ boardId }).items.find((item) => item.card_id === cycleA)
    expect(cyclic?.critical_path).toEqual([expect.objectContaining({
      terminal: 'cycle',
      path: expect.arrayContaining([
        expect.objectContaining({ card_id: cycleA }),
        expect.objectContaining({ card_id: cycleB }),
      ]),
    })])
  })

  it('matches fail-closed with strict CAS, deterministic ties, and capacity evidence', () => {
    const { db, boardId } = fixture()
    const cardId = card(db, boardId, 'Match deterministically')
    const workspaceId = workspace(db, boardId, cardId)
    const market = configure(db, cardId, { workspaceId })
    const alpha = profile(db, boardId, 'Alpha')
    profile(db, boardId, 'Zulu')
    profile(db, boardId, 'No model', { model: null })
    profile(db, boardId, 'Wrong provider', { provider: 'claude' })
    profile(db, boardId, 'Insufficient access', { access: 'read_only' })
    profile(db, boardId, 'Missing capability', { capabilities: [] })

    const service = new OpenWorkService(db, {
      supportedProviders: ['codex'],
      globalCapacity: 1,
    })
    const match = service.matchCard(cardId, market.market_version)
    expect(match).toMatchObject({
      card_id: cardId,
      eligible: true,
      eligible_agent_count: 2,
      selected_agent: { profile_id: alpha.id, workspace_id: workspaceId },
      global_capacity: { active: 0, limit: 1, available: 1 },
      decision_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    expect(dispatchMatch(match)).toMatchObject({
      profile_id: alpha.id,
      workspace_id: workspaceId,
      decision_sha256: match.decision_sha256,
    })
    expect(match.candidates.find((candidate) => candidate.name === 'No model')
      ?.ineligibility_reasons).toContain(
      'profile has no declared default model; model fallback is disabled',
    )
    expect(match.candidates.find((candidate) => candidate.name === 'Wrong provider')
      ?.ineligibility_reasons).toContain(
      'provider claude is not currently supported by the scheduler',
    )
    expect(() => service.matchCard(cardId, market.market_version - 1)).toThrow(/stale/)
    expect(() => service.matchCard(cardId, undefined as unknown as number))
      .toThrow(/expected market version must be a positive integer/)

    new JobScheduler(db).create({ boardId, provider: 'codex' })
    const exhausted = service.matchCard(cardId, market.market_version)
    expect(exhausted).toMatchObject({
      eligible: false,
      eligible_agent_count: 0,
      global_capacity: { active: 1, limit: 1, available: 0 },
    })
    expect(exhausted.candidates[0].ineligibility_reasons)
      .toContain('global scheduler capacity is exhausted')
  })

  it('moves deterministic selection past a profile with a reserved active lifecycle', () => {
    const { db, boardId } = fixture()
    const target = card(db, boardId, 'Capacity target')
    const targetWorkspace = workspace(db, boardId, target)
    const targetMarket = configure(db, target, { workspaceId: targetWorkspace })
    const alpha = profile(db, boardId, 'Alpha occupied')
    const beta = profile(db, boardId, 'Beta available')
    const occupiedCard = card(db, boardId, 'Occupied lifecycle')
    const occupiedWorkspace = workspace(db, boardId, occupiedCard)
    const occupiedMarket = configure(db, occupiedCard, { workspaceId: occupiedWorkspace })
    const assignment = new JobAssignmentService(db).assign({
      cardId: occupiedCard,
      profileId: alpha.id,
      workspaceId: occupiedWorkspace,
      expectedMarketVersion: occupiedMarket.market_version,
      actor,
      idempotencyKey: 'open-work-service:occupied-assignment',
    }).assignment
    const orchestration = new OrchestrationService(db, new JobScheduler(db))
    orchestration.createCardJob({
      cardId: occupiedCard,
      expectedBoardId: boardId,
      requireLaunchable: true,
      provider: 'codex',
      model: 'gpt-5.4',
      accessProfile: 'workspace_write',
      workspaceId: occupiedWorkspace,
      idempotencyKey: 'open-work-service:occupied-job',
      expectedJobAssignment: {
        jobAssignmentId: assignment.id,
        assignedProfileId: assignment.profile_id,
        assignmentMarketVersion: assignment.assigned_market_version,
      },
    })
    const service = new OpenWorkService(db, {
      supportedProviders: ['codex'],
      globalCapacity: 10,
    })

    const match = service.matchCard(target, targetMarket.market_version)

    expect(match.selected_agent?.profile_id).toBe(beta.id)
    expect(match.candidates.find((candidate) => candidate.profile_id === alpha.id))
      .toMatchObject({
        eligible: false,
        capacity: { active: 1, limit: 1, available: 0 },
        ineligibility_reasons: ['profile capacity is exhausted'],
      })
    expect(db.prepare(`SELECT
      (SELECT COUNT(*) FROM job_market_assignments
        WHERE profile_id=? AND status='active') AS assignments,
      (SELECT COUNT(*) FROM jobs
        WHERE assigned_profile_id=? AND status='queued') AS jobs,
      (SELECT COUNT(*) FROM agent_sessions
        WHERE assigned_profile_id=? AND status='reserved') AS sessions`)
      .get(alpha.id, alpha.id, alpha.id)).toEqual({
      assignments: 1,
      jobs: 1,
      sessions: 1,
    })
  })

  it('requires an explicit active workspace and a published open contract', () => {
    const { db, boardId } = fixture()
    const noWorkspace = card(db, boardId, 'No workspace')
    const open = configure(db, noWorkspace)
    profile(db, boardId, 'Workspace candidate')
    const service = new OpenWorkService(db, { supportedProviders: ['codex'] })

    const blocked = service.matchCard(noWorkspace, open.market_version)
    expect(blocked).toMatchObject({
      eligible: false,
      selected_agent: null,
      candidates: [{
        workspace_id: null,
        ineligibility_reasons: ['dispatch requires a compatible active card workspace'],
      }],
    })

    const draft = card(db, boardId, 'Draft card')
    const draftMarket = configure(db, draft, {
      workspaceId: workspace(db, boardId, draft),
    })
    db.prepare(`UPDATE job_market_contracts
      SET status='draft', published_at=NULL WHERE card_id=?`).run(draft)
    expect(() => service.matchCard(draft, draftMarket.market_version))
      .toThrow(/published and open/)
  })

  it('previews through the canonical validator without any durable mutation', () => {
    const { db, boardId } = fixture()
    const cardId = card(db, boardId, 'Preview safely')
    const market = configure(db, cardId, {
      workspaceId: workspace(db, boardId, cardId),
    })
    const service = new OpenWorkService(db, { supportedProviders: ['codex'] })
    const before = snapshot(db, cardId)
    const patch = {
      objective: 'Preview-only objective',
      risks: ['Preview must roll back'],
    }

    const first = service.preview(cardId, patch, market.market_version)
    const second = service.preview(cardId, patch, market.market_version)

    expect(first.validation).toMatchObject({ mode: 'publish', valid: true })
    expect(first.agent_brief).toContain('Preview-only objective')
    expect(first.agent_brief).toContain(`- [criterion-${cardId}] Card ${cardId} is verified`)
    expect(first.agent_brief).toContain(`Description: Run the focused verifier for card ${cardId}`)
    expect(first.agent_brief).toContain('<unknown job id until dispatch>')
    expect(first.agent_brief).toContain('<unknown delivery id until dispatch>')
    expect(first.agent_brief_sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(second.agent_brief).toBe(first.agent_brief)
    expect(second.agent_brief_sha256).toBe(first.agent_brief_sha256)
    expect(snapshot(db, cardId)).toBe(before)
    expect(() => service.preview(cardId, patch, market.market_version + 1)).toThrow(/stale/)
  })
})
