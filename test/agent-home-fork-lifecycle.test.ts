import type Database from 'better-sqlite3'
import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AgentHomeForkOutcomeUnknownError,
  type AgentHomeNativeForkResult,
} from '../src/agent-os/agent-home-fork.js'
import {
  AgentHomeLifecycleService,
  type AgentHomeRuntimeControl,
  type RuntimeActionCapabilities,
} from '../src/agent-os/agent-home-lifecycle.js'
import { AgentProfileService } from '../src/agent-os/agent-profiles.js'
import { ArtifactStore } from '../src/agent-os/artifact-store.js'
import { ConversationService, type AgentSessionRecord } from '../src/agent-os/conversations.js'
import { openDb } from '../src/db.js'
import { buildServer } from '../src/server.js'

const actor = { type: 'operator' as const, id: 'fork-lifecycle-test' }
const databases: Database.Database[] = []
const servers: FastifyInstance[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
  for (const db of databases.splice(0)) db.close()
})

class ForkRuntime implements AgentHomeRuntimeControl {
  readonly calls: string[] = []
  readonly adoptions: Array<{ parent: string; child: string; action: string }> = []
  readonly verifications: string[] = []

  constructor(
    private readonly behavior:
      | AgentHomeNativeForkResult
      | ((session: AgentSessionRecord) => AgentHomeNativeForkResult | Promise<AgentHomeNativeForkResult>),
    private readonly targetWorkspaceId: string,
    private readonly verification:
      | AgentHomeNativeForkResult
      | ((session: AgentSessionRecord) => AgentHomeNativeForkResult | Promise<AgentHomeNativeForkResult>)
      = behavior,
  ) {}

  agentHomeSessionCapabilities(): RuntimeActionCapabilities {
    const unavailable = { supported: false, reason: 'not exercised by fork tests' }
    return {
      pause: unavailable,
      resume: unavailable,
      stop: unavailable,
      retry: unavailable,
      fork: { supported: true, reason: null },
    }
  }

  async pauseAgentHomeSession(): Promise<void> {
    throw new Error('not exercised')
  }

  async resumeAgentHomeSession(): Promise<void> {
    throw new Error('not exercised')
  }

  async stopAgentHomeSession(): Promise<void> {
    throw new Error('not exercised')
  }

  async prepareAgentHomeForkSession(): Promise<{ workspaceId: string }> {
    return { workspaceId: this.targetWorkspaceId }
  }

  async forkAgentHomeSession(
    session: AgentSessionRecord,
  ): Promise<AgentHomeNativeForkResult> {
    this.calls.push(session.id)
    return typeof this.behavior === 'function'
      ? this.behavior(session)
      : this.behavior
  }

  async verifyAgentHomeForkChild(
    session: AgentSessionRecord,
  ): Promise<AgentHomeNativeForkResult> {
    this.verifications.push(session.id)
    return typeof this.verification === 'function'
      ? this.verification(session)
      : this.verification
  }

  async adoptAgentHomeForkSession(
    parent: AgentSessionRecord,
    child: AgentSessionRecord,
    operation: { actionId: string },
  ): Promise<void> {
    this.adoptions.push({
      parent: parent.id,
      child: child.id,
      action: operation.actionId,
    })
  }
}

