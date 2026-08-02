import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type Database from 'better-sqlite3'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CanonicalDiscussionKnowledgePromotionAdapter,
  DiscussionKnowledgePromotionError,
} from '../src/agent-os/discussion-knowledge-promotion.js'
import { KnowledgeCompiler } from '../src/agent-os/knowledge-compiler.js'
import { KNOWLEDGE_COMPILER_CONTRACT_VERSION } from '../src/agent-os/knowledge-compiler-contracts.js'
import { KnowledgeService } from '../src/agent-os/knowledge-service.js'
import { CONTEXT_SECTIONS } from '../src/agent-os/knowledge-types.js'
import {
  DiscussionService,
  type DiscussionKnowledgePromotionEvidence,
} from '../src/agent-os/discussions.js'
import { registerAgentOsRoutes } from '../src/agent-os/routes.js'
import { openDb } from '../src/db.js'

const databases: Database.Database[] = []
const servers: FastifyInstance[] = []
const repositories: string[] = []

afterEach(async () => {
  await Promise.allSettled(servers.splice(0).map((server) => server.close()))
  for (const db of databases.splice(0)) db.close()
  for (const repository of repositories.splice(0)) {
    fs.rmSync(repository, { recursive: true, force: true })
  }
})

describe('canonical Discussion to Knowledge promotion', () => {
  it('persists the independently reviewed accepted answer through central route composition',
    async () => {
      const db = trackedDb()
      const boardId = board(db, repository())
      const server = Fastify()
      server.decorateRequest('orchestraPrincipal', null)
      server.addHook('onRequest', (request, _reply, done) => {
        request.orchestraPrincipal = header(request.headers['x-test-principal'])
        done()
      })
      registerAgentOsRoutes(server, { db, isOperator: () => true })
      await server.ready()
      servers.push(server)

      const created = await command(server, 'asker', 'create', {
        method: 'POST',
        url: `/api/v1/os/boards/${boardId}/discussions`,
        payload: {
          type: 'question',
          title: 'How is accepted evidence promoted?',
          body: 'Require exact source identity and independent review.',
        },
      })
      expect(created.statusCode, created.body).toBe(201)
      const discussionId = created.json().discussion.id as string
      const rootPostId = created.json().posts[0].id as string
      const rawSecret = ['ghp', '12345678901234567890'].join('_')
      const answerBody = `Verify the live accepted post with token ${rawSecret} before persistence.`

      const answered = await command(server, 'answerer', 'answer', {
        method: 'POST',
        url: `/api/v1/os/discussions/${discussionId}/posts`,
        payload: {
          parent_post_id: rootPostId,
          kind: 'answer',
          body: answerBody,
        },
      })
      expect(answered.statusCode, answered.body).toBe(201)
      const postId = answered.json().post.id as string
      const contentHash = answered.json().post.content_sha256 as string

      const accepted = await command(server, 'asker', 'accept', {
        method: 'POST',
        url: `/api/v1/os/discussions/${discussionId}/accept`,
        payload: { post_id: postId },
      })
      expect(accepted.statusCode, accepted.body).toBe(200)

      const requested = await command(server, 'asker', 'request-promotion', {
        method: 'POST',
        url: `/api/v1/os/discussions/${discussionId}/posts/${postId}/promotion`,
        payload: {},
      })
      expect(requested.statusCode, requested.body).toBe(201)
      const promotionId = requested.json().promotion.id as string

      const reviewed = await command(server, 'independent-reviewer', 'review-promotion', {
        method: 'POST',
        url: `/api/v1/os/discussion-promotions/${promotionId}/review`,
        payload: {
          decision: 'approve',
          note: 'Canonical post, acceptance event, source hash, and artifact all match.',
        },
      })
      expect(reviewed.statusCode, reviewed.body).toBe(200)
      expect(reviewed.json().promotion).toMatchObject({ status: 'promoted' })

      const result = JSON.parse(reviewed.json().promotion.knowledge_result_json) as {
        source_ids: string[]
        chunk_ids: string[]
        repository_key: string
        repository_head_sha: string
        raw_source_content_sha256: string
        persisted_content_sha256: string
        redaction_state: string
      }
      expect(result.source_ids).toHaveLength(1)
      expect(result.chunk_ids).toHaveLength(1)
      expect(result.raw_source_content_sha256).toBe(contentHash)
      expect(result.persisted_content_sha256).not.toBe(contentHash)
      expect(result.redaction_state).toBe('redacted')
      expect(db.prepare(`SELECT source_kind, content_sha256, freshness_policy, redaction_state,
          json_extract(provenance_json, '$.repository_key') AS repository_key
        FROM knowledge_sources WHERE board_id=? AND id=?`)
        .get(boardId, result.source_ids[0])).toEqual({
        source_kind: 'discussion_answer',
        content_sha256: result.persisted_content_sha256,
        freshness_policy: 'manual_until_superseded',
        redaction_state: 'redacted',
        repository_key: result.repository_key,
      })
      const persistedChunk = db.prepare(`SELECT content, content_sha256 FROM knowledge_chunks
        WHERE board_id=? AND id=?`).get(boardId, result.chunk_ids[0]) as
        { content: string; content_sha256: string }
      expect(persistedChunk.content).toContain('[REDACTED]')
      expect(persistedChunk.content).not.toContain(rawSecret)
      expect(persistedChunk.content_sha256).toBe(result.persisted_content_sha256)
      expect(db.prepare('SELECT body FROM os_discussion_posts WHERE id=?').get(postId))
        .toEqual({ body: answerBody })

      const knowledge = new KnowledgeService(db)
      const targets = {
        board_id: boardId,
        workspace_id: null,
        card_id: null,
        contract_ref: null,
        contract_version: null,
        contract_snapshot_sha256: null,
        job_id: null,
        profile_id: null,
        session_id: null,
        delivery_report_id: null,
      }
      const retrieved = knowledge.retrieve({
        version: 1,
        board_id: boardId,
        access_scope: { kind: 'board' },
        targets,
        repository_key: result.repository_key,
        base_commit_sha: result.repository_head_sha,
        source_revisions: [],
        source_kinds: ['discussion_answer'],
        freshness_states: ['fresh'],
        redaction_states: ['redacted'],
        content_states: ['present'],
        ingest_states: ['active'],
        paths: [],
        path_prefixes: [],
        symbols: [],
        query: 'Verify live accepted post',
        limit: 10,
      })
      expect(retrieved.results.map((item) => item.citation.chunk_id)).toContain(result.chunk_ids[0])

      const sectionBudget = { max_tokens: 4_000, max_characters: 30_000 }
      const compiled = new KnowledgeCompiler(knowledge, knowledge.retrieve.bind(knowledge)).compile({
        version: KNOWLEDGE_COMPILER_CONTRACT_VERSION,
        board_id: boardId,
        access_scope: { kind: 'board' },
        targets,
        repository_key: result.repository_key,
        base_commit_sha: result.repository_head_sha,
        task: {
          objective: 'Verify the live accepted post before persistence',
          criteria: [{ id: 'accepted-source', text: 'Use exact accepted source evidence', required: true }],
          files: [],
          symbols: [],
          recent_work: [],
        },
        budget: {
          max_tokens: 12_000,
          max_characters: 100_000,
          sections: Object.fromEntries(CONTEXT_SECTIONS.map((section) => [section, sectionBudget])),
        },
        pinned_chunk_ids: [result.chunk_ids[0]],
        adapter_signals: [],
        previous_context: null,
        created_at: '2026-08-02T08:00:00.000Z',
      })
      expect(compiled.build.entries).toEqual(expect.arrayContaining([
        expect.objectContaining({ chunk_id: result.chunk_ids[0], decision: 'selected' }),
      ]))
      expect(compiled.documents.some((document) => document.content.includes('[REDACTED]'))).toBe(true)
      expect(compiled.documents.every((document) => !document.content.includes(rawSecret))).toBe(true)
      const browse = await server.inject({
        method: 'GET',
        url: `/api/v1/os/boards/${boardId}/knowledge`,
      })
      expect(browse.statusCode, browse.body).toBe(200)
      expect(browse.json().knowledge).toEqual([
        expect.objectContaining({
          content: persistedChunk.content,
          citation: expect.objectContaining({ source_id: result.source_ids[0] }),
        }),
      ])
    })

  it('rejects cross-board claims and arbitrary artifact text despite promotion status', async () => {
    const db = trackedDb()
    const boardId = board(db, '/discussion-promotion-security')
    const otherBoardId = board(db, '/discussion-promotion-other')
    const discussions = new DiscussionService(db)
    const { promotionId } = await reviewedPromotion(discussions, db, boardId)
    const adapter = new CanonicalDiscussionKnowledgePromotionAdapter(db)
    const evidence = promotionEvidence(db, promotionId)

    expect(() => adapter.promote({ ...evidence, boardId: otherBoardId }))
      .toThrowError(expect.objectContaining<Partial<DiscussionKnowledgePromotionError>>({
        code: 'promotion_scope_mismatch',
      }))

    const arbitraryArtifact = JSON.stringify({
      schema_version: 1,
      kind: 'discussion_answer',
      status: 'accepted',
      content: 'Arbitrary status-labelled text must never become Knowledge.',
    })
    const arbitraryHash = sha256(arbitraryArtifact)
    db.prepare(`UPDATE os_discussion_promotions
      SET artifact_json=?, artifact_sha256=? WHERE id=?`)
      .run(arbitraryArtifact, arbitraryHash, promotionId)
    expect(() => adapter.promote({
      ...evidence,
      artifactJson: arbitraryArtifact,
      artifactSha256: arbitraryHash,
    })).toThrowError(expect.objectContaining<Partial<DiscussionKnowledgePromotionError>>({
      code: 'promotion_source_mismatch',
    }))
    expect(db.prepare('SELECT count(*) AS count FROM knowledge_sources').get())
      .toEqual({ count: 0 })
  })

  it('requires the durable approval event instead of trusting a promoting status label', () => {
    const db = trackedDb()
    const boardId = board(db, '/discussion-promotion-review-evidence')
    const discussions = new DiscussionService(db)
    const requested = requestedPromotion(discussions, boardId, 'status-only')
    db.prepare(`UPDATE os_discussion_promotions
      SET status='promoting', reviewed_by_type='operator', reviewed_by_id='reviewer',
          review_note='status only', reviewed_at=? WHERE id=?`)
      .run(new Date().toISOString(), requested.id)
    const adapter = new CanonicalDiscussionKnowledgePromotionAdapter(db)

    expect(() => adapter.promote(promotionEvidence(db, requested.id)))
      .toThrowError(expect.objectContaining<Partial<DiscussionKnowledgePromotionError>>({
        code: 'promotion_not_reviewed',
      }))
    expect(db.prepare('SELECT count(*) AS count FROM knowledge_sources').get())
      .toEqual({ count: 0 })
  })
})

