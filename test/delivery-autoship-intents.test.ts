import type Database from 'better-sqlite3'
import SqliteDatabase from 'better-sqlite3'
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AGENT_OS_DELIVERY_AUTOSHIP_INTENT_MIGRATION_ID,
  installDeliveryAutoshipIntentSchema,
} from '../src/agent-os/delivery-autoship-intent-migration.js'
import {
  AGENT_OS_DELIVERY_AUTOSHIP_WORKTREE_IDENTITY_MIGRATION_ID,
  installDeliveryAutoshipWorktreeIdentitySchema,
} from '../src/agent-os/delivery-autoship-worktree-identity-migration.js'
import { installDeliveryShipmentIntegritySchema } from '../src/agent-os/delivery-shipment-integrity-migration.js'
import { installDeliveryTrackbookSchema } from '../src/agent-os/delivery-trackbook-migration.js'
import { DeliveryTrackbookService } from '../src/agent-os/delivery-trackbook.js'
import { DeliveryReportService } from '../src/agent-os/delivery-reports.js'
import { JobScheduler } from '../src/agent-os/scheduler.js'
import { TaskContractService } from '../src/agent-os/task-contracts.js'
import { openDb } from '../src/db.js'
import { buildServer } from '../src/server.js'
import { cardWorktree } from '../src/shipqueue.js'

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
  installDeliveryAutoshipWorktreeIdentitySchema(db)
  const boardId = Number(db.prepare("INSERT INTO boards (project_path, name) VALUES (?, 'Autoship')")
    .run(realpathSync(repository)).lastInsertRowid)
  const cardId = Number(db.prepare(`INSERT INTO cards
    (board_id, title, description, branch) VALUES (?, 'Durable autoship', 'Restart safe', 'card-77')`)
    .run(boardId).lastInsertRowid)
  const candidateWorktree = cardWorktree(realpathSync(repository), cardId)
  git(repository, 'worktree', 'add', candidateWorktree, 'card-77')
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
    candidateWorktree,
    accepted,
    sourceCommit,
    mainBeforeMerge,
    trackbook: new DeliveryTrackbookService(db),
  }
}