describe('Agent Home native fork lifecycle', () => {
  it('keeps native fork operator-only and returns the child through the authenticated API', async () => {
    const db = trackedDb()
    const fixture = seedForkHome(db)
    const runtime = new ForkRuntime(successfulFork(fixture), fixture.targetWorkspaceId)
    const server = buildServer(db, undefined, {
      token: 'fork-operator',
      agentToken: 'fork-agent',
      agentOs: { agentHomeLifecycle: runtime },
    })
    servers.push(server)
    await server.ready()

    const forbidden = await server.inject({
      method: 'POST',
      url: `/api/v1/os/sessions/${fixture.sessionId}/fork`,
      headers: {
        authorization: 'Bearer fork-agent',
        'idempotency-key': 'fork:api:agent',
      },
    })
    expect(forbidden.statusCode).toBe(403)
    expect(runtime.calls).toEqual([])

    const created = await server.inject({
      method: 'POST',
      url: `/api/v1/os/sessions/${fixture.sessionId}/fork`,
      headers: {
        authorization: 'Bearer fork-operator',
        'idempotency-key': 'fork:api:operator',
      },
    })
    expect(created.statusCode).toBe(200)
    expect(created.json()).toMatchObject({
      action: {
        type: 'fork',
        target_session_id: fixture.sessionId,
        replayed: false,
      },
      session: { id: fixture.sessionId },
      created_session: {
        external_id: fixture.childExternalId,
        parent_session_id: fixture.sessionId,
        lineage_type: 'fork',
        control_state: 'active',
      },
      links: {
        profile_id: fixture.profileId,
        session_id: expect.any(String),
      },
    })
    expect(runtime.calls).toEqual([fixture.sessionId])

    const childId = created.json().created_session.id as string
    const child = await server.inject({
      method: 'GET',
      url: `/api/v1/os/sessions/${childId}`,
      headers: { authorization: 'Bearer fork-agent' },
    })
    expect(child.statusCode).toBe(200)
    expect(child.json().session).toMatchObject({
      id: childId,
      external_id: fixture.childExternalId,
      recovery_state: 'attachable',
    })
  })

  it('persists a detached independent child, safe history snapshot, and idempotent result', async () => {
    const db = trackedDb()
    const fixture = seedForkHome(db)
    appendUnsafeSourceHistory(db, fixture)
    const runtime = new ForkRuntime(successfulFork(fixture), fixture.targetWorkspaceId)
    const lifecycle = new AgentHomeLifecycleService(db, {
      runtime,
      actionLeaseId: 'fork-success-daemon',
    })

    const first = await lifecycle.run(fixture.sessionId, 'fork', {
      actor,
      idempotencyKey: 'fork:success',
    })
    const replay = await lifecycle.run(fixture.sessionId, 'fork', {
      actor,
      idempotencyKey: 'fork:success',
    })

    expect(runtime.calls).toEqual([fixture.sessionId])
    expect(first.action).toMatchObject({
      type: 'fork',
      target_session_id: fixture.sessionId,
      replayed: false,
    })
    expect(replay.action).toMatchObject({
      id: first.action.id,
      replayed: true,
    })
    expect(replay.created_session?.id).toBe(first.created_session?.id)
    expect(first.session).toMatchObject({
      id: fixture.sessionId,
      status: 'running',
      control_state: 'active',
      job_id: fixture.jobId,
    })
    expect(first.created_session).toMatchObject({
      agent_id: null,
      provider: 'codex',
      external_id: fixture.childExternalId,
      provider_thread_id: fixture.childExternalId,
      status: 'idle',
      job_id: null,
      recovery_state: 'attachable',
      history_state: 'complete',
      parent_session_id: fixture.sessionId,
      lineage_type: 'fork',
      control_state: 'active',
      workspace_id: fixture.targetWorkspaceId,
      profile_id: fixture.profileId,
    })
    expect(first.created_session?.conversation_id).not.toBe(fixture.conversationId)
    expect(first.created_session?.display_name).toContain('[REDACTED]')
    expect(first.created_session?.display_name).not.toContain('FORK_NAME_SECRET')

    const childEvents = db.prepare(`SELECT sequence, provider_event_id,
      provider_thread_id, provider_turn_id, provider_item_id, provider_cursor,
      correlation_id, causation_id, projected_text, metadata_json, raw_artifact_id,
      redaction_state, retention_class
      FROM conversation_events WHERE session_id=? ORDER BY sequence`)
      .all(first.created_session!.id) as Array<Record<string, unknown>>
    expect(childEvents).toHaveLength(2)
    expect(childEvents.map((event) => event.sequence)).toEqual([1, 2])
    for (const event of childEvents) {
      expect(event).toMatchObject({
        provider_event_id: null,
        provider_thread_id: null,
        provider_turn_id: null,
        provider_item_id: null,
        provider_cursor: null,
        correlation_id: null,
        causation_id: null,
        raw_artifact_id: null,
      })
      expect(JSON.parse(String(event.metadata_json))).toEqual({
        fork_snapshot: true,
        source_conversation_event_id: expect.any(String),
        source_sequence: expect.any(Number),
      })
      expect(String(event.metadata_json)).not.toContain('RAW_METADATA_SECRET')
    }
    expect(childEvents[0]).toMatchObject({
      projected_text: 'Authorization: Basic [REDACTED]',
      redaction_state: 'redacted',
      retention_class: 'transcript',
    })
    expect(childEvents[1]).toMatchObject({
      projected_text: null,
      redaction_state: 'withheld',
    })

    const action = db.prepare(`SELECT status, effect_state, result_session_id, effect_json
      FROM agent_session_actions WHERE id=?`).get(first.action.id) as Record<string, unknown>
    expect(action).toMatchObject({
      status: 'succeeded',
      effect_state: 'completed',
      result_session_id: first.created_session?.id,
    })
    expect(String(action.effect_json)).not.toContain('RAW_METADATA_SECRET')
    expect((db.prepare(`SELECT COUNT(*) AS count FROM os_events
      WHERE kind='agent_session.fork' AND job_id=? AND session_id=?`)
      .get(fixture.jobId, fixture.sessionId) as { count: number }).count).toBe(1)
  })

  it('quarantines an outcome-unknown child without persisting provider errors or a fake session', async () => {
    const db = trackedDb()
    const fixture = seedForkHome(db)
    const runtime = new ForkRuntime(() => {
      throw new AgentHomeForkOutcomeUnknownError(
        'RAW_RPC_PAYLOAD_SHOULD_NOT_PERSIST',
        fixture.sourceExternalId,
        fixture.sourceExternalId,
        {
          externalId: fixture.childExternalId,
          providerThreadId: fixture.childExternalId,
          forkedFromId: fixture.sourceExternalId,
          childProviderSessionId: 'provider-session-child',
          subscriptionReleased: true,
        },
      )
    }, fixture.targetWorkspaceId)
    const lifecycle = new AgentHomeLifecycleService(db, {
      runtime,
      actionLeaseId: 'fork-unknown-daemon',
    })

    await expect(lifecycle.run(fixture.sessionId, 'fork', {
      actor,
      idempotencyKey: 'fork:unknown',
    })).rejects.toThrow('provider fork outcome is unknown and requires operator reconciliation')

    const action = db.prepare(`SELECT status, effect_state, error_code, error_message, effect_json
      FROM agent_session_actions WHERE idempotency_key='fork:unknown'`).get() as
      Record<string, unknown>
    expect(action).toMatchObject({
      status: 'failed',
      effect_state: 'outcome_unknown',
      error_code: 'action_outcome_unknown',
      error_message: 'provider fork outcome is unknown and requires operator reconciliation',
    })
    expect(JSON.parse(String(action.effect_json))).toEqual({
      outcome: 'unknown',
      source_session_id: fixture.sessionId,
      provider: 'codex',
      fork_target: { workspace_id: fixture.targetWorkspaceId },
      quarantined_child: {
        external_id: fixture.childExternalId,
        provider_thread_id: fixture.childExternalId,
        forked_from_id: fixture.sourceExternalId,
        provider_session_id: 'provider-session-child',
        subscription_released: true,
      },
    })
    expect(JSON.stringify(action)).not.toContain('RAW_RPC_PAYLOAD_SHOULD_NOT_PERSIST')
    expect(db.prepare('SELECT 1 FROM agent_sessions WHERE external_id=?')
      .get(fixture.childExternalId)).toBeUndefined()
    expect((db.prepare(`SELECT COUNT(*) AS count FROM attention_items
      WHERE kind='agent_session.fork_outcome_unknown' AND severity='high'`)
      .get() as { count: number }).count).toBe(1)
    const audit = db.prepare(`SELECT job_id, card_id, payload FROM os_events
      WHERE kind='agent_session.action_outcome_unknown'`).get() as
      { job_id: string; card_id: number; payload: string }
    expect(audit).toMatchObject({
      job_id: fixture.jobId,
      card_id: fixture.cardId,
    })
    expect(audit.payload).not.toContain('RAW_RPC_PAYLOAD_SHOULD_NOT_PERSIST')

    await expect(lifecycle.run(fixture.sessionId, 'fork', {
      actor,
      idempotencyKey: 'fork:blocked-after-unknown',
    })).rejects.toThrow('earlier provider outcome requires operator reconciliation')
    expect(runtime.calls).toEqual([fixture.sessionId])
  })

  it('checkpoints a known child and completes quarantine after audit storage recovers', async () => {
    const db = trackedDb()
    const fixture = seedForkHome(db)
    const runtime = new ForkRuntime(() => {
      throw new AgentHomeForkOutcomeUnknownError(
        'RAW_PROVIDER_ERROR',
        fixture.sourceExternalId,
        fixture.sourceExternalId,
        {
          externalId: fixture.childExternalId,
          providerThreadId: fixture.childExternalId,
          forkedFromId: fixture.sourceExternalId,
          childProviderSessionId: 'provider-session-child',
          subscriptionReleased: false,
        },
      )
    }, fixture.targetWorkspaceId)
    db.exec(`
      CREATE TRIGGER reject_fork_unknown_audit
      BEFORE INSERT ON os_events
      WHEN NEW.kind='agent_session.action_outcome_unknown'
      BEGIN
        SELECT RAISE(ABORT, 'fork quarantine audit unavailable');
      END;
    `)
    const lifecycle = new AgentHomeLifecycleService(db, {
      runtime,
      actionLeaseId: 'fork-before-audit-outage',
    })

    await expect(lifecycle.run(fixture.sessionId, 'fork', {
      actor,
      idempotencyKey: 'fork:audit-outage',
    })).rejects.toThrow('fork quarantine audit unavailable')
    const pending = db.prepare(`SELECT status, effect_state, effect_json
      FROM agent_session_actions WHERE idempotency_key='fork:audit-outage'`).get() as
      Record<string, unknown>
    expect(pending).toMatchObject({ status: 'pending', effect_state: 'invoking' })
    expect(String(pending.effect_json)).toContain(fixture.childExternalId)
    expect(String(pending.effect_json)).not.toContain('RAW_PROVIDER_ERROR')
    expect((db.prepare('SELECT COUNT(*) AS count FROM attention_items')
      .get() as { count: number }).count).toBe(0)

    db.exec('DROP TRIGGER reject_fork_unknown_audit')
    new AgentHomeLifecycleService(db, {
      runtime,
      actionLeaseId: 'fork-after-audit-outage',
    })

    expect(db.prepare(`SELECT status, effect_state, error_code, effect_json
      FROM agent_session_actions WHERE idempotency_key='fork:audit-outage'`).get())
      .toMatchObject({
        status: 'failed',
        effect_state: 'outcome_unknown',
        error_code: 'action_outcome_unknown',
        effect_json: expect.stringContaining(fixture.childExternalId),
      })
    expect((db.prepare(`SELECT COUNT(*) AS count FROM os_events
      WHERE kind='agent_session.action_outcome_unknown'`).get() as
      { count: number }).count).toBe(1)
    expect((db.prepare(`SELECT COUNT(*) AS count FROM attention_items
      WHERE kind='agent_session.fork_outcome_unknown'`).get() as
      { count: number }).count).toBe(1)
    expect(runtime.calls).toEqual([fixture.sessionId])
  })

  it('recovers an applied fork after completion audit failure without invoking the provider twice', async () => {
    const db = trackedDb()
    const fixture = seedForkHome(db)
    const runtime = new ForkRuntime(successfulFork(fixture), fixture.targetWorkspaceId)
    db.exec(`
      CREATE TRIGGER reject_fork_completion
      BEFORE INSERT ON os_events
      WHEN NEW.kind='agent_session.fork'
      BEGIN
        SELECT RAISE(ABORT, 'fork completion audit unavailable');
      END;
    `)
    const lifecycle = new AgentHomeLifecycleService(db, {
      runtime,
      actionLeaseId: 'fork-before-completion-outage',
    })

    await expect(lifecycle.run(fixture.sessionId, 'fork', {
      actor,
      idempotencyKey: 'fork:completion-outage',
    })).rejects.toThrow('fork completion audit unavailable')
    const pending = db.prepare(`SELECT status, effect_state, result_session_id
      FROM agent_session_actions WHERE idempotency_key='fork:completion-outage'`).get() as {
        status: string
        effect_state: string
        result_session_id: string
      }
    expect(pending).toMatchObject({ status: 'pending', effect_state: 'applied' })
    expect(pending.result_session_id).toEqual(expect.any(String))
    expect(db.prepare('SELECT external_id FROM agent_sessions WHERE id=?')
      .get(pending.result_session_id)).toEqual({ external_id: fixture.childExternalId })

    db.exec('DROP TRIGGER reject_fork_completion')
    const restarted = new AgentHomeLifecycleService(db, {
      runtime,
      actionLeaseId: 'fork-after-completion-outage',
    })
    const replay = await restarted.run(fixture.sessionId, 'fork', {
      actor,
      idempotencyKey: 'fork:completion-outage',
    })

    expect(replay.action.replayed).toBe(true)
    expect(replay.created_session?.id).toBe(pending.result_session_id)
    expect(runtime.calls).toEqual([fixture.sessionId])
    expect((db.prepare(`SELECT COUNT(*) AS count FROM agent_sessions
      WHERE parent_session_id=? AND lineage_type='fork'`).get(fixture.sessionId) as
      { count: number }).count).toBe(1)
    expect((db.prepare(`SELECT COUNT(*) AS count FROM os_events
      WHERE kind='agent_session.fork'`).get() as { count: number }).count).toBe(1)
  })

  it('rolls back every local child row when persistence fails after provider success', async () => {
    const db = trackedDb()
    const fixture = seedForkHome(db)
    const runtime = new ForkRuntime(successfulFork(fixture), fixture.targetWorkspaceId)
    db.exec(`
      CREATE TRIGGER reject_fork_child
      BEFORE INSERT ON agent_sessions
      WHEN NEW.lineage_type='fork'
      BEGIN
        SELECT RAISE(ABORT, 'fork child persistence unavailable');
      END;
    `)
    const lifecycle = new AgentHomeLifecycleService(db, {
      runtime,
      actionLeaseId: 'fork-child-persistence-outage',
    })

    await expect(lifecycle.run(fixture.sessionId, 'fork', {
      actor,
      idempotencyKey: 'fork:child-persistence-outage',
    })).rejects.toThrow('provider fork outcome is unknown and requires operator reconciliation')

    expect((db.prepare(`SELECT COUNT(*) AS count FROM agent_sessions
      WHERE parent_session_id=? OR external_id=?`).get(
      fixture.sessionId,
      fixture.childExternalId,
    ) as { count: number }).count).toBe(0)
    expect((db.prepare('SELECT COUNT(*) AS count FROM agent_conversations')
      .get() as { count: number }).count).toBe(1)
    expect(db.prepare(`SELECT status, effect_state, result_session_id
      FROM agent_session_actions WHERE idempotency_key='fork:child-persistence-outage'`).get())
      .toMatchObject({
        status: 'failed',
        effect_state: 'outcome_unknown',
        result_session_id: null,
      })
    expect(runtime.calls).toEqual([fixture.sessionId])
  })

  it('reconciles one exact known child through the operator API without reforking', async () => {
    const db = trackedDb()
    const fixture = seedForkHome(db)
    const unknown = () => {
      throw new AgentHomeForkOutcomeUnknownError(
        'RAW_PROVIDER_FAILURE',
        fixture.sourceExternalId,
        fixture.sourceExternalId,
        {
          externalId: fixture.childExternalId,
          providerThreadId: fixture.childExternalId,
          forkedFromId: fixture.sourceExternalId,
          childProviderSessionId: 'provider-child-session',
          subscriptionReleased: true,
        },
      )
    }
    const runtime = new ForkRuntime(
      unknown,
      fixture.targetWorkspaceId,
      successfulFork(fixture),
    )
    const server = buildServer(db, undefined, {
      token: 'fork-reconcile-operator',
      agentToken: 'fork-reconcile-agent',
      agentOs: { agentHomeLifecycle: runtime },
    })
    servers.push(server)
    await server.ready()

    const forked = await server.inject({
      method: 'POST',
      url: `/api/v1/os/sessions/${fixture.sessionId}/fork`,
      headers: {
        authorization: 'Bearer fork-reconcile-operator',
        'idempotency-key': 'fork:reconcile:unknown',
      },
    })
    expect(forked.statusCode).toBe(409)
    const action = db.prepare(`SELECT id FROM agent_session_actions
      WHERE idempotency_key='fork:reconcile:unknown'`).get() as { id: string }

    const forbidden = await server.inject({
      method: 'POST',
      url: `/api/v1/os/session-actions/${action.id}/reconcile`,
      headers: {
        authorization: 'Bearer fork-reconcile-agent',
        'idempotency-key': 'fork:reconcile:verify',
      },
      payload: { resolution: 'verify_adopt' },
    })
    expect(forbidden.statusCode).toBe(403)
    expect(runtime.verifications).toEqual([])

    const request = {
      method: 'POST' as const,
      url: `/api/v1/os/session-actions/${action.id}/reconcile`,
      headers: {
        authorization: 'Bearer fork-reconcile-operator',
        'idempotency-key': 'fork:reconcile:verify',
      },
      payload: {
        resolution: 'verify_adopt',
        note: 'Authorization: Bearer RAW_RECONCILIATION_SECRET',
      },
    }
    const reconciled = await server.inject(request)
    expect(reconciled.statusCode).toBe(200)
    expect(reconciled.json()).toMatchObject({
      reconciliation: {
        action_id: action.id,
        resolution: 'verify_adopt',
        replayed: false,
      },
      action: { status: 'succeeded', effect_state: 'completed' },
      created_session: {
        external_id: fixture.childExternalId,
        workspace_id: fixture.targetWorkspaceId,
        parent_session_id: fixture.sessionId,
        control_state: 'active',
      },
    })
    const replay = await server.inject(request)
    expect(replay.statusCode).toBe(200)
    expect(replay.json().reconciliation.replayed).toBe(true)
    expect(runtime.calls).toEqual([fixture.sessionId])
    expect(runtime.verifications).toEqual([fixture.sessionId])
    expect(runtime.adoptions).toHaveLength(1)
    expect((db.prepare(`SELECT COUNT(*) AS count
      FROM agent_session_action_reconciliations WHERE action_id=?`)
      .get(action.id) as { count: number }).count).toBe(1)
    const audit = db.prepare(`SELECT board_id, workspace_id, card_id, session_id,
      job_id, contract_id, payload FROM os_events
      WHERE kind='agent_session.fork_reconciled'`).get() as Record<string, unknown>
    expect(audit).toMatchObject({
      board_id: fixture.boardId,
      workspace_id: fixture.workspaceId,
      card_id: fixture.cardId,
      session_id: fixture.sessionId,
      job_id: fixture.jobId,
      contract_id: `card:${fixture.cardId}:v2`,
    })
    expect(String(audit.payload)).not.toContain('RAW_RECONCILIATION_SECRET')
    expect(JSON.stringify(db.prepare('SELECT payload FROM os_events').all()))
      .not.toContain('RAW_PROVIDER_FAILURE')
  })

  it('records a failed verification attempt without deadlocking a later confirmed-absent decision', async () => {
    const db = trackedDb()
    const fixture = seedForkHome(db)
    const runtime = new ForkRuntime(
      () => {
        throw new AgentHomeForkOutcomeUnknownError(
          'RAW_INITIAL_PROVIDER_FAILURE',
          fixture.sourceExternalId,
          fixture.sourceExternalId,
          {
            externalId: fixture.childExternalId,
            providerThreadId: fixture.childExternalId,
            forkedFromId: fixture.sourceExternalId,
            childProviderSessionId: 'provider-child-session',
            subscriptionReleased: true,
          },
        )
      },
      fixture.targetWorkspaceId,
      () => {
        throw new Error(
          'read failed Authorization: Bearer RAW_VERIFICATION_SECRET',
        )
      },
    )
    const lifecycle = new AgentHomeLifecycleService(db, {
      runtime,
      actionLeaseId: 'fork-failed-verification-daemon',
    })

    await expect(lifecycle.run(fixture.sessionId, 'fork', {
      actor,
      idempotencyKey: 'fork:failed-verification:unknown',
    })).rejects.toThrow(/requires operator reconciliation/)
    const action = db.prepare(`SELECT id FROM agent_session_actions
      WHERE idempotency_key='fork:failed-verification:unknown'`).get() as
      { id: string }

    await expect(lifecycle.reconcileFork(action.id, {
      actor,
      idempotencyKey: 'fork:failed-verification:verify',
      resolution: 'verify_adopt',
    })).rejects.toThrow('fork reconciliation did not complete')
    expect(db.prepare(`SELECT status, error_code, error_message
      FROM agent_session_action_reconciliations
      WHERE idempotency_key='fork:failed-verification:verify'`).get())
      .toEqual({
        status: 'failed',
        error_code: 'fork_reconciliation_failed',
        error_message: 'fork reconciliation did not complete',
      })

    const confirmed = await lifecycle.reconcileFork(action.id, {
      actor,
      idempotencyKey: 'fork:failed-verification:confirm',
      resolution: 'confirm_absent',
    })
    expect(confirmed).toMatchObject({
      reconciliation: {
        resolution: 'confirm_absent',
        replayed: false,
      },
      action: {
        status: 'failed',
        effect_state: 'completed',
      },
      created_session: null,
    })
    expect(db.prepare(`SELECT status, resolution
      FROM agent_session_action_reconciliations
      WHERE action_id=? ORDER BY created_at, rowid`).all(action.id)).toEqual([
      { status: 'failed', resolution: 'verify_adopt' },
      { status: 'succeeded', resolution: 'confirm_absent' },
    ])
    expect(lifecycle.capabilities(fixture.sessionId, true).actions.fork.supported)
      .toBe(true)
    expect(JSON.stringify(db.prepare(`SELECT payload FROM os_events`).all()))
      .not.toContain('RAW_VERIFICATION_SECRET')
    expect(JSON.stringify(db.prepare(`SELECT error_message
      FROM agent_session_action_reconciliations`).all()))
      .not.toContain('RAW_VERIFICATION_SECRET')
    expect(runtime.calls).toEqual([fixture.sessionId])
    expect(runtime.verifications).toEqual([fixture.sessionId])
  })

  it('retries the exact verification decision after completion or reconciliation audit storage recovers', async () => {
    for (const rejectedKind of [
      'agent_session.fork',
      'agent_session.fork_reconciled',
    ]) {
      const db = trackedDb()
      const fixture = seedForkHome(db)
      const runtime = new ForkRuntime(
        () => {
          throw new AgentHomeForkOutcomeUnknownError(
            'provider outcome unknown',
            fixture.sourceExternalId,
            fixture.sourceExternalId,
            {
              externalId: fixture.childExternalId,
              providerThreadId: fixture.childExternalId,
              forkedFromId: fixture.sourceExternalId,
              childProviderSessionId: 'provider-child-session',
              subscriptionReleased: true,
            },
          )
        },
        fixture.targetWorkspaceId,
        successfulFork(fixture),
      )
      const lifecycle = new AgentHomeLifecycleService(db, {
        runtime,
        actionLeaseId: `fork-reconciliation-retry-${rejectedKind}`,
      })
      const forkKey = `fork:reconciliation-retry:${rejectedKind}`
      await expect(lifecycle.run(fixture.sessionId, 'fork', {
        actor,
        idempotencyKey: forkKey,
      })).rejects.toThrow(/requires operator reconciliation/)
      const action = db.prepare(`SELECT id FROM agent_session_actions
        WHERE idempotency_key=?`).get(forkKey) as { id: string }
      db.exec(`
        CREATE TRIGGER reject_fork_reconciliation_audit
        BEFORE INSERT ON os_events
        WHEN NEW.kind='${rejectedKind}'
        BEGIN
          SELECT RAISE(ABORT, 'fork reconciliation audit unavailable');
        END;
      `)
      const reconciliationInput = {
        actor,
        idempotencyKey: `fork:reconciliation-retry:verify:${rejectedKind}`,
        resolution: 'verify_adopt' as const,
      }

      await expect(lifecycle.reconcileFork(action.id, reconciliationInput))
        .rejects.toThrow('fork reconciliation did not complete')
      expect(db.prepare(`SELECT status, error_message
        FROM agent_session_action_reconciliations
        WHERE action_id=?`).get(action.id)).toEqual({
        status: 'failed',
        error_message: 'fork reconciliation did not complete',
      })
      const interruptedAction = db.prepare(`SELECT status, effect_state, effect_json
        FROM agent_session_actions WHERE id=?`).get(action.id) as
        { status: string; effect_state: string; effect_json: string }
      expect(interruptedAction.effect_json).toContain('"state":"attached"')
      expect({
        status: interruptedAction.status,
        effect_state: interruptedAction.effect_state,
      }).toEqual(rejectedKind === 'agent_session.fork'
        ? { status: 'pending', effect_state: 'applied' }
        : { status: 'succeeded', effect_state: 'completed' })

      db.exec('DROP TRIGGER reject_fork_reconciliation_audit')
      const recovered = await lifecycle.reconcileFork(
        action.id,
        reconciliationInput,
      )
      expect(recovered).toMatchObject({
        reconciliation: {
          action_id: action.id,
          resolution: 'verify_adopt',
        },
        action: {
          status: 'succeeded',
          effect_state: 'completed',
        },
        created_session: {
          external_id: fixture.childExternalId,
          control_state: 'active',
        },
      })
      expect(runtime.calls).toEqual([fixture.sessionId])
      expect(runtime.verifications).toEqual([fixture.sessionId])
      expect(runtime.adoptions).toHaveLength(1)
      expect((db.prepare(`SELECT COUNT(*) AS count
        FROM agent_session_action_reconciliations WHERE action_id=?`)
        .get(action.id) as { count: number }).count).toBe(1)
      expect((db.prepare(`SELECT COUNT(*) AS count FROM os_events
        WHERE kind='agent_session.fork'`).get() as { count: number }).count)
        .toBe(1)
      expect((db.prepare(`SELECT COUNT(*) AS count FROM os_events
        WHERE kind='agent_session.fork_reconciled'`).get() as
        { count: number }).count).toBe(1)
    }
  })

  it('confirms an unknown child absent, releases the fork fence, and replays concurrently', async () => {
    const db = trackedDb()
    const fixture = seedForkHome(db)
    const runtime = new ForkRuntime(() => {
      throw new AgentHomeForkOutcomeUnknownError(
        'unknown without a child',
        fixture.sourceExternalId,
        fixture.sourceExternalId,
      )
    }, fixture.targetWorkspaceId)
    const lifecycle = new AgentHomeLifecycleService(db, {
      runtime,
      actionLeaseId: 'fork-confirm-absent-daemon',
    })
    await expect(lifecycle.run(fixture.sessionId, 'fork', {
      actor,
      idempotencyKey: 'fork:confirm-absent:unknown',
    })).rejects.toThrow(/requires operator reconciliation/)
    const action = db.prepare(`SELECT id FROM agent_session_actions
      WHERE idempotency_key='fork:confirm-absent:unknown'`).get() as { id: string }

    const input = {
      actor,
      idempotencyKey: 'fork:confirm-absent',
      resolution: 'confirm_absent' as const,
    }
    const [first, replay] = await Promise.all([
      lifecycle.reconcileFork(action.id, input),
      lifecycle.reconcileFork(action.id, input),
    ])
    expect(first.reconciliation.replayed).toBe(false)
    expect(replay.reconciliation.replayed).toBe(true)
    expect(first.action).toEqual({
      id: action.id,
      status: 'failed',
      effect_state: 'completed',
    })
    expect((db.prepare(`SELECT COUNT(*) AS count FROM os_events
      WHERE kind='agent_session.fork_reconciled'`).get() as
      { count: number }).count).toBe(1)
    expect((db.prepare(`SELECT COUNT(*) AS count FROM attention_items
      WHERE kind='agent_session.fork_outcome_unknown' AND status='resolved'`)
      .get() as { count: number }).count).toBe(1)
    expect(new AgentHomeLifecycleService(db, {
      runtime,
      actionLeaseId: 'fork-confirm-absent-retry-daemon',
    }).capabilities(fixture.sessionId, true).actions.fork.supported).toBe(true)

    await expect(lifecycle.run(fixture.sessionId, 'fork', {
      actor,
      idempotencyKey: 'fork:after-confirmed-absent',
    })).rejects.toThrow(/requires operator reconciliation/)
    expect(runtime.calls).toEqual([fixture.sessionId, fixture.sessionId])
    const attention = db.prepare(`SELECT title FROM attention_items
      WHERE kind='agent_session.fork_outcome_unknown' ORDER BY rowid`).all() as
      Array<{ title: string }>
    expect(new Set(attention.map((item) => item.title)).size).toBe(2)
    expect(attention.every((item) => item.title.includes(fixture.sessionId))).toBe(true)
  })

  it('preserves partial and unavailable history and allows cross-provider identities', async () => {
    for (const historyState of ['partial', 'unavailable'] as const) {
      const db = trackedDb()
      const fixture = seedForkHome(db)
      db.prepare('UPDATE agent_sessions SET history_state=? WHERE id=?')
        .run(historyState, fixture.sessionId)
      db.prepare(`INSERT INTO agent_sessions (
        id, workspace_id, provider, external_id, provider_thread_id, status, context_json
      ) VALUES (?, ?, 'claude', ?, ?, 'idle', '{}')`).run(
        `cross-provider-${historyState}`,
        fixture.workspaceId,
        fixture.childExternalId,
        fixture.childExternalId,
      )
      const runtime = new ForkRuntime(
        successfulFork(fixture),
        fixture.targetWorkspaceId,
      )
      const result = await new AgentHomeLifecycleService(db, {
        runtime,
        actionLeaseId: `fork-history-${historyState}`,
      }).run(fixture.sessionId, 'fork', {
        actor,
        idempotencyKey: `fork:history:${historyState}`,
      })
      expect(result.created_session).toMatchObject({
        history_state: historyState,
        provider: 'codex',
        external_id: fixture.childExternalId,
        workspace_id: fixture.targetWorkspaceId,
      })
    }
  })

  it('rejects a runtime target that aliases the parent before invoking the provider', async () => {
    const db = trackedDb()
    const fixture = seedForkHome(db)
    const runtime = new ForkRuntime(successfulFork(fixture), fixture.workspaceId)
    await expect(new AgentHomeLifecycleService(db, {
      runtime,
      actionLeaseId: 'fork-parent-alias-daemon',
    }).run(fixture.sessionId, 'fork', {
      actor,
      idempotencyKey: 'fork:parent-alias',
    })).rejects.toThrow('distinct active managed worktree')
    expect(runtime.calls).toEqual([])
    expect((db.prepare(`SELECT COUNT(*) AS count FROM agent_sessions
      WHERE lineage_type='fork'`).get() as { count: number }).count).toBe(0)
  })
})

