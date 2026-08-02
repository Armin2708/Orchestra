import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type Database from 'better-sqlite3'

const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u

interface RepositoryCandidate {
  repository_key: string
  source_count: number
}

export interface BoardKnowledgeRepository {
  root: string
  head: string
  repositoryKey: string
}

/**
 * Resolves the repository identity shared by runtime compilation and
 * review-backed promotions. Existing active sources are authoritative; a
 * repository-root identity is used only before the first source exists.
 */
export function resolveBoardKnowledgeRepository(
  db: Database.Database,
  boardId: number,
): BoardKnowledgeRepository {
  const board = db.prepare('SELECT project_path FROM boards WHERE id=?').get(boardId) as
    { project_path: string } | undefined
  if (!board) throw new Error('knowledge board was not found')

  const root = git(board.project_path, ['rev-parse', '--show-toplevel']).trim()
  if (fs.realpathSync(path.resolve(root)) !== fs.realpathSync(path.resolve(board.project_path))) {
    throw new Error('knowledge board repository root does not match')
  }
  const head = git(root, ['rev-parse', '--verify', 'HEAD']).trim()
  if (!COMMIT.test(head)) throw new Error('knowledge board repository head is invalid')

  const current = repositoryCandidate(db, boardId, head)
  const historical = current ? null : repositoryCandidate(db, boardId, null)
  if (current || historical) {
    return { root, head, repositoryKey: (current ?? historical)!.repository_key }
  }

  const roots = git(root, ['rev-list', '--max-parents=0', 'HEAD'])
    .split(/\r?\n/u).filter((value) => COMMIT.test(value)).sort()
  if (roots.length === 0) throw new Error('knowledge board repository identity is invalid')
  return { root, head, repositoryKey: `git/${roots[0]}` }
}

function repositoryCandidate(
  db: Database.Database,
  boardId: number,
  head: string | null,
): RepositoryCandidate | undefined {
  const headFilter = head === null
    ? ''
    : "AND json_extract(provenance_json, '$.base_commit_sha')=?"
  return db.prepare(`SELECT
      json_extract(provenance_json, '$.repository_key') AS repository_key,
      count(*) AS source_count
    FROM knowledge_sources
    WHERE board_id=? ${headFilter}
      AND content_state='present' AND ingest_state='active'
      AND json_type(provenance_json, '$.repository_key')='text'
    GROUP BY repository_key
    ORDER BY source_count DESC, repository_key
    LIMIT 1`).get(...(head === null ? [boardId] : [boardId, head])) as
      RepositoryCandidate | undefined
}

function git(root: string, args: string[]): string {
  const environment = { ...process.env }
  for (const key of Object.keys(environment)) {
    if (key.startsWith('GIT_')) delete environment[key]
  }
  environment.GIT_CONFIG_NOSYSTEM = '1'
  environment.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null'
  environment.GIT_NO_REPLACE_OBJECTS = '1'
  environment.GIT_OPTIONAL_LOCKS = '0'
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    env: environment,
    maxBuffer: 1_000_000,
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 15_000,
  })
}
