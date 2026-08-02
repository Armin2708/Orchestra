import type Database from 'better-sqlite3'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AGENT_OS_DELIVERY_AUTOSHIP_INTENT_MIGRATION_ID,
  installDeliveryAutoshipIntentSchema,
} from '../src/agent-os/delivery-autoship-intent-migration.js'
import { installDeliveryShipmentIntegritySchema } from '../src/agent-os/delivery-shipment-integrity-migration.js'
import { installDeliveryTrackbookSchema } from '../src/agent-os/delivery-trackbook-migration.js'
import { DeliveryTrackbookService } from '../src/agent-os/delivery-trackbook.js'
import { DeliveryReportService } from '../src/agent-os/delivery-reports.js'
import { JobScheduler } from '../src/agent-os/scheduler.js'
import { TaskContractService } from '../src/agent-os/task-contracts.js'
import { openDb } from '../src/db.js'

const actor = { type: 'operator' as const, id: 'ship_queue' }
const roots: string[] = []
const databases = new Set<Database.Database>()

afterEach(() => {
  for (const db of databases) db.close()
  databases.clear()
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
})

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()
}

function fixture() {
  const holder = mkdtempSync(path.join(os.tmpdir(), 'orchestra-autoship-intent-'))
  roots.push(holder)
  const repository = path.join(holder, 'repository')
  const dbPath = path.join(holder, 'orchestra.sqlite')
  execFileSync('git', ['init', '-b', 'main', repository], { stdio: 'ignore' })
  git(repository, 'config', 'user.email', 'autoship@example.test')
  git(repository, 'config', 'user.name', 'Autoship Test')
  writeFileSync(path.join(repository, 'base.txt'), 'base\n')
  git(repository, 'add', 'base.txt')
  git(repository, 'commit', '-m', 'base')
  const mainBeforeMerge = git(repository, 'rev-parse', 'HEAD')
  git(repository, 'checkout', '-b', 'card-77')
  writeFileSync(path.join(repository, 'delivery.txt'), 'accepted delivery\n')
  git(repository, 'add', 'delivery.txt')
  git(repository, 'commit', '-m', 'accepted delivery')
  const sourceCommit = git(repository, 'rev-parse', 'HEAD')
  git(repository, 'checkout', 'main')

  const db = openDb(dbPath)
  databases.add(db)
  installDeliveryTrackbookSchema(db)
  installDeliveryShipmentIntegritySchema(db)
  installDeliveryAutoshipIntentSchema(db)
  const boardId = Number(db.prepare("INSERT INTO boards (project_path, name) VALUES (?, 'Autoship')")
    .run(realpathSync(repository)).lastInsertRowid)
  const cardId = Number(db.prepare(`INSERT INTO cards
    (board_id, title, description, branch) VALUES (?, 'Durable autoship', 'Restart safe', 'card-77')`)
    .run(boardId).lastInsertRowid)
  new TaskContractService(db).put(cardId, {
    objective: 'Ship accepted evidence after a restart.',
    deliverables: [{ id: 'autoship', text: 'Durable autoship', required: true }],
    acceptance_criteria: [{
      id: 'restart',
      text: 'A pending shipment survives restart',
      required: true,
      deliverable_ids: ['autoship'],
    }],
    base_ref: 'main',
  })
  const job = new JobScheduler(db).create({ boardId, cardId, provider: 'codex' })
  const reports = new DeliveryReportService(db)
  const draft = reports.prepareForJob(job.id)
  const submitted = reports.submit(draft.id, {
    actor: 'agent:worker',
    summary: 'Durable autoship is ready.',
    deliveredItems: [{ deliverableId: 'autoship', status: 'delivered' }],
    commits: [sourceCommit],
  })
  const verified = reports.verify(submitted.id, {
    actor: 'agent:verifier',
    deliverableResults: [{
      deliverableId: 'autoship',
      outcome: 'met',
      evidenceRefs: [{ kind: 'commit', ref: sourceCommit }],
    }],
    results: [{
      criterionId: 'restart',
      outcome: 'met',
      evidenceRefs: [{ kind: 'commit', ref: sourceCommit }],
    }],
  })
  const accepted = reports.accept(verified.id, { actor: 'operator:reviewer' })
  return {
    holder,
    repository: realpathSync(repository),
    dbPath,
    db,
    boardId,
    cardId,
    accepted,
    sourceCommit,
    mainBeforeMerge,
    trackbook: new DeliveryTrackbookService(db),
  }
}