function trackedDb(): Database.Database {
  const db = openDb(':memory:')
  databases.push(db)
  return db
}

function seedForkHome(db: Database.Database) {
  const boardId = Number(db.prepare(`INSERT INTO boards (project_path, name)
    VALUES ('/agent-home-fork', 'Agent Home fork')`).run().lastInsertRowid)
  const cardId = Number(db.prepare(`INSERT INTO cards
    (board_id, title, description) VALUES (?, 'Fork session', 'fork lifecycle fixture')`)
    .run(boardId).lastInsertRowid)
  const workspaceId = 'fork-workspace'
  const targetWorkspaceId = 'fork-target-workspace'
  db.prepare(`INSERT INTO workspaces
    (id, board_id, card_id, name, kind, root_path, status)
    VALUES (?, ?, ?, 'Fork workspace', 'shared', '/agent-home-fork', 'active')`)
    .run(workspaceId, boardId, cardId)
  db.prepare(`INSERT INTO workspaces
    (id, board_id, card_id, name, kind, root_path, worktree_path, branch, status)
    VALUES (?, ?, ?, 'Fork target', 'worktree', '/agent-home-fork',
      '/agent-home-fork-worktrees/fork-target', 'orchestra/fork-target', 'active')`)
    .run(targetWorkspaceId, boardId, cardId)
  const jobId = 'fork-job'
  db.prepare(`INSERT INTO jobs
    (id, board_id, card_id, workspace_id, provider, driver_id, access_profile,
      contract_version, priority, status, max_attempts)
    VALUES (?, ?, ?, ?, 'codex', 'codex', 'read_only', 2, 0, 'running', 1)`)
    .run(jobId, boardId, cardId, workspaceId)
  const sourceExternalId = 'thread-fork-source'
  const childExternalId = 'thread-fork-child'
  const sessionId = 'fork-session'
  db.prepare(`INSERT INTO agent_sessions
    (id, workspace_id, provider, external_id, status, context_json)
    VALUES (?, ?, 'codex', ?, 'running', ?)`).run(
    sessionId,
    workspaceId,
    sourceExternalId,
    JSON.stringify({ job_id: jobId }),
  )
  const profile = new AgentProfileService(db).create({
    boardId,
    name: 'Fork agent',
    defaultProvider: 'codex',
    actor,
    idempotencyKey: 'fork:profile',
  })
  const conversations = new ConversationService(db)
  const conversation = conversations.listConversations(profile.id)[0]!
  conversations.linkSession(sessionId, {
    profileId: profile.id,
    conversationId: conversation.id,
    jobId,
    mode: 'managed',
    driverId: 'codex',
    providerThreadId: sourceExternalId,
    recoveryState: 'attachable',
    historyState: 'complete',
    accessProfile: 'read_only',
    actor,
    idempotencyKey: 'fork:link',
  })
  db.prepare('UPDATE agent_conversations SET title=? WHERE id=?')
    .run('Release password=FORK_NAME_SECRET', conversation.id)
  return {
    boardId,
    cardId,
    workspaceId,
    targetWorkspaceId,
    jobId,
    sessionId,
    profileId: profile.id,
    conversationId: conversation.id,
    sourceExternalId,
    childExternalId,
  }
}