describe('delivery autoship intent migration 037', () => {
  it('upgrades a genuine populated 037 table and enforces identity on later inserts', () => {
    const legacy = new SqliteDatabase(':memory:')
    try {
      legacy.exec(`CREATE TABLE delivery_autoship_intents (
        id TEXT PRIMARY KEY,
        report_id TEXT NOT NULL,
        board_id INTEGER NOT NULL,
        card_id INTEGER NOT NULL,
        job_id TEXT,
        source_repository TEXT NOT NULL,
        source_branch TEXT NOT NULL,
        source_commit TEXT NOT NULL,
        destination TEXT NOT NULL,
        prepared_by TEXT NOT NULL,
        prepared_at TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_sha256 TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`)
      legacy.prepare(`INSERT INTO delivery_autoship_intents VALUES
        ('legacy', 'report', 1, 1, NULL, '/repository', 'card-1', ?, 'main',
         'operator:legacy', '2026-08-02T00:00:00.000Z', 'legacy', ?,
         '2026-08-02T00:00:00.000Z')`).run('a'.repeat(40), '0'.repeat(64))
      const before = new Set((legacy.prepare(`PRAGMA table_info('delivery_autoship_intents')`)
        .all() as Array<{ name: string }>).map((column) => column.name))
      expect(before.has('worktree_path')).toBe(false)

      installDeliveryAutoshipWorktreeIdentitySchema(legacy)
      installDeliveryAutoshipWorktreeIdentitySchema(legacy)
      expect(legacy.prepare(`SELECT worktree_path, worktree_git_dir, worktree_common_dir,
        worktree_git_dir_device, worktree_git_dir_inode
        FROM delivery_autoship_intents WHERE id='legacy'`).get()).toEqual({
        worktree_path: null,
        worktree_git_dir: null,
        worktree_common_dir: null,
        worktree_git_dir_device: null,
        worktree_git_dir_inode: null,
      })
      expect(() => legacy.prepare(`INSERT INTO delivery_autoship_intents
        (id, report_id, board_id, card_id, source_repository, source_branch,
         source_commit, destination, prepared_by, prepared_at, idempotency_key,
         request_sha256, created_at)
        VALUES ('new-without-identity', 'report-2', 1, 2, '/repository', 'card-2', ?,
          'main', 'operator:test', '2026-08-02T00:00:00.000Z', 'new', ?,
          '2026-08-02T00:00:00.000Z')`).run('b'.repeat(40), '1'.repeat(64)))
        .toThrow(/worktree identity is required/)
    } finally {
      legacy.close()
    }
  })

  it('is replay-safe and keeps prepared/completed records append-only', () => {
    const setup = fixture()
    expect(AGENT_OS_DELIVERY_AUTOSHIP_INTENT_MIGRATION_ID).toBe('037-delivery-autoship-intents')
    expect(AGENT_OS_DELIVERY_AUTOSHIP_WORKTREE_IDENTITY_MIGRATION_ID)
      .toBe('038-delivery-autoship-worktree-identity')
    expect(() => installDeliveryAutoshipIntentSchema(setup.db)).not.toThrow()
    expect(() => installDeliveryAutoshipWorktreeIdentitySchema(setup.db)).not.toThrow()
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
      worktree_path: realpathSync(setup.candidateWorktree),
      worktree_git_dir: expect.stringContaining(`${path.sep}worktrees${path.sep}`),
      worktree_common_dir: realpathSync(path.join(setup.repository, '.git')),
      worktree_git_dir_device: expect.stringMatching(/^\d+$/),
      worktree_git_dir_inode: expect.stringMatching(/^\d+$/),
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
    git(setup.repository, 'worktree', 'remove', setup.candidateWorktree)
    git(setup.repository, 'branch', '-f', 'card-77', 'main')
    expect(() => setup.trackbook.prepareAutoshipIntent(setup.accepted.id, {
      actor,
      branch: 'card-77',
      idempotencyKey: 'prepare:uncited',
    })).toThrow(/must be cited/)
    expect(setup.trackbook.pendingAutoshipIntents()).toEqual([])
  })

  it('keeps a populated legacy null identity pending without fabricating completion', () => {
    const setup = fixture()
    setup.db.exec('DROP TRIGGER delivery_autoship_intents_worktree_identity')
    const at = '2026-08-02T00:00:00.000Z'
    setup.db.prepare(`INSERT INTO delivery_autoship_intents
      (id, report_id, board_id, card_id, job_id, source_repository, source_branch,
       source_commit, destination, prepared_by, prepared_at, idempotency_key,
       request_sha256, created_at)
      VALUES ('legacy-037-intent', ?, ?, ?, ?, ?, 'card-77', ?, 'main',
        'operator:legacy', ?, 'legacy-037-intent', ?, ?)`).run(
      setup.accepted.id,
      setup.boardId,
      setup.cardId,
      setup.accepted.job_id,
      setup.repository,
      setup.sourceCommit,
      at,
      '0'.repeat(64),
      at,
    )
    installDeliveryAutoshipWorktreeIdentitySchema(setup.db)
    const [legacy] = setup.trackbook.pendingAutoshipIntents()
    expect(legacy).toMatchObject({
      id: 'legacy-037-intent',
      worktree_path: null,
      worktree_git_dir: null,
      worktree_common_dir: null,
      worktree_git_dir_device: null,
      worktree_git_dir_inode: null,
    })

    git(setup.repository, 'merge', '--no-ff', setup.sourceCommit, '-m', 'merge legacy accepted source')
    git(setup.repository, 'worktree', 'remove', setup.candidateWorktree)
    git(setup.repository, 'branch', '-d', 'card-77')
    expect(setup.trackbook.reconcilePendingAutoshipIntents({ actor })).toEqual([
      expect.objectContaining({
        status: 'pending',
        reason: expect.stringMatching(/lacks durable candidate worktree identity/),
      }),
    ])
    expect(setup.db.prepare('SELECT COUNT(*) AS count FROM delivery_shipment_receipts').get())
      .toEqual({ count: 0 })
    expect(setup.db.prepare('SELECT COUNT(*) AS count FROM delivery_shipments').get())
      .toEqual({ count: 0 })
    expect(setup.db.prepare('SELECT COUNT(*) AS count FROM delivery_autoship_completions').get())
      .toEqual({ count: 0 })
  })
})

