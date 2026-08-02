import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import type Database from 'better-sqlite3'
import type { ActorIdentity } from './agent-home-support.js'
import { DeliveryReportService, deliveryReportGaps, type DeliveryReport } from './delivery-reports.js'
import { ConflictError, NotFoundError, ValidationError } from './errors.js'
import { EventStore } from './event-store.js'
import { parseJson, timestamp } from './json.js'
import { redactSensitiveText, redactStructuredValue } from './structured-redaction.js'

const MAX = Object.freeze({
  actor: 320,
  command: 32_000,
  cwd: 4_096,
  environmentEntries: 128,
  environmentValue: 8_192,
  idempotencyKey: 512,
  locator: 4_096,
  text: 20_000,
  attestations: 200,
  list: 200,
})

const SENSITIVE_ENV_KEY = /(?:^|_)(?:authorization|cookie|credential|password|passwd|private|secret|session|token)(?:_|$)/i
const HEX_SHA256 = /^[a-f0-9]{64}$/
const FULL_GIT_COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i

export type DeliveryTrackbookFilter =
  | 'all'
  | 'awaiting_review'
  | 'evidence_gaps'
  | 'rejected'
  | 'overridden'
  | 'shipped'

export interface DeliveryVerificationRun {
  id: string
  report_id: string
  command: string
  cwd: string
  environment: Record<string, string>
  environment_sha256: string
  exit_code: number
  output_artifact_id: string
  output_sha256: string
  started_at: string
  finished_at: string
  recorded_by: string
  idempotency_key: string
  request_sha256: string
  created_at: string
}

export interface DeliveryArtifactAttestation {
  id: string
  report_id: string
  artifact_id: string
  content_sha256: string
  byte_size: number
  source_kind: 'inline' | 'file' | 'command_output' | 'external'
  source_locator: string
  source_revision: string | null
  builder: string
  parameters: Record<string, unknown>
  environment: Record<string, string>
  provenance: Record<string, unknown>
  attestation_sha256: string
  recorded_by: string
  idempotency_key: string
  request_sha256: string
  created_at: string
}

export interface DeliveryReviewLocation {
  path?: string
  startLine?: number
  endLine?: number
  startByte?: number
  endByte?: number
}

export interface DeliveryReviewComment {
  id: string
  report_id: string
  criterion_id: string | null
  deliverable_id: string | null
  artifact_id: string
  location: DeliveryReviewLocation
  body: string
  author: string
  idempotency_key: string
  request_sha256: string
  created_at: string
}

export interface DeliveryShipment {
  id: string
  report_id: string
  receipt_id: string | null
  board_id: number
  card_id: number
  job_id: string | null
  source_repository: string
  source_commit: string
  observed_head_commit: string | null
  destination: string
  deployment_ref: string | null
  artifact_attestations: Array<{
    id: string
    artifact_id: string
    content_sha256: string
    attestation_sha256: string
  }>
  manifest_sha256: string
  shipped_by: string
  shipped_at: string
  idempotency_key: string
  request_sha256: string
  created_at: string
}

export interface DeliveryShipmentReceipt {
  id: string
  receipt_kind: 'ship_queue'
  board_id: number
  card_id: number
  source_repository: string
  source_commit: string
  observed_head_commit: string
  destination: 'main'
  deployment_ref: string | null
  observed_by: 'ship_queue'
  observed_at: string
  receipt_sha256: string
  idempotency_key: string
  request_sha256: string
  created_at: string
}

export interface DeliveryRegression {
  id: string
  report_id: string
  shipment_id: string | null
  evidence_artifact_id: string
  summary: string
  reopened_report_id: string
  recorded_by: string
  observed_at: string
  idempotency_key: string
  request_sha256: string
  created_at: string
}

export interface JobDeliveryDetail {
  job: {
    id: string
    board_id: number
    card_id: number
    workspace_id: string | null
    status: string
    provider: string
    created_at: string
  }
  requested: DeliveryReport['asked']
  delivered: DeliveryReport
  lineage: DeliveryReport[]
  verification_runs: DeliveryVerificationRun[]
  artifact_attestations: DeliveryArtifactAttestation[]
  review_comments: DeliveryReviewComment[]
  shipments: DeliveryShipment[]
  regressions: DeliveryRegression[]
  evidence_gaps: string[]
}

export interface RecordVerificationRunInput {
  actor: ActorIdentity
  command: string
  cwd: string
  environment: Record<string, string>
  exitCode: number
  outputArtifactId: string
  startedAt: string
  finishedAt: string
  idempotencyKey: string
}

export interface AttestArtifactInput {
  actor: ActorIdentity
  artifactId: string
  contentSha256?: string
  byteSize?: number
  sourceKind: DeliveryArtifactAttestation['source_kind']
  sourceLocator: string
  sourceRevision?: string | null
  builder: string
  parameters?: Record<string, unknown>
  environment?: Record<string, string>
  provenance?: Record<string, unknown>
  idempotencyKey: string
}

export interface AddReviewCommentInput {
  actor: ActorIdentity
  criterionId?: string
  deliverableId?: string
  artifactId: string
  location: DeliveryReviewLocation
  body: string
  idempotencyKey: string
}

export interface ShipDeliveryInput {
  actor: ActorIdentity
  receiptId: string
  artifactAttestationIds?: string[]
  idempotencyKey: string
}

/** Internal observation produced after ShipQueue has merged and read the board repository HEAD. */
export interface RecordShipQueueReceiptInput {
  boardId: number
  cardId: number
  sourceCommit: string
  observedHeadCommit: string
  idempotencyKey: string
}

export interface ReopenAfterRegressionInput {
  actor: ActorIdentity
  shipmentId?: string | null
  evidenceArtifactId: string
  summary: string
  observedAt?: string
  idempotencyKey: string
}

type ReportScope = {
  id: string
  board_id: number
  card_id: number
  job_id: string | null
  workspace_id: string | null
}

type ArtifactRow = {
  id: string
  board_id: number
  card_id: number | null
  workspace_id: string | null
  path: string | null
  content: string | null
  metadata: string
}

export class DeliveryTrackbookService {
  private readonly reports: DeliveryReportService
  private readonly events: EventStore

  constructor(private readonly db: Database.Database, events?: EventStore) {
    this.events = events ?? new EventStore(db)
    this.reports = new DeliveryReportService(db, this.events)
    this.requireSchema()
  }

