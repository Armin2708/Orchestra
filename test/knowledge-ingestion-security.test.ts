import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openDb } from '../src/db.js'
import { knowledgeSourceId } from '../src/agent-os/knowledge-contracts.js'
import {
  MAX_REPOSITORY_DOCUMENT_BYTES,
  MAX_REPOSITORY_DOCUMENTS,
  MAX_REPOSITORY_DOCUMENT_TOTAL_BYTES,
  MAX_REPOSITORY_TRAVERSAL_DEPTH,
  MAX_REPOSITORY_TRAVERSAL_ENTRIES,
  RepositoryDocumentIngestionError,
  RepositoryDocumentIngestor,
  type RepositoryDocumentIngestionInput,
} from '../src/agent-os/knowledge-ingestion.js'
import { KnowledgeStore } from '../src/agent-os/knowledge-store.js'
import type { KnowledgeSource } from '../src/agent-os/knowledge-types.js'

const AT = '2026-07-26T18:00:00.000Z'
const LATER = '2026-07-26T19:00:00.000Z'
const SENTINEL = 'never-persist-repository-secret'
const API_KEY = 'never-persist-repository-api-key-123456'
const AWS_MARKER = ['AKIA', 'IOSFODNN7EXAMPLE'].join('')
const PRIVATE_KEY_BEGIN = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ')
const PRIVATE_KEY_END = ['-----END', 'PRIVATE KEY-----'].join(' ')
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

function gitInput(
  root: string,
  arguments_: readonly string[],
  input: string,
): string {
  return execFileSync(
    'git',
    ['-C', root, ...arguments_],
    {
      encoding: 'utf8',
      input,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  ).trim()
}

function write(root: string, relativePath: string, content: string | Buffer): void {
  const target = path.join(root, ...relativePath.split('/'))
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content)
}

function repository(seed = 'seed'): { root: string; head: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-kno002-sec-'))
  tempDirectories.push(root)
  git(root, ['init', '--initial-branch=main'])
  write(root, 'seed.txt', `${seed}\n`)
  git(root, ['add', 'seed.txt'])
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
    .run(boardId, root, `security ${boardId}`)
  return db
}

function input(
  root: string,
  head: string,
  overrides: Partial<RepositoryDocumentIngestionInput> = {},
): RepositoryDocumentIngestionInput {
  return {
    board_id: 1,
    repository_key: 'security-fixture',
    repository_root: root,
    workspace_root: root,
    base_commit_sha: head,
    observed_at: AT,
    ...overrides,
  }
}

function capturedError(operation: () => unknown): RepositoryDocumentIngestionError {
  try {
    operation()
  } catch (error) {
    expect(error).toBeInstanceOf(RepositoryDocumentIngestionError)
    return error as RepositoryDocumentIngestionError
  }
  throw new Error('expected repository document ingestion to fail')
}

