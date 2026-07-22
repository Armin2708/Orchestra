import { describe, expect, it } from 'vitest'
import { ArtifactStore } from '../src/agent-os/artifact-store.js'
import { DeliveryReportService } from '../src/agent-os/delivery-reports.js'
import { EvidenceService } from '../src/agent-os/evidence.js'
import { EventStore } from '../src/agent-os/event-store.js'
import { JobScheduler } from '../src/agent-os/scheduler.js'
import { TaskContractService } from '../src/agent-os/task-contracts.js'
import { WorkspaceStore } from '../src/agent-os/workspace-store.js'
import { openDb } from '../src/db.js'

function fixture() {
  const db = openDb(':memory:')
  const boardId = Number(db.prepare("INSERT INTO boards (project_path, name) VALUES ('/repo', 'repo')")
    .run().lastInsertRowid)
  const cardId = Number(db.prepare(`INSERT INTO cards (board_id, title, description)
    VALUES (?, 'Track delivery', 'Build a canonical delivery trackbook')`).run(boardId).lastInsertRowid)
  const contracts = new TaskContractService(db, new EventStore(db))
  const contract = contracts.put(cardId, {
    deliverables: ['Trackbook service', 'Human report'],
    acceptance_criteria: ['Lifecycle is enforced', 'Evidence is auditable'],
    verify_commands: ['npm test'],
    non_goals: ['No UI in this slice'],
    risks: ['Legacy compatibility'],
  })
  const deliveries = new DeliveryReportService(db)
  return { db, boardId, cardId, contracts, contract, deliveries }
}

function submitAll(setup: ReturnType<typeof fixture>) {
  const draft = setup.deliveries.createForCard(setup.cardId, { actor: 'agent' })
  return setup.deliveries.submit(draft.id, {
    actor: 'agent',
    summary: 'Implemented the requested delivery domain.',
    deliveredItems: draft.asked.deliverables.map((item) => ({ deliverableId: item.id, text: item.text })),
    claims: draft.asked.acceptance_criteria.map((item) => ({
      text: `Claimed ${item.text}`, criterionId: item.id,
    })),
    changedFiles: ['src/agent-os/delivery-reports.ts'],
    commits: ['abc1234'],
  })
}

function evidenceArtifact(setup: ReturnType<typeof fixture>, kind = 'research_report') {
  return new ArtifactStore(setup.db).create({
    boardId: setup.boardId,
    cardId: setup.cardId,
    kind,
    name: `${kind}.md`,
    content: 'Observed evidence',
  })
}

describe('TaskContract delivery identity', () => {
  it('preserves stable ids across legacy-string reorder and versions only Asked changes', () => {
    const setup = fixture()
    const initial = setup.contracts.getOrCreate(setup.cardId)
    const deliverableIds = new Map(initial.deliverables.map((item) => [item.text, item.id]))
    const criterionIds = new Map(initial.acceptance_criteria.map((item) => [item.text, item.id]))

    const reordered = setup.contracts.put(setup.cardId, {
      deliverables: ['Human report', 'Trackbook service'],
      acceptance_criteria: ['Evidence is auditable', 'Lifecycle is enforced'],
    })

    expect(new Map(reordered.deliverables.map((item) => [item.text, item.id]))).toEqual(deliverableIds)
    expect(new Map(reordered.acceptance_criteria.map((item) => [item.text, item.id]))).toEqual(criterionIds)
    expect(reordered.version).toBe(initial.version + 1)

    const noOp = setup.contracts.put(setup.cardId, {
      deliverables: ['Human report', 'Trackbook service'],
      acceptance_criteria: ['Evidence is auditable', 'Lifecycle is enforced'],
    })
    expect(noOp.version).toBe(reordered.version)
    expect(noOp.updated_at).toBe(reordered.updated_at)

    const workspace = new WorkspaceStore(setup.db).create({
      boardId: setup.boardId, cardId: setup.cardId, name: 'runtime', rootPath: '/repo',
    })
    const attached = setup.contracts.put(setup.cardId, { workspace_id: workspace.id })
    expect(attached).toMatchObject({ version: reordered.version, updated_at: reordered.updated_at, workspace_id: workspace.id })
    expect(() => setup.db.prepare('UPDATE task_contracts SET version=version-1 WHERE card_id=?').run(setup.cardId))
      .toThrow(/monotonically/)
    expect(() => setup.db.prepare('UPDATE task_contracts SET version=version WHERE card_id=?').run(setup.cardId))
      .not.toThrow()
  })
})

