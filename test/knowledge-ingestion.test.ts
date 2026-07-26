import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { openDb } from '../src/db.js'
import {
  RepositoryDocumentIngestor,
  type RepositoryDocumentIngestionInput,
} from '../src/agent-os/index.js'

const AT = '2026-07-26T16:00:00.000Z'
const LATER = '2026-07-26T17:00:00.000Z'
const SECRET = 'repository-document-secret-123456'
const tempDirectories: string[] = []
const databases: Database.Database[] = []

afterEach(() => {
  for (const db of databases.splice(0)) {
    if (db.open) db.close()
  }
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

function git(root: string, arguments_: readonly string[]): string {
  return execFileSync(
    'git',
    ['-C', root, ...arguments_],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  ).trim()
}

function write(root: string, relativePath: string, content: string | Buffer): void {
  const target = path.join(root, ...relativePath.split('/'))
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content)
}

function repository(): { root: string; head: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-kno002-'))
  tempDirectories.push(root)
  git(root, ['init', '--initial-branch=main'])
  write(root, '.gitignore', 'AGENTS.md\n')
  write(root, 'seed.txt', 'repository seed\n')
  git(root, ['add', '.gitignore', 'seed.txt'])
  git(root, [
    '-c',
    'user.name=Agentboard Test',
    '-c',
    'user.email=agentboard@example.invalid',
    'commit',
    '-m',
    'seed',
  ])
  return { root, head: git(root, ['rev-parse', 'HEAD']) }
}

function database(root: string, boardId = 1): Database.Database {
  const db = openDb(':memory:')
  databases.push(db)
  db.prepare('INSERT INTO boards (id, project_path, name) VALUES (?, ?, ?)')
    .run(boardId, root, `knowledge ${boardId}`)
  return db
}

function input(
  root: string,
  head: string,
  overrides: Partial<RepositoryDocumentIngestionInput> = {},
): RepositoryDocumentIngestionInput {
  return {
    board_id: 1,
    repository_key: 'fixture-repository',
    repository_root: root,
    workspace_root: root,
    base_commit_sha: head,
    observed_at: AT,
    max_file_bytes: 256,
    ...overrides,
  }
}

const hash = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex')

describe('RepositoryDocumentIngestor', () => {
  it('explicitly ingests the bounded repository-document allowlist with provenance', () => {
    const repo = repository()
    write(repo.root, 'ADR-0001.md', '# Decision\nUse durable records.\n')
    write(repo.root, 'AGENTS.md', `# Agent rules\napi_key=${SECRET}\n`)
    write(repo.root, 'CONTRIBUTING.md', '# Contributing\nUse focused changes.\n')
    write(repo.root, 'README.md', '# Fixture\nRepository guide.\n')
    write(repo.root, 'conventions/style.md', '# Style\nPrefer clarity.\n')
    write(repo.root, 'docs/architecture/overview.md', '# Architecture\nLayered.\n')
    write(repo.root, 'docs/guide.md', '# Guide\nOperator notes.\n')
    git(repo.root, ['add', 'README.md'])
    git(repo.root, [
      '-c',
      'user.name=Agentboard Test',
      '-c',
      'user.email=agentboard@example.invalid',
      'commit',
      '-m',
      'track readme',
    ])
    repo.head = git(repo.root, ['rev-parse', 'HEAD'])

    write(repo.root, '.hidden/docs/README.md', '# hidden\n')
    write(repo.root, 'credentials/README.md', `password=${SECRET}\n`)
    write(repo.root, 'dist/docs/README.md', '# built\n')
    write(repo.root, 'node_modules/package/README.md', '# dependency\n')
    write(repo.root, 'docs/invalid.md', Buffer.from([0xc3, 0x28]))
    write(repo.root, 'docs/empty.md', '')
    write(repo.root, 'docs/large.md', 'x'.repeat(300))
    write(repo.root, 'src/index.ts', 'export const value = true\n')
    write(repo.root, 'NOTES.md', '# unrelated root note\n')
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-kno002-outside-'))
    tempDirectories.push(outside)
    write(outside, 'escape.md', `token=${SECRET}\n`)
    fs.symlinkSync(path.join(outside, 'escape.md'), path.join(repo.root, 'docs/escape.md'))

    expect(git(repo.root, ['check-ignore', 'AGENTS.md'])).toBe('AGENTS.md')

    const db = database(repo.root)
    const result = new RepositoryDocumentIngestor(db).ingest(
      input(repo.root, repo.head),
    )

    expect(result.sources.map((source) => source.locator)).toEqual([
      'ADR-0001.md',
      'AGENTS.md',
      'CONTRIBUTING.md',
      'README.md',
      'conventions/style.md',
      'docs/architecture/overview.md',
      'docs/guide.md',
    ])
    expect(result.sources.map((source) => source.source_kind)).toEqual([
      'architecture',
      'agents',
      'convention',
      'readme',
      'convention',
      'architecture',
      'documentation',
    ])
    expect(result.sources.find((source) => source.source_kind === 'agents'))
      .toMatchObject({
        trust_class: 'instruction',
        freshness_policy: 'path_hash',
        freshness_state: 'fresh',
        redaction_state: 'redacted',
        content_state: 'present',
        ingest_state: 'active',
        access_scope: { kind: 'board' },
        targets: { board_id: 1, workspace_id: null },
        provenance: {
          repository_key: 'fixture-repository',
          base_commit_sha: repo.head,
          relative_root: '.',
          adapter_id: 'repository-document-ingestion',
          adapter_version: '1.0.0',
          adapter_index_commit_sha: null,
          observed_at: AT,
        },
      })
    const readmeSource = result.sources.find(
      (source) => source.locator === 'README.md',
    )
    expect(readmeSource).toMatchObject({
      source_revision: repo.head,
      freshness_policy: 'commit_exact',
      provenance: {
        base_commit_sha: repo.head,
        worktree_state_hash: null,
      },
    })

    const agentsIndex = result.sources.findIndex(
      (source) => source.source_kind === 'agents',
    )
    const agentsSource = result.sources[agentsIndex]
    const agentsChunk = result.chunks[agentsIndex]
    expect(agentsChunk.ordinal).toBe(0)
    expect(agentsChunk.symbol).toBeNull()
    expect(agentsChunk.content).toContain('api_key=[REDACTED]')
    expect(agentsChunk.content).not.toContain(SECRET)
    expect(agentsSource.content_sha256).toBe(hash(agentsChunk.content))
    expect(agentsSource.source_revision)
      .toBe(`path-sha256:${repo.head}:board:${agentsSource.content_sha256}`)
    expect(agentsSource.provenance.worktree_state_hash)
      .toBe(agentsSource.content_sha256)
    expect(agentsChunk.content_sha256).toBe(agentsSource.content_sha256)
    expect(agentsChunk.source_range).toEqual({
      start_line: 1,
      end_line: 2,
      start_byte: 0,
      end_byte: Buffer.byteLength(agentsChunk.content, 'utf8'),
    })
    expect(agentsChunk.character_count).toBe(agentsChunk.content.length)
    expect(agentsChunk.byte_count)
      .toBe(Buffer.byteLength(agentsChunk.content, 'utf8'))
    expect(agentsChunk.estimated_tokens)
      .toBe(Math.ceil(agentsChunk.content.length / 4))

    expect(result.totals).toMatchObject({
      ingested_files: 7,
      redacted_files: 1,
    })
    expect(result.skipped.hidden_paths).toBeGreaterThanOrEqual(2)
    expect(result.skipped.excluded_directories).toBe(2)
    expect(result.skipped.credential_paths).toBe(1)
    expect(result.skipped.symbolic_links).toBe(1)
    expect(result.skipped.invalid_text_files).toBe(1)
    expect(result.skipped.empty_files).toBe(1)
    expect(result.skipped.oversized_files).toBe(1)
    expect(result.skipped.unsupported_files).toBeGreaterThanOrEqual(3)
    expect(result.totals.skipped_paths)
      .toBe(Object.values(result.skipped).reduce((sum, value) => sum + value, 0))

    expect(
      db.prepare('SELECT COUNT(*) AS count FROM knowledge_sources')
        .get(),
    ).toEqual({ count: 7 })
    expect(
      db.prepare('SELECT COUNT(*) AS count FROM knowledge_chunks')
        .get(),
    ).toEqual({ count: 7 })
  })

  it('uses path-hash provenance for a dirty tracked document', () => {
    const repo = repository()
    write(repo.root, 'README.md', '# Committed\n')
    git(repo.root, ['add', 'README.md'])
    git(repo.root, [
      '-c',
      'user.name=Agentboard Test',
      '-c',
      'user.email=agentboard@example.invalid',
      'commit',
      '-m',
      'track readme',
    ])
    repo.head = git(repo.root, ['rev-parse', 'HEAD'])
    const dirtyContent = '# Dirty workspace\n'
    write(repo.root, 'README.md', dirtyContent)
    const db = database(repo.root)

    const result = new RepositoryDocumentIngestor(db).ingest(
      input(repo.root, repo.head),
    )

    expect(result.sources[0]).toMatchObject({
      source_revision: `path-sha256:${repo.head}:board:${hash(dirtyContent)}`,
      freshness_policy: 'path_hash',
      provenance: {
        base_commit_sha: repo.head,
        worktree_state_hash: hash(dirtyContent),
      },
    })
  })

  it('classifies common architecture-note and convention filename variants', () => {
    const repo = repository()
    write(repo.root, 'ARCHITECTURE_NOTES.md', '# Architecture notes\n')
    write(repo.root, 'architecture-notes.md', '# More architecture notes\n')
    write(repo.root, 'coding_standards.md', '# Coding standards\n')
    write(repo.root, 'CONVENTIONS.md', '# Conventions\n')
    write(repo.root, 'STYLE_GUIDE.md', '# Style guide\n')
    write(repo.root, 'NOTES.md', '# Unrelated notes\n')
    write(repo.root, 'CLAUDE.md', '# Provider-specific instructions\n')
    const db = database(repo.root)

    const result = new RepositoryDocumentIngestor(db).ingest(
      input(repo.root, repo.head),
    )

    expect(result.sources.map((source) => [
      source.locator,
      source.source_kind,
    ])).toEqual([
      ['ARCHITECTURE_NOTES.md', 'architecture'],
      ['CONVENTIONS.md', 'convention'],
      ['STYLE_GUIDE.md', 'convention'],
      ['architecture-notes.md', 'architecture'],
      ['coding_standards.md', 'convention'],
    ])
  })

  it('creates a new path-hash identity when HEAD advances without changing an ignored document', () => {
    const repo = repository()
    const agentsContent = '# Stable ignored instructions\n'
    write(repo.root, 'AGENTS.md', agentsContent)
    const db = database(repo.root)
    const ingestor = new RepositoryDocumentIngestor(db)
    const first = ingestor.ingest(input(repo.root, repo.head))

    write(repo.root, 'seed.txt', 'repository seed changed\n')
    git(repo.root, ['add', 'seed.txt'])
    git(repo.root, [
      '-c',
      'user.name=Agentboard Test',
      '-c',
      'user.email=agentboard@example.invalid',
      'commit',
      '-m',
      'advance unrelated head',
    ])
    const laterHead = git(repo.root, ['rev-parse', 'HEAD'])
    const second = ingestor.ingest(input(repo.root, laterHead, {
      observed_at: LATER,
    }))

    expect(first.sources[0].freshness_policy).toBe('path_hash')
    expect(second.sources[0]).toMatchObject({
      source_revision: `path-sha256:${laterHead}:board:${hash(agentsContent)}`,
      freshness_policy: 'path_hash',
      provenance: {
        base_commit_sha: laterHead,
        worktree_state_hash: hash(agentsContent),
      },
    })
    expect(second.sources[0].id).not.toBe(first.sources[0].id)
    expect(
      db.prepare('SELECT COUNT(*) AS count FROM knowledge_sources').get(),
    ).toEqual({ count: 2 })
  })

  it('replays unchanged documents idempotently even when observed later', () => {
    const repo = repository()
    write(repo.root, 'README.md', '# Replay\nSame content.\n')
    const db = database(repo.root)
    const ingestor = new RepositoryDocumentIngestor(db)

    const first = ingestor.ingest(input(repo.root, repo.head))
    const replay = ingestor.ingest(input(repo.root, repo.head, {
      observed_at: LATER,
    }))

    expect(replay.sources).toEqual(first.sources)
    expect(replay.chunks).toEqual(first.chunks)
    expect(replay.sources[0].created_at).toBe(AT)
    expect(replay.sources[0].provenance.observed_at).toBe(AT)
    expect(
      db.prepare('SELECT COUNT(*) AS count FROM knowledge_sources').get(),
    ).toEqual({ count: 1 })
    expect(
      db.prepare('SELECT COUNT(*) AS count FROM knowledge_chunks').get(),
    ).toEqual({ count: 1 })
  })

  it('produces deterministic identities and ordering across databases', () => {
    const repo = repository()
    write(repo.root, 'README.md', '# Deterministic\n')
    write(repo.root, 'docs/z-last.md', '# Z\n')
    write(repo.root, 'docs/a-first.md', '# A\n')
    const firstDb = database(repo.root, 1)
    const secondDb = database(repo.root, 2)

    const first = new RepositoryDocumentIngestor(firstDb).ingest(
      input(repo.root, repo.head, { board_id: 1 }),
    )
    const second = new RepositoryDocumentIngestor(secondDb).ingest(
      input(repo.root, repo.head, { board_id: 2 }),
    )

    expect(first.sources.map((source) => source.locator)).toEqual([
      'README.md',
      'docs/a-first.md',
      'docs/z-last.md',
    ])
    expect(second.sources.map((source) => source.id))
      .toEqual(first.sources.map((source) => source.id))
    expect(second.chunks.map((chunk) => chunk.id))
      .toEqual(first.chunks.map((chunk) => chunk.id))
    expect(second.sources.every((source) => source.targets.board_id === 2))
      .toBe(true)
  })

  it('accepts only a workspace record whose execution root matches the scan root', () => {
    const repo = repository()
    write(repo.root, 'README.md', '# Workspace\n')
    git(repo.root, ['add', 'README.md'])
    git(repo.root, [
      '-c',
      'user.name=Agentboard Test',
      '-c',
      'user.email=agentboard@example.invalid',
      'commit',
      '-m',
      'track workspace readme',
    ])
    repo.head = git(repo.root, ['rev-parse', 'HEAD'])
    const localAgents = '# Workspace-local instructions\n'
    write(repo.root, 'AGENTS.md', localAgents)
    const db = database(repo.root)
    db.prepare(`INSERT INTO workspaces
      (id, board_id, name, kind, root_path, status)
      VALUES (?, 1, ?, 'shared', ?, 'active')`)
      .run('workspace-one', 'workspace one', repo.root)

    const result = new RepositoryDocumentIngestor(db).ingest(
      input(repo.root, repo.head, { workspace_id: 'workspace-one' }),
    )
    const replay = new RepositoryDocumentIngestor(db).ingest(
      input(repo.root, repo.head, {
        workspace_id: 'workspace-one',
        observed_at: LATER,
      }),
    )

    expect(result.totals.ingested_files).toBe(2)
    expect(replay.sources).toEqual(result.sources)
    expect(replay.chunks).toEqual(result.chunks)
    expect(result.sources.find((source) => source.locator === 'AGENTS.md'))
      .toMatchObject({
      access_scope: {
        kind: 'workspace',
        workspace_id: 'workspace-one',
      },
      targets: {
        board_id: 1,
        workspace_id: 'workspace-one',
      },
      source_revision:
        `path-sha256:${repo.head}:workspace-${hash('workspace-one')}:${hash(localAgents)}`,
    })
    expect(result.sources.find((source) => source.locator === 'README.md'))
      .toMatchObject({
        access_scope: { kind: 'board' },
        targets: {
          board_id: 1,
          workspace_id: null,
        },
        freshness_policy: 'commit_exact',
        source_revision: repo.head,
    })
  })
})
