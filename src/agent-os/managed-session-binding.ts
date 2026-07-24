import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { AgentProfileService, type AgentProfile } from './agent-profiles.js'
import {
  ConversationService,
  type AgentConversation,
  type AgentSessionRecord,
} from './conversations.js'
import { ConflictError, NotFoundError, ValidationError } from './errors.js'
import { timestamp } from './json.js'
import type { AgentHomeAccessProfile } from './agent-home-support.js'

const RUNTIME_ACTOR = { type: 'system', id: 'agent-os-runtime' } as const
const ACTIVE_SESSION_STATUSES = ['reserved', 'starting', 'running', 'idle', 'stopping'] as const

export interface BindManagedAgentSession {
  jobId: string
  boardId: number
  workspaceId: string
  provider: string
  driverId: string
  profileName: string
  model: string | null
  effort: string | null
  accessProfile: AgentHomeAccessProfile
  context: Record<string, unknown>
}

export interface ManagedAgentSessionBinding {
  agentHomeSessionId: string
  agentProfileId: string
  agentConversationId: string
}

/**
 * Materializes the durable Agent Home identity for one managed provider launch.
 *
 * The binding happens before provider launch. Re-running it for the same active
 * job/session returns the same opaque IDs and never creates a parallel session.
 */
export class ManagedAgentSessionBinder {
  private readonly profiles: AgentProfileService
  private readonly conversations: ConversationService

  constructor(private readonly db: Database.Database) {
    this.profiles = new AgentProfileService(db)
    this.conversations = new ConversationService(db)
  }

  bind(input: BindManagedAgentSession): ManagedAgentSessionBinding {
    const materialize = this.db.transaction(() => {
      this.validateScope(input)
      const session = this.ensureSession(input)
      const scope = this.identityFor(session, input)
      const linked = this.conversations.linkSession(session.id, {
        profileId: scope.profile.id,
        conversationId: scope.conversation.id,
        jobId: input.jobId,
        mode: 'managed',
        driverId: input.driverId,
        effort: input.effort,
        accessProfile: input.accessProfile,
        actor: RUNTIME_ACTOR,
        idempotencyKey: `agent-home:session:${session.id}:link`,
        correlationId: input.jobId,
      })
      return {
        agentHomeSessionId: linked.id,
        agentProfileId: scope.profile.id,
        agentConversationId: scope.conversation.id,
      }
    })
    return materialize.immediate()
  }

  private validateScope(input: BindManagedAgentSession): void {
    const job = this.db.prepare('SELECT board_id, workspace_id, provider, driver_id FROM jobs WHERE id=?')
      .get(input.jobId) as {
        board_id: number
        workspace_id: string | null
        provider: string
        driver_id: string
      } | undefined
    if (!job) throw new NotFoundError('managed job not found')
    if (Number(job.board_id) !== input.boardId) {
      throw new ValidationError('managed job and board scope are inconsistent')
    }
    if (job.provider !== input.provider || job.driver_id !== input.driverId) {
      throw new ValidationError('managed job provider identity changed before launch')
    }
    const workspace = this.db.prepare('SELECT board_id FROM workspaces WHERE id=?')
      .get(input.workspaceId) as { board_id: number } | undefined
    if (!workspace || Number(workspace.board_id) !== input.boardId) {
      throw new ValidationError('managed session workspace belongs to a different board')
    }
    if (job.workspace_id && job.workspace_id !== input.workspaceId) {
      throw new ValidationError('managed job and workspace scope are inconsistent')
    }
    if (job.workspace_id === null) {
      const assigned = this.db.prepare(
        'UPDATE jobs SET workspace_id=? WHERE id=? AND workspace_id IS NULL',
      ).run(input.workspaceId, input.jobId)
      if (assigned.changes !== 1) {
        throw new ConflictError('managed job workspace changed before Agent Home binding')
      }
    }
  }