function appendUnsafeSourceHistory(
  db: Database.Database,
  fixture: ReturnType<typeof seedForkHome>,
): void {
  const artifact = new ArtifactStore(db).create({
    boardId: fixture.boardId,
    workspaceId: fixture.workspaceId,
    cardId: fixture.cardId,
    kind: 'provider_raw_event',
    name: 'fork-source-raw.json',
    mimeType: 'application/json',
    content: '{"authorization":"Basic RAW_ARTIFACT_SECRET"}',
  })
  const conversations = new ConversationService(db)
  const visible = conversations.appendEvent(fixture.sessionId, {
    idempotencyKey: 'fork:event:visible',
    dedupeKey: 'fork:provider:visible',
    kind: 'assistant',
    providerEventId: 'provider-event-secret',
    providerThreadId: fixture.sourceExternalId,
    providerTurnId: 'provider-turn-secret',
    providerItemId: 'provider-item-secret',
    providerCursor: 'provider-cursor-secret',
    correlationId: 'correlation-secret',
    causationId: 'causation-secret',
    projectedText: 'safe source',
    metadata: { nested: { apiKey: 'RAW_METADATA_SECRET' } },
    rawArtifactId: artifact.id,
    actor: { type: 'agent', id: 'codex-worker' },
  }).event
  // Simulate a pre-redaction legacy row. Fork projection must defend itself
  // instead of trusting historical redaction state.
  db.prepare(`UPDATE conversation_events
    SET projected_text='Authorization: Basic Zm9vOmJhcg==', redaction_state='none',
      metadata_json='{"nested":{"apiKey":"RAW_METADATA_SECRET"}}'
    WHERE id=?`).run(visible.id)
  conversations.appendEvent(fixture.sessionId, {
    idempotencyKey: 'fork:event:reasoning',
    dedupeKey: 'fork:provider:reasoning',
    kind: 'assistant',
    providerEventId: 'provider-event-reasoning',
    providerThreadId: fixture.sourceExternalId,
    projectedText: 'PRIVATE_REASONING_MUST_NOT_COPY',
    metadata: { native_method: 'item/reasoning/textDelta' },
    redactionState: 'withheld',
    retentionClass: 'audit',
    actor: { type: 'agent', id: 'codex-worker' },
  })
}

function successfulFork(
  fixture: ReturnType<typeof seedForkHome>,
): AgentHomeNativeForkResult {
  return {
    sourceExternalId: fixture.sourceExternalId,
    externalId: fixture.childExternalId,
    sourceProviderThreadId: fixture.sourceExternalId,
    providerThreadId: fixture.childExternalId,
    provenance: {
      fork_method: 'thread/fork',
      history_boundary: 'full',
      read_verified: true,
      subscription_released: true,
    },
  }
}
