import path from 'node:path'
import type Database from 'better-sqlite3'
import { canonicalHash, type AgentHomeAccessProfile } from './agent-home-support.js'
import { ConflictError, NotFoundError, ValidationError } from './errors.js'
import { parseJson, timestamp } from './json.js'

const CODEX_PROVIDER = 'codex'
const ACTIVE_PROFILE_STATUS = 'active'

export interface CodexAgentHomeThreadBinding {
  agentHomeSessionId: string
  agentProfileId: string
  agentConversationId: string
  workspaceId: string
  providerCursor: string | null
  captureCursor: string | null
}

export interface BindCodexAgentHomeThread {
  threadId: string
  cwd: string
  mode: 'launch' | 'attach'
  boardId?: number
  workspaceId?: string
  agentId?: number
  jobId?: string
  expected?: {
    agentHomeSessionId: string
    agentProfileId: string
    agentConversationId: string
  }
}

type SessionRow = {
  id: string
  workspace_id: string
  agent_id: number | null
  provider: string
  external_id: string | null
  model: string | null
  status: string
  context_json: string
  profile_id: string | null
  conversation_id: string | null
  job_id: string | null
  mode: 'managed' | 'ambient' | 'compatibility'
  driver_id: string | null
  effort: string | null
  access_profile: AgentHomeAccessProfile | null
  provider_thread_id: string | null
  provider_cursor: string | null
  recovery_json: string
  history_state: 'complete' | 'partial' | 'unavailable'
  workspace_board_id: number
  workspace_root_path: string
  workspace_worktree_path: string | null
  workspace_status: string
}

type AgentRow = {
  id: number
  board_id: number
  name: string
  role: string | null
  provider: string
  external_session_id: string | null
  model: string | null
  effort: string | null
  access_profile: AgentHomeAccessProfile | null
  created_at: string
  last_seen: string
}

type Identity = {
  profileId: string
  conversationId: string
}

/**
 * Resolves one Codex thread to one durable Agent Home identity.
 *
 * Binding is transactional and fail-closed: ambiguous threads, split ownership,
 * incomplete supplied identities, or workspace mismatches never produce a
 * best-effort canonical identity.
 */
export class CodexAgentHomeThreadBinder {
  constructor(private readonly db: Database.Database) {}

  lookup(threadId: string): CodexAgentHomeThreadBinding | undefined {
    const normalizedThreadId = requiredString(threadId, 'Codex thread id', 512)
    const rows = this.sessionsForThread(normalizedThreadId)
    if (rows.length > 1) {
      throw new ConflictError(`multiple Agent Home sessions reference Codex thread ${normalizedThreadId}`)
    }
    const row = rows[0]
    if (!row) return undefined
    this.validateThreadColumns(row, normalizedThreadId)
    const identity = this.requireCompleteIdentity(row)
    this.validateIdentity(row, identity)
    return this.binding(row, identity)
  }

  bind(input: BindCodexAgentHomeThread): CodexAgentHomeThreadBinding {
    const bind = this.db.transaction(() => this.bindNow(input))
    return bind.immediate()
  }

