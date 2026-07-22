import { createHash, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { ConflictError, NotFoundError, ValidationError } from './errors.js'
import { EventStore } from './event-store.js'
import { parseJson, timestamp } from './json.js'
import {
  normalizeContractText,
  TaskContractService,
  type ContractAcceptanceCriterion,
  type ContractDeliverable,
  type TaskContract,
} from './task-contracts.js'

export type DeliveryStatus = 'draft' | 'submitted' | 'verified' | 'accepted' | 'rejected'
export type CriterionOutcome = 'met' | 'partial' | 'missed' | 'unverifiable'
export type EffectiveCriterionOutcome = CriterionOutcome | 'overridden'
export type DeliveryItemStatus = 'delivered' | 'partial' | 'omitted'
export type EvidenceReferenceKind = 'artifact' | 'event' | 'process' | 'commit' | 'url' | 'other'

export interface DeliveryAskedSnapshot {
  objective: string
  deliverables: ContractDeliverable[]
  acceptance_criteria: ContractAcceptanceCriterion[]
  verify_commands: string[]
  non_goals: string[]
  risks: string[]
  dependencies: number[]
  base_ref: string | null
  budget_tokens: number | null
  budget_cents: number | null
  priority: number
  policy_id: string | null
  contract_version: number
  contract_updated_at: string
}

export interface DeliveryItem {
  id: string
  deliverable_id: string | null
  text: string
  status: DeliveryItemStatus
}

export interface DeliveryClaim {
  id: string
  text: string
  criterion_id: string | null
  deliverable_id: string | null
}

export interface EvidenceReference {
  kind: EvidenceReferenceKind
  ref: string
  label: string | null
}

export interface DeliveryOverride {
  actor: string
  reason: string
  at: string
}

export interface DeliveryDeliverableResult {
  report_id: string
  deliverable_id: string
  text: string
  required: boolean
  outcome: CriterionOutcome
  effective_outcome: EffectiveCriterionOutcome
  note: string | null
  evidence_refs: EvidenceReference[]
  override: DeliveryOverride | null
  actor: string
  created_at: string
  updated_at: string
}

export interface DeliveryCriterionResult {
  report_id: string
  criterion_id: string
  text: string
  required: boolean
  outcome: CriterionOutcome
  effective_outcome: EffectiveCriterionOutcome
  note: string | null
  evidence_refs: EvidenceReference[]
  override: DeliveryOverride | null
  actor: string
  created_at: string
  updated_at: string
}

export interface DeliveryReport {
  id: string
  lineage_id: string
  parent_report_id: string | null
  sequence: number
  board_id: number
  card_id: number
  job_id: string | null
  session_id: string | null
  workspace_id: string | null
  status: DeliveryStatus
  asked: DeliveryAskedSnapshot
  summary: string
  delivered_items: DeliveryItem[]
  claims: DeliveryClaim[]
  changed_files: string[]
  commits: string[]
  artifact_ids: string[]
  gaps: string[]
  deliverable_results: DeliveryDeliverableResult[]
  criterion_results: DeliveryCriterionResult[]
  created_by: string
  submitted_by: string | null
  verified_by: string | null
  accepted_by: string | null
  rejected_by: string | null
  acceptance_note: string | null
  rejection_reason: string | null
  created_at: string
  updated_at: string
  submitted_at: string | null
  verified_at: string | null
  accepted_at: string | null
  rejected_at: string | null
}

export interface CreateDeliveryReportLinks {
  jobId?: string | null
  sessionId?: string | null
  workspaceId?: string | null
  actor?: string
}

export interface AttachRuntimeScopeInput {
  sessionId?: string | null
  workspaceId?: string | null
}

export interface DeliveryItemInput {
  id?: string
  deliverableId?: string | null
  deliverable_id?: string | null
  text?: string
  status?: DeliveryItemStatus
}

export interface DeliveryClaimInput {
  id?: string
  text: string
  criterionId?: string | null
  criterion_id?: string | null
  deliverableId?: string | null
  deliverable_id?: string | null
}

export interface SubmitDeliveryInput {
  actor: string
  summary: string
  deliveredItems?: Array<string | DeliveryItemInput>
  claims?: Array<string | DeliveryClaimInput>
  changedFiles?: string[]
  commits?: string[]
  artifactIds?: string[]
  gaps?: string[]
}

export interface EvidenceReferenceInput {
  kind?: EvidenceReferenceKind
  ref: string
  label?: string | null
}

export interface VerifyResultInput {
  criterionId?: string
  criterion_id?: string
  deliverableId?: string
  deliverable_id?: string
  text?: string
  outcome?: CriterionOutcome | 'overridden'
  originalOutcome?: CriterionOutcome
  original_outcome?: CriterionOutcome
  met?: boolean | 'unverifiable'
  note?: string | null
  evidenceRefs?: Array<string | EvidenceReferenceInput>
  evidence_refs?: Array<string | EvidenceReferenceInput>
  evidence?: string | EvidenceReferenceInput | Array<string | EvidenceReferenceInput>
  override?: { actor: string; reason: string; at?: string }
}

export interface VerifyDeliveryInput {
  actor: string
  results?: VerifyResultInput[]
  deliverableResults?: VerifyResultInput[]
}

export interface AcceptDeliveryInput {
  actor: string
  note?: string | null
}

export interface RejectDeliveryInput {
  actor: string
  reason: string
}

export interface ReviseDeliveryInput {
  actor?: string
}

const LIMITS = {
  actor: 200,
  summary: 20_000,
  text: 4_000,
  note: 4_000,
  reason: 4_000,
  reference: 2_048,
  label: 500,
  id: 256,
  path: 2_048,
  commit: 256,
  items: 200,
  claims: 200,
  results: 200,
  references: 100,
  files: 1_000,
  commits: 200,
  artifacts: 500,
  gaps: 200,
} as const

type ScopeRow = { id: number; board_id: number }
type JobScopeRow = { id: string; board_id: number; card_id: number | null; workspace_id: string | null }
type SessionScopeRow = { id: string; workspace_id: string; context_json: string }
type WorkspaceScopeRow = { id: string; board_id: number; card_id: number | null }
type StoredResult = {
  outcome: CriterionOutcome
  note: string | null
  evidence_refs: EvidenceReference[]
  override: DeliveryOverride | null
}

export class DeliveryReportService {
  private readonly contracts: TaskContractService
  private readonly events: EventStore

  constructor(private readonly db: Database.Database, events?: EventStore) {
    this.contracts = new TaskContractService(db)
    this.events = events ?? new EventStore(db)
  }

  prepareForJob(jobId: string): DeliveryReport {
    const id = boundedString(jobId, 'jobId', LIMITS.id)
    const job = this.job(id)
    if (job.card_id == null) throw new ValidationError('job is not linked to a card')
    const report = this.createForCard(job.card_id, {
      jobId: id,
      actor: 'scheduler',
    })
    const session = this.sessionForJob(id)
    return this.attachRuntimeScope(report.id, {
      sessionId: session?.id,
      workspaceId: job.workspace_id,
    })
  }

  attachRuntimeScope(reportId: string, input: AttachRuntimeScopeInput): DeliveryReport {
    const id = boundedString(reportId, 'delivery report id', LIMITS.id)
    const requestedSessionId = nullableBoundedString(input.sessionId, 'sessionId', LIMITS.id)
    const requestedWorkspaceId = nullableBoundedString(input.workspaceId, 'workspaceId', LIMITS.id)
    const attach = this.db.transaction(() => {
      const report = this.get(id)
      if (!requestedSessionId && !requestedWorkspaceId) return report
      if (report.session_id && requestedSessionId && report.session_id !== requestedSessionId) {
        throw new ConflictError('delivery report is already attached to a different runtime session')
      }
      if (report.workspace_id && requestedWorkspaceId && report.workspace_id !== requestedWorkspaceId) {
        throw new ConflictError('delivery report is already attached to a different runtime workspace')
      }

      const sessionId = report.session_id ?? requestedSessionId
      const session = sessionId ? this.session(sessionId) : null
      const workspaceId = report.workspace_id ?? requestedWorkspaceId ?? session?.workspace_id ?? null
      const workspace = workspaceId ? this.workspace(workspaceId) : null
      const job = report.job_id ? this.job(report.job_id) : null
      if (job && (job.board_id !== report.board_id || job.card_id !== report.card_id)) {
        throw new ConflictError('delivery report job scope no longer matches its card or board')
      }
      if (workspace && workspace.board_id !== report.board_id) {
        throw new ValidationError('workspace belongs to a different board')
      }
      const workspaceMatchesCard = workspace?.card_id === report.card_id
      const workspaceMatchesJob = !!(workspace && job?.workspace_id === workspace.id)
      if (workspace && !workspaceMatchesCard && !workspaceMatchesJob) {
        throw new ValidationError('workspace does not belong to the delivery report card or job')
      }
      if (session && session.workspace_id !== workspaceId) {
        throw new ValidationError('session belongs to a different workspace')
      }
      if (session && job) {
        const sessionJobId = jsonString(parseJson<Record<string, unknown>>(session.context_json, {}).job_id)
        if (sessionJobId !== job.id) throw new ValidationError('session belongs to a different job')
      }

      const nextSessionId = report.session_id ?? sessionId
      const nextWorkspaceId = report.workspace_id ?? workspaceId
      if (nextSessionId === report.session_id && nextWorkspaceId === report.workspace_id) return report
      const at = timestamp()
      this.db.prepare(`UPDATE delivery_reports SET session_id=?, workspace_id=?, updated_at=?
        WHERE id=? AND session_id IS ? AND workspace_id IS ?`)
        .run(nextSessionId, nextWorkspaceId, at, report.id, report.session_id, report.workspace_id)
      const updated = this.get(report.id)
      this.appendEvent('delivery.runtime_scope_attached', 'runtime', eventScope(updated, {
        previous_session_id: report.session_id,
        previous_workspace_id: report.workspace_id,
      }))
      return updated
    })
    return attach.immediate()
  }

  createForCard(cardId: number, links: CreateDeliveryReportLinks = {}): DeliveryReport {
    positiveCardId(cardId)
    const actor = boundedString(links.actor ?? 'system', 'actor', LIMITS.actor)
    const requestedJobId = nullableBoundedString(links.jobId, 'jobId', LIMITS.id)
    const requestedSessionId = nullableBoundedString(links.sessionId, 'sessionId', LIMITS.id)
    const requestedWorkspaceId = nullableBoundedString(links.workspaceId, 'workspaceId', LIMITS.id)
    const create = this.db.transaction(() => {
      const card = this.card(cardId)
      if (requestedJobId) {
        const existing = this.db.prepare(`SELECT id FROM delivery_reports WHERE job_id=?
          ORDER BY sequence DESC, rowid DESC LIMIT 1`).get(requestedJobId) as { id: string } | undefined
        if (existing) return this.get(existing.id)
      } else {
        const existing = this.db.prepare(`SELECT id, session_id, workspace_id FROM delivery_reports
          WHERE card_id=? AND job_id IS NULL AND status IN ('draft','submitted','verified')
          ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(cardId) as
          { id: string; session_id: string | null; workspace_id: string | null } | undefined
        if (existing) {
          if ((requestedSessionId && requestedSessionId !== existing.session_id)
            || (requestedWorkspaceId && requestedWorkspaceId !== existing.workspace_id)) {
            throw new ConflictError('card already has an active delivery report with different scope')
          }
          return this.get(existing.id)
        }
      }

      const contract = this.contracts.getOrCreate(cardId)
      const job = requestedJobId ? this.job(requestedJobId) : null
      if (job && (job.card_id !== cardId || job.board_id !== card.board_id)) {
        throw new ValidationError('job belongs to a different card or board')
      }
      let sessionId = requestedSessionId
      let workspaceId = links.workspaceId === undefined
        ? job?.workspace_id ?? contract.workspace_id
        : requestedWorkspaceId
      if (!sessionId && requestedJobId) sessionId = this.sessionForJob(requestedJobId)?.id ?? null
      const session = sessionId ? this.session(sessionId) : null
      if (session && workspaceId == null) workspaceId = session.workspace_id
      const workspace = workspaceId ? this.workspace(workspaceId) : null
      if (workspace && (workspace.board_id !== card.board_id
        || (workspace.card_id != null && workspace.card_id !== cardId))) {
        throw new ValidationError('workspace belongs to a different card or board')
      }
      if (session && workspace && session.workspace_id !== workspace.id) {
        throw new ValidationError('session belongs to a different workspace')
      }
      if (session && requestedJobId) {
        const sessionJobId = jsonString(parseJson<Record<string, unknown>>(session.context_json, {}).job_id)
        if (sessionJobId && sessionJobId !== requestedJobId) throw new ValidationError('session belongs to a different job')
      }

      const id = randomUUID()
      const at = timestamp()
      const asked = snapshotContract(contract)
      this.db.prepare(`INSERT INTO delivery_reports
        (id, lineage_id, parent_report_id, sequence, board_id, card_id, job_id, session_id, workspace_id,
         status, asked_snapshot, created_by, created_at, updated_at)
        VALUES (?, ?, NULL, 1, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)`)
        .run(id, id, card.board_id, cardId, requestedJobId, sessionId, workspaceId, JSON.stringify(asked), actor, at, at)
      this.appendEvent('delivery.prepared', actor, {
        id, lineage_id: id, parent_report_id: null, sequence: 1, board_id: card.board_id, card_id: cardId,
        job_id: requestedJobId, session_id: sessionId, workspace_id: workspaceId,
        contract_version: asked.contract_version,
      })
      return this.get(id)
    })
    return create.immediate()
  }

  get(id: string): DeliveryReport {
    const reportId = boundedString(id, 'delivery report id', LIMITS.id)
    const row = this.db.prepare('SELECT * FROM delivery_reports WHERE id=?').get(reportId) as Record<string, unknown> | undefined
    if (!row) throw new NotFoundError('delivery report not found')
    return this.mapReport(row)
  }

  listCard(cardId: number): DeliveryReport[] {
    positiveCardId(cardId)
    this.card(cardId)
    const rows = this.db.prepare(`SELECT * FROM delivery_reports WHERE card_id=?
      ORDER BY created_at, rowid`).all(cardId) as Record<string, unknown>[]
    return rows.map((row) => this.mapReport(row))
  }

  currentForCard(cardId: number): DeliveryReport | null {
    positiveCardId(cardId)
    this.card(cardId)
    const row = this.db.prepare(`SELECT * FROM delivery_reports WHERE card_id=?
      ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(cardId) as Record<string, unknown> | undefined
    return row ? this.mapReport(row) : null
  }

  submit(id: string, input: SubmitDeliveryInput): DeliveryReport {
    const actor = boundedString(input.actor, 'actor', LIMITS.actor)
    const report = this.get(id)
    if (report.status === 'submitted') return report
    if (report.status !== 'draft') throw new ConflictError('only a draft delivery report can be submitted')
    const summary = boundedString(input.summary, 'summary', LIMITS.summary)
    const deliveredItems = normalizeDeliveredItems(report, input.deliveredItems ?? [])
    const claims = normalizeClaims(report, input.claims ?? [])
    const changedFiles = boundedStringArray(input.changedFiles ?? [], 'changedFiles', LIMITS.files, LIMITS.path)
    const commits = boundedStringArray(input.commits ?? [], 'commits', LIMITS.commits, LIMITS.commit)
    const artifactIds = boundedStringArray(input.artifactIds ?? [], 'artifactIds', LIMITS.artifacts, LIMITS.id)
    const gaps = boundedStringArray(input.gaps ?? [], 'gaps', LIMITS.gaps, LIMITS.text)
    for (const artifactId of artifactIds) this.assertArtifactScope(report, artifactId)

    const submit = this.db.transaction(() => {
      const current = this.get(id)
      if (current.status === 'submitted') return current
      if (current.status !== 'draft') throw new ConflictError('only a draft delivery report can be submitted')
      const at = timestamp()
      this.db.prepare(`UPDATE delivery_reports SET status='submitted', summary=?, delivered_items=?, claims_json=?,
        changed_files=?, commits=?, artifact_ids=?, gaps=?, submitted_by=?, submitted_at=?, updated_at=? WHERE id=?`)
        .run(summary, JSON.stringify(deliveredItems), JSON.stringify(claims), JSON.stringify(changedFiles),
          JSON.stringify(commits), JSON.stringify(artifactIds), JSON.stringify(gaps), actor, at, at, id)
      this.ensureResultCoverage(current, actor, at)
      this.appendEvent('delivery.submitted', actor, eventScope(current, {
        summary, delivered_item_count: deliveredItems.length, claim_count: claims.length,
        changed_file_count: changedFiles.length, commit_count: commits.length,
        artifact_count: artifactIds.length, reported_gaps: gaps,
      }))
      return this.get(id)
    })
    return submit.immediate()
  }

  verify(id: string, input: VerifyDeliveryInput): DeliveryReport {
    const actor = boundedString(input.actor, 'actor', LIMITS.actor)
    const report = this.get(id)
    if (!['submitted', 'verified'].includes(report.status)) {
      throw new ConflictError('only a submitted or verified delivery report can be verified')
    }
    const criterionInputs = boundedObjectArray(input.results ?? [], 'results', LIMITS.results)
    const deliverableInputs = boundedObjectArray(input.deliverableResults ?? [], 'deliverableResults', LIMITS.results)
    const verify = this.db.transaction(() => {
      const current = this.get(id)
      if (!['submitted', 'verified'].includes(current.status)) {
        throw new ConflictError('only a submitted or verified delivery report can be verified')
      }
      const at = timestamp()
      this.ensureResultCoverage(current, current.submitted_by ?? actor, current.submitted_at ?? at)
      const criterionUpdates = this.resolveResults(current, criterionInputs, 'criterion', actor, at)
      const deliverableUpdates = this.resolveResults(current, deliverableInputs, 'deliverable', actor, at)
      let changed = false
      for (const result of criterionUpdates.matched) changed = this.upsertResult('criterion', current, result) || changed
      for (const result of deliverableUpdates.matched) changed = this.upsertResult('deliverable', current, result) || changed
      if (!changed) return this.get(id)
      this.db.prepare(`UPDATE delivery_reports SET status='verified', verified_by=?, verified_at=?, updated_at=? WHERE id=?`)
        .run(actor, at, at, id)
      this.appendEvent('delivery.verified', actor, eventScope(current, {
        criterion_ids: criterionUpdates.matched.map((item) => item.id),
        deliverable_ids: deliverableUpdates.matched.map((item) => item.id),
        unmatched_criteria: criterionUpdates.unmatched,
        unmatched_deliverables: deliverableUpdates.unmatched,
      }))
      return this.get(id)
    })
    return verify.immediate()
  }

  accept(id: string, input: AcceptDeliveryInput): DeliveryReport {
    const actor = boundedString(input.actor, 'actor', LIMITS.actor)
    const note = nullableBoundedString(input.note, 'note', LIMITS.note)
    const accept = this.db.transaction(() => {
      const report = this.get(id)
      if (report.status === 'accepted') return report
      if (report.status !== 'verified') throw new ConflictError('only a verified delivery report can be accepted')
      const blockers = acceptanceBlockers(report)
      if (blockers.length) throw new ConflictError(`delivery is not completion-ready: ${blockers.join('; ')}`)
      const at = timestamp()
      this.db.prepare(`UPDATE delivery_reports SET status='accepted', accepted_by=?, acceptance_note=?,
        accepted_at=?, updated_at=? WHERE id=?`).run(actor, note, at, at, id)
      this.appendEvent('delivery.accepted', actor, eventScope(report, { note }))
      return this.get(id)
    })
    return accept.immediate()
  }

  reject(id: string, input: RejectDeliveryInput): DeliveryReport {
    const actor = boundedString(input.actor, 'actor', LIMITS.actor)
    const reason = boundedString(input.reason, 'reason', LIMITS.reason)
    const reject = this.db.transaction(() => {
      const report = this.get(id)
      if (report.status === 'rejected') return report
      if (!['submitted', 'verified'].includes(report.status)) {
        throw new ConflictError('only a submitted or verified delivery report can be rejected')
      }
      const at = timestamp()
      this.db.prepare(`UPDATE delivery_reports SET status='rejected', rejected_by=?, rejection_reason=?,
        rejected_at=?, updated_at=? WHERE id=?`).run(actor, reason, at, at, id)
      this.appendEvent('delivery.rejected', actor, eventScope(report, { reason }))
      return this.get(id)
    })
    return reject.immediate()
  }

  revise(id: string, input: ReviseDeliveryInput = {}): DeliveryReport {
    const actor = boundedString(input.actor ?? 'system', 'actor', LIMITS.actor)
    const revise = this.db.transaction(() => {
      const report = this.get(id)
      const existing = this.db.prepare('SELECT id FROM delivery_reports WHERE parent_report_id=?')
        .get(report.id) as { id: string } | undefined
      if (existing) return this.get(existing.id)
      if (report.status !== 'rejected') throw new ConflictError('only a rejected delivery report can be revised')
      const childId = randomUUID()
      const at = timestamp()
      this.db.prepare(`INSERT INTO delivery_reports
        (id, lineage_id, parent_report_id, sequence, board_id, card_id, job_id, session_id, workspace_id,
         status, asked_snapshot, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)`)
        .run(childId, report.lineage_id, report.id, report.sequence + 1, report.board_id, report.card_id,
          report.job_id, report.session_id, report.workspace_id, JSON.stringify(report.asked), actor, at, at)
      this.appendEvent('delivery.revised', actor, {
        ...eventScope(report),
        delivery_report_id: childId,
        parent_report_id: report.id,
        sequence: report.sequence + 1,
      })
      return this.get(childId)
    })
    return revise.immediate()
  }

  assertReviewReady(cardId: number): DeliveryReport {
    const report = this.currentForCard(cardId)
    if (!report) throw new ConflictError('card has no delivery report')
    if (!['submitted', 'verified'].includes(report.status)) {
      throw new ConflictError('delivery must be submitted before review')
    }
    const missing = reviewCoverageGaps(report)
    if (missing.length) throw new ConflictError(`delivery is not review-ready: ${missing.join('; ')}`)
    return report
  }

  assertCompletionReady(cardId: number): DeliveryReport {
    const report = this.currentForCard(cardId)
    if (!report) throw new ConflictError('card has no delivery report')
    if (report.status !== 'accepted') throw new ConflictError('delivery must be accepted before completion')
    const blockers = acceptanceBlockers(report)
    if (blockers.length) throw new ConflictError(`delivery is not completion-ready: ${blockers.join('; ')}`)
    return report
  }

  renderHuman(idOrReport: string | DeliveryReport): string {
    const report = typeof idOrReport === 'string' ? this.get(idOrReport) : idOrReport
    const asked = report.asked
    const lines = [
      `# Delivery ${humanInline(report.id)}`,
      '',
      `Status: ${report.status}`,
      `Card: ${report.card_id}`,
      `Contract: v${asked.contract_version} (${humanInline(asked.contract_updated_at)})`,
      `Revision: ${report.sequence}`,
      '',
      '## Asked',
      '',
      humanBlock(asked.objective),
      '',
      '### Deliverables',
      ...asked.deliverables.map((item) => `- ${item.required ? '[required]' : '[optional]'} ${humanInline(item.id)} — ${humanInline(item.text)}`),
      '',
      '### Acceptance criteria',
      ...asked.acceptance_criteria.map((item) => `- ${item.required ? '[required]' : '[optional]'} ${humanInline(item.id)} — ${humanInline(item.text)}`),
      '',
      '### Verification commands',
      ...(asked.verify_commands.length ? asked.verify_commands.map((command) => `- ${humanInline(command)}`) : ['- None recorded']),
      '',
      '## Delivered',
      '',
      report.summary ? humanBlock(report.summary) : 'No summary submitted.',
      '',
      '### Items',
      ...report.delivered_items.map((item) => `- [${item.status}] ${humanInline(item.deliverable_id ?? item.id)} — ${humanInline(item.text)}`),
      '',
      '### Claims (not evidence)',
      ...(report.claims.length ? report.claims.map((claim) => `- ${humanInline(claim.text)}`) : ['- None']),
      '',
      '## Verification',
      '',
      ...renderResults('Deliverables', report.deliverable_results),
      '',
      ...renderResults('Acceptance criteria', report.criterion_results),
      '',
      '## Files and commits',
      '',
      ...(report.changed_files.length ? report.changed_files.map((file) => `- file: ${humanInline(file)}`) : ['- No changed files recorded']),
      ...report.commits.map((commit) => `- commit: ${humanInline(commit)}`),
      '',
      '## Gaps',
      '',
      ...(deliveryReportGaps(report).length ? deliveryReportGaps(report).map((gap) => `- ${humanInline(gap)}`) : ['- None']),
      '',
      '## Audit',
      '',
      `Created: ${humanInline(report.created_at)} by ${humanInline(report.created_by)}`,
      ...(report.submitted_at ? [`Submitted: ${humanInline(report.submitted_at)} by ${humanInline(report.submitted_by ?? 'unknown')}`] : []),
      ...(report.verified_at ? [`Verified: ${humanInline(report.verified_at)} by ${humanInline(report.verified_by ?? 'unknown')}`] : []),
      ...(report.accepted_at ? [`Accepted: ${humanInline(report.accepted_at)} by ${humanInline(report.accepted_by ?? 'unknown')}`] : []),
      ...(report.rejected_at ? [`Rejected: ${humanInline(report.rejected_at)} by ${humanInline(report.rejected_by ?? 'unknown')} — ${humanInline(report.rejection_reason ?? '')}`] : []),
    ]
    return lines.join('\n').trimEnd() + '\n'
  }

  private mapReport(row: Record<string, unknown>): DeliveryReport {
    const id = String(row.id)
    const asked = parseJson<DeliveryAskedSnapshot>(row.asked_snapshot, emptyAskedSnapshot())
    return {
      id,
      lineage_id: String(row.lineage_id),
      parent_report_id: nullableRowString(row.parent_report_id),
      sequence: Number(row.sequence),
      board_id: Number(row.board_id),
      card_id: Number(row.card_id),
      job_id: nullableRowString(row.job_id),
      session_id: nullableRowString(row.session_id),
      workspace_id: nullableRowString(row.workspace_id),
      status: String(row.status) as DeliveryStatus,
      asked,
      summary: String(row.summary ?? ''),
      delivered_items: parseJson<DeliveryItem[]>(row.delivered_items, []),
      claims: parseJson<DeliveryClaim[]>(row.claims_json, []),
      changed_files: parseJson<string[]>(row.changed_files, []),
      commits: parseJson<string[]>(row.commits, []),
      artifact_ids: parseJson<string[]>(row.artifact_ids, []),
      gaps: parseJson<string[]>(row.gaps, []),
      deliverable_results: this.deliverableResults(id, asked),
      criterion_results: this.criterionResults(id, asked),
      created_by: String(row.created_by),
      submitted_by: nullableRowString(row.submitted_by),
      verified_by: nullableRowString(row.verified_by),
      accepted_by: nullableRowString(row.accepted_by),
      rejected_by: nullableRowString(row.rejected_by),
      acceptance_note: nullableRowString(row.acceptance_note),
      rejection_reason: nullableRowString(row.rejection_reason),
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
      submitted_at: nullableRowString(row.submitted_at),
      verified_at: nullableRowString(row.verified_at),
      accepted_at: nullableRowString(row.accepted_at),
      rejected_at: nullableRowString(row.rejected_at),
    }
  }

  private deliverableResults(reportId: string, asked: DeliveryAskedSnapshot): DeliveryDeliverableResult[] {
    const rows = this.db.prepare('SELECT * FROM delivery_deliverable_results WHERE report_id=?')
      .all(reportId) as Record<string, unknown>[]
    const byId = new Map(rows.map((row) => [String(row.deliverable_id), row]))
    return asked.deliverables.flatMap((item) => {
      const row = byId.get(item.id)
      return row ? [{ ...mapStoredResult(row), report_id: reportId, deliverable_id: item.id,
        text: item.text, required: item.required }] : []
    })
  }

  private criterionResults(reportId: string, asked: DeliveryAskedSnapshot): DeliveryCriterionResult[] {
    const rows = this.db.prepare('SELECT * FROM delivery_criterion_results WHERE report_id=?')
      .all(reportId) as Record<string, unknown>[]
    const byId = new Map(rows.map((row) => [String(row.criterion_id), row]))
    return asked.acceptance_criteria.flatMap((item) => {
      const row = byId.get(item.id)
      return row ? [{ ...mapStoredResult(row), report_id: reportId, criterion_id: item.id,
        text: item.text, required: item.required }] : []
    })
  }

  private ensureResultCoverage(report: DeliveryReport, actor: string, at: string): void {
    const insertDeliverable = this.db.prepare(`INSERT OR IGNORE INTO delivery_deliverable_results
      (report_id, deliverable_id, outcome, note, evidence_refs, actor, created_at, updated_at)
      VALUES (?, ?, 'unverifiable', NULL, '[]', ?, ?, ?)`)
    for (const deliverable of report.asked.deliverables) insertDeliverable.run(report.id, deliverable.id, actor, at, at)
    const insertCriterion = this.db.prepare(`INSERT OR IGNORE INTO delivery_criterion_results
      (report_id, criterion_id, outcome, note, evidence_refs, actor, created_at, updated_at)
      VALUES (?, ?, 'unverifiable', NULL, '[]', ?, ?, ?)`)
    for (const criterion of report.asked.acceptance_criteria) insertCriterion.run(report.id, criterion.id, actor, at, at)
  }

  private resolveResults(
    report: DeliveryReport,
    inputs: Record<string, unknown>[],
    kind: 'criterion' | 'deliverable',
    actor: string,
    at: string,
  ): { matched: Array<StoredResult & { id: string; actor: string; at: string }>; unmatched: string[] } {
    const subjects = kind === 'criterion' ? report.asked.acceptance_criteria : report.asked.deliverables
    const matched: Array<StoredResult & { id: string; actor: string; at: string }> = []
    const unmatched: string[] = []
    const used = new Set<string>()
    for (const input of inputs) {
      const explicit = nullableBoundedString(kind === 'criterion'
        ? input.criterionId ?? input.criterion_id
        : input.deliverableId ?? input.deliverable_id, `${kind}Id`, LIMITS.id)
      const text = nullableBoundedString(input.text, `${kind}.text`, LIMITS.text)
      let subject: { id: string; text: string } | undefined
      if (explicit) {
        subject = subjects.find((candidate) => candidate.id === explicit)
        if (!subject) throw new ValidationError(`${kind} id is not in the frozen Asked snapshot`)
      } else if (text) {
        const matches = subjects.filter((candidate) => normalizeContractText(candidate.text) === normalizeContractText(text))
        if (matches.length > 1) throw new ValidationError(`${kind} text is ambiguous; use its stable id`)
        subject = matches[0]
        if (!subject) { unmatched.push(text); continue }
      } else {
        throw new ValidationError(`${kind} result requires a stable id or exact text`)
      }
      if (used.has(subject.id)) throw new ValidationError(`${kind} results must not contain duplicate ids`)
      used.add(subject.id)
      const outcome = resultOutcome(input)
      const note = nullableBoundedString(input.note, `${kind}.note`, LIMITS.note)
      const evidenceRaw = input.evidenceRefs ?? input.evidence_refs ?? input.evidence ?? []
      const evidence = Array.isArray(evidenceRaw) ? evidenceRaw : [evidenceRaw]
      const evidenceRefs = this.evidenceReferences(report, evidence)
      const override = normalizeOverride(input.override, outcome, at, input.outcome === 'overridden')
      matched.push({ id: subject.id, outcome, note, evidence_refs: evidenceRefs, override, actor, at })
    }
    return { matched, unmatched }
  }

  private upsertResult(
    kind: 'criterion' | 'deliverable',
    report: DeliveryReport,
    result: StoredResult & { id: string; actor: string; at: string },
  ): boolean {
    const current = kind === 'criterion'
      ? report.criterion_results.find((item) => item.criterion_id === result.id)
      : report.deliverable_results.find((item) => item.deliverable_id === result.id)
    if (current && storedResultEqual(current, result)) return false
    if (current?.override) {
      if (immutableOverrideResultEqual(current, result)) return false
      throw new ConflictError(`audited ${kind} override is immutable; revise the delivery report to replace it`)
    }
    const table = kind === 'criterion' ? 'delivery_criterion_results' : 'delivery_deliverable_results'
    const idColumn = kind === 'criterion' ? 'criterion_id' : 'deliverable_id'
    this.db.prepare(`INSERT INTO ${table}
      (report_id, ${idColumn}, outcome, note, evidence_refs, override_actor, override_reason, override_at,
       actor, created_at, updated_at)
      VALUES (@report_id, @subject_id, @outcome, @note, @evidence_refs, @override_actor, @override_reason,
       @override_at, @actor, @at, @at)
      ON CONFLICT(report_id, ${idColumn}) DO UPDATE SET outcome=excluded.outcome, note=excluded.note,
        evidence_refs=excluded.evidence_refs, override_actor=excluded.override_actor,
        override_reason=excluded.override_reason, override_at=excluded.override_at,
        actor=excluded.actor, updated_at=excluded.updated_at`).run({
      report_id: report.id,
      subject_id: result.id,
      outcome: result.outcome,
      note: result.note,
      evidence_refs: JSON.stringify(result.evidence_refs),
      override_actor: result.override?.actor ?? null,
      override_reason: result.override?.reason ?? null,
      override_at: result.override?.at ?? null,
      actor: result.actor,
      at: result.at,
    })
    return true
  }

  private evidenceReferences(report: DeliveryReport, input: unknown[]): EvidenceReference[] {
    if (input.length > LIMITS.references) throw new ValidationError(`evidenceRefs accepts at most ${LIMITS.references} items`)
    const normalized: EvidenceReference[] = []
    for (const raw of input) {
      let kind: EvidenceReferenceKind
      let ref: string
      let label: string | null = null
      if (typeof raw === 'string') {
        const parsed = parseReference(raw, report.artifact_ids)
        kind = parsed.kind
        ref = parsed.ref
      } else if (isRecord(raw)) {
        if (typeof raw.artifact_id === 'string' && raw.ref === undefined) {
          kind = 'artifact'
          ref = boundedString(raw.artifact_id, 'evidence.ref', LIMITS.reference)
        } else {
          ref = boundedString(raw.ref, 'evidence.ref', LIMITS.reference)
          kind = raw.kind === undefined ? inferReferenceKind(ref, report.artifact_ids) : evidenceKind(raw.kind)
        }
        label = nullableBoundedString(raw.label, 'evidence.label', LIMITS.label)
      } else {
        throw new ValidationError('evidence references must be strings or objects')
      }
      this.assertEvidenceScope(report, { kind, ref, label })
      const item = { kind, ref, label }
      if (!normalized.some((candidate) => stableJson(candidate) === stableJson(item))) normalized.push(item)
    }
    return normalized
  }

  private assertEvidenceScope(report: DeliveryReport, evidence: EvidenceReference): void {
    if (evidence.kind === 'artifact') {
      this.assertArtifactScope(report, evidence.ref)
      return
    }
    if (evidence.kind === 'event') {
      const row = this.db.prepare('SELECT board_id, card_id, workspace_id FROM os_events WHERE id=?').get(evidence.ref) as
        { board_id: number; card_id: number | null; workspace_id: string | null } | undefined
      if (!row) throw new NotFoundError('evidence event not found')
      if (!evidenceScopeMatches(report, row)) {
        throw new ValidationError('evidence event belongs to a different delivery scope')
      }
      return
    }
    if (evidence.kind === 'process') {
      const row = this.db.prepare(`SELECT w.board_id, w.card_id, p.workspace_id FROM processes p
        JOIN workspaces w ON w.id=p.workspace_id WHERE p.id=?`).get(evidence.ref) as
        { board_id: number; card_id: number | null; workspace_id: string } | undefined
      if (!row) throw new NotFoundError('evidence process not found')
      if (!evidenceScopeMatches(report, row)) {
        throw new ValidationError('evidence process belongs to a different delivery scope')
      }
      return
    }
    if (evidence.kind === 'commit' && !/^[a-fA-F0-9]{4,64}$/.test(evidence.ref)) {
      throw new ValidationError('commit evidence must be a hexadecimal git object id')
    }
    if (evidence.kind === 'url') {
      let url: URL
      try { url = new URL(evidence.ref) } catch { throw new ValidationError('URL evidence must be a valid URL') }
      if (!['http:', 'https:'].includes(url.protocol)) throw new ValidationError('URL evidence must use http or https')
    }
  }

  private assertArtifactScope(report: DeliveryReport, artifactId: string): void {
    const row = this.db.prepare('SELECT board_id, card_id, workspace_id FROM artifacts WHERE id=?').get(artifactId) as
      { board_id: number; card_id: number | null; workspace_id: string | null } | undefined
    if (!row) throw new NotFoundError('artifact not found')
    if (!evidenceScopeMatches(report, row)) {
      throw new ValidationError('artifact belongs to a different delivery scope')
    }
  }

  private appendEvent(kind: string, actor: string, payload: Record<string, unknown>): void {
    this.events.append({
      boardId: Number(payload.board_id),
      cardId: Number(payload.card_id),
      workspaceId: nullableRowString(payload.workspace_id),
      sessionId: nullableRowString(payload.session_id),
      kind,
      source: 'delivery',
      payload: { ...payload, actor, causation_id: payload.job_id ?? payload.parent_report_id ?? payload.card_id },
    })
  }

  private card(cardId: number): ScopeRow {
    const row = this.db.prepare('SELECT id, board_id FROM cards WHERE id=?').get(cardId) as ScopeRow | undefined
    if (!row) throw new NotFoundError('card not found')
    return row
  }

  private job(jobId: string): JobScopeRow {
    const row = this.db.prepare('SELECT id, board_id, card_id, workspace_id FROM jobs WHERE id=?').get(jobId) as JobScopeRow | undefined
    if (!row) throw new NotFoundError('job not found')
    return row
  }

  private session(sessionId: string): SessionScopeRow {
    const row = this.db.prepare('SELECT id, workspace_id, context_json FROM agent_sessions WHERE id=?')
      .get(sessionId) as SessionScopeRow | undefined
    if (!row) throw new NotFoundError('session not found')
    return row
  }

  private workspace(workspaceId: string): WorkspaceScopeRow {
    const row = this.db.prepare('SELECT id, board_id, card_id FROM workspaces WHERE id=?')
      .get(workspaceId) as WorkspaceScopeRow | undefined
    if (!row) throw new NotFoundError('workspace not found')
    return row
  }

  private sessionForJob(jobId: string): SessionScopeRow | null {
    const row = this.db.prepare(`SELECT id, workspace_id, context_json FROM agent_sessions
      WHERE CASE WHEN json_valid(context_json)
        THEN json_extract(context_json, '$.job_id')=? ELSE 0 END
      ORDER BY updated_at DESC, rowid DESC LIMIT 1`).get(jobId) as SessionScopeRow | undefined
    return row ?? null
  }
}

export function deliveryReportGaps(report: DeliveryReport): string[] {
  const gaps = new Set(report.gaps)
  if (report.status === 'draft') gaps.add('Delivery has not been submitted.')
  for (const deliverable of report.asked.deliverables) {
    const item = report.delivered_items.find((candidate) => candidate.deliverable_id === deliverable.id)
    if (!item) gaps.add(`Deliverable ${deliverable.id} is not represented in Delivered items.`)
    else if (item.status !== 'delivered') gaps.add(`Deliverable ${deliverable.id} is ${item.status}.`)
    const result = report.deliverable_results.find((candidate) => candidate.deliverable_id === deliverable.id)
    addResultGap(gaps, 'Deliverable', deliverable.id, result)
  }
  for (const criterion of report.asked.acceptance_criteria) {
    const result = report.criterion_results.find((candidate) => candidate.criterion_id === criterion.id)
    addResultGap(gaps, 'Criterion', criterion.id, result)
  }
  return [...gaps]
}

function snapshotContract(contract: TaskContract): DeliveryAskedSnapshot {
  return {
    objective: contract.objective,
    deliverables: structuredClone(contract.deliverables),
    acceptance_criteria: structuredClone(contract.acceptance_criteria),
    verify_commands: [...contract.verify_commands],
    non_goals: [...contract.non_goals],
    risks: [...contract.risks],
    dependencies: [...contract.dependencies],
    base_ref: contract.base_ref,
    budget_tokens: contract.budget_tokens,
    budget_cents: contract.budget_cents,
    priority: contract.priority,
    policy_id: contract.policy_id,
    contract_version: contract.version,
    contract_updated_at: contract.updated_at,
  }
}

function emptyAskedSnapshot(): DeliveryAskedSnapshot {
  return {
    objective: '', deliverables: [], acceptance_criteria: [], verify_commands: [], non_goals: [], risks: [],
    dependencies: [], base_ref: null, budget_tokens: null, budget_cents: null, priority: 0, policy_id: null,
    contract_version: 0, contract_updated_at: '',
  }
}

function mapStoredResult(row: Record<string, unknown>) {
  const override = row.override_actor == null ? null : {
    actor: String(row.override_actor), reason: String(row.override_reason), at: String(row.override_at),
  }
  return {
    outcome: String(row.outcome) as CriterionOutcome,
    effective_outcome: override ? 'overridden' as const : String(row.outcome) as CriterionOutcome,
    note: nullableRowString(row.note),
    evidence_refs: parseJson<EvidenceReference[]>(row.evidence_refs, []),
    override,
    actor: String(row.actor),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  }
}

function normalizeDeliveredItems(report: DeliveryReport, input: Array<string | DeliveryItemInput>): DeliveryItem[] {
  if (!Array.isArray(input) || input.length > LIMITS.items) {
    throw new ValidationError(`deliveredItems accepts at most ${LIMITS.items} items`)
  }
  const byDeliverable = new Map<string, DeliveryItem>()
  const extras: DeliveryItem[] = []
  for (const raw of input) {
    if (typeof raw !== 'string' && !isRecord(raw)) throw new ValidationError('deliveredItems must contain strings or objects')
    const object = typeof raw === 'string' ? null : raw
    const explicit = nullableBoundedString(object?.deliverableId ?? object?.deliverable_id,
      'deliveredItem.deliverableId', LIMITS.id)
    const rawText = typeof raw === 'string' ? raw : object?.text
    const text = nullableBoundedString(rawText, 'deliveredItem.text', LIMITS.text)
    let deliverable: ContractDeliverable | undefined
    if (explicit) {
      deliverable = report.asked.deliverables.find((candidate) => candidate.id === explicit)
      if (!deliverable) throw new ValidationError('delivered item references an unknown Asked deliverable')
    } else if (text) {
      const matches = report.asked.deliverables.filter((candidate) => normalizeContractText(candidate.text) === normalizeContractText(text))
      if (matches.length > 1) throw new ValidationError('delivered item text is ambiguous; use its stable deliverable id')
      deliverable = matches[0]
    }
    const itemText = text ?? deliverable?.text
    if (!itemText) throw new ValidationError('deliveredItem.text is required for an extra item')
    const status = deliveryItemStatus(object?.status)
    const id = object?.id === undefined
      ? entityId('delivery-item', report.id, deliverable?.id ?? itemText)
      : stableIdentifier(object.id, 'deliveredItem.id')
    const item = { id, deliverable_id: deliverable?.id ?? null, text: itemText, status }
    if (deliverable) {
      if (byDeliverable.has(deliverable.id)) throw new ValidationError('each Asked deliverable may appear only once')
      byDeliverable.set(deliverable.id, item)
    } else {
      extras.push(item)
    }
  }
  const promised = report.asked.deliverables.map((deliverable) => byDeliverable.get(deliverable.id) ?? ({
    id: entityId('delivery-item', report.id, deliverable.id),
    deliverable_id: deliverable.id,
    text: deliverable.text,
    status: 'omitted' as const,
  }))
  return [...promised, ...extras]
}

function normalizeClaims(report: DeliveryReport, input: Array<string | DeliveryClaimInput>): DeliveryClaim[] {
  if (!Array.isArray(input) || input.length > LIMITS.claims) {
    throw new ValidationError(`claims accepts at most ${LIMITS.claims} items`)
  }
  const claims: DeliveryClaim[] = []
  for (const raw of input) {
    if (typeof raw !== 'string' && !isRecord(raw)) throw new ValidationError('claims must contain strings or objects')
    const object = typeof raw === 'string' ? null : raw
    const text = boundedString(typeof raw === 'string' ? raw : object?.text, 'claim.text', LIMITS.text)
    const criterionId = nullableBoundedString(object?.criterionId ?? object?.criterion_id, 'claim.criterionId', LIMITS.id)
    const deliverableId = nullableBoundedString(object?.deliverableId ?? object?.deliverable_id, 'claim.deliverableId', LIMITS.id)
    if (criterionId && !report.asked.acceptance_criteria.some((item) => item.id === criterionId)) {
      throw new ValidationError('claim references an unknown Asked criterion')
    }
    if (deliverableId && !report.asked.deliverables.some((item) => item.id === deliverableId)) {
      throw new ValidationError('claim references an unknown Asked deliverable')
    }
    const id = object?.id === undefined
      ? entityId('delivery-claim', report.id, `${criterionId ?? ''}:${deliverableId ?? ''}:${text}`)
      : stableIdentifier(object.id, 'claim.id')
    const claim = { id, text, criterion_id: criterionId, deliverable_id: deliverableId }
    if (!claims.some((candidate) => candidate.id === id)) claims.push(claim)
  }
  return claims
}

function reviewCoverageGaps(report: DeliveryReport): string[] {
  const gaps: string[] = []
  if (!report.summary.trim()) gaps.push('summary is missing')
  for (const deliverable of report.asked.deliverables) {
    if (!report.delivered_items.some((item) => item.deliverable_id === deliverable.id)) {
      gaps.push(`deliverable ${deliverable.id} is missing from Delivered items`)
    }
    if (!report.deliverable_results.some((item) => item.deliverable_id === deliverable.id)) {
      gaps.push(`deliverable ${deliverable.id} has no outcome row`)
    }
  }
  for (const criterion of report.asked.acceptance_criteria) {
    if (!report.criterion_results.some((item) => item.criterion_id === criterion.id)) {
      gaps.push(`criterion ${criterion.id} has no outcome row`)
    }
  }
  return gaps
}

function acceptanceBlockers(report: DeliveryReport): string[] {
  const blockers = reviewCoverageGaps(report)
  for (const deliverable of report.asked.deliverables.filter((item) => item.required)) {
    const item = report.delivered_items.find((candidate) => candidate.deliverable_id === deliverable.id)
    const result = report.deliverable_results.find((candidate) => candidate.deliverable_id === deliverable.id)
    if (!result || (result.outcome !== 'met' && !result.override)) {
      blockers.push(`required deliverable ${deliverable.id} is not met or overridden`)
      continue
    }
    if (!result.override && item?.status !== 'delivered') {
      blockers.push(`required deliverable ${deliverable.id} is not recorded as delivered`)
    }
    if (!result.override && !result.evidence_refs.length) {
      blockers.push(`required deliverable ${deliverable.id} has no evidence`)
    }
  }
  for (const criterion of report.asked.acceptance_criteria.filter((item) => item.required)) {
    const result = report.criterion_results.find((candidate) => candidate.criterion_id === criterion.id)
    if (!result || (result.outcome !== 'met' && !result.override)) {
      blockers.push(`required criterion ${criterion.id} is not met or overridden`)
      continue
    }
    if (!result.override && !result.evidence_refs.length) blockers.push(`required criterion ${criterion.id} has no evidence`)
  }
  return [...new Set(blockers)]
}

function addResultGap(
  gaps: Set<string>,
  label: string,
  id: string,
  result: { outcome: CriterionOutcome; evidence_refs: EvidenceReference[]; override: DeliveryOverride | null } | undefined,
): void {
  if (!result) { gaps.add(`${label} ${id} has no outcome.`); return }
  if (result.outcome !== 'met' && !result.override) gaps.add(`${label} ${id} is ${result.outcome}.`)
  if (result.outcome === 'met' && !result.override && !result.evidence_refs.length) gaps.add(`${label} ${id} has no evidence.`)
}

function resultOutcome(input: Record<string, unknown>): CriterionOutcome {
  const raw = input.outcome ?? (input.met === true ? 'met' : input.met === false ? 'missed' : input.met)
  if (raw === 'overridden') {
    const original = input.originalOutcome ?? input.original_outcome
    if (!['partial', 'missed', 'unverifiable'].includes(String(original))) {
      throw new ValidationError('overridden compatibility input requires originalOutcome partial, missed, or unverifiable')
    }
    return String(original) as CriterionOutcome
  }
  if (!['met', 'partial', 'missed', 'unverifiable'].includes(String(raw))) {
    throw new ValidationError('result outcome must be met, partial, missed, or unverifiable')
  }
  return String(raw) as CriterionOutcome
}

function normalizeOverride(
  value: unknown,
  outcome: CriterionOutcome,
  at: string,
  compatibilityOverride: boolean,
): DeliveryOverride | null {
  if (value === undefined || value === null) {
    if (compatibilityOverride) throw new ValidationError('overridden outcomes require an override audit object')
    return null
  }
  if (outcome === 'met') throw new ValidationError('a met outcome does not need an override')
  if (!isRecord(value)) throw new ValidationError('override must be an audit object')
  return {
    actor: boundedString(value.actor, 'override.actor', LIMITS.actor),
    reason: boundedString(value.reason, 'override.reason', LIMITS.reason),
    at: value.at === undefined ? at : isoTimestamp(value.at, 'override.at'),
  }
}

function parseReference(raw: string, artifactIds: string[]): EvidenceReference {
  const value = boundedString(raw, 'evidence.ref', LIMITS.reference)
  const prefixed = /^(artifact|event|process|commit|url|other):(.*)$/s.exec(value)
  if (prefixed) return { kind: prefixed[1] as EvidenceReferenceKind,
    ref: boundedString(prefixed[2], 'evidence.ref', LIMITS.reference), label: null }
  return { kind: inferReferenceKind(value, artifactIds), ref: value, label: null }
}

function inferReferenceKind(ref: string, artifactIds: string[]): EvidenceReferenceKind {
  if (artifactIds.includes(ref)) return 'artifact'
  if (/^https?:\/\//i.test(ref)) return 'url'
  return 'other'
}

function evidenceKind(value: unknown): EvidenceReferenceKind {
  if (!['artifact', 'event', 'process', 'commit', 'url', 'other'].includes(String(value))) {
    throw new ValidationError('evidence.kind is invalid')
  }
  return String(value) as EvidenceReferenceKind
}

function deliveryItemStatus(value: unknown): DeliveryItemStatus {
  if (value === undefined) return 'delivered'
  if (!['delivered', 'partial', 'omitted'].includes(String(value))) {
    throw new ValidationError('deliveredItem.status must be delivered, partial, or omitted')
  }
  return String(value) as DeliveryItemStatus
}

function eventScope(report: DeliveryReport, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    delivery_report_id: report.id,
    lineage_id: report.lineage_id,
    parent_report_id: report.parent_report_id,
    sequence: report.sequence,
    board_id: report.board_id,
    card_id: report.card_id,
    job_id: report.job_id,
    session_id: report.session_id,
    workspace_id: report.workspace_id,
    contract_version: report.asked.contract_version,
    ...extra,
  }
}

function storedResultEqual(
  current: { outcome: CriterionOutcome; note: string | null; evidence_refs: EvidenceReference[]; override: DeliveryOverride | null },
  next: StoredResult,
): boolean {
  return current.outcome === next.outcome && current.note === next.note
    && stableJson(current.evidence_refs) === stableJson(next.evidence_refs)
    && stableJson(current.override) === stableJson(next.override)
}

function immutableOverrideResultEqual(
  current: { outcome: CriterionOutcome; note: string | null; evidence_refs: EvidenceReference[]; override: DeliveryOverride | null },
  next: StoredResult,
): boolean {
  return !!current.override && !!next.override && current.outcome === next.outcome && current.note === next.note
    && stableJson(current.evidence_refs) === stableJson(next.evidence_refs)
    && current.override.actor === next.override.actor && current.override.reason === next.override.reason
}

function evidenceScopeMatches(
  report: DeliveryReport,
  row: { board_id: number; card_id: number | null; workspace_id: string | null },
): boolean {
  if (row.board_id !== report.board_id) return false
  if (row.card_id === report.card_id) return true
  return report.workspace_id != null && row.workspace_id === report.workspace_id
}

function renderResults(
  heading: string,
  results: Array<DeliveryDeliverableResult | DeliveryCriterionResult>,
): string[] {
  return [
    `### ${heading}`,
    ...(results.length ? results.map((result) => {
      const id = 'criterion_id' in result ? result.criterion_id : result.deliverable_id
      const evidence = result.evidence_refs.length
        ? `; evidence: ${result.evidence_refs.map((item) => `${item.kind}:${humanInline(item.ref)}`).join(', ')}` : '; evidence: none'
      const override = result.override
        ? `; override: ${humanInline(result.override.actor)} — ${humanInline(result.override.reason)} at ${humanInline(result.override.at)}` : ''
      const state = result.override ? `${result.outcome}; overridden` : result.outcome
      return `- [${state}] ${humanInline(id)} — ${humanInline(result.text)}${evidence}${override}`
    }) : ['- No outcomes recorded']),
  ]
}

function boundedObjectArray(value: unknown, field: string, max: number): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length > max || value.some((item) => !isRecord(item))) {
    throw new ValidationError(`${field} must be an array of at most ${max} objects`)
  }
  return value
}

function boundedStringArray(value: unknown, field: string, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new ValidationError(`${field} must be an array of at most ${maxItems} strings`)
  }
  const result: string[] = []
  for (const item of value) {
    const normalized = boundedString(item, field, maxLength)
    if (!result.includes(normalized)) result.push(normalized)
  }
  return result
}

function boundedString(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || !value.trim()) throw new ValidationError(`${field} is required`)
  if (value.length > max) throw new ValidationError(`${field} must be at most ${max} characters`)
  return value.trim()
}

function nullableBoundedString(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') throw new ValidationError(`${field} must be a string or null`)
  if (value.length > max) throw new ValidationError(`${field} must be at most ${max} characters`)
  return value.trim() || null
}

function stableIdentifier(value: unknown, field: string): string {
  const id = boundedString(value, field, LIMITS.id)
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/.test(id)) throw new ValidationError(`${field} must be a stable identifier`)
  return id
}

function isoTimestamp(value: unknown, field: string): string {
  const at = boundedString(value, field, 100)
  if (Number.isNaN(Date.parse(at))) throw new ValidationError(`${field} must be an ISO timestamp`)
  return at
}

function entityId(prefix: string, reportId: string, value: string): string {
  return `${prefix}-${createHash('sha256').update(`${reportId}:${normalizeContractText(value)}`).digest('hex').slice(0, 16)}`
}

function positiveCardId(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new ValidationError('cardId must be a positive integer')
}

function nullableRowString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value)
}

function jsonString(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

function humanInline(value: string): string {
  return safeHuman(value).replace(/\s+/g, ' ').trim()
}

function humanBlock(value: string): string {
  return safeHuman(value).trim()
}

function safeHuman(value: string): string {
  return value
    .replace(/\u001B(?:[@-_][0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '')
}