function trackedDb(): Database.Database {
  const db = openDb(':memory:')
  databases.push(db)
  return db
}

function board(db: Database.Database, projectPath: string): number {
  return Number(db.prepare('INSERT INTO boards (project_path, name) VALUES (?, ?)')
    .run(projectPath, projectPath).lastInsertRowid)
}

function repository(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-discussion-promotion-'))
  repositories.push(root)
  git(root, ['init'])
  git(root, ['config', 'user.name', 'Discussion Promotion Test'])
  git(root, ['config', 'user.email', 'discussion-promotion@example.invalid'])
  fs.writeFileSync(path.join(root, 'README.md'), '# Discussion promotion\n', 'utf8')
  git(root, ['add', 'README.md'])
  git(root, ['commit', '-m', 'seed repository'])
  return root
}

function git(root: string, args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()
}

function requestedPromotion(
  service: DiscussionService,
  boardId: number,
  suffix: string,
) {
  const question = service.createDiscussion({
    boardId,
    type: 'question',
    title: `Exact promotion ${suffix}`,
    body: 'Only the exact accepted source may pass.',
    actor: { type: 'operator', id: `asker-${suffix}` },
    idempotencyKey: `${suffix}:create`,
  })
  const answer = service.addPost({
    discussionId: question.discussion.id,
    parentPostId: question.posts[0].id,
    kind: 'answer',
    body: `Exact accepted answer ${suffix}.`,
    actor: { type: 'operator', id: `answerer-${suffix}` },
    idempotencyKey: `${suffix}:answer`,
  })
  service.acceptAnswer({
    discussionId: question.discussion.id,
    postId: answer.id,
    actor: { type: 'operator', id: `asker-${suffix}` },
    idempotencyKey: `${suffix}:accept`,
  })
  return service.requestPromotion({
    discussionId: question.discussion.id,
    postId: answer.id,
    actor: { type: 'operator', id: `asker-${suffix}` },
    idempotencyKey: `${suffix}:promotion`,
  })
}

