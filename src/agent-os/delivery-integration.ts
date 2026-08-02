import type Database from 'better-sqlite3'
import { execFileSync } from 'node:child_process'
import { DeliveryReportService, type DeliveryReport } from './delivery-reports.js'
import { EvidenceService } from './evidence.js'
import { ConflictError } from './errors.js'
import { EventStore } from './event-store.js'

export interface ReviewDeliveryInput {
  cardId: number
  actor: string
  summary?: string | null
}

export interface RuntimeDeliveryInput extends ReviewDeliveryInput {
  jobId: string
  sessionId: string
  workspaceId?: string | null
  provider: string
}

/**
 * Compatibility glue around the canonical delivery state machine.
 *
 * Transition rules stay inside DeliveryReportService. This adapter only decides
 * when legacy review actions need a compatibility report and when canonical jobs
 * must be held to their already-prepared report.
 */
export class DeliveryLifecycleIntegration {
  readonly reports: DeliveryReportService
  private readonly evidence: EvidenceService
  private readonly events: EventStore

  constructor(private readonly db: Database.Database) {
    this.events = new EventStore(db)
    this.reports = new DeliveryReportService(db, this.events)
    this.evidence = new EvidenceService(db)
  }

  isManagedCard(cardId: number): boolean {
    return !!this.db.prepare('SELECT 1 FROM jobs WHERE card_id=? LIMIT 1').get(cardId)
  }

  ensureReviewReady(input: ReviewDeliveryInput): DeliveryReport {
    const managedJob = this.managedJob(input.cardId)
    const managed = !!managedJob
    let delivery = managedJob
      ? this.reports.currentForJob(managedJob.id)
      : this.reports.currentForCard(input.cardId)
    let historicalCompatibility = false
    if (!delivery) {
      if (managedJob && !['succeeded', 'blocked', 'cancelled'].includes(managedJob.status)) {
        throw new ConflictError('active canonical job is missing its prepared delivery report')
      }
      historicalCompatibility = !!managedJob
      delivery = this.reports.createForCard(input.cardId, managedJob
        ? { jobId: managedJob.id, actor: 'compatibility-upgrade' }
        : { actor: input.actor })
    } else if (delivery.status === 'accepted') {
      if (managed) throw new ConflictError('accepted canonical delivery cannot re-enter review without a new job')
      delivery = this.reports.createForCard(input.cardId, { actor: input.actor })
    } else if (delivery.status === 'rejected') {
      delivery = this.reports.revise(delivery.id, { actor: input.actor })
    }

    if (delivery.status === 'draft') {
      if (managed && !historicalCompatibility && delivery.created_by !== 'compatibility-upgrade') {
        throw new ConflictError('canonical delivery report must be submitted before moving the card to review')
      }
      delivery = this.submitCompatibility(delivery, input)
    }
    return managedJob
      ? this.reports.assertJobReviewReady(managedJob.id)
      : this.reports.assertReviewReady(input.cardId)
  }

  assertDoneReady(cardId: number): DeliveryReport | null {
    const managedJob = this.managedJob(cardId)
    if (!managedJob) return null
    return this.reports.assertJobCompletionReady(managedJob.id)
  }

  recordVerification(
    input: ReviewDeliveryInput & { results: unknown[] },
  ): DeliveryReport {
    const delivery = this.ensureReviewReady(input)
    return this.reports.verify(delivery.id, {
      actor: input.actor,
      results: input.results as any,
    })
  }

  accept(input: ReviewDeliveryInput & { confirmed?: boolean }): DeliveryReport | null {
    const managedJob = this.managedJob(input.cardId)
    const managed = !!managedJob
    let delivery = managedJob
      ? this.reports.currentForJob(managedJob.id)
      : this.reports.currentForCard(input.cardId)
    if (!delivery) {
      delivery = this.ensureReviewReady(input)
    }

    // A legacy human approval is itself the compatibility attestation. Canonical
    // gaps require the explicit confirm flag and always retain the override reason.
    if (!managed || delivery.created_by === 'compatibility-upgrade' || input.confirmed) {
      const reason = input.summary?.trim()
        || (managed
          ? 'Explicit approval confirmation over failed verification'
          : 'Human approval of compatibility delivery')
      delivery = this.overrideOpenRows(delivery, input.actor, reason)
    }
    return this.reports.accept(delivery.id, { actor: input.actor, note: input.summary ?? undefined })
  }

