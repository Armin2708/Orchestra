import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { AgentProfileService, type AgentProfile } from './agent-profiles.js'
import {
  ConversationService,
  type AgentConversation,
  type AgentSessionRecord,
} from './conversations.js'
import { ConflictError, NotFoundError, ValidationError } from './errors.js'
import type { FrozenJobAssignmentIdentity } from './job-assignment-runtime.js'
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
  jobAssignment?: FrozenJobAssignmentIdentity | null
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
    const job = this.db.prepare(`SELECT board_id, card_id, workspace_id, provider, driver_id,
      job_assignment_id, assigned_profile_id, assignment_market_version
      FROM jobs WHERE id=?`)
      .get(input.jobId) as {
        board_id: number
        card_id: number | null
        workspace_id: string | null
        provider: string
        driver_id: string
        job_assignment_id: string | null
        assigned_profile_id: string | null
        assignment_market_version: number | null
      } | undefined
    if (!job) throw new NotFoundError('managed job not found')
    if (Number(job.board_id) !== input.boardId) {
      throw new ValidationError('managed job and board scope are inconsistent')
    }
    if (job.provider !== input.provider || job.driver_id !== input.driverId) {
      throw new ValidationError('managed job provider identity changed before launch')
    }
    const jobAssignment = completeAssignmentIdentity(job, 'managed job')
    const requestedAssignment = normalizeAssignmentIdentity(input.jobAssignment, 'managed launch')
    if (!sameAssignmentIdentity(jobAssignment, requestedAssignment)) {
      throw new ConflictError('managed launch assignment identity changed before Agent Home binding')
    }
    const workspace = this.db.prepare('SELECT board_id FROM workspaces WHERE id=?')
      .get(input.workspaceId) as { board_id: number } | undefined
    if (!workspace || Number(workspace.board_id) !== input.boardId) {
      throw new ValidationError('managed session workspace belongs to a different board')
    }
    if (job.workspace_id && job.workspace_id !== input.workspaceId) {
      throw new ValidationError('managed job and workspace scope are inconsistent')
    }
    if (jobAssignment) {
      if (job.workspace_id !== input.workspaceId || !job.card_id) {
        throw new ConflictError('assigned managed job has incomplete runtime scope')
      }
      const retained = this.db.prepare(`SELECT 1
        FROM job_market_assignments assignment
        JOIN agent_profiles profile ON profile.id=assignment.profile_id
        WHERE assignment.id=?
          AND assignment.board_id=?
          AND assignment.card_id=?
          AND assignment.profile_id=?
          AND assignment.assigned_market_version=?
          AND assignment.status='active'
          AND profile.status='active'`).get(
        jobAssignment.jobAssignmentId,
        input.boardId,
        job.card_id,
        jobAssignment.assignedProfileId,
        jobAssignment.assignmentMarketVersion,
      )
      if (!retained) {
        throw new ConflictError('assigned managed job no longer has its exact active assignment')
      }
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
    const assigned = normalizeAssignmentIdentity(input.jobAssignment, 'managed launch')
    const rows = this.db.prepare(`SELECT id, status FROM agent_sessions
      WHERE ${assigned
        ? 'job_id=?'
        : `(job_id=? OR (
            job_id IS NULL
            AND json_valid(context_json)
            AND json_extract(context_json, '$.job_id')=?
          ))`}
        AND status IN (${ACTIVE_SESSION_STATUSES.map(() => '?').join(',')})
      ORDER BY updated_at DESC, rowid DESC LIMIT 2`)
      .all(
        ...(assigned ? [input.jobId] : [input.jobId, input.jobId]),
        ...ACTIVE_SESSION_STATUSES,
      ) as Array<{ id: string; status: string }>
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
    if (assigned) {
      throw new ConflictError('assigned managed job is missing its reserved provider session')
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
    const assigned = normalizeAssignmentIdentity(input.jobAssignment, 'managed launch')
    const sessionJobId = assigned
      ? session.job_id
      : session.job_id
        ?? (typeof session.context.job_id === 'string' ? session.context.job_id : null)
    if (sessionJobId !== input.jobId) {
      throw new ConflictError('reserved provider session belongs to a different job')
    }
    const sessionAssignment = completeAssignmentIdentity(session, 'reserved provider session')
    if (!sameAssignmentIdentity(sessionAssignment, assigned)) {
      throw new ConflictError('reserved provider session assignment identity is inconsistent')
    }
    if (assigned && session.profile_id !== null
      && session.profile_id !== assigned.assignedProfileId) {
      throw new ConflictError('reserved provider session is linked to a different assigned profile')
    }
    if ((session.profile_id === null) !== (session.conversation_id === null)) {
      throw new ConflictError('reserved provider session has an incomplete Agent Home identity')
    }
  }

  private identityFor(
    session: AgentSessionRecord,
    input: BindManagedAgentSession,
  ): { profile: AgentProfile; conversation: AgentConversation } {
    const assigned = normalizeAssignmentIdentity(input.jobAssignment, 'managed launch')
    if (session.profile_id && session.conversation_id) {
      const profile = this.profiles.require(session.profile_id)
      const conversation = this.conversations.requireConversation(session.conversation_id)
      if (profile.board_id !== input.boardId
        || conversation.board_id !== input.boardId
        || conversation.profile_id !== profile.id) {
        throw new ConflictError('reserved provider session has an inconsistent Agent Home scope')
      }
      if (assigned && (profile.id !== assigned.assignedProfileId
        || profile.status !== 'active'
        || conversation.status !== 'active')) {
        throw new ConflictError('reserved provider session does not retain its assigned Agent Home identity')
      }
      return { profile, conversation }
    }

    if (assigned) {
      const profile = this.profiles.require(assigned.assignedProfileId)
      if (profile.board_id !== input.boardId || profile.status !== 'active') {
        throw new ConflictError('assigned AgentProfile is no longer active in the managed job board')
      }
      const conversation = this.db.prepare(`SELECT id FROM agent_conversations
        WHERE profile_id=? AND board_id=? AND status='active' AND is_default=1
        ORDER BY updated_at DESC, rowid DESC LIMIT 1`).get(
        profile.id,
        input.boardId,
      ) as { id: string } | undefined
      if (!conversation) {
        throw new ConflictError('assigned AgentProfile has no active default conversation')
      }
      return {
        profile,
        conversation: this.conversations.requireConversation(conversation.id),
      }
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

function normalizeAssignmentIdentity(
  value: FrozenJobAssignmentIdentity | null | undefined,
  label: string,
): FrozenJobAssignmentIdentity | null {
  if (value == null) return null
  const jobAssignmentId = value.jobAssignmentId?.trim()
  const assignedProfileId = value.assignedProfileId?.trim()
  const assignmentMarketVersion = Number(value.assignmentMarketVersion)
  if (!jobAssignmentId || !assignedProfileId
    || !Number.isSafeInteger(assignmentMarketVersion)
    || assignmentMarketVersion <= 0) {
    throw new ValidationError(`${label} assignment identity is invalid`)
  }
  return { jobAssignmentId, assignedProfileId, assignmentMarketVersion }
}

function completeAssignmentIdentity(
  value: {
    job_assignment_id: string | null
    assigned_profile_id: string | null
    assignment_market_version: number | null
  },
  label: string,
): FrozenJobAssignmentIdentity | null {
  const present = [
    value.job_assignment_id,
    value.assigned_profile_id,
    value.assignment_market_version,
  ].map((part) => part != null)
  if (!present.some(Boolean)) return null
  if (!present.every(Boolean)) {
    throw new ConflictError(`${label} assignment identity is incomplete`)
  }
  return normalizeAssignmentIdentity({
    jobAssignmentId: value.job_assignment_id!,
    assignedProfileId: value.assigned_profile_id!,
    assignmentMarketVersion: value.assignment_market_version!,
  }, label)
}

function sameAssignmentIdentity(
  left: FrozenJobAssignmentIdentity | null,
  right: FrozenJobAssignmentIdentity | null,
): boolean {
  return left === null && right === null
    || left !== null && right !== null
      && left.jobAssignmentId === right.jobAssignmentId
      && left.assignedProfileId === right.assignedProfileId
      && left.assignmentMarketVersion === right.assignmentMarketVersion
}