describe('RepositoryDocumentIngestor security and failure boundaries', () => {
  it('redacts before every durable hash and never persists raw credential text', () => {
    const repo = repository()
    const original = [
      '# Security note',
      `api_key=${API_KEY}`,
      `password=${SENTINEL}`,
      PRIVATE_KEY_BEGIN,
      SENTINEL,
      PRIVATE_KEY_END,
      '',
    ].join('\n')
    write(repo.root, 'docs/security.md', original)
    const db = database(repo.root)

    const result = new RepositoryDocumentIngestor(db).ingest(
      input(repo.root, repo.head),
    )

    expect(result.sources).toHaveLength(1)
    expect(result.sources[0].redaction_state).toBe('redacted')
    expect(result.chunks[0].content).toContain('[REDACTED]')
    expect(result.chunks[0].content).not.toContain(API_KEY)
    expect(result.chunks[0].content).not.toContain(SENTINEL)
    const durable = JSON.stringify(
      db.prepare(`SELECT source.content_sha256, source.provenance_json,
          chunk.content, chunk.content_sha256
        FROM knowledge_sources source
        JOIN knowledge_chunks chunk
          ON chunk.board_id=source.board_id AND chunk.source_id=source.id`)
        .all(),
    )
    expect(durable).not.toContain(API_KEY)
    expect(durable).not.toContain(SENTINEL)
    const redactedHash = createHash('sha256')
      .update(result.chunks[0].content, 'utf8')
      .digest('hex')
    const originalHash = createHash('sha256')
      .update(original, 'utf8')
      .digest('hex')
    expect(result.sources[0].content_sha256).toBe(redactedHash)
    expect(result.sources[0].content_sha256).not.toBe(originalHash)
    expect(result.sources[0].provenance.worktree_state_hash).toBe(redactedHash)
  })

  it('replays secret rotations and BOM changes from normalized redacted ranges', () => {
    const repo = repository()
    const firstRaw = [
      '# Rotation',
      'api_key=short-secret-value',
      PRIVATE_KEY_BEGIN,
      'short-private-value',
      PRIVATE_KEY_END,
      '',
    ].join('\n')
    const secondRaw = [
      '# Rotation',
      'api_key=a-much-longer-secret-value-that-must-not-change-identity',
      PRIVATE_KEY_BEGIN,
      'longer-private-value-line-one',
      'longer-private-value-line-two',
      'longer-private-value-line-three',
      PRIVATE_KEY_END,
      '',
    ].join('\n')
    write(
      repo.root,
      'docs/rotation.md',
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(firstRaw)]),
    )
    const db = database(repo.root)
    const ingestor = new RepositoryDocumentIngestor(db)
    const first = ingestor.ingest(input(repo.root, repo.head))
    write(repo.root, 'docs/rotation.md', secondRaw)
    const second = ingestor.ingest(input(repo.root, repo.head, {
      observed_at: LATER,
    }))

    expect(first.chunks[0].content).toBe(
      '# Rotation\napi_key=[REDACTED]\n[REDACTED]\n',
    )
    expect(second.sources).toEqual(first.sources)
    expect(second.chunks).toEqual(first.chunks)
    expect(first.chunks[0].source_range).toEqual({
      start_line: 1,
      end_line: 3,
      start_byte: 0,
      end_byte: Buffer.byteLength(first.chunks[0].content, 'utf8'),
    })
    expect(
      db.prepare('SELECT COUNT(*) AS count FROM knowledge_sources').get(),
    ).toEqual({ count: 1 })
    expect(
      db.prepare('SELECT COUNT(*) AS count FROM knowledge_chunks').get(),
    ).toEqual({ count: 1 })
    const durable = JSON.stringify(
      db.prepare('SELECT * FROM knowledge_chunks').all(),
    )
    expect(durable).not.toContain('short-secret-value')
    expect(durable).not.toContain('longer-secret-value')
    expect(durable).not.toContain('private-value-line')
  })

  it('skips credential paths, hidden/vendor/generated content, links, invalid UTF-8, NUL, and oversized files', () => {
    const repo = repository()
    write(repo.root, 'AGENTS.md', '# Owned instructions\n')
    write(repo.root, 'README.md', '# Allowed\n')
    write(repo.root, 'secrets/README.md', `password=${SENTINEL}\n`)
    write(repo.root, 'docs/secrets.md', `${AWS_MARKER}\n`)
    write(repo.root, 'docs/credentials.md', `${AWS_MARKER}\n`)
    write(repo.root, 'docs/private-key.md', `${AWS_MARKER}\n`)
    write(repo.root, 'docs/service-account-prod.md', `${AWS_MARKER}\n`)
    write(repo.root, 'docs/team-secrets-backup.md', `${AWS_MARKER}\n`)
    write(repo.root, 'docs/team secrets backup.md', `${AWS_MARKER}\n`)
    write(repo.root, 'docs/private keys.md', `${AWS_MARKER}\n`)
    write(repo.root, 'docs/service account.md', `${AWS_MARKER}\n`)
    write(repo.root, 'docs/project.secret.notes.md', `${AWS_MARKER}\n`)
    write(repo.root, 'docs/token-diet.md', '# Legitimate token guidance\n')
    write(repo.root, '.private/README.md', `password=${SENTINEL}\n`)
    write(repo.root, 'vendor/package/README.md', `password=${SENTINEL}\n`)
    write(repo.root, 'generated/docs/README.md', `password=${SENTINEL}\n`)
    const dependencyRoots = [
      '__pypackages__',
      'bower_components',
      'Carthage',
      'obj',
      'Pods',
      'site-packages',
      'third-party',
      'third_party',
      'thirdparty',
      'venv',
    ]
    for (const dependencyRoot of dependencyRoots) {
      write(repo.root, `${dependencyRoot}/lib/AGENTS.md`, `${SENTINEL}\n`)
      write(repo.root, `${dependencyRoot}/lib/README.md`, `${SENTINEL}\n`)
    }
    write(repo.root, 'docs/invalid.md', Buffer.from([0xff, 0xfe, 0xfd]))
    write(repo.root, 'docs/nul.md', Buffer.from('prefix\u0000suffix', 'utf8'))
    write(repo.root, 'docs/large.md', 'x'.repeat(65))
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-kno002-link-'))
    tempDirectories.push(outside)
    write(outside, 'outside.md', `password=${SENTINEL}\n`)
    fs.symlinkSync(path.join(outside, 'outside.md'), path.join(repo.root, 'docs/link.md'))

    const db = database(repo.root)
    const result = new RepositoryDocumentIngestor(db).ingest(
      input(repo.root, repo.head, { max_file_bytes: 64 }),
    )

    expect(result.sources.map((source) => source.locator)).toEqual([
      'AGENTS.md',
      'README.md',
      'docs/token-diet.md',
    ])
    expect(result.skipped.credential_paths).toBe(10)
    expect(result.skipped.hidden_paths).toBeGreaterThanOrEqual(2)
    expect(result.skipped.excluded_directories).toBe(
      dependencyRoots.length + 2,
    )
    expect(result.skipped.symbolic_links).toBe(1)
    expect(result.skipped.invalid_text_files).toBe(2)
    expect(result.skipped.oversized_files).toBe(1)
    expect(JSON.stringify(db.prepare('SELECT * FROM knowledge_chunks').all()))
      .not.toContain(SENTINEL)
    expect(JSON.stringify(db.prepare('SELECT * FROM knowledge_sources').all()))
      .not.toContain(AWS_MARKER)
  })

  it('skips paths rejected by the durable locator contract without aborting valid docs', () => {
    const repo = repository()
    write(repo.root, 'README.md', '# Valid\n')
    for (const invalidPath of [
      'docs/C#-guide.md',
      'docs/why?.md',
      'docs/bad%ZZ.md',
      'docs/encoded%23fragment.md',
      'docs/nested%252fescape.md',
    ]) {
      write(repo.root, invalidPath, `# ${invalidPath}\n`)
    }
    const db = database(repo.root)

    const result = new RepositoryDocumentIngestor(db).ingest(
      input(repo.root, repo.head),
    )

    expect(result.sources.map((source) => source.locator)).toEqual(['README.md'])
    expect(result.skipped.unsafe_paths).toBe(5)
    expect(
      db.prepare('SELECT COUNT(*) AS count FROM knowledge_sources').get(),
    ).toEqual({ count: 1 })
  })

  it('stops at real submodule and ignored nested-repository boundaries', () => {
    const parent = repository('parent')
    const child = repository('child')
    write(child.root, 'README.md', `# Child\n${SENTINEL}\n`)
    write(child.root, 'AGENTS.md', `# Child instructions\n${SENTINEL}\n`)
    git(child.root, ['add', 'README.md', 'AGENTS.md'])
    git(child.root, [
      '-c',
      'user.name=Agentboard Test',
      '-c',
      'user.email=agentboard@example.invalid',
      'commit',
      '-m',
      'child docs',
    ])

    write(parent.root, 'README.md', '# Parent\n')
    write(parent.root, '.gitignore', 'sandbox/\n')
    git(parent.root, [
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'add',
      child.root,
      'modules/lib',
    ])
    git(parent.root, [
      'add',
      'README.md',
      '.gitignore',
      '.gitmodules',
      'modules/lib',
    ])
    git(parent.root, [
      '-c',
      'user.name=Agentboard Test',
      '-c',
      'user.email=agentboard@example.invalid',
      'commit',
      '-m',
      'parent with submodule',
    ])
    parent.head = git(parent.root, ['rev-parse', 'HEAD'])
    git(parent.root, ['rm', '--cached', '--force', 'modules/lib'])
    expect(git(parent.root, ['ls-files', '--stage', '--', 'modules/lib']))
      .toBe('')
    fs.rmSync(path.join(parent.root, 'modules/lib/.git'), { force: true })
    expect(fs.existsSync(path.join(parent.root, 'modules/lib/.git'))).toBe(false)

    const nestedRoot = path.join(parent.root, 'sandbox/nested')
    fs.mkdirSync(nestedRoot, { recursive: true })
    git(nestedRoot, ['init', '--initial-branch=main'])
    write(nestedRoot, 'README.md', `# Ignored child\n${SENTINEL}\n`)
    write(nestedRoot, 'AGENTS.md', `# Ignored instructions\n${SENTINEL}\n`)
    git(nestedRoot, ['add', 'README.md', 'AGENTS.md'])
    git(nestedRoot, [
      '-c',
      'user.name=Agentboard Test',
      '-c',
      'user.email=agentboard@example.invalid',
      'commit',
      '-m',
      'ignored nested docs',
    ])
    expect(git(parent.root, ['check-ignore', 'sandbox/nested/README.md']))
      .toBe('sandbox/nested/README.md')
    const db = database(parent.root)

    const result = new RepositoryDocumentIngestor(db).ingest(
      input(parent.root, parent.head),
    )

    expect(result.sources.map((source) => source.locator)).toEqual(['README.md'])
    expect(result.skipped.nested_repositories).toBe(2)
    expect(JSON.stringify(db.prepare('SELECT * FROM knowledge_sources').all()))
      .not.toContain(SENTINEL)
    expect(JSON.stringify(db.prepare('SELECT * FROM knowledge_chunks').all()))
      .not.toContain(SENTINEL)
  })

  it('stops at staged submodules absent from the base revision', () => {
    const parent = repository('parent')
    write(parent.root, 'README.md', '# Parent\n')
    git(parent.root, ['add', 'README.md'])
    git(parent.root, [
      '-c',
      'user.name=Agentboard Test',
      '-c',
      'user.email=agentboard@example.invalid',
      'commit',
      '-m',
      'parent docs',
    ])
    parent.head = git(parent.root, ['rev-parse', 'HEAD'])

    const child = repository('child')
    write(child.root, 'README.md', `# Staged child\n${SENTINEL}\n`)
    write(child.root, 'AGENTS.md', `# Staged instructions\n${SENTINEL}\n`)
    git(child.root, ['add', 'README.md', 'AGENTS.md'])
    git(child.root, [
      '-c',
      'user.name=Agentboard Test',
      '-c',
      'user.email=agentboard@example.invalid',
      'commit',
      '-m',
      'child docs',
    ])
    git(parent.root, [
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'add',
      child.root,
      'modules/new',
    ])
    fs.rmSync(path.join(parent.root, 'modules/new/.git'), { force: true })
    expect(git(parent.root, ['ls-files', '--stage', '--', 'modules/new']))
      .toMatch(/^160000 [a-f0-9]+ 0\tmodules\/new$/u)
    const db = database(parent.root)

    const result = new RepositoryDocumentIngestor(db).ingest(
      input(parent.root, parent.head),
    )

    expect(result.sources.map((source) => source.locator)).toEqual(['README.md'])
    expect(result.skipped.nested_repositories).toBe(1)
    expect(JSON.stringify(db.prepare('SELECT * FROM knowledge_sources').all()))
      .not.toContain(SENTINEL)
    expect(JSON.stringify(db.prepare('SELECT * FROM knowledge_chunks').all()))
      .not.toContain(SENTINEL)
  })

  it('treats every unmerged gitlink stage as a nested boundary', () => {
    const parent = repository('parent')
    write(parent.root, 'README.md', '# Parent\n')
    git(parent.root, ['add', 'README.md'])
    git(parent.root, [
      '-c',
      'user.name=Agentboard Test',
      '-c',
      'user.email=agentboard@example.invalid',
      'commit',
      '-m',
      'parent docs',
    ])
    parent.head = git(parent.root, ['rev-parse', 'HEAD'])
    write(
      parent.root,
      'modules/conflicted/README.md',
      `# Conflicted child\n${SENTINEL}\n`,
    )
    write(
      parent.root,
      'modules/conflicted/AGENTS.md',
      `# Conflicted instructions\n${SENTINEL}\n`,
    )
    gitInput(
      parent.root,
      ['update-index', '-z', '--index-info'],
      [
        `160000 ${parent.head} 2\tmodules/conflicted`,
        `160000 ${parent.head} 3\tmodules/conflicted`,
        '',
      ].join('\u0000'),
    )
    const indexEntries = git(parent.root, [
      'ls-files',
      '--stage',
      '--',
      'modules/conflicted',
    ])
    expect(indexEntries).toContain(' 2\tmodules/conflicted')
    expect(indexEntries).toContain(' 3\tmodules/conflicted')
    const db = database(parent.root)

    const result = new RepositoryDocumentIngestor(db).ingest(
      input(parent.root, parent.head),
    )

    expect(result.sources.map((source) => source.locator)).toEqual(['README.md'])
    expect(result.skipped.nested_repositories).toBe(1)
    expect(JSON.stringify(db.prepare('SELECT * FROM knowledge_sources').all()))
      .not.toContain(SENTINEL)
    expect(JSON.stringify(db.prepare('SELECT * FROM knowledge_chunks').all()))
      .not.toContain(SENTINEL)
  })

  it('stops at ignored nested bare-repository boundaries', () => {
    const parent = repository('parent')
    write(parent.root, 'README.md', '# Parent\n')
    write(parent.root, '.gitignore', 'sandbox/\n')
    const bareRoot = path.join(parent.root, 'sandbox/bare.git')
    fs.mkdirSync(bareRoot, { recursive: true })
    git(bareRoot, ['init', '--bare'])
    write(bareRoot, 'README.md', `# Bare child\n${SENTINEL}\n`)
    write(bareRoot, 'AGENTS.md', `# Bare instructions\n${SENTINEL}\n`)
    expect(git(parent.root, ['check-ignore', 'sandbox/bare.git/README.md']))
      .toBe('sandbox/bare.git/README.md')
    const db = database(parent.root)

    const result = new RepositoryDocumentIngestor(db).ingest(
      input(parent.root, parent.head),
    )

    expect(result.sources.map((source) => source.locator)).toEqual(['README.md'])
    expect(result.skipped.nested_repositories).toBe(1)
    expect(JSON.stringify(db.prepare('SELECT * FROM knowledge_sources').all()))
      .not.toContain(SENTINEL)
    expect(JSON.stringify(db.prepare('SELECT * FROM knowledge_chunks').all()))
      .not.toContain(SENTINEL)
  })

  it('skips locator-unsafe gitlinks without making safe parent docs unavailable', () => {
    const parent = repository('parent')
    const child = repository('child')
    write(child.root, 'README.md', `# Child\n${SENTINEL}\n`)
    git(child.root, ['add', 'README.md'])
    git(child.root, [
      '-c',
      'user.name=Agentboard Test',
      '-c',
      'user.email=agentboard@example.invalid',
      'commit',
      '-m',
      'child docs',
    ])

    write(parent.root, 'README.md', '# Parent\n')
    git(parent.root, [
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'add',
      child.root,
      'modules/C#lib',
    ])
    git(parent.root, ['add', 'README.md', '.gitmodules', 'modules/C#lib'])
    git(parent.root, [
      '-c',
      'user.name=Agentboard Test',
      '-c',
      'user.email=agentboard@example.invalid',
      'commit',
      '-m',
      'parent with locator-unsafe submodule',
    ])
    parent.head = git(parent.root, ['rev-parse', 'HEAD'])
    const db = database(parent.root)

    const result = new RepositoryDocumentIngestor(db).ingest(
      input(parent.root, parent.head),
    )

    expect(result.sources.map((source) => source.locator)).toEqual(['README.md'])
    expect(result.skipped.unsafe_paths).toBe(1)
    expect(JSON.stringify(db.prepare('SELECT * FROM knowledge_sources').all()))
      .not.toContain(SENTINEL)
    expect(JSON.stringify(db.prepare('SELECT * FROM knowledge_chunks').all()))
      .not.toContain(SENTINEL)
  })

  it('skips locator-unsafe staged gitlinks without aborting safe parent docs', () => {
    const parent = repository('parent')
    write(parent.root, 'README.md', '# Parent\n')
    git(parent.root, ['add', 'README.md'])
    git(parent.root, [
      '-c',
      'user.name=Agentboard Test',
      '-c',
      'user.email=agentboard@example.invalid',
      'commit',
      '-m',
      'parent docs',
    ])
    parent.head = git(parent.root, ['rev-parse', 'HEAD'])
    write(
      parent.root,
      'modules/C#new/README.md',
      `# Unsafe child\n${SENTINEL}\n`,
    )
    git(parent.root, [
      'update-index',
      '--add',
      '--cacheinfo',
      `160000,${parent.head},modules/C#new`,
    ])
    const db = database(parent.root)

    const result = new RepositoryDocumentIngestor(db).ingest(
      input(parent.root, parent.head),
    )

    expect(result.sources.map((source) => source.locator)).toEqual(['README.md'])
    expect(result.skipped.unsafe_paths).toBe(1)
    expect(JSON.stringify(db.prepare('SELECT * FROM knowledge_sources').all()))
      .not.toContain(SENTINEL)
    expect(JSON.stringify(db.prepare('SELECT * FROM knowledge_chunks').all()))
      .not.toContain(SENTINEL)
  })

  it('allows direct GitHub convention docs without opening other hidden trees', () => {
    const repo = repository()
    write(repo.root, '.github/CONTRIBUTING.md', '# GitHub conventions\n')
    write(repo.root, '.github/workflows/ci.yml', `secret=${SENTINEL}\n`)
    write(repo.root, '.github/actions/vendor/README.md', `${SENTINEL}\n`)
    write(repo.root, '.github/secrets.md', `${AWS_MARKER}\n`)
    write(repo.root, '.github/.env', `password=${SENTINEL}\n`)
    write(repo.root, '.other/CONTRIBUTING.md', `${SENTINEL}\n`)
    const db = database(repo.root)

    const result = new RepositoryDocumentIngestor(db).ingest(
      input(repo.root, repo.head),
    )

    expect(result.sources.map((source) => source.locator))
      .toEqual(['.github/CONTRIBUTING.md'])
    expect(result.skipped.excluded_directories).toBe(2)
    expect(result.skipped.credential_paths).toBe(1)
    expect(result.skipped.hidden_paths).toBeGreaterThanOrEqual(3)
    const durable = JSON.stringify(
      db.prepare('SELECT * FROM knowledge_chunks').all(),
    )
    expect(durable).not.toContain(SENTINEL)
    expect(durable).not.toContain(AWS_MARKER)
  })

  it('fails closed when board, repository, workspace, workspace record, or revision scope does not match', () => {
    const boardRepo = repository('board')
    const otherRepo = repository('other')
    write(boardRepo.root, 'README.md', '# Board\n')
    write(otherRepo.root, 'README.md', '# Other\n')
    const db = database(boardRepo.root)
    const ingestor = new RepositoryDocumentIngestor(db)

    expect(capturedError(() => ingestor.ingest(input(boardRepo.root, boardRepo.head, {
      board_id: 99,
    }))).code).toBe('board_not_found')
    expect(capturedError(() => ingestor.ingest(input(boardRepo.root, boardRepo.head, {
      repository_root: otherRepo.root,
    }))).code).toBe('repository_root_mismatch')
    expect(capturedError(() => ingestor.ingest(input(boardRepo.root, boardRepo.head, {
      workspace_root: otherRepo.root,
    }))).code).toBe('workspace_root_mismatch')
    expect(capturedError(() => ingestor.ingest(
      input(boardRepo.root, otherRepo.head),
    )).code).toBe('repository_revision_mismatch')
    expect(capturedError(() => ingestor.ingest(input(boardRepo.root, boardRepo.head, {
      workspace_id: 'missing-workspace',
    }))).code).toBe('workspace_root_mismatch')

    db.prepare(`INSERT INTO workspaces
      (id, board_id, name, kind, root_path, status)
      VALUES ('wrong-root', 1, 'wrong root', 'shared', ?, 'active')`)
      .run(otherRepo.root)
    expect(capturedError(() => ingestor.ingest(input(boardRepo.root, boardRepo.head, {
      workspace_id: 'wrong-root',
    }))).code).toBe('workspace_root_mismatch')

    expect(
      db.prepare('SELECT COUNT(*) AS count FROM knowledge_sources').get(),
    ).toEqual({ count: 0 })
  })

  it('requires registered external worktrees and isolates path-hash knowledge by workspace', () => {
    const repo = repository()
    const worktreeParent = fs.mkdtempSync(
      path.join(os.tmpdir(), 'agentboard-kno002-worktrees-'),
    )
    tempDirectories.push(worktreeParent)
    const firstRoot = path.join(worktreeParent, 'first')
    const secondRoot = path.join(worktreeParent, 'second')
    git(repo.root, ['worktree', 'add', '--detach', firstRoot, repo.head])
    git(repo.root, ['worktree', 'add', '--detach', secondRoot, repo.head])
    const content = '# Workspace-only instructions\n'
    write(firstRoot, 'AGENTS.md', content)
    write(secondRoot, 'AGENTS.md', content)
    const db = database(repo.root)
    const ingestor = new RepositoryDocumentIngestor(db)

    expect(capturedError(() => ingestor.ingest(input(
      repo.root,
      repo.head,
      { workspace_root: firstRoot },
    ))).code).toBe('workspace_root_mismatch')

    db.prepare(`INSERT INTO workspaces
      (id, board_id, name, kind, root_path, worktree_path, status)
      VALUES (?, 1, ?, 'worktree', ?, ?, 'active')`)
      .run('workspace-first', 'workspace first', repo.root, firstRoot)
    db.prepare(`INSERT INTO workspaces
      (id, board_id, name, kind, root_path, worktree_path, status)
      VALUES (?, 1, ?, 'worktree', ?, ?, 'active')`)
      .run('workspace-second', 'workspace second', repo.root, secondRoot)

    const first = ingestor.ingest(input(repo.root, repo.head, {
      workspace_root: firstRoot,
      workspace_id: 'workspace-first',
    }))
    const second = ingestor.ingest(input(repo.root, repo.head, {
      workspace_root: secondRoot,
      workspace_id: 'workspace-second',
    }))

    expect(first.sources[0]).toMatchObject({
      access_scope: {
        kind: 'workspace',
        workspace_id: 'workspace-first',
      },
      targets: {
        board_id: 1,
        workspace_id: 'workspace-first',
      },
    })
    expect(second.sources[0]).toMatchObject({
      access_scope: {
        kind: 'workspace',
        workspace_id: 'workspace-second',
      },
      targets: {
        board_id: 1,
        workspace_id: 'workspace-second',
      },
    })
    expect(second.sources[0].id).not.toBe(first.sources[0].id)
    expect(
      db.prepare('SELECT COUNT(*) AS count FROM knowledge_sources').get(),
    ).toEqual({ count: 2 })
  })

  it('rechecks board and workspace bindings inside the write transaction', () => {
    const boardRepo = repository('board binding')
    const otherRepo = repository('board rebound')
    write(boardRepo.root, 'README.md', '# Board binding\n')
    const boardDb = database(boardRepo.root)
    const originalReadSync = fs.readSync
    let boardRebound = false
    fs.readSync = ((
      descriptor: number,
      buffer: NodeJS.ArrayBufferView,
      offset: number,
      length: number,
      position: number | null,
    ): number => {
      const count = originalReadSync(
        descriptor,
        buffer,
        offset,
        length,
        position,
      )
      if (!boardRebound) {
        boardRebound = true
        boardDb.prepare('UPDATE boards SET project_path=? WHERE id=1')
          .run(otherRepo.root)
      }
      return count
    }) as typeof fs.readSync
    try {
      const error = capturedError(() =>
        new RepositoryDocumentIngestor(boardDb).ingest(
          input(boardRepo.root, boardRepo.head),
        ))
      expect(error.code).toBe('repository_root_mismatch')
      expect(
        boardDb.prepare('SELECT COUNT(*) AS count FROM knowledge_sources').get(),
      ).toEqual({ count: 0 })
    } finally {
      fs.readSync = originalReadSync
    }

    const workspaceRepo = repository('workspace binding')
    const displacedRepo = repository('workspace rebound')
    write(workspaceRepo.root, 'README.md', '# Workspace binding\n')
    const workspaceDb = database(workspaceRepo.root)
    workspaceDb.prepare(`INSERT INTO workspaces
      (id, board_id, name, kind, root_path, status)
      VALUES ('workspace-binding', 1, 'workspace binding',
        'shared', ?, 'active')`)
      .run(workspaceRepo.root)
    let workspaceRebound = false
    fs.readSync = ((
      descriptor: number,
      buffer: NodeJS.ArrayBufferView,
      offset: number,
      length: number,
      position: number | null,
    ): number => {
      const count = originalReadSync(
        descriptor,
        buffer,
        offset,
        length,
        position,
      )
      if (!workspaceRebound) {
        workspaceRebound = true
        workspaceDb.prepare(`UPDATE workspaces SET root_path=?
          WHERE id='workspace-binding'`).run(displacedRepo.root)
      }
      return count
    }) as typeof fs.readSync
    try {
      const error = capturedError(() =>
        new RepositoryDocumentIngestor(workspaceDb).ingest(input(
          workspaceRepo.root,
          workspaceRepo.head,
          { workspace_id: 'workspace-binding' },
        )))
      expect(error.code).toBe('workspace_root_mismatch')
      expect(
        workspaceDb.prepare('SELECT COUNT(*) AS count FROM knowledge_sources')
          .get(),
      ).toEqual({ count: 0 })
    } finally {
      fs.readSync = originalReadSync
    }
  })

  it('rejects malformed, accessor, proxy, extra-field, and unsafe-bound inputs without reflecting them', () => {
    const repo = repository()
    write(repo.root, 'README.md', '# Input\n')
    const db = database(repo.root)
    const ingestor = new RepositoryDocumentIngestor(db)
    const sentinelPath = path.join(repo.root, SENTINEL)

    const accessor = {
      ...input(repo.root, repo.head),
      get repository_root(): string {
        return sentinelPath
      },
    }
    const proxy = new Proxy(input(repo.root, repo.head), {
      getPrototypeOf() {
        throw new Error(SENTINEL)
      },
    })
    const extra = {
      ...input(repo.root, repo.head),
      credential: SENTINEL,
    } as RepositoryDocumentIngestionInput

    for (const supplied of [
      accessor,
      proxy,
      extra,
      input(repo.root, repo.head, { repository_root: 'relative/path' }),
      input(repo.root, repo.head, { max_file_bytes: 0 }),
      input(repo.root, repo.head, {
        max_file_bytes: MAX_REPOSITORY_DOCUMENT_BYTES + 1,
      }),
      input(repo.root, repo.head, {
        max_total_bytes: MAX_REPOSITORY_DOCUMENT_TOTAL_BYTES + 1,
      }),
      input(repo.root, repo.head, {
        max_documents: MAX_REPOSITORY_DOCUMENTS + 1,
      }),
      input(repo.root, repo.head, {
        max_traversal_depth: MAX_REPOSITORY_TRAVERSAL_DEPTH + 1,
      }),
      input(repo.root, repo.head, {
        max_traversal_entries: MAX_REPOSITORY_TRAVERSAL_ENTRIES + 1,
      }),
      input(repo.root, repo.head, {
        max_documents: '1' as unknown as number,
      }),
      input(repo.root, repo.head, { repository_key: 'Org/Repository' }),
      input(repo.root, repo.head, { repository_key: 'org/secrets' }),
      input(repo.root, repo.head, {
        repository_key: 'org/ghp_abcdefghijklmnop',
      }),
      input(repo.root, repo.head, { observed_at: 'not-a-timestamp' }),
      input(repo.root, repo.head, { base_commit_sha: 'ABC' }),
    ]) {
      const error = capturedError(() => ingestor.ingest(supplied))
      expect(error.code).toBe('invalid_input')
      expect(error.message).not.toContain(SENTINEL)
      expect(error.message).not.toContain(sentinelPath)
    }
  })

  it('remaps constructed, subclassed, forged, and proxied errors from hostile input', () => {
    const repo = repository()
    write(repo.root, 'README.md', '# Hostile reflection\n')
    const db = database(repo.root)
    const ingestor = new RepositoryDocumentIngestor(db)
    expect(Object.getOwnPropertyNames(RepositoryDocumentIngestor.prototype))
      .not.toContain('ingestInternal')
    const returned = capturedError(() => ingestor.ingest(
      input(repo.root, repo.head, { max_documents: 0 }),
    ))
    returned.message = SENTINEL
    Object.defineProperty(returned, 'cause', {
      value: SENTINEL,
      enumerable: true,
    })
    const constructed = new RepositoryDocumentIngestionError(
      'repository_unavailable',
    )
    constructed.message = SENTINEL
    Object.defineProperty(constructed, 'cause', {
      value: SENTINEL,
      enumerable: true,
    })
    class HostileSubclass extends RepositoryDocumentIngestionError {
      constructor() {
        super('repository_unavailable')
        this.message = SENTINEL
        Object.defineProperty(this, 'cause', { value: SENTINEL })
      }
    }
    const forged = Object.create(
      RepositoryDocumentIngestionError.prototype,
    ) as RepositoryDocumentIngestionError
    Object.defineProperties(forged, {
      code: { value: 'repository_unavailable', enumerable: true },
      message: { value: SENTINEL, enumerable: true },
      cause: { value: SENTINEL, enumerable: true },
    })
    const proxied = new Proxy(
      new RepositoryDocumentIngestionError('repository_unavailable'),
      {
        get() {
          throw new Error(SENTINEL)
        },
      },
    )

    for (const hostile of [
      constructed,
      new HostileSubclass(),
      forged,
      proxied,
      returned,
      SENTINEL,
    ]) {
      const supplied = new Proxy(input(repo.root, repo.head), {
        getPrototypeOf() {
          throw hostile
        },
      })
      const error = capturedError(() => ingestor.ingest(supplied))
      expect(error.code).toBe('invalid_input')
      expect(error.message).toBe(
        'repository document ingestion input is invalid',
      )
      expect(String(error.stack)).not.toContain(SENTINEL)
      expect(Object.hasOwn(error, 'cause')).toBe(false)
    }
  })

  it('rolls back earlier document writes when a later retained identity conflicts', () => {
    const repo = repository()
    const readme = '# Existing\n'
    const readmeHash = createHash('sha256').update(readme, 'utf8').digest('hex')
    write(repo.root, 'README.md', readme)
    const db = database(repo.root)
    const ingestor = new RepositoryDocumentIngestor(db)
    const sourceRevision = `path-sha256:${repo.head}:board:${readmeHash}`
    const conflictingSource: KnowledgeSource = {
      id: knowledgeSourceId({
        repository_key: 'security-fixture',
        source_kind: 'readme',
        normalized_locator: 'README.md',
        source_revision: sourceRevision,
        content_sha256: readmeHash,
      }),
      source_kind: 'readme',
      trust_class: 'reference',
      title: 'conflicting retained title',
      locator: 'README.md',
      normalized_locator: 'README.md',
      source_revision: sourceRevision,
      content_sha256: readmeHash,
      freshness_policy: 'path_hash',
      freshness_state: 'fresh',
      redaction_state: 'none',
      content_state: 'present',
      ingest_state: 'active',
      access_scope: { kind: 'board' },
      targets: {
        board_id: 1,
        workspace_id: null,
        card_id: null,
        contract_ref: null,
        contract_version: null,
        contract_snapshot_sha256: null,
        job_id: null,
        profile_id: null,
        session_id: null,
        delivery_report_id: null,
      },
      provenance: {
        repository_key: 'security-fixture',
        base_commit_sha: repo.head,
        worktree_state_hash: readmeHash,
        relative_root: '.',
        adapter_id: 'repository-document-ingestion',
        adapter_version: '1.0.0',
        adapter_index_commit_sha: null,
        observed_at: AT,
      },
      created_at: AT,
      updated_at: AT,
    }
    new KnowledgeStore(db).putSource(conflictingSource)
    write(repo.root, 'AGENTS.md', '# New instructions\n')

    const error = capturedError(() => ingestor.ingest(input(
      repo.root,
      repo.head,
      { observed_at: LATER },
    )))
    expect(error.code).toBe('persistence_conflict')
    expect(
      db.prepare('SELECT COUNT(*) AS count FROM knowledge_sources').get(),
    ).toEqual({ count: 1 })
    expect(
      db.prepare('SELECT COUNT(*) AS count FROM knowledge_chunks').get(),
    ).toEqual({ count: 0 })
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM knowledge_sources WHERE source_kind='agents'")
        .get(),
    ).toEqual({ count: 0 })
  })

  it('normalizes closed, corrupt, and hostile store failures at the public boundary', () => {
    const closedRepo = repository('closed database')
    write(closedRepo.root, 'README.md', '# Closed\n')
    const closedDb = database(closedRepo.root)
    closedDb.close()
    const closedError = capturedError(() =>
      new RepositoryDocumentIngestor(closedDb).ingest(
        input(closedRepo.root, closedRepo.head),
      ))
    expect(closedError.code).toBe('persistence_failed')
    expect(closedError.message).toBe(
      'repository document ingestion could not persist knowledge',
    )
    expect(String(closedError.stack)).not.toContain('connection is not open')
    expect(Object.hasOwn(closedError, 'cause')).toBe(false)

    const corruptRepo = repository('corrupt database')
    write(corruptRepo.root, 'README.md', '# Corrupt\n')
    const corruptDb = database(corruptRepo.root)
    corruptDb.exec('DROP TABLE knowledge_sources')
    const corruptError = capturedError(() =>
      new RepositoryDocumentIngestor(corruptDb).ingest(
        input(corruptRepo.root, corruptRepo.head),
      ))
    expect(corruptError.code).toBe('persistence_failed')
    expect(corruptError.message).toBe(
      'repository document ingestion could not persist knowledge',
    )
    expect(Object.hasOwn(corruptError, 'cause')).toBe(false)

    const hostileRepo = repository('hostile store')
    write(hostileRepo.root, 'README.md', '# Store\n')
    const hostileDb = database(hostileRepo.root)
    const storeFailure = new Error(SENTINEL)
    Object.defineProperty(storeFailure, 'cause', { value: SENTINEL })
    const putSource = vi.spyOn(KnowledgeStore.prototype, 'putSource')
      .mockImplementation(() => {
        throw storeFailure
      })
    try {
      const hostileError = capturedError(() =>
        new RepositoryDocumentIngestor(hostileDb).ingest(
          input(hostileRepo.root, hostileRepo.head),
        ))
      expect(hostileError.code).toBe('persistence_failed')
      expect(hostileError.message).toBe(
        'repository document ingestion could not persist knowledge',
      )
      expect(String(hostileError.stack)).not.toContain(SENTINEL)
      expect(Object.hasOwn(hostileError, 'cause')).toBe(false)
      expect(
        hostileDb.prepare('SELECT COUNT(*) AS count FROM knowledge_sources')
          .get(),
      ).toEqual({ count: 0 })
    } finally {
      putSource.mockRestore()
    }
  })

  it('normalizes a retained ordinal race to a fixed adapter conflict', () => {
    const repo = repository()
    write(repo.root, 'README.md', '# Ordinal race\n')
    const db = database(repo.root)
    const ingestor = new RepositoryDocumentIngestor(db)
    const first = ingestor.ingest(input(repo.root, repo.head))
    const displacedChunkId = `kc_${'f'.repeat(64)}`
    db.exec('DROP TRIGGER knowledge_chunks_immutable')
    db.prepare(`UPDATE knowledge_chunks SET id=?
      WHERE board_id=1 AND id=?`)
      .run(displacedChunkId, first.chunks[0].id)

    const error = capturedError(() => ingestor.ingest(input(
      repo.root,
      repo.head,
      { observed_at: LATER },
    )))

    expect(error.code).toBe('persistence_conflict')
    expect(error.message).toBe(
      'repository document ingestion conflicts with retained knowledge',
    )
    expect(Object.hasOwn(error, 'cause')).toBe(false)
    expect(
      db.prepare('SELECT COUNT(*) AS count FROM knowledge_chunks').get(),
    ).toEqual({ count: 1 })
  })

  it('returns fixed errors that do not expose supplied repository paths', () => {
    const repo = repository()
    const db = database(repo.root)
    const missing = path.join(repo.root, SENTINEL)
    const error = capturedError(() => new RepositoryDocumentIngestor(db).ingest(
      input(repo.root, repo.head, { workspace_root: missing }),
    ))

    expect(error.code).toBe('workspace_root_mismatch')
    expect(error.message).toBe(
      'repository document ingestion workspace root is outside the repository scope',
    )
    expect(error.message).not.toContain(SENTINEL)
    expect(error.message).not.toContain(repo.root)
  })

  it('fails closed when repository-wide traversal budgets are exceeded', () => {
    const scenarios: Array<{
      name: string
      arrange: (root: string) => void
      overrides: Partial<RepositoryDocumentIngestionInput>
    }> = [
      {
        name: 'document count',
        arrange(root) {
          write(root, 'README.md', '# One\n')
          write(root, 'docs/two.md', '# Two\n')
        },
        overrides: { max_documents: 1 },
      },
      {
        name: 'aggregate bytes',
        arrange(root) {
          write(root, 'README.md', 'a'.repeat(40))
          write(root, 'docs/two.md', 'b'.repeat(40))
        },
        overrides: {
          max_file_bytes: 64,
          max_total_bytes: 64,
        },
      },
      {
        name: 'traversal depth',
        arrange(root) {
          write(root, 'docs/nested/README.md', '# Nested\n')
        },
        overrides: { max_traversal_depth: 1 },
      },
      {
        name: 'traversal entries',
        arrange(root) {
          write(root, 'README.md', '# Entry\n')
        },
        overrides: { max_traversal_entries: 1 },
      },
    ]

    for (const scenario of scenarios) {
      const repo = repository(scenario.name)
      scenario.arrange(repo.root)
      const db = database(repo.root)
      const error = capturedError(() =>
        new RepositoryDocumentIngestor(db).ingest(
          input(repo.root, repo.head, scenario.overrides),
        ))

      expect(error.code, scenario.name).toBe('filesystem_read_failed')
      expect(
        db.prepare('SELECT COUNT(*) AS count FROM knowledge_sources').get(),
        scenario.name,
      ).toEqual({ count: 0 })
      expect(
        db.prepare('SELECT COUNT(*) AS count FROM knowledge_chunks').get(),
        scenario.name,
      ).toEqual({ count: 0 })
    }
  })

  it('detects a file that grows after its bounded size check', () => {
    const repo = repository()
    const target = path.join(repo.root, 'README.md')
    write(repo.root, 'README.md', '# Stable prefix\n')
    const db = database(repo.root)
    const originalReadSync = fs.readSync
    let mutated = false
    fs.readSync = ((
      descriptor: number,
      buffer: NodeJS.ArrayBufferView,
      offset: number,
      length: number,
      position: number | null,
    ): number => {
      if (!mutated) {
        mutated = true
        fs.appendFileSync(target, SENTINEL)
      }
      return originalReadSync(descriptor, buffer, offset, length, position)
    }) as typeof fs.readSync

    try {
      const error = capturedError(() =>
        new RepositoryDocumentIngestor(db).ingest(input(repo.root, repo.head)))
      expect(error.code).toBe('filesystem_read_failed')
      expect(
        db.prepare('SELECT COUNT(*) AS count FROM knowledge_sources').get(),
      ).toEqual({ count: 0 })
    } finally {
      fs.readSync = originalReadSync
    }
  })

  it('detects an ancestor directory swap before content can persist', () => {
    const repo = repository()
    const raceDirectory = path.join(repo.root, 'docs/race')
    const movedDirectory = path.join(repo.root, 'docs/race-original')
    const target = path.join(raceDirectory, 'README.md')
    write(repo.root, 'docs/race/README.md', '# Intended\n')
    const canonicalTarget = fs.realpathSync(target)
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-kno002-race-'))
    tempDirectories.push(outside)
    write(outside, 'README.md', `# Outside\n${SENTINEL}\n`)
    const db = database(repo.root)
    const originalOpenSync = fs.openSync
    let swapped = false
    fs.openSync = ((filePath: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
      if (!swapped && path.resolve(String(filePath)) === canonicalTarget) {
        swapped = true
        fs.renameSync(raceDirectory, movedDirectory)
        fs.symlinkSync(outside, raceDirectory)
      }
      return originalOpenSync(filePath, flags, mode)
    }) as typeof fs.openSync

    try {
      const error = capturedError(() =>
        new RepositoryDocumentIngestor(db).ingest(input(repo.root, repo.head)))
      expect(error.code).toBe('filesystem_read_failed')
      expect(
        JSON.stringify(db.prepare('SELECT * FROM knowledge_chunks').all()),
      ).not.toContain(SENTINEL)
    } finally {
      fs.openSync = originalOpenSync
      if (
        fs.existsSync(raceDirectory)
        && fs.lstatSync(raceDirectory).isSymbolicLink()
      ) {
        fs.unlinkSync(raceDirectory)
      }
      if (fs.existsSync(movedDirectory)) {
        fs.renameSync(movedDirectory, raceDirectory)
      }
    }
  })

  it('detects a nested Git boundary added after directory enumeration', () => {
    const repo = repository()
    write(repo.root, 'docs/README.md', '# Boundary race\n')
    const canonicalMarker = path.join(
      fs.realpathSync(path.join(repo.root, 'docs')),
      '.git',
    )
    const db = database(repo.root)
    const originalLstatSync = fs.lstatSync
    let markerChecks = 0
    fs.lstatSync = ((
      filePath: fs.PathLike,
      options?: {
        bigint?: boolean
        throwIfNoEntry?: boolean
      },
    ): unknown => {
      if (path.resolve(String(filePath)) === canonicalMarker) {
        markerChecks += 1
        if (markerChecks === 2) fs.mkdirSync(canonicalMarker)
      }
      return originalLstatSync(filePath, options as never)
    }) as typeof fs.lstatSync

    try {
      const error = capturedError(() =>
        new RepositoryDocumentIngestor(db).ingest(input(repo.root, repo.head)))
      expect(error.code).toBe('filesystem_read_failed')
      expect(
        db.prepare('SELECT COUNT(*) AS count FROM knowledge_sources').get(),
      ).toEqual({ count: 0 })
    } finally {
      fs.lstatSync = originalLstatSync
      fs.rmSync(canonicalMarker, { recursive: true, force: true })
    }
  })

  it('rolls back when a bare Git boundary appears after enumeration', () => {
    const repo = repository()
    write(repo.root, 'docs/README.md', '# Bare boundary race\n')
    const canonicalDirectory = fs.realpathSync(path.join(repo.root, 'docs'))
    const head = path.join(canonicalDirectory, 'HEAD')
    const objects = path.join(canonicalDirectory, 'objects')
    const refs = path.join(canonicalDirectory, 'refs')
    const db = database(repo.root)
    const putSource = vi.spyOn(KnowledgeStore.prototype, 'putSource')
    const originalLstatSync = fs.lstatSync
    let headChecks = 0
    fs.lstatSync = ((
      filePath: fs.PathLike,
      options?: {
        bigint?: boolean
        throwIfNoEntry?: boolean
      },
    ): unknown => {
      if (path.resolve(String(filePath)) === head) {
        headChecks += 1
        if (headChecks === 5) {
          fs.writeFileSync(head, 'ref: refs/heads/main\n')
          fs.mkdirSync(objects)
          fs.mkdirSync(refs)
        }
      }
      return originalLstatSync(filePath, options as never)
    }) as typeof fs.lstatSync

    try {
      const error = capturedError(() =>
        new RepositoryDocumentIngestor(db).ingest(input(repo.root, repo.head)))
      expect(error.code).toBe('filesystem_read_failed')
      expect(headChecks).toBe(5)
      expect(putSource).toHaveBeenCalled()
      expect(
        db.prepare('SELECT COUNT(*) AS count FROM knowledge_sources').get(),
      ).toEqual({ count: 0 })
      expect(
        db.prepare('SELECT COUNT(*) AS count FROM knowledge_chunks').get(),
      ).toEqual({ count: 0 })
    } finally {
      fs.lstatSync = originalLstatSync
      putSource.mockRestore()
      fs.rmSync(head, { force: true })
      fs.rmSync(objects, { recursive: true, force: true })
      fs.rmSync(refs, { recursive: true, force: true })
    }
  })

  it('rolls back when the index gains a gitlink during persistence', () => {
    const repo = repository()
    write(repo.root, 'README.md', '# Index boundary race\n')
    const db = database(repo.root)
    const originalPutSource = KnowledgeStore.prototype.putSource
    let mutated = false
    const putSource = vi.spyOn(KnowledgeStore.prototype, 'putSource')
      .mockImplementation(function (
        this: KnowledgeStore,
        source: KnowledgeSource,
      ): KnowledgeSource {
        const retained = originalPutSource.call(this, source)
        if (!mutated) {
          mutated = true
          git(repo.root, [
            'update-index',
            '--add',
            '--cacheinfo',
            `160000,${repo.head},modules/race`,
          ])
        }
        return retained
      })

    try {
      const error = capturedError(() =>
        new RepositoryDocumentIngestor(db).ingest(input(repo.root, repo.head)))
      expect(error.code).toBe('filesystem_read_failed')
      expect(mutated).toBe(true)
      expect(putSource).toHaveBeenCalled()
      expect(git(repo.root, ['ls-files', '--stage', '--', 'modules/race']))
        .toMatch(/^160000 [a-f0-9]+ 0\tmodules\/race$/u)
      expect(
        db.prepare('SELECT COUNT(*) AS count FROM knowledge_sources').get(),
      ).toEqual({ count: 0 })
      expect(
        db.prepare('SELECT COUNT(*) AS count FROM knowledge_chunks').get(),
      ).toEqual({ count: 0 })
    } finally {
      putSource.mockRestore()
    }
  })

  it('allows unrelated ordinary files to be staged during persistence', () => {
    const repo = repository()
    write(repo.root, 'README.md', '# Stable knowledge\n')
    write(repo.root, 'ordinary.bin', 'ordinary staged content\n')
    const db = database(repo.root)
    const originalPutSource = KnowledgeStore.prototype.putSource
    let staged = false
    const putSource = vi.spyOn(KnowledgeStore.prototype, 'putSource')
      .mockImplementation(function (
        this: KnowledgeStore,
        source: KnowledgeSource,
      ): KnowledgeSource {
        const retained = originalPutSource.call(this, source)
        if (!staged) {
          staged = true
          git(repo.root, ['add', 'ordinary.bin'])
        }
        return retained
      })

    try {
      const result = new RepositoryDocumentIngestor(db).ingest(
        input(repo.root, repo.head),
      )
      expect(result.sources.map((source) => source.locator))
        .toEqual(['README.md'])
      expect(staged).toBe(true)
      expect(putSource).toHaveBeenCalled()
      expect(git(repo.root, ['ls-files', '--error-unmatch', 'ordinary.bin']))
        .toBe('ordinary.bin')
      expect(
        db.prepare('SELECT COUNT(*) AS count FROM knowledge_sources').get(),
      ).toEqual({ count: 1 })
      expect(
        db.prepare('SELECT COUNT(*) AS count FROM knowledge_chunks').get(),
      ).toEqual({ count: 1 })
    } finally {
      putSource.mockRestore()
    }
  })

  it('rejects candidate documents with hard links outside the scan root', () => {
    const repo = repository()
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-kno002-hardlink-'))
    tempDirectories.push(outside)
    write(outside, 'shared.md', `# Shared\n${SENTINEL}\n`)
    fs.mkdirSync(path.join(repo.root, 'docs'), { recursive: true })
    fs.linkSync(
      path.join(outside, 'shared.md'),
      path.join(repo.root, 'docs/shared.md'),
    )
    const db = database(repo.root)

    const error = capturedError(() =>
      new RepositoryDocumentIngestor(db).ingest(input(repo.root, repo.head)))

    expect(error.code).toBe('filesystem_read_failed')
    expect(
      JSON.stringify(db.prepare('SELECT * FROM knowledge_chunks').all()),
    ).not.toContain(SENTINEL)
  })

  it('rejects a repository revision that changes after scanning', () => {
    const repo = repository()
    write(repo.root, 'revision-race.txt', 'changed\n')
    git(repo.root, ['add', 'revision-race.txt'])
    git(repo.root, [
      '-c',
      'user.name=Agentboard Test',
      '-c',
      'user.email=agentboard@example.invalid',
      'commit',
      '-m',
      'prepare moved head',
    ])
    const movedHead = git(repo.root, ['rev-parse', 'HEAD'])
    git(repo.root, ['reset', '--hard', repo.head])
    write(repo.root, 'README.md', '# Revision race\n')
    const db = database(repo.root)
    const originalReadSync = fs.readSync
    let committed = false
    fs.readSync = ((
      descriptor: number,
      buffer: NodeJS.ArrayBufferView,
      offset: number,
      length: number,
      position: number | null,
    ): number => {
      const count = originalReadSync(
        descriptor,
        buffer,
        offset,
        length,
        position,
      )
      if (!committed) {
        committed = true
        git(repo.root, ['update-ref', 'HEAD', movedHead])
      }
      return count
    }) as typeof fs.readSync

    try {
      const error = capturedError(() =>
        new RepositoryDocumentIngestor(db).ingest(input(repo.root, repo.head)))
      expect(error.code).toBe('repository_revision_mismatch')
      expect(
        db.prepare('SELECT COUNT(*) AS count FROM knowledge_sources').get(),
      ).toEqual({ count: 0 })
    } finally {
      fs.readSync = originalReadSync
    }
  })

  it('isolates Git inspection from caller-supplied Git environment variables', () => {
    const repo = repository('intended')
    const otherRepo = repository('environment redirect')
    write(repo.root, 'README.md', '# Intended repository\n')
    const db = database(repo.root)
    const originalGitDirectory = process.env.GIT_DIR
    const originalGitWorkTree = process.env.GIT_WORK_TREE
    const originalGitConfig = process.env.GIT_CONFIG_GLOBAL
    process.env.GIT_DIR = path.join(otherRepo.root, '.git')
    process.env.GIT_WORK_TREE = otherRepo.root
    process.env.GIT_CONFIG_GLOBAL = path.join(otherRepo.root, SENTINEL)

    try {
      const result = new RepositoryDocumentIngestor(db).ingest(
        input(repo.root, repo.head),
      )
      expect(result.sources.map((source) => source.locator))
        .toEqual(['README.md'])
      expect(result.base_commit_sha).toBe(repo.head)
    } finally {
      if (originalGitDirectory === undefined) delete process.env.GIT_DIR
      else process.env.GIT_DIR = originalGitDirectory
      if (originalGitWorkTree === undefined) delete process.env.GIT_WORK_TREE
      else process.env.GIT_WORK_TREE = originalGitWorkTree
      if (originalGitConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL
      else process.env.GIT_CONFIG_GLOBAL = originalGitConfig
    }
  })

  it('does not execute a repository-local fsmonitor command', () => {
    const repo = repository()
    write(repo.root, 'README.md', '# Safe inspection\n')
    const hookRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'agentboard-kno002-fsmonitor-'),
    )
    tempDirectories.push(hookRoot)
    const hook = path.join(hookRoot, 'hostile-fsmonitor')
    const marker = path.join(hookRoot, 'executed')
    fs.writeFileSync(
      hook,
      [
        '#!/bin/sh',
        'marker="${0%/*}/executed"',
        ': > "$marker"',
        "printf '\\n'",
        '',
      ].join('\n'),
    )
    fs.chmodSync(hook, 0o700)
    git(repo.root, ['config', 'core.fsmonitor', hook])
    git(repo.root, ['ls-files', '--stage'])
    expect(fs.existsSync(marker)).toBe(true)
    git(repo.root, ['update-index', '--no-fsmonitor'])
    fs.rmSync(marker, { force: true })
    const db = database(repo.root)

    const result = new RepositoryDocumentIngestor(db).ingest(
      input(repo.root, repo.head),
    )

    expect(result.sources.map((source) => source.locator))
      .toEqual(['README.md'])
    expect(fs.existsSync(marker)).toBe(false)
  })

  it('preserves legal trailing spaces in repository and worktree roots', () => {
    const repositoryContainer = fs.mkdtempSync(
      path.join(os.tmpdir(), 'agentboard-kno002-spaced-repo-'),
    )
    tempDirectories.push(repositoryContainer)
    const spacedRepositoryRoot = path.join(repositoryContainer, 'repo ')
    fs.mkdirSync(spacedRepositoryRoot)
    git(spacedRepositoryRoot, ['init', '--initial-branch=main'])
    write(spacedRepositoryRoot, 'seed.txt', 'seed\n')
    write(spacedRepositoryRoot, 'README.md', '# Spaced repository\n')
    git(spacedRepositoryRoot, ['add', 'seed.txt', 'README.md'])
    git(spacedRepositoryRoot, [
      '-c',
      'user.name=Agentboard Test',
      '-c',
      'user.email=agentboard@example.invalid',
      'commit',
      '-m',
      'spaced repository',
    ])
    const spacedRepositoryHead = git(
      spacedRepositoryRoot,
      ['rev-parse', 'HEAD'],
    )
    const repositoryDb = database(spacedRepositoryRoot)
    const repositoryResult = new RepositoryDocumentIngestor(repositoryDb).ingest(
      input(spacedRepositoryRoot, spacedRepositoryHead),
    )
    expect(repositoryResult.sources.map((source) => source.locator))
      .toEqual(['README.md'])

    const repo = repository('spaced worktree')
    const worktreeContainer = fs.mkdtempSync(
      path.join(os.tmpdir(), 'agentboard-kno002-spaced-worktree-'),
    )
    tempDirectories.push(worktreeContainer)
    const spacedWorktreeRoot = path.join(worktreeContainer, 'worktree ')
    git(repo.root, [
      'worktree',
      'add',
      '--detach',
      spacedWorktreeRoot,
      repo.head,
    ])
    write(spacedWorktreeRoot, 'AGENTS.md', '# Spaced worktree\n')
    const worktreeDb = database(repo.root)
    worktreeDb.prepare(`INSERT INTO workspaces
      (id, board_id, name, kind, root_path, worktree_path, status)
      VALUES ('spaced-worktree', 1, 'spaced worktree', 'worktree',
        ?, ?, 'active')`)
      .run(repo.root, spacedWorktreeRoot)

    const worktreeResult = new RepositoryDocumentIngestor(worktreeDb).ingest(
      input(repo.root, repo.head, {
        workspace_id: 'spaced-worktree',
        workspace_root: spacedWorktreeRoot,
      }),
    )
    expect(worktreeResult.sources.map((source) => source.locator))
      .toEqual(['AGENTS.md'])
  })

  it('does not let Git replacement refs forge commit-exact provenance', () => {
    const repo = repository()
    const original = '# Original commit bytes\n'
    const replacement = '# Replacement workspace bytes\n'
    write(repo.root, 'README.md', original)
    git(repo.root, ['add', 'README.md'])
    git(repo.root, [
      '-c',
      'user.name=Agentboard Test',
      '-c',
      'user.email=agentboard@example.invalid',
      'commit',
      '-m',
      'original readme',
    ])
    const originalHead = git(repo.root, ['rev-parse', 'HEAD'])
    write(repo.root, 'README.md', replacement)
    git(repo.root, ['add', 'README.md'])
    git(repo.root, [
      '-c',
      'user.name=Agentboard Test',
      '-c',
      'user.email=agentboard@example.invalid',
      'commit',
      '-m',
      'replacement readme',
    ])
    const replacementHead = git(repo.root, ['rev-parse', 'HEAD'])
    git(repo.root, ['reset', '--hard', originalHead])
    write(repo.root, 'README.md', replacement)
    git(repo.root, ['replace', originalHead, replacementHead])
    const db = database(repo.root)
    const replacementHash = createHash('sha256')
      .update(replacement, 'utf8')
      .digest('hex')

    const result = new RepositoryDocumentIngestor(db).ingest(
      input(repo.root, originalHead),
    )

    expect(result.sources[0]).toMatchObject({
      freshness_policy: 'path_hash',
      source_revision: `path-sha256:${originalHead}:board:${replacementHash}`,
      provenance: {
        base_commit_sha: originalHead,
        worktree_state_hash: replacementHash,
      },
    })
  })

  it('keeps Git-normalized CRLF bytes path-hashed without executing filters', () => {
    const repo = repository()
    write(
      repo.root,
      '.gitattributes',
      'README.md text eol=lf filter=sentinel\n',
    )
    write(repo.root, 'README.md', '# Canonical LF\n')
    git(repo.root, ['add', '.gitattributes', 'README.md'])
    git(repo.root, [
      '-c',
      'user.name=Agentboard Test',
      '-c',
      'user.email=agentboard@example.invalid',
      'commit',
      '-m',
      'track normalized readme',
    ])
    repo.head = git(repo.root, ['rev-parse', 'HEAD'])
    const crlfContent = '# Canonical LF\r\n'
    write(repo.root, 'README.md', crlfContent)
    expect(git(repo.root, ['diff', '--exit-code', '--', 'README.md'])).toBe('')
    const filterMarker = path.join(repo.root, 'filter-was-executed')
    git(repo.root, [
      'config',
      'filter.sentinel.smudge',
      `touch '${filterMarker}'; cat`,
    ])
    const db = database(repo.root)

    const result = new RepositoryDocumentIngestor(db).ingest(
      input(repo.root, repo.head),
    )

    expect(result.sources[0]).toMatchObject({
      freshness_policy: 'path_hash',
      source_revision:
        `path-sha256:${repo.head}:board:${createHash('sha256').update(crlfContent).digest('hex')}`,
    })
    expect(fs.existsSync(filterMarker)).toBe(false)
  })
})