describe('delivery autoship intent migration 037', () => {
  it('is replay-safe and keeps prepared/completed records append-only', () => {
    const setup = fixture()
    expect(AGENT_OS_DELIVERY_AUTOSHIP_INTENT_MIGRATION_ID).toBe('037-delivery-autoship-intents')
    expect(() => installDeliveryAutoshipIntentSchema(setup.db)).not.toThrow()
    const intent = setup.trackbook.prepareAutoshipIntent(setup.accepted.id, {
      actor,
      branch: 'card-77',
      idempotencyKey: 'prepare:card-77',
    })
    expect(setup.trackbook.prepareAutoshipIntent(setup.accepted.id, {
      actor,
      branch: 'card-77',
      idempotencyKey: 'prepare:card-77',
    })).toEqual(intent)
    expect(intent).toMatchObject({
      report_id: setup.accepted.id,
      board_id: setup.boardId,
      card_id: setup.cardId,
      source_repository: setup.repository,
      source_branch: 'card-77',
      source_commit: setup.sourceCommit,
      destination: 'main',
    })
    expect(setup.trackbook.pendingAutoshipIntents()).toEqual([intent])
    expect(setup.trackbook.pendingAutoshipIntentForCard(setup.boardId, setup.cardId))
      .toEqual(intent)
    expect(() => setup.db.prepare('UPDATE delivery_autoship_intents SET source_branch=? WHERE id=?')
      .run('tampered', intent.id)).toThrow(/immutable/)
    expect(() => setup.db.prepare('DELETE FROM delivery_autoship_intents WHERE id=?')
      .run(intent.id)).toThrow(/immutable/)
  })

  it('rejects a branch tip that is not cited by the current accepted report', () => {
    const setup = fixture()
    git(setup.repository, 'branch', '-f', 'card-77', 'main')
    expect(() => setup.trackbook.prepareAutoshipIntent(setup.accepted.id, {
      actor,
      branch: 'card-77',
      idempotencyKey: 'prepare:uncited',
    })).toThrow(/must be cited/)
    expect(setup.trackbook.pendingAutoshipIntents()).toEqual([])
  })
})

