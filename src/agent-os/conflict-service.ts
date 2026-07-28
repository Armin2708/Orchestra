import type Database from 'better-sqlite3'
import { NotFoundError, ValidationError } from './errors.js'
import { WorkspaceStore } from './workspace-store.js'

export type WorkspaceConflict = ReturnType<WorkspaceStore['conflicts']>[number]

export interface ConflictDetectionServiceBoundary {
  listBoard(boardId: number): WorkspaceConflict[]
}

/**
 * Compatibility-only conflict boundary.
 *
 * It deliberately exposes the two existing computed workspace overlap kinds. It does not
 * manufacture the durable negotiation and resolution lifecycle reserved for the canonical
 * Conflict domain.
 */
export class ComputedWorkspaceConflictService implements ConflictDetectionServiceBoundary {
  private readonly workspaces: WorkspaceStore

  constructor(private readonly db: Database.Database) {
    this.workspaces = new WorkspaceStore(db)
  }

  listBoard(boardId: number): WorkspaceConflict[] {
    if (!Number.isSafeInteger(boardId) || boardId <= 0) {
      throw new ValidationError('board id must be a positive integer')
    }
    if (!this.db.prepare('SELECT 1 FROM boards WHERE id=?').get(boardId)) {
      throw new NotFoundError('board not found')
    }
    return this.workspaces.conflicts(boardId)
  }
}