  recordVerificationRun(reportId: string, input: RecordVerificationRunInput): DeliveryVerificationRun {
    const report = this.reports.get(identifier(reportId, 'reportId'))
    if (!['submitted', 'verified'].includes(report.status)) {
      throw new ConflictError('verification can be recorded only for a submitted or verified delivery')
    }
    const actor = actorIdentity(input.actor)
    const command = bounded(input.command, 'command', MAX.command)
    const cwd = bounded(input.cwd, 'cwd', MAX.cwd)
    const environment = safeEnvironment(input.environment)
    const exitCode = integer(input.exitCode, 'exitCode')
    const startedAt = iso(input.startedAt, 'startedAt')
    const finishedAt = iso(input.finishedAt, 'finishedAt')
    if (finishedAt < startedAt) throw new ValidationError('finishedAt must not precede startedAt')
    const idempotencyKey = bounded(input.idempotencyKey, 'idempotencyKey', MAX.idempotencyKey)
    const artifact = this.scopedArtifact(report, input.outputArtifactId)
    if (artifact.content === null) throw new ValidationError('verification output artifact must retain exact content')
    assertSafeVerificationOutput(artifact.content)
    const outputSha256 = sha256(artifact.content)
    const environmentJson = canonicalJson(environment)
    const request = {
      report_id: report.id,
      command,
      cwd,
      environment,
      exit_code: exitCode,
      output_artifact_id: artifact.id,
      output_sha256: outputSha256,
      started_at: startedAt,
      finished_at: finishedAt,
      recorded_by: actorKey(actor),
    }
    const requestSha256 = hashJson(request)
    const run = this.db.transaction(() => {
      const replay = this.verificationByKey(report.id, idempotencyKey)
      if (replay) return replayChecked(replay, requestSha256, 'verification run')
      this.ensureArtifactAttestation(report, artifact, {
        actor,
        artifactId: artifact.id,
        sourceKind: 'command_output',
        sourceLocator: `delivery:${report.id}:command-output:${artifact.id}`,
        sourceRevision: report.commits.at(-1) ?? null,
        builder: command,
        parameters: { cwd, exit_code: exitCode, started_at: startedAt, finished_at: finishedAt },
        environment,
        provenance: { exact_command: command, output_artifact_id: artifact.id },
        idempotencyKey: `verification-output:${idempotencyKey}`,
      })
      const id = randomUUID()
      const createdAt = timestamp()
      this.db.prepare(`INSERT INTO delivery_verification_runs
        (id, report_id, command, cwd, environment_json, environment_sha256, exit_code,
         output_artifact_id, output_sha256, started_at, finished_at, recorded_by,
         idempotency_key, request_sha256, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, report.id, command, cwd, environmentJson, sha256(environmentJson), exitCode,
          artifact.id, outputSha256, startedAt, finishedAt, actorKey(actor), idempotencyKey,
          requestSha256, createdAt)
      this.appendEvent(report, actor, 'delivery.verification_recorded', id, {
        verification_run_id: id,
        command_sha256: sha256(command),
        environment_sha256: sha256(environmentJson),
        exit_code: exitCode,
        output_artifact_id: artifact.id,
        output_sha256: outputSha256,
      })
      return this.verificationByKey(report.id, idempotencyKey)!
    })
    return run.immediate()
  }

  attestArtifact(reportId: string, input: AttestArtifactInput): DeliveryArtifactAttestation {
    const report = this.reports.get(identifier(reportId, 'reportId'))
    const artifact = this.scopedArtifact(report, input.artifactId)
    const result = this.db.transaction(() => this.ensureArtifactAttestation(report, artifact, input))
    return result.immediate()
  }

  addReviewComment(reportId: string, input: AddReviewCommentInput): DeliveryReviewComment {
    const report = this.reports.get(identifier(reportId, 'reportId'))
    if (!['submitted', 'verified', 'rejected'].includes(report.status)) {
      throw new ConflictError('review comments require a submitted, verified, or rejected delivery')
    }
    const actor = actorIdentity(input.actor)
    const criterionId = optionalIdentifier(input.criterionId, 'criterionId')
    const deliverableId = optionalIdentifier(input.deliverableId, 'deliverableId')
    if ((criterionId ? 1 : 0) + (deliverableId ? 1 : 0) !== 1) {
      throw new ValidationError('a review comment must target exactly one criterion or deliverable')
    }
    if (criterionId && !report.asked.acceptance_criteria.some((item) => item.id === criterionId)) {
      throw new ValidationError('review comment criterion is not in the frozen request')
    }
    if (deliverableId && !report.asked.deliverables.some((item) => item.id === deliverableId)) {
      throw new ValidationError('review comment deliverable is not in the frozen request')
    }
    const artifact = this.scopedArtifact(report, input.artifactId)
    this.requireArtifactAttestation(report.id, artifact.id)
    const location = reviewLocation(input.location, artifact)
    const body = bounded(input.body, 'body', MAX.text)
    const idempotencyKey = bounded(input.idempotencyKey, 'idempotencyKey', MAX.idempotencyKey)
    const request = {
      report_id: report.id,
      criterion_id: criterionId,
      deliverable_id: deliverableId,
      artifact_id: artifact.id,
      location,
      body,
      author: actorKey(actor),
    }
    const requestSha256 = hashJson(request)
    const create = this.db.transaction(() => {
      const replay = this.commentByKey(report.id, idempotencyKey)
      if (replay) return replayChecked(replay, requestSha256, 'review comment')
      const id = randomUUID()
      const createdAt = timestamp()
      this.db.prepare(`INSERT INTO delivery_review_comments
        (id, report_id, criterion_id, deliverable_id, artifact_id, location_json, body,
         author, idempotency_key, request_sha256, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, report.id, criterionId, deliverableId, artifact.id, canonicalJson(location),
          body, actorKey(actor), idempotencyKey, requestSha256, createdAt)
      this.appendEvent(report, actor, 'delivery.review_comment_added', id, {
        review_comment_id: id,
        criterion_id: criterionId,
        deliverable_id: deliverableId,
        artifact_id: artifact.id,
        location,
      })
      return this.commentByKey(report.id, idempotencyKey)!
    })
    return create.immediate()
  }

  rejectWithFeedback(
    reportId: string,
    input: { actor: ActorIdentity; reason: string; comments?: Omit<AddReviewCommentInput, 'actor'>[] },
  ): DeliveryReport {
    const report = this.reports.get(identifier(reportId, 'reportId'))
    const actor = actorIdentity(input.actor)
    const reason = bounded(input.reason, 'reason', MAX.text)
    const reject = this.db.transaction(() => {
      for (const comment of input.comments ?? []) this.addReviewComment(report.id, { ...comment, actor })
      return this.reports.reject(report.id, { actor: actorKey(actor), reason })
    })
    return reject.immediate()
  }

  reviseRejected(reportId: string, actor: ActorIdentity): DeliveryReport {
    return this.reports.revise(identifier(reportId, 'reportId'), { actor: actorKey(actorIdentity(actor)) })
  }

  recordShipQueueReceipt(input: RecordShipQueueReceiptInput): DeliveryShipmentReceipt {
    this.requireShipmentIntegritySchema()
    const boardId = positiveInteger(input.boardId, 'boardId')
    const cardId = positiveInteger(input.cardId, 'cardId')
    const sourceCommit = fullCommit(input.sourceCommit, 'sourceCommit')
    const observedHeadCommit = fullCommit(input.observedHeadCommit, 'observedHeadCommit')
    const idempotencyKey = bounded(input.idempotencyKey, 'idempotencyKey', MAX.idempotencyKey)
    const requestSha256 = hashJson({
      receipt_kind: 'ship_queue',
      board_id: boardId,
      card_id: cardId,
      source_commit: sourceCommit,
      observed_head_commit: observedHeadCommit,
      destination: 'main',
    })
    const replay = this.shipmentReceiptByKey(idempotencyKey)
    if (replay) return replayChecked(replay, requestSha256, 'shipment receipt')

    const sourceRepository = exactBoardRepository(this.db, boardId, cardId)
    const observedHead = repositoryHead(sourceRepository)
    if (observedHead !== observedHeadCommit) {
      throw new ValidationError('observedHeadCommit must equal the observed board repository HEAD')
    }
    const resolvedSourceCommit = repositoryCommit(sourceRepository, sourceCommit)
    if (resolvedSourceCommit !== sourceCommit) {
      throw new ValidationError('shipment sourceCommit must be a full commit SHA resolved in the board repository')
    }
    if (!repositoryContainsCommit(sourceRepository, sourceCommit, observedHeadCommit)) {
      throw new ValidationError('shipment sourceCommit must be an ancestor of the observed board repository HEAD')
    }
    const duplicate = this.shipmentReceiptByObservation(boardId, cardId, sourceCommit, observedHeadCommit)
    if (duplicate) return duplicate

    const observedAt = timestamp()
    const receipt = {
      receipt_kind: 'ship_queue' as const,
      board_id: boardId,
      card_id: cardId,
      source_repository: sourceRepository,
      source_commit: sourceCommit,
      observed_head_commit: observedHeadCommit,
      destination: 'main' as const,
      deployment_ref: null,
      observed_by: 'ship_queue' as const,
      observed_at: observedAt,
    }
    const receiptSha256 = hashJson(receipt)
    const create = this.db.transaction(() => {
      const prior = this.shipmentReceiptByKey(idempotencyKey)
      if (prior) return replayChecked(prior, requestSha256, 'shipment receipt')
      const observed = this.shipmentReceiptByObservation(boardId, cardId, sourceCommit, observedHeadCommit)
      if (observed) return observed
      const id = randomUUID()
      const createdAt = timestamp()
      this.db.prepare(`INSERT INTO delivery_shipment_receipts
        (id, receipt_kind, board_id, card_id, source_repository, source_commit, observed_head_commit,
         destination, deployment_ref, observed_by, observed_at, receipt_sha256,
         idempotency_key, request_sha256, created_at)
        VALUES (?, 'ship_queue', ?, ?, ?, ?, ?, 'main', NULL, 'ship_queue', ?, ?, ?, ?, ?)`)
        .run(id, boardId, cardId, sourceRepository, sourceCommit, observedHeadCommit, observedAt,
          receiptSha256, idempotencyKey, requestSha256, createdAt)
      return this.shipmentReceiptByKey(idempotencyKey)!
    })
    return create.immediate()
  }

  ship(reportId: string, input: ShipDeliveryInput): DeliveryShipment {
    this.requireShipmentIntegritySchema()
    const report = this.reports.get(identifier(reportId, 'reportId'))
    if (report.status !== 'accepted') throw new ConflictError('only an accepted delivery can be shipped')
    const current = report.job_id
      ? this.reports.currentForJob(report.job_id)
      : this.reports.currentForCard(report.card_id)
    if (current?.id !== report.id) throw new ConflictError('only the current accepted delivery revision can be shipped')
    const actor = actorIdentity(input.actor)
    const receipt = this.shipmentReceipt(identifier(input.receiptId, 'receiptId'))
    if (receipt.board_id !== report.board_id || receipt.card_id !== report.card_id) {
      throw new ValidationError('shipment receipt belongs to a different board or card')
    }
    const sourceRepository = receipt.source_repository
    const sourceCommit = receipt.source_commit
    if (!deliveryCitesCommit(report, sourceCommit)) {
      throw new ValidationError('shipment sourceCommit must be cited by the accepted delivery')
    }
    const destination = receipt.destination
    const deploymentRef = receipt.deployment_ref
    const idempotencyKey = bounded(input.idempotencyKey, 'idempotencyKey', MAX.idempotencyKey)
    const shippedAt = receipt.observed_at
    const attestationIds = uniqueIdentifiers(input.artifactAttestationIds ?? [], 'artifactAttestationIds', MAX.attestations)
    const attestations = attestationIds.map((id) => {
      const attestation = this.db.prepare(`SELECT id, report_id, artifact_id, content_sha256, attestation_sha256
        FROM delivery_artifact_attestations WHERE id=?`)
        .get(id) as { id: string; report_id: string; artifact_id: string; content_sha256: string; attestation_sha256: string } | undefined
      if (!attestation) throw new NotFoundError('artifact attestation not found')
      if (attestation.report_id !== report.id) throw new ValidationError('artifact attestation belongs to a different delivery')
      return {
        id: attestation.id,
        artifact_id: attestation.artifact_id,
        content_sha256: attestation.content_sha256,
        attestation_sha256: attestation.attestation_sha256,
      }
    })
    const manifest = {
      report_id: report.id,
      lineage_id: report.lineage_id,
      sequence: report.sequence,
      board_id: report.board_id,
      card_id: report.card_id,
      job_id: report.job_id,
      receipt_id: receipt.id,
      receipt_kind: receipt.receipt_kind,
      receipt_sha256: receipt.receipt_sha256,
      observed_head_commit: receipt.observed_head_commit,
      source_repository: sourceRepository,
      source_commit: sourceCommit,
      destination,
      deployment_ref: deploymentRef,
      artifact_attestations: attestations,
      accepted_at: report.accepted_at,
      shipped_at: shippedAt,
      shipped_by: actorKey(actor),
    }
    const manifestSha256 = hashJson(manifest)
    const requestSha256 = manifestSha256
    const create = this.db.transaction(() => {
      const replay = this.shipmentByKey(report.id, idempotencyKey)
      if (replay) return replayChecked(replay, requestSha256, 'shipment')
      const id = randomUUID()
      const createdAt = timestamp()
      this.db.prepare(`INSERT INTO delivery_shipments
        (id, report_id, receipt_id, board_id, card_id, job_id, source_repository, source_commit,
         destination, deployment_ref, artifact_attestations_json, manifest_sha256,
         shipped_by, shipped_at, idempotency_key, request_sha256, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, report.id, receipt.id, report.board_id, report.card_id, report.job_id, sourceRepository,
          sourceCommit, destination, deploymentRef, canonicalJson(attestations), manifestSha256,
          actorKey(actor), shippedAt, idempotencyKey, requestSha256, createdAt)
      this.appendEvent(report, actor, 'delivery.shipped', id, {
        shipment_id: id,
        receipt_id: receipt.id,
        receipt_sha256: receipt.receipt_sha256,
        source_repository: sourceRepository,
        source_commit: sourceCommit,
        destination,
        deployment_ref: deploymentRef,
        manifest_sha256: manifestSha256,
      }, shippedAt)
      return this.shipmentByKey(report.id, idempotencyKey)!
    })
    return create.immediate()
  }

  reopenAfterRegression(reportId: string, input: ReopenAfterRegressionInput): DeliveryRegression {
    const report = this.reports.get(identifier(reportId, 'reportId'))
    if (report.status !== 'accepted') throw new ConflictError('only an accepted delivery can be reopened after regression')
    const actor = actorIdentity(input.actor)
    const artifact = this.scopedArtifact(report, input.evidenceArtifactId)
    this.requireArtifactAttestation(report.id, artifact.id)
    const summary = bounded(input.summary, 'summary', MAX.text)
    const shipmentId = optionalIdentifier(input.shipmentId, 'shipmentId')
    if (shipmentId) {
      const shipment = this.db.prepare('SELECT report_id FROM delivery_shipments WHERE id=?')
        .get(shipmentId) as { report_id: string } | undefined
      if (!shipment) throw new NotFoundError('shipment not found')
      if (shipment.report_id !== report.id) throw new ValidationError('shipment belongs to a different delivery')
    }
    const idempotencyKey = bounded(input.idempotencyKey, 'idempotencyKey', MAX.idempotencyKey)
    const priorRegression = this.regressionByKey(report.id, idempotencyKey)
    const observedAt = iso(input.observedAt ?? priorRegression?.observed_at ?? timestamp(), 'observedAt')
    const request = {
      report_id: report.id,
      shipment_id: shipmentId,
      evidence_artifact_id: artifact.id,
      summary,
      recorded_by: actorKey(actor),
      observed_at: observedAt,
    }
    const requestSha256 = hashJson(request)
    const reopen = this.db.transaction(() => {
      const replay = this.regressionByKey(report.id, idempotencyKey)
      if (replay) return replayChecked(replay, requestSha256, 'regression reopen')
      const current = report.job_id
        ? this.reports.currentForJob(report.job_id)
        : this.reports.currentForCard(report.card_id)
      if (current?.id !== report.id) throw new ConflictError('only the current accepted delivery can be reopened')
      const child = this.createRegressionRevision(report, actor)
      const id = randomUUID()
      const createdAt = timestamp()
      this.db.prepare(`INSERT INTO delivery_regressions
        (id, report_id, shipment_id, evidence_artifact_id, summary, reopened_report_id,
         recorded_by, observed_at, idempotency_key, request_sha256, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, report.id, shipmentId, artifact.id, summary, child.id, actorKey(actor),
          observedAt, idempotencyKey, requestSha256, createdAt)
      this.appendEvent(report, actor, 'delivery.regression_reopened', id, {
        regression_id: id,
        shipment_id: shipmentId,
        evidence_artifact_id: artifact.id,
        reopened_report_id: child.id,
        summary,
      }, observedAt)
      return this.regressionByKey(report.id, idempotencyKey)!
    })
    return reopen.immediate()
  }

  jobDetail(jobId: string): JobDeliveryDetail {
    const id = identifier(jobId, 'jobId')
    const job = this.db.prepare(`SELECT id, board_id, card_id, workspace_id, status, provider, created_at
      FROM jobs WHERE id=?`).get(id) as JobDeliveryDetail['job'] | undefined
    if (!job) throw new NotFoundError('job not found')
    if (job.card_id == null) throw new ConflictError('job is not linked to a card')
    const delivered = this.reports.currentForJob(id)
    if (!delivered) throw new ConflictError('job has no delivery report')
    const lineage = this.reports.listCard(job.card_id).filter((item) => item.lineage_id === delivered.lineage_id)
    return {
      job: { ...job, card_id: Number(job.card_id), board_id: Number(job.board_id) },
      requested: delivered.asked,
      delivered,
      lineage,
      verification_runs: lineage.flatMap((revision) => this.verificationRuns(revision.id)),
      artifact_attestations: lineage.flatMap((revision) => this.artifactAttestations(revision.id)),
      review_comments: lineage.flatMap((revision) => this.reviewComments(revision.id)),
      shipments: lineage.flatMap((revision) => this.shipments(revision.id)),
      regressions: this.regressions(delivered.lineage_id),
      evidence_gaps: deliveryReportGaps(delivered),
    }
  }

  listBoard(boardId: number, filter: DeliveryTrackbookFilter = 'all', limit = 100): DeliveryReport[] {
    if (!Number.isSafeInteger(boardId) || boardId <= 0) throw new ValidationError('boardId must be a positive integer')
    if (!this.db.prepare('SELECT 1 FROM boards WHERE id=?').get(boardId)) throw new NotFoundError('board not found')
    if (!['all', 'awaiting_review', 'evidence_gaps', 'rejected', 'overridden', 'shipped'].includes(filter)) {
      throw new ValidationError('delivery filter is invalid')
    }
    const boundedLimit = Math.min(MAX.list, Math.max(1, integer(limit, 'limit')))
    const clauses = ['report.board_id=@board_id']
    if (filter === 'awaiting_review') clauses.push("report.status IN ('submitted','verified')")
    if (filter === 'rejected') clauses.push("report.status='rejected'")
    if (filter === 'overridden') clauses.push(`(EXISTS (
      SELECT 1 FROM delivery_deliverable_results result
      WHERE result.report_id=report.id AND result.override_actor IS NOT NULL
    ) OR EXISTS (
      SELECT 1 FROM delivery_criterion_results result
      WHERE result.report_id=report.id AND result.override_actor IS NOT NULL
    ))`)
    if (filter === 'shipped') clauses.push('EXISTS (SELECT 1 FROM delivery_shipments shipment WHERE shipment.report_id=report.id)')
    const sqlLimit = filter === 'evidence_gaps' ? MAX.list : boundedLimit
    const rows = this.db.prepare(`SELECT report.id FROM delivery_reports report
      WHERE ${clauses.join(' AND ')}
      ORDER BY report.updated_at DESC, report.rowid DESC LIMIT @limit`)
      .all({ board_id: boardId, limit: sqlLimit }) as Array<{ id: string }>
    const reports = rows.map((row) => this.reports.get(row.id))
    return filter === 'evidence_gaps'
      ? reports.filter((report) => deliveryReportGaps(report).length > 0).slice(0, boundedLimit)
      : reports
  }

  verificationRuns(reportId: string): DeliveryVerificationRun[] {
    return (this.db.prepare(`SELECT * FROM delivery_verification_runs WHERE report_id=?
      ORDER BY finished_at, rowid`).all(reportId) as Record<string, unknown>[]).map(mapVerificationRun)
  }

  artifactAttestations(reportId: string): DeliveryArtifactAttestation[] {
    return (this.db.prepare(`SELECT * FROM delivery_artifact_attestations WHERE report_id=?
      ORDER BY created_at, rowid`).all(reportId) as Record<string, unknown>[]).map(mapArtifactAttestation)
  }

  reviewComments(reportId: string): DeliveryReviewComment[] {
    return (this.db.prepare(`SELECT * FROM delivery_review_comments WHERE report_id=?
      ORDER BY created_at, rowid`).all(reportId) as Record<string, unknown>[]).map(mapReviewComment)
  }

  shipments(reportId: string): DeliveryShipment[] {
    if (!this.hasShipmentIntegritySchema()) {
      return (this.db.prepare(`SELECT shipment.*, NULL AS receipt_id, NULL AS observed_head_commit
        FROM delivery_shipments shipment WHERE shipment.report_id=?
        ORDER BY shipment.shipped_at, shipment.rowid`)
        .all(reportId) as Record<string, unknown>[]).map(mapShipment)
    }
    return (this.db.prepare(`SELECT shipment.*, receipt.observed_head_commit
      FROM delivery_shipments shipment
      LEFT JOIN delivery_shipment_receipts receipt ON receipt.id=shipment.receipt_id
      WHERE shipment.report_id=? ORDER BY shipment.shipped_at, shipment.rowid`)
      .all(reportId) as Record<string, unknown>[]).map(mapShipment)
  }

  regressions(lineageId: string): DeliveryRegression[] {
    return (this.db.prepare(`SELECT regression.* FROM delivery_regressions regression
      JOIN delivery_reports report ON report.id=regression.report_id
      WHERE report.lineage_id=? ORDER BY regression.observed_at, regression.rowid`)
      .all(lineageId) as Record<string, unknown>[]).map(mapRegression)
  }

  private ensureArtifactAttestation(
    report: DeliveryReport,
    artifact: ArtifactRow,
    input: AttestArtifactInput,
  ): DeliveryArtifactAttestation {
    const actor = actorIdentity(input.actor)
    const sourceKind = input.sourceKind
    if (!['inline', 'file', 'command_output', 'external'].includes(sourceKind)) {
      throw new ValidationError('sourceKind is invalid')
    }
    const sourceLocator = bounded(input.sourceLocator, 'sourceLocator', MAX.locator)
    const sourceRevision = optionalBounded(input.sourceRevision, 'sourceRevision', MAX.locator)
    const builder = bounded(input.builder, 'builder', MAX.locator)
    const parameters = plainRecord(input.parameters ?? {}, 'parameters')
    const environment = safeEnvironment(input.environment ?? {})
    const provenance = plainRecord(input.provenance ?? {}, 'provenance')
    const idempotencyKey = bounded(input.idempotencyKey, 'idempotencyKey', MAX.idempotencyKey)
    if (artifact.content !== null) assertSafeRetainedArtifact(artifact.content)
    const exact = artifact.content === null
      ? externalDigest(input.contentSha256, input.byteSize)
      : { content_sha256: sha256(artifact.content), byte_size: Buffer.byteLength(artifact.content) }
    if (input.contentSha256 && input.contentSha256.toLowerCase() !== exact.content_sha256) {
      throw new ValidationError('artifact contentSha256 does not match retained content')
    }
    if (input.byteSize !== undefined && input.byteSize !== exact.byte_size) {
      throw new ValidationError('artifact byteSize does not match retained content')
    }
    const attested = {
      report_id: report.id,
      artifact_id: artifact.id,
      ...exact,
      source_kind: sourceKind,
      source_locator: sourceLocator,
      source_revision: sourceRevision,
      builder,
      parameters,
      environment,
      provenance,
      recorded_by: actorKey(actor),
    }
    const attestationSha256 = hashJson(attested)
    const requestSha256 = attestationSha256
    const replay = this.attestationByKey(report.id, idempotencyKey)
    if (replay) return replayChecked(replay, requestSha256, 'artifact attestation')
    const existing = this.db.prepare('SELECT * FROM delivery_artifact_attestations WHERE report_id=? AND artifact_id=?')
      .get(report.id, artifact.id) as Record<string, unknown> | undefined
    if (existing) {
      const mapped = mapArtifactAttestation(existing)
      if (mapped.attestation_sha256 !== attestationSha256) {
        throw new ConflictError('artifact already has a different immutable attestation')
      }
      return mapped
    }
    const id = randomUUID()
    const createdAt = timestamp()
    this.db.prepare(`INSERT INTO delivery_artifact_attestations
      (id, report_id, artifact_id, content_sha256, byte_size, source_kind, source_locator,
       source_revision, builder, parameters_json, environment_json, provenance_json,
       attestation_sha256, recorded_by, idempotency_key, request_sha256, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, report.id, artifact.id, exact.content_sha256, exact.byte_size, sourceKind,
        sourceLocator, sourceRevision, builder, canonicalJson(parameters), canonicalJson(environment),
        canonicalJson(provenance), attestationSha256, actorKey(actor), idempotencyKey,
        requestSha256, createdAt)
    this.appendEvent(report, actor, 'delivery.artifact_attested', id, {
      artifact_attestation_id: id,
      artifact_id: artifact.id,
      content_sha256: exact.content_sha256,
      byte_size: exact.byte_size,
      source_kind: sourceKind,
      source_locator: sourceLocator,
      source_revision: sourceRevision,
      attestation_sha256: attestationSha256,
    })
    return this.attestationByKey(report.id, idempotencyKey)!
  }

  private createRegressionRevision(report: DeliveryReport, actor: ActorIdentity): DeliveryReport {
    const existing = this.db.prepare('SELECT id FROM delivery_reports WHERE parent_report_id=?')
      .get(report.id) as { id: string } | undefined
    if (existing) throw new ConflictError('delivery already has a revision; reopen that current revision instead')
    const childId = randomUUID()
    const at = timestamp()
    this.db.prepare(`INSERT INTO delivery_reports
      (id, lineage_id, parent_report_id, sequence, board_id, card_id, job_id, session_id, workspace_id,
       status, asked_snapshot, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)`)
      .run(childId, report.lineage_id, report.id, report.sequence + 1, report.board_id, report.card_id,
        report.job_id, report.session_id, report.workspace_id, canonicalJson(report.asked), actorKey(actor), at, at)
    return this.reports.get(childId)
  }

  private scopedArtifact(report: ReportScope, artifactId: string): ArtifactRow {
    const id = identifier(artifactId, 'artifactId')
    const artifact = this.db.prepare(`SELECT id, board_id, card_id, workspace_id, path, content, metadata
      FROM artifacts WHERE id=?`).get(id) as ArtifactRow | undefined
    if (!artifact) throw new NotFoundError('artifact not found')
    const exactScope = artifact.card_id === report.card_id
      || (report.workspace_id !== null && artifact.workspace_id === report.workspace_id)
    if (artifact.board_id !== report.board_id || !exactScope) {
      throw new ValidationError('artifact belongs to a different delivery scope')
    }
    return artifact
  }

  private requireArtifactAttestation(reportId: string, artifactId: string): void {
    const row = this.db.prepare(`SELECT 1 FROM delivery_artifact_attestations
      WHERE report_id=? AND artifact_id=?`).get(reportId, artifactId)
    if (!row) throw new ConflictError('exact review and regression evidence must be attested first')
  }

  private appendEvent(
    report: ReportScope,
    actor: ActorIdentity,
    kind: string,
    entityId: string,
    payload: Record<string, unknown>,
    createdAt?: string,
  ): void {
    this.events.append({
      boardId: report.board_id,
      cardId: report.card_id,
      workspaceId: report.workspace_id,
      jobId: report.job_id,
      actor,
      causationId: report.id,
      idempotencyKey: `delivery-trackbook:${entityId}`,
      kind,
      source: 'delivery-trackbook',
      payload: { delivery_report_id: report.id, ...payload },
      createdAt,
    })
  }

  private requireSchema(): void {
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM sqlite_master
      WHERE type='table' AND name IN (
        'delivery_verification_runs','delivery_artifact_attestations','delivery_review_comments',
        'delivery_shipments','delivery_regressions'
      )`).get() as { count: number }
    if (row.count !== 5) throw new Error('delivery Trackbook migration 030 is not installed')
  }

  private hasShipmentIntegritySchema(): boolean {
    const table = this.db.prepare(`SELECT 1 FROM sqlite_master
      WHERE type='table' AND name='delivery_shipment_receipts'`).get()
    if (!table) return false
    return (this.db.prepare(`PRAGMA table_info(delivery_shipments)`).all() as Array<{ name: string }>)
      .some((column) => column.name === 'receipt_id')
  }

  private requireShipmentIntegritySchema(): void {
    if (!this.hasShipmentIntegritySchema()) {
      throw new Error('delivery shipment integrity migration 035 is not installed')
    }
  }

  private verificationByKey(reportId: string, key: string): DeliveryVerificationRun | null {
    const row = this.db.prepare('SELECT * FROM delivery_verification_runs WHERE report_id=? AND idempotency_key=?')
      .get(reportId, key) as Record<string, unknown> | undefined
    return row ? mapVerificationRun(row) : null
  }

  private attestationByKey(reportId: string, key: string): DeliveryArtifactAttestation | null {
    const row = this.db.prepare('SELECT * FROM delivery_artifact_attestations WHERE report_id=? AND idempotency_key=?')
      .get(reportId, key) as Record<string, unknown> | undefined
    return row ? mapArtifactAttestation(row) : null
  }

  private commentByKey(reportId: string, key: string): DeliveryReviewComment | null {
    const row = this.db.prepare('SELECT * FROM delivery_review_comments WHERE report_id=? AND idempotency_key=?')
      .get(reportId, key) as Record<string, unknown> | undefined
    return row ? mapReviewComment(row) : null
  }

  private shipmentReceipt(id: string): DeliveryShipmentReceipt {
    const row = this.db.prepare('SELECT * FROM delivery_shipment_receipts WHERE id=?')
      .get(id) as Record<string, unknown> | undefined
    if (!row) throw new NotFoundError('shipment receipt not found')
    return mapShipmentReceipt(row)
  }

  private shipmentReceiptByKey(key: string): DeliveryShipmentReceipt | null {
    const row = this.db.prepare(`SELECT * FROM delivery_shipment_receipts
      WHERE receipt_kind='ship_queue' AND idempotency_key=?`).get(key) as Record<string, unknown> | undefined
    return row ? mapShipmentReceipt(row) : null
  }

  private shipmentReceiptByObservation(
    boardId: number,
    cardId: number,
    sourceCommit: string,
    observedHeadCommit: string,
  ): DeliveryShipmentReceipt | null {
    const row = this.db.prepare(`SELECT * FROM delivery_shipment_receipts
      WHERE receipt_kind='ship_queue' AND board_id=? AND card_id=?
        AND source_commit=? AND observed_head_commit=? AND destination='main'`)
      .get(boardId, cardId, sourceCommit, observedHeadCommit) as Record<string, unknown> | undefined
    return row ? mapShipmentReceipt(row) : null
  }

  private shipmentByKey(reportId: string, key: string): DeliveryShipment | null {
    const row = this.db.prepare(`SELECT shipment.*, receipt.observed_head_commit
      FROM delivery_shipments shipment
      LEFT JOIN delivery_shipment_receipts receipt ON receipt.id=shipment.receipt_id
      WHERE shipment.report_id=? AND shipment.idempotency_key=?`)
      .get(reportId, key) as Record<string, unknown> | undefined
    return row ? mapShipment(row) : null
  }

  private regressionByKey(reportId: string, key: string): DeliveryRegression | null {
    const row = this.db.prepare('SELECT * FROM delivery_regressions WHERE report_id=? AND idempotency_key=?')
      .get(reportId, key) as Record<string, unknown> | undefined
    return row ? mapRegression(row) : null
  }
}

function mapVerificationRun(row: Record<string, unknown>): DeliveryVerificationRun {
  return {
    id: String(row.id),
    report_id: String(row.report_id),
    command: String(row.command),
    cwd: String(row.cwd),
    environment: parseJson<Record<string, string>>(row.environment_json, {}),
    environment_sha256: String(row.environment_sha256),
    exit_code: Number(row.exit_code),
    output_artifact_id: String(row.output_artifact_id),
    output_sha256: String(row.output_sha256),
    started_at: String(row.started_at),
    finished_at: String(row.finished_at),
    recorded_by: String(row.recorded_by),
      idempotency_key: String(row.idempotency_key),
    request_sha256: String(row.request_sha256),
    created_at: String(row.created_at),
  }
}

function mapArtifactAttestation(row: Record<string, unknown>): DeliveryArtifactAttestation {
  return {
    id: String(row.id),
    report_id: String(row.report_id),
    artifact_id: String(row.artifact_id),
    content_sha256: String(row.content_sha256),
    byte_size: Number(row.byte_size),
    source_kind: String(row.source_kind) as DeliveryArtifactAttestation['source_kind'],
    source_locator: String(row.source_locator),
    source_revision: nullableString(row.source_revision),
    builder: String(row.builder),
    parameters: parseJson<Record<string, unknown>>(row.parameters_json, {}),
    environment: parseJson<Record<string, string>>(row.environment_json, {}),
    provenance: parseJson<Record<string, unknown>>(row.provenance_json, {}),
    attestation_sha256: String(row.attestation_sha256),
    recorded_by: String(row.recorded_by),
    idempotency_key: String(row.idempotency_key),
    request_sha256: String(row.request_sha256),
    created_at: String(row.created_at),
  }
}

function mapReviewComment(row: Record<string, unknown>): DeliveryReviewComment {
  return {
    id: String(row.id),
    report_id: String(row.report_id),
    criterion_id: nullableString(row.criterion_id),
    deliverable_id: nullableString(row.deliverable_id),
    artifact_id: String(row.artifact_id),
    location: parseJson<DeliveryReviewLocation>(row.location_json, {}),
    body: String(row.body),
    author: String(row.author),
    idempotency_key: String(row.idempotency_key),
    request_sha256: String(row.request_sha256),
    created_at: String(row.created_at),
  }
}

function mapShipment(row: Record<string, unknown>): DeliveryShipment {
  return {
    id: String(row.id),
    report_id: String(row.report_id),
    receipt_id: nullableString(row.receipt_id),
    board_id: Number(row.board_id),
    card_id: Number(row.card_id),
    job_id: nullableString(row.job_id),
    source_repository: String(row.source_repository),
    source_commit: String(row.source_commit),
    observed_head_commit: nullableString(row.observed_head_commit),
    destination: String(row.destination),
    deployment_ref: nullableString(row.deployment_ref),
    artifact_attestations: parseJson<DeliveryShipment['artifact_attestations']>(row.artifact_attestations_json, []),
    manifest_sha256: String(row.manifest_sha256),
    shipped_by: String(row.shipped_by),
    shipped_at: String(row.shipped_at),
    idempotency_key: String(row.idempotency_key),
    request_sha256: String(row.request_sha256),
    created_at: String(row.created_at),
  }
}

function mapShipmentReceipt(row: Record<string, unknown>): DeliveryShipmentReceipt {
  return {
    id: String(row.id),
    receipt_kind: 'ship_queue',
    board_id: Number(row.board_id),
    card_id: Number(row.card_id),
    source_repository: String(row.source_repository),
    source_commit: String(row.source_commit),
    observed_head_commit: String(row.observed_head_commit),
    destination: 'main',
    deployment_ref: nullableString(row.deployment_ref),
    observed_by: 'ship_queue',
    observed_at: String(row.observed_at),
    receipt_sha256: String(row.receipt_sha256),
    idempotency_key: String(row.idempotency_key),
    request_sha256: String(row.request_sha256),
    created_at: String(row.created_at),
  }
}

function mapRegression(row: Record<string, unknown>): DeliveryRegression {
  return {
    id: String(row.id),
    report_id: String(row.report_id),
    shipment_id: nullableString(row.shipment_id),
    evidence_artifact_id: String(row.evidence_artifact_id),
    summary: String(row.summary),
    reopened_report_id: String(row.reopened_report_id),
    recorded_by: String(row.recorded_by),
    observed_at: String(row.observed_at),
    idempotency_key: String(row.idempotency_key),
    request_sha256: String(row.request_sha256),
    created_at: String(row.created_at),
  }
}

function replayChecked<T extends { request_sha256: string }>(value: T, expected: string, label: string): T {
  if (value.request_sha256 !== expected) {
    throw new ConflictError(`${label} idempotency key was already used for different input`)
  }
  return value
}

function assertSafeVerificationOutput(content: string): void {
  assertSafeRetainedArtifact(content)
}

function assertSafeRetainedArtifact(content: string): void {
  if (Buffer.byteLength(content) > 1024 * 1024) {
    throw new ValidationError('verification output exceeds the 1 MiB retention limit')
  }
  const redacted = redactSensitiveText(content)
  if (redacted.redactions > 0 || redacted.value !== content) {
    throw new ValidationError('verification output must be redacted before it is recorded')
  }
}

function deliveryCitesCommit(report: DeliveryReport, commit: string): boolean {
  if (report.commits.some((value) => value.toLowerCase() === commit)) return true
  return [...report.deliverable_results, ...report.criterion_results].some((result) =>
    result.evidence_refs.some((evidence) => evidence.kind === 'commit' && evidence.ref.toLowerCase() === commit))
}

function fullCommit(value: unknown, field: string): string {
  const commit = bounded(value, field, 64).toLowerCase()
  if (!FULL_GIT_COMMIT.test(commit)) {
    throw new ValidationError(`${field} must be a full 40- or 64-character hexadecimal commit SHA`)
  }
  return commit
}

function exactBoardRepository(db: Database.Database, boardId: number, cardId: number): string {
  const row = db.prepare(`SELECT board.project_path
    FROM cards card JOIN boards board ON board.id=card.board_id
    WHERE board.id=? AND card.id=?`).get(boardId, cardId) as { project_path: string } | undefined
  if (!row) throw new NotFoundError('shipment card was not found on the board')
  try {
    const configured = realpathSync(row.project_path)
    const root = realpathSync(gitEvidence(configured, ['rev-parse', '--show-toplevel']))
    if (root !== configured) {
      throw new ValidationError('shipment board path must be the exact repository root')
    }
    return root
  } catch (error) {
    if (error instanceof ValidationError) throw error
    throw new ValidationError('shipment board repository could not be verified')
  }
}

function repositoryHead(repository: string): string {
  let head: string
  try {
    head = gitEvidence(repository, ['rev-parse', '--verify', 'HEAD^{commit}']).toLowerCase()
  } catch {
    throw new ValidationError('shipment board repository HEAD could not be resolved')
  }
  return fullCommit(head, 'observed repository HEAD')
}

function repositoryCommit(repository: string, commit: string): string {
  try {
    return fullCommit(
      gitEvidence(repository, ['rev-parse', '--verify', '--end-of-options', `${commit}^{commit}`]),
      'resolved sourceCommit',
    )
  } catch {
    throw new ValidationError('shipment sourceCommit does not resolve in the exact board repository')
  }
}

function repositoryContainsCommit(repository: string, sourceCommit: string, observedHeadCommit: string): boolean {
  try {
    gitEvidence(repository, ['merge-base', '--is-ancestor', sourceCommit, observedHeadCommit])
    return true
  } catch {
    return false
  }
}

function gitEvidence(repository: string, args: string[]): string {
  const environment = { ...process.env }
  for (const key of Object.keys(environment)) {
    if (key.startsWith('GIT_')) delete environment[key]
  }
  environment.GIT_CONFIG_NOSYSTEM = '1'
  environment.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null'
  environment.GIT_NO_REPLACE_OBJECTS = '1'
  environment.GIT_OPTIONAL_LOCKS = '0'
  return execFileSync('git', ['-C', repository, ...args], {
    encoding: 'utf8',
    env: environment,
    maxBuffer: 65_536,
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 15_000,
  }).trim()
}

function reviewLocation(value: DeliveryReviewLocation, artifact: ArtifactRow): DeliveryReviewLocation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError('location must be an object')
  const path = optionalBounded(value.path, 'location.path', MAX.locator)
  const hasLines = value.startLine !== undefined || value.endLine !== undefined
  const hasBytes = value.startByte !== undefined || value.endByte !== undefined
  if (hasLines === hasBytes) throw new ValidationError('location must use exactly one line or byte range')
  if (hasLines) {
    const startLine = positiveInteger(value.startLine, 'location.startLine')
    const endLine = positiveInteger(value.endLine ?? value.startLine, 'location.endLine')
    if (endLine < startLine) throw new ValidationError('location.endLine must not precede startLine')
    if (artifact.content !== null && endLine > artifact.content.split(/\r?\n/).length) {
      throw new ValidationError('review line range exceeds artifact content')
    }
    return { ...(path ? { path } : {}), startLine, endLine }
  }
  const startByte = nonNegativeInteger(value.startByte, 'location.startByte')
  const endByte = nonNegativeInteger(value.endByte, 'location.endByte')
  if (endByte <= startByte) throw new ValidationError('location.endByte must be greater than startByte')
  if (artifact.content !== null && endByte > Buffer.byteLength(artifact.content)) {
    throw new ValidationError('review byte range exceeds artifact content')
  }
  return { ...(path ? { path } : {}), startByte, endByte }
}

function safeEnvironment(value: Record<string, string>): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError('environment must be an object')
  const entries = Object.entries(value)
  if (entries.length > MAX.environmentEntries) throw new ValidationError(`environment accepts at most ${MAX.environmentEntries} entries`)
  const normalized: Record<string, string> = {}
  for (const [key, raw] of entries.sort(([left], [right]) => left.localeCompare(right))) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key)) throw new ValidationError(`environment key ${key} is invalid`)
    if (SENSITIVE_ENV_KEY.test(key)) throw new ValidationError(`sensitive environment key ${key} cannot be persisted`)
    if (typeof raw !== 'string') throw new ValidationError(`environment value ${key} must be a string`)
    if (raw.length > MAX.environmentValue) throw new ValidationError(`environment value ${key} is too long`)
    normalized[key] = raw
  }
  return normalized
}

