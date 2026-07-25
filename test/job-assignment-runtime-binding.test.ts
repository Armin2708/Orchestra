import type Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import {
  AgentHomeLifecycleService,
  type AgentHomeRuntimeControl,
  type RuntimeActionCapabilities,
} from '../src/agent-os/agent-home-lifecycle.js'
import { AgentProfileService } from '../src/agent-os/agent-profiles.js'
import { ConversationService } from '../src/agent-os/conversations.js'
import { ConflictError } from '../src/agent-os/errors.js'
import {
  resolveCurrentJobAssignment,
  type ResolvedJobAssignment,
} from '../src/agent-os/job-assignment-runtime.js'
import { JobAssignmentService } from '../src/agent-os/job-assignments.js'
import { JobMarketService } from '../src/agent-os/job-market.js'
import { applyAgentOsMigrations } from '../src/agent-os/migrations.js'
import { orchestrationIdentity } from '../src/agent-os/orchestration-envelope.js'
import { OrchestrationService } from '../src/agent-os/orchestration-service.js'
import { createAgentOsRuntime } from '../src/agent-os/runtime-integration.js'
import { JobScheduler } from '../src/agent-os/scheduler.js'
import { TaskContractService } from '../src/agent-os/task-contracts.js'
import { WorkspaceStore } from '../src/agent-os/workspace-store.js'
import { openDb } from '../src/db.js'
import type { AgentDriver, DriverLaunchRequest, DriverSession } from '../src/runtime/index.js'
import { normalizeCanonicalLifecycleResponse } from '../web/src/osApi.js'

const MIGRATION_ID = '017-job-assignment-runtime-binding'
const actor = { type: 'operator', id: 'runtime-binding-test' }

interface Fixture {
  db: Database.Database
  boardId: number
  cardId: number
  workspaceId: string
  profileId: string
  assignments: JobAssignmentService
  market: JobMarketService
}

function fixture(suffix: string): Fixture {
  const db = openDb(':memory:')
  const boardId = Number(db.prepare(
    'INSERT INTO boards (project_path, name) VALUES (?, ?)',
  ).run(`/runtime-binding-${suffix}`, `runtime binding ${suffix}`).lastInsertRowid)
  const cardId = Number(db.prepare(`
    INSERT INTO cards (board_id, title, description)
    VALUES (?, ?, 'Bind the canonical assignment to runtime')
  `).run(boardId, `runtime binding ${suffix}`).lastInsertRowid)
  const workspaceId = `runtime-binding-${suffix}-workspace`
  db.prepare(`
    INSERT INTO workspaces (
      id, board_id, card_id, name, kind, root_path, base_ref, status
    ) VALUES (?, ?, ?, ?, 'shared', ?, 'HEAD', 'active')
  `).run(
    workspaceId,
    boardId,
    cardId,
    workspaceId,
    `/tmp/${workspaceId}`,
  )
  const profile = new AgentProfileService(db).create({
    boardId,
    name: `runtime binding ${suffix} profile`,
    capabilities: ['terminal'],
    actor,
    idempotencyKey: `runtime-binding:${suffix}:profile`,
  })
  const market = new JobMarketService(db)
  market.get(cardId)
  return {
    db,
    boardId,
    cardId,
    workspaceId,
    profileId: profile.id,
    assignments: new JobAssignmentService(db),
    market,
  }
}

function claimAssignment(input: Fixture) {
  const current = input.market.get(input.cardId)
  return input.assignments.claim({
    cardId: input.cardId,
    profileId: input.profileId,
    workspaceId: input.workspaceId,
    expectedMarketVersion: current.market_version,
    actor,
    idempotencyKey: `runtime-binding:${input.cardId}:claim`,
  })
}

function insertBoundJob(
  input: Fixture,
  assignment: ReturnType<typeof claimAssignment>['assignment'],
  id: string,
): void {
  input.db.prepare(`
    INSERT INTO jobs (
      id, board_id, card_id, workspace_id, provider, status,
      job_assignment_id, assigned_profile_id, assignment_market_version
    ) VALUES (?, ?, ?, ?, 'codex', 'queued', ?, ?, ?)
  `).run(
    id,
    input.boardId,
    input.cardId,
    input.workspaceId,
    assignment.id,
    assignment.profile_id,
    assignment.assigned_market_version,
  )
}

function insertAgent(input: Fixture, name: string): number {
  return Number(input.db.prepare(`
    INSERT INTO agents (board_id, name, kind, status, provider)
    VALUES (?, ?, 'hired', 'active', 'codex')
  `).run(input.boardId, name).lastInsertRowid)
}

function removeMigration017(db: Database.Database): void {
  db.exec(`
    DROP TRIGGER IF EXISTS jobs_job_assignment_required_insert;
    DROP TRIGGER IF EXISTS jobs_job_assignment_required_activation;
    DROP TRIGGER IF EXISTS jobs_job_assignment_binding_current_guard;
    DROP TRIGGER IF EXISTS jobs_job_assignment_session_binding_guard;
    DROP TRIGGER IF EXISTS agent_sessions_job_assignment_required_insert;
    DROP TRIGGER IF EXISTS agent_sessions_job_assignment_binding_current_guard;
    DROP TRIGGER IF EXISTS agent_sessions_job_assignment_required_update;
    DROP TRIGGER IF EXISTS agent_sessions_job_assignment_required_status;
    DROP TRIGGER IF EXISTS job_assignment_workspace_runtime_guard;
    DROP TRIGGER IF EXISTS job_market_assignment_legacy_owner_update;
    CREATE TRIGGER job_market_assignment_legacy_owner_update
    BEFORE UPDATE OF owner_agent_id ON cards
    WHEN NEW.owner_agent_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM job_market_assignments assignment
        WHERE assignment.card_id=NEW.id AND assignment.status='active'
      )
    BEGIN
      SELECT RAISE(
        ABORT,
        'card has an active canonical job market assignment'
      );
    END;
    DELETE FROM os_schema_migrations
    WHERE id='017-job-assignment-runtime-binding';
  `)
}