  private bindNow(input: BindCodexAgentHomeThread): CodexAgentHomeThreadBinding {
    const threadId = requiredString(input.threadId, 'Codex thread id', 512)
    const cwd = requiredString(input.cwd, 'Codex thread cwd', 4_096)
    const expected = input.expected ? {
      agentHomeSessionId: requiredString(
        input.expected.agentHomeSessionId,
        'Agent Home session id',
        200,
      ),
      agentProfileId: requiredString(
        input.expected.agentProfileId,
        'Agent Home profile id',
        200,
      ),
      agentConversationId: requiredString(
        input.expected.agentConversationId,
        'Agent Home conversation id',
        200,
      ),
    } : undefined
    const requestedAgentId = optionalPositiveInteger(input.agentId, 'legacy agent id')
    const requestedBoardId = optionalPositiveInteger(input.boardId, 'board id')
    const requestedWorkspaceId = optionalString(input.workspaceId, 'workspace id', 200)
    const requestedJobId = optionalString(input.jobId, 'job id', 200)

    const threadRows = this.sessionsForThread(threadId)
    if (threadRows.length > 1) {
      throw new ConflictError(`multiple Agent Home sessions reference Codex thread ${threadId}`)
    }
    let session = expected ? this.session(expected.agentHomeSessionId) : threadRows[0]
    if (expected && !session) {
      throw new NotFoundError(`supplied Agent Home session ${expected.agentHomeSessionId} does not exist`)
    }
    if (expected && threadRows[0] && threadRows[0].id !== expected.agentHomeSessionId) {
      throw new ConflictError(`Codex thread ${threadId} already belongs to another Agent Home session`)
    }

    const owner = this.resolveOwner({
      threadId,
      requestedAgentId,
      sessionAgentId: session?.agent_id ?? null,
    })

    if (session) {
      this.validateSessionScope(session, {
        threadId,
        cwd,
        requestedBoardId,
        requestedWorkspaceId,
        requestedJobId,
        owner,
      })
      const identity = expected
        ? this.validateExpectedIdentity(session, expected)
        : this.identityFor(session, owner)
      this.bindSession(session, identity, {
        threadId,
        mode: input.mode,
        owner,
        requestedJobId,
      })
      session = this.requireSession(session.id)
      this.validateIdentity(session, identity)
      return this.binding(session, identity)
    }

    if (!owner) {
      throw new ConflictError(`Codex thread ${threadId} has no exact durable owner`)
    }
    if (requestedBoardId !== undefined && owner.board_id !== requestedBoardId) {
      throw new ValidationError('Codex thread owner belongs to a different board')
    }
    if (requestedJobId) {
      throw new ConflictError('managed Codex attach is missing its reserved Agent Home session')
    }
    const workspaceId = this.ensureLegacyWorkspace(owner, cwd, requestedWorkspaceId)
    const identity = this.ensureLegacyIdentity(owner)
    const sessionId = `legacy-codex-session:${owner.id}:${canonicalHash(threadId).slice(0, 32)}`
    const at = timestamp()
    const historyState = input.mode === 'attach' ? 'partial' : 'complete'
    const context = {
      source: 'codex_agent_home_binding',
      legacy_agent_id: owner.id,
      capture_mode: input.mode,
    }
    this.db.prepare(`INSERT INTO agent_sessions (
      id, workspace_id, agent_id, provider, external_id, model, status, context_json,
      profile_id, conversation_id, job_id, mode, driver_id, effort, access_profile,
      provider_thread_id, provider_cursor, recovery_state, recovery_json, history_state,
      started_at, ended_at, archived_at, created_at, updated_at
    ) VALUES (
      ?, ?, ?, 'codex', ?, ?, 'running', ?,
      ?, ?, NULL, 'compatibility', 'codex', ?, ?,
      ?, NULL, 'attachable', ?, ?,
      ?, NULL, NULL, ?, ?
    )`).run(
      sessionId,
      workspaceId,
      owner.id,
      threadId,
      owner.model,
      JSON.stringify(context),
      identity.profileId,
      identity.conversationId,
      owner.effort,
      owner.access_profile,
      threadId,
      JSON.stringify(captureRecovery({}, input.mode, threadId, at)),
      historyState,
      at,
      at,
      at,
    )
    session = this.requireSession(sessionId)
    this.validateIdentity(session, identity)
    return this.binding(session, identity)
  }

  private sessionsForThread(threadId: string): SessionRow[] {
    return this.db.prepare(`${SESSION_SELECT}
      WHERE session.provider=?
        AND (session.provider_thread_id=? OR session.external_id=?)
      ORDER BY session.updated_at DESC, session.rowid DESC
      LIMIT 2`).all(CODEX_PROVIDER, threadId, threadId) as SessionRow[]
  }

  private session(sessionId: string): SessionRow | undefined {
    return this.db.prepare(`${SESSION_SELECT} WHERE session.id=?`)
      .get(sessionId) as SessionRow | undefined
  }

  private requireSession(sessionId: string): SessionRow {
    const session = this.session(sessionId)
    if (!session) throw new NotFoundError('Agent Home session disappeared while binding Codex')
    return session
  }

