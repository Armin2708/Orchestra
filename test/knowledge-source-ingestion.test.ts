import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { DeliveryReportService } from '../src/agent-os/delivery-reports.js'
import {
  KnowledgeSourceIngestor,
  type AcceptedKnowledgeIngestionInput,
  type StructuralKnowledgeIngestionInput,
} from '../src/agent-os/knowledge-source-ingestion.js'
import { TaskContractService } from '../src/agent-os/task-contracts.js'
import { openDb } from '../src/db.js'

const OBSERVED_AT = '2026-07-29T10:00:00.000Z'
const LATER_AT = '2026-07-29T11:00:00.000Z'
const repositories: string[] = []
const databases: Database.Database[] = []

afterEach(() => {
  for (const db of databases.splice(0)) {
    if (db.open) db.close()
  }
  for (const repository of repositories.splice(0)) {
    fs.rmSync(repository, { recursive: true, force: true })
  }
})

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function git(root: string, ...arguments_: string[]): string {
  return execFileSync('/usr/bin/git', ['-C', root, ...arguments_], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_SYSTEM: '/dev/null',
    },
  }).trim()
}

function write(root: string, relativePath: string, content: string): void {
  const fullPath = path.join(root, relativePath)
  fs.mkdirSync(path.dirname(fullPath), { recursive: true })
  fs.writeFileSync(fullPath, content, 'utf8')
}

function commit(root: string, message: string): string {
  git(root, 'add', '--all')
  git(root, 'commit', '-m', message)
  return git(root, 'rev-parse', 'HEAD')
}

function repositoryFixture(): {
  root: string
  firstCommit: string
  head: string
  source: string
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-source-ingestion-'))
  repositories.push(root)
  git(root, 'init', '-b', 'main')
  git(root, 'config', 'user.name', 'Evidence Author')
  git(root, 'config', 'user.email', 'evidence@example.test')
  const source = [
    'export function helper(): number {',
    '  return 1',
    '}',
    'export function caller(): number {',
    '  return helper() // Gotcha: caller must preserve helper ordering.',
    '}',
  ].join('\n')
  write(root, 'src/service.ts', `${source}\n`)
  write(root, 'src/other.ts', 'export const other = 1\n')
  const firstCommit = commit(root, 'add service symbols')
  const updatedSource = source
    .replace('return 1', 'return 2')
    .replace('preserve helper ordering', 'preserve helper call ordering')
  write(root, 'src/service.ts', `${updatedSource}\n`)
  const head = commit(root, 'update helper behavior')
  write(root, 'README.md', 'Unrelated working tree material.\n')
  return { root, firstCommit, head, source: updatedSource }
}

function boardDb(root: string): { db: Database.Database; boardId: number } {
  const db = openDb(':memory:')
  databases.push(db)
  const boardId = Number(db.prepare(
    'INSERT INTO boards (project_path, name) VALUES (?, ?)',
  ).run(root, 'Knowledge source ingestion').lastInsertRowid)
  return { db, boardId }
}

function structuralInput(
  root: string,
  boardId: number,
  head: string,
  source: string,
): StructuralKnowledgeIngestionInput {
  const lines = source.split('\n')
  return {
    board_id: boardId,
    repository_key: 'example/knowledge-source',
    repository_root: root,
    base_commit_sha: head,
    observed_at: OBSERVED_AT,
    symbols: [
      {
        key: 'caller',
        path: 'src/service.ts',
        start_line: 4,
        end_line: 6,
        language: 'typescript',
        qualified_name: 'caller',
        symbol_kind: 'function',
        expected_source_sha256: sha256(lines.slice(3, 6).join('\n')),
        relationships: [{
          kind: 'calls',
          target_key: 'helper',
          expected_evidence_sha256: sha256(lines[4]),
          target_source_sha256: sha256(lines.slice(0, 3).join('\n')),
          start_line: 5,
          end_line: 5,
        }],
      },
      {
        key: 'helper',
        path: 'src/service.ts',
        start_line: 1,
        end_line: 3,
        language: 'typescript',
        qualified_name: 'helper',
        symbol_kind: 'function',
        expected_source_sha256: sha256(lines.slice(0, 3).join('\n')),
      },
    ],
  }
}

