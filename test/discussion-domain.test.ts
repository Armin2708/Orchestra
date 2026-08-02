import { describe, expect, it } from 'vitest'
import { AgentProfileService } from '../src/agent-os/agent-profiles.js'
import {
  AGENT_OS_DISCUSSION_MIGRATION_ID,
  AGENT_OS_DISCUSSION_TABLES,
  installDiscussionSchema,
} from '../src/agent-os/discussion-migration.js'
import {
  DiscussionService,
  type DiscussionKnowledgePromotionEvidence,
  type DiscussionWakeRequest,
} from '../src/agent-os/discussions.js'
import { openDb } from '../src/db.js'

function fixture() {
  const db = openDb(':memory:')
  installDiscussionSchema(db)
  const boardId = Number(db.prepare(`INSERT INTO boards (project_path, name)
    VALUES ('/discussion-domain', 'Discussion domain')`).run().lastInsertRowid)
  const profiles = new AgentProfileService(db)
  const create = (name: string) => profiles.create({
    boardId,
    name,
    actor: { type: 'human' as const, id: 'owner' },
    idempotencyKey: `profile:${name}`,
  })
  return {
    db,
    boardId,
    asker: create('Asker'),
    answerer: create('Answerer'),
    subscriber: create('Subscriber'),
  }
}

const agent = (profileId: string, id = profileId) => ({
  type: 'agent' as const,
  id,
  profileId,
})
const operator = { type: 'operator' as const, id: 'human-reviewer' }

describe('Discussion migration', () => {
  it('installs the complete isolated schema, replays, and fails closed on drift', () => {
    const db = openDb(':memory:')
    expect(AGENT_OS_DISCUSSION_MIGRATION_ID).toBe('032-discussions-domain')
    installDiscussionSchema(db)
    expect(() => installDiscussionSchema(db)).not.toThrow()
    const objects = new Set((db.prepare(`SELECT name FROM sqlite_master
      WHERE type IN ('table','index','trigger')`).all() as Array<{ name: string }>)
      .map((row) => row.name))
    for (const table of AGENT_OS_DISCUSSION_TABLES) expect(objects.has(table), table).toBe(true)
    expect(objects.has('os_discussion_search')).toBe(true)

    db.exec(`DROP TABLE os_discussion_tags;
      CREATE TABLE os_discussion_tags (discussion_id TEXT PRIMARY KEY);`)
    expect(() => installDiscussionSchema(db)).toThrow(/incompatible table os_discussion_tags/)
    db.close()
  })
})