function externalDigest(contentSha256: string | undefined, byteSize: number | undefined) {
  const digest = String(contentSha256 ?? '').toLowerCase()
  if (!HEX_SHA256.test(digest)) throw new ValidationError('external artifacts require a SHA-256 content digest')
  return { content_sha256: digest, byte_size: nonNegativeInteger(byteSize, 'byteSize') }
}

function actorIdentity(value: ActorIdentity): ActorIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError('actor is required')
  const type = bounded(value.type, 'actor.type', 64)
  const id = value.id === null ? null : bounded(value.id, 'actor.id', 256)
  return { type, id }
}

function actorKey(actor: ActorIdentity): string {
  return bounded(`${actor.type}:${actor.id ?? 'anonymous'}`, 'actor', MAX.actor)
}

function identifier(value: unknown, field: string): string {
  const result = bounded(value, field, 512)
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/+\-=]{0,511}$/.test(result)) throw new ValidationError(`${field} is invalid`)
  return result
}

function optionalIdentifier(value: unknown, field: string): string | null {
  return value === undefined || value === null || value === '' ? null : identifier(value, field)
}

function uniqueIdentifiers(values: unknown[], field: string, max: number): string[] {
  if (!Array.isArray(values) || values.length > max) throw new ValidationError(`${field} accepts at most ${max} values`)
  return [...new Set(values.map((value) => identifier(value, field)))].sort()
}