  private resolveOwner(input: {
    threadId: string
    requestedAgentId: number | undefined
    sessionAgentId: number | null
  }): AgentRow | undefined {
    const owners = this.db.prepare(`SELECT id, board_id, name, role, provider,
        external_session_id, model, effort, access_profile, created_at, last_seen
      FROM agents
      WHERE provider=? AND external_session_id=?
      ORDER BY last_seen DESC, id DESC LIMIT 2`)
      .all(CODEX_PROVIDER, input.threadId) as AgentRow[]
    if (owners.length > 1) {
      throw new ConflictError(`multiple legacy agents claim Codex thread ${input.threadId}`)
    }
    const ownerIds = new Set<number>()
    if (input.requestedAgentId !== undefined) ownerIds.add(input.requestedAgentId)
    if (input.sessionAgentId !== null) ownerIds.add(input.sessionAgentId)
    if (owners[0]) ownerIds.add(Number(owners[0].id))
    if (ownerIds.size > 1) {
      throw new ConflictError(`Codex thread ${input.threadId} has conflicting durable owners`)
    }
    const ownerId = [...ownerIds][0]
    if (ownerId === undefined) return undefined
    const owner = this.agent(ownerId)
    if (!owner || owner.provider !== CODEX_PROVIDER) {
      throw new ConflictError(`Codex thread ${input.threadId} owner is unavailable`)
    }
    if (owner.external_session_id && owner.external_session_id !== input.threadId) {
      throw new ConflictError(`legacy agent ${owner.id} belongs to another Codex thread`)
    }
    return owner
  }

  private agent(agentId: number): AgentRow | undefined {
    return this.db.prepare(`SELECT id, board_id, name, role, provider,
        external_session_id, model, effort, access_profile, created_at, last_seen
      FROM agents WHERE id=?`).get(agentId) as AgentRow | undefined
  }

  private validateSessionScope(
    session: SessionRow,
    input: {
      threadId: string
      cwd: string
      requestedBoardId: number | undefined
      requestedWorkspaceId: string | undefined
      requestedJobId: string | undefined
      owner: AgentRow | undefined
    },
  ): void {
    if (session.provider !== CODEX_PROVIDER) {
      throw new ConflictError('supplied Agent Home session is not a Codex session')
    }
    this.validateThreadColumns(session, input.threadId)
    if (session.workspace_status !== 'active' && session.workspace_status !== 'reserved') {
      throw new ConflictError(`Agent Home workspace ${session.workspace_id} is ${session.workspace_status}`)
    }
    if (input.requestedWorkspaceId && session.workspace_id !== input.requestedWorkspaceId) {
      throw new ConflictError('Codex launch workspace does not match the supplied Agent Home session')
    }
    if (input.requestedBoardId !== undefined
      && session.workspace_board_id !== input.requestedBoardId) {
      throw new ValidationError('Codex session and requested board scope are inconsistent')
    }
    if (input.owner && input.owner.board_id !== session.workspace_board_id) {
      throw new ConflictError('Codex session owner and workspace belong to different boards')
    }
    if (!samePath(this.workspaceRoot(session), input.cwd)) {
      throw new ConflictError('Codex thread cwd does not match its durable Agent Home workspace')
    }
    const sessionJobId = session.job_id
      ?? optionalString(parseJson<Record<string, unknown>>(session.context_json, {}).job_id, 'job id', 200)
    if (input.requestedJobId && sessionJobId !== input.requestedJobId) {
      throw new ConflictError('Codex session belongs to a different managed job')
    }
    if (sessionJobId) {
      const job = this.db.prepare('SELECT board_id, workspace_id, status FROM jobs WHERE id=?')
        .get(sessionJobId) as {
          board_id: number
          workspace_id: string | null
          status: string
        } | undefined
      if (!job
        || Number(job.board_id) !== session.workspace_board_id
        || (job.workspace_id && job.workspace_id !== session.workspace_id)
        || !['running', 'cancelling'].includes(job.status)) {
        throw new ConflictError('Codex session has an inconsistent managed job scope')
      }
    }
  }

  private validateThreadColumns(session: SessionRow, threadId: string): void {
    if (session.external_id && session.external_id !== threadId) {
      throw new ConflictError('Agent Home session external thread identity is inconsistent')
    }
    if (session.provider_thread_id && session.provider_thread_id !== threadId) {
      throw new ConflictError('Agent Home session provider thread identity is inconsistent')
    }
  }

