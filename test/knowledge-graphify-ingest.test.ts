import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDb } from '../src/db.js'
import {
  GRAPHIFY_BOOTSTRAP_HINT,
  GRAPHIFY_GRAPH_LOCATOR,
  GRAPHIFY_REPORT_LOCATOR,
  ingestGraphifyKnowledge,
} from '../src/agent-os/knowledge-graphify-ingest.js'
import { KnowledgeManagementService } from '../src/agent-os/knowledge-management.js'

const temporary: string[] = []
afterEach(() => {
  for (const directory of temporary.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

const AT = '2026-08-10T08:00:00.000Z'
const LATER = '2026-08-10T08:05:00.000Z'

function git(root: string, args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
}

function repository(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-graphify-ingest-'))
  temporary.push(root)
  git(root, ['init', '-q'])
  git(root, ['config', 'user.email', 'graphify@example.invalid'])
  git(root, ['config', 'user.name', 'Graphify Test'])
  return root
}

function commitFile(root: string, relative: string, content: string): string {
  fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true })
  fs.writeFileSync(path.join(root, relative), content)
  git(root, ['add', '--', relative])
  git(root, ['commit', '-q', '-m', `add ${relative}`])
  return git(root, ['rev-parse', 'HEAD'])
}

function addBoard(root: string, id = 1) {
  const db = openDb(path.join(root, `graphify-${id}.sqlite`))
  db.prepare('INSERT INTO boards (id, project_path, name) VALUES (?, ?, ?)')
    .run(id, root, `Graphify ${id}`)
  return db
}

const REPORT = [
  '# Graph Report - example',
  '',
  '## Summary',
  '- 3 nodes · 2 edges · 1 community',
  '',
  '## Community Hubs',
  '- [[Daemon Lifecycle|Daemon Lifecycle]]',
].join('\n')

const GRAPH = JSON.stringify({
  directed: false,
  nodes: [
    { id: 'a', label: 'daemon.ts', community: 1, source_file: 'src/daemon.ts' },
    {
      id: 'b',
      label: 'WAL journal decision',
      community: 1,
      source_file: 'docs/decisions.md',
      source_location: 'lines 3-9',
      rationale: 'SQLite WAL was chosen over fullfsync journaling for latency.',
    },
  ],
  links: [{ source: 'a', target: 'b' }],
  built_at_commit: 'a'.repeat(40),
})

function seededRepository(): { root: string; head: string } {
  const root = repository()
  commitFile(root, GRAPHIFY_REPORT_LOCATOR, REPORT)
  const head = commitFile(root, GRAPHIFY_GRAPH_LOCATOR, GRAPH)
  return { root, head }
}

describe('graphify knowledge ingestion', () => {
  it('hints at graphify bootstrap when the graph is missing, still ingesting the README', () => {
    const root = repository()
    commitFile(root, 'README.md', 'hello project')
    const db = addBoard(root)
    const result = ingestGraphifyKnowledge(db, { board_id: 1, observed_at: AT })
    expect(result).toMatchObject({
      graph_found: false,
      report_found: false,
      docs_found: 1,
      created_sources: 1,
      hint: GRAPHIFY_BOOTSTRAP_HINT,
    })
    expect(new KnowledgeManagementService(db).browse({ board_id: 1 }).length).toBe(1)

    const bare = repository()
    commitFile(bare, '.gitkeep', '')
    const bareDb = addBoard(bare)
    const bareResult = ingestGraphifyKnowledge(bareDb, { board_id: 1, observed_at: AT })
    expect(bareResult).toMatchObject({ created_sources: 0, created_chunks: 0, hint: GRAPHIFY_BOOTSTRAP_HINT })
  })

  it('ingests the report and graph into browsable, searchable knowledge', () => {
    const { root, head } = seededRepository()
    const db = addBoard(root)
    const result = ingestGraphifyKnowledge(db, { board_id: 1, observed_at: AT })
    expect(result).toMatchObject({
      repository_head_sha: head,
      graph_found: true,
      report_found: true,
      created_sources: 2,
      unchanged_sources: 0,
      superseded_sources: 0,
      hint: null,
    })
    expect(result.created_chunks).toBeGreaterThanOrEqual(4)

    const service = new KnowledgeManagementService(db)
    const items = service.browse({ board_id: 1 })
    const kinds = new Set(items.map((item) => item.citation.source_kind))
    expect(kinds).toEqual(new Set(['graphify']))
    const locators = new Set(items.map((item) => item.citation.locator))
    expect(locators).toEqual(new Set([GRAPHIFY_GRAPH_LOCATOR, GRAPHIFY_REPORT_LOCATOR]))
    expect(items.every((item) => item.citation.freshness === 'fresh')).toBe(true)

    const decisions = service.browse({ board_id: 1, query: 'WAL journaling' })
    expect(decisions.length).toBeGreaterThanOrEqual(1)
    expect(decisions[0].content).toContain('SQLite WAL was chosen')

    const sections = service.browse({ board_id: 1, query: 'Community Hubs' })
    expect(sections.some((item) => item.citation.start_line !== null)).toBe(true)
  })

  it('ingests README and docs/*.md as readable documentation articles', () => {
    const { root } = seededRepository()
    commitFile(root, 'README.md', '# Orchestra\n\nA live kanban board agents share.\n\n## How it works\n- agents register\n- cards claim paths')
    commitFile(root, 'docs/getting-started.md', '# Getting started\n\n## Install\nRun npm install.\n\n## First board\nOpen the web UI.')
    const db = addBoard(root)
    const result = ingestGraphifyKnowledge(db, { board_id: 1, observed_at: AT })
    expect(result.docs_found).toBe(2)
    expect(result.created_sources).toBe(4)

    const items = new KnowledgeManagementService(db).browse({ board_id: 1, limit: 100 })
    const readme = items.filter((item) => item.citation.source_kind === 'readme')
    const docs = items.filter((item) => item.citation.source_kind === 'documentation')
    expect(readme.length).toBeGreaterThanOrEqual(2)
    expect(docs.length).toBeGreaterThanOrEqual(3)
    expect(readme[0].citation.title).toBe('Orchestra')
    expect(docs[0].citation.title).toBe('Getting started')
    expect(docs.every((item) => item.citation.locator === 'docs/getting-started.md')).toBe(true)
    expect(items.some((item) => item.content.includes('agents register'))).toBe(true)
    const searched = new KnowledgeManagementService(db).browse({ board_id: 1, query: 'kanban board' })
    expect(searched.length).toBeGreaterThanOrEqual(1)
  })

  it('is idempotent for unchanged output and supersedes changed output', () => {
    const { root } = seededRepository()
    const db = addBoard(root)
    ingestGraphifyKnowledge(db, { board_id: 1, observed_at: AT })
    const repeat = ingestGraphifyKnowledge(db, { board_id: 1, observed_at: LATER })
    expect(repeat).toMatchObject({
      created_sources: 0,
      unchanged_sources: 2,
      superseded_sources: 0,
      created_chunks: 0,
    })

    commitFile(root, GRAPHIFY_REPORT_LOCATOR, `${REPORT}\n\n## New Section\n- more`)
    const changed = ingestGraphifyKnowledge(db, { board_id: 1, observed_at: LATER })
    expect(changed.created_sources).toBe(2)
    expect(changed.superseded_sources).toBe(2)

    const items = new KnowledgeManagementService(db).browse({ board_id: 1, limit: 50 })
    const reportRevisions = new Set(items
      .filter((item) => item.citation.locator === GRAPHIFY_REPORT_LOCATOR)
      .map((item) => item.citation.source_content_sha256))
    expect(reportRevisions.size).toBe(1)
    expect(items.some((item) => item.content.includes('New Section'))).toBe(true)
  })

  it('participates in repository freshness review when output changes on disk', () => {
    const { root } = seededRepository()
    const db = addBoard(root)
    ingestGraphifyKnowledge(db, { board_id: 1, observed_at: AT })
    const service = new KnowledgeManagementService(db)
    expect(service.refreshRepository(1, LATER).review_requests).toBe(0)

    commitFile(root, GRAPHIFY_GRAPH_LOCATOR, GRAPH.replace('WAL journal decision', 'Rewritten decision'))
    const refreshed = service.refreshRepository(1, LATER)
    expect(refreshed.review_requests).toBeGreaterThanOrEqual(1)
    expect(service.listReviews(1).some((review) => review.kind === 'stale')).toBe(true)
  })

  it('rejects boards without a verifiable git repository state', () => {
    const root = repository()
    const db = addBoard(root)
    expect(() => ingestGraphifyKnowledge(db, { board_id: 1, observed_at: AT }))
      .toThrowError(/repository state could not be verified/)
    expect(() => ingestGraphifyKnowledge(db, { board_id: 99, observed_at: AT }))
      .toThrowError(/board was not found/)
  })
})
