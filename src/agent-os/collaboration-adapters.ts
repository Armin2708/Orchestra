import type Database from 'better-sqlite3'
import { AttentionService } from './attention.js'
import {
  DiscussionService,
  type DiscussionWakeAdapter,
  type DiscussionWakeRequest,
} from './discussions.js'
import type { ConflictDiscussionAdapter } from './team-planning.js'

/** Converts a delivered discussion wake into one profile-scoped attention item per recipient. */
export class DiscussionAttentionWakeAdapter implements DiscussionWakeAdapter {
  private readonly attention: AttentionService

  constructor(private readonly db: Database.Database) {
    this.attention = new AttentionService(db)
  }

  wake(request: DiscussionWakeRequest): void {
    for (const profileId of request.recipientProfileIds) {
      const profile = this.db.prepare(`SELECT legacy_agent_id FROM agent_profiles
        WHERE id=? AND board_id=? AND status='active'`).get(profileId, request.boardId) as
        { legacy_agent_id: number | null } | undefined
      if (!profile) throw new Error('discussion wake recipient is not an active board profile')
      this.attention.create({
        boardId: request.boardId,
        agentId: profile.legacy_agent_id,
        kind: `discussion.wake:${request.discussionId}:${request.postId}:${profileId}`,
        severity: 'medium',
        title: `Discussion ${request.reasons[profileId]} for ${profileId}`,
        detail: JSON.stringify({
          discussion_id: request.discussionId,
          post_id: request.postId,
          profile_id: profileId,
          reason: request.reasons[profileId],
          causation_event_id: request.causationEventId,
        }),
        dedupe: false,
      })
    }
  }
}

/** Creates and resolves the canonical Discussion record linked to a team conflict. */
export class CanonicalConflictDiscussionAdapter implements ConflictDiscussionAdapter {
  constructor(private readonly discussions: DiscussionService) {}

  createConflictDiscussion(input: Parameters<ConflictDiscussionAdapter['createConflictDiscussion']>[0]):
  { id: string } {
    const snapshot = this.discussions.createDiscussion({
      boardId: input.boardId,
      type: 'conflict',
      title: input.title,
      body: `Team ${input.teamId} opened conflict ${input.conflictId}.`,
      mentions: input.participantProfileIds,
      automated: true,
      requestedAction: 'Review the conflict evidence and record a bounded proposal.',
      actor: { type: 'service', id: 'team-planning-conflicts' },
      idempotencyKey: input.idempotencyKey,
      correlationId: input.correlationId,
      causationId: input.conflictId,
    })
    return { id: snapshot.discussion.id }
  }

  resolveConflictDiscussion(
    input: Parameters<NonNullable<ConflictDiscussionAdapter['resolveConflictDiscussion']>>[0],
  ): void {
    this.discussions.transition({
      discussionId: input.discussionId,
      state: 'resolved',
      resolutionSummary: input.summary,
      actor: { type: 'service', id: 'team-planning-conflicts' },
      idempotencyKey: input.idempotencyKey,
      correlationId: input.conflictId,
      causationId: input.resolutionId,
    })
  }
}