  private validateExpectedIdentity(
    session: SessionRow,
    expected: NonNullable<BindCodexAgentHomeThread['expected']>,
  ): Identity {
    if (session.profile_id !== expected.agentProfileId
      || session.conversation_id !== expected.agentConversationId) {
      throw new ConflictError('supplied Agent Home identity does not match its durable session')
    }
    const identity = {
      profileId: expected.agentProfileId,
      conversationId: expected.agentConversationId,
    }
    this.validateIdentity(session, identity)
    return identity
  }

  private identityFor(session: SessionRow, owner: AgentRow | undefined): Identity {
    if ((session.profile_id === null) !== (session.conversation_id === null)) {
      throw new ConflictError('Agent Home session has an incomplete canonical identity')
    }
    if (session.profile_id && session.conversation_id) {
      const identity = {
        profileId: session.profile_id,
        conversationId: session.conversation_id,
      }
      this.validateIdentity(session, identity)
      return identity
    }
    if (!owner) {
      throw new ConflictError('unlinked Codex session has no exact legacy owner')
    }
    return this.ensureLegacyIdentity(owner)
  }

  private requireCompleteIdentity(session: SessionRow): Identity {
    if (!session.profile_id || !session.conversation_id) {
      throw new ConflictError('Codex session is not linked to a complete Agent Home identity')
    }
    return {
      profileId: session.profile_id,
      conversationId: session.conversation_id,
    }
  }

  private validateIdentity(session: SessionRow, identity: Identity): void {
    const profile = this.db.prepare(`SELECT board_id, legacy_agent_id, status
      FROM agent_profiles WHERE id=?`).get(identity.profileId) as {
        board_id: number
        legacy_agent_id: number | null
        status: string
      } | undefined
    const conversation = this.db.prepare(`SELECT board_id, profile_id, status
      FROM agent_conversations WHERE id=?`).get(identity.conversationId) as {
        board_id: number
        profile_id: string
        status: string
      } | undefined
    if (!profile || !conversation
      || Number(profile.board_id) !== session.workspace_board_id
      || Number(conversation.board_id) !== session.workspace_board_id
      || conversation.profile_id !== identity.profileId) {
      throw new ConflictError('Codex session has an inconsistent Agent Home identity scope')
    }
    if (profile.status !== ACTIVE_PROFILE_STATUS || conversation.status !== ACTIVE_PROFILE_STATUS) {
      throw new ConflictError('Codex session Agent Home identity is archived')
    }
    if (profile.legacy_agent_id !== null
      && session.agent_id !== null
      && Number(profile.legacy_agent_id) !== Number(session.agent_id)) {
      throw new ConflictError('Codex session profile belongs to another legacy agent')
    }
  }

  private ensureLegacyWorkspace(
    owner: AgentRow,
    cwd: string,
    requestedWorkspaceId: string | undefined,
  ): string {
    const workspaceId = requestedWorkspaceId ?? `legacy-agent:${owner.id}`
    if (workspaceId !== `legacy-agent:${owner.id}`) {
      throw new ConflictError('legacy Codex launch requires its deterministic compatibility workspace')
    }
    const existing = this.db.prepare(`SELECT board_id, root_path, worktree_path, status
      FROM workspaces WHERE id=?`).get(workspaceId) as {
        board_id: number
        root_path: string
        worktree_path: string | null
        status: string
      } | undefined
    if (existing) {
      if (Number(existing.board_id) !== owner.board_id
        || !samePath(existing.worktree_path ?? existing.root_path, cwd)
        || existing.status !== 'active') {
        throw new ConflictError('legacy Codex compatibility workspace is inconsistent')
      }
      return workspaceId
    }
    const at = timestamp()
    this.db.prepare(`INSERT INTO workspaces (
      id, board_id, card_id, name, kind, root_path, worktree_path, branch,
      base_ref, status, env_json, created_at, updated_at
    ) VALUES (?, ?, NULL, ?, 'shared', ?, NULL, NULL, 'HEAD', 'active', '{}', ?, ?)`)
      .run(workspaceId, owner.board_id, `${owner.name} compatibility`, cwd, at, at)
    return workspaceId
  }