  reject(input: ReviewDeliveryInput & { reason: string }): DeliveryReport | null {
    const managedJob = this.managedJob(input.cardId)
    let delivery = managedJob
      ? this.reports.currentForJob(managedJob.id)
      : this.reports.currentForCard(input.cardId)
    if (!delivery) {
      delivery = this.ensureReviewReady(input)
    }
    return this.reports.reject(delivery.id, { actor: input.actor, reason: input.reason })
  }

  completeRuntime(input: RuntimeDeliveryInput): DeliveryReport {
    let delivery = this.reports.prepareForJob(input.jobId)
    const summary = concise(input.summary) || `Provider ${input.provider} completed job ${input.jobId}.`
    const sourceCommit = this.citedBranchCommit(input.cardId)

    if (!this.runtimeEvidence(input.jobId)) {
      const capture = this.db.transaction(() => {
        this.events.append({
          boardId: this.boardId(input.cardId),
          workspaceId: input.workspaceId,
          cardId: input.cardId,
          sessionId: input.sessionId,
          kind: 'delivery.agent_claim',
          source: input.provider,
          payload: { claim: summary, job_id: input.jobId, delivery_id: delivery.id },
        })
        const persisted = this.evidence.persist(input.cardId)
        this.events.append({
          boardId: this.boardId(input.cardId),
          workspaceId: input.workspaceId,
          cardId: input.cardId,
          sessionId: input.sessionId,
          kind: 'delivery.runtime_evidence',
          source: 'runtime',
          payload: { job_id: input.jobId, delivery_id: delivery.id, artifact_id: persisted.artifact.id },
        })
        return persisted
      })()
      if (delivery.status === 'draft') {
        delivery = this.reports.submit(delivery.id, {
          actor: 'runtime',
          summary,
          claims: [summary],
          artifactIds: [capture.artifact.id],
          changedFiles: capture.evidence.changed_files,
          commits: sourceCommit ? [sourceCommit] : [],
          gaps: [
            ...capture.evidence.gaps,
            'The provider did not submit a structured delivery report; its final output is retained as an unverified claim.',
          ],
        })
      }
    } else if (delivery.status === 'draft') {
      const evidence = this.runtimeEvidence(input.jobId)!
      delivery = this.reports.submit(delivery.id, {
        actor: 'runtime',
        summary,
        claims: [summary],
        artifactIds: evidence.artifactId ? [evidence.artifactId] : [],
        commits: sourceCommit ? [sourceCommit] : [],
        gaps: ['The provider did not submit a structured delivery report; its final output is retained as an unverified claim.'],
      })
    }

    if (delivery.status === 'accepted') return delivery
    return this.reports.assertJobReviewReady(input.jobId)
  }

  private submitCompatibility(delivery: DeliveryReport, input: ReviewDeliveryInput): DeliveryReport {
    const persisted = this.evidence.persist(input.cardId)
    const summary = concise(input.summary) || 'Card was submitted through the compatibility review flow.'
    const sourceCommit = this.citedBranchCommit(input.cardId)
    return this.reports.submit(delivery.id, {
      actor: input.actor,
      summary,
      claims: input.summary?.trim() ? [input.summary.trim()] : [],
      artifactIds: [persisted.artifact.id],
      changedFiles: persisted.evidence.changed_files,
      commits: sourceCommit ? [sourceCommit] : [],
      gaps: persisted.evidence.gaps,
    })
  }

