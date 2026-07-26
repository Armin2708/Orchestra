import type Database from 'better-sqlite3'
import {
  ConversationService,
  type AgentSessionRecord,
  type ConversationEvent,
} from './conversations.js'

export interface AgentHomeLinks {
  board_id: number
  profile_id: string
  conversation_id: string | null
  session_id: string | null
  job_id: string | null
  workspace_id: string | null
  event_id: string | null
  process_id: string | null
  process_ids: string[]
  href: string
}

export class AgentHomeLinkService {
  private readonly conversations: ConversationService

  constructor(private readonly db: Database.Database) {
    this.conversations = new ConversationService(db)
  }

  forProfile(profileId: string): AgentHomeLinks {
    const profile = this.conversations.home(profileId).profile
    return this.build({
      boardId: profile.board_id,
      profileId: profile.id,
      conversationId: null,
    })
  }

  forConversation(conversationId: string, eventId?: string | null): AgentHomeLinks {
    const conversation = this.conversations.requireConversation(conversationId)
    return this.build({
      boardId: conversation.board_id,
      profileId: conversation.profile_id,
      conversationId: conversation.id,
      eventId,
    })
  }

  forEvent(eventOrId: ConversationEvent | string): AgentHomeLinks {
    const event = typeof eventOrId === 'string'
      ? this.conversations.requireEvent(eventOrId)
      : eventOrId
    if (!event.session_id) return this.forConversation(event.conversation_id, event.id)
    const processId = event.metadata.process_id ?? event.metadata.processId
    return this.forSession(
      event.session_id,
      event.id,
      typeof processId === 'string' && processId ? processId : null,
    )
  }

  forSession(
    sessionOrId: AgentSessionRecord | string,
    eventId?: string | null,
    processId?: string | null,
  ): AgentHomeLinks {
    const session = typeof sessionOrId === 'string'
      ? this.conversations.requireSession(sessionOrId)
      : sessionOrId
    if (!session.profile_id) {
      throw new Error('unlinked sessions do not have an Agent Home deep link')
    }
    const workspace = this.db.prepare('SELECT board_id FROM workspaces WHERE id=?')
      .get(session.workspace_id) as { board_id: number } | undefined
    if (!workspace) throw new Error('session workspace does not exist')
    return this.build({
      boardId: workspace.board_id,
      profileId: session.profile_id,
      conversationId: session.conversation_id,
      session,
      eventId,
      processId,
    })
  }

  private build(input: {
    boardId: number
    profileId: string
    conversationId: string | null
    session?: AgentSessionRecord | null
    eventId?: string | null
    processId?: string | null
  }): AgentHomeLinks {
    const session = input.session ?? null
    const processIds = session
      ? (this.db.prepare(`SELECT id FROM processes WHERE workspace_id=?
          ORDER BY started_at DESC, rowid DESC`).all(session.workspace_id) as Array<{ id: string }>)
          .map((row) => String(row.id))
      : []
    const processId = input.processId && processIds.includes(input.processId)
      ? input.processId
      : null
    const query = new URLSearchParams()
    query.set('board', String(input.boardId))
    query.set('agent', input.profileId)
    if (input.conversationId) query.set('conversation', input.conversationId)
    if (session) {
      query.set('session', session.id)
      if (session.job_id) query.set('job', session.job_id)
      query.set('workspace', session.workspace_id)
    }
    if (processId) query.set('process', processId)
    if (input.eventId) query.set('event', input.eventId)
    return {
      board_id: input.boardId,
      profile_id: input.profileId,
      conversation_id: input.conversationId,
      session_id: session?.id ?? null,
      job_id: session?.job_id ?? null,
      workspace_id: session?.workspace_id ?? null,
      event_id: input.eventId ?? null,
      process_id: processId,
      process_ids: processIds,
      href: `/?${query.toString()}`,
    }
  }
}
