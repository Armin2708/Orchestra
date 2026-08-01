import { afterEach, describe, expect, it } from 'vitest'
import { openDb } from '../src/db.js'
import { applyAgentOsMigrations } from '../src/agent-os/migrations.js'
import { CheckpointService } from '../src/agent-os/checkpoints.js'
import {
  CommandIdempotencyStore,
  commandRequestIdentity,
} from '../src/agent-os/command-idempotency.js'
import { DeliveryReportService } from '../src/agent-os/delivery-reports.js'
import { PolicyEngine } from '../src/agent-os/policy-engine.js'
import { JobScheduler } from '../src/agent-os/scheduler.js'
import { WorkspaceStore } from '../src/agent-os/workspace-store.js'

const databases: Array<ReturnType<typeof openDb>> = []

afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})

function fixture() {
  const db = openDb(':memory:')
  databases.push(db)
  const boardId = Number(db.prepare(`
    INSERT INTO boards (project_path, name)
    VALUES ('/command-idempotency', 'command idempotency')
  `).run().lastInsertRowid)
  const otherBoardId = Number(db.prepare(`
    INSERT INTO boards (project_path, name)
    VALUES ('/command-idempotency-other', 'command idempotency other')
  `).run().lastInsertRowid)
  const cardId = Number(db.prepare(`
    INSERT INTO cards (board_id, title, description)
    VALUES (?, 'Idempotent commands', 'Replay every mutation safely')
  `).run(boardId).lastInsertRowid)
  return { db, boardId, otherBoardId, cardId }
}

