import { createHash, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { canonicalKnowledgeJson } from './knowledge-contracts.js'
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from './errors.js'

export const DISCUSSION_TYPES = Object.freeze([
  'question', 'answer', 'plan', 'decision', 'announcement', 'conflict',
] as const)
export const DISCUSSION_STATES = Object.freeze([
  'open', 'answered', 'resolved', 'needs_human', 'archived', 'superseded',
] as const)
export const DISCUSSION_POST_KINDS = Object.freeze([
  'question', 'answer', 'plan', 'decision', 'announcement', 'conflict',
  'comment', 'resolution',
] as const)
export const DISCUSSION_LINK_TYPES = Object.freeze([
  'repo', 'job', 'contract', 'agent', 'workspace', 'file', 'symbol', 'delivery',
] as const)
export const DISCUSSION_PERMISSIONS = Object.freeze([
  'edit', 'resolve', 'moderate', 'promote_knowledge',
] as const)

export type DiscussionType = typeof DISCUSSION_TYPES[number]
export type DiscussionState = typeof DISCUSSION_STATES[number]
export type DiscussionPostKind = typeof DISCUSSION_POST_KINDS[number]
export type DiscussionLinkType = typeof DISCUSSION_LINK_TYPES[number]
export type DiscussionPermission = typeof DISCUSSION_PERMISSIONS[number]
export type DiscussionQueue = 'unanswered' | 'needs_human'

export interface DiscussionActor {
  type: 'operator' | 'agent' | 'service'
  id: string
  profileId?: string | null
  provider?: string | null
  sessionId?: string | null
}

export interface DiscussionLinkInput {
  type: DiscussionLinkType
  targetId?: string | null
  path?: string | null
  symbol?: string | null
  sourceRevision?: string | null
  sourceSha256?: string | null
}

export interface DiscussionWakeRequest {
  boardId: number
  discussionId: string
  postId: string
  causationEventId: string
  recipientProfileIds: string[]
  reasons: Record<string, 'mention' | 'subscription' | 'direct_reply'>
}

export interface DiscussionWakeAdapter {
  wake(request: DiscussionWakeRequest): void | Promise<void>
}

export interface DiscussionKnowledgePromotionEvidence {
  promotionId: string
  boardId: number
  discussionId: string
  postId: string
  sourceUri: string
  sourceContentSha256: string
  artifactJson: string
  artifactSha256: string
  acceptanceEventId: string
  reviewedBy: { type: string; id: string }
}

export interface DiscussionKnowledgePromotionAdapter {
  promote(
    evidence: DiscussionKnowledgePromotionEvidence,
  ): Record<string, unknown> | Promise<Record<string, unknown>>
}

export interface DiscussionRecord {
  id: string
  board_id: number
  discussion_type: DiscussionType
  state: DiscussionState
  title: string
  body: string
  created_by_type: DiscussionActor['type']
  created_by_id: string
  created_by_profile_id: string | null
  accepted_post_id: string | null
  resolution_summary: string | null
  superseded_by_id: string | null
  version: number
  created_at: string
  updated_at: string
  resolved_at: string | null
  archived_at: string | null
}

export interface DiscussionPost {
  id: string
  discussion_id: string
  parent_post_id: string | null
  post_kind: DiscussionPostKind
  body: string
  content_sha256: string
  author_type: DiscussionActor['type']
  author_id: string
  author_profile_id: string | null
  provider: string | null
  session_id: string | null
  automated: boolean
  requested_action: string | null
  reply_depth: number
  version: number
  created_at: string
  updated_at: string
  edited_at: string | null
}

export interface DiscussionPostNode extends DiscussionPost {
  mentions: string[]
  children: DiscussionPostNode[]
}

export interface DiscussionSnapshot {
  discussion: DiscussionRecord
  tags: string[]
  links: Array<Record<string, unknown>>
  subscriptions: string[]
  posts: DiscussionPost[]
  tree: DiscussionPostNode[]
}

export interface DiscussionListFilter {
  types?: DiscussionType[]
  states?: DiscussionState[]
  tags?: string[]
  linkType?: DiscussionLinkType
  linkTarget?: string
  authorProfileId?: string
  queue?: DiscussionQueue
  limit?: number
  offset?: number
}

interface CommandInput {
  actor: DiscussionActor
  idempotencyKey: string
  correlationId?: string | null
  causationId?: string | null
}

interface CommandSpec<T> {
  boardId: number
  commandType: string
  resultKind: string
  input: CommandInput
  fingerprint: unknown
  create(): string
  load(id: string): T
}

interface RawPost extends Omit<DiscussionPost, 'automated'> {
  automated: number
}

interface PromotionRow {
  id: string
  discussion_id: string
  post_id: string
  status: 'pending_review' | 'approved' | 'promoting' | 'promoted' | 'rejected' | 'failed'
  source_uri: string
  source_content_sha256: string
  artifact_json: string
  artifact_sha256: string
  acceptance_event_id: string
  requested_by_type: string
  requested_by_id: string
  reviewed_by_type: string | null
  reviewed_by_id: string | null
  review_note: string | null
  knowledge_result_json: string | null
  created_at: string
  reviewed_at: string | null
  promoted_at: string | null
}

const MAX_WAKE_RECIPIENTS = 50
const MAX_DISCUSSION_POSTS = 2_000
const MAX_LIST_LIMIT = 200
const MAX_SEARCH_RESULTS = 100
const SHA256 = /^[0-9a-f]{64}$/u
const TAG = /^[a-z0-9](?:[a-z0-9._/-]{0,78}[a-z0-9])?$/u

const TRANSITIONS: Readonly<Record<DiscussionState, readonly DiscussionState[]>> = Object.freeze({
  open: ['answered', 'resolved', 'needs_human', 'archived', 'superseded'],
  answered: ['open', 'resolved', 'needs_human', 'archived', 'superseded'],
  resolved: ['open', 'archived', 'superseded'],
  needs_human: ['open', 'answered', 'resolved', 'archived', 'superseded'],
  archived: ['open'],
  superseded: [],
})

/**
 * Canonical durable Discussions boundary. Low-level messages remain a wake
 * transport and are accessed only through the bounded wake adapter.
 */
export class DiscussionService {
  constructor(
    private readonly db: Database.Database,
    private readonly wakeAdapter?: DiscussionWakeAdapter,
    private readonly knowledgeAdapter?: DiscussionKnowledgePromotionAdapter,
  ) {}

  createDiscussion(input: CommandInput & {
    boardId: number
    type: DiscussionType
    title: string
    body: string
    tags?: string[]
    links?: DiscussionLinkInput[]
    mentions?: string[]
    automated?: boolean
    requestedAction?: string | null
  }): DiscussionSnapshot {
    const boardId = positiveInteger(input.boardId, 'board id')
    this.requireBoard(boardId)
    const actor = this.actor(input.actor, boardId)
    const type = member(input.type, DISCUSSION_TYPES, 'discussion type')
    const title = text(input.title, 'title', 500)
    const body = markdown(input.body, 'body', 200_000)
    const tags = normalizedTags(input.tags)
    const links = normalizedLinks(input.links)
    for (const link of links) this.assertLinkScope(link, boardId)
    const mentions = this.profiles(input.mentions, boardId)
    const automated = input.automated ?? false
    const requestedAction = optionalText(input.requestedAction, 'requested action', 4_000)
    const normalized = {
      type, title, body, tags, links, mentions, automated, requestedAction, actor,
    }
    const snapshot = this.command({
      boardId,
      commandType: 'discussion.create',
      resultKind: 'discussion',
      input,
      fingerprint: normalized,
      create: () => {
        const now = timestamp()
        const discussionId = randomUUID()
        const postId = randomUUID()
        this.db.prepare(`INSERT INTO os_discussions
          (id, board_id, discussion_type, state, title, body,
           created_by_type, created_by_id, created_by_profile_id,
           version, created_at, updated_at)
          VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, 1, ?, ?)`)
          .run(discussionId, boardId, type, title, body, actor.type, actor.id,
            actor.profileId, now, now)
        this.db.prepare(`INSERT INTO os_discussion_posts
          (id, discussion_id, parent_post_id, post_kind, body, content_sha256,
           author_type, author_id, author_profile_id, provider, session_id,
           automated, requested_action, reply_depth, version, created_at, updated_at)
          VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?)`)
          .run(postId, discussionId, rootPostKind(type), body, sha256(body),
            actor.type, actor.id, actor.profileId, actor.provider, actor.sessionId,
            automated ? 1 : 0, requestedAction, now, now)
        for (const tag of tags) this.db.prepare(
          `INSERT INTO os_discussion_tags (discussion_id, tag, created_at) VALUES (?, ?, ?)`,
        ).run(discussionId, tag, now)
        for (const link of links) this.insertLink(discussionId, link, now)
        for (const profileId of mentions) this.insertMention(postId, profileId, now)
        const eventId = this.event({
          boardId,
          discussionId,
          postId,
          eventType: 'discussion.created',
          actor,
          input,
          payload: { discussion_type: type, state: 'open', post_content_sha256: sha256(body) },
        })
        this.enqueueNotifications({
          boardId, discussionId, postId, eventId, actorProfileId: actor.profileId,
          announcement: type === 'announcement', parentAuthorProfileId: null,
          mentions, now,
        })
        this.indexPost(discussionId, postId, boardId, title, body, tags)
        return discussionId
      },
      load: (id) => this.require(id),
    })
    this.dispatchPostNotifications(snapshot.posts[0]?.id)
    return snapshot
  }

  addPost(input: CommandInput & {
    discussionId: string
    parentPostId?: string | null
    kind: DiscussionPostKind
    body: string
    mentions?: string[]
    automated?: boolean
    requestedAction?: string | null
  }): DiscussionPost {
    const discussion = this.requireDiscussion(input.discussionId)
    this.assertWritable(discussion)
    const actor = this.actor(input.actor, discussion.board_id)
    const parent = input.parentPostId
      ? this.requirePost(input.parentPostId, discussion.id) : null
    const kind = member(input.kind, DISCUSSION_POST_KINDS, 'post kind')
    const body = markdown(input.body, 'body', 200_000)
    const mentions = this.profiles(input.mentions, discussion.board_id)
    const automated = input.automated ?? false
    const requestedAction = optionalText(input.requestedAction, 'requested action', 4_000)
    if (automated && parent?.automated && !parent.requested_action) {
      throw new ForbiddenError('automated reply loops are prohibited')
    }
    if (automated && parent && sameActor(parent, actor)) {
      throw new ForbiddenError('automated self-replies are prohibited')
    }
    const depth = parent ? parent.reply_depth + 1 : 0
    if (depth > 1_024) throw new ValidationError('discussion reply depth exceeded')
    const postCount = this.db.prepare(`SELECT COUNT(*) AS count
      FROM os_discussion_posts WHERE discussion_id=?`).get(discussion.id) as { count: number }
    if (postCount.count >= MAX_DISCUSSION_POSTS) {
      throw new ValidationError(`discussion may have at most ${MAX_DISCUSSION_POSTS} posts`)
    }
    const normalized = {
      discussionId: discussion.id, parentPostId: parent?.id ?? null,
      kind, body, mentions, automated, requestedAction, actor,
    }
    const post = this.command({
      boardId: discussion.board_id,
      commandType: 'discussion.post.create',
      resultKind: 'post',
      input,
      fingerprint: normalized,
      create: () => {
        const now = timestamp()
        const postId = randomUUID()
        this.db.prepare(`INSERT INTO os_discussion_posts
          (id, discussion_id, parent_post_id, post_kind, body, content_sha256,
           author_type, author_id, author_profile_id, provider, session_id,
           automated, requested_action, reply_depth, version, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`)
          .run(postId, discussion.id, parent?.id ?? null, kind, body, sha256(body),
            actor.type, actor.id, actor.profileId, actor.provider, actor.sessionId,
            automated ? 1 : 0, requestedAction, depth, now, now)
        for (const profileId of mentions) this.insertMention(postId, profileId, now)
        const eventId = this.event({
          boardId: discussion.board_id,
          discussionId: discussion.id,
          postId,
          eventType: 'discussion.post.created',
          actor,
          input: { ...input, causationId: input.causationId ?? this.postEventId(parent?.id) },
          payload: {
            parent_post_id: parent?.id ?? null,
            post_kind: kind,
            content_sha256: sha256(body),
            automated,
          },
        })
        this.enqueueNotifications({
          boardId: discussion.board_id,
          discussionId: discussion.id,
          postId,
          eventId,
          actorProfileId: actor.profileId,
          announcement: discussion.discussion_type === 'announcement' || kind === 'announcement',
          parentAuthorProfileId: parent?.author_profile_id ?? null,
          mentions,
          now,
        })
        this.db.prepare(`UPDATE os_discussions
          SET updated_at=?, version=version+1 WHERE id=?`).run(now, discussion.id)
        this.indexPost(discussion.id, postId, discussion.board_id,
          discussion.title, body, this.tags(discussion.id))
        return postId
      },
      load: (id) => this.requirePost(id, discussion.id),
    })
    this.dispatchPostNotifications(post.id)
    return post
  }

  editPost(input: CommandInput & {
    discussionId: string
    postId: string
    body: string
    expectedVersion: number
  }): DiscussionPost {
    const discussion = this.requireDiscussion(input.discussionId)
    this.assertWritable(discussion)
    const actor = this.actor(input.actor, discussion.board_id)
    const retained = this.requirePost(input.postId, discussion.id)
    if (!sameActor(retained, actor)
      && !this.hasPermission(discussion, actor, 'edit')
      && !this.hasPermission(discussion, actor, 'moderate')) {
      throw new ForbiddenError('post edit permission is required')
    }
    const body = markdown(input.body, 'body', 200_000)
    const expectedVersion = positiveInteger(input.expectedVersion, 'expected version')
    return this.command({
      boardId: discussion.board_id,
      commandType: 'discussion.post.edit',
      resultKind: 'post',
      input,
      fingerprint: { discussionId: discussion.id, postId: retained.id, body, expectedVersion, actor },
      create: () => {
        if (retained.version !== expectedVersion) throw new ConflictError('post version changed')
        if (discussion.accepted_post_id === retained.id) {
          throw new ConflictError('an accepted answer is immutable')
        }
        if (this.db.prepare(`SELECT 1 FROM os_discussion_promotions
          WHERE post_id=? AND status IN ('approved','promoted')`).get(retained.id)) {
          throw new ConflictError('an approved promotion makes the exact source immutable')
        }
        const now = timestamp()
        const result = this.db.prepare(`UPDATE os_discussion_posts
          SET body=?, content_sha256=?, version=version+1, updated_at=?, edited_at=?
          WHERE id=? AND version=?`).run(body, sha256(body), now, now,
            retained.id, expectedVersion)
        if (result.changes !== 1) throw new ConflictError('post version changed')
        this.event({
          boardId: discussion.board_id,
          discussionId: discussion.id,
          postId: retained.id,
          eventType: 'discussion.post.edited',
          actor,
          input,
          payload: {
            prior_content_sha256: retained.content_sha256,
            content_sha256: sha256(body),
            prior_version: retained.version,
          },
        })
        this.db.prepare(`DELETE FROM os_discussion_search WHERE post_id=?`).run(retained.id)
        this.indexPost(discussion.id, retained.id, discussion.board_id,
          discussion.title, body, this.tags(discussion.id))
        return retained.id
      },
      load: (id) => this.requirePost(id, discussion.id),
    })
  }

  acceptAnswer(input: CommandInput & {
    discussionId: string
    postId: string
  }): DiscussionSnapshot {
    const discussion = this.requireDiscussion(input.discussionId)
    this.assertWritable(discussion)
    const actor = this.actor(input.actor, discussion.board_id)
    const post = this.requirePost(input.postId, discussion.id)
    if (post.post_kind !== 'answer') throw new ValidationError('accepted post must be an answer')
    if (!this.canResolve(discussion, actor)) {
      throw new ForbiddenError('answer acceptance permission is required')
    }
    if (sameActor(post, actor)) throw new ForbiddenError('authors cannot accept their own answer')
    return this.command({
      boardId: discussion.board_id,
      commandType: 'discussion.answer.accept',
      resultKind: 'discussion',
      input,
      fingerprint: { discussionId: discussion.id, postId: post.id, actor },
      create: () => {
        const current = this.requireDiscussion(discussion.id)
        if (current.accepted_post_id && current.accepted_post_id !== post.id) {
          throw new ConflictError('discussion already has an accepted answer')
        }
        const now = timestamp()
        this.db.prepare(`UPDATE os_discussions SET accepted_post_id=?, state='answered',
          version=version+1, updated_at=?, resolved_at=NULL, archived_at=NULL
          WHERE id=?`).run(post.id, now, discussion.id)
        this.event({
          boardId: discussion.board_id,
          discussionId: discussion.id,
          postId: post.id,
          eventType: 'discussion.answer.accepted',
          actor,
          input,
          payload: { post_id: post.id, content_sha256: post.content_sha256 },
        })
        return discussion.id
      },
      load: (id) => this.require(id),
    })
  }

  transition(input: CommandInput & {
    discussionId: string
    state: DiscussionState
    resolutionSummary?: string | null
    supersededById?: string | null
  }): DiscussionSnapshot {
    const discussion = this.requireDiscussion(input.discussionId)
    const actor = this.actor(input.actor, discussion.board_id)
    const state = member(input.state, DISCUSSION_STATES, 'discussion state')
    const replayCandidate = discussion.state === state
      && this.db.prepare(`SELECT 1 FROM os_discussion_commands
        WHERE board_id=? AND idempotency_key=? AND command_type='discussion.transition'`)
        .get(discussion.board_id, input.idempotencyKey)
    if (discussion.state !== state && !TRANSITIONS[discussion.state].includes(state)) {
      throw new ConflictError(`discussion cannot transition from ${discussion.state} to ${state}`)
    }
    if (discussion.state === state && !replayCandidate) {
      throw new ConflictError(`discussion is already ${state}`)
    }
    if (state === 'answered' && !discussion.accepted_post_id) {
      throw new ConflictError('answered state requires an accepted answer')
    }
    const moderate = state === 'archived' || state === 'superseded'
      || discussion.state === 'archived'
    if (moderate
      ? !this.hasPermission(discussion, actor, 'moderate')
      : !this.canResolve(discussion, actor)) {
      throw new ForbiddenError(`${moderate ? 'moderation' : 'resolution'} permission is required`)
    }
    const resolution = optionalMarkdown(
      input.resolutionSummary,
      'resolution summary',
      20_000,
    )
    if (state === 'resolved' && !resolution) {
      throw new ValidationError('resolved discussion requires a resolution summary')
    }
    const supersededBy = state === 'superseded'
      ? this.requireDiscussion(text(input.supersededById, 'superseded by id', 200)) : null
    if (supersededBy && (supersededBy.id === discussion.id
      || supersededBy.board_id !== discussion.board_id)) {
      throw new ValidationError('superseding discussion must be distinct and on the same board')
    }
    return this.command({
      boardId: discussion.board_id,
      commandType: 'discussion.transition',
      resultKind: 'discussion',
      input,
      fingerprint: {
        discussionId: discussion.id, state,
        resolution, supersededById: supersededBy?.id ?? null, actor,
      },
      create: () => {
        const now = timestamp()
        this.db.prepare(`UPDATE os_discussions SET state=?, resolution_summary=?,
          superseded_by_id=?, resolved_at=?, archived_at=?, version=version+1, updated_at=?
          WHERE id=?`).run(
            state,
            state === 'resolved' ? resolution : null,
            supersededBy?.id ?? null,
            state === 'resolved' ? now : null,
            state === 'archived' || state === 'superseded' ? now : null,
            now,
            discussion.id,
          )
        this.event({
          boardId: discussion.board_id,
          discussionId: discussion.id,
          postId: null,
          eventType: 'discussion.state.changed',
          actor,
          input,
          payload: {
            from: discussion.state, to: state,
            resolution_summary: state === 'resolved' ? resolution : null,
            superseded_by_id: supersededBy?.id ?? null,
          },
        })
        return discussion.id
      },
      load: (id) => this.require(id),
    })
  }

  subscribe(input: CommandInput & {
    discussionId: string
    profileId: string
  }): DiscussionSnapshot {
    const discussion = this.requireDiscussion(input.discussionId)
    const actor = this.actor(input.actor, discussion.board_id)
    const profileId = this.profile(input.profileId, discussion.board_id)
    if (actor.type !== 'operator' && actor.profileId !== profileId) {
      throw new ForbiddenError('actors may subscribe only themselves')
    }
    return this.command({
      boardId: discussion.board_id,
      commandType: 'discussion.subscribe',
      resultKind: 'discussion',
      input,
      fingerprint: { discussionId: discussion.id, profileId, actor },
      create: () => {
        const retained = this.db.prepare(`SELECT 1 FROM os_discussion_subscriptions
          WHERE discussion_id=? AND profile_id=?`).get(discussion.id, profileId)
        const count = this.db.prepare(`SELECT COUNT(*) AS count
          FROM os_discussion_subscriptions WHERE discussion_id=?`).get(discussion.id) as
          { count: number }
        if (!retained && count.count >= MAX_WAKE_RECIPIENTS) {
          throw new ValidationError(
            `discussion subscriptions may contain at most ${MAX_WAKE_RECIPIENTS} profiles`,
          )
        }
        this.db.prepare(`INSERT OR IGNORE INTO os_discussion_subscriptions
          (discussion_id, profile_id, created_by_type, created_by_id, created_at)
          VALUES (?, ?, ?, ?, ?)`).run(discussion.id, profileId,
            actor.type, actor.id, timestamp())
        this.event({
          boardId: discussion.board_id,
          discussionId: discussion.id,
          postId: null,
          eventType: 'discussion.subscription.created',
          actor,
          input,
          payload: { profile_id: profileId },
        })
        return discussion.id
      },
      load: (id) => this.require(id),
    })
  }

  unsubscribe(input: CommandInput & {
    discussionId: string
    profileId: string
  }): DiscussionSnapshot {
    const discussion = this.requireDiscussion(input.discussionId)
    const actor = this.actor(input.actor, discussion.board_id)
    const profileId = this.profile(input.profileId, discussion.board_id)
    if (actor.type !== 'operator' && actor.profileId !== profileId) {
      throw new ForbiddenError('actors may unsubscribe only themselves')
    }
    return this.command({
      boardId: discussion.board_id,
      commandType: 'discussion.unsubscribe',
      resultKind: 'discussion',
      input,
      fingerprint: { discussionId: discussion.id, profileId, actor },
      create: () => {
        this.db.prepare(`DELETE FROM os_discussion_subscriptions
          WHERE discussion_id=? AND profile_id=?`).run(discussion.id, profileId)
        this.event({
          boardId: discussion.board_id,
          discussionId: discussion.id,
          postId: null,
          eventType: 'discussion.subscription.deleted',
          actor,
          input,
          payload: { profile_id: profileId },
        })
        return discussion.id
      },
      load: (id) => this.require(id),
    })
  }

  grantPermission(input: CommandInput & {
    boardId: number
    discussionId: string
    subjectType: 'operator' | 'profile' | 'service'
    subjectId: string
    permission: DiscussionPermission
    reason: string
    expiresAt?: string | null
  }): Record<string, unknown> {
    const boardId = positiveInteger(input.boardId, 'board id')
    const actor = this.actor(input.actor, boardId)
    if (actor.type !== 'operator') throw new ForbiddenError('operator authorization is required')
    const discussion = this.requireDiscussion(input.discussionId)
    if (discussion.board_id !== boardId) throw new NotFoundError('discussion not found')
    const subjectType = member(input.subjectType,
      ['operator', 'profile', 'service'] as const, 'subject type')
    const subjectId = text(input.subjectId, 'subject id', 300)
    if (subjectType === 'profile') this.profile(subjectId, boardId)
    const permission = member(input.permission, DISCUSSION_PERMISSIONS, 'permission')
    const reason = text(input.reason, 'reason', 2_000)
    const expiresAt = optionalIso(input.expiresAt, 'expires at')
    return this.command({
      boardId,
      commandType: 'discussion.permission.grant',
      resultKind: 'permission',
      input,
      fingerprint: {
        discussionId: discussion.id, subjectType, subjectId,
        permission, reason, expiresAt, actor,
      },
      create: () => {
        const id = randomUUID()
        this.db.prepare(`INSERT INTO os_discussion_permissions
          (id, board_id, discussion_id, subject_type, subject_id, permission,
           granted_by_type, granted_by_id, reason, expires_at, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(id, boardId, discussion.id, subjectType, subjectId,
            permission, actor.type, actor.id, reason, expiresAt, timestamp())
        this.event({
          boardId, discussionId: discussion.id, postId: null,
          eventType: 'discussion.permission.granted', actor, input,
          payload: { permission_id: id, subject_type: subjectType, subject_id: subjectId,
            permission, expires_at: expiresAt },
        })
        return id
      },
      load: (id) => this.permission(id),
    })
  }

  revokePermission(input: CommandInput & {
    permissionId: string
  }): Record<string, unknown> {
    const retained = this.permission(input.permissionId)
    const boardId = Number(retained.board_id)
    const actor = this.actor(input.actor, boardId)
    if (actor.type !== 'operator') throw new ForbiddenError('operator authorization is required')
    return this.command({
      boardId,
      commandType: 'discussion.permission.revoke',
      resultKind: 'permission',
      input,
      fingerprint: { permissionId: input.permissionId, actor },
      create: () => {
        this.db.prepare(`UPDATE os_discussion_permissions SET revoked_at=?
          WHERE id=? AND revoked_at IS NULL`).run(timestamp(), input.permissionId)
        const discussionId = typeof retained.discussion_id === 'string'
          ? retained.discussion_id : null
        if (discussionId) this.event({
          boardId, discussionId, postId: null,
          eventType: 'discussion.permission.revoked', actor, input,
          payload: { permission_id: input.permissionId },
        })
        return input.permissionId
      },
      load: (id) => this.permission(id),
    })
  }

  requestPromotion(input: CommandInput & {
    discussionId: string
    postId: string
  }): PromotionRow {
    const discussion = this.requireDiscussion(input.discussionId)
    const actor = this.actor(input.actor, discussion.board_id)
    const post = this.requirePost(input.postId, discussion.id)
    if (!this.hasPermission(discussion, actor, 'promote_knowledge')) {
      throw new ForbiddenError('knowledge promotion permission is required')
    }
    if (discussion.accepted_post_id !== post.id) {
      throw new ConflictError('only the currently accepted answer may be promoted')
    }
    const accepted = this.acceptanceEvidence(discussion.id, post)
    const artifact = canonicalKnowledgeJson({
      schema_version: 1,
      kind: 'discussion_answer',
      key: `discussion:${discussion.id}:post:${post.id}`,
      title: discussion.title,
      content: post.body,
      accepted_at: String(accepted.created_at),
      accepted_by: `${String(accepted.actor_type)}:${String(accepted.actor_id)}`,
    })
    const sourceUri = `discussion://${discussion.id}/posts/${post.id}@sha256:${post.content_sha256}`
    return this.command({
      boardId: discussion.board_id,
      commandType: 'discussion.promotion.request',
      resultKind: 'promotion',
      input,
      fingerprint: {
        discussionId: discussion.id, postId: post.id,
        sourceUri, sourceContentSha256: post.content_sha256,
        artifactSha256: sha256(artifact), acceptanceEventId: String(accepted.id), actor,
      },
      create: () => {
        const id = randomUUID()
        this.db.prepare(`INSERT INTO os_discussion_promotions
          (id, discussion_id, post_id, status, source_uri,
           source_content_sha256, artifact_json, artifact_sha256,
           acceptance_event_id, requested_by_type, requested_by_id, created_at)
          VALUES (?, ?, ?, 'pending_review', ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(id, discussion.id, post.id, sourceUri, post.content_sha256,
            artifact, sha256(artifact), String(accepted.id), actor.type, actor.id, timestamp())
        this.event({
          boardId: discussion.board_id, discussionId: discussion.id, postId: post.id,
          eventType: 'discussion.promotion.requested', actor, input,
          payload: {
            promotion_id: id, source_uri: sourceUri,
            source_content_sha256: post.content_sha256,
            artifact_sha256: sha256(artifact), acceptance_event_id: String(accepted.id),
          },
        })
        return id
      },
      load: (id) => this.requirePromotion(id),
    })
  }

  async reviewPromotion(input: CommandInput & {
    promotionId: string
    decision: 'approve' | 'reject'
    note: string
  }): Promise<PromotionRow> {
    const retained = this.requirePromotion(input.promotionId)
    const discussion = this.requireDiscussion(retained.discussion_id)
    const actor = this.actor(input.actor, discussion.board_id)
    if (!this.hasPermission(discussion, actor, 'promote_knowledge')) {
      throw new ForbiddenError('knowledge promotion permission is required')
    }
    if (retained.requested_by_type === actor.type && retained.requested_by_id === actor.id) {
      throw new ForbiddenError('promotion requester cannot review their own request')
    }
    const decision = member(input.decision, ['approve', 'reject'] as const, 'decision')
    const note = text(input.note, 'review note', 4_000)
    const reviewed = this.command({
      boardId: discussion.board_id,
      commandType: 'discussion.promotion.review',
      resultKind: 'promotion',
      input,
      fingerprint: { promotionId: retained.id, decision, note, actor },
      create: () => {
        const current = this.requirePromotion(retained.id)
        if (current.status !== 'pending_review') {
          throw new ConflictError('promotion has already been reviewed')
        }
        const post = this.requirePost(current.post_id, discussion.id)
        this.acceptanceEvidence(discussion.id, post, current.acceptance_event_id)
        if (post.content_sha256 !== current.source_content_sha256
          || discussion.accepted_post_id !== post.id
          || sha256(current.artifact_json) !== current.artifact_sha256) {
          throw new ConflictError('promotion exact-source evidence changed before review')
        }
        const now = timestamp()
        this.db.prepare(`UPDATE os_discussion_promotions
          SET status=?, reviewed_by_type=?, reviewed_by_id=?, review_note=?, reviewed_at=?
          WHERE id=?`).run(decision === 'approve' ? 'approved' : 'rejected',
            actor.type, actor.id, note, now, current.id)
        this.event({
          boardId: discussion.board_id, discussionId: discussion.id, postId: post.id,
          eventType: decision === 'approve'
            ? 'discussion.promotion.approved' : 'discussion.promotion.rejected',
          actor, input,
          payload: {
            promotion_id: current.id, decision, source_uri: current.source_uri,
            source_content_sha256: current.source_content_sha256,
            artifact_sha256: current.artifact_sha256,
          },
        })
        return current.id
      },
      load: (id) => this.requirePromotion(id),
    })
    if (reviewed.status !== 'approved' || !this.knowledgeAdapter) return reviewed
    const claimed = this.db.prepare(`UPDATE os_discussion_promotions
      SET status='promoting' WHERE id=? AND status='approved'`).run(reviewed.id)
    if (claimed.changes !== 1) return this.requirePromotion(reviewed.id)
    try {
      const result = await this.knowledgeAdapter.promote({
        promotionId: reviewed.id,
        boardId: discussion.board_id,
        discussionId: discussion.id,
        postId: reviewed.post_id,
        sourceUri: reviewed.source_uri,
        sourceContentSha256: reviewed.source_content_sha256,
        artifactJson: reviewed.artifact_json,
        artifactSha256: reviewed.artifact_sha256,
        acceptanceEventId: reviewed.acceptance_event_id,
        reviewedBy: { type: actor.type, id: actor.id },
      })
      let resultJson: string
      try {
        resultJson = canonicalKnowledgeJson(result)
      } catch {
        resultJson = canonicalKnowledgeJson({
          status: 'completed',
          result_withheld: 'invalid_adapter_result',
        })
      }
      this.db.transaction(() => {
        this.db.prepare(`UPDATE os_discussion_promotions SET status='promoted',
          knowledge_result_json=?, promoted_at=? WHERE id=? AND status='promoting'`)
          .run(resultJson, timestamp(), reviewed.id)
        this.event({
          boardId: discussion.board_id,
          discussionId: discussion.id,
          postId: reviewed.post_id,
          eventType: 'discussion.promotion.completed',
          actor,
          input: {
            ...input,
            idempotencyKey: `${input.idempotencyKey}:promotion-completed`,
            causationId: null,
          },
          payload: {
            promotion_id: reviewed.id,
            source_uri: reviewed.source_uri,
            source_content_sha256: reviewed.source_content_sha256,
            artifact_sha256: reviewed.artifact_sha256,
          },
        })
      })()
    } catch {
      this.db.transaction(() => {
        this.db.prepare(`UPDATE os_discussion_promotions SET status='failed'
          WHERE id=? AND status='promoting'`).run(reviewed.id)
        this.event({
          boardId: discussion.board_id,
          discussionId: discussion.id,
          postId: reviewed.post_id,
          eventType: 'discussion.promotion.failed',
          actor,
          input: {
            ...input,
            idempotencyKey: `${input.idempotencyKey}:promotion-failed`,
            causationId: null,
          },
          payload: {
            promotion_id: reviewed.id,
            failure_code: 'knowledge_adapter_failed',
          },
        })
      })()
    }
    return this.requirePromotion(reviewed.id)
  }

  get(id: string): DiscussionSnapshot | null {
    const discussion = this.db.prepare(`SELECT * FROM os_discussions WHERE id=?`)
      .get(id) as DiscussionRecord | undefined
    return discussion ? this.snapshot(discussion) : null
  }

  require(id: string): DiscussionSnapshot {
    const value = this.get(id)
    if (!value) throw new NotFoundError('discussion not found')
    return value
  }

  list(boardId: number, filter: DiscussionListFilter = {}): DiscussionRecord[] {
    this.requireBoard(positiveInteger(boardId, 'board id'))
    const clauses = ['d.board_id=?']
    const values: unknown[] = [boardId]
    appendIn(clauses, values, 'd.discussion_type', filter.types, DISCUSSION_TYPES,
      'discussion type')
    appendIn(clauses, values, 'd.state', filter.states, DISCUSSION_STATES,
      'discussion state')
    for (const tag of normalizedTags(filter.tags)) {
      clauses.push(`EXISTS (SELECT 1 FROM os_discussion_tags t
        WHERE t.discussion_id=d.id AND t.tag=?)`)
      values.push(tag)
    }
    if (filter.linkType) {
      clauses.push(`EXISTS (SELECT 1 FROM os_discussion_links l
        WHERE l.discussion_id=d.id AND l.link_type=?${filter.linkTarget
          ? ' AND (l.target_id=? OR l.target_path=?)' : ''})`)
      values.push(member(filter.linkType, DISCUSSION_LINK_TYPES, 'link type'))
      if (filter.linkTarget) values.push(filter.linkTarget, filter.linkTarget)
    }
    if (filter.authorProfileId) {
      clauses.push(`EXISTS (SELECT 1 FROM os_discussion_posts p
        WHERE p.discussion_id=d.id AND p.author_profile_id=?)`)
      values.push(filter.authorProfileId)
    }
    if (filter.queue === 'needs_human') clauses.push(`d.state='needs_human'`)
    if (filter.queue === 'unanswered') clauses.push(`d.discussion_type='question'
      AND d.state='open' AND d.accepted_post_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM os_discussion_posts p
        WHERE p.discussion_id=d.id AND p.post_kind='answer')`)
    const limit = boundedInteger(filter.limit ?? 50, 'limit', 1, MAX_LIST_LIMIT)
    const offset = boundedInteger(filter.offset ?? 0, 'offset', 0, 1_000_000)
    values.push(limit, offset)
    return this.db.prepare(`SELECT d.* FROM os_discussions d
      WHERE ${clauses.join(' AND ')}
      ORDER BY d.updated_at DESC, d.id DESC LIMIT ? OFFSET ?`).all(...values) as
      DiscussionRecord[]
  }

  search(boardId: number, query: string, filter: DiscussionListFilter = {}): DiscussionRecord[] {
    this.requireBoard(positiveInteger(boardId, 'board id'))
    const term = text(query, 'query', 1_000)
    const limit = boundedInteger(filter.limit ?? 50, 'limit', 1, MAX_SEARCH_RESULTS)
    let ids: string[]
    try {
      ids = (this.db.prepare(`SELECT DISTINCT discussion_id
        FROM os_discussion_search WHERE board_id=? AND os_discussion_search MATCH ?
        ORDER BY rank LIMIT ?`).all(String(boardId), term, limit) as Array<{ discussion_id: string }>)
        .map((row) => row.discussion_id)
    } catch {
      throw new ValidationError('search query is invalid')
    }
    if (!ids.length) return []
    const filtered = new Set(this.list(boardId, { ...filter, limit: MAX_LIST_LIMIT })
      .map((item) => item.id))
    return ids.filter((id) => filtered.has(id))
      .map((id) => this.requireDiscussion(id))
  }

  queue(boardId: number, queue: DiscussionQueue, limit = 50): DiscussionRecord[] {
    return this.list(boardId, { queue, limit })
  }

  notifications(profileId: string, statuses: Array<'pending' | 'failed'> = ['pending', 'failed']):
  Array<Record<string, unknown>> {
    if (!statuses.length) return []
    return this.db.prepare(`SELECT * FROM os_discussion_notifications
      WHERE recipient_profile_id=? AND status IN (${statuses.map(() => '?').join(',')})
      ORDER BY created_at, id LIMIT 200`).all(profileId, ...statuses) as
      Array<Record<string, unknown>>
  }

  promotions(boardId: number, status?: PromotionRow['status']): PromotionRow[] {
    const sql = `SELECT p.* FROM os_discussion_promotions p
      JOIN os_discussions d ON d.id=p.discussion_id WHERE d.board_id=?`
      + (status ? ' AND p.status=?' : '') + ' ORDER BY p.created_at, p.id LIMIT 200'
    return this.db.prepare(sql).all(...(status ? [boardId, status] : [boardId])) as PromotionRow[]
  }

  async retryPendingNotifications(postId?: string): Promise<number> {
    return this.dispatchPostNotifications(postId)
  }

  private command<T>(spec: CommandSpec<T>): T {
    const key = text(spec.input.idempotencyKey, 'idempotency key', 300)
    const fingerprint = sha256(canonicalKnowledgeJson({
      command_type: spec.commandType,
      actor: spec.input.actor,
      value: spec.fingerprint,
    }))
    return this.db.transaction(() => {
      const retained = this.db.prepare(`SELECT * FROM os_discussion_commands
        WHERE board_id=? AND idempotency_key=?`).get(spec.boardId, key) as
        | Record<string, unknown> | undefined
      if (retained) {
        if (retained.command_type !== spec.commandType
          || retained.fingerprint_sha256 !== fingerprint
          || retained.result_kind !== spec.resultKind) {
          throw new ConflictError('idempotency key was already used for a different command')
        }
        return spec.load(String(retained.result_id))
      }
      const resultId = spec.create()
      this.db.prepare(`INSERT INTO os_discussion_commands
        (board_id, idempotency_key, command_type, fingerprint_sha256,
         result_kind, result_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(spec.boardId, key, spec.commandType, fingerprint,
          spec.resultKind, resultId, timestamp())
      return spec.load(resultId)
    })()
  }

  private event(input: {
    boardId: number
    discussionId: string
    postId: string | null
    eventType: string
    actor: Required<Pick<DiscussionActor, 'type' | 'id'>> & DiscussionActor
    input: CommandInput
    payload: Record<string, unknown>
  }): string {
    const id = randomUUID()
    const correlationId = optionalText(input.input.correlationId,
      'correlation id', 512) ?? text(input.input.idempotencyKey, 'idempotency key', 300)
    let causationId = optionalText(input.input.causationId, 'causation id', 512)
    if (!causationId && input.eventType !== 'discussion.created') {
      const previous = this.db.prepare(`SELECT id FROM os_discussion_events
        WHERE discussion_id=? ORDER BY rowid DESC LIMIT 1`)
        .get(input.discussionId) as { id: string } | undefined
      causationId = previous?.id ?? null
    }
    if (causationId) {
      const cause = this.db.prepare(`SELECT discussion_id FROM os_discussion_events WHERE id=?`)
        .get(causationId) as { discussion_id: string } | undefined
      if (!cause || cause.discussion_id !== input.discussionId) {
        throw new ValidationError('causation event must belong to the same discussion')
      }
    }
    this.db.prepare(`INSERT INTO os_discussion_events
      (id, board_id, discussion_id, post_id, event_type, event_version,
       actor_type, actor_id, actor_profile_id, correlation_id, causation_id,
       idempotency_key, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.boardId, input.discussionId, input.postId, input.eventType,
        input.actor.type, input.actor.id, input.actor.profileId ?? null,
        correlationId, causationId, text(input.input.idempotencyKey, 'idempotency key', 300),
        canonicalKnowledgeJson(input.payload), timestamp())
    return id
  }

  private enqueueNotifications(input: {
    boardId: number
    discussionId: string
    postId: string
    eventId: string
    actorProfileId: string | null
    announcement: boolean
    parentAuthorProfileId: string | null
    mentions: string[]
    now: string
  }): void {
    const reasons = new Map<string, 'mention' | 'subscription' | 'direct_reply'>()
    for (const profileId of input.mentions) reasons.set(profileId, 'mention')
    const subscriptions = this.db.prepare(`SELECT profile_id
      FROM os_discussion_subscriptions WHERE discussion_id=? ORDER BY profile_id`)
      .all(input.discussionId) as Array<{ profile_id: string }>
    for (const { profile_id } of subscriptions) {
      if (!reasons.has(profile_id)) reasons.set(profile_id, 'subscription')
    }
    if (!input.announcement && input.parentAuthorProfileId
      && !reasons.has(input.parentAuthorProfileId)) {
      reasons.set(input.parentAuthorProfileId, 'direct_reply')
    }
    if (input.actorProfileId) reasons.delete(input.actorProfileId)
    if (reasons.size > MAX_WAKE_RECIPIENTS) {
      throw new ValidationError(`discussion wake fanout exceeds ${MAX_WAKE_RECIPIENTS} recipients`)
    }
    for (const [profileId, reason] of [...reasons].sort(([left], [right]) =>
      left.localeCompare(right))) {
      this.db.prepare(`INSERT INTO os_discussion_notifications
        (id, discussion_id, post_id, recipient_profile_id, reason,
         causation_event_id, status, attempt_count, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?)`)
        .run(randomUUID(), input.discussionId, input.postId, profileId,
          reason, input.eventId, input.now)
    }
  }

  private async dispatchPostNotifications(postId?: string): Promise<number> {
    if (!postId || !this.wakeAdapter) return 0
    const rows = this.db.transaction(() => {
      const candidates = this.db.prepare(`SELECT n.*, d.board_id
        FROM os_discussion_notifications n
        JOIN os_discussions d ON d.id=n.discussion_id
        WHERE n.post_id=? AND n.status IN ('pending','failed') AND n.attempt_count<10
        ORDER BY n.recipient_profile_id LIMIT ?`).all(postId, MAX_WAKE_RECIPIENTS) as
        Array<Record<string, unknown>>
      const claim = this.db.prepare(`UPDATE os_discussion_notifications
        SET status='delivering' WHERE id=? AND status IN ('pending','failed')
          AND attempt_count<10`)
      return candidates.filter((row) => claim.run(row.id).changes === 1)
    })()
    if (!rows.length) return 0
    const reasons: Record<string, 'mention' | 'subscription' | 'direct_reply'> = {}
    for (const row of rows) reasons[String(row.recipient_profile_id)] = row.reason as never
    try {
      await this.wakeAdapter.wake({
        boardId: Number(rows[0].board_id),
        discussionId: String(rows[0].discussion_id),
        postId,
        causationEventId: String(rows[0].causation_event_id),
        recipientProfileIds: rows.map((row) => String(row.recipient_profile_id)),
        reasons,
      })
      const now = timestamp()
      const update = this.db.prepare(`UPDATE os_discussion_notifications
        SET status='delivered', attempt_count=attempt_count+1,
          last_error_code=NULL, delivered_at=? WHERE id=? AND status='delivering'`)
      this.db.transaction(() => rows.forEach((row) => update.run(now, row.id)))()
      return rows.length
    } catch {
      const update = this.db.prepare(`UPDATE os_discussion_notifications
        SET status='failed', attempt_count=attempt_count+1,
          last_error_code='adapter_failed' WHERE id=? AND status='delivering'`)
      this.db.transaction(() => rows.forEach((row) => update.run(row.id)))()
      return 0
    }
  }

  private actor(value: DiscussionActor, boardId: number): DiscussionActor & {
    profileId: string | null
    provider: string | null
    sessionId: string | null
  } {
    if (!value || !['operator', 'agent', 'service'].includes(value.type)) {
      throw new ValidationError('actor is invalid')
    }
    const actor = {
      type: value.type,
      id: text(value.id, 'actor id', 300),
      profileId: value.profileId ? this.profile(value.profileId, boardId) : null,
      provider: optionalText(value.provider, 'provider', 100),
      sessionId: optionalText(value.sessionId, 'session id', 200),
    }
    if (actor.type === 'agent' && !actor.profileId) {
      throw new ValidationError('agent actor requires a profile id')
    }
    if (actor.sessionId) {
      const session = this.db.prepare(`SELECT workspace.board_id, session.profile_id,
          session.provider FROM agent_sessions session
          JOIN workspaces workspace ON workspace.id=session.workspace_id
          WHERE session.id=?`).get(actor.sessionId) as
        | { board_id: number; profile_id: string | null; provider: string } | undefined
      if (!session || session.board_id !== boardId
        || (actor.profileId && session.profile_id !== actor.profileId)
        || (actor.provider && session.provider !== actor.provider)) {
        throw new ValidationError('actor session provenance does not match board/profile/provider')
      }
    }
    return actor
  }

  private hasPermission(
    discussion: DiscussionRecord,
    actor: DiscussionActor,
    permission: DiscussionPermission,
  ): boolean {
    if (actor.type === 'operator') return true
    const subjectType = actor.type === 'agent' ? 'profile' : 'service'
    const subjectId = actor.type === 'agent' ? actor.profileId : actor.id
    if (!subjectId) return false
    return Boolean(this.db.prepare(`SELECT 1 FROM os_discussion_permissions
      WHERE board_id=? AND (discussion_id IS NULL OR discussion_id=?)
        AND subject_type=? AND subject_id=? AND permission=?
        AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?) LIMIT 1`)
      .get(discussion.board_id, discussion.id, subjectType, subjectId,
        permission, timestamp()))
  }

  private canResolve(discussion: DiscussionRecord, actor: DiscussionActor): boolean {
    return (discussion.created_by_type === actor.type
      && discussion.created_by_id === actor.id)
      || this.hasPermission(discussion, actor, 'resolve')
      || this.hasPermission(discussion, actor, 'moderate')
  }

  private snapshot(discussion: DiscussionRecord): DiscussionSnapshot {
    const posts = (this.db.prepare(`SELECT * FROM os_discussion_posts
      WHERE discussion_id=? ORDER BY created_at, id`).all(discussion.id) as RawPost[])
      .map(mapPost)
    const mentionRows = this.db.prepare(`SELECT m.post_id, m.profile_id
      FROM os_discussion_mentions m JOIN os_discussion_posts p ON p.id=m.post_id
      WHERE p.discussion_id=? ORDER BY m.post_id, m.profile_id`).all(discussion.id) as
      Array<{ post_id: string; profile_id: string }>
    const mentions = new Map<string, string[]>()
    for (const row of mentionRows) {
      const list = mentions.get(row.post_id) ?? []
      list.push(row.profile_id)
      mentions.set(row.post_id, list)
    }
    return {
      discussion,
      tags: this.tags(discussion.id),
      links: this.db.prepare(`SELECT * FROM os_discussion_links
        WHERE discussion_id=? ORDER BY link_type, target_id, target_path, id`)
        .all(discussion.id) as Array<Record<string, unknown>>,
      subscriptions: (this.db.prepare(`SELECT profile_id FROM os_discussion_subscriptions
        WHERE discussion_id=? ORDER BY profile_id`).all(discussion.id) as
        Array<{ profile_id: string }>).map((row) => row.profile_id),
      posts,
      tree: postTree(posts, mentions),
    }
  }

  private requireDiscussion(id: string): DiscussionRecord {
    const row = this.db.prepare(`SELECT * FROM os_discussions WHERE id=?`)
      .get(text(id, 'discussion id', 200)) as DiscussionRecord | undefined
    if (!row) throw new NotFoundError('discussion not found')
    return row
  }

  private requirePost(id: string, discussionId?: string): DiscussionPost {
    const row = this.db.prepare(`SELECT * FROM os_discussion_posts WHERE id=?`)
      .get(text(id, 'post id', 200)) as RawPost | undefined
    if (!row || (discussionId && row.discussion_id !== discussionId)) {
      throw new NotFoundError('discussion post not found')
    }
    return mapPost(row)
  }

  private requirePromotion(id: string): PromotionRow {
    const row = this.db.prepare(`SELECT * FROM os_discussion_promotions WHERE id=?`)
      .get(text(id, 'promotion id', 200)) as PromotionRow | undefined
    if (!row) throw new NotFoundError('discussion promotion not found')
    return row
  }

  private acceptanceEvidence(
    discussionId: string,
    post: DiscussionPost,
    eventId?: string,
  ): Record<string, unknown> {
    const accepted = eventId
      ? this.db.prepare(`SELECT * FROM os_discussion_events
          WHERE id=? AND discussion_id=? AND post_id=?
            AND event_type='discussion.answer.accepted'`)
          .get(eventId, discussionId, post.id) as Record<string, unknown> | undefined
      : this.db.prepare(`SELECT * FROM os_discussion_events
          WHERE discussion_id=? AND post_id=? AND event_type='discussion.answer.accepted'
          ORDER BY rowid DESC LIMIT 1`)
          .get(discussionId, post.id) as Record<string, unknown> | undefined
    if (!accepted) throw new ConflictError('accepted answer lacks exact acceptance evidence')
    let payload: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(String(accepted.payload_json))
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error()
      payload = parsed as Record<string, unknown>
    } catch {
      throw new ConflictError('accepted answer evidence payload is invalid')
    }
    if (payload.post_id !== post.id || payload.content_sha256 !== post.content_sha256) {
      throw new ConflictError('accepted answer evidence does not match the exact source')
    }
    return accepted
  }

  private permission(id: string): Record<string, unknown> {
    const row = this.db.prepare(`SELECT * FROM os_discussion_permissions WHERE id=?`)
      .get(text(id, 'permission id', 200)) as Record<string, unknown> | undefined
    if (!row) throw new NotFoundError('discussion permission not found')
    return row
  }

  private assertWritable(discussion: DiscussionRecord): void {
    if (discussion.state === 'archived' || discussion.state === 'superseded') {
      throw new ConflictError('discussion is not writable in its current state')
    }
  }

  private requireBoard(boardId: number): void {
    if (!this.db.prepare(`SELECT 1 FROM boards WHERE id=?`).get(boardId)) {
      throw new NotFoundError('board not found')
    }
  }

  private profile(profileId: string, boardId: number): string {
    const id = text(profileId, 'profile id', 200)
    if (!this.db.prepare(`SELECT 1 FROM agent_profiles WHERE id=? AND board_id=?`)
      .get(id, boardId)) throw new NotFoundError('agent profile not found')
    return id
  }

  private profiles(values: string[] | undefined, boardId: number): string[] {
    const unique = [...new Set((values ?? []).map((value) =>
      this.profile(value, boardId)))].sort()
    if (unique.length > MAX_WAKE_RECIPIENTS) {
      throw new ValidationError(`mentions may contain at most ${MAX_WAKE_RECIPIENTS} profiles`)
    }
    return unique
  }

  private insertMention(postId: string, profileId: string, now: string): void {
    this.db.prepare(`INSERT INTO os_discussion_mentions
      (post_id, profile_id, mention_kind, created_at)
      VALUES (?, ?, 'explicit', ?)`).run(postId, profileId, now)
  }

  private insertLink(discussionId: string, link: RequiredLink, now: string): void {
    this.db.prepare(`INSERT INTO os_discussion_links
      (id, discussion_id, link_type, target_id, target_path, symbol_name,
       source_revision, source_sha256, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), discussionId, link.type, link.targetId, link.path,
        link.symbol, link.sourceRevision, link.sourceSha256, now)
  }

  private assertLinkScope(link: RequiredLink, boardId: number): void {
    const targetId = link.targetId
    let scoped = true
    if (link.type === 'job') {
      scoped = Boolean(targetId && this.db.prepare(
        `SELECT 1 FROM jobs WHERE id=? AND board_id=?`,
      ).get(targetId, boardId))
    } else if (link.type === 'contract') {
      const cardId = targetId && /^\d+$/u.test(targetId) ? Number(targetId) : null
      scoped = Boolean(cardId && this.db.prepare(`SELECT 1 FROM task_contracts tc
        JOIN cards c ON c.id=tc.card_id WHERE tc.card_id=? AND c.board_id=?`)
        .get(cardId, boardId))
    } else if (link.type === 'agent') {
      scoped = Boolean(targetId && this.db.prepare(
        `SELECT 1 FROM agent_profiles WHERE id=? AND board_id=?`,
      ).get(targetId, boardId))
    } else if (link.type === 'workspace') {
      scoped = Boolean(targetId && this.db.prepare(
        `SELECT 1 FROM workspaces WHERE id=? AND board_id=?`,
      ).get(targetId, boardId))
    } else if (link.type === 'delivery') {
      scoped = Boolean(targetId && this.db.prepare(
        `SELECT 1 FROM delivery_reports WHERE id=? AND board_id=?`,
      ).get(targetId, boardId))
    } else if (link.type === 'file' || link.type === 'symbol') {
      scoped = Boolean(link.path && safeRelativePath(link.path))
    }
    if (!scoped) throw new ValidationError('discussion link is outside the board scope')
  }

  private indexPost(
    discussionId: string,
    postId: string,
    boardId: number,
    title: string,
    body: string,
    tags: string[],
  ): void {
    this.db.prepare(`INSERT INTO os_discussion_search
      (discussion_id, post_id, board_id, title, body, tags)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(discussionId, postId, String(boardId), title, body, tags.join(' '))
  }

  private tags(discussionId: string): string[] {
    return (this.db.prepare(`SELECT tag FROM os_discussion_tags
      WHERE discussion_id=? ORDER BY tag`).all(discussionId) as Array<{ tag: string }>)
      .map((row) => row.tag)
  }

  private postEventId(postId: string | undefined): string | null {
    if (!postId) return null
    const event = this.db.prepare(`SELECT id FROM os_discussion_events
      WHERE post_id=? ORDER BY rowid DESC LIMIT 1`).get(postId) as
      | { id: string } | undefined
    return event?.id ?? null
  }
}

interface RequiredLink {
  type: DiscussionLinkType
  targetId: string | null
  path: string | null
  symbol: string | null
  sourceRevision: string | null
  sourceSha256: string | null
}

function normalizedLinks(values: DiscussionLinkInput[] | undefined): RequiredLink[] {
  const links = (values ?? []).map((value) => {
    const type = member(value.type, DISCUSSION_LINK_TYPES, 'link type')
    const targetId = optionalText(value.targetId, 'link target id', 500)
    const path = optionalText(value.path, 'link path', 2_000)
    const symbol = optionalText(value.symbol, 'symbol name', 500)
    const sourceRevision = optionalText(value.sourceRevision, 'source revision', 500)
    const sourceSha256 = optionalText(value.sourceSha256, 'source sha256', 64)
    if (!targetId && !path) throw new ValidationError('discussion link requires a target id or path')
    if (type !== 'symbol' && symbol) throw new ValidationError('only symbol links may name a symbol')
    if (sourceSha256 && !SHA256.test(sourceSha256)) {
      throw new ValidationError('source sha256 is invalid')
    }
    return { type, targetId, path, symbol, sourceRevision, sourceSha256 }
  })
  if (links.length > 64) throw new ValidationError('discussion may have at most 64 links')
  return links
}

function normalizedTags(values: string[] | undefined): string[] {
  const tags = [...new Set((values ?? []).map((value) =>
    text(value, 'tag', 80).toLowerCase()))].sort()
  if (tags.some((tag) => !TAG.test(tag))) throw new ValidationError('discussion tag is invalid')
  if (tags.length > 32) throw new ValidationError('discussion may have at most 32 tags')
  return tags
}

function safeRelativePath(value: string): boolean {
  if (value.startsWith('/') || value.startsWith('\\') || value.includes('\u0000')) return false
  const parts = value.replaceAll('\\', '/').split('/')
  return parts.length > 0 && parts.every((part) => part.length > 0 && part !== '.' && part !== '..')
}

function rootPostKind(type: DiscussionType): DiscussionPostKind {
  return type
}

function sameActor(post: DiscussionPost, actor: DiscussionActor): boolean {
  if (post.author_type === actor.type && post.author_id === actor.id) return true
  return Boolean(post.author_profile_id && actor.profileId
    && post.author_profile_id === actor.profileId)
}

function postTree(
  posts: DiscussionPost[],
  mentions: ReadonlyMap<string, string[]>,
): DiscussionPostNode[] {
  const nodes = new Map<string, DiscussionPostNode>()
  for (const post of posts) nodes.set(post.id, {
    ...post,
    mentions: mentions.get(post.id) ?? [],
    children: [],
  })
  const roots: DiscussionPostNode[] = []
  for (const post of posts) {
    const node = nodes.get(post.id)!
    const parent = post.parent_post_id ? nodes.get(post.parent_post_id) : null
    if (parent) parent.children.push(node)
    else roots.push(node)
  }
  return roots
}

function mapPost(row: RawPost): DiscussionPost {
  return { ...row, automated: row.automated === 1 }
}

function appendIn<T extends string>(
  clauses: string[],
  values: unknown[],
  column: string,
  selected: T[] | undefined,
  allowed: readonly T[],
  field: string,
): void {
  if (!selected?.length) return
  const normalized = [...new Set(selected.map((value) => member(value, allowed, field)))]
  clauses.push(`${column} IN (${normalized.map(() => '?').join(',')})`)
  values.push(...normalized)
}

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || value !== value.trim()
    || value.length < 1 || value.length > max
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value)) {
    throw new ValidationError(`${field} is invalid`)
  }
  return value
}

function optionalText(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null || value === '') return null
  return text(value, field, max)
}

function markdown(value: unknown, field: string, max: number): string {
  const normalized = text(value, field, max)
  // Discussion UI renders Markdown as text unless an audited renderer is supplied.
  // Reject active-content forms so future renderers cannot accidentally activate
  // a retained script, event handler, or executable URL.
  if (/(?:javascript|vbscript)\s*:|data\s*:\s*text\/html/iu.test(normalized)
    || /<[a-z!/]/iu.test(normalized)
    || /\son[a-z]+\s*=/iu.test(normalized)) {
    throw new ValidationError(`${field} contains unsafe active content`)
  }
  return normalized
}

function optionalMarkdown(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null || value === '') return null
  return markdown(value, field, max)
}

function optionalIso(value: unknown, field: string): string | null {
  const normalized = optionalText(value, field, 50)
  if (normalized === null) return null
  let canonical: string
  try {
    canonical = new Date(normalized).toISOString()
  } catch {
    throw new ValidationError(`${field} must be an ISO timestamp`)
  }
  if (canonical !== normalized) {
    throw new ValidationError(`${field} must be an ISO timestamp`)
  }
  return normalized
}

function member<const T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): T {
  if (!allowed.includes(value as T)) throw new ValidationError(`${field} is invalid`)
  return value as T
}

function positiveInteger(value: unknown, field: string): number {
  return boundedInteger(value, field, 1, Number.MAX_SAFE_INTEGER)
}

function boundedInteger(value: unknown, field: string, min: number, max: number): number {
  const parsed = typeof value === 'string' && /^\d+$/u.test(value) ? Number(value) : value
  if (!Number.isSafeInteger(parsed) || Number(parsed) < min || Number(parsed) > max) {
    throw new ValidationError(`${field} is invalid`)
  }
  return Number(parsed)
}

function timestamp(): string {
  return new Date().toISOString()
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
