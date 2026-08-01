import type Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentProfileService } from '../src/agent-os/agent-profiles.js'
import { renderAgentBrief } from '../src/agent-os/agent-brief.js'
import { JobMarketService } from '../src/agent-os/job-market.js'
import {
  OpenWorkService,
  dispatchMatch,
  type OpenWorkDispatchMatch,
} from '../src/agent-os/open-work.js'
import { OrchestrationService } from '../src/agent-os/orchestration-service.js'
import {
  JobScheduler,
  type Job,
  type JobExecutor,
} from '../src/agent-os/scheduler.js'
import { WorkspaceStore } from '../src/agent-os/workspace-store.js'
import { openDb } from '../src/db.js'

const actor = { type: 'operator' as const, id: 'job-market-gate-test' }
const databases: Database.Database[] = []

afterEach(() => {
  while (databases.length) databases.pop()!.close()
  delete process.env.ORCHESTRA_MAX_LAUNCHED
})

class RunningExecutor implements JobExecutor {
  readonly executed: string[] = []

  supportedProviders(): readonly string[] {
    return ['codex']
  }

  async execute(job: Job) {
    this.executed.push(job.id)
    return { status: 'running' as const }
  }
}

function fixture() {
  const db = openDb(':memory:')
  databases.push(db)
  const boardId = Number(db.prepare(
    "INSERT INTO boards (project_path, name) VALUES ('/job-market-gate', 'Job Market Gate')",
  ).run().lastInsertRowid)
  const executor = new RunningExecutor()
  const scheduler = new JobScheduler(db, executor)
  const orchestration = new OrchestrationService(db, scheduler)
  return { db, boardId, executor, scheduler, orchestration }
}

function card(db: Database.Database, boardId: number, title: string): number {
  return Number(db.prepare(`INSERT INTO cards (board_id, title, description)
    VALUES (?, ?, ?)`).run(
      boardId,
      title,
      `Deliver ${title}`,
    ).lastInsertRowid)
}

function workspace(db: Database.Database, boardId: number, cardId: number): string {
  return new WorkspaceStore(db).create({
    boardId,
    cardId,
    name: `gate-workspace-${cardId}`,
    kind: 'worktree',
    rootPath: '/job-market-gate',
    worktreePath: `/tmp/job-market-gate-${cardId}`,
    branch: `test/job-market-gate-${cardId}`,
    baseRef: 'main',
  }).id
}

function profile(
  db: Database.Database,
  boardId: number,
  name: string,
  capabilities: string[],
) {
  return new AgentProfileService(db).create({
    boardId,
    name,
    defaultProvider: 'codex',
    defaultModel: 'gpt-5.4',
    defaultAccessProfile: 'workspace_write',
    capabilities,
    actor,
    idempotencyKey: `job-market-gate:profile:${name}`,
  })
}

function configure(
  db: Database.Database,
  cardId: number,
  input: {
    workspaceId: string
    capability: string
    dependencyId?: number
    blockingReason?: string
  },
) {
  return new JobMarketService(db).update(cardId, {
    objective: `Deliver gated card ${cardId}`,
    deliverables: [{
      id: `gate-delivery-${cardId}`,
      text: `Gated delivery for ${cardId}`,
      required: true,
    }],
    acceptance_criteria: [{
      id: `gate-criterion-${cardId}`,
      text: `Gated card ${cardId} passes`,
      required: true,
      deliverable_ids: [`gate-delivery-${cardId}`],
      description: `Run gated verification for ${cardId}`,
      verifier: { kind: 'command', command: `npm test -- gate-${cardId}` },
      required_artifacts: [{ kind: 'test-log', name: `gate-${cardId}` }],
      priority: 9,
    }],
    dependency_rules: input.dependencyId === undefined ? [] : [{
      card_id: input.dependencyId,
      blocking_reason: input.blockingReason ?? 'Dependency must finish',
      completion_condition: 'card_done',
    }],
    required_capabilities: [input.capability],
    provider_constraints: ['codex'],
    model_constraints: ['gpt-5.4'],
    access_needs: ['workspace_write'],
    budget_tokens: 2_000,
    budget_cents: 200,
    budget_time_seconds: 600,
    budget_retries: 1,
    priority: 10,
    workspace_id: input.workspaceId,
    base_ref: 'main',
    verify_commands: [`npm test -- gate-${cardId}`],
    non_goals: ['Do not bypass the gate'],
    risks: ['Concurrent dispatch'],
  }, actor.id)
}