describe('durable autoship recovery', () => {
  it('uses exact live lookup and rotates bounded recovery past 200 older attempts', () => {
    const setup = fixture()
    const at = '2026-08-02T00:00:00.000Z'
    const insertCard = setup.db.prepare(`INSERT INTO cards
      (board_id, title, description, branch) VALUES (?, ?, 'Older pending', 'card-77')`)
    const insertReport = setup.db.prepare(`INSERT INTO delivery_reports
      (id, lineage_id, sequence, board_id, card_id, status, asked_snapshot, commits,
       created_by, created_at, updated_at)
      VALUES (?, ?, 1, ?, ?, 'accepted', '{}', ?, 'test', ?, ?)`)
    const insertIntent = setup.db.prepare(`INSERT INTO delivery_autoship_intents
      (id, report_id, board_id, card_id, source_repository, source_branch,
       source_commit, destination, prepared_by, prepared_at, idempotency_key,
       request_sha256, created_at)
      VALUES (?, ?, ?, ?, ?, 'card-77', ?, 'main', 'operator:test', ?, ?, ?, ?)`)
    const insertAttempt = setup.db.prepare(`INSERT INTO os_events
      (id, board_id, card_id, actor_type, actor_id, correlation_id, causation_id,
       idempotency_key, kind, source, payload, created_at)
      VALUES (?, ?, ?, 'operator', 'test', ?, ?, ?,
        'delivery.autoship_reconciliation_pending', 'delivery-trackbook', ?, ?)`)
    for (let index = 0; index < 200; index += 1) {
      const cardId = Number(insertCard.run(setup.boardId, `Older pending ${index}`).lastInsertRowid)
      const reportId = `older-report-${index}`
      const intentId = `older-intent-${index}`
      insertReport.run(
        reportId,
        reportId,
        setup.boardId,
        cardId,
        JSON.stringify([setup.sourceCommit]),
        at,
        at,
      )
      insertIntent.run(
        intentId,
        reportId,
        setup.boardId,
        cardId,
        setup.repository,
        setup.sourceCommit,
        at,
        `older-intent:${index}`,
        '0'.repeat(64),
        at,
      )
      insertAttempt.run(
        `older-attempt-${index}`,
        setup.boardId,
        cardId,
        `older-attempt-${index}`,
        reportId,
        `older-attempt:${index}`,
        JSON.stringify({ delivery_report_id: reportId, autoship_intent_id: intentId }),
        at,
      )
    }
    const current = setup.trackbook.prepareAutoshipIntent(setup.accepted.id, {
      actor,
      branch: 'card-77',
      idempotencyKey: 'prepare:after-200',
    })
    expect(setup.trackbook.pendingAutoshipIntents(setup.boardId, 200)).toHaveLength(200)
    expect(setup.trackbook.pendingAutoshipIntents(setup.boardId, 1)).toEqual([current])
    expect(setup.trackbook.pendingAutoshipIntentForCard(setup.boardId, setup.cardId))
      .toEqual(current)
  })

  it('survives restart after merge and reconciles receipt, shipment and completion exactly once', () => {
    const setup = fixture()
    const intent = setup.trackbook.prepareAutoshipIntent(setup.accepted.id, {
      actor,
      branch: 'card-77',
      idempotencyKey: 'prepare:restart',
    })
    expect(setup.trackbook.reconcilePendingAutoshipIntents({ actor })).toEqual([
      expect.objectContaining({ status: 'pending', intent }),
    ])

    git(setup.repository, 'merge', '--no-ff', setup.sourceCommit, '-m', 'merge accepted delivery')
    const observedHead = git(setup.repository, 'rev-parse', 'HEAD')
    expect(() => setup.trackbook.completeAutoshipIntent(intent.id, {
      actor,
      observedHeadCommit: setup.mainBeforeMerge,
      idempotencyKey: 'complete:wrong-head',
    })).toThrow(/exact current board repository HEAD/)
    expect(setup.trackbook.pendingAutoshipIntents()).toEqual([intent])

    setup.db.close()
    databases.delete(setup.db)
    const restartedDb = openDb(setup.dbPath)
    databases.add(restartedDb)
    installDeliveryAutoshipIntentSchema(restartedDb)
    const restarted = new DeliveryTrackbookService(restartedDb)
    expect(restarted.pendingAutoshipIntents()).toEqual([intent])
    restartedDb.prepare("UPDATE cards SET column_name='blocked' WHERE id=?").run(setup.cardId)
    restartedDb.prepare(`INSERT INTO card_events (card_id, type, payload)
      VALUES (?, 'autoship_failed', '{}')`).run(setup.cardId)
    restartedDb.exec(`CREATE TRIGGER fail_autoship_card_restore
      BEFORE UPDATE OF column_name ON cards
      WHEN OLD.column_name='blocked' AND NEW.column_name='done'
      BEGIN SELECT RAISE(ABORT, 'forced autoship card repair failure'); END;`)
    expect(restarted.reconcilePendingAutoshipIntents({ actor })).toEqual([
      expect.objectContaining({
        status: 'pending',
        reason: expect.stringMatching(/forced autoship card repair failure/),
      }),
    ])
    expect(restartedDb.prepare('SELECT COUNT(*) AS count FROM delivery_shipment_receipts').get())
      .toEqual({ count: 0 })
    expect(restartedDb.prepare('SELECT COUNT(*) AS count FROM delivery_shipments').get())
      .toEqual({ count: 0 })
    expect(restartedDb.prepare('SELECT COUNT(*) AS count FROM delivery_autoship_completions').get())
      .toEqual({ count: 0 })
    expect(restartedDb.prepare('SELECT column_name FROM cards WHERE id=?').get(setup.cardId))
      .toEqual({ column_name: 'blocked' })
    restartedDb.exec('DROP TRIGGER fail_autoship_card_restore')
    const [reconciled] = restarted.reconcilePendingAutoshipIntents({ actor })
    expect(reconciled?.status).toBe('completed')
    if (!reconciled || reconciled.status !== 'completed') throw new Error('intent did not reconcile')
    expect(reconciled.result).toMatchObject({
      intent,
      receipt: {
        source_repository: setup.repository,
        source_commit: setup.sourceCommit,
        observed_head_commit: observedHead,
      },
      shipment: {
        report_id: setup.accepted.id,
        source_repository: setup.repository,
        source_commit: setup.sourceCommit,
        observed_head_commit: observedHead,
      },
      completion: {
        intent_id: intent.id,
        observed_head_commit: observedHead,
      },
    })

    const duplicate = restarted.completeAutoshipIntent(intent.id, {
      actor,
      observedHeadCommit: observedHead,
      idempotencyKey: 'complete:duplicate-recovery',
    })
    expect(duplicate).toEqual(reconciled.result)
    expect(restarted.reconcilePendingAutoshipIntents({ actor })).toEqual([])
    expect(restartedDb.prepare('SELECT COUNT(*) AS count FROM delivery_shipment_receipts').get())
      .toEqual({ count: 1 })
    expect(restartedDb.prepare('SELECT COUNT(*) AS count FROM delivery_shipments').get())
      .toEqual({ count: 1 })
    expect(restartedDb.prepare('SELECT COUNT(*) AS count FROM delivery_autoship_completions').get())
      .toEqual({ count: 1 })
    expect(restartedDb.prepare('SELECT column_name FROM cards WHERE id=?').get(setup.cardId))
      .toEqual({ column_name: 'done' })
    expect(() => restartedDb.prepare('DELETE FROM delivery_autoship_completions WHERE intent_id=?')
      .run(intent.id)).toThrow(/immutable/)
  })
})