function bounded(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || !value.trim()) throw new ValidationError(`${field} is required`)
  const result = value.trim()
  if (result.length > max) throw new ValidationError(`${field} must be at most ${max} characters`)
  if (/\p{Cc}/u.test(result)) throw new ValidationError(`${field} contains control characters`)
  return result
}

function optionalBounded(value: unknown, field: string, max: number): string | null {
  return value === undefined || value === null || value === '' ? null : bounded(value, field, max)
}

function integer(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value)) throw new ValidationError(`${field} must be an integer`)
  return Number(value)
}

function positiveInteger(value: unknown, field: string): number {
  const result = integer(value, field)
  if (result <= 0) throw new ValidationError(`${field} must be positive`)
  return result
}

function nonNegativeInteger(value: unknown, field: string): number {
  const result = integer(value, field)
  if (result < 0) throw new ValidationError(`${field} must be non-negative`)
  return result
}

function iso(value: unknown, field: string): string {
  const text = bounded(value, field, 64)
  const time = Date.parse(text)
  if (!Number.isFinite(time)) throw new ValidationError(`${field} must be an ISO timestamp`)
  return new Date(time).toISOString()
}

function plainRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError(`${field} must be an object`)
  const redacted = redactStructuredValue(value)
  if (redacted.changed || redacted.redactions > 0) {
    throw new ValidationError(`${field} must be redacted before it is recorded`)
  }
  const serialized = canonicalJson(value)
  if (serialized.length > 64_000) throw new ValidationError(`${field} is too large`)
  return JSON.parse(serialized) as Record<string, unknown>
}

function nullableString(value: unknown): string | null {
  return value === undefined || value === null ? null : String(value)
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value))
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, sortJson(item)]))
  return value
}

function hashJson(value: unknown): string {
  return sha256(canonicalJson(value))
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
