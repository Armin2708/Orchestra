import type Database from 'better-sqlite3'
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { ArtifactStore } from '../src/agent-os/artifact-store.js'
import { DeliveryReportService, type DeliveryReport } from '../src/agent-os/delivery-reports.js'
import { installDeliveryTrackbookSchema } from '../src/agent-os/delivery-trackbook-migration.js'
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

afterEach(async () => {
  await Promise.allSettled(servers.splice(0).map((server) => server.close()))
  while (databases.length) databases.pop()!.close()
})

function fixture() {
  const db = openDb(':memory:')
  databases.push(db)
  installDeliveryTrackbookSchema(db)
  const boardId = Number(db.prepare("INSERT INTO boards (project_path, name) VALUES ('/repo', 'Delivery')")
    .run().lastInsertRowid)
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
    commits: [SOURCE_COMMIT],
    artifactIds: [output.id],
  })
  const trackbook = new DeliveryTrackbookService(db)
  return { db, boardId, cardId, contract, job, reports, submitted, output, trackbook }
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
  it('replays safely and installs the five additive provenance tables', () => {
    const setup = fixture()
    expect(() => installDeliveryTrackbookSchema(setup.db)).not.toThrow()
    const names = (setup.db.prepare(`SELECT name FROM sqlite_master
      WHERE type='table' AND name IN (
        'delivery_verification_runs','delivery_artifact_attestations','delivery_review_comments',
        'delivery_shipments','delivery_regressions'
      ) ORDER BY name`).all() as Array<{ name: string }>).map((row) => row.name)
    expect(names).toHaveLength(5)
    const deleteGuards = setup.db.prepare(`SELECT name FROM sqlite_master
      WHERE type='trigger' AND name LIKE 'delivery_%_delete_guard'`).all()
    expect(deleteGuards).toHaveLength(6)
  })

  it('prevents direct and cascading deletion of every immutable proof ledger', () => {
    const setup = fixture()
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
    const shipment = setup.trackbook.ship(accepted.id, {
      actor: operator,
      sourceRepository: '/repo',
      sourceCommit: SOURCE_COMMIT,
      destination: 'beta',
      artifactAttestationIds: [attestation!.id],
      shippedAt: '2026-08-02T09:00:00.000Z',
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
  it('records a provenance manifest distinct from git history and reopens one immutable child after regression', () => {
    const setup = fixture()
    const accepted = verifyAndAccept(setup)
    const attestation = setup.trackbook.attestArtifact(accepted.id, {
      actor: operator,
      artifactId: setup.output.id,
      sourceKind: 'file',
      sourceLocator: 'artifacts/focused-tests.txt',
      sourceRevision: SOURCE_COMMIT,
      builder: 'vitest',
      parameters: { mode: 'focused' },
      environment: { CI: '1' },
      provenance: { job_id: setup.job.id, report_id: accepted.id },
      idempotencyKey: 'attest:focused',
    })
    const shipInput = {
      actor: operator,
      sourceRepository: '/repo',
      sourceCommit: SOURCE_COMMIT,
      destination: 'beta',
      deploymentRef: 'release/beta-1',
      artifactAttestationIds: [attestation.id],
      shippedAt: '2026-08-02T09:00:00.000Z',
      idempotencyKey: 'ship:beta-1',
    }
    const shipment = setup.trackbook.ship(accepted.id, shipInput)
    expect(setup.trackbook.ship(accepted.id, shipInput)).toEqual(shipment)
    expect(shipment).toMatchObject({
      report_id: accepted.id,
      source_repository: '/repo',
      source_commit: SOURCE_COMMIT,
      destination: 'beta',
      artifact_attestations: [expect.objectContaining({
        id: attestation.id,
        artifact_id: setup.output.id,
        content_sha256: attestation.content_sha256,
        attestation_sha256: attestation.attestation_sha256,
      })],
      manifest_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    expect(() => setup.trackbook.ship(accepted.id, { ...shipInput, destination: 'production' }))
      .toThrow(/idempotency key.*different input/)
    expect(() => setup.db.prepare('UPDATE delivery_shipments SET destination=? WHERE id=?')
      .run('tampered', shipment.id)).toThrow(/immutable/)

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
    const setup = fixture()
    const accepted = verifyAndAccept(setup)
    expect(() => setup.trackbook.ship(accepted.id, {
      actor: operator,
      sourceRepository: '/repo',
      sourceCommit: 'b'.repeat(40),
      destination: 'beta',
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
        source_repository: '/repo',
        source_commit: SOURCE_COMMIT,
        destination: 'beta',
      },
    })
    expect(unauthorized.statusCode).toBe(403)
    expect(unauthorized.json().error).toMatch(/operator authorization/)
  })
})
