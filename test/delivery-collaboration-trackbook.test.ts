import type Database from 'better-sqlite3'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { ArtifactStore } from '../src/agent-os/artifact-store.js'
import { DeliveryReportService, type DeliveryReport } from '../src/agent-os/delivery-reports.js'
import { installDeliveryTrackbookSchema } from '../src/agent-os/delivery-trackbook-migration.js'
import { installDeliveryShipmentIntegritySchema } from '../src/agent-os/delivery-shipment-integrity-migration.js'
import { deliveryTrackbookPlugin } from '../src/agent-os/delivery-trackbook-routes.js'
import { DeliveryTrackbookService } from '../src/agent-os/delivery-trackbook.js'
import { EventStore } from '../src/agent-os/event-store.js'
import { JobScheduler } from '../src/agent-os/scheduler.js'
import { TaskContractService } from '../src/agent-os/task-contracts.js'
import { openDb } from '../src/db.js'

const operator = { type: 'operator' as const, id: 'reviewer-7' }
const agent = { type: 'agent' as const, id: 'worker-3' }
const SOURCE_COMMIT = 'a'.repeat(40)
const databases: Database.Database[] = []
const servers: FastifyInstance[] = []
const repositories: string[] = []

afterEach(async () => {
  await Promise.allSettled(servers.splice(0).map((server) => server.close()))
  while (databases.length) databases.pop()!.close()
  while (repositories.length) rmSync(repositories.pop()!, { recursive: true, force: true })
})

type TestRepository = { root: string; head: string }

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()
}

function repository(objectFormat: 'sha1' | 'sha256' = 'sha1'): TestRepository {
  const root = mkdtempSync(path.join(os.tmpdir(), 'orchestra-delivery-shipment-'))
  repositories.push(root)
  git(root, 'init', `--object-format=${objectFormat}`, '-b', 'main')
  git(root, 'config', 'user.email', 'delivery@example.test')
  git(root, 'config', 'user.name', 'Delivery Test')
  writeFileSync(path.join(root, 'README.md'), '# Delivery shipment\n')
  git(root, 'add', 'README.md')
  git(root, 'commit', '-m', 'initial delivery')
  return { root: realpathSync(root), head: git(root, 'rev-parse', 'HEAD') }
}

function commit(repositoryState: TestRepository, name: string): string {
  writeFileSync(path.join(repositoryState.root, name), `${name}\n`)
  git(repositoryState.root, 'add', name)
  git(repositoryState.root, 'commit', '-m', `add ${name}`)
  repositoryState.head = git(repositoryState.root, 'rev-parse', 'HEAD')
  return repositoryState.head
}

function fixture(repositoryState?: TestRepository) {
  const db = openDb(':memory:')
  databases.push(db)
  installDeliveryTrackbookSchema(db)
  installDeliveryShipmentIntegritySchema(db)
  const projectPath = repositoryState?.root ?? '/repo'
  const sourceCommit = repositoryState?.head ?? SOURCE_COMMIT
  const boardId = Number(db.prepare("INSERT INTO boards (project_path, name) VALUES (?, 'Delivery')")
    .run(projectPath).lastInsertRowid)
  const cardId = Number(db.prepare(`INSERT INTO cards (board_id, title, description)
    VALUES (?, 'Ship Trackbook', 'Prove requested versus delivered')`).run(boardId).lastInsertRowid)
  const contract = new TaskContractService(db).put(cardId, {
    objective: 'Ship a provenance-safe Delivery Trackbook.',
    deliverables: [{ id: 'trackbook', text: 'Requested and Delivered columns', required: true }],
    acceptance_criteria: [{
      id: 'proof',
      text: 'Exact verification and provenance are visible',
      required: true,
      deliverable_ids: ['trackbook'],
    }],
    verify_commands: ['npm test -- delivery-collaboration-trackbook'],
    base_ref: 'main',
  })
  const job = new JobScheduler(db).create({ boardId, cardId, provider: 'codex' })
  const reports = new DeliveryReportService(db)
  const draft = reports.prepareForJob(job.id)
  const output = new ArtifactStore(db).create({
    boardId,
    cardId,
    kind: 'test_report',
    name: 'focused-tests.txt',
    content: '9 tests passed\nexit 0\n',
    metadata: { redacted: true },
  })
  const submitted = reports.submit(draft.id, {
    actor: 'agent:worker-3',
    summary: 'Implemented the requested Delivery Trackbook slice.',
    deliveredItems: [{ deliverableId: 'trackbook', status: 'delivered' }],
    changedFiles: ['src/agent-os/delivery-trackbook.ts'],
    commits: [sourceCommit],
    artifactIds: [output.id],
  })
  const trackbook = new DeliveryTrackbookService(db)
  return { db, boardId, cardId, contract, job, reports, submitted, output, trackbook, sourceCommit }
}