  private ensureLegacyIdentity(owner: AgentRow): Identity {
    const expectedProfileId = `legacy-agent:${owner.id}`
    let profile = this.db.prepare(`SELECT id, board_id, legacy_agent_id, status
      FROM agent_profiles WHERE legacy_agent_id=?`).get(owner.id) as {
        id: string
        board_id: number
        legacy_agent_id: number | null
        status: string
      } | undefined
    if (!profile) {
      const byId = this.db.prepare(`SELECT id, board_id, legacy_agent_id, status
        FROM agent_profiles WHERE id=?`).get(expectedProfileId) as typeof profile
      if (byId) {
        throw new ConflictError(`legacy Agent Home profile ${expectedProfileId} is already orphaned or reassigned`)
      }
      const at = timestamp()
      try {
        this.db.prepare(`INSERT INTO agent_profiles (
          id, board_id, legacy_agent_id, name, role, default_provider, default_model,
          default_effort, default_access_profile, capabilities_json, owner_actor_type,
          owner_actor_id, status, provenance_json, created_at, updated_at, archived_at
        ) VALUES (
          ?, ?, ?, ?, ?, 'codex', ?, ?, ?, '[]', 'system',
          'codex-agent-home-binding', 'active', ?, ?, ?, NULL
        )`).run(
          expectedProfileId,
          owner.board_id,
          owner.id,
          owner.name,
          owner.role,
          owner.model,
          owner.effort,
          owner.access_profile,
          JSON.stringify({ source: 'runtime_legacy_codex', legacy_agent_id: owner.id }),
          owner.created_at || at,
          at,
        )
      } catch (error) {
        throw new ConflictError(
          `cannot materialize the exact legacy Agent Home profile: ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
      }
      profile = this.db.prepare(`SELECT id, board_id, legacy_agent_id, status
        FROM agent_profiles WHERE id=?`).get(expectedProfileId) as typeof profile
    }
    if (!profile
      || Number(profile.board_id) !== owner.board_id
      || Number(profile.legacy_agent_id) !== owner.id
      || profile.status !== ACTIVE_PROFILE_STATUS) {
      throw new ConflictError('legacy Agent Home profile scope is inconsistent')
    }

    let conversation = this.db.prepare(`SELECT id, board_id, profile_id, status
      FROM agent_conversations
      WHERE profile_id=? AND is_default=1 AND status='active'`).get(profile.id) as {
        id: string
        board_id: number
        profile_id: string
        status: string
      } | undefined
    if (!conversation) {
      const conversationId = `legacy-conversation:${owner.id}`
      const byId = this.db.prepare(`SELECT id, board_id, profile_id, status
        FROM agent_conversations WHERE id=?`).get(conversationId) as typeof conversation
      if (byId) {
        throw new ConflictError(`legacy Agent Home conversation ${conversationId} cannot be reused`)
      }
      const at = timestamp()
      this.db.prepare(`INSERT INTO agent_conversations (
        id, board_id, profile_id, title, status, is_default, next_sequence,
        created_by_actor_type, created_by_actor_id, created_at, updated_at, archived_at
      ) VALUES (?, ?, ?, ?, 'active', 1, 1, 'system', 'codex-agent-home-binding', ?, ?, NULL)`)
        .run(conversationId, owner.board_id, profile.id, `${owner.name} conversation`, at, at)
      conversation = this.db.prepare(`SELECT id, board_id, profile_id, status
        FROM agent_conversations WHERE id=?`).get(conversationId) as typeof conversation
    }
    if (!conversation
      || Number(conversation.board_id) !== owner.board_id
      || conversation.profile_id !== profile.id
      || conversation.status !== ACTIVE_PROFILE_STATUS) {
      throw new ConflictError('legacy Agent Home conversation scope is inconsistent')
    }
    return { profileId: profile.id, conversationId: conversation.id }
  }

  private bindSession(
    session: SessionRow,
    identity: Identity,
    input: {
      threadId: string
      mode: 'launch' | 'attach'
      owner: AgentRow | undefined
      requestedJobId: string | undefined
    },
  ): void {
    const at = timestamp()
    const recovery = captureRecovery(
      parseJson<Record<string, unknown>>(session.recovery_json, {}),
      input.mode,
      input.threadId,
      at,
    )
    const jobId = session.job_id ?? input.requestedJobId ?? null
    const status = input.mode === 'attach'
      ? 'running'
      : jobId ? session.status : 'running'
    const historyState = input.mode === 'attach' ? 'partial' : 'complete'
    this.db.prepare(`UPDATE agent_sessions SET
      agent_id=COALESCE(agent_id, ?),
      external_id=?,
      profile_id=?,
      conversation_id=?,
      job_id=COALESCE(job_id, ?),
      mode=?,
      driver_id='codex',
      provider_thread_id=?,
      recovery_state='attachable',
      recovery_json=?,
      history_state=?,
      status=?,
      started_at=COALESCE(started_at, created_at),
      ended_at=CASE WHEN ?='attach' THEN NULL ELSE ended_at END,
      updated_at=?
      WHERE id=?`).run(
      input.owner?.id ?? null,
      input.threadId,
      identity.profileId,
      identity.conversationId,
      input.requestedJobId ?? null,
      jobId ? 'managed' : session.mode,
      input.threadId,
      JSON.stringify(recovery),
      historyState,
      status,
      input.mode,
      at,
      session.id,
    )
  }

  private binding(session: SessionRow, identity: Identity): CodexAgentHomeThreadBinding {
    const captureSequence = this.db.prepare(`SELECT
        MAX(CAST(substr(provider_cursor, 17) AS INTEGER)) AS value
      FROM conversation_events
      WHERE session_id=? AND provider_cursor GLOB 'orchestra-codex:[0-9]*'`)
      .get(session.id) as { value: number | null }
    return {
      agentHomeSessionId: session.id,
      agentProfileId: identity.profileId,
      agentConversationId: identity.conversationId,
      workspaceId: session.workspace_id,
      providerCursor: session.provider_cursor,
      captureCursor: captureSequence.value === null
        ? null
        : `orchestra-codex:${Number(captureSequence.value)}`,
    }
  }

  private workspaceRoot(session: SessionRow): string {
    return session.workspace_worktree_path ?? session.workspace_root_path
  }
}

const SESSION_SELECT = `SELECT
    session.id,
    session.workspace_id,
    session.agent_id,
    session.provider,
    session.external_id,
    session.model,
    session.status,
    session.context_json,
    session.profile_id,
    session.conversation_id,
    session.job_id,
    session.mode,
    session.driver_id,
    session.effort,
    session.access_profile,
    session.provider_thread_id,
    session.provider_cursor,
    session.recovery_json,
    session.history_state,
    workspace.board_id AS workspace_board_id,
    workspace.root_path AS workspace_root_path,
    workspace.worktree_path AS workspace_worktree_path,
    workspace.status AS workspace_status
  FROM agent_sessions session
  JOIN workspaces workspace ON workspace.id=session.workspace_id`

const captureRecovery = (
  current: Record<string, unknown>,
  mode: 'launch' | 'attach',
  threadId: string,
  at: string,
): Record<string, unknown> => ({
  ...current,
  codex_native_capture: {
    state: 'bound',
    mode,
    thread_id: threadId,
    bound_at: at,
    unobserved_interval: mode === 'attach',
  },
})

const samePath = (left: string, right: string): boolean =>
  path.resolve(left) === path.resolve(right)

const requiredString = (value: unknown, label: string, maximum: number): string => {
  if (typeof value !== 'string' || !value.trim()) throw new ValidationError(`${label} is required`)
  const normalized = value.trim()
  if (normalized.length > maximum) throw new ValidationError(`${label} is too long`)
  return normalized
}

const optionalString = (
  value: unknown,
  label: string,
  maximum: number,
): string | undefined => {
  if (value === undefined || value === null) return undefined
  return requiredString(value, label, maximum)
}

const optionalPositiveInteger = (value: unknown, label: string): number | undefined => {
  if (value === undefined || value === null) return undefined
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new ValidationError(`${label} must be a positive integer`)
  }
  return number
}