async function reviewedPromotion(
  service: DiscussionService,
  db: Database.Database,
  boardId: number,
): Promise<{ promotionId: string }> {
  const requested = requestedPromotion(service, boardId, 'reviewed')
  await service.reviewPromotion({
    promotionId: requested.id,
    decision: 'approve',
    note: 'Independent exact-source review.',
    actor: { type: 'operator', id: 'independent-reviewer' },
    idempotencyKey: 'reviewed:review',
  })
  const row = db.prepare('SELECT status FROM os_discussion_promotions WHERE id=?')
    .get(requested.id) as { status: string }
  expect(row.status).toBe('approved')
  db.prepare(`UPDATE os_discussion_promotions SET status='promoting' WHERE id=?`)
    .run(requested.id)
  return { promotionId: requested.id }
}

function promotionEvidence(
  db: Database.Database,
  promotionId: string,
): DiscussionKnowledgePromotionEvidence {
  const row = db.prepare(`SELECT promotion.*, discussion.board_id
    FROM os_discussion_promotions promotion
    JOIN os_discussions discussion ON discussion.id=promotion.discussion_id
    WHERE promotion.id=?`).get(promotionId) as Record<string, unknown>
  return {
    promotionId,
    boardId: Number(row.board_id),
    discussionId: String(row.discussion_id),
    postId: String(row.post_id),
    sourceUri: String(row.source_uri),
    sourceContentSha256: String(row.source_content_sha256),
    artifactJson: String(row.artifact_json),
    artifactSha256: String(row.artifact_sha256),
    acceptanceEventId: String(row.acceptance_event_id),
    reviewedBy: {
      type: String(row.reviewed_by_type),
      id: String(row.reviewed_by_id),
    },
  }
}

async function command(
  server: FastifyInstance,
  principal: string,
  key: string,
  request: { method: 'POST'; url: string; payload: Record<string, unknown> },
) {
  return server.inject({
    ...request,
    headers: {
      'x-test-principal': principal,
      'idempotency-key': `discussion-promotion:${key}`,
    },
  })
}

function header(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? 'operator' : value ?? 'operator'
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}