describe('DOM-013 command idempotency coverage', () => {
  it('installs the forward-only command receipt schema and safely replays its marker', () => {
    const { db, boardId } = fixture()

    expect(db.prepare(`
      SELECT id FROM os_schema_migrations ORDER BY rowid DESC LIMIT 1
    `).get()).toEqual({ id: '029-agent-organization-assurance' })
    expect(db.prepare(`
      SELECT type FROM sqlite_master
      WHERE name='os_command_receipts'
    `).get()).toEqual({ type: 'table' })

    expect(() => db.prepare(`
      INSERT INTO os_command_receipts (
        board_id, idempotency_key, command, scope_id, request_fingerprint,
        status, result_id, created_at, completed_at
      ) VALUES (?, 'bad-key', 'workspace.create', 'board', 'not-a-hash',
        'succeeded', 'workspace', datetime('now'), datetime('now'))
    `).run(boardId)).toThrow()

    expect(() => db.prepare(`
      INSERT INTO os_command_receipts (
        board_id, idempotency_key, command, scope_id, request_fingerprint,
        status, result_id, created_at
      ) VALUES (?, ?, 'workspace.create', ?, ?, 'pending', 'premature-result',
        datetime('now'))
    `).run(boardId, 'premature-result', String(boardId), 'a'.repeat(64))).toThrow()

    expect(() => db.prepare(`
      INSERT INTO os_command_receipts (
        board_id, idempotency_key, command, scope_id, request_fingerprint,
        status, created_at
      ) VALUES (?, ?, 'workspace.create', ?, ?, 'pending', datetime('now'))
    `).run(boardId, 'bad\nkey', String(boardId), 'a'.repeat(64))).toThrow()

    db.prepare(`
      DELETE FROM os_schema_migrations
      WHERE id='021-command-idempotency-coverage'
    `).run()
    applyAgentOsMigrations(db)
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM os_schema_migrations
      WHERE id='021-command-idempotency-coverage'
    `).get()).toEqual({ count: 1 })
  })

  it('replays create commands and rejects changed requests for the same key', () => {
    const { db, boardId, cardId } = fixture()
    const workspaces = new WorkspaceStore(db)
    const workspaceRequest = {
      boardId,
      cardId,
      name: 'DOM-013',
      rootPath: '/command-idempotency',
      idempotencyKey: 'workspace-create-1',
    }
    const workspace = workspaces.create(workspaceRequest)
    expect(workspaces.create(workspaceRequest).id).toBe(workspace.id)
    expect(() => workspaces.create({
      ...workspaceRequest,
      name: 'changed workspace',
    })).toThrow(/idempotency key.*different command request/i)

    const checkpoints = new CheckpointService(db)
    const checkpointRequest = {
      workspaceId: workspace.id,
      name: 'before change',
      gitHead: '0123456789abcdef',
      idempotencyKey: 'checkpoint-create-1',
    }
    const checkpoint = checkpoints.create(checkpointRequest)
    expect(checkpoints.create(checkpointRequest).id).toBe(checkpoint.id)
    expect(() => checkpoints.create({
      ...checkpointRequest,
      gitHead: 'fedcba9876543210',
    })).toThrow(/idempotency key.*different command request/i)

    const policies = new PolicyEngine(db)
    const policyRequest = {
      boardId,
      name: 'DOM-013 policy',
      fileGlobs: ['src/**'],
      approvalScope: 'ask',
      idempotencyKey: 'policy-create-1',
    }
    const policy = policies.create(policyRequest)
    expect(policies.create(policyRequest).id).toBe(policy.id)
    expect(() => policies.create({
      ...policyRequest,
      fileGlobs: ['test/**'],
    })).toThrow(/idempotency key.*different command request/i)

    expect(db.prepare(`
      SELECT command, status, result_id
      FROM os_command_receipts
      ORDER BY command
    `).all()).toEqual([
      {
        command: 'checkpoint.create',
        status: 'succeeded',
        result_id: checkpoint.id,
      },
      {
        command: 'policy.create',
        status: 'succeeded',
        result_id: policy.id,
      },
      {
        command: 'workspace.create',
        status: 'succeeded',
        result_id: workspace.id,
      },
    ])
  })

  it('replays cardless launch, submit, accept, and cancel without repeating effects', async () => {
    const { db, boardId, cardId } = fixture()
    const scheduler = new JobScheduler(db)

    const cardlessRequest = {
      boardId,
      provider: 'future-provider',
      priority: 7,
      idempotencyKey: 'cardless-launch-1',
    }
    const cardless = scheduler.create(cardlessRequest)
    expect(scheduler.create(cardlessRequest).id).toBe(cardless.id)
    expect(() => scheduler.create({
      ...cardlessRequest,
      provider: 'changed-provider',
    })).toThrow(/idempotency key.*different launch request/i)

    const job = scheduler.create({
      boardId,
      cardId,
      provider: 'future-provider',
    })
    const reports = new DeliveryReportService(db)
    const report = reports.prepareForJob(job.id)
    const submission = {
      actor: 'agent',
      summary: 'DOM-013 is complete.',
      deliveredItems: [{
        deliverableId: report.asked.deliverables[0]!.id,
        status: 'delivered' as const,
      }],
      idempotencyKey: 'delivery-submit-1',
    }
    const submitted = reports.submit(report.id, submission)
    expect(reports.submit(report.id, submission).id).toBe(submitted.id)
    expect(() => reports.submit(report.id, {
      ...submission,
      summary: 'A changed claim.',
    })).toThrow(/idempotency key.*different command request/i)

    db.prepare(`
      UPDATE delivery_reports
      SET status='verified', verified_by='verifier',
        verified_at=datetime('now'), updated_at=datetime('now')
      WHERE id=?
    `).run(report.id)
    const evidence = JSON.stringify([{
      kind: 'other',
      ref: 'dom-013-contract-test',
      label: 'DOM-013 contract evidence',
    }])
    db.prepare(`
      UPDATE delivery_deliverable_results
      SET outcome='met', evidence_refs=?
      WHERE report_id=?
    `).run(evidence, report.id)
    db.prepare(`
      UPDATE delivery_criterion_results
      SET outcome='met', evidence_refs=?
      WHERE report_id=?
    `).run(evidence, report.id)
    const acceptance = {
      actor: 'human',
      note: 'Evidence checked.',
      idempotencyKey: 'delivery-accept-1',
    }
    const accepted = reports.accept(report.id, acceptance)
    expect(reports.accept(report.id, acceptance)).toEqual(accepted)
    expect(() => reports.accept(report.id, {
      ...acceptance,
      note: 'Changed approval note.',
    })).toThrow(/idempotency key.*different command request/i)

    const cancelled = await scheduler.cancel(cardless.id, {
      idempotencyKey: 'job-cancel-1',
    })
    expect((await scheduler.cancel(cardless.id, {
      idempotencyKey: 'job-cancel-1',
    })).id).toBe(cancelled.id)

    const second = scheduler.create({
      boardId,
      provider: 'future-provider',
    })
    await expect(scheduler.cancel(second.id, {
      idempotencyKey: 'job-cancel-1',
    })).rejects.toThrow(/idempotency key.*different command request/i)

    expect(db.prepare(`
      SELECT command, COUNT(*) AS count
      FROM os_command_receipts
      GROUP BY command
      ORDER BY command
    `).all()).toEqual([
      { command: 'delivery.accept', count: 1 },
      { command: 'delivery.submit', count: 1 },
      { command: 'job.cancel', count: 1 },
    ])
  })

  it('does not mutate a pending receipt through a mismatched completion identity', () => {
    const { db, boardId } = fixture()
    const commands = new CommandIdempotencyStore(db)
    const original = commandRequestIdentity({
      boardId,
      idempotencyKey: 'completion-identity-1',
      command: 'workspace.create',
      scopeId: String(boardId),
      request: { name: 'original' },
    })!
    const changed = commandRequestIdentity({
      boardId,
      idempotencyKey: 'completion-identity-1',
      command: 'workspace.create',
      scopeId: String(boardId),
      request: { name: 'changed' },
    })!

    commands.claim(original)
    expect(() => commands.succeed(changed, 'workspace-1'))
      .toThrow(/different command request/i)
    expect(db.prepare(`
      SELECT status, result_id FROM os_command_receipts
      WHERE board_id=? AND idempotency_key=?
    `).get(boardId, original.idempotencyKey)).toEqual({
      status: 'pending',
      result_id: null,
    })

    commands.succeed(original, 'workspace-1')
    expect(() => commands.recordSucceeded(original, 'workspace-2'))
      .toThrow(/different result/i)
  })
})