  private citedBranchCommit(cardId: number): string | null {
    const row = this.db.prepare(`SELECT cards.branch, boards.project_path
      FROM cards JOIN boards ON boards.id=cards.board_id
      WHERE cards.id=?`).get(cardId) as {
        branch: string | null
        project_path: string
      } | undefined
    if (!row?.branch) return null
    try {
      execFileSync('git', ['check-ref-format', '--branch', row.branch], {
        cwd: row.project_path,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      const commit = execFileSync(
        'git',
        ['rev-parse', '--verify', `refs/heads/${row.branch}^{commit}`],
        { cwd: row.project_path, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      ).trim()
      return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit) ? commit : null
    } catch {
      return null
    }
  }

  private overrideOpenRows(delivery: DeliveryReport, actor: string, reason: string): DeliveryReport {
    const report = delivery as DeliveryReport & {
      criterion_results?: Array<Record<string, any>>
      deliverable_results?: Array<Record<string, any>>
    }
    const evidenceRef = { kind: 'other' as const, ref: `human-override:${delivery.id}`, label: reason }
    const criteria = (report.criterion_results ?? [])
      .filter((row) => !rowReady(row))
      .map((row) => overrideResult(row, 'criterionId', String(row.criterion_id), actor, reason, evidenceRef))
    const deliverables = (report.deliverable_results ?? [])
      .filter((row) => !rowReady(row))
      .map((row) => overrideResult(row, 'deliverableId', String(row.deliverable_id), actor, reason, evidenceRef))
    if (!criteria.length && !deliverables.length) {
      return delivery.status === 'submitted'
        ? this.reports.verify(delivery.id, { actor, results: [], deliverableResults: [] })
        : delivery
    }
    return this.reports.verify(delivery.id, {
      actor,
      results: criteria,
      deliverableResults: deliverables,
    })
  }

  private runtimeEvidence(jobId: string): { artifactId: string | null } | null {
    const row = this.db.prepare(`SELECT payload FROM os_events
      WHERE kind='delivery.runtime_evidence'
        AND json_valid(payload) AND json_extract(payload, '$.job_id')=?
      ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(jobId) as { payload: string } | undefined
    if (!row) return null
    try {
      const payload = JSON.parse(row.payload) as Record<string, unknown>
      return { artifactId: typeof payload.artifact_id === 'string' ? payload.artifact_id : null }
    } catch {
      return { artifactId: null }
    }
  }

  private boardId(cardId: number): number {
    return Number((this.db.prepare('SELECT board_id FROM cards WHERE id=?').get(cardId) as { board_id: number }).board_id)
  }

  private managedJob(cardId: number): { id: string; status: string } | null {
    return this.db.prepare(`SELECT id, status FROM jobs WHERE card_id=?
      ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(cardId) as { id: string; status: string } | undefined ?? null
  }
}

function concise(value: string | null | undefined): string {
  const normalized = value?.replace(/\s+/g, ' ').trim() ?? ''
  return normalized.length > 4_000 ? `${normalized.slice(0, 3_997)}...` : normalized
}

function rowReady(row: Record<string, any>): boolean {
  const evidence = Array.isArray(row.evidence_refs) && row.evidence_refs.length > 0
  if (!evidence) return false
  if (row.outcome === 'met') return true
  return row.effective_outcome === 'overridden' && !!row.override
}

function overrideResult(
  row: Record<string, any>,
  idField: 'criterionId' | 'deliverableId',
  id: string,
  actor: string,
  reason: string,
  evidenceRef: { kind: 'other'; ref: string; label: string },
): Record<string, unknown> {
  const evidenceRefs = [...(Array.isArray(row.evidence_refs) ? row.evidence_refs : []), evidenceRef]
  if (row.outcome === 'met') {
    return { [idField]: id, outcome: 'met', note: row.note ?? reason, evidenceRefs }
  }
  const outcome = ['partial', 'missed', 'unverifiable'].includes(String(row.outcome))
    ? row.outcome
    : ['partial', 'missed', 'unverifiable'].includes(String(row.original_outcome))
      ? row.original_outcome
      : 'unverifiable'
  return {
    [idField]: id,
    outcome,
    note: row.note ?? reason,
    evidenceRefs,
    override: { actor, reason },
  }
}
