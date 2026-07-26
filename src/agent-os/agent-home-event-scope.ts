import type Database from 'better-sqlite3'
import { ConflictError, NotFoundError } from './errors.js'

export interface DurableSessionEventScope {
  boardId: number
  workspaceId: string
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

export interface DurableSessionEventScopeOptions {
  expectedBoardId?: number
  expectedWorkspaceId?: string
  requestedJobId?: string | null
}

export function durableSessionEventScope(
  db: Database.Database,
  session: SessionEventScopeSource,
  options: DurableSessionEventScopeOptions = {},
): DurableSessionEventScope {
  const workspace = db.prepare('SELECT id, board_id FROM workspaces WHERE id=?')
    .get(session.workspace_id) as { id: string; board_id: number } | undefined
  if (!workspace) throw new ConflictError('agent session workspace is missing')
  const workspaceId = String(workspace.id)
  const boardId = Number(workspace.board_id)
  if (options.expectedBoardId !== undefined && options.expectedBoardId !== boardId) {
    throw new ConflictError('agent session board scope is inconsistent')
  }
  if (options.expectedWorkspaceId !== undefined
    && options.expectedWorkspaceId !== workspaceId) {
    throw new ConflictError('agent session workspace scope is inconsistent')
  }

  const identities = [
    normalizedJobIdentity(options.requestedJobId, 'requested'),
    normalizedJobIdentity(session.job_id, 'persisted'),
    normalizedJobIdentity(session.context.job_id, 'context'),
  ].filter((value): value is string => value !== null)
  const uniqueIdentities = new Set(identities)
  if (uniqueIdentities.size > 1) {
    throw new ConflictError('agent session job identities are inconsistent')
  }
  const jobId = identities[0] ?? null
  if (!jobId) {
    return {
      boardId,
      workspaceId,
      jobId: null,
      cardId: null,
      contractId: null,
      correlationId: null,
    }
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
    || (job.workspace_id !== null && job.workspace_id !== workspaceId)) {
    throw new ConflictError('agent session job scope is inconsistent')
  }

  const cardId = job.card_id === null ? null : Number(job.card_id)
  const contractVersion = job.contract_version === null ? null : Number(job.contract_version)
  const contractId = cardId && contractVersion ? `card:${cardId}:v${contractVersion}` : null
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
    boardId,
    workspaceId,
    jobId,
    cardId,
    contractId,
    correlationId: contextCorrelationId ?? prior?.correlation_id ?? jobId,
  }
}

function normalizedJobIdentity(value: unknown, source: string): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || !value.trim()) {
    throw new ConflictError(`agent session ${source} job identity is invalid`)
  }
  return value.trim()
}