function dispatchInput(match: OpenWorkDispatchMatch, idempotencyKey: string) {
  return {
    match,
    confirm: true,
    actor,
    idempotencyKey,
  }
}

describe('Job Market Open Work gate', () => {
  it('requires publish before match and preserves a draft preview', () => {
    const { db, boardId, orchestration } = fixture()
    const cardId = card(db, boardId, 'Publish gate')
    const workspaceId = workspace(db, boardId, cardId)
    profile(db, boardId, 'Publisher', ['publish'])
    const markets = new JobMarketService(db)
    configure(db, cardId, { workspaceId, capability: 'publish' })
    markets.transition(cardId, 'cancelled', actor.id, 'return to draft')
    const draft = markets.transition(cardId, 'draft', actor.id, 'edit before publishing')
    const service = new OpenWorkService(db, {
      orchestration,
      supportedProviders: ['codex'],
    })

    const before = db.prepare('SELECT * FROM job_market_contracts WHERE card_id=?').get(cardId)
    const preview = service.preview(cardId, {
      objective: 'Previewed but not yet published',
    }, draft.market_version)
    expect(preview.agent_brief).toContain('Previewed but not yet published')
    expect(db.prepare('SELECT * FROM job_market_contracts WHERE card_id=?').get(cardId))
      .toEqual(before)
    expect(() => service.matchCard(cardId, draft.market_version)).toThrow(/published and open/)

    const published = markets.publish(cardId, actor.id)
    expect(service.matchCard(cardId, published.market_version)).toMatchObject({
      eligible: true,
      market_version: published.market_version,
    })
  })

  it('unlocks dependencies and dispatches exactly once across two clients', async () => {
    const { db, boardId, executor, orchestration } = fixture()
    const dependencyId = card(db, boardId, 'Foundation')
    const cardId = card(db, boardId, 'Exactly-once candidate')
    const workspaceId = workspace(db, boardId, cardId)
    const selected = profile(db, boardId, 'Exactly once', ['exactly-once'])
    const blockingReason = 'Foundation evidence must pass'
    const market = configure(db, cardId, {
      workspaceId,
      capability: 'exactly-once',
      dependencyId,
      blockingReason,
    })
    const firstClient = new OpenWorkService(db, {
      orchestration,
      supportedProviders: ['codex'],
    })
    const secondClient = new OpenWorkService(db, {
      orchestration,
      supportedProviders: ['codex'],
    })

    const blocked = firstClient.matchCard(cardId, market.market_version)
    expect(blocked).toMatchObject({
      eligible: false,
      eligible_agent_count: 0,
      candidates: [{
        profile_id: selected.id,
        ineligibility_reasons: ['contract dependencies are not ready'],
      }],
    })
    expect(() => dispatchMatch(blocked)).toThrow(/no dispatchable selected agent/)

    db.prepare("UPDATE cards SET column_name='done' WHERE id=?").run(dependencyId)
    const ready = firstClient.matchCard(cardId, market.market_version)
    const compact = dispatchMatch(ready)
    const preview = firstClient.preview(cardId, {}, market.market_version)
    const expectedPreview = renderAgentBrief({
      job_market: preview.job_market,
      repository: '/job-market-gate',
      workspace_id: workspaceId,
      dependencies: [{
        card_id: dependencyId,
        title: 'Foundation',
        state: 'done',
        blocking_reason: blockingReason,
        completion_condition: 'card_done',
        readiness: 'ready',
      }],
      critical_path: [],
    })
    expect(preview.agent_brief).toBe(expectedPreview.agent_brief)
    expect(preview.agent_brief_sha256).toBe(expectedPreview.agent_brief_sha256)
    expect(compact.agent_brief_sha256).toBe(preview.agent_brief_sha256)

    const [first, second] = await Promise.all([
      firstClient.dispatch(dispatchInput(compact, 'gate:dispatch-once')),
      secondClient.dispatch(dispatchInput(compact, 'gate:dispatch-once')),
    ])

    expect([first.replayed, second.replayed].sort()).toEqual([false, true])
    expect(second.assignment.id).toBe(first.assignment.id)
    expect(second.job.id).toBe(first.job.id)
    expect(second.agent_brief).toBe(first.agent_brief)
    expect(second.agent_brief_sha256).toBe(first.agent_brief_sha256)
    expect(first.agent_brief).toBe(preview.agent_brief)
    expect(first.agent_brief_sha256).toBe(preview.agent_brief_sha256)
    expect(executor.executed).toEqual([first.job.id])
    expect(first.dispatch).toMatchObject({
      started: [first.job.id],
      blocked: [],
      deferred: [],
      error: null,
    })
    expect(db.prepare('SELECT COUNT(*) AS count FROM job_market_assignments').get())
      .toEqual({ count: 1 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM jobs').get()).toEqual({ count: 1 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM delivery_reports').get())
      .toEqual({ count: 1 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM agent_sessions').get())
      .toEqual({ count: 1 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM workspace_assignments').get())
      .toEqual({ count: 1 })
    expect(db.prepare(`SELECT COUNT(*) AS count FROM os_events
      WHERE job_id=? AND kind='job.started'`).get(first.job.id)).toEqual({ count: 1 })

    const delivery = db.prepare(
      'SELECT id FROM delivery_reports WHERE job_id=?',
    ).get(first.job.id) as { id: string }
    const currentMarket = new JobMarketService(db).get(cardId)
    const expectedDispatch = renderAgentBrief({
      job_market: currentMarket,
      repository: '/job-market-gate',
      job_id: first.job.id,
      delivery_id: delivery.id,
      workspace_id: workspaceId,
      selection: {
        profile_id: compact.profile_id,
        provider: compact.provider,
        model: compact.model,
        access_profile: compact.access_profile,
      },
      dependencies: [{
        card_id: dependencyId,
        title: 'Foundation',
        state: 'done',
        blocking_reason: blockingReason,
        completion_condition: 'card_done',
        readiness: 'ready',
      }],
      critical_path: [],
    })
    expect(first.agent_brief).toBe(expectedDispatch.agent_brief)
    expect(first.agent_brief_sha256).toBe(expectedDispatch.agent_brief_sha256)

    db.prepare(`UPDATE job_market_criteria
      SET description='mutable live description', verifier_json='{"kind":"human"}',
        required_artifacts_json='[]', priority=99
      WHERE card_id=?`).run(cardId)
    db.prepare(`UPDATE job_market_contracts
      SET required_capabilities_json='["drifted"]', budget_time_seconds=1,
        budget_retries=99 WHERE card_id=?`).run(cardId)
    db.prepare(`UPDATE job_market_dependencies
      SET blocking_reason='mutable live dependency reason' WHERE card_id=?`).run(cardId)
    const replayAfterLiveDrift = await firstClient.dispatch(
      dispatchInput(compact, 'gate:dispatch-once'),
    )
    expect(replayAfterLiveDrift.replayed).toBe(true)
    expect(replayAfterLiveDrift.agent_brief).toBe(preview.agent_brief)
    expect(replayAfterLiveDrift.agent_brief_sha256).toBe(preview.agent_brief_sha256)
  })

  it('rejects stale or tampered match decisions before any reservation', async () => {
    const { db, boardId, orchestration } = fixture()
    const cardId = card(db, boardId, 'Stale decision')
    const workspaceId = workspace(db, boardId, cardId)
    profile(db, boardId, 'Stale matcher', ['cas'])
    const market = configure(db, cardId, { workspaceId, capability: 'cas' })
    const service = new OpenWorkService(db, {
      orchestration,
      supportedProviders: ['codex'],
    })
    const matched = dispatchMatch(service.matchCard(cardId, market.market_version))

    await expect(service.dispatch(dispatchInput({
      ...matched,
      decision_sha256: `${matched.decision_sha256[0] === '0' ? '1' : '0'}`
        + matched.decision_sha256.slice(1),
    }, 'gate:tampered'))).rejects.toThrow(/digest is invalid/)

    new JobMarketService(db).update(cardId, { risks: ['Contract changed after matching'] }, actor.id)
    await expect(service.dispatch(dispatchInput(matched, 'gate:stale')))
      .rejects.toThrow(/version is stale/)
    expect(db.prepare('SELECT COUNT(*) AS count FROM job_market_assignments').get())
      .toEqual({ count: 0 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM jobs').get()).toEqual({ count: 0 })
  })

  it('consumes the final global slot at durable queued reservation time', async () => {
    const { db, boardId, executor, orchestration } = fixture()
    const firstCard = card(db, boardId, 'First final-slot candidate')
    const secondCard = card(db, boardId, 'Second final-slot candidate')
    const firstWorkspace = workspace(db, boardId, firstCard)
    const secondWorkspace = workspace(db, boardId, secondCard)
    profile(db, boardId, 'First specialist', ['first-slot'])
    profile(db, boardId, 'Second specialist', ['second-slot'])
    const firstMarket = configure(db, firstCard, {
      workspaceId: firstWorkspace,
      capability: 'first-slot',
    })
    const secondMarket = configure(db, secondCard, {
      workspaceId: secondWorkspace,
      capability: 'second-slot',
    })
    let releaseLaunch!: () => void
    let launchEntered!: () => void
    const launchGate = new Promise<void>((resolve) => { releaseLaunch = resolve })
    const entered = new Promise<void>((resolve) => { launchEntered = resolve })
    const delayedCanonical = {
      createCardJob: orchestration.createCardJob.bind(orchestration),
      launchCard: async (
        input: Parameters<OrchestrationService['launchCard']>[0],
      ) => {
        launchEntered()
        await launchGate
        return orchestration.launchCard(input)
      },
    }
    const firstClient = new OpenWorkService(db, {
      orchestration: delayedCanonical,
      supportedProviders: ['codex'],
      globalCapacity: 1,
    })
    const secondClient = new OpenWorkService(db, {
      orchestration: delayedCanonical,
      supportedProviders: ['codex'],
      globalCapacity: 1,
    })
    const firstMatch = dispatchMatch(
      firstClient.matchCard(firstCard, firstMarket.market_version),
    )
    const secondMatch = dispatchMatch(
      secondClient.matchCard(secondCard, secondMarket.market_version),
    )

    const firstDispatch = firstClient.dispatch(
      dispatchInput(firstMatch, 'gate:last-slot:first'),
    )
    await entered
    expect(db.prepare("SELECT status FROM jobs WHERE card_id=?").get(firstCard))
      .toEqual({ status: 'queued' })
    await expect(secondClient.dispatch(
      dispatchInput(secondMatch, 'gate:last-slot:second'),
    )).rejects.toThrow(/no eligible agent at current capacity/)
    expect(secondClient.matchCard(secondCard, secondMarket.market_version)).toMatchObject({
      eligible: false,
      global_capacity: { active: 1, limit: 1, available: 0 },
    })
    expect(db.prepare(
      'SELECT COUNT(*) AS count FROM job_market_assignments WHERE card_id=?',
    ).get(secondCard)).toEqual({ count: 0 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM jobs WHERE card_id=?').get(secondCard))
      .toEqual({ count: 0 })

    releaseLaunch()
    const launched = await firstDispatch
    expect(launched.job.id).toBeTruthy()
    expect(executor.executed).toEqual([launched.job.id])
  })
})