function observeShipment(
  setup: ReturnType<typeof fixture>,
  idempotencyKey: string,
  observedHeadCommit = setup.sourceCommit,
) {
  return setup.trackbook.recordShipQueueReceipt({
    boardId: setup.boardId,
    cardId: setup.cardId,
    sourceCommit: setup.sourceCommit,
    observedHeadCommit,
    idempotencyKey,
  })
}

function verifyAndAccept(setup: ReturnType<typeof fixture>): DeliveryReport {
  const evidence = [{ kind: 'artifact' as const, ref: setup.output.id }]
  const verified = setup.reports.verify(setup.submitted.id, {
    actor: 'agent:verifier',
    deliverableResults: [{ deliverableId: 'trackbook', outcome: 'met', evidenceRefs: evidence }],
    results: [{ criterionId: 'proof', outcome: 'met', evidenceRefs: evidence }],
  })
  return setup.reports.accept(verified.id, { actor: 'operator:reviewer-7', note: 'Exact evidence reviewed.' })
}

describe('delivery collaboration Trackbook migration', () => {
  it('replays both migrations safely and installs the observed receipt schema', () => {
    const setup = fixture()
    expect(() => installDeliveryTrackbookSchema(setup.db)).not.toThrow()
    expect(() => installDeliveryShipmentIntegritySchema(setup.db)).not.toThrow()
    const names = (setup.db.prepare(`SELECT name FROM sqlite_master
      WHERE type='table' AND name IN (
        'delivery_verification_runs','delivery_artifact_attestations','delivery_review_comments',
        'delivery_shipment_receipts','delivery_shipments','delivery_regressions'
      ) ORDER BY name`).all() as Array<{ name: string }>).map((row) => row.name)
    expect(names).toHaveLength(6)
    const deleteGuards = setup.db.prepare(`SELECT name FROM sqlite_master
      WHERE type='trigger' AND name LIKE 'delivery_%_delete_guard'`).all()
    expect(deleteGuards).toHaveLength(9)
  })

  it('prevents direct and cascading deletion of every immutable proof ledger', () => {
    const repositoryState = repository()
    const setup = fixture(repositoryState)
    const verification = setup.trackbook.recordVerificationRun(setup.submitted.id, {
      actor: agent,
      command: 'npm test -- delivery-collaboration-trackbook',
      cwd: '/repo',
      environment: { CI: '1' },
      exitCode: 0,
      outputArtifactId: setup.output.id,
      startedAt: '2026-08-02T08:00:00.000Z',
      finishedAt: '2026-08-02T08:00:01.000Z',
      idempotencyKey: 'verify:immutable-delete',
    })
    const [attestation] = setup.trackbook.artifactAttestations(setup.submitted.id)
    const comment = setup.trackbook.addReviewComment(setup.submitted.id, {
      actor: operator,
      criterionId: 'proof',
      artifactId: setup.output.id,
      location: { path: 'focused-tests.txt', startLine: 1, endLine: 2 },
      body: 'Retain this exact proof with the report.',
      idempotencyKey: 'comment:immutable-delete',
    })
    expect(() => setup.db.prepare('DELETE FROM delivery_reports WHERE id=?').run(setup.submitted.id))
      .toThrow(/immutable/)
    expect(() => setup.db.prepare('DELETE FROM cards WHERE id=?').run(setup.cardId))
      .toThrow(/immutable/)
    const accepted = verifyAndAccept(setup)
    const receipt = observeShipment(setup, 'receipt:immutable-delete')
    const shipment = setup.trackbook.ship(accepted.id, {
      actor: operator,
      receiptId: receipt.id,
      artifactAttestationIds: [attestation!.id],
      idempotencyKey: 'ship:immutable-delete',
    })
    const regressionArtifact = new ArtifactStore(setup.db).create({
      boardId: setup.boardId,
      cardId: setup.cardId,
      kind: 'regression_report',
      name: 'immutable-regression.txt',
      content: 'A reproducible regression.',
    })
    setup.trackbook.attestArtifact(accepted.id, {
      actor: operator,
      artifactId: regressionArtifact.id,
      sourceKind: 'external',
      sourceLocator: 'beta:immutable-regression',
      builder: 'operator-observation',
      idempotencyKey: 'attest:immutable-regression',
    })
    const regression = setup.trackbook.reopenAfterRegression(accepted.id, {
      actor: operator,
      shipmentId: shipment.id,
      evidenceArtifactId: regressionArtifact.id,
      summary: 'Proof must survive reopening.',
      observedAt: '2026-08-02T10:00:00.000Z',
      idempotencyKey: 'regression:immutable-delete',
    })

    const immutableRows = [
      ['delivery_verification_runs', verification.id],
      ['delivery_artifact_attestations', attestation!.id],
      ['delivery_review_comments', comment.id],
      ['delivery_shipment_receipts', receipt.id],
      ['delivery_shipments', shipment.id],
      ['delivery_regressions', regression.id],
    ] as const
    for (const [table, id] of immutableRows) {
      expect(() => setup.db.prepare(`DELETE FROM ${table} WHERE id=?`).run(id)).toThrow(/immutable/)
    }
    expect(() => setup.db.prepare('DELETE FROM artifacts WHERE id=?').run(setup.output.id))
      .toThrow(/immutable/)

    const before = Object.fromEntries(immutableRows.map(([table]) => [
      table,
      (setup.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count,
    ]))
    expect(() => setup.db.prepare('DELETE FROM delivery_reports WHERE id=?').run(accepted.id))
      .toThrow(/immutable|FOREIGN KEY constraint/)
    expect(() => setup.db.prepare('DELETE FROM cards WHERE id=?').run(setup.cardId))
      .toThrow(/immutable|FOREIGN KEY constraint/)
    expect(Object.fromEntries(immutableRows.map(([table]) => [
      table,
      (setup.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count,
    ]))).toEqual(before)
    expect(setup.reports.get(accepted.id).id).toBe(accepted.id)
  })
})

describe('exact verification and artifact provenance', () => {
  it('records command, safe environment, exit, bounded output digest, immutable attestation and exact replay', () => {
    const setup = fixture()
    const input = {
      actor: agent,
      command: 'npm test -- delivery-collaboration-trackbook',
      cwd: '/repo',
      environment: { CI: '1', NODE_ENV: 'test' },
      exitCode: 0,
      outputArtifactId: setup.output.id,
      startedAt: '2026-08-02T08:00:00.000Z',
      finishedAt: '2026-08-02T08:00:01.000Z',
      idempotencyKey: 'verify:focused',
    }
    const first = setup.trackbook.recordVerificationRun(setup.submitted.id, input)
    const replay = setup.trackbook.recordVerificationRun(setup.submitted.id, input)

    expect(replay).toEqual(first)
    expect(first).toMatchObject({
      command: input.command,
      environment: { CI: '1', NODE_ENV: 'test' },
      exit_code: 0,
      output_artifact_id: setup.output.id,
      output_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      environment_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    expect(setup.trackbook.artifactAttestations(setup.submitted.id)).toEqual([
      expect.objectContaining({
        artifact_id: setup.output.id,
        source_kind: 'command_output',
        content_sha256: first.output_sha256,
        attestation_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ])
    expect(() => setup.trackbook.recordVerificationRun(setup.submitted.id, {
      ...input,
      exitCode: 1,
    })).toThrow(/idempotency key.*different input/)
    expect(() => setup.db.prepare('UPDATE artifacts SET content=? WHERE id=?')
      .run('tampered', setup.output.id)).toThrow(/immutable/)
  })

  it('rejects secret-bearing, oversized and sensitive-environment verification evidence', () => {
    const setup = fixture()
    const artifacts = new ArtifactStore(setup.db)
    const secret = artifacts.create({
      boardId: setup.boardId,
      cardId: setup.cardId,
      kind: 'test_report',
      name: 'unsafe.txt',
      content: ['Authorization: Bearer', 'unsafe-value'].join(' '),
    })
    const base = {
      actor: agent,
      command: 'npm test',
      cwd: '/repo',
      environment: {},
      exitCode: 0,
      startedAt: '2026-08-02T08:00:00.000Z',
      finishedAt: '2026-08-02T08:00:01.000Z',
      idempotencyKey: 'verify:unsafe',
    }
    expect(() => setup.trackbook.recordVerificationRun(setup.submitted.id, {
      ...base,
      outputArtifactId: secret.id,
    })).toThrow(/must be redacted/)

    const oversized = artifacts.create({
      boardId: setup.boardId,
      cardId: setup.cardId,
      kind: 'test_report',
      name: 'oversized.txt',
      content: 'x'.repeat(1024 * 1024 + 1),
    })
    expect(() => setup.trackbook.recordVerificationRun(setup.submitted.id, {
      ...base,
      outputArtifactId: oversized.id,
      idempotencyKey: 'verify:oversized',
    })).toThrow(/1 MiB/)
    expect(() => setup.trackbook.recordVerificationRun(setup.submitted.id, {
      ...base,
      outputArtifactId: setup.output.id,
      environment: { API_TOKEN: 'do-not-store' },
      idempotencyKey: 'verify:env-secret',
    })).toThrow(/sensitive environment key/)
  })
})

describe('review, rejection, revision and exact locations', () => {
  it('links feedback to one stable criterion and an exact artifact range, then revises and resubmits', () => {
    const setup = fixture()
    setup.trackbook.attestArtifact(setup.submitted.id, {
      actor: agent,
      artifactId: setup.output.id,
      sourceKind: 'file',
      sourceLocator: 'focused-tests.txt',
      sourceRevision: SOURCE_COMMIT,
      builder: 'vitest',
      idempotencyKey: 'attest:review-output',
    })
    const comment = setup.trackbook.addReviewComment(setup.submitted.id, {
      actor: operator,
      criterionId: 'proof',
      artifactId: setup.output.id,
      location: { path: 'focused-tests.txt', startLine: 1, endLine: 2 },
      body: 'Keep the command output with the accepted record.',
      idempotencyKey: 'comment:proof',
    })
    expect(setup.trackbook.addReviewComment(setup.submitted.id, {
      actor: operator,
      criterionId: 'proof',
      artifactId: setup.output.id,
      location: { path: 'focused-tests.txt', startLine: 1, endLine: 2 },
      body: 'Keep the command output with the accepted record.',
      idempotencyKey: 'comment:proof',
    })).toEqual(comment)
    expect(comment).toMatchObject({
      criterion_id: 'proof',
      deliverable_id: null,
      artifact_id: setup.output.id,
      location: { path: 'focused-tests.txt', startLine: 1, endLine: 2 },
    })
    expect(() => setup.trackbook.addReviewComment(setup.submitted.id, {
      actor: operator,
      criterionId: 'proof',
      deliverableId: 'trackbook',
      artifactId: setup.output.id,
      location: { startLine: 1 },
      body: 'Ambiguous target',
      idempotencyKey: 'comment:ambiguous',
    })).toThrow(/exactly one/)
    expect(() => setup.trackbook.addReviewComment(setup.submitted.id, {
      actor: operator,
      criterionId: 'proof',
      artifactId: setup.output.id,
      location: { startLine: 99 },
      body: 'Outside evidence',
      idempotencyKey: 'comment:outside',
    })).toThrow(/exceeds artifact content/)

    const rejected = setup.trackbook.rejectWithFeedback(setup.submitted.id, {
      actor: operator,
      reason: 'Add the exact output provenance.',
    })
    const revision = setup.trackbook.reviseRejected(rejected.id, agent)
    const resubmitted = setup.reports.submit(revision.id, {
      actor: 'agent:worker-3',
      summary: 'Revised with exact provenance.',
      deliveredItems: [{ deliverableId: 'trackbook', status: 'delivered' }],
      commits: [SOURCE_COMMIT],
      artifactIds: [setup.output.id],
    })
    expect(rejected).toMatchObject({ status: 'rejected', rejection_reason: 'Add the exact output provenance.' })
    expect(resubmitted).toMatchObject({ status: 'submitted', parent_report_id: rejected.id, sequence: 2 })
    expect(resubmitted.asked).toEqual(rejected.asked)
  })
})

describe('canonical shipping and regression reopen', () => {
  it('accepts a full 64-character SHA only when a SHA-256 board repository resolves it', () => {
    const repositoryState = repository('sha256')
    expect(repositoryState.head).toMatch(/^[a-f0-9]{64}$/)
    const setup = fixture(repositoryState)
    expect(observeShipment(setup, 'receipt:sha256')).toMatchObject({
      source_commit: repositoryState.head,
      observed_head_commit: repositoryState.head,
    })
  })

  it('rejects abbreviated, foreign, stale and non-root shipment assertions before minting a receipt', () => {
    const repositoryState = repository()
    const setup = fixture(repositoryState)
    expect(() => setup.trackbook.recordShipQueueReceipt({
      boardId: setup.boardId,
      cardId: setup.cardId,
      sourceCommit: repositoryState.head.slice(0, 12),
      observedHeadCommit: repositoryState.head,
      idempotencyKey: 'receipt:abbreviated',
    })).toThrow(/full 40- or 64-character/)

    const foreignRepository = repository()
    const foreignCommit = commit(foreignRepository, 'foreign.txt')
    expect(() => setup.trackbook.recordShipQueueReceipt({
      boardId: setup.boardId,
      cardId: setup.cardId,
      sourceCommit: foreignCommit,
      observedHeadCommit: repositoryState.head,
      idempotencyKey: 'receipt:foreign',
    })).toThrow(/does not resolve in the exact board repository/)

    const staleCommit = repositoryState.head
    commit(repositoryState, 'later.txt')
    expect(() => setup.trackbook.recordShipQueueReceipt({
      boardId: setup.boardId,
      cardId: setup.cardId,
      sourceCommit: staleCommit,
      observedHeadCommit: staleCommit,
      idempotencyKey: 'receipt:stale',
    })).toThrow(/observed board repository HEAD/)

    const nestedRepository = repository()
    const nested = path.join(nestedRepository.root, 'nested')
    mkdirSync(nested)
    const nestedSetup = fixture({ root: nested, head: nestedRepository.head })
    expect(() => nestedSetup.trackbook.recordShipQueueReceipt({
      boardId: nestedSetup.boardId,
      cardId: nestedSetup.cardId,
      sourceCommit: nestedRepository.head,
      observedHeadCommit: nestedRepository.head,
      idempotencyKey: 'receipt:nested',
    })).toThrow(/exact repository root/)
  })

  it('records a provenance manifest distinct from git history and reopens one immutable child after regression', () => {
    const repositoryState = repository()
    const setup = fixture(repositoryState)
    const accepted = verifyAndAccept(setup)
    const attestation = setup.trackbook.attestArtifact(accepted.id, {
      actor: operator,
      artifactId: setup.output.id,
      sourceKind: 'file',
      sourceLocator: 'artifacts/focused-tests.txt',
      sourceRevision: setup.sourceCommit,
      builder: 'vitest',
      parameters: { mode: 'focused' },
      environment: { CI: '1' },
      provenance: { job_id: setup.job.id, report_id: accepted.id },
      idempotencyKey: 'attest:focused',
    })
    const observedHeadCommit = commit(repositoryState, 'merged-main.txt')
    const receipt = observeShipment(setup, 'receipt:beta-1', observedHeadCommit)
    const shipInput = {
      actor: operator,
      receiptId: receipt.id,
      artifactAttestationIds: [attestation.id],
      idempotencyKey: 'ship:beta-1',
    }
    const shipment = setup.trackbook.ship(accepted.id, shipInput)
    expect(setup.trackbook.ship(accepted.id, shipInput)).toEqual(shipment)
    expect(shipment).toMatchObject({
      report_id: accepted.id,
      receipt_id: receipt.id,
      source_repository: repositoryState.root,
      source_commit: setup.sourceCommit,
      observed_head_commit: observedHeadCommit,
      destination: 'main',
      artifact_attestations: [expect.objectContaining({
        id: attestation.id,
        artifact_id: setup.output.id,
        content_sha256: attestation.content_sha256,
        attestation_sha256: attestation.attestation_sha256,
      })],
      manifest_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    expect(receipt).toMatchObject({
      receipt_kind: 'ship_queue',
      board_id: setup.boardId,
      card_id: setup.cardId,
      source_repository: repositoryState.root,
      source_commit: setup.sourceCommit,
      observed_head_commit: observedHeadCommit,
      destination: 'main',
      observed_by: 'ship_queue',
      receipt_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    expect(() => setup.trackbook.ship(accepted.id, { ...shipInput, artifactAttestationIds: [] }))
      .toThrow(/idempotency key.*different input/)
    expect(() => setup.db.prepare('UPDATE delivery_shipments SET destination=? WHERE id=?')
      .run('tampered', shipment.id)).toThrow(/immutable/)
    expect(() => setup.db.prepare(`INSERT INTO delivery_shipments
      (id, report_id, board_id, card_id, job_id, source_repository, source_commit,
       destination, deployment_ref, artifact_attestations_json, manifest_sha256,
       shipped_by, shipped_at, idempotency_key, request_sha256, created_at)
      SELECT 'caller-only', report_id, board_id, card_id, job_id, source_repository, source_commit,
        destination, deployment_ref, artifact_attestations_json, manifest_sha256,
        shipped_by, shipped_at, 'caller-only', request_sha256, created_at
      FROM delivery_shipments WHERE id=?`).run(shipment.id)).toThrow(/exact observed ShipQueue receipt/)

    const regressionArtifact = new ArtifactStore(setup.db).create({
      boardId: setup.boardId,
      cardId: setup.cardId,
      kind: 'regression_report',
      name: 'beta-regression.txt',
      content: 'The requested comparison fails after restart.',
    })
    setup.trackbook.attestArtifact(accepted.id, {
      actor: operator,
      artifactId: regressionArtifact.id,
      sourceKind: 'external',
      sourceLocator: 'beta:restart-regression',
      builder: 'operator-observation',
      idempotencyKey: 'attest:restart-regression',
    })
    const regressionInput = {
      actor: operator,
      shipmentId: shipment.id,
      evidenceArtifactId: regressionArtifact.id,
      summary: 'Restart dropped the shipped comparison state.',
      observedAt: '2026-08-02T10:00:00.000Z',
      idempotencyKey: 'regression:restart',
    }
    const regression = setup.trackbook.reopenAfterRegression(accepted.id, regressionInput)
    expect(setup.trackbook.reopenAfterRegression(accepted.id, regressionInput)).toEqual(regression)
    expect(regression).toMatchObject({
      report_id: accepted.id,
      shipment_id: shipment.id,
      evidence_artifact_id: regressionArtifact.id,
      reopened_report_id: expect.any(String),
    })
    expect(setup.reports.get(regression.reopened_report_id)).toMatchObject({
      status: 'draft',
      parent_report_id: accepted.id,
      lineage_id: accepted.lineage_id,
      sequence: 2,
      asked: accepted.asked,
    })
    expect(() => setup.db.prepare('UPDATE delivery_regressions SET summary=? WHERE id=?')
      .run('tampered', regression.id)).toThrow(/immutable/)
  })

  it('fails closed when shipping an uncited commit or an older delivery revision', () => {
    const repositoryState = repository()
    const setup = fixture(repositoryState)
    const accepted = verifyAndAccept(setup)
    const uncitedCommit = commit(repositoryState, 'uncited.txt')
    const receipt = setup.trackbook.recordShipQueueReceipt({
      boardId: setup.boardId,
      cardId: setup.cardId,
      sourceCommit: uncitedCommit,
      observedHeadCommit: uncitedCommit,
      idempotencyKey: 'receipt:uncited',
    })
    expect(() => setup.trackbook.ship(accepted.id, {
      actor: operator,
      receiptId: receipt.id,
      idempotencyKey: 'ship:uncited',
    })).toThrow(/must be cited/)
  })
})

describe('Job Detail and review filters', () => {
  it('returns frozen requested versus delivered data with proof ledgers and exact filter states', () => {
    const setup = fixture()
    setup.trackbook.recordVerificationRun(setup.submitted.id, {
      actor: agent,
      command: 'npm test -- delivery-collaboration-trackbook',
      cwd: '/repo',
      environment: { CI: '1' },
      exitCode: 0,
      outputArtifactId: setup.output.id,
      startedAt: '2026-08-02T08:00:00.000Z',
      finishedAt: '2026-08-02T08:00:01.000Z',
      idempotencyKey: 'verify:detail',
    })
    const detail = setup.trackbook.jobDetail(setup.job.id)
    expect(detail).toMatchObject({
      job: { id: setup.job.id, card_id: setup.cardId },
      requested: { objective: setup.contract.objective, contract_version: setup.contract.version },
      delivered: { id: setup.submitted.id, summary: setup.submitted.summary },
      verification_runs: [{ command: 'npm test -- delivery-collaboration-trackbook', exit_code: 0 }],
      artifact_attestations: [{ artifact_id: setup.output.id }],
    })
    expect(setup.trackbook.listBoard(setup.boardId, 'awaiting_review')).toEqual([
      expect.objectContaining({ id: setup.submitted.id }),
    ])
    expect(setup.trackbook.listBoard(setup.boardId, 'evidence_gaps')).toEqual([
      expect.objectContaining({ id: setup.submitted.id }),
    ])
    expect(setup.trackbook.listBoard(setup.boardId, 'shipped')).toEqual([])
  })
})

describe('Delivery Trackbook authenticated route boundary', () => {
  it('ignores no body actor: spoof attempts fail and operator-only shipping cannot be self-promoted', async () => {
    const setup = fixture()
    const server = Fastify()
    server.decorateRequest('orchestraPrincipal', 'authenticated-user')
    await server.register(deliveryTrackbookPlugin, {
      prefix: '/api/v1/os',
      db: setup.db,
      isOperator: (request: FastifyRequest) => request.headers.authorization === 'Bearer operator',
    })
    servers.push(server)
    await server.ready()

    const spoofed = await server.inject({
      method: 'POST',
      url: `/api/v1/os/deliveries/${setup.submitted.id}/verification-runs`,
      headers: { authorization: 'Bearer agent', 'idempotency-key': 'route:verify' },
      payload: {
        actor: { type: 'operator', id: 'spoofed' },
        command: 'npm test',
        cwd: '/repo',
        environment: {},
        exit_code: 0,
        output_artifact_id: setup.output.id,
        started_at: '2026-08-02T08:00:00.000Z',
        finished_at: '2026-08-02T08:00:01.000Z',
      },
    })
    expect(spoofed.statusCode).toBe(400)
    expect(spoofed.json().error).toMatch(/server-derived/)

    const accepted = verifyAndAccept(setup)
    const unauthorized = await server.inject({
      method: 'POST',
      url: `/api/v1/os/deliveries/${accepted.id}/ship`,
      headers: { authorization: 'Bearer agent', 'idempotency-key': 'route:ship' },
      payload: {
        receipt_id: 'receipt-not-visible-to-agent',
      },
    })
    expect(unauthorized.statusCode).toBe(403)
    expect(unauthorized.json().error).toMatch(/operator authorization/)

    const callerAsserted = await server.inject({
      method: 'POST',
      url: `/api/v1/os/deliveries/${accepted.id}/ship`,
      headers: { authorization: 'Bearer operator', 'idempotency-key': 'route:asserted-ship' },
      payload: {
        receipt_id: 'receipt-not-enough',
        source_repository: '/repo',
        source_commit: SOURCE_COMMIT,
        destination: 'main',
      },
    })
    expect(callerAsserted.statusCode).toBe(400)
    expect(callerAsserted.json().error).toMatch(/observed from the ShipQueue receipt/)
  })
})