  private ensureSession(input: BindManagedAgentSession): AgentSessionRecord {
    const rows = this.db.prepare(`SELECT id, status FROM agent_sessions
      WHERE (
        job_id=?
        OR (json_valid(context_json) AND json_extract(context_json, '$.job_id')=?)
      )
        AND status IN (${ACTIVE_SESSION_STATUSES.map(() => '?').join(',')})
      ORDER BY updated_at DESC, rowid DESC LIMIT 2`)
      .all(input.jobId, input.jobId, ...ACTIVE_SESSION_STATUSES) as Array<{ id: string; status: string }>
    if (rows.length > 1) {
      throw new ConflictError('managed job has multiple active provider-session identities')
    }
    if (rows[0]) {
      if (!['reserved', 'starting'].includes(rows[0].status)) {
        throw new ConflictError(`managed job already has an active ${rows[0].status} provider session`)
      }
      const session = this.conversations.requireSession(rows[0].id)
      this.validateSession(session, input)
      return session
    }

    const id = randomUUID()
    const at = timestamp()
    const context = JSON.stringify({ ...input.context, job_id: input.jobId })
    this.db.prepare(`INSERT INTO agent_sessions (
      id, workspace_id, agent_id, provider, external_id, model, status, context_json,
      job_id, mode, driver_id, effort, access_profile, recovery_state, recovery_json,
      history_state, started_at, created_at, updated_at
    ) VALUES (
      ?, ?, NULL, ?, NULL, ?, 'starting', ?,
      ?, 'managed', ?, ?, ?, 'unknown', '{}',
      'unavailable', ?, ?, ?
    )`).run(
      id,
      input.workspaceId,
      input.provider,
      input.model,
      context,
      input.jobId,
      input.driverId,
      input.effort,
      input.accessProfile,
      at,
      at,
      at,
    )
    const session = this.conversations.requireSession(id)
    this.validateSession(session, input)
    return session
  }

  private validateSession(session: AgentSessionRecord, input: BindManagedAgentSession): void {
    if (session.workspace_id !== input.workspaceId || session.provider !== input.provider) {
      throw new ConflictError('reserved provider session does not match the managed launch')
    }
    const sessionJobId = session.job_id
      ?? (typeof session.context.job_id === 'string' ? session.context.job_id : null)
    if (sessionJobId !== input.jobId) {
      throw new ConflictError('reserved provider session belongs to a different job')
    }
    if ((session.profile_id === null) !== (session.conversation_id === null)) {
      throw new ConflictError('reserved provider session has an incomplete Agent Home identity')
    }
  }

  private identityFor(
    session: AgentSessionRecord,
    input: BindManagedAgentSession,
  ): { profile: AgentProfile; conversation: AgentConversation } {
    if (session.profile_id && session.conversation_id) {
      const profile = this.profiles.require(session.profile_id)
      const conversation = this.conversations.requireConversation(session.conversation_id)
      if (profile.board_id !== input.boardId
        || conversation.board_id !== input.boardId
        || conversation.profile_id !== profile.id) {
        throw new ConflictError('reserved provider session has an inconsistent Agent Home scope')
      }
      return { profile, conversation }
    }

    const profile = this.ensureProfile(input)
    const conversation = this.ensureDefaultConversation(profile)
    return { profile, conversation }
  }

  private ensureProfile(input: BindManagedAgentSession): AgentProfile {
    return this.profiles.create({
      boardId: input.boardId,
      name: input.profileName,
      defaultProvider: input.provider,
      defaultModel: input.model,
      defaultEffort: input.effort,
      defaultAccessProfile: input.accessProfile,
      actor: RUNTIME_ACTOR,
      idempotencyKey: `agent-home:job:${input.jobId}:profile`,
      correlationId: input.jobId,
    })
  }

  private ensureDefaultConversation(profile: AgentProfile): AgentConversation {
    const existing = this.db.prepare(`SELECT id FROM agent_conversations
      WHERE profile_id=? AND is_default=1 AND status='active'`)
      .get(profile.id) as { id: string } | undefined
    if (existing) return this.conversations.requireConversation(existing.id)
    return this.conversations.createConversation(profile.id, {
      isDefault: true,
      actor: RUNTIME_ACTOR,
      idempotencyKey: `agent-home:profile:${profile.id}:default-conversation`,
      correlationId: profile.id,
    })
  }
}
