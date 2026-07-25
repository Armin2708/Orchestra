import type Database from 'better-sqlite3'
import { ConflictError, NotFoundError } from './errors.js'

export interface DurableSessionEventScope {
  jobId: string | null
  cardId: number | null
  contractId: string | null
  correlationId: string | null
}

export interface SessionEventScopeSource {
  workspace_id: string
  job_id: string | null
  context: Record<string, unknown>
}

export function durableSessionEventScope(
  db: Database.Database,
  session: SessionEventScopeSource,
  boardId: number,
  requestedJobId?: string | null,
): DurableSessionEventScope {
  const contextJobId = typeof session.context.job_id === 'string'
    ? session.context.job_id.trim() || null
    : null
  const jobId = requestedJobId === undefined
    ? session.job_id ?? contextJobId
    : requestedJobId
  if (!jobId) {
    return { jobId: null, cardId: null, contractId: null, correlationId: null }
  }

  const job = db.prepare(`SELECT board_id, workspace_id, card_id, contract_version
    FROM jobs WHERE id=?`).get(jobId) as {
    board_id: number
    workspace_id: string | null
    card_id: number | null
    contract_version: number | null
  } | undefined
  if (!job) throw new NotFoundError('job not found')
  if (Number(job.board_id) !== boardId
    || (job.workspace_id !== null && job.workspace_id !== session.workspace_id)) {
    throw new ConflictError('agent session job scope is inconsistent')
  }

  const cardId = job.card_id === null ? null : Number(job.card_id)
  const contractVersion = job.contract_version === null ? null : Number(job.contract_version)
  const contractId = cardId && contractVersion ? `card:${cardId}:v${contractVersion}` : null
  if (!contractId) {
    return { jobId, cardId, contractId: null, correlationId: null }
  }

  const contextCorrelationId = typeof session.context.correlation_id === 'string'
    ? session.context.correlation_id.trim() || null
    : null
  const prior = db.prepare(`SELECT correlation_id FROM os_events
    WHERE job_id=? AND correlation_id IS NOT NULL
    ORDER BY created_at ASC, rowid ASC LIMIT 1`).get(jobId) as
    { correlation_id: string } | undefined
  if (contextCorrelationId && prior?.correlation_id
    && contextCorrelationId !== prior.correlation_id) {
    throw new ConflictError('agent session canonical correlation scope is inconsistent')
  }
  return {
    jobId,
    cardId,
    contractId,
    correlationId: contextCorrelationId ?? prior?.correlation_id ?? jobId,
  }
}