async function eventually(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
): Promise<void> {
  const started = Date.now()
  while (!(await condition())) {
    if (Date.now() - started > timeoutMs) throw new Error('condition never became true')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

class RetryRuntime implements AgentHomeRuntimeControl {
  agentHomeSessionCapabilities(): RuntimeActionCapabilities {
    const available = { supported: true, reason: null }
    return {
      pause: available,
      resume: available,
      stop: available,
      retry: available,
      fork: { supported: false, reason: 'fork is outside this test' },
    }
  }

  async pauseAgentHomeSession(): Promise<void> {}
  async resumeAgentHomeSession(): Promise<void> {}
  async stopAgentHomeSession(): Promise<void> {}
}

function linkAssignedSession(
  input: Fixture,
  sessionId: string,
  jobId: string,
  suffix: string,
): string {
  const conversation = input.db.prepare(`
    SELECT id FROM agent_conversations
    WHERE profile_id=? AND status='active' AND is_default=1
  `).get(input.profileId) as { id: string }
  new ConversationService(input.db).linkSession(sessionId, {
    profileId: input.profileId,
    conversationId: conversation.id,
    jobId,
    mode: 'managed',
    driverId: 'claude',
    effort: null,
    accessProfile: 'read_only',
    actor,
    idempotencyKey: `runtime-binding:${suffix}:link`,
  })
  return conversation.id
}

function prepareRecoverableAssignedJob(suffix: string) {
  const input = fixture(suffix)
  const claimed = claimAssignment(input)
  const scheduler = new JobScheduler(input.db)
  const orchestration = new OrchestrationService(input.db, scheduler, {
    materialize: async (workspace) => workspace,
  })
  const snapshot = orchestration.createCardJob({
    cardId: input.cardId,
    workspaceId: input.workspaceId,
    provider: 'claude',
    accessProfile: 'read_only',
    maxAttempts: 1,
    idempotencyKey: `runtime-binding:${suffix}:launch`,
  })
  const conversationId = linkAssignedSession(
    input,
    snapshot.session!.id,
    snapshot.job.id,
    suffix,
  )
  input.db.prepare(`
    UPDATE jobs SET status='running', attempts=1, started_at=datetime('now')
    WHERE id=?
  `).run(snapshot.job.id)
  input.db.prepare(`
    UPDATE agent_sessions SET
      status='running',
      external_id=?,
      provider_thread_id=?,
      updated_at=datetime('now')
    WHERE id=?
  `).run(`${suffix}-thread`, `${suffix}-thread`, snapshot.session!.id)
  return { input, claimed, snapshot, conversationId }
}

describe('job assignment runtime resolver', () => {
  it('returns null or one complete camel-case frozen identity with runtime metadata', () => {
    const input = fixture('resolver')
    expect(resolveCurrentJobAssignment(input.db, input.boardId, input.cardId)).toBeNull()

    const claimed = claimAssignment(input)
    expect(resolveCurrentJobAssignment(input.db, input.boardId, input.cardId)).toEqual({
      jobAssignmentId: claimed.assignment.id,
      assignedProfileId: input.profileId,
      assignmentMarketVersion: claimed.assignment.assigned_market_version,
      assignmentVersion: claimed.assignment.version,
      boardId: input.boardId,
      cardId: input.cardId,
      workspaceId: input.workspaceId,
      currentMarketVersion: claimed.market.market_version,
    })
    expect(() => resolveCurrentJobAssignment(input.db, 0, input.cardId))
      .toThrow(/board id must be a positive integer/)
    expect(() => resolveCurrentJobAssignment(input.db, input.boardId, -1))
      .toThrow(/card id must be a positive integer/)
    input.db.close()
  })

  it('fails closed on partial, future-version, or ambiguous resolver rows', () => {
    const complete: Record<keyof ResolvedJobAssignment | string, unknown> = {
      job_assignment_id: 'assignment-one',
      assigned_profile_id: 'profile-one',
      assignment_market_version: 2,
      assignment_version: 1,
      board_id: 1,
      card_id: 2,
      workspace_id: null,
      current_market_version: 2,
      ownership_mode: 'exclusive',
    }
    const fakeDb = (rows: Record<string, unknown>[]) => ({
      prepare: () => ({ all: () => rows }),
    }) as unknown as Database.Database

    expect(() => resolveCurrentJobAssignment(
      fakeDb([{ ...complete, assigned_profile_id: null }]),
      1,
      2,
    )).toThrow(/profile identity is missing/)
    expect(() => resolveCurrentJobAssignment(
      fakeDb([{ ...complete, assignment_market_version: 3 }]),
      1,
      2,
    )).toThrow(/market version is inconsistent/)
    expect(() => resolveCurrentJobAssignment(
      fakeDb([{ ...complete, assignment_market_version: 1 }]),
      1,
      2,
    )).toThrow(/market version is inconsistent/)
    expect(() => resolveCurrentJobAssignment(
      fakeDb([{ ...complete, assignment_version: 2 }]),
      1,
      2,
    )).toThrow(/version is inconsistent/)
    expect(() => resolveCurrentJobAssignment(
      fakeDb([{ ...complete, board_id: 3 }]),
      1,
      2,
    )).toThrow(/scope is inconsistent/)
    expect(() => resolveCurrentJobAssignment(
      fakeDb([{ ...complete, ownership_mode: 'shared' }]),
      1,
      2,
    )).toThrow(/ownership mode is inconsistent/)
    expect(() => resolveCurrentJobAssignment(
      fakeDb([complete, { ...complete, job_assignment_id: 'assignment-two' }]),
      1,
      2,
    )).toThrow(/identity is ambiguous/)
  })
})

describe('job assignment runtime binding migration 017', () => {
  it('upgrades without backfilling legacy rows and is idempotent', () => {
    const input = fixture('upgrade')
    input.db.prepare(`
      INSERT INTO jobs (
        id, board_id, card_id, workspace_id, provider, status
      ) VALUES ('upgrade-legacy-job', ?, ?, ?, 'codex', 'failed')
    `).run(input.boardId, input.cardId, input.workspaceId)
    input.db.prepare(`
      INSERT INTO agent_sessions (
        id, workspace_id, provider, status, job_id
      ) VALUES (
        'upgrade-legacy-session', ?, 'codex', 'stopped', 'upgrade-legacy-job'
      )
    `).run(input.workspaceId)

    removeMigration017(input.db)
    claimAssignment(input)
    applyAgentOsMigrations(input.db)
    applyAgentOsMigrations(input.db)

    expect(input.db.prepare(`
      SELECT job_assignment_id, assigned_profile_id, assignment_market_version
      FROM jobs WHERE id='upgrade-legacy-job'
    `).get()).toEqual({
      job_assignment_id: null,
      assigned_profile_id: null,
      assignment_market_version: null,
    })
    expect(input.db.prepare(`
      SELECT job_assignment_id, assigned_profile_id, assignment_market_version
      FROM agent_sessions WHERE id='upgrade-legacy-session'
    `).get()).toEqual({
      job_assignment_id: null,
      assigned_profile_id: null,
      assignment_market_version: null,
    })
    expect(input.db.prepare(`
      SELECT COUNT(*) AS count FROM os_schema_migrations WHERE id=?
    `).get(MIGRATION_ID)).toEqual({ count: 1 })
    input.db.close()
  })

  it('requires exact frozen identity on new jobs but preserves queued legacy compatibility', () => {
    const input = fixture('job-guards')
    input.db.prepare(`
      INSERT INTO jobs (
        id, board_id, card_id, workspace_id, provider, status
      ) VALUES ('historical-null-job', ?, ?, ?, 'codex', 'failed')
    `).run(input.boardId, input.cardId, input.workspaceId)
    input.db.prepare(`
      INSERT INTO jobs (
        id, board_id, card_id, workspace_id, provider, status
      ) VALUES ('relocated-null-job', ?, NULL, ?, 'codex', 'running')
    `).run(input.boardId, input.workspaceId)
    const claimed = claimAssignment(input)

    expect(() => input.db.prepare(`
      INSERT INTO jobs (
        id, board_id, card_id, workspace_id, provider, status
      ) VALUES ('new-unbound-job', ?, ?, ?, 'codex', 'queued')
    `).run(input.boardId, input.cardId, input.workspaceId))
      .toThrow(/active job assignment requires exact frozen job identity/)

    expect(() => input.db.prepare(`
      INSERT INTO jobs (
        id, board_id, card_id, workspace_id, provider, status,
        job_assignment_id, assigned_profile_id, assignment_market_version
      ) VALUES (
        'new-wrong-job', ?, ?, ?, 'codex', 'queued', ?, ?, ?
      )
    `).run(
      input.boardId,
      input.cardId,
      input.workspaceId,
      claimed.assignment.id,
      input.profileId,
      claimed.assignment.assigned_market_version + 1,
    )).toThrow(/identity/)

    expect(() => input.db.prepare(`
      UPDATE jobs SET status='queued' WHERE id='historical-null-job'
    `).run()).not.toThrow()
    expect(() => input.db.prepare(`
      UPDATE jobs SET status='running' WHERE id='historical-null-job'
    `).run()).toThrow(/exact frozen job identity before execution/)
    expect(() => input.db.prepare(`
      UPDATE jobs SET status='cancelling' WHERE id='historical-null-job'
    `).run()).toThrow(/exact frozen job identity before execution/)
    expect(() => input.db.prepare(`
      UPDATE jobs SET card_id=? WHERE id='relocated-null-job'
    `).run(input.cardId)).toThrow(/exact frozen job identity before execution/)
    input.db.prepare(`
      UPDATE jobs SET status='failed' WHERE id='historical-null-job'
    `).run()
    expect(() => insertBoundJob(input, claimed.assignment, 'new-bound-job'))
      .not.toThrow()
    input.db.close()
  })

  it('requires exact bound-session identity on insert, relation changes, and active status', () => {
    const input = fixture('session-guards')
    input.db.prepare(`
      INSERT INTO jobs (
        id, board_id, card_id, workspace_id, provider, status
      ) VALUES ('session-historical-job', ?, ?, ?, 'codex', 'failed')
    `).run(input.boardId, input.cardId, input.workspaceId)
    input.db.prepare(`
      INSERT INTO agent_sessions (
        id, workspace_id, provider, status, job_id
      ) VALUES (
        'session-historical-row', ?, 'codex', 'stopped', 'session-historical-job'
      )
    `).run(input.workspaceId)
    const claimed = claimAssignment(input)
    insertBoundJob(input, claimed.assignment, 'session-bound-job')

    expect(() => input.db.prepare(`
      INSERT INTO agent_sessions (
        id, workspace_id, provider, status, job_id
      ) VALUES (
        'session-late-unbound-row', ?, 'codex', 'starting',
        'session-historical-job'
      )
    `).run(input.workspaceId))
      .toThrow(/exact frozen agent session assignment identity/)

    expect(() => input.db.prepare(`
      UPDATE agent_sessions SET status='running'
      WHERE id='session-historical-row'
    `).run()).toThrow(/active canonical assignment/)

    expect(() => input.db.prepare(`
      UPDATE jobs SET
        status='queued',
        job_assignment_id=?,
        assigned_profile_id=?,
        assignment_market_version=?
      WHERE id='session-historical-job'
    `).run(
      claimed.assignment.id,
      input.profileId,
      claimed.assignment.assigned_market_version,
    )).toThrow(/would strand an unbound agent session/)

    expect(() => input.db.prepare(`
      INSERT INTO agent_sessions (
        id, workspace_id, provider, status, job_id
      ) VALUES (
        'session-missing-identity', ?, 'codex', 'reserved', 'session-bound-job'
      )
    `).run(input.workspaceId)).toThrow(/exact frozen agent session assignment identity/)

    expect(() => input.db.prepare(`
      UPDATE agent_sessions SET job_id='session-bound-job'
      WHERE id='session-historical-row'
    `).run()).toThrow(/exact frozen agent session assignment identity/)

    input.db.prepare(`
      INSERT INTO agent_sessions (
        id, workspace_id, provider, status, job_id,
        job_assignment_id, assigned_profile_id, assignment_market_version
      ) VALUES (
        'session-bound-row', ?, 'codex', 'reserved', 'session-bound-job',
        ?, ?, ?
      )
    `).run(
      input.workspaceId,
      claimed.assignment.id,
      input.profileId,
      claimed.assignment.assigned_market_version,
    )
    input.db.prepare(`
      UPDATE jobs SET status='running' WHERE id='session-bound-job'
    `).run()
    expect(() => input.db.prepare(`
      UPDATE agent_sessions SET status='running' WHERE id='session-bound-row'
    `).run()).not.toThrow()
    input.db.close()
  })

  it('rejects new assignment bindings after market drift but preserves frozen pre-drift rows', () => {
    const input = fixture('market-drift-guards')
    const claimed = claimAssignment(input)
    insertBoundJob(input, claimed.assignment, 'market-drift-frozen-job')
    input.db.prepare(`
      INSERT INTO agent_sessions (
        id, workspace_id, provider, status, job_id,
        job_assignment_id, assigned_profile_id, assignment_market_version
      ) VALUES (
        'market-drift-frozen-session', ?, 'codex', 'reserved',
        'market-drift-frozen-job', ?, ?, ?
      )
    `).run(
      input.workspaceId,
      claimed.assignment.id,
      input.profileId,
      claimed.assignment.assigned_market_version,
    )
    const updated = input.market.update(input.cardId, {
      objective: 'market drift after the frozen job and reservation exist',
    }, 'runtime-binding-test')
    expect(updated.market_version).toBeGreaterThan(
      claimed.assignment.assigned_market_version,
    )

    expect(() => insertBoundJob(
      input,
      claimed.assignment,
      'market-drift-new-job',
    )).toThrow(/exact frozen job identity/)
    expect(() => input.db.prepare(`
      INSERT INTO agent_sessions (
        id, workspace_id, provider, status, job_id,
        job_assignment_id, assigned_profile_id, assignment_market_version
      ) VALUES (
        'market-drift-new-session', ?, 'codex', 'reserved',
        'market-drift-frozen-job', ?, ?, ?
      )
    `).run(
      input.workspaceId,
      claimed.assignment.id,
      input.profileId,
      claimed.assignment.assigned_market_version,
    )).toThrow(/exact frozen agent session assignment identity/)
    expect(input.db.prepare(`
      SELECT COUNT(*) AS count FROM jobs WHERE id='market-drift-new-job'
    `).get()).toEqual({ count: 0 })
    expect(input.db.prepare(`
      SELECT COUNT(*) AS count FROM agent_sessions
      WHERE id='market-drift-new-session'
    `).get()).toEqual({ count: 0 })

    expect(() => input.db.prepare(`
      UPDATE jobs SET status='running'
      WHERE id='market-drift-frozen-job'
    `).run()).not.toThrow()
    expect(() => input.db.prepare(`
      UPDATE agent_sessions SET status='starting'
      WHERE id='market-drift-frozen-session'
    `).run()).not.toThrow()
    input.db.close()

    const binding = fixture('market-drift-binding-guards')
    binding.db.prepare(`
      INSERT INTO jobs (
        id, board_id, card_id, workspace_id, provider, status
      ) VALUES
        ('market-drift-current-bind', ?, ?, ?, 'codex', 'blocked'),
        ('market-drift-stale-bind', ?, ?, ?, 'codex', 'blocked')
    `).run(
      binding.boardId,
      binding.cardId,
      binding.workspaceId,
      binding.boardId,
      binding.cardId,
      binding.workspaceId,
    )
    binding.db.prepare(`
      INSERT INTO agent_sessions (
        id, workspace_id, provider, status, context_json
      ) VALUES (
        'market-drift-late-session', ?, 'codex', 'stopped', '{}'
      )
    `).run(binding.workspaceId)
    const bindingClaim = claimAssignment(binding)
    binding.db.prepare(`
      UPDATE jobs SET
        status='queued',
        job_assignment_id=?,
        assigned_profile_id=?,
        assignment_market_version=?
      WHERE id='market-drift-current-bind'
    `).run(
      bindingClaim.assignment.id,
      binding.profileId,
      bindingClaim.assignment.assigned_market_version,
    )
    binding.market.update(binding.cardId, {
      objective: 'market drift before any later binding',
    }, 'runtime-binding-test')

    expect(() => binding.db.prepare(`
      UPDATE agent_sessions SET
        status='reserved',
        job_id='market-drift-current-bind',
        job_assignment_id=?,
        assigned_profile_id=?,
        assignment_market_version=?
      WHERE id='market-drift-late-session'
    `).run(
      bindingClaim.assignment.id,
      binding.profileId,
      bindingClaim.assignment.assigned_market_version,
    )).toThrow(/current active market assignment/)
    binding.db.prepare(`
      UPDATE jobs SET status='blocked'
      WHERE id='market-drift-current-bind'
    `).run()
    expect(() => binding.db.prepare(`
      UPDATE jobs SET
        status='queued',
        job_assignment_id=?,
        assigned_profile_id=?,
        assignment_market_version=?
      WHERE id='market-drift-stale-bind'
    `).run(
      bindingClaim.assignment.id,
      binding.profileId,
      bindingClaim.assignment.assigned_market_version,
    )).toThrow(/current active market assignment/)
    expect(binding.db.prepare(`
      SELECT status, job_assignment_id
      FROM jobs WHERE id='market-drift-stale-bind'
    `).get()).toEqual({ status: 'blocked', job_assignment_id: null })
    expect(binding.db.prepare(`
      SELECT status, job_id, job_assignment_id
      FROM agent_sessions WHERE id='market-drift-late-session'
    `).get()).toEqual({
      status: 'stopped',
      job_id: null,
      job_assignment_id: null,
    })
    binding.db.close()
  })

  it('keeps the frozen workspace active until its assignment-bound runtime is terminal', () => {
    const input = fixture('workspace-lifecycle-guard')
    input.db.prepare('UPDATE task_contracts SET workspace_id=NULL WHERE card_id=?')
      .run(input.cardId)
    const current = input.market.get(input.cardId)
    const claimed = input.assignments.claim({
      cardId: input.cardId,
      profileId: input.profileId,
      workspaceId: null,
      expectedMarketVersion: current.market_version,
      actor,
      idempotencyKey: 'runtime-binding:workspace-lifecycle-guard:claim',
    })
    insertBoundJob(input, claimed.assignment, 'workspace-lifecycle-job')
    const otherCardId = Number(input.db.prepare(`
      INSERT INTO cards (board_id, title, description)
      VALUES (?, 'other workspace scope', 'must not replace the frozen card')
    `).run(input.boardId).lastInsertRowid)
    expect(claimed.assignment.workspace_id).toBeNull()

    expect(() => input.db.prepare(`
      UPDATE workspaces SET status='failed' WHERE id=?
    `).run(input.workspaceId)).not.toThrow()
    input.db.prepare("UPDATE workspaces SET status='active' WHERE id=?")
      .run(input.workspaceId)
    input.db.prepare(`
      UPDATE jobs SET status='running' WHERE id='workspace-lifecycle-job'
    `).run()

    expect(() => input.db.prepare(`
      UPDATE workspaces SET status='failed' WHERE id=?
    `).run(input.workspaceId)).toThrow(/active assignment runtime/)
    expect(() => new WorkspaceStore(input.db).archive(input.workspaceId))
      .toThrow(ConflictError)
    expect(() => new WorkspaceStore(input.db).update(input.workspaceId, {
      card_id: otherCardId,
    })).toThrow(ConflictError)
    expect(input.db.prepare('SELECT status FROM workspaces WHERE id=?')
      .get(input.workspaceId)).toEqual({ status: 'active' })
    expect(input.db.prepare('SELECT card_id FROM workspaces WHERE id=?')
      .get(input.workspaceId)).toEqual({ card_id: input.cardId })

    input.db.prepare(`
      UPDATE jobs SET status='blocked' WHERE id='workspace-lifecycle-job'
    `).run()
    expect(() => input.db.prepare(`
      UPDATE workspaces SET status='failed' WHERE id=?
    `).run(input.workspaceId)).not.toThrow()
    input.db.close()
  })

  it('projects a legacy owner only from exact post-launch assignment proof', () => {
    const input = fixture('owner-proof')
    const claimed = claimAssignment(input)
    insertBoundJob(input, claimed.assignment, 'owner-proof-job')
    const ownerId = insertAgent(input, 'owner-proof-agent')
    const unrelatedAgentId = insertAgent(input, 'unrelated-owner-agent')
    input.db.prepare(`
      INSERT INTO agent_sessions (
        id, workspace_id, agent_id, provider, status, job_id,
        job_assignment_id, assigned_profile_id, assignment_market_version
      ) VALUES (
        'owner-proof-session', ?, ?, 'codex', 'reserved', 'owner-proof-job',
        ?, ?, ?
      )
    `).run(
      input.workspaceId,
      ownerId,
      claimed.assignment.id,
      input.profileId,
      claimed.assignment.assigned_market_version,
    )

    expect(() => input.db.prepare(`
      UPDATE cards SET owner_agent_id=? WHERE id=?
    `).run(ownerId, input.cardId)).toThrow(/matching active assignment runtime/)
    input.db.prepare("UPDATE jobs SET status='running' WHERE id='owner-proof-job'").run()
    input.db.prepare(`
      UPDATE agent_sessions SET status='running' WHERE id='owner-proof-session'
    `).run()
    expect(() => input.db.prepare(`
      UPDATE cards SET owner_agent_id=? WHERE id=?
    `).run(ownerId, input.cardId)).toThrow(/matching active assignment runtime/)
    input.db.prepare(`
      UPDATE agents SET session_id='agent-os:owner-proof-job' WHERE id=?
    `).run(ownerId)
    expect(() => input.db.prepare(`
      UPDATE cards SET owner_agent_id=? WHERE id=?
    `).run(ownerId, input.cardId)).toThrow(/matching active assignment runtime/)
    const conversation = input.db.prepare(`
      SELECT id FROM agent_conversations
      WHERE board_id=? AND profile_id=? AND status='active' AND is_default=1
    `).get(input.boardId, input.profileId) as { id: string }
    input.db.prepare(`
      UPDATE agent_sessions
      SET profile_id=?, conversation_id=?, external_id='owner-proof-thread'
      WHERE id='owner-proof-session'
    `).run(input.profileId, conversation.id)
    expect(() => input.db.prepare(`
      UPDATE cards SET owner_agent_id=? WHERE id=?
    `).run(unrelatedAgentId, input.cardId)).toThrow(/matching active assignment runtime/)
    expect(() => input.db.prepare(`
      UPDATE cards SET owner_agent_id=? WHERE id=?
    `).run(ownerId, input.cardId)).not.toThrow()
    expect(() => input.db.prepare(`
      UPDATE cards SET owner_agent_id=NULL WHERE id=?
    `).run(input.cardId)).not.toThrow()
    input.db.close()
  })
})

describe('phase-two assignment runtime behavior', () => {
  it('atomically freezes assignment identity and replays it after the assignment becomes historical', () => {
    const input = fixture('orchestration-freeze')
    const claimed = claimAssignment(input)
    const scheduler = new JobScheduler(input.db)
    const orchestration = new OrchestrationService(input.db, scheduler, {
      materialize: async (workspace) => workspace,
    })
    const request = {
      cardId: input.cardId,
      workspaceId: input.workspaceId,
      provider: 'claude',
      model: 'claude-phase-two',
      effort: 'high',
      accessProfile: 'read_only' as const,
      maxAttempts: 1,
      idempotencyKey: 'runtime-binding:orchestration-freeze:launch',
    }

    const created = orchestration.createCardJob(request)

    expect(created.job).toMatchObject({
      job_assignment_id: claimed.assignment.id,
      assigned_profile_id: input.profileId,
      assignment_market_version: claimed.assignment.assigned_market_version,
    })
    expect(created.session).toMatchObject({
      job_id: created.job.id,
      job_assignment_id: claimed.assignment.id,
      assigned_profile_id: input.profileId,
      assignment_market_version: claimed.assignment.assigned_market_version,
      profile_id: null,
      conversation_id: null,
    })
    expect(created.session?.context).toMatchObject({
      job_assignment_id: claimed.assignment.id,
      assigned_profile_id: input.profileId,
      assignment_market_version: claimed.assignment.assigned_market_version,
    })
    expect(created.session?.context.assignment_id)
      .toBe(created.session?.context.workspace_assignment_id)
    expect(created.session?.workspace_assignment_id)
      .toBe(created.session?.context.workspace_assignment_id)
    expect(created.session?.context.assignment_id).not.toBe(claimed.assignment.id)

    const originalAsked = structuredClone(created.delivery.asked)
    new TaskContractService(input.db).put(input.cardId, {
      objective: 'MUTATED AMBIENT CONTRACT MUST NOT REPLACE THE FROZEN DELIVERY',
    })
    scheduler.failBeforeLaunch(created.job.id, 'make the original launch terminal')
    input.assignments.release({
      cardId: input.cardId,
      assignmentId: claimed.assignment.id,
      expectedMarketVersion: claimed.market.market_version,
      expectedAssignmentVersion: claimed.assignment.version,
      actor,
      idempotencyKey: 'runtime-binding:orchestration-freeze:release',
      reason: 'prove replay is independent of mutable assignment state',
    })

    const replay = orchestration.createCardJob(request)

    expect(replay.job.id).toBe(created.job.id)
    expect(replay.session?.id).toBe(created.session?.id)
    expect(replay.delivery.asked).toEqual(originalAsked)
    expect(replay.job).toMatchObject({
      job_assignment_id: claimed.assignment.id,
      assigned_profile_id: input.profileId,
      assignment_market_version: claimed.assignment.assigned_market_version,
    })
    expect(input.assignments.require(claimed.assignment.id).status).toBe('released')
    expect(input.db.prepare('SELECT COUNT(*) AS count FROM jobs').get())
      .toEqual({ count: 1 })
    input.db.close()
  })

  it('rolls back an assigned launch without an already-active workspace and rejects a stale expected identity', () => {
    const input = fixture('active-workspace')
    input.db.prepare("UPDATE workspaces SET status='archived' WHERE id=?")
      .run(input.workspaceId)
    input.db.prepare('UPDATE task_contracts SET workspace_id=NULL WHERE card_id=?')
      .run(input.cardId)
    const current = input.market.get(input.cardId)
    const claimed = input.assignments.claim({
      cardId: input.cardId,
      profileId: input.profileId,
      workspaceId: null,
      expectedMarketVersion: current.market_version,
      actor,
      idempotencyKey: 'runtime-binding:active-workspace:claim',
    })
    const scheduler = new JobScheduler(input.db)
    const orchestration = new OrchestrationService(input.db, scheduler, {
      materialize: async (workspace) => workspace,
    })
    const counts = () => Object.fromEntries([
      'jobs',
      'delivery_reports',
      'workspace_assignments',
      'agent_sessions',
      'workspaces',
      'os_events',
    ].map((table) => [
      table,
      (input.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count,
    ]))
    const before = counts()

    expect(() => orchestration.createCardJob({
      cardId: input.cardId,
      provider: 'claude',
      accessProfile: 'read_only',
      idempotencyKey: 'runtime-binding:active-workspace:launch',
    })).toThrow(/require an active workspace/)
    expect(counts()).toEqual(before)

    expect(() => orchestration.createCardJob({
      cardId: input.cardId,
      provider: 'claude',
      accessProfile: 'read_only',
      idempotencyKey: 'runtime-binding:active-workspace:stale',
      expectedJobAssignment: {
        jobAssignmentId: claimed.assignment.id,
        assignedProfileId: input.profileId,
        assignmentMarketVersion: claimed.assignment.assigned_market_version + 1,
      },
    })).toThrow(/expected Job Market assignment is stale/)
    expect(counts()).toEqual(before)
    input.db.close()
  })

  it('rejects an expected-unassigned launch after an assignment appears with zero launch writes', () => {
    const input = fixture('expected-unassigned-cas')
    claimAssignment(input)
    const orchestration = new OrchestrationService(
      input.db,
      new JobScheduler(input.db),
      { materialize: async (workspace) => workspace },
    )
    const counts = () => Object.fromEntries([
      'jobs',
      'delivery_reports',
      'workspace_assignments',
      'agent_sessions',
      'workspaces',
      'os_events',
    ].map((table) => [
      table,
      (input.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
        count: number
      }).count,
    ]))
    const before = counts()

    expect(() => orchestration.createCardJob({
      cardId: input.cardId,
      workspaceId: input.workspaceId,
      provider: 'claude',
      accessProfile: 'read_only',
      idempotencyKey: 'runtime-binding:expected-unassigned-cas:launch',
      expectedJobAssignment: null,
    })).toThrow(/expected no active Job Market assignment/)
    expect(counts()).toEqual(before)
    input.db.close()
  })

  it('fingerprints unconstrained and expected-unassigned launches distinctly while replaying true null', () => {
    const unconstrained = fixture('expected-unassigned-fingerprint')
    const unconstrainedService = new OrchestrationService(
      unconstrained.db,
      new JobScheduler(unconstrained.db),
      { materialize: async (workspace) => workspace },
    )
    const request = {
      cardId: unconstrained.cardId,
      workspaceId: unconstrained.workspaceId,
      provider: 'claude',
      accessProfile: 'read_only' as const,
      idempotencyKey: 'runtime-binding:expected-unassigned-fingerprint:launch',
    }
    const first = unconstrainedService.createCardJob(request)

    expect(() => unconstrainedService.createCardJob({
      ...request,
      expectedJobAssignment: null,
    })).toThrow(/idempotency key was already used for a different launch request/)
    expect(unconstrainedService.createCardJob(request).job.id).toBe(first.job.id)
    unconstrained.db.close()

    const expectedUnassigned = fixture('expected-unassigned-null-replay')
    const expectedUnassignedService = new OrchestrationService(
      expectedUnassigned.db,
      new JobScheduler(expectedUnassigned.db),
      { materialize: async (workspace) => workspace },
    )
    const nullRequest = {
      cardId: expectedUnassigned.cardId,
      workspaceId: expectedUnassigned.workspaceId,
      provider: 'claude',
      accessProfile: 'read_only' as const,
      idempotencyKey: 'runtime-binding:expected-unassigned-null-replay:launch',
      expectedJobAssignment: null,
    }
    const nullFirst = expectedUnassignedService.createCardJob(nullRequest)

    expect(expectedUnassignedService.createCardJob(nullRequest).job.id)
      .toBe(nullFirst.job.id)
    expectedUnassigned.db.close()
  })

  it('rejects a new launch after the active assignment market version becomes stale with zero launch writes', () => {
    const input = fixture('stale-market')
    const claimed = claimAssignment(input)
    const updated = input.market.update(input.cardId, {
      objective: 'A changed contract requires a new canonical assignment',
    }, 'runtime-binding-test')
    expect(updated.market_version).toBeGreaterThan(
      claimed.assignment.assigned_market_version,
    )
    const orchestration = new OrchestrationService(
      input.db,
      new JobScheduler(input.db),
      { materialize: async (workspace) => workspace },
    )
    const counts = () => Object.fromEntries([
      'jobs',
      'delivery_reports',
      'workspace_assignments',
      'agent_sessions',
      'workspaces',
      'os_events',
    ].map((table) => [
      table,
      (input.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count,
    ]))
    const before = counts()

    expect(() => orchestration.createCardJob({
      cardId: input.cardId,
      workspaceId: input.workspaceId,
      provider: 'claude',
      accessProfile: 'read_only',
      idempotencyKey: 'runtime-binding:stale-market:launch',
    })).toThrow(/active job assignment market version is inconsistent/)

    expect(counts()).toEqual(before)
    expect(input.db.prepare('SELECT COUNT(*) AS count FROM jobs').get())
      .toEqual({ count: 0 })
    input.db.close()
  })

  it('normalizes a deferred assigned launch from durable workspace assignment identity only', async () => {
    const input = fixture('deferred-envelope')
    claimAssignment(input)
    const scheduler = new JobScheduler(input.db)
    const orchestration = new OrchestrationService(input.db, scheduler, {
      materialize: async (workspace) => workspace,
    })

    const launched = await orchestration.launchCard({
      cardId: input.cardId,
      workspaceId: input.workspaceId,
      provider: 'claude',
      accessProfile: 'read_only',
      idempotencyKey: 'runtime-binding:deferred-envelope:launch',
    })
    const identity = orchestrationIdentity('canonical', launched)
    const envelope = {
      mode: 'canonical' as const,
      orchestration: identity,
      contract: launched.contract,
      delivery: {
        ...launched.delivery,
        contract_id: identity.contract_id,
      },
      job: launched.job,
      workspace: launched.workspace,
      session: launched.session,
      dispatch: launched.dispatch,
      dispatch_error: launched.dispatch_error,
    }

    expect(launched.job.status).toBe('queued')
    expect(launched.session).toMatchObject({
      status: 'reserved',
      profile_id: null,
      workspace_assignment_id: expect.any(String),
    })
    expect(identity.assignment_id).toBe(launched.session?.workspace_assignment_id)
    expect(identity.workspace_assignment_id)
      .toBe(launched.session?.workspace_assignment_id)
    expect(normalizeCanonicalLifecycleResponse(envelope).session.profile_id)
      .toBeNull()

    const forgedEnvelope = structuredClone(envelope)
    forgedEnvelope.session!.workspace_assignment_id = 'forged-workspace-assignment'
    expect(() => normalizeCanonicalLifecycleResponse(forgedEnvelope))
      .toThrow(/orchestration.assignment_id does not match/)

    input.db.prepare(`
      UPDATE agent_sessions
      SET context_json=json_set(
        context_json,
        '$.assignment_id',
        'forged-workspace-assignment',
        '$.workspace_assignment_id',
        'forged-workspace-assignment'
      )
      WHERE id=?
    `).run(launched.session!.id)
    expect(() => orchestration.getJobSnapshot(launched.job.id))
      .toThrow(/workspace assignment context is inconsistent/)
    input.db.close()
  })

  it('launches with the assigned Agent Home identity and immutable Delivery prompt', async () => {
    const input = fixture('managed-launch')
    const claimed = claimAssignment(input)
    const runtime = createAgentOsRuntime(input.db)
    const requests: DriverLaunchRequest[] = []
    const driver: AgentDriver = {
      id: 'claude',
      capabilities: () => ({
        attach: true,
        streaming: true,
        interrupt: true,
        stop: true,
        rawTerminal: false,
        resume: true,
        managesAgentIdentity: true,
      }),
      launch: async (request) => {
        requests.push(request)
        return {
          id: 'claude:managed-launch',
          externalId: 'managed-launch-thread',
          driverId: 'claude',
          workspaceId: request.workspaceId,
          status: 'running',
          startedAt: new Date().toISOString(),
          metadata: {},
        }
      },
      attach: async () => null,
      send: async () => undefined,
      interrupt: async () => undefined,
      stop: async () => undefined,
      events: async function* (sessionId) {
        yield {
          sessionId,
          seq: 1,
          type: 'exit',
          at: new Date().toISOString(),
          data: 'completed',
        }
      },
    }
    runtime.registerDriver(driver)

    try {
      const orchestration = new OrchestrationService(input.db, runtime.scheduler, {
        materialize: async (workspace) => workspace,
      })
      const reserved = orchestration.createCardJob({
        cardId: input.cardId,
        workspaceId: input.workspaceId,
        provider: 'claude',
        accessProfile: 'read_only',
        maxAttempts: 1,
        idempotencyKey: 'runtime-binding:managed-launch:launch',
      })
      const frozenObjective = reserved.delivery.asked.objective
      new TaskContractService(input.db).put(input.cardId, {
        objective: 'MUTATED RUNTIME OBJECTIVE MUST NOT ENTER THE PROVIDER PROMPT',
      })

      expect((await runtime.scheduler.tick()).started).toEqual([reserved.job.id])
      await eventually(() => runtime.scheduler.get(reserved.job.id)?.status === 'succeeded')

      expect(requests).toHaveLength(1)
      expect((requests[0] as DriverLaunchRequest & { prompt?: string }).prompt)
        .toContain(`Objective: ${frozenObjective}`)
      expect((requests[0] as DriverLaunchRequest & { prompt?: string }).prompt)
        .not.toContain('MUTATED RUNTIME OBJECTIVE')
      expect(requests[0].metadata).toMatchObject({
        jobId: reserved.job.id,
        job_assignment_id: claimed.assignment.id,
        assigned_profile_id: input.profileId,
        assignment_market_version: claimed.assignment.assigned_market_version,
        agentProfileId: input.profileId,
      })
      const session = input.db.prepare(`
        SELECT job_id, profile_id, conversation_id,
          job_assignment_id, assigned_profile_id, assignment_market_version
        FROM agent_sessions WHERE id=?
      `).get(reserved.session!.id) as Record<string, unknown>
      expect(session).toMatchObject({
        job_id: reserved.job.id,
        profile_id: input.profileId,
        job_assignment_id: claimed.assignment.id,
        assigned_profile_id: input.profileId,
        assignment_market_version: claimed.assignment.assigned_market_version,
      })
      expect(session.conversation_id).toBeTruthy()
      expect(input.db.prepare('SELECT COUNT(*) AS count FROM agent_profiles').get())
        .toEqual({ count: 1 })
      expect(input.db.prepare('SELECT COUNT(*) AS count FROM agent_conversations').get())
        .toEqual({ count: 1 })
    } finally {
      await runtime.shutdown()
      input.db.close()
    }
  })

  it('stops and durably blocks a provider launch that returns a different workspace', async () => {
    const input = fixture('workspace-mismatch')
    claimAssignment(input)
    const runtime = createAgentOsRuntime(input.db)
    const stopped: string[] = []
    const driver: AgentDriver = {
      id: 'claude',
      capabilities: () => ({
        attach: true,
        streaming: true,
        interrupt: true,
        stop: true,
        rawTerminal: false,
        resume: true,
        managesAgentIdentity: true,
      }),
      launch: async () => ({
        id: 'claude:wrong-workspace',
        externalId: 'wrong-workspace-thread',
        driverId: 'claude',
        workspaceId: 'attacker-controlled-workspace',
        status: 'running',
        startedAt: new Date().toISOString(),
        metadata: {},
      }),
      attach: async () => null,
      send: async () => undefined,
      interrupt: async () => undefined,
      stop: async (sessionId) => {
        stopped.push(sessionId)
      },
      events: async function* () {},
    }
    runtime.registerDriver(driver)

    try {
      const orchestration = new OrchestrationService(input.db, runtime.scheduler, {
        materialize: async (workspace) => workspace,
      })
      const reserved = orchestration.createCardJob({
        cardId: input.cardId,
        workspaceId: input.workspaceId,
        provider: 'claude',
        accessProfile: 'read_only',
        maxAttempts: 1,
        idempotencyKey: 'runtime-binding:workspace-mismatch:launch',
      })

      const dispatch = await runtime.scheduler.tick()

      expect(dispatch.blocked).toEqual([reserved.job.id])
      expect(stopped).toEqual(['claude:wrong-workspace'])
      expect(runtime.scheduler.get(reserved.job.id)).toMatchObject({
        status: 'blocked',
        error: expect.stringMatching(/workspace does not match/),
      })
      expect(input.db.prepare('SELECT status, external_id FROM agent_sessions WHERE id=?')
        .get(reserved.session!.id)).toEqual({ status: 'failed', external_id: null })
      expect(input.db.prepare(`
        SELECT COUNT(*) AS count FROM os_events
        WHERE job_id=? AND kind='agent_session.started'
      `).get(reserved.job.id)).toEqual({ count: 0 })
      expect(input.db.prepare('SELECT owner_agent_id FROM cards WHERE id=?')
        .get(input.cardId)).toEqual({ owner_agent_id: null })
    } finally {
      await runtime.shutdown()
      input.db.close()
    }
  })

  it('rejects provider launches with mismatched, terminal, or empty session identity', async () => {
    const scenarios = [
      {
        suffix: 'wrong-driver',
        id: 'claude:wrong-driver',
        externalId: 'wrong-driver-thread',
        driverId: 'codex',
        status: 'running',
        error: /driver does not match/,
        stopped: ['claude:wrong-driver'],
      },
      {
        suffix: 'terminal-status',
        id: 'claude:terminal-status',
        externalId: 'terminal-status-thread',
        driverId: 'claude',
        status: 'stopped',
        error: /terminal or stopping status/,
        stopped: ['claude:terminal-status'],
      },
      {
        suffix: 'empty-session-id',
        id: '',
        externalId: 'empty-session-id-thread',
        driverId: 'claude',
        status: 'running',
        error: /identity is empty/,
        stopped: [],
      },
      {
        suffix: 'empty-external-id',
        id: 'claude:empty-external-id',
        externalId: '',
        driverId: 'claude',
        status: 'running',
        error: /identity is empty/,
        stopped: ['claude:empty-external-id'],
      },
    ] as const

    for (const scenario of scenarios) {
      const input = fixture(`provider-binding-${scenario.suffix}`)
      claimAssignment(input)
      const runtime = createAgentOsRuntime(input.db)
      const stopped: string[] = []
      const driver: AgentDriver = {
        id: 'claude',
        capabilities: () => ({
          attach: true,
          streaming: true,
          interrupt: true,
          stop: true,
          rawTerminal: false,
          resume: true,
          managesAgentIdentity: true,
        }),
        launch: async (request) => ({
          id: scenario.id,
          externalId: scenario.externalId,
          driverId: scenario.driverId,
          workspaceId: request.workspaceId,
          status: scenario.status,
          startedAt: new Date().toISOString(),
          metadata: {},
        }),
        attach: async () => null,
        send: async () => undefined,
        interrupt: async () => undefined,
        stop: async (sessionId) => {
          stopped.push(sessionId)
        },
        events: async function* () {},
      }
      runtime.registerDriver(driver)

      try {
        const orchestration = new OrchestrationService(input.db, runtime.scheduler, {
          materialize: async (workspace) => workspace,
        })
        const reserved = orchestration.createCardJob({
          cardId: input.cardId,
          workspaceId: input.workspaceId,
          provider: 'claude',
          accessProfile: 'read_only',
          maxAttempts: 1,
          idempotencyKey: `runtime-binding:provider-binding:${scenario.suffix}`,
        })

        const dispatch = await runtime.scheduler.tick()

        expect(dispatch.blocked).toEqual([reserved.job.id])
        expect(stopped).toEqual([...scenario.stopped])
        expect(runtime.scheduler.get(reserved.job.id)).toMatchObject({
          status: 'blocked',
          error: expect.stringMatching(scenario.error),
        })
        expect(input.db.prepare('SELECT status, external_id FROM agent_sessions WHERE id=?')
          .get(reserved.session!.id)).toEqual({ status: 'failed', external_id: null })
        expect(input.db.prepare(`
          SELECT COUNT(*) AS count FROM os_events
          WHERE job_id=? AND kind='agent_session.started'
        `).get(reserved.job.id)).toEqual({ count: 0 })
      } finally {
        await runtime.shutdown()
        input.db.close()
      }
    }
  })

  it('stops and blocks a launch when its frozen workspace is revoked during provider startup', async () => {
    const input = fixture('workspace-revoked-during-launch')
    claimAssignment(input)
    const runtime = createAgentOsRuntime(input.db)
    const stopped: string[] = []
    const driver: AgentDriver = {
      id: 'claude',
      capabilities: () => ({
        attach: true,
        streaming: true,
        interrupt: true,
        stop: true,
        rawTerminal: false,
        resume: true,
        managesAgentIdentity: true,
      }),
      launch: async (request) => {
        input.db.exec('DROP TRIGGER job_assignment_workspace_runtime_guard')
        input.db.prepare("UPDATE workspaces SET status='failed' WHERE id=?")
          .run(request.workspaceId)
        return {
          id: 'claude:revoked-workspace',
          externalId: 'revoked-workspace-thread',
          driverId: 'claude',
          workspaceId: request.workspaceId,
          status: 'running',
          startedAt: new Date().toISOString(),
          metadata: {},
        }
      },
      attach: async () => null,
      send: async () => undefined,
      interrupt: async () => undefined,
      stop: async (sessionId) => {
        stopped.push(sessionId)
      },
      events: async function* () {},
    }
    runtime.registerDriver(driver)

    try {
      const orchestration = new OrchestrationService(input.db, runtime.scheduler, {
        materialize: async (workspace) => workspace,
      })
      const reserved = orchestration.createCardJob({
        cardId: input.cardId,
        workspaceId: input.workspaceId,
        provider: 'claude',
        accessProfile: 'read_only',
        maxAttempts: 1,
        idempotencyKey: 'runtime-binding:workspace-revoked-during-launch:launch',
      })

      const dispatch = await runtime.scheduler.tick()

      expect(dispatch.blocked).toEqual([reserved.job.id])
      expect(stopped).toEqual(['claude:revoked-workspace'])
      expect(runtime.scheduler.get(reserved.job.id)).toMatchObject({
        status: 'blocked',
        error: expect.stringMatching(/workspace was revoked during provider launch/),
      })
      expect(input.db.prepare('SELECT status FROM workspaces WHERE id=?')
        .get(input.workspaceId)).toEqual({ status: 'failed' })
      expect(input.db.prepare('SELECT status, external_id FROM agent_sessions WHERE id=?')
        .get(reserved.session!.id)).toEqual({ status: 'failed', external_id: null })
      expect(input.db.prepare(`
        SELECT COUNT(*) AS count FROM os_events
        WHERE job_id=? AND kind='agent_session.started'
      `).get(reserved.job.id)).toEqual({ count: 0 })
    } finally {
      await runtime.shutdown()
      input.db.close()
    }
  })

  it('reattaches only the exact retained assignment during daemon recovery', async () => {
    const prepared = prepareRecoverableAssignedJob('recovery-exact')
    const { input, snapshot } = prepared
    const runtime = createAgentOsRuntime(input.db)
    const attached: string[] = []
    const continued: string[] = []
    const driver: AgentDriver = {
      id: 'claude',
      capabilities: () => ({
        attach: true,
        streaming: true,
        interrupt: true,
        stop: true,
        rawTerminal: false,
        resume: true,
        managesAgentIdentity: true,
      }),
      launch: async () => {
        throw new Error('recovery must attach, not launch')
      },
      attach: async (externalId) => {
        attached.push(externalId)
        return {
          id: 'claude:recovery-exact',
          externalId,
          driverId: 'claude',
          workspaceId: input.workspaceId,
          status: 'running',
          startedAt: new Date().toISOString(),
          metadata: {},
        }
      },
      send: async (_sessionId, message) => {
        continued.push(message)
      },
      interrupt: async () => undefined,
      stop: async () => undefined,
      events: async function* (sessionId) {
        yield {
          sessionId,
          seq: 1,
          type: 'exit',
          at: new Date().toISOString(),
          data: 'completed',
        }
      },
    }
    runtime.registerDriver(driver)

    try {
      const result = await runtime.reconcileJobs()

      expect(result.resumed).toEqual([snapshot.job.id])
      expect(attached).toEqual(['recovery-exact-thread'])
      expect(continued).toHaveLength(1)
      await eventually(() => runtime.scheduler.get(snapshot.job.id)?.status === 'succeeded')
    } finally {
      await runtime.shutdown()
      input.db.close()
    }
  })

  it('rejects mismatched provider identity and terminal state during recovery', async () => {
    const scenarios = [
      {
        suffix: 'wrong-driver',
        driverId: 'codex',
        externalId: 'recovery-provider-wrong-driver-thread',
        status: 'running',
        error: /driver does not match/,
      },
      {
        suffix: 'terminal-status',
        driverId: 'claude',
        externalId: 'recovery-provider-terminal-status-thread',
        status: 'failed',
        error: /terminal or stopping status/,
      },
      {
        suffix: 'wrong-external',
        driverId: 'claude',
        externalId: 'attacker-substituted-thread',
        status: 'running',
        error: /external identity does not match/,
      },
    ] as const

    for (const scenario of scenarios) {
      const prepared = prepareRecoverableAssignedJob(
        `recovery-provider-${scenario.suffix}`,
      )
      const { input, snapshot } = prepared
      const runtime = createAgentOsRuntime(input.db)
      const attached: string[] = []
      const detached: string[] = []
      const sent: string[] = []
      const driver: AgentDriver = {
        id: 'claude',
        capabilities: () => ({
          attach: true,
          streaming: true,
          interrupt: true,
          stop: true,
          rawTerminal: false,
          resume: true,
          managesAgentIdentity: true,
        }),
        launch: async () => {
          throw new Error('recovery must attach, not launch')
        },
        attach: async (externalId) => {
          attached.push(externalId)
          return {
            id: `claude:recovery-provider-${scenario.suffix}`,
            externalId: scenario.externalId,
            driverId: scenario.driverId,
            workspaceId: input.workspaceId,
            status: scenario.status,
            startedAt: new Date().toISOString(),
            metadata: {},
          }
        },
        send: async (sessionId) => {
          sent.push(sessionId)
        },
        interrupt: async () => undefined,
        stop: async () => undefined,
        detach: async (sessionId) => {
          detached.push(sessionId)
        },
        events: async function* () {},
      }
      runtime.registerDriver(driver)

      try {
        const result = await runtime.reconcileJobs()

        expect(result).toEqual({ resumed: [], recovered: [snapshot.job.id] })
        expect(attached).toEqual([
          `recovery-provider-${scenario.suffix}-thread`,
        ])
        expect(detached).toEqual([
          `claude:recovery-provider-${scenario.suffix}`,
        ])
        expect(sent).toEqual([])
        expect(runtime.scheduler.get(snapshot.job.id)).toMatchObject({
          status: 'blocked',
          error: expect.stringMatching(scenario.error),
        })
        expect(input.db.prepare('SELECT status FROM agent_sessions WHERE id=?')
          .get(snapshot.session!.id)).toEqual({ status: 'failed' })
      } finally {
        await runtime.shutdown()
        input.db.close()
      }
    }
  })

  it('does not stop an untrusted recovery handle when the driver cannot detach it', async () => {
    const prepared = prepareRecoverableAssignedJob('recovery-substitution-no-detach')
    const { input, snapshot } = prepared
    const runtime = createAgentOsRuntime(input.db)
    const stopped: string[] = []
    const sent: string[] = []
    const driver: AgentDriver = {
      id: 'claude',
      capabilities: () => ({
        attach: true,
        streaming: true,
        interrupt: true,
        stop: true,
        rawTerminal: false,
        resume: true,
        managesAgentIdentity: true,
      }),
      launch: async () => {
        throw new Error('recovery must attach, not launch')
      },
      attach: async () => ({
        id: 'claude:untrusted-recovery-substitution',
        externalId: 'another-agents-provider-thread',
        driverId: 'claude',
        workspaceId: input.workspaceId,
        status: 'running',
        startedAt: new Date().toISOString(),
        metadata: {},
      }),
      send: async (sessionId) => {
        sent.push(sessionId)
      },
      interrupt: async () => undefined,
      stop: async (sessionId) => {
        stopped.push(sessionId)
      },
      events: async function* () {},
    }
    runtime.registerDriver(driver)

    try {
      expect(await runtime.reconcileJobs()).toEqual({
        resumed: [],
        recovered: [snapshot.job.id],
      })
      expect(stopped).toEqual([])
      expect(sent).toEqual([])
      expect(runtime.scheduler.get(snapshot.job.id)).toMatchObject({
        status: 'blocked',
        error: expect.stringMatching(/external identity does not match/),
      })
      expect(input.db.prepare('SELECT status FROM agent_sessions WHERE id=?')
        .get(snapshot.session!.id)).toEqual({ status: 'failed' })
    } finally {
      await runtime.shutdown()
      input.db.close()
    }
  })

  it('stops an exact recovery handle before failing durable state when continuation fails', async () => {
    const prepared = prepareRecoverableAssignedJob('recovery-continuation-failure')
    const { input, snapshot } = prepared
    const runtime = createAgentOsRuntime(input.db)
    const stopped: string[] = []
    const driver: AgentDriver = {
      id: 'claude',
      capabilities: () => ({
        attach: true,
        streaming: true,
        interrupt: true,
        stop: true,
        rawTerminal: false,
        resume: true,
        managesAgentIdentity: true,
      }),
      launch: async () => {
        throw new Error('recovery must attach, not launch')
      },
      attach: async (externalId) => ({
        id: 'claude:recovery-continuation-failure',
        externalId,
        driverId: 'claude',
        workspaceId: input.workspaceId,
        status: 'running',
        startedAt: new Date().toISOString(),
        metadata: {},
      }),
      send: async () => {
        throw new Error('continuation delivery failed')
      },
      interrupt: async () => undefined,
      stop: async (sessionId) => {
        stopped.push(sessionId)
      },
      events: async function* () {},
    }
    runtime.registerDriver(driver)

    try {
      expect(await runtime.reconcileJobs()).toEqual({
        resumed: [],
        recovered: [snapshot.job.id],
      })
      expect(stopped).toEqual(['claude:recovery-continuation-failure'])
      expect(runtime.scheduler.get(snapshot.job.id)).toMatchObject({
        status: 'blocked',
        error: expect.stringMatching(/continuation delivery failed/),
      })
      expect(input.db.prepare('SELECT status FROM agent_sessions WHERE id=?')
        .get(snapshot.session!.id)).toEqual({ status: 'failed' })
    } finally {
      await runtime.shutdown()
      input.db.close()
    }
  })

  it('does not stop a substituted provider session during cancellation attach', async () => {
    const prepared = prepareRecoverableAssignedJob('cancel-provider-substitution')
    const { input, snapshot } = prepared
    const runtime = createAgentOsRuntime(input.db)
    const attached: string[] = []
    const detached: string[] = []
    const stopped: string[] = []
    const driver: AgentDriver = {
      id: 'claude',
      capabilities: () => ({
        attach: true,
        streaming: true,
        interrupt: true,
        stop: true,
        rawTerminal: false,
        resume: true,
        managesAgentIdentity: true,
      }),
      launch: async () => {
        throw new Error('cancellation must attach, not launch')
      },
      attach: async (externalId) => {
        attached.push(externalId)
        return {
          id: 'claude:cancel-provider-substitution',
          externalId: 'attacker-substituted-thread',
          driverId: 'claude',
          workspaceId: input.workspaceId,
          status: 'running',
          startedAt: new Date().toISOString(),
          metadata: {},
        }
      },
      send: async () => undefined,
      interrupt: async () => undefined,
      stop: async (sessionId) => {
        stopped.push(sessionId)
      },
      detach: async (sessionId) => {
        detached.push(sessionId)
      },
      events: async function* () {},
    }
    runtime.registerDriver(driver)

    try {
      await expect(runtime.scheduler.cancel(snapshot.job.id))
        .rejects.toThrow(/external identity does not match/)
      expect(attached).toEqual(['cancel-provider-substitution-thread'])
      expect(detached).toEqual(['claude:cancel-provider-substitution'])
      expect(stopped).toEqual([])
      expect(runtime.scheduler.get(snapshot.job.id)).toMatchObject({
        status: 'cancelling',
        error: expect.stringMatching(/cancellation not confirmed.*external identity/),
      })
      expect(input.db.prepare('SELECT status FROM agent_sessions WHERE id=?')
        .get(snapshot.session!.id)).toEqual({ status: 'running' })
    } finally {
      await runtime.shutdown()
      input.db.close()
    }
  })

  it('does not resume or fail a durable session when cancellation wins the recovery attach race', async () => {
    const prepared = prepareRecoverableAssignedJob('recovery-cancel-race')
    const { input, snapshot } = prepared
    const runtime = createAgentOsRuntime(input.db)
    const attached: string[] = []
    const detached: string[] = []
    const stopped: string[] = []
    const sent: string[] = []
    let attachCalls = 0
    let announceRecoveryAttach!: () => void
    let resolveRecoveryAttach!: (session: DriverSession) => void
    const recoveryAttachStarted = new Promise<void>((resolve) => {
      announceRecoveryAttach = resolve
    })
    const pendingRecoveryAttach = new Promise<DriverSession>((resolve) => {
      resolveRecoveryAttach = resolve
    })
    const providerSession = (id: string): DriverSession => ({
      id,
      externalId: 'recovery-cancel-race-thread',
      driverId: 'claude',
      workspaceId: input.workspaceId,
      status: 'running',
      startedAt: new Date().toISOString(),
      metadata: {},
    })
    const driver: AgentDriver = {
      id: 'claude',
      capabilities: () => ({
        attach: true,
        streaming: true,
        interrupt: true,
        stop: true,
        rawTerminal: false,
        resume: true,
        managesAgentIdentity: true,
      }),
      launch: async () => {
        throw new Error('recovery and cancellation must attach, not launch')
      },
      attach: async (externalId) => {
        attached.push(externalId)
        attachCalls += 1
        if (attachCalls === 1) {
          announceRecoveryAttach()
          return pendingRecoveryAttach
        }
        return providerSession('claude:recovery-cancel-race-stop')
      },
      send: async (sessionId) => {
        sent.push(sessionId)
      },
      interrupt: async () => undefined,
      stop: async (sessionId) => {
        stopped.push(sessionId)
      },
      detach: async (sessionId) => {
        detached.push(sessionId)
      },
      events: async function* () {},
    }
    runtime.registerDriver(driver)

    try {
      const recovery = runtime.reconcileJobs()
      await recoveryAttachStarted
      await runtime.scheduler.cancel(snapshot.job.id)
      resolveRecoveryAttach(providerSession('claude:recovery-cancel-race-resume'))

      expect(await recovery).toEqual({
        resumed: [],
        recovered: [snapshot.job.id],
      })
      expect(attached).toEqual([
        'recovery-cancel-race-thread',
        'recovery-cancel-race-thread',
      ])
      expect(stopped).toEqual(['claude:recovery-cancel-race-stop'])
      expect(detached).toEqual(['claude:recovery-cancel-race-resume'])
      expect(sent).toEqual([])
      expect(runtime.scheduler.get(snapshot.job.id)).toMatchObject({
        status: 'cancelled',
        error: null,
      })
      expect(input.db.prepare('SELECT status FROM agent_sessions WHERE id=?')
        .get(snapshot.session!.id)).toEqual({ status: 'stopped' })
      expect(input.db.prepare(`
        SELECT COUNT(*) AS count FROM os_events
        WHERE job_id=? AND kind='agent_session.failed'
      `).get(snapshot.job.id)).toEqual({ count: 0 })
    } finally {
      await runtime.shutdown()
      input.db.close()
    }
  })

  it('rejects assigned recovery when the durable workspace is no longer active', async () => {
    const prepared = prepareRecoverableAssignedJob('recovery-inactive-workspace')
    const { input, snapshot } = prepared
    input.db.exec('DROP TRIGGER job_assignment_workspace_runtime_guard')
    input.db.prepare("UPDATE workspaces SET status='archived' WHERE id=?")
      .run(input.workspaceId)
    const runtime = createAgentOsRuntime(input.db)
    let attachCalls = 0
    const driver: AgentDriver = {
      id: 'claude',
      capabilities: () => ({
        attach: true,
        streaming: true,
        interrupt: true,
        stop: true,
        rawTerminal: false,
        resume: true,
        managesAgentIdentity: true,
      }),
      launch: async () => {
        throw new Error('recovery must not launch')
      },
      attach: async () => {
        attachCalls += 1
        return null
      },
      send: async () => undefined,
      interrupt: async () => undefined,
      stop: async () => undefined,
      events: async function* () {},
    }
    runtime.registerDriver(driver)

    try {
      const result = await runtime.reconcileJobs()

      expect(result).toEqual({ resumed: [], recovered: [snapshot.job.id] })
      expect(attachCalls).toBe(0)
      expect(runtime.scheduler.get(snapshot.job.id)).toMatchObject({
        status: 'blocked',
        error: expect.stringMatching(/workspace is no longer active/),
      })
      expect(input.db.prepare('SELECT status FROM agent_sessions WHERE id=?')
        .get(snapshot.session!.id)).toEqual({ status: 'failed' })
    } finally {
      await runtime.shutdown()
      input.db.close()
    }
  })

  it('rejects a corrupt assigned recovery binding before contacting the provider', async () => {
    const prepared = prepareRecoverableAssignedJob('recovery-corrupt')
    const { input, snapshot, conversationId } = prepared
    input.db.prepare(`
      UPDATE agent_conversations
      SET status='archived', archived_at=datetime('now'), updated_at=datetime('now')
      WHERE id=?
    `).run(conversationId)
    const runtime = createAgentOsRuntime(input.db)
    let attachCalls = 0
    const driver: AgentDriver = {
      id: 'claude',
      capabilities: () => ({
        attach: true,
        streaming: true,
        interrupt: true,
        stop: true,
        rawTerminal: false,
        resume: true,
        managesAgentIdentity: true,
      }),
      launch: async () => {
        throw new Error('recovery must not launch')
      },
      attach: async () => {
        attachCalls += 1
        return null
      },
      send: async () => undefined,
      interrupt: async () => undefined,
      stop: async () => undefined,
      events: async function* () {},
    }
    runtime.registerDriver(driver)

    try {
      const result = await runtime.reconcileJobs()

      expect(result.recovered).toEqual([snapshot.job.id])
      expect(attachCalls).toBe(0)
      expect(runtime.scheduler.get(snapshot.job.id)).toMatchObject({
        status: 'blocked',
        error: expect.stringMatching(/frozen job assignment is no longer recoverable/),
      })
      expect(input.db.prepare('SELECT status FROM agent_sessions WHERE id=?')
        .get(snapshot.session!.id)).toEqual({ status: 'failed' })
    } finally {
      await runtime.shutdown()
      input.db.close()
    }
  })

  it('uses relational job identity for agent controls and ignores forged context', async () => {
    const prepared = prepareRecoverableAssignedJob('relational-agent-control')
    const { input, snapshot } = prepared
    const decoyJobId = 'relational-agent-control-decoy'
    input.db.prepare(`
      INSERT INTO jobs (
        id, board_id, card_id, workspace_id, provider, driver_id, status
      ) VALUES (?, ?, NULL, ?, 'claude', 'claude', 'queued')
    `).run(decoyJobId, input.boardId, input.workspaceId)
    const ownerId = insertAgent(input, 'relational-agent-control-owner')
    input.db.prepare(`
      UPDATE agents
      SET session_id=?, provider='claude'
      WHERE id=?
    `).run(`agent-os:${decoyJobId}`, ownerId)
    input.db.prepare(`
      UPDATE agent_sessions
      SET agent_id=?,
        context_json=json_set(context_json, '$.job_id', ?),
        updated_at=datetime('now')
      WHERE id=?
    `).run(ownerId, decoyJobId, snapshot.session!.id)
    const runtime = createAgentOsRuntime(input.db)

    try {
      expect(await runtime.jobExecutor.fireManagedAgent(ownerId)).toBe(false)
      expect(runtime.scheduler.get(decoyJobId)?.status).toBe('queued')
      expect(runtime.scheduler.get(snapshot.job.id)?.status).toBe('running')

      input.db.prepare(`
        UPDATE agents SET session_id=? WHERE id=?
      `).run(`agent-os:${snapshot.job.id}`, ownerId)
      expect(runtime.jobExecutor.ownsAgent(ownerId)).toBe(true)
      expect(runtime.scheduler.get(decoyJobId)?.status).toBe('queued')
    } finally {
      await runtime.shutdown()
      input.db.close()
    }
  })

  it('rejects legacy session controls that forge an assigned job only in context', async () => {
    const input = fixture('relational-session-control')
    claimAssignment(input)
    const runtime = createAgentOsRuntime(input.db)
    const orchestration = new OrchestrationService(input.db, runtime.scheduler, {
      materialize: async (workspace) => workspace,
    })
    const reserved = orchestration.createCardJob({
      cardId: input.cardId,
      workspaceId: input.workspaceId,
      provider: 'claude',
      accessProfile: 'read_only',
      maxAttempts: 1,
      idempotencyKey: 'runtime-binding:relational-session-control:launch',
    })
    input.db.prepare(`
      INSERT INTO agent_sessions (
        id, workspace_id, provider, status, context_json
      ) VALUES (
        'relational-session-control-forged',
        ?, 'claude', 'idle', json_object('job_id', ?)
      )
    `).run(input.workspaceId, reserved.job.id)

    try {
      await expect(runtime.jobExecutor.stopAgentHomeSession(
        'relational-session-control-forged',
      )).rejects.toThrow(/not attached to a canonical Agent OS job/)
      expect(runtime.scheduler.get(reserved.job.id)?.status).toBe('queued')
      expect(input.db.prepare('SELECT status FROM agent_sessions WHERE id=?')
        .get(reserved.session!.id)).toEqual({ status: 'reserved' })
      expect(input.db.prepare('SELECT status FROM agent_sessions WHERE id=?')
        .get('relational-session-control-forged')).toEqual({ status: 'idle' })

      await expect(runtime.jobExecutor.stopAgentHomeSession(reserved.session!.id))
        .resolves.toBeUndefined()
      expect(runtime.scheduler.get(reserved.job.id)?.status).toBe('cancelled')
    } finally {
      await runtime.shutdown()
      input.db.close()
    }
  })

  it('rejects retries with unavailable frozen workspace before writing an action', async () => {
    for (const scenario of ['archived', 'relinked-null-assignment'] as const) {
      const input = fixture(`retry-workspace-${scenario}`)
      const claimed = scenario === 'relinked-null-assignment'
        ? (() => {
            input.db.prepare(
              'UPDATE task_contracts SET workspace_id=NULL WHERE card_id=?',
            ).run(input.cardId)
            const current = input.market.get(input.cardId)
            return input.assignments.claim({
              cardId: input.cardId,
              profileId: input.profileId,
              workspaceId: null,
              expectedMarketVersion: current.market_version,
              actor,
              idempotencyKey: `runtime-binding:retry-workspace-${scenario}:claim`,
            })
          })()
        : claimAssignment(input)
      const scheduler = new JobScheduler(input.db)
      const orchestration = new OrchestrationService(input.db, scheduler, {
        materialize: async (workspace) => workspace,
      })
      const parent = orchestration.createCardJob({
        cardId: input.cardId,
        workspaceId: input.workspaceId,
        provider: 'claude',
        accessProfile: 'read_only',
        maxAttempts: 1,
        idempotencyKey: `runtime-binding:retry-workspace-${scenario}:parent`,
      })
      linkAssignedSession(
        input,
        parent.session!.id,
        parent.job.id,
        `retry-workspace-${scenario}`,
      )
      scheduler.failBeforeLaunch(parent.job.id, 'make the parent retryable')

      if (scenario === 'archived') {
        new WorkspaceStore(input.db).archive(input.workspaceId)
      } else {
        expect(claimed.assignment.workspace_id).toBeNull()
        const otherCardId = Number(input.db.prepare(`
          INSERT INTO cards (board_id, title, description)
          VALUES (?, 'retry workspace replacement', 'must not inherit the retry')
        `).run(input.boardId).lastInsertRowid)
        new WorkspaceStore(input.db).update(input.workspaceId, {
          card_id: otherCardId,
        })
      }
      const lifecycle = new AgentHomeLifecycleService(input.db, {
        runtime: new RetryRuntime(),
        orchestration,
        scheduler,
      })
      const counts = () => Object.fromEntries([
        'jobs',
        'agent_sessions',
        'delivery_reports',
        'agent_session_actions',
        'os_events',
        'workspaces',
        'workspace_assignments',
      ].map((table) => [
        table,
        (input.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
          count: number
        }).count,
      ]))
      const before = counts()

      await expect(lifecycle.run(parent.session!.id, 'retry', {
        actor,
        idempotencyKey: `runtime-binding:retry-workspace-${scenario}:action`,
      })).rejects.toThrow(/frozen workspace/)
      expect(counts()).toEqual(before)
      input.db.close()
    }
  })

  it('retries with the exact parent assignment and rejects stale retries with zero writes', async () => {
    const input = fixture('retry-exact')
    const claimed = claimAssignment(input)
    const scheduler = new JobScheduler(input.db)
    const orchestration = new OrchestrationService(input.db, scheduler, {
      materialize: async (workspace) => workspace,
    })
    const parent = orchestration.createCardJob({
      cardId: input.cardId,
      workspaceId: input.workspaceId,
      provider: 'claude',
      accessProfile: 'read_only',
      maxAttempts: 1,
      idempotencyKey: 'runtime-binding:retry-exact:parent',
    })
    const conversationId = linkAssignedSession(
      input,
      parent.session!.id,
      parent.job.id,
      'retry-exact-parent',
    )
    scheduler.failBeforeLaunch(parent.job.id, 'make parent retryable')
    const lifecycle = new AgentHomeLifecycleService(input.db, {
      runtime: new RetryRuntime(),
      orchestration,
      scheduler,
    })

    const retried = await lifecycle.run(parent.session!.id, 'retry', {
      actor,
      idempotencyKey: 'runtime-binding:retry-exact:action',
    })
    const childJob = scheduler.get(retried.created_session!.job_id!)!

    expect(retried.created_session).toMatchObject({
      profile_id: input.profileId,
      conversation_id: conversationId,
      parent_session_id: parent.session!.id,
      lineage_type: 'retry',
      job_assignment_id: claimed.assignment.id,
      assigned_profile_id: input.profileId,
      assignment_market_version: claimed.assignment.assigned_market_version,
    })
    expect(childJob).toMatchObject({
      job_assignment_id: claimed.assignment.id,
      assigned_profile_id: input.profileId,
      assignment_market_version: claimed.assignment.assigned_market_version,
      status: 'queued',
    })
    expect(input.db.prepare('SELECT COUNT(*) AS count FROM delivery_reports').get())
      .toEqual({ count: 2 })
    const replay = await lifecycle.run(parent.session!.id, 'retry', {
      actor,
      idempotencyKey: 'runtime-binding:retry-exact:action',
    })
    expect(replay.action.replayed).toBe(true)
    expect(replay.created_session?.id).toBe(retried.created_session?.id)

    scheduler.failBeforeLaunch(childJob.id, 'make room for the stale retry proof')
    input.db.prepare(`
      UPDATE job_market_contracts SET version=version+1, updated_at=datetime('now')
      WHERE card_id=?
    `).run(input.cardId)
    const counts = () => Object.fromEntries([
      'jobs',
      'agent_sessions',
      'delivery_reports',
      'agent_session_actions',
      'os_events',
      'workspaces',
      'workspace_assignments',
    ].map((table) => [
      table,
      (input.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count,
    ]))
    const before = counts()

    await expect(lifecycle.run(parent.session!.id, 'retry', {
      actor,
      idempotencyKey: 'runtime-binding:retry-exact:stale-action',
    })).rejects.toThrow(/same active assignment and unchanged market version/)
    expect(counts()).toEqual(before)
    input.db.close()
  })
})