describe('durable autoship recovery', () => {
  it('uses one bounded startup snapshot without rotating the current candidate out of recovery', async () => {
    const setup = fixture()
    const at = '2026-08-02T00:00:00.000Z'
    const current = setup.trackbook.prepareAutoshipIntent(setup.accepted.id, {
      actor,
      branch: 'card-77',
      idempotencyKey: 'prepare:after-200',
    })
    const insertCard = setup.db.prepare(`INSERT INTO cards
      (board_id, title, description, branch) VALUES (?, ?, 'Older pending', 'card-77')`)
    const insertReport = setup.db.prepare(`INSERT INTO delivery_reports
      (id, lineage_id, sequence, board_id, card_id, status, asked_snapshot, commits,
       created_by, created_at, updated_at)
      VALUES (?, ?, 1, ?, ?, 'accepted', ?, ?, 'test', ?, ?)`)
    const insertIntent = setup.db.prepare(`INSERT INTO delivery_autoship_intents
      (id, report_id, board_id, card_id, source_repository, source_branch,
       source_commit, worktree_path, worktree_git_dir, worktree_common_dir,
       worktree_git_dir_device, worktree_git_dir_inode, destination, prepared_by,
       prepared_at, idempotency_key, request_sha256, created_at)
      VALUES (?, ?, ?, ?, ?, 'card-77', ?, ?, ?, ?, ?, ?, 'main', 'operator:test', ?, ?, ?, ?)`)
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
        JSON.stringify(setup.accepted.asked),
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
        current.worktree_path,
        current.worktree_git_dir,
        current.worktree_common_dir,
        current.worktree_git_dir_device,
        current.worktree_git_dir_inode,
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
    expect(setup.trackbook.pendingAutoshipIntents(setup.boardId, 200)).toHaveLength(200)
    expect(setup.trackbook.pendingAutoshipIntents(setup.boardId, 1)).toEqual([current])
    expect(setup.trackbook.pendingAutoshipIntentForCard(setup.boardId, setup.cardId))
      .toEqual(current)

    git(setup.repository, 'merge', '--no-ff', setup.sourceCommit, '-m', 'merge current bounded candidate')
    setup.db.prepare("UPDATE cards SET column_name='done' WHERE id=?").run(setup.cardId)
    const enqueued: any[] = []
    const server = buildServer(setup.db, undefined, {
      makeShipQueue: () => ({
        enqueue: (candidate) => { enqueued.push(candidate); return { queued: true } },
        status: () => null,
      }),
    })
    expect(enqueued).toEqual([expect.objectContaining({
      cardId: setup.cardId,
      branch: current.source_branch,
      sourceCommit: current.source_commit,
      worktree: cardWorktree(setup.repository, setup.cardId),
    })])
    expect(setup.trackbook.pendingAutoshipIntents()).toContainEqual(current)
    expect(setup.db.prepare('SELECT COUNT(*) AS count FROM delivery_autoship_completions').get())
      .toEqual({ count: 0 })
    await server.close()
  }, 60_000)

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
    expect(setup.trackbook.reconcilePendingAutoshipIntents({ actor })).toEqual([
      expect.objectContaining({
        status: 'pending',
        reason: expect.stringMatching(/candidate branch cleanup is incomplete/),
      }),
    ])
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
    expect(restarted.reconcilePendingAutoshipIntents({ actor })).toEqual([
      expect.objectContaining({
        status: 'pending',
        reason: expect.stringMatching(/candidate branch cleanup is incomplete/),
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
    git(setup.repository, 'worktree', 'remove', setup.candidateWorktree)
    git(setup.repository, 'branch', '-d', 'card-77')
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

  it('preserves ignored candidate content and all canonical state during restart cleanup', async () => {
    const setup = fixture()
    const intent = setup.trackbook.prepareAutoshipIntent(setup.accepted.id, {
      actor,
      branch: 'card-77',
      idempotencyKey: 'prepare:ignored-content',
    })
    git(setup.repository, 'merge', '--no-ff', setup.sourceCommit, '-m', 'merge before ignored-content recovery')
    const worktree = setup.candidateWorktree
    writeFileSync(path.join(setup.repository, '.git', 'info', 'exclude'), '.env\nnode_modules/\nartifacts/\n')
    mkdirSync(path.join(worktree, 'node_modules'), { recursive: true })
    mkdirSync(path.join(worktree, 'artifacts'), { recursive: true })
    const ignoredPaths = [
      path.join(worktree, '.env'),
      path.join(worktree, 'node_modules', 'local-cache.bin'),
      path.join(worktree, 'artifacts', 'accepted-output.log'),
    ]
    for (const ignoredPath of ignoredPaths) writeFileSync(ignoredPath, 'preserve me\n')
    expect(git(worktree, 'check-ignore', ...ignoredPaths)).not.toBe('')
    setup.db.prepare("UPDATE cards SET column_name='done' WHERE id=?").run(setup.cardId)

    const server = buildServer(setup.db)
    await expect.poll(
      () => setup.db.prepare('SELECT column_name FROM cards WHERE id=?').get(setup.cardId),
      { timeout: 30_000 },
    ).toEqual({ column_name: 'blocked' })

    expect(ignoredPaths.every((ignoredPath) => existsSync(ignoredPath))).toBe(true)
    expect(git(setup.repository, 'worktree', 'list', '--porcelain')).toContain(realpathSync(worktree))
    expect(git(setup.repository, 'rev-parse', 'card-77')).toBe(setup.sourceCommit)
    expect(setup.trackbook.pendingAutoshipIntents()).toEqual([intent])
    expect(setup.db.prepare('SELECT COUNT(*) AS count FROM delivery_shipment_receipts').get())
      .toEqual({ count: 0 })
    expect(setup.db.prepare('SELECT COUNT(*) AS count FROM delivery_shipments').get())
      .toEqual({ count: 0 })
    expect(setup.db.prepare('SELECT COUNT(*) AS count FROM delivery_autoship_completions').get())
      .toEqual({ count: 0 })
    await server.close()
  }, 60_000)

  it('requires the exact card worktree path to be absent and preserves unrelated worktrees', () => {
    const setup = fixture()
    const intent = setup.trackbook.prepareAutoshipIntent(setup.accepted.id, {
      actor,
      branch: 'card-77',
      idempotencyKey: 'prepare:worktree-proof',
    })
    git(setup.repository, 'merge', '--no-ff', setup.sourceCommit, '-m', 'merge accepted delivery')
    const candidateWorktree = setup.candidateWorktree
    git(candidateWorktree, 'checkout', '--detach', setup.sourceCommit)
    git(setup.repository, 'branch', '-d', 'card-77')
    git(setup.repository, 'branch', 'unrelated-recovery-work')
    const unrelatedWorktree = path.join(setup.holder, 'unrelated-worktree')
    git(setup.repository, 'worktree', 'add', unrelatedWorktree, 'unrelated-recovery-work')

    expect(setup.trackbook.reconcilePendingAutoshipIntents({ actor })).toEqual([
      expect.objectContaining({
        status: 'pending',
        reason: expect.stringMatching(/durable candidate worktree remains registered/),
      }),
    ])
    expect(setup.db.prepare('SELECT COUNT(*) AS count FROM delivery_shipment_receipts').get())
      .toEqual({ count: 0 })
    expect(setup.db.prepare('SELECT COUNT(*) AS count FROM delivery_shipments').get())
      .toEqual({ count: 0 })
    expect(setup.db.prepare('SELECT COUNT(*) AS count FROM delivery_autoship_completions').get())
      .toEqual({ count: 0 })

    git(setup.repository, 'worktree', 'remove', candidateWorktree)
    mkdirSync(candidateWorktree)
    expect(setup.trackbook.reconcilePendingAutoshipIntents({ actor })).toEqual([
      expect.objectContaining({
        status: 'pending',
        reason: expect.stringMatching(/path remains unregistered/),
      }),
    ])
    rmSync(candidateWorktree, { recursive: true })

    const [completed] = setup.trackbook.reconcilePendingAutoshipIntents({ actor })
    expect(completed?.status).toBe('completed')
    expect(setup.trackbook.pendingAutoshipIntents()).toEqual([])
    const registrations = git(setup.repository, 'worktree', 'list', '--porcelain')
    expect(registrations).toContain(realpathSync(unrelatedWorktree))
    expect(git(setup.repository, 'rev-parse', 'unrelated-recovery-work')).toBe(
      git(setup.repository, 'rev-parse', 'main'),
    )
    expect(intent.source_commit).toBe(setup.sourceCommit)
  })

  it('blocks canonical-path reuse but permits unrelated reuse of a released admin path', () => {
    const setup = fixture()
    const intent = setup.trackbook.prepareAutoshipIntent(setup.accepted.id, {
      actor,
      branch: 'card-77',
      idempotencyKey: 'prepare:admin-path-reuse',
    })
    git(setup.repository, 'merge', '--no-ff', setup.sourceCommit, '-m', 'merge before admin reuse')
    git(setup.repository, 'worktree', 'remove', setup.candidateWorktree)
    git(setup.repository, 'branch', '-d', 'card-77')
    git(setup.repository, 'branch', 'unrelated-admin-reuse')

    git(setup.repository, 'worktree', 'add', setup.candidateWorktree, 'unrelated-admin-reuse')
    expect(setup.trackbook.reconcilePendingAutoshipIntents({ actor })).toEqual([
      expect.objectContaining({
        status: 'pending',
        reason: expect.stringMatching(/card worktree cleanup is incomplete/),
      }),
    ])
    git(setup.repository, 'worktree', 'remove', setup.candidateWorktree)
    // ext4 (CI) hands freed inodes straight back, APFS (macOS) never does — burn a few
    // directory inodes so the recreated admin dir cannot inherit the recorded identity
    for (let i = 0; i < 8; i++) mkdirSync(path.join(setup.holder, `inode-spacer-${i}`))

    const alternateParent = path.join(setup.holder, 'unrelated-parent')
    mkdirSync(alternateParent)
    const unrelatedWorktree = path.join(alternateParent, path.basename(setup.candidateWorktree))
    git(setup.repository, 'worktree', 'add', unrelatedWorktree, 'unrelated-admin-reuse')
    const reusedGitDir = realpathSync(git(unrelatedWorktree, 'rev-parse', '--absolute-git-dir'))
    const reusedAdmin = lstatSync(reusedGitDir, { bigint: true })
    expect(reusedGitDir).toBe(intent.worktree_git_dir)
    if (`${reusedAdmin.dev}:${reusedAdmin.ino}`
      === `${intent.worktree_git_dir_device}:${intent.worktree_git_dir_inode}`) {
      // the filesystem recycled the exact inode anyway — identity genuinely matches and
      // unrelated-reuse detection is indistinguishable from the original; nothing to test
      return
    }

    const [completed] = setup.trackbook.reconcilePendingAutoshipIntents({ actor })
    expect(completed?.status).toBe('completed')
    expect(git(setup.repository, 'worktree', 'list', '--porcelain'))
      .toContain(realpathSync(unrelatedWorktree))
    expect(git(unrelatedWorktree, 'rev-parse', 'unrelated-admin-reuse'))
      .toBe(git(setup.repository, 'rev-parse', 'main'))
  })

  it('keeps completion pending when the detached accepted worktree was moved off its canonical path', () => {
    const setup = fixture()
    setup.trackbook.prepareAutoshipIntent(setup.accepted.id, {
      actor,
      branch: 'card-77',
      idempotencyKey: 'prepare:moved-detached-worktree',
    })
    git(setup.repository, 'merge', '--no-ff', setup.sourceCommit, '-m', 'merge before moved cleanup bypass')
    const canonicalWorktree = setup.candidateWorktree
    const movedWorktree = path.join(setup.holder, 'moved-detached-candidate')
    git(canonicalWorktree, 'checkout', '--detach', setup.sourceCommit)
    git(setup.repository, 'branch', '-d', 'card-77')
    git(setup.repository, 'worktree', 'move', canonicalWorktree, movedWorktree)

    expect(setup.trackbook.reconcilePendingAutoshipIntents({ actor })).toEqual([
      expect.objectContaining({
        status: 'pending',
        reason: expect.stringMatching(/durable candidate worktree remains registered/),
      }),
    ])
    expect(setup.db.prepare('SELECT COUNT(*) AS count FROM delivery_shipment_receipts').get())
      .toEqual({ count: 0 })
    expect(setup.db.prepare('SELECT COUNT(*) AS count FROM delivery_shipments').get())
      .toEqual({ count: 0 })
    expect(setup.db.prepare('SELECT COUNT(*) AS count FROM delivery_autoship_completions').get())
      .toEqual({ count: 0 })
    expect(git(setup.repository, 'worktree', 'list', '--porcelain')).toContain(
      realpathSync(movedWorktree),
    )
    expect(git(movedWorktree, 'rev-parse', 'HEAD')).toBe(setup.sourceCommit)
  })

  it('tracks a moved candidate by durable admin identity after HEAD advances and content becomes dirty', async () => {
    const setup = fixture()
    const intent = setup.trackbook.prepareAutoshipIntent(setup.accepted.id, {
      actor,
      branch: 'card-77',
      idempotencyKey: 'prepare:moved-advanced-dirty-worktree',
    })
    git(setup.repository, 'merge', '--no-ff', setup.sourceCommit, '-m', 'merge before advanced worktree bypass')
    const movedWorktree = path.join(setup.holder, 'moved-advanced-dirty-candidate')
    git(setup.candidateWorktree, 'checkout', '--detach', setup.sourceCommit)
    git(setup.repository, 'branch', '-d', 'card-77')
    git(setup.repository, 'worktree', 'move', setup.candidateWorktree, movedWorktree)
    writeFileSync(path.join(movedWorktree, 'advanced.txt'), 'advanced commit\n')
    git(movedWorktree, 'add', 'advanced.txt')
    git(movedWorktree, 'commit', '-m', 'advance detached candidate after move')
    const advancedHead = git(movedWorktree, 'rev-parse', 'HEAD')
    expect(advancedHead).not.toBe(setup.sourceCommit)
    writeFileSync(path.join(movedWorktree, 'advanced.txt'), 'dirty tracked content\n')
    writeFileSync(path.join(movedWorktree, 'untracked.txt'), 'dirty untracked content\n')
    writeFileSync(path.join(setup.repository, '.git', 'info', 'exclude'), '.env\nartifacts/\n')
    mkdirSync(path.join(movedWorktree, 'artifacts'), { recursive: true })
    const ignoredPaths = [
      path.join(movedWorktree, '.env'),
      path.join(movedWorktree, 'artifacts', 'retained-output.log'),
    ]
    for (const ignoredPath of ignoredPaths) writeFileSync(ignoredPath, 'ignored user content\n')
    setup.db.prepare("UPDATE cards SET column_name='done' WHERE id=?").run(setup.cardId)

    const server = buildServer(setup.db)
    await expect.poll(
      () => setup.db.prepare('SELECT column_name FROM cards WHERE id=?').get(setup.cardId),
      { timeout: 30_000 },
    ).toEqual({ column_name: 'blocked' })

    expect(existsSync(movedWorktree)).toBe(true)
    expect(existsSync(path.join(movedWorktree, 'advanced.txt'))).toBe(true)
    expect(existsSync(path.join(movedWorktree, 'untracked.txt'))).toBe(true)
    expect(ignoredPaths.every((ignoredPath) => existsSync(ignoredPath))).toBe(true)
    expect(git(setup.repository, 'worktree', 'list', '--porcelain')).toContain(realpathSync(movedWorktree))
    expect(git(movedWorktree, 'rev-parse', 'HEAD')).toBe(advancedHead)
    expect(git(movedWorktree, 'status', '--porcelain=v1', '--untracked-files=all', '--ignored=matching'))
      .toMatch(/(?: M advanced\.txt|\?\? untracked\.txt|!! \.env)/)
    expect(git(setup.repository, 'branch', '--list', 'card-77')).toBe('')
    expect(setup.trackbook.pendingAutoshipIntents()).toEqual([intent])
    expect(setup.db.prepare('SELECT COUNT(*) AS count FROM delivery_shipment_receipts').get())
      .toEqual({ count: 0 })
    expect(setup.db.prepare('SELECT COUNT(*) AS count FROM delivery_shipments').get())
      .toEqual({ count: 0 })
    expect(setup.db.prepare('SELECT COUNT(*) AS count FROM delivery_autoship_completions').get())
      .toEqual({ count: 0 })
    await server.close()
  }, 60_000)

  it('startup keeps merged work pending and requeues exact cleanup identity from done or autoship-failed', async () => {
    const setup = fixture()
    const intent = setup.trackbook.prepareAutoshipIntent(setup.accepted.id, {
      actor,
      branch: 'card-77',
      idempotencyKey: 'prepare:startup-proof',
    })
    git(setup.repository, 'merge', '--no-ff', setup.sourceCommit, '-m', 'merge before daemon restart')
    setup.db.prepare("UPDATE cards SET column_name='done' WHERE id=?").run(setup.cardId)
    const firstEnqueued: any[] = []
    const first = buildServer(setup.db, undefined, {
      makeShipQueue: () => ({
        enqueue: (candidate) => { firstEnqueued.push(candidate); return { queued: true } },
        status: () => null,
      }),
    })
    expect(firstEnqueued).toEqual([expect.objectContaining({
      boardId: setup.boardId,
      cardId: setup.cardId,
      branch: intent.source_branch,
      sourceCommit: intent.source_commit,
      worktree: cardWorktree(setup.repository, setup.cardId),
    })])
    expect(setup.db.prepare('SELECT COUNT(*) AS count FROM delivery_shipment_receipts').get())
      .toEqual({ count: 0 })
    expect(setup.db.prepare('SELECT COUNT(*) AS count FROM delivery_shipments').get())
      .toEqual({ count: 0 })
    expect(setup.db.prepare('SELECT COUNT(*) AS count FROM delivery_autoship_completions').get())
      .toEqual({ count: 0 })
    expect(git(setup.repository, 'rev-parse', 'card-77')).toBe(setup.sourceCommit)
    await first.close()

    setup.db.prepare("UPDATE cards SET column_name='blocked' WHERE id=?").run(setup.cardId)
    setup.db.prepare(`INSERT INTO card_events (card_id, type, payload)
      VALUES (?, 'autoship_failed', '{}')`).run(setup.cardId)
    const retryEnqueued: any[] = []
    const retry = buildServer(setup.db, undefined, {
      makeShipQueue: () => ({
        enqueue: (candidate) => { retryEnqueued.push(candidate); return { queued: true } },
        status: () => null,
      }),
    })
    expect(retryEnqueued).toEqual([expect.objectContaining({
      branch: intent.source_branch,
      sourceCommit: intent.source_commit,
      worktree: cardWorktree(setup.repository, setup.cardId),
    })])
    expect(setup.db.prepare('SELECT column_name FROM cards WHERE id=?').get(setup.cardId))
      .toEqual({ column_name: 'blocked' })
    expect(setup.db.prepare('SELECT COUNT(*) AS count FROM delivery_autoship_completions').get())
      .toEqual({ count: 0 })
    await retry.close()
  })
})
