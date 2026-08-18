import fs from 'node:fs'
import path from 'node:path'
import type Database from 'better-sqlite3'
import {
  GRAPHIFY_GRAPH_LOCATOR,
  ingestGraphifyKnowledge,
  type GraphifyIngestInput,
  type GraphifyIngestResult,
} from './knowledge-graphify-ingest.js'

export interface GraphifyAutoSyncDeps {
  ingest?: (db: Database.Database, input: GraphifyIngestInput) => GraphifyIngestResult
}

export interface GraphifyAutoSync {
  /** stat every board's graph.json; ingest the ones whose graph changed since the last tick */
  tick(): void
}

/**
 * Keeps the Wiki in step with a project's graphify output without the manual
 * "Sync project graph" button. The ingest itself is idempotent and supersede-safe,
 * so the only job here is a cheap mtime gate per board — and never letting a
 * knowledge failure take the reaper interval down with it. A failed ingest is not
 * retried until the graph file changes again: the same bytes would fail the same way.
 */
export function createGraphifyAutoSync(
  db: Database.Database,
  deps: GraphifyAutoSyncDeps = {},
): GraphifyAutoSync {
  const ingest = deps.ingest ?? ingestGraphifyKnowledge
  const attempted = new Map<number, number>()
  return {
    tick(): void {
      const boards = db.prepare('SELECT id, project_path FROM boards').all() as
        { id: number, project_path: string }[]
      for (const board of boards) {
        let mtime: number
        try {
          mtime = fs.statSync(path.join(board.project_path, GRAPHIFY_GRAPH_LOCATOR)).mtimeMs
        } catch {
          continue // no graphify output — nothing to sync
        }
        if (attempted.get(board.id) === mtime) continue
        attempted.set(board.id, mtime)
        try {
          ingest(db, { board_id: board.id })
        } catch {
          // knowledge-service failures must never break the reaper tick; the
          // mtime stays recorded so an unchanged graph is not retried hot
        }
      }
    },
  }
}