function acceptedDelivery(
  db: Database.Database,
  boardId: number,
  commitSha: string,
): { cardId: number; reportId: string } {
  const cardId = Number(db.prepare(`INSERT INTO cards
    (board_id, title, description) VALUES (?, ?, ?)`)
    .run(boardId, 'Verified delivery', 'Retain exact delivery evidence')
    .lastInsertRowid)
  const contracts = new TaskContractService(db)
  contracts.put(cardId, {
    objective: 'Retain exact delivery evidence.',
    deliverables: ['Durable source'],
    acceptance_criteria: ['The source is verified'],
    verify_commands: ['npm test'],
  })
  const deliveries = new DeliveryReportService(db)
  const draft = deliveries.createForCard(cardId, { actor: 'implementer' })
  const submitted = deliveries.submit(draft.id, {
    actor: 'implementer',
    summary: 'Implemented durable evidence.',
    deliveredItems: draft.asked.deliverables.map((item) => ({
      deliverableId: item.id,
      text: item.text,
      status: 'delivered',
    })),
    changedFiles: ['src/service.ts'],
    commits: [commitSha],
  })
  const evidence = [{ kind: 'commit' as const, ref: commitSha }]
  const verified = deliveries.verify(submitted.id, {
    actor: 'release-verifier',
    deliverableResults: submitted.asked.deliverables.map((item) => ({
      deliverableId: item.id,
      outcome: 'met',
      evidenceRefs: evidence,
    })),
    results: submitted.asked.acceptance_criteria.map((item) => ({
      criterionId: item.id,
      outcome: 'met',
      evidenceRefs: evidence,
    })),
  })
  const accepted = deliveries.accept(verified.id, {
    actor: 'release-reviewer',
    note: 'Commit and tests verified.',
  })
  return { cardId, reportId: accepted.id }
}