describe('DiscussionService', () => {
  it('proves nested searchable Q&A, targeted wakes, acceptance, and reviewed promotion', async () => {
    const { db, boardId, asker, answerer, subscriber } = fixture()
    const wakes: DiscussionWakeRequest[] = []
    const promotions: DiscussionKnowledgePromotionEvidence[] = []
    const service = new DiscussionService(db, {
      wake(request) { wakes.push(request) },
    }, {
      promote(evidence) {
        promotions.push(evidence)
        return { source_ids: ['knowledge-source-one'] }
      },
    })

    const created = service.createDiscussion({
      boardId,
      type: 'question',
      title: 'How should exact promotion work?',
      body: 'Use a reviewed exact source.',
      tags: ['knowledge', 'q-and-a'],
      links: [{ type: 'repo', targetId: 'agentboard' }],
      mentions: [answerer.id],
      actor: agent(asker.id),
      idempotencyKey: 'discussion:create',
    })
    await service.retryPendingNotifications(created.posts[0].id)
    expect(wakes).toEqual([expect.objectContaining({
      recipientProfileIds: [answerer.id],
      reasons: { [answerer.id]: 'mention' },
    })])
    expect(service.search(boardId, 'exact promotion')).toEqual([
      expect.objectContaining({ id: created.discussion.id }),
    ])
    expect(service.queue(boardId, 'unanswered')).toHaveLength(1)

    service.subscribe({
      discussionId: created.discussion.id,
      profileId: subscriber.id,
      actor: agent(subscriber.id),
      idempotencyKey: 'discussion:subscribe',
    })
    const answer = service.addPost({
      discussionId: created.discussion.id,
      parentPostId: created.posts[0].id,
      kind: 'answer',
      body: 'Snapshot the accepted post hash, then require independent review.',
      actor: agent(answerer.id),
      idempotencyKey: 'discussion:answer',
    })
    await service.retryPendingNotifications(answer.id)
    const replyWake = wakes.at(-1)!
    expect(new Set(replyWake.recipientProfileIds)).toEqual(new Set([asker.id, subscriber.id]))
    expect(replyWake.recipientProfileIds).not.toContain(answerer.id)

    const nested = service.addPost({
      discussionId: created.discussion.id,
      parentPostId: answer.id,
      kind: 'comment',
      body: 'This nested clarification retains its exact parent.',
      actor: agent(asker.id),
      idempotencyKey: 'discussion:nested',
    })
    const deep = service.addPost({
      discussionId: created.discussion.id,
      parentPostId: nested.id,
      kind: 'comment',
      body: 'Arbitrary nesting remains intact.',
      actor: agent(answerer.id),
      idempotencyKey: 'discussion:deep',
    })
    expect(service.require(created.discussion.id).tree[0].children[0]
      .children[0].children[0].id).toBe(deep.id)

    const accepted = service.acceptAnswer({
      discussionId: created.discussion.id,
      postId: answer.id,
      actor: agent(asker.id),
      idempotencyKey: 'discussion:accept',
    })
    expect(accepted.discussion).toMatchObject({ state: 'answered', accepted_post_id: answer.id })
    expect(service.queue(boardId, 'unanswered')).toEqual([])

    service.grantPermission({
      boardId,
      discussionId: created.discussion.id,
      subjectType: 'profile',
      subjectId: asker.id,
      permission: 'promote_knowledge',
      reason: 'Question owner may request independent promotion review.',
      actor: operator,
      idempotencyKey: 'discussion:permission:promote',
    })
    const requested = service.requestPromotion({
      discussionId: created.discussion.id,
      postId: answer.id,
      actor: agent(asker.id),
      idempotencyKey: 'discussion:promotion:request',
    })
    expect(requested).toMatchObject({
      status: 'pending_review',
      source_content_sha256: answer.content_sha256,
    })
    expect(requested.source_uri).toContain(answer.content_sha256)
    expect(JSON.parse(requested.artifact_json)).toMatchObject({
      kind: 'discussion_answer',
      content: answer.body,
    })
    const promoted = await service.reviewPromotion({
      promotionId: requested.id,
      decision: 'approve',
      note: 'Exact accepted source and acceptance event reviewed.',
      actor: operator,
      idempotencyKey: 'discussion:promotion:review',
    })
    expect(promoted.status).toBe('promoted')
    expect(promotions).toEqual([expect.objectContaining({
      postId: answer.id,
      sourceContentSha256: answer.content_sha256,
      artifactSha256: requested.artifact_sha256,
    })])
    expect(service.reviewPromotion({
      promotionId: requested.id,
      decision: 'approve',
      note: 'Exact accepted source and acceptance event reviewed.',
      actor: operator,
      idempotencyKey: 'discussion:promotion:review',
    })).resolves.toMatchObject({ status: 'promoted' })
    expect(promotions).toHaveLength(1)
    db.close()
  })

  it('keeps announcements inert and blocks loops, self-approval, unsafe content, and replay drift', async () => {
    const { db, boardId, asker, answerer } = fixture()
    const wakes: DiscussionWakeRequest[] = []
    const service = new DiscussionService(db, { wake(request) { wakes.push(request) } })
    const announcement = service.createDiscussion({
      boardId,
      type: 'announcement',
      title: 'Quiet announcement',
      body: 'Readers can discover this without being woken.',
      actor: agent(asker.id),
      automated: true,
      idempotencyKey: 'announcement:create',
    })
    await service.retryPendingNotifications(announcement.posts[0].id)
    expect(wakes).toEqual([])
    expect(service.notifications(answerer.id)).toEqual([])

    expect(() => service.addPost({
      discussionId: announcement.discussion.id,
      parentPostId: announcement.posts[0].id,
      kind: 'comment',
      body: 'Automated acknowledgement.',
      actor: agent(asker.id),
      automated: true,
      idempotencyKey: 'announcement:loop',
    })).toThrow(/automated reply loops|self-replies/)

    const question = service.createDiscussion({
      boardId, type: 'question', title: 'Self approval?', body: 'No.',
      actor: agent(asker.id), idempotencyKey: 'self-question',
    })
    const ownAnswer = service.addPost({
      discussionId: question.discussion.id,
      kind: 'answer', body: 'I should not approve this myself.',
      actor: agent(asker.id), idempotencyKey: 'self-answer',
    })
    expect(() => service.acceptAnswer({
      discussionId: question.discussion.id,
      postId: ownAnswer.id,
      actor: agent(asker.id),
      idempotencyKey: 'self-accept',
    })).toThrow(/cannot accept their own/)
    expect(() => service.createDiscussion({
      boardId, type: 'question', title: 'Unsafe',
      body: '[click](javascript:alert(1))', actor: operator,
      idempotencyKey: 'unsafe',
    })).toThrow(/unsafe active content/)

    const replay = service.createDiscussion({
      boardId, type: 'plan', title: 'Stable replay', body: 'Stable.',
      actor: operator, idempotencyKey: 'stable-replay',
    })
    expect(service.createDiscussion({
      boardId, type: 'plan', title: 'Stable replay', body: 'Stable.',
      actor: operator, idempotencyKey: 'stable-replay',
    }).discussion.id).toBe(replay.discussion.id)
    expect(() => service.createDiscussion({
      boardId, type: 'plan', title: 'Changed replay', body: 'Changed.',
      actor: operator, idempotencyKey: 'stable-replay',
    })).toThrow(/idempotency key/)
    db.close()
  })

  it('enforces board-scoped links and needs-human queues', () => {
    const { db, boardId } = fixture()
    const otherBoardId = Number(db.prepare(`INSERT INTO boards (project_path, name)
      VALUES ('/other', 'Other')`).run().lastInsertRowid)
    db.prepare(`INSERT INTO jobs
      (id, board_id, provider, status, max_attempts, scheduled_at, created_at)
      VALUES ('other-job', ?, 'codex', 'queued', 1, datetime('now'), datetime('now'))`)
      .run(otherBoardId)
    const service = new DiscussionService(db)
    expect(() => service.createDiscussion({
      boardId, type: 'plan', title: 'Cross board', body: 'Forbidden.',
      links: [{ type: 'job', targetId: 'other-job' }],
      actor: operator, idempotencyKey: 'cross-board',
    })).toThrow(/outside the board scope/)
    const created = service.createDiscussion({
      boardId, type: 'conflict', title: 'Needs a human', body: 'Decision blocked.',
      actor: operator, idempotencyKey: 'needs-human:create',
    })
    const transition = service.transition({
      discussionId: created.discussion.id,
      state: 'needs_human',
      actor: operator,
      idempotencyKey: 'needs-human:transition',
    })
    expect(service.transition({
      discussionId: created.discussion.id,
      state: 'needs_human',
      actor: operator,
      idempotencyKey: 'needs-human:transition',
    }).state).toBe(transition.state)
    expect(service.queue(boardId, 'needs_human')).toEqual([
      expect.objectContaining({ id: created.discussion.id }),
    ])
    db.close()
  })
})