describe('DeliveryReportService', () => {
  it('prepares one job-linked report and freezes the exact Asked snapshot', () => {
    const setup = fixture()
    const scheduler = new JobScheduler(setup.db)
    const job = scheduler.create({ boardId: setup.boardId, cardId: setup.cardId, provider: 'claude' })

    const prepared = setup.deliveries.prepareForJob(job.id)
    const retried = setup.deliveries.prepareForJob(job.id)
    const frozen = structuredClone(prepared.asked)
    setup.contracts.put(setup.cardId, { objective: 'A changed request' })

    expect(retried.id).toBe(prepared.id)
    expect(setup.deliveries.get(prepared.id).asked).toEqual(frozen)
    expect(setup.deliveries.get(prepared.id).asked.objective).not.toBe('A changed request')
    expect(() => setup.db.prepare("UPDATE delivery_reports SET asked_snapshot='{}' WHERE id=?").run(prepared.id))
      .toThrow(/immutable/)
    expect(new EventStore(setup.db).listBoard(setup.boardId, { cardId: setup.cardId, kind: 'delivery.prepared' }))
      .toHaveLength(1)
  })

  it('submits complete unverifiable coverage and permits review without inventing passes', () => {
    const setup = fixture()
    const draft = setup.deliveries.createForCard(setup.cardId, { actor: 'agent' })
    const submitted = setup.deliveries.submit(draft.id, {
      actor: 'agent',
      summary: 'One promised item is still absent.',
      deliveredItems: [{ deliverableId: draft.asked.deliverables[0].id, text: 'Trackbook service' }],
      claims: ['The lifecycle exists.'],
      gaps: ['Human report remains to be delivered.'],
    })

    expect(submitted.status).toBe('submitted')
    expect(submitted.delivered_items).toEqual([
      expect.objectContaining({ deliverable_id: draft.asked.deliverables[0].id, status: 'delivered' }),
      expect.objectContaining({ deliverable_id: draft.asked.deliverables[1].id, status: 'omitted' }),
    ])
    expect(submitted.deliverable_results.map((item) => item.outcome)).toEqual(['unverifiable', 'unverifiable'])
    expect(submitted.criterion_results.map((item) => item.outcome)).toEqual(['unverifiable', 'unverifiable'])
    expect(setup.deliveries.assertReviewReady(setup.cardId).id).toBe(submitted.id)
    expect(() => setup.deliveries.accept(submitted.id, { actor: 'reviewer' })).toThrow(/verified/)

    const verified = setup.deliveries.verify(submitted.id, { actor: 'verifier', results: [], deliverableResults: [] })
    expect(verified.status).toBe('verified')
    expect(() => setup.deliveries.accept(verified.id, { actor: 'reviewer' })).toThrow(/not completion-ready/)
  })

  it('accepts only when required deliverables and criteria have scoped evidence', () => {
    const setup = fixture()
    const submitted = submitAll(setup)
    const artifact = evidenceArtifact(setup)
    const evidenceRefs = [{ kind: 'artifact' as const, ref: artifact.id }]
    const verified = setup.deliveries.verify(submitted.id, {
      actor: 'verifier',
      deliverableResults: submitted.asked.deliverables.map((item) => ({
        deliverableId: item.id, outcome: 'met', evidenceRefs,
      })),
      results: submitted.asked.acceptance_criteria.map((item) => ({
        criterionId: item.id, outcome: 'met', evidenceRefs,
      })),
    })
    const accepted = setup.deliveries.accept(verified.id, { actor: 'reviewer', note: 'Evidence checked.' })

    expect(accepted).toMatchObject({ status: 'accepted', accepted_by: 'reviewer', acceptance_note: 'Evidence checked.' })
    expect(setup.deliveries.accept(accepted.id, { actor: 'reviewer' }).id).toBe(accepted.id)
    expect(setup.deliveries.assertCompletionReady(setup.cardId).id).toBe(accepted.id)
    expect(new EventStore(setup.db).listBoard(setup.boardId, { cardId: setup.cardId }).map((event) => event.kind))
      .toEqual(expect.arrayContaining([
        'delivery.prepared', 'delivery.submitted', 'delivery.verified', 'delivery.accepted',
      ]))
  })

  it('keeps the failed outcome visible underneath an audited override', () => {
    const setup = fixture()
    const submitted = submitAll(setup)
    const artifact = evidenceArtifact(setup, 'review_report')
    const evidenceRefs = [{ kind: 'artifact' as const, ref: artifact.id }]
    const criterion = submitted.asked.acceptance_criteria[0]
    const verified = setup.deliveries.verify(submitted.id, {
      actor: 'verifier',
      deliverableResults: submitted.asked.deliverables.map((item) => ({
        deliverableId: item.id, outcome: 'met', evidenceRefs,
      })),
      results: submitted.asked.acceptance_criteria.map((item) => item.id === criterion.id ? ({
        criterionId: item.id,
        outcome: 'missed',
        evidenceRefs,
        override: { actor: 'human-reviewer', reason: 'Known non-blocking platform limitation' },
      }) : ({ criterionId: item.id, outcome: 'met', evidenceRefs })),
    })
    const result = verified.criterion_results.find((item) => item.criterion_id === criterion.id)!

    expect(result).toMatchObject({
      outcome: 'missed',
      effective_outcome: 'overridden',
      override: { actor: 'human-reviewer', reason: 'Known non-blocking platform limitation', at: expect.any(String) },
    })
    expect((setup.db.prepare(`SELECT outcome, override_actor FROM delivery_criterion_results
      WHERE report_id=? AND criterion_id=?`).get(verified.id, criterion.id) as any))
      .toEqual({ outcome: 'missed', override_actor: 'human-reviewer' })
    expect(setup.deliveries.accept(verified.id, { actor: 'reviewer' }).status).toBe('accepted')
  })

  it('resolves legacy verification by exact text and never passes unmatched rows positionally', () => {
    const setup = fixture()
    const submitted = submitAll(setup)
    const artifact = evidenceArtifact(setup)
    const firstCriterion = submitted.asked.acceptance_criteria[0]
    const verified = setup.deliveries.verify(submitted.id, {
      actor: 'legacy-verifier',
      deliverableResults: submitted.asked.deliverables.map((item) => ({
        deliverableId: item.id, outcome: 'met', evidenceRefs: [{ kind: 'artifact', ref: artifact.id }],
      })),
      results: [
        { text: firstCriterion.text, met: true, evidence: { kind: 'artifact', ref: artifact.id } },
        { text: 'not an Asked criterion', met: true, evidence: { kind: 'artifact', ref: artifact.id } },
      ],
    })

    expect(verified.criterion_results.find((item) => item.criterion_id === firstCriterion.id)?.outcome).toBe('met')
    expect(verified.criterion_results.find((item) => item.criterion_id !== firstCriterion.id)?.outcome).toBe('unverifiable')
    const event = new EventStore(setup.db).listBoard(setup.boardId, { kind: 'delivery.verified' })[0]
    expect(event.payload).toMatchObject({ unmatched_criteria: ['not an Asked criterion'] })
  })

  it('supports submitted rejection and creates one immutable revision child', () => {
    const setup = fixture()
    const submitted = submitAll(setup)
    const rejected = setup.deliveries.reject(submitted.id, { actor: 'reviewer', reason: 'Needs another pass.' })
    const revision = setup.deliveries.revise(rejected.id, { actor: 'agent' })
    const retried = setup.deliveries.revise(rejected.id, { actor: 'agent' })

    expect(rejected.status).toBe('rejected')
    expect(revision).toMatchObject({
      status: 'draft', parent_report_id: rejected.id, lineage_id: rejected.lineage_id, sequence: 2,
    })
    expect(revision.asked).toEqual(rejected.asked)
    expect(retried.id).toBe(revision.id)
    expect(setup.deliveries.listCard(setup.cardId).map((item) => item.id)).toEqual([rejected.id, revision.id])
    expect(() => setup.deliveries.revise(revision.id)).toThrow(/rejected/)
  })

  it('adds delivery history and criterion-level gaps to EvidenceBundle without requiring code diffs for acceptance', () => {
    const setup = fixture()
    const submitted = submitAll(setup)
    const artifact = evidenceArtifact(setup, 'research_report')
    const evidenceRefs = [{ kind: 'artifact' as const, ref: artifact.id }]
    const verified = setup.deliveries.verify(submitted.id, {
      actor: 'verifier',
      deliverableResults: submitted.asked.deliverables.map((item) => ({ deliverableId: item.id, outcome: 'met', evidenceRefs })),
      results: submitted.asked.acceptance_criteria.map((item) => ({ criterionId: item.id, outcome: 'met', evidenceRefs })),
    })
    setup.deliveries.accept(verified.id, { actor: 'reviewer' })

    const bundle = new EvidenceService(setup.db).assemble(setup.cardId)
    expect(bundle.delivery.current?.status).toBe('accepted')
    expect(bundle.delivery.history).toHaveLength(1)
    expect(bundle.gaps).toContain('No diff or patch artifact has been recorded.')
    expect(bundle.gaps).not.toEqual(expect.arrayContaining([expect.stringMatching(/criterion.*no evidence/i)]))
  })

  it('bounds malformed agent data and renders deterministically without terminal controls', () => {
    const setup = fixture()
    const draft = setup.deliveries.createForCard(setup.cardId)
    expect(() => setup.deliveries.submit(draft.id, {
      actor: 'agent', summary: 'x'.repeat(20_001),
    })).toThrow(/at most 20000/)

    const submitted = setup.deliveries.submit(draft.id, {
      actor: 'agent',
      summary: 'Safe\u001b[31m red\u001b[0m\u0000 summary',
      deliveredItems: draft.asked.deliverables.map((item) => ({ deliverableId: item.id, text: item.text })),
      claims: ['A bounded claim'],
    })
    expect(() => setup.deliveries.verify(submitted.id, {
      actor: 'verifier', results: ['malformed' as any],
    })).toThrow(/objects/)

    const first = setup.deliveries.renderHuman(submitted)
    const second = setup.deliveries.renderHuman(submitted.id)
    expect(second).toBe(first)
    expect(first).toContain('Safe red summary')
    expect(first).not.toMatch(/[\u001b\u0000]/)
    expect(first).toContain('Claims (not evidence)')
  })
})