describe('knowledge source ingestion', () => {
  it('ingests committed accepted discussion answers and durable decisions', () => {
    const fixture = repositoryFixture()
    const accepted = [
      'Decision: Keep knowledge ingestion repository-scoped.',
      'Accepted answer: Use exact committed citations and redact ghp_12345678901234567890.',
    ].join('\n')
    write(fixture.root, 'docs/accepted-knowledge.md', `${accepted}\n`)
    const head = commit(fixture.root, 'record accepted knowledge')
    const { db, boardId } = boardDb(fixture.root)
    const input: AcceptedKnowledgeIngestionInput = {
      board_id: boardId,
      repository_key: 'example/knowledge-source',
      repository_root: fixture.root,
      base_commit_sha: head,
      observed_at: OBSERVED_AT,
      entries: [{
        kind: 'discussion_answer',
        key: 'discussion:knowledge-ingestion',
        path: 'docs/accepted-knowledge.md',
        start_line: 2,
        end_line: 2,
        title: 'Accepted knowledge ingestion answer',
        accepted_at: OBSERVED_AT,
        accepted_by: 'release-reviewer',
        expected_source_sha256: sha256(accepted.split('\n')[1]),
      }, {
        kind: 'decision',
        key: 'decision:repository-scope',
        path: 'docs/accepted-knowledge.md',
        start_line: 1,
        end_line: 1,
        title: 'Repository-scoped knowledge ingestion',
        accepted_at: OBSERVED_AT,
        accepted_by: 'release-reviewer',
        expected_source_sha256: sha256(accepted.split('\n')[0]),
      }],
    }

    const report = new KnowledgeSourceIngestor(db).ingestAcceptedKnowledge(input)
    expect(report.sources.map((source) => source.source_kind))
      .toEqual(['decision', 'discussion_answer'])
    expect(report.sources.every((source) =>
      source.trust_class === 'evidence'
      && source.source_revision === head
      && source.freshness_policy === 'commit_exact')).toBe(true)
    const envelopes = report.chunks.map((chunk) =>
      JSON.parse(chunk.content) as Record<string, unknown>)
    expect(envelopes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        accepted_by: 'release-reviewer',
        confidence_micros: 1_000_000,
        interpretation: 'data_only',
        kind: 'decision',
      }),
      expect.objectContaining({
        accepted_by: 'release-reviewer',
        confidence_micros: 1_000_000,
        interpretation: 'data_only',
        kind: 'discussion_answer',
      }),
    ]))
    expect(JSON.stringify(envelopes)).not.toContain('ghp_12345678901234567890')
    expect(JSON.stringify(envelopes)).toContain('[REDACTED]')

    const replay = new KnowledgeSourceIngestor(db).ingestAcceptedKnowledge({
      ...input,
      observed_at: LATER_AT,
      entries: [...input.entries].reverse(),
    })
    expect(replay.sources.map((source) => source.id))
      .toEqual(report.sources.map((source) => source.id))
    expect(replay.sources.every((source) => source.created_at === OBSERVED_AT))
      .toBe(true)

    expect(() => new KnowledgeSourceIngestor(db).ingestAcceptedKnowledge({
      ...input,
      entries: [{
        ...input.entries[0],
        key: 'discussion:uncommitted-copy',
      }, {
        ...input.entries[1],
        key: 'decision:forged-citation',
        expected_source_sha256: '0'.repeat(64),
      }],
    })).toThrow(expect.objectContaining({ code: 'evidence_mismatch' }))
    expect(db.prepare('SELECT COUNT(*) AS count FROM knowledge_sources').get())
      .toEqual({ count: 2 })
  })

  it('retains deterministic exact structural citations, authors, and relationships', () => {
    const fixture = repositoryFixture()
    const first = boardDb(fixture.root)
    const input = structuralInput(
      fixture.root,
      first.boardId,
      fixture.head,
      fixture.source,
    )
    const firstReport = new KnowledgeSourceIngestor(first.db)
      .ingestStructural(input)
    expect(firstReport.sources).toHaveLength(2)
    expect(firstReport.sources.map((source) => source.locator)).toEqual([
      expect.stringContaining('/lines-1-3.json'),
      expect.stringContaining('/lines-4-6.json'),
    ])
    const callerChunk = firstReport.chunks.find((chunk) =>
      chunk.symbol?.qualified_name === 'caller')
    expect(callerChunk).toBeDefined()
    const caller = JSON.parse(callerChunk!.content) as {
      authors: Array<{ name: string; email: string }>
      citation: { commit_sha: string; path: string; start_line: number; end_line: number }
      confidence_micros: number
      evidence: { source_sha256: string; persisted_evidence_sha256: string }
      interpretation: string
      relationships: Array<{ kind: string; target: { qualified_name: string } }>
    }
    expect(caller).toMatchObject({
      authors: [{ name: 'Evidence Author', email: 'evidence@example.test' }],
      citation: {
        commit_sha: fixture.head,
        path: 'src/service.ts',
        start_line: 4,
        end_line: 6,
      },
      confidence_micros: 950_000,
      interpretation: 'data_only',
      relationships: [{ kind: 'calls', target: { qualified_name: 'helper' } }],
    })
    expect(firstReport.sources[0]).toMatchObject({
      source_kind: 'code_symbol',
      freshness_policy: 'commit_exact',
      freshness_state: 'fresh',
      provenance: {
        repository_key: 'example/knowledge-source',
        base_commit_sha: fixture.head,
      },
    })
    expect(callerChunk!.source_range).toEqual({
      start_line: 4,
      end_line: 6,
      start_byte: null,
      end_byte: null,
    })

    const replay = new KnowledgeSourceIngestor(first.db).ingestStructural({
      ...input,
      observed_at: LATER_AT,
      symbols: [...input.symbols].reverse(),
    })
    expect(replay.sources.map((source) => source.id))
      .toEqual(firstReport.sources.map((source) => source.id))
    expect(replay.sources.every((source) => source.created_at === OBSERVED_AT))
      .toBe(true)

    const second = boardDb(fixture.root)
    const secondReport = new KnowledgeSourceIngestor(second.db)
      .ingestStructural({ ...input, board_id: second.boardId })
    expect(secondReport.sources.map((source) => source.id))
      .toEqual(firstReport.sources.map((source) => source.id))
    expect(secondReport.chunks.map((chunk) => chunk.id))
      .toEqual(firstReport.chunks.map((chunk) => chunk.id))
  })

  it('selects bounded recent history and exact blame only for requested paths', () => {
    const fixture = repositoryFixture()
    const { db, boardId } = boardDb(fixture.root)
    const report = new KnowledgeSourceIngestor(db).ingestGitContext({
      board_id: boardId,
      repository_key: 'example/knowledge-source',
      repository_root: fixture.root,
      base_commit_sha: fixture.head,
      observed_at: OBSERVED_AT,
      paths: ['src/service.ts'],
      recent_commit_limit: 5,
      blame_ranges: [{
        path: 'src/service.ts',
        start_line: 1,
        end_line: 2,
      }],
    })
    expect(report.sources.filter((source) => source.source_kind === 'git_history'))
      .toHaveLength(2)
    expect(report.sources.filter((source) => source.source_kind === 'git_blame'))
      .toHaveLength(1)
    const history = report.chunks
      .map((chunk) => JSON.parse(chunk.content) as Record<string, unknown>)
      .filter((chunk) => chunk.kind === 'git_history')
    expect(history).toEqual(expect.arrayContaining([
      expect.objectContaining({
        changed_paths: ['src/service.ts'],
        confidence_micros: 1_000_000,
        interpretation: 'data_only',
      }),
    ]))
    expect(JSON.stringify(history)).not.toContain('README.md')
    expect(JSON.stringify(history)).not.toContain('src/other.ts')
    const blame = report.chunks
      .map((chunk) => JSON.parse(chunk.content) as Record<string, unknown>)
      .find((chunk) => chunk.kind === 'git_blame') as {
        authors: Array<{ name: string }>
        lines: Array<{ line: number; commit_sha: string }>
      }
    expect(blame.authors).toEqual([{ name: 'Evidence Author', email: 'evidence@example.test' }])
    expect(blame.lines.map((line) => line.line)).toEqual([1, 2])
    expect(blame.lines.every((line) => [fixture.firstCommit, fixture.head]
      .includes(line.commit_sha))).toBe(true)
  })

  it('persists only current accepted delivery summaries and source-backed gotchas', () => {
    const fixture = repositoryFixture()
    const { db, boardId } = boardDb(fixture.root)
    const delivery = acceptedDelivery(db, boardId, fixture.head)
    const gotchaText = 'Gotcha: caller must preserve helper call ordering.'
    const citedLine = fixture.source.split('\n')[4]
    const report = new KnowledgeSourceIngestor(db).ingestVerifiedDelivery({
      board_id: boardId,
      repository_key: 'example/knowledge-source',
      repository_root: fixture.root,
      base_commit_sha: fixture.head,
      observed_at: OBSERVED_AT,
      report_id: delivery.reportId,
      source_commit_sha: fixture.head,
      gotchas: [{
        path: 'src/service.ts',
        start_line: 5,
        end_line: 5,
        text: gotchaText,
        expected_source_sha256: sha256(citedLine),
      }],
    })
    expect(report.sources.map((source) => source.source_kind))
      .toEqual(['gotcha', 'verified_delivery'])
    expect(report.sources[0]).toMatchObject({
      trust_class: 'untrusted',
      source_revision: fixture.head,
      targets: {
        board_id: boardId,
        card_id: delivery.cardId,
        delivery_report_id: delivery.reportId,
      },
    })
    const gotcha = JSON.parse(report.chunks[0].content) as Record<string, unknown>
    expect(gotcha).toMatchObject({
      author: 'release-reviewer',
      confidence_micros: 900_000,
      gotcha: gotchaText,
      interpretation: 'data_only',
      verified_by: 'release-verifier',
    })
    const summary = JSON.parse(report.chunks[1].content) as Record<string, unknown>
    expect(summary).toMatchObject({
      accepted_by: 'release-reviewer',
      confidence_micros: 1_000_000,
      interpretation: 'data_only',
      kind: 'verified_delivery',
      verified_by: 'release-verifier',
    })
  })
})
