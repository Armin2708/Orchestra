import type Database from 'better-sqlite3'
import { ConflictError, ValidationError } from './errors.js'

export interface FrozenJobAssignmentIdentity {
  jobAssignmentId: string
  assignedProfileId: string
  assignmentMarketVersion: number
}

export interface ResolvedJobAssignment extends FrozenJobAssignmentIdentity {
  assignmentVersion: number
  boardId: number
  cardId: number
  workspaceId: string | null
  currentMarketVersion: number
}

interface CurrentJobAssignmentRow {
  job_assignment_id: unknown
  assigned_profile_id: unknown
  assignment_market_version: unknown
  assignment_version: unknown
  board_id: unknown
  card_id: unknown
  workspace_id: unknown
  current_market_version: unknown
  ownership_mode: unknown
}

function positiveScopeId(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ValidationError(`${label} must be a positive integer`)
  }
  return value
}

function requiredIdentityString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConflictError(`active job assignment ${label} is missing`)
  }
  return value
}

function requiredIdentityVersion(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new ConflictError(`active job assignment ${label} is missing or invalid`)
  }
  return Number(value)
}

function mapCurrentJobAssignment(row: CurrentJobAssignmentRow): ResolvedJobAssignment {
  const workspaceId = row.workspace_id === null
    ? null
    : requiredIdentityString(row.workspace_id, 'workspace identity')
  return {
    jobAssignmentId: requiredIdentityString(row.job_assignment_id, 'id'),
    assignedProfileId: requiredIdentityString(row.assigned_profile_id, 'profile identity'),
    assignmentMarketVersion: requiredIdentityVersion(
      row.assignment_market_version,
      'market version',
    ),
    assignmentVersion: requiredIdentityVersion(row.assignment_version, 'version'),
    boardId: requiredIdentityVersion(row.board_id, 'board scope'),
    cardId: requiredIdentityVersion(row.card_id, 'card scope'),
    workspaceId,
    currentMarketVersion: requiredIdentityVersion(
      row.current_market_version,
      'current market version',
    ),
  }
}

/**
 * Resolve the one current canonical assignment without mutating or inferring runtime state.
 *
 * A card with no active canonical assignment returns null. Corrupt/partial or ambiguous
 * assignment state fails closed instead of being treated as an unassigned legacy card.
 */
export function resolveCurrentJobAssignment(
  db: Database.Database,
  boardId: number,
  cardId: number,
): ResolvedJobAssignment | null {
  const normalizedBoardId = positiveScopeId(boardId, 'board id')
  const normalizedCardId = positiveScopeId(cardId, 'card id')
  const rows = db.prepare(`
    SELECT
      assignment.id AS job_assignment_id,
      assignment.profile_id AS assigned_profile_id,
      assignment.assigned_market_version AS assignment_market_version,
      assignment.version AS assignment_version,
      assignment.board_id,
      assignment.card_id,
      assignment.workspace_id,
      market.version AS current_market_version,
      assignment.ownership_mode
    FROM job_market_assignments assignment
    LEFT JOIN job_market_contracts market ON market.card_id=assignment.card_id
    WHERE assignment.card_id=?
      AND assignment.status='active'
    ORDER BY assignment.created_at DESC, assignment.rowid DESC
    LIMIT 2
  `).all(normalizedCardId) as CurrentJobAssignmentRow[]

  if (rows.length === 0) return null
  if (rows.length !== 1) {
    throw new ConflictError('active job assignment identity is ambiguous')
  }
  if (rows[0].ownership_mode !== 'exclusive') {
    throw new ConflictError('active job assignment ownership mode is inconsistent')
  }
  const resolved = mapCurrentJobAssignment(rows[0])
  if (resolved.boardId !== normalizedBoardId || resolved.cardId !== normalizedCardId) {
    throw new ConflictError('active job assignment scope is inconsistent')
  }
  if (resolved.assignmentVersion !== 1) {
    throw new ConflictError('active job assignment version is inconsistent')
  }
  if (resolved.assignmentMarketVersion !== resolved.currentMarketVersion) {
    throw new ConflictError('active job assignment market version is inconsistent')
  }
  return resolved
}
