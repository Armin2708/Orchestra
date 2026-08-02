import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import type Database from 'better-sqlite3'
import {
  canonicalKnowledgeJson,
  knowledgeChunkId,
  knowledgeSourceId,
} from './knowledge-contracts.js'
import { KnowledgeStore } from './knowledge-store.js'
import type { KnowledgeChunk, KnowledgeSource } from './knowledge-types.js'
import type { ConflictKnowledgePromotionAdapter } from './team-planning.js'

const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u

export class CanonicalConflictKnowledgeAdapter implements ConflictKnowledgePromotionAdapter {
  private readonly store: KnowledgeStore

  constructor(private readonly db: Database.Database) {
    this.store = new KnowledgeStore(db)
  }

  promoteConflictResolution(input: {
    boardId: number
    cardId: number | null
    conflictId: string
    resolutionId: string
    title: string
    exactSource: Record<string, unknown>
    sourceSha256: string
    reviewedAt: string
  }): { sourceId: string; chunkId: string; repositoryHeadSha: string } {
    const content = canonicalKnowledgeJson(input.exactSource)
    if (sha256(content) !== input.sourceSha256) {
      throw new Error('conflict knowledge exact source changed before promotion')
    }
    const repository = this.repository(input.boardId)
    const normalizedLocator =
      `conflicts/${input.conflictId}/resolutions/${input.resolutionId}.json`
    const sourceWithoutId: Omit<KnowledgeSource, 'id'> = {
      source_kind: 'decision',
      trust_class: 'evidence',
      title: input.title,
      locator: normalizedLocator,
      normalized_locator: normalizedLocator,
      source_revision: input.sourceSha256,
      content_sha256: input.sourceSha256,
      freshness_policy: 'manual_until_superseded',
      freshness_state: 'fresh',
      redaction_state: 'none',
      content_state: 'present',
      ingest_state: 'active',
      access_scope: { kind: 'board' },
      targets: {
        board_id: input.boardId,
        workspace_id: null,
        card_id: input.cardId,
        contract_ref: null,
        contract_version: null,
        contract_snapshot_sha256: null,
        job_id: null,
        profile_id: null,
        session_id: null,
        delivery_report_id: null,
      },
      provenance: {
        repository_key: `board:${input.boardId}`,
        base_commit_sha: repository.head,
        worktree_state_hash: null,
        relative_root: '.',
        adapter_id: 'conflict-resolution-promotion',
        adapter_version: '1.0.0',
        adapter_index_commit_sha: null,
        observed_at: input.reviewedAt,
      },
      created_at: input.reviewedAt,
      updated_at: input.reviewedAt,
    }
    const source: KnowledgeSource = {
      ...sourceWithoutId,
      id: knowledgeSourceId({
        repository_key: sourceWithoutId.provenance.repository_key,
        source_kind: sourceWithoutId.source_kind,
        normalized_locator: normalizedLocator,
        source_revision: sourceWithoutId.source_revision,
        content_sha256: sourceWithoutId.content_sha256,
      }),
    }
    const range = {
      start_line: null,
      end_line: null,
      start_byte: null,
      end_byte: null,
    }
    const chunkWithoutId: Omit<KnowledgeChunk, 'id'> = {
      source_id: source.id,
      ordinal: 0,
      content,
      content_sha256: input.sourceSha256,
      character_count: content.length,
      byte_count: Buffer.byteLength(content, 'utf8'),
      estimated_tokens: Math.max(1, Math.ceil(content.length / 4)),
      source_range: range,
      symbol: null,
      created_at: input.reviewedAt,
    }
    const chunk: KnowledgeChunk = {
      ...chunkWithoutId,
      id: knowledgeChunkId({
        source_id: source.id,
        ordinal: 0,
        content_sha256: input.sourceSha256,
        source_range: range,
      }),
    }
    this.store.putSource(source)
    this.store.putChunk(input.boardId, chunk)
    return { sourceId: source.id, chunkId: chunk.id, repositoryHeadSha: repository.head }
  }

  private repository(boardId: number): { root: string; head: string } {
    const board = this.db.prepare('SELECT project_path FROM boards WHERE id=?').get(boardId) as
      { project_path: string } | undefined
    if (!board) throw new Error('conflict knowledge board was not found')
    let root: string
    try {
      root = git(board.project_path, ['rev-parse', '--show-toplevel']).trim()
      if (fs.realpathSync(root) !== fs.realpathSync(board.project_path)) {
        throw new Error('repository root mismatch')
      }
    } catch {
      throw new Error('conflict knowledge repository evidence could not be verified')
    }
    const head = git(root, ['rev-parse', '--verify', 'HEAD']).trim()
    if (!COMMIT.test(head)) throw new Error('conflict knowledge repository head is invalid')
    return { root, head }
  }
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
    maxBuffer: 65_536,
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 15_000,
  })
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}
