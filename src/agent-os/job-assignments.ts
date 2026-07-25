import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import {
  actorIdentity,
  boundedString,
  canonicalHash,
  optionalBoundedString,
  type ActorIdentity,
} from './agent-home-support.js'
import { ConflictError, NotFoundError, ValidationError } from './errors.js'
import { EventStore } from './event-store.js'
import {
  JOB_MARKET_STATUSES,
  JobMarketService,
  type JobMarketContract,
  type JobMarketStatus,
} from './job-market.js'
import { parseJson, timestamp } from './json.js'

export const JOB_ASSIGNMENT_STATUSES = ['active', 'released', 'superseded'] as const
export type JobAssignmentStatus = (typeof JOB_ASSIGNMENT_STATUSES)[number]
export type JobAssignmentOrigin = 'claim' | 'assign' | 'reassign'

export interface JobMarketAssignment {
  id: string
  board_id: number
  card_id: number
  profile_id: string
  workspace_id: string | null
  ownership_mode: 'exclusive'
  origin: JobAssignmentOrigin
  status: JobAssignmentStatus
  assigned_market_version: number
  version: number
  predecessor_assignment_id: string | null
  predecessor_version: number | null
  created_actor_type: string
  created_actor_id: string | null
  idempotency_key: string
  request_fingerprint: string
  reason: string | null
  created_at: string
  updated_at: string
  ended_at: string | null
  ended_actor_type: string | null
  ended_actor_id: string | null
  end_reason: string | null
  end_idempotency_key: string | null
  end_request_fingerprint: string | null
  ended_market_version: number | null
}

export interface JobAssignmentMarketSnapshot {
  status: JobMarketStatus
  market_version: number
}

export interface JobAssignmentCommandResult {
  assignment: JobMarketAssignment
  market: JobAssignmentMarketSnapshot
  replayed: boolean
}

export interface CreateJobAssignment {
  cardId: number
  profileId: string
  workspaceId?: string | null
  expectedMarketVersion: number
  actor: ActorIdentity
  idempotencyKey: string
  correlationId?: string | null
  reason?: string | null
}

export interface ReleaseJobAssignment {
  cardId: number
  assignmentId: string
  expectedMarketVersion: number
  expectedAssignmentVersion: number
  actor: ActorIdentity
  idempotencyKey: string
  correlationId?: string | null
  reason?: string | null
}

export interface ReassignJobAssignment extends ReleaseJobAssignment {
  profileId: string
  workspaceId?: string | null
}

export interface JobAssignmentFilters {
  status?: JobAssignmentStatus
  profileId?: string
  workspaceId?: string
  cardId?: number
  limit?: number
}

interface AssignmentRow extends Record<string, unknown> {
  id: string
  board_id: number
  card_id: number
  profile_id: string
  workspace_id: string | null
  ownership_mode: 'exclusive'
  origin: JobAssignmentOrigin
  status: JobAssignmentStatus
  assigned_market_version: number
  version: number
  predecessor_assignment_id: string | null
  predecessor_version: number | null
  created_actor_type: string
  created_actor_id: string | null
  idempotency_key: string
  request_fingerprint: string
  reason: string | null
  created_at: string
  updated_at: string
  ended_at: string | null
  ended_actor_type: string | null
  ended_actor_id: string | null
  end_reason: string | null
  end_idempotency_key: string | null
  end_request_fingerprint: string | null
  ended_market_version: number | null
}

interface CardScope {
  id: number
  board_id: number
  owner_agent_id: number | null
}

interface ProfileScope {
  id: string
  board_id: number
  status: 'active' | 'archived'
  capabilities_json: string
}

interface ReplayPayload extends Record<string, unknown> {
  assignment_id?: unknown
  request_fingerprint?: unknown
  result?: unknown
}

const ACTIVE_JOB_STATUSES = ['queued', 'running', 'cancelling'] as const
const ACTIVE_SESSION_STATUSES = ['reserved', 'starting', 'running', 'idle', 'stopping'] as const

/**
 * Authoritative, audited Job Market responsibility lifecycle.
 *
 * The legacy cards.owner_agent_id field is deliberately not written here. Runtime
 * projection into jobs/sessions is reserved for JOB-010 phase two.
 */
export class JobAssignmentService {
  private readonly events: EventStore
  private readonly market: JobMarketService

  constructor(
    private readonly db: Database.Database,
    events = new EventStore(db),
  ) {
    this.events = events
    this.market = new JobMarketService(db)
  }

  current(cardId: number): JobMarketAssignment | null {
    const card = this.cardScope(cardId)
    const row = this.db.prepare(`SELECT * FROM job_market_assignments
      WHERE board_id=? AND card_id=? AND status='active'
      ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(card.board_id, card.id) as
      AssignmentRow | undefined
    return row ? mapJobAssignment(row) : null
  }

  history(cardId: number): JobMarketAssignment[] {
    const card = this.cardScope(cardId)
    return (this.db.prepare(`SELECT * FROM job_market_assignments
      WHERE board_id=? AND card_id=?
      ORDER BY created_at DESC, rowid DESC`).all(card.board_id, card.id) as AssignmentRow[])
      .map(mapJobAssignment)
  }

  listBoard(boardId: number, filters: JobAssignmentFilters = {}): JobMarketAssignment[] {
    const normalizedBoardId = positiveInteger(boardId, 'board id')
    if (!this.db.prepare('SELECT 1 FROM boards WHERE id=?').get(normalizedBoardId)) {
      throw new NotFoundError('board not found')
    }
    const where = ['board_id=@board_id']
    const params: Record<string, unknown> = { board_id: normalizedBoardId }
    if (filters.status !== undefined) {
      if (!JOB_ASSIGNMENT_STATUSES.includes(filters.status)) {
        throw new ValidationError('assignment status must be active, released, or superseded')
      }
      where.push('status=@status')
      params.status = filters.status
    }
    if (filters.profileId !== undefined) {
      where.push('profile_id=@profile_id')
      params.profile_id = boundedString(filters.profileId, 'profile id', 200)
    }
    if (filters.workspaceId !== undefined) {
      where.push('workspace_id=@workspace_id')
      params.workspace_id = boundedString(filters.workspaceId, 'workspace id', 200)
    }
    if (filters.cardId !== undefined) {
      where.push('card_id=@card_id')
      params.card_id = positiveInteger(filters.cardId, 'card id')
    }
    const limit = filters.limit === undefined ? 100 : positiveInteger(filters.limit, 'limit')
    params.limit = Math.min(limit, 500)
    return (this.db.prepare(`SELECT * FROM job_market_assignments
      WHERE ${where.join(' AND ')}
      ORDER BY updated_at DESC, rowid DESC LIMIT @limit`).all(params) as AssignmentRow[])
      .map(mapJobAssignment)
  }

  require(id: string): JobMarketAssignment {
    const assignmentId = boundedString(id, 'assignment id', 200)
    const row = this.db.prepare('SELECT * FROM job_market_assignments WHERE id=?')
      .get(assignmentId) as AssignmentRow | undefined
    if (!row) throw new NotFoundError('job market assignment not found')
    return mapJobAssignment(row)
  }

  claim(input: CreateJobAssignment): JobAssignmentCommandResult {
    return this.create('claim', 'job_market.assignment_claimed', input)
  }

  assign(input: CreateJobAssignment): JobAssignmentCommandResult {
    return this.create('assign', 'job_market.assignment_assigned', input)
  }

  release(input: ReleaseJobAssignment): JobAssignmentCommandResult {
    const normalized = this.normalizeRelease(input)
    const fingerprint = canonicalHash({
      command: 'job_assignment.release',
      cardId: normalized.cardId,
      assignmentId: normalized.assignmentId,
      expectedMarketVersion: normalized.expectedMarketVersion,
      expectedAssignmentVersion: normalized.expectedAssignmentVersion,
      actor: normalized.actor,
      reason: normalized.reason,
    })
    const card = this.cardScope(normalized.cardId)
    const replay = this.replay(
      card.board_id,
      normalized.idempotencyKey,
      'job_market.assignment_released',
      fingerprint,
    )
    if (replay) return replay

    const release = this.db.transaction(() => {
      const latestCard = this.cardScope(normalized.cardId)
      const raced = this.replay(
        latestCard.board_id,
        normalized.idempotencyKey,
        'job_market.assignment_released',
        fingerprint,
      )
      if (raced) return raced
      const assignment = this.requireScopedActive(
        normalized.assignmentId,
        latestCard,
        normalized.expectedAssignmentVersion,
      )
      const market = this.market.get(latestCard.id)
      this.requireMarketVersion(market, normalized.expectedMarketVersion)
      if (!['assigned', 'rejected', 'cancelled', 'accepted', 'archived'].includes(market.status)) {
        throw new ConflictError(`contract in ${market.status} cannot release its active assignment`)
      }
      this.assertNoActiveExecution(latestCard.id)

      const at = timestamp()
      try {
        const updated = this.db.prepare(`UPDATE job_market_assignments SET
          status='released', version=version+1, updated_at=?, ended_at=?,
          ended_actor_type=?, ended_actor_id=?, end_reason=?,
          end_idempotency_key=?, end_request_fingerprint=?, ended_market_version=?
          WHERE id=? AND board_id=? AND card_id=? AND status='active' AND version=?`)
          .run(
            at,
            at,
            normalized.actor.type,
            normalized.actor.id,
            normalized.reason,
            normalized.idempotencyKey,
            fingerprint,
            market.market_version + 1,
            assignment.id,
            latestCard.board_id,
            latestCard.id,
            assignment.version,
          )
        if (updated.changes !== 1) throw new ConflictError('job market assignment changed concurrently')
      } catch (error) {
        throw assignmentConflict(error)
      }
      const result = this.result(this.require(assignment.id), this.market.get(latestCard.id))
      this.audit({
        boardId: latestCard.board_id,
        workspaceId: result.assignment.workspace_id,
        cardId: latestCard.id,
        contractVersion: market.contract.version,
        kind: 'job_market.assignment_released',
        idempotencyKey: normalized.idempotencyKey,
        correlationId: normalized.correlationId,
        actor: normalized.actor,
        reason: normalized.reason,
        fingerprint,
        result,
      })
      return result
    })
    try {
      return release.immediate()
    } catch (error) {
      throw assignmentConflict(error)
    }
  }

  reassign(input: ReassignJobAssignment): JobAssignmentCommandResult {
    const normalized = this.normalizeReassign(input)
    const fingerprint = canonicalHash({
      command: 'job_assignment.reassign',
      cardId: normalized.cardId,
      assignmentId: normalized.assignmentId,
      profileId: normalized.profileId,
      workspaceId: normalized.workspaceId,
      expectedMarketVersion: normalized.expectedMarketVersion,
      expectedAssignmentVersion: normalized.expectedAssignmentVersion,
      actor: normalized.actor,
      reason: normalized.reason,
    })
    const card = this.cardScope(normalized.cardId)
    const replay = this.replay(
      card.board_id,
      normalized.idempotencyKey,
      'job_market.assignment_reassigned',
      fingerprint,
    )
    if (replay) return replay

    const reassign = this.db.transaction(() => {
      const latestCard = this.cardScope(normalized.cardId)
      const raced = this.replay(
        latestCard.board_id,
        normalized.idempotencyKey,
        'job_market.assignment_reassigned',
        fingerprint,
      )
      if (raced) return raced
      const predecessor = this.requireScopedActive(
        normalized.assignmentId,
        latestCard,
        normalized.expectedAssignmentVersion,
      )
      const market = this.market.get(latestCard.id)
      this.requireMarketVersion(market, normalized.expectedMarketVersion)
      if (!['assigned', 'rejected'].includes(market.status)) {
        throw new ConflictError(`contract in ${market.status} cannot be reassigned`)
      }
      if (
        predecessor.profile_id === normalized.profileId
        && predecessor.assigned_market_version === market.market_version
      ) {
        throw new ConflictError('assignment already belongs to this profile at the current market version')
      }
      if (predecessor.profile_id === normalized.profileId && normalized.reason === null) {
        throw new ValidationError('reason is required when reassigning to the same profile')
      }
      this.assertNoLegacyOwner(latestCard)
      this.assertNoActiveExecution(latestCard.id)
      const workspaceId = this.assertCandidate(
        latestCard,
        market,
        normalized.profileId,
        normalized.workspaceId,
        predecessor.workspace_id,
      )

      const successorId = randomUUID()
      const at = timestamp()
      try {
        this.db.prepare(`INSERT INTO job_market_assignments (
          id, board_id, card_id, profile_id, workspace_id, ownership_mode,
          origin, status, assigned_market_version, version,
          predecessor_assignment_id, predecessor_version,
          created_actor_type, created_actor_id, idempotency_key,
          request_fingerprint, reason, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'exclusive', 'reassign', 'pending', ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(
            successorId,
            latestCard.board_id,
            latestCard.id,
            normalized.profileId,
            workspaceId,
            market.market_version + 1,
            predecessor.id,
            predecessor.version,
            normalized.actor.type,
            normalized.actor.id,
            normalized.idempotencyKey,
            fingerprint,
            normalized.reason,
            at,
            at,
          )
      } catch (error) {
        throw assignmentConflict(error)
      }
      const result = this.result(this.require(successorId), this.market.get(latestCard.id))
      this.audit({
        boardId: latestCard.board_id,
        workspaceId: result.assignment.workspace_id,
        cardId: latestCard.id,
        contractVersion: market.contract.version,
        kind: 'job_market.assignment_reassigned',
        idempotencyKey: normalized.idempotencyKey,
        correlationId: normalized.correlationId,
        actor: normalized.actor,
        reason: normalized.reason,
        fingerprint,
        result,
        predecessor,
      })
      return result
    })
    try {
      return reassign.immediate()
    } catch (error) {
      throw assignmentConflict(error)
    }
  }

  private create(
    origin: 'claim' | 'assign',
    kind: 'job_market.assignment_claimed' | 'job_market.assignment_assigned',
    input: CreateJobAssignment,
  ): JobAssignmentCommandResult {
    const normalized = this.normalizeCreate(input)
    const fingerprint = canonicalHash({
      command: `job_assignment.${origin}`,
      cardId: normalized.cardId,
      profileId: normalized.profileId,
      workspaceId: normalized.workspaceId,
      expectedMarketVersion: normalized.expectedMarketVersion,
      actor: normalized.actor,
      reason: normalized.reason,
    })
    const card = this.cardScope(normalized.cardId)
    const replay = this.replay(card.board_id, normalized.idempotencyKey, kind, fingerprint)
    if (replay) return replay

    const create = this.db.transaction(() => {
      const latestCard = this.cardScope(normalized.cardId)
      const raced = this.replay(latestCard.board_id, normalized.idempotencyKey, kind, fingerprint)
      if (raced) return raced
      const market = this.market.get(latestCard.id)
      this.requireMarketVersion(market, normalized.expectedMarketVersion)
      if (market.status !== 'open') {
        throw new ConflictError(`contract in ${market.status} cannot be assigned`)
      }
      this.assertNoLegacyOwner(latestCard)
      this.assertNoActiveExecution(latestCard.id)
      if (this.current(latestCard.id)) {
        throw new ConflictError('card already has an active job market assignment')
      }
      const workspaceId = this.assertCandidate(
        latestCard,
        market,
        normalized.profileId,
        normalized.workspaceId,
        null,
      )
      const assignmentId = randomUUID()
      const at = timestamp()
      try {
        this.db.prepare(`INSERT INTO job_market_assignments (
          id, board_id, card_id, profile_id, workspace_id, ownership_mode,
          origin, status, assigned_market_version, version,
          predecessor_assignment_id, predecessor_version,
          created_actor_type, created_actor_id, idempotency_key,
          request_fingerprint, reason, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'exclusive', ?, 'active', ?, 1, NULL, NULL, ?, ?, ?, ?, ?, ?, ?)`)
          .run(
            assignmentId,
            latestCard.board_id,
            latestCard.id,
            normalized.profileId,
            workspaceId,
            origin,
            market.market_version + 1,
            normalized.actor.type,
            normalized.actor.id,
            normalized.idempotencyKey,
            fingerprint,
            normalized.reason,
            at,
            at,
          )
      } catch (error) {
        throw assignmentConflict(error)
      }
      const result = this.result(this.require(assignmentId), this.market.get(latestCard.id))
      this.audit({
        boardId: latestCard.board_id,
        workspaceId: result.assignment.workspace_id,
        cardId: latestCard.id,
        contractVersion: market.contract.version,
        kind,
        idempotencyKey: normalized.idempotencyKey,
        correlationId: normalized.correlationId,
        actor: normalized.actor,
        reason: normalized.reason,
        fingerprint,
        result,
      })
      return result
    })
    try {
      return create.immediate()
    } catch (error) {
      throw assignmentConflict(error)
    }
  }

  private normalizeCreate(input: CreateJobAssignment) {
    return {
      cardId: positiveInteger(input.cardId, 'card id'),
      profileId: boundedString(input.profileId, 'profile id', 200),
      workspaceId: optionalBoundedString(input.workspaceId, 'workspace id', 200),
      expectedMarketVersion: positiveInteger(input.expectedMarketVersion, 'expected market version'),
      actor: actorIdentity(input.actor),
      idempotencyKey: boundedString(input.idempotencyKey, 'idempotency key', 200),
      correlationId: optionalBoundedString(input.correlationId, 'correlation id', 200),
      reason: optionalBoundedString(input.reason, 'reason', 2_000),
    }
  }

  private normalizeRelease(input: ReleaseJobAssignment) {
    return {
      cardId: positiveInteger(input.cardId, 'card id'),
      assignmentId: boundedString(input.assignmentId, 'assignment id', 200),
      expectedMarketVersion: positiveInteger(input.expectedMarketVersion, 'expected market version'),
      expectedAssignmentVersion: positiveInteger(
        input.expectedAssignmentVersion,
        'expected assignment version',
      ),
      actor: actorIdentity(input.actor),
      idempotencyKey: boundedString(input.idempotencyKey, 'idempotency key', 200),
      correlationId: optionalBoundedString(input.correlationId, 'correlation id', 200),
      reason: optionalBoundedString(input.reason, 'reason', 2_000),
    }
  }

  private normalizeReassign(input: ReassignJobAssignment) {
    return {
      ...this.normalizeRelease(input),
      profileId: boundedString(input.profileId, 'profile id', 200),
      workspaceId: optionalBoundedString(input.workspaceId, 'workspace id', 200),
    }
  }

  private assertCandidate(
    card: CardScope,
    market: JobMarketContract,
    profileId: string,
    requestedWorkspaceId: string | null,
    fallbackWorkspaceId: string | null,
  ): string | null {
    const profile = this.db.prepare(`SELECT id, board_id, status, capabilities_json
      FROM agent_profiles WHERE id=?`).get(profileId) as ProfileScope | undefined
    if (!profile) throw new NotFoundError('agent profile not found')
    if (profile.board_id !== card.board_id) {
      throw new ValidationError('agent profile belongs to a different board')
    }
    if (profile.status !== 'active') throw new ConflictError('agent profile is archived')

    const capabilities = new Set(parseJson<string[]>(profile.capabilities_json, []))
    const missing = market.constraints.required_capabilities
      .filter((capability) => !capabilities.has(capability))
    if (missing.length) {
      throw new ValidationError(`agent profile lacks required capabilities: ${missing.join(', ')}`)
    }
    const validation = this.market.validate(card.id, 'publish')
    if (!validation.valid) {
      throw new ValidationError(`job contract is not assignable: ${validation.errors.join('; ')}`)
    }

    const contractWorkspaceId = market.contract.workspace_id
    if (
      requestedWorkspaceId !== null
      && contractWorkspaceId !== null
      && requestedWorkspaceId !== contractWorkspaceId
    ) {
      throw new ValidationError('assignment workspace must match the contract workspace')
    }
    const workspaceId = requestedWorkspaceId ?? contractWorkspaceId ?? fallbackWorkspaceId
    if (workspaceId !== null) {
      const workspace = this.db.prepare(`SELECT board_id, card_id, status
        FROM workspaces WHERE id=?`).get(workspaceId) as
        { board_id: number; card_id: number | null; status: string } | undefined
      if (!workspace) throw new NotFoundError('workspace not found')
      if (
        workspace.board_id !== card.board_id
        || (workspace.card_id !== null && workspace.card_id !== card.id)
      ) {
        throw new ValidationError('assignment workspace scope is inconsistent')
      }
      if (workspace.status !== 'active') throw new ConflictError('assignment workspace is not active')
    }
    return workspaceId
  }

  private assertNoLegacyOwner(card: CardScope): void {
    if (card.owner_agent_id !== null) {
      throw new ConflictError(
        'card has a legacy owner; clear it before using canonical Job Market assignment',
      )
    }
  }

  private assertNoActiveExecution(cardId: number): void {
    const jobPlaceholders = ACTIVE_JOB_STATUSES.map(() => '?').join(',')
    const activeJob = this.db.prepare(`SELECT id FROM jobs
      WHERE card_id=? AND status IN (${jobPlaceholders}) LIMIT 1`)
      .get(cardId, ...ACTIVE_JOB_STATUSES)
    if (activeJob) throw new ConflictError('card has an active job')
    const sessionPlaceholders = ACTIVE_SESSION_STATUSES.map(() => '?').join(',')
    const activeSession = this.db.prepare(`SELECT session.id FROM agent_sessions session
      JOIN jobs job ON job.id=session.job_id
      WHERE job.card_id=? AND session.status IN (${sessionPlaceholders}) LIMIT 1`)
      .get(cardId, ...ACTIVE_SESSION_STATUSES)
    if (activeSession) throw new ConflictError('card has an active agent session')
  }

  private requireMarketVersion(market: JobMarketContract, expected: number): void {
    if (market.market_version !== expected) {
      throw new ConflictError(
        `job market version is stale; expected ${expected}, current ${market.market_version}`,
      )
    }
  }

  private requireScopedActive(
    assignmentId: string,
    card: CardScope,
    expectedVersion: number,
  ): JobMarketAssignment {
    const assignment = this.require(assignmentId)
    if (assignment.board_id !== card.board_id || assignment.card_id !== card.id) {
      throw new NotFoundError('job market assignment not found for this card')
    }
    if (assignment.status !== 'active') {
      throw new ConflictError(`job market assignment is ${assignment.status}`)
    }
    if (assignment.version !== expectedVersion) {
      throw new ConflictError(
        `job assignment version is stale; expected ${expectedVersion}, current ${assignment.version}`,
      )
    }
    return assignment
  }

  private cardScope(value: number): CardScope {
    const cardId = positiveInteger(value, 'card id')
    const card = this.db.prepare('SELECT id, board_id, owner_agent_id FROM cards WHERE id=?')
      .get(cardId) as CardScope | undefined
    if (!card) throw new NotFoundError('card not found')
    return card
  }

  private result(
    assignment: JobMarketAssignment,
    market: JobMarketContract,
  ): JobAssignmentCommandResult {
    return {
      assignment,
      market: {
        status: market.status,
        market_version: market.market_version,
      },
      replayed: false,
    }
  }

  private replay(
    boardId: number,
    idempotencyKey: string,
    kind: string,
    requestFingerprint: string,
  ): JobAssignmentCommandResult | null {
    const row = this.db.prepare(`SELECT kind, card_id, workspace_id, payload FROM os_events
      WHERE board_id=? AND idempotency_key=?`).get(boardId, idempotencyKey) as
      {
        kind: string
        card_id: number | null
        workspace_id: string | null
        payload: string
      } | undefined
    if (!row) return null
    const payload = parseJson<ReplayPayload>(row.payload, {})
    if (row.kind !== kind || payload.request_fingerprint !== requestFingerprint) {
      throw new ConflictError('idempotency key was already used for a different assignment command')
    }
    const result = replayResult(payload.result)
    if (
      payload.assignment_id !== result.assignment.id
      || row.card_id !== result.assignment.card_id
      || row.workspace_id !== result.assignment.workspace_id
      || result.assignment.board_id !== boardId
    ) {
      throw new ConflictError('assignment replay event scope does not match its result snapshot')
    }
    const retained = this.db.prepare('SELECT * FROM job_market_assignments WHERE id=?')
      .get(result.assignment.id) as AssignmentRow | undefined
    if (!retained) {
      throw new ConflictError('assignment replay event references missing assignment history')
    }
    const retainedAssignment = mapJobAssignment(retained)
    if (
      canonicalHash(immutableAssignmentIdentity(retainedAssignment))
      !== canonicalHash(immutableAssignmentIdentity(result.assignment))
    ) {
      throw new ConflictError('assignment replay event result does not match retained history')
    }
    const commandFingerprint = row.kind === 'job_market.assignment_released'
      ? result.assignment.end_request_fingerprint
      : result.assignment.request_fingerprint
    const commandKey = row.kind === 'job_market.assignment_released'
      ? result.assignment.end_idempotency_key
      : result.assignment.idempotency_key
    if (commandFingerprint !== requestFingerprint || commandKey !== idempotencyKey) {
      throw new ConflictError('assignment replay event result has inconsistent command identity')
    }
    if (row.kind === 'job_market.assignment_released') {
      if (
        canonicalHash(terminalAssignmentSnapshot(retainedAssignment))
          !== canonicalHash(terminalAssignmentSnapshot(result.assignment))
        || result.market.market_version !== retainedAssignment.ended_market_version
        || result.assignment.status !== 'released'
        || result.assignment.version < 2
        || !['open', 'accepted', 'archived'].includes(result.market.status)
      ) {
        throw new ConflictError('assignment release replay event contains an invalid result state')
      }
    } else if (
      result.assignment.status !== 'active'
      || result.assignment.version !== 1
      || result.market.status !== 'assigned'
    ) {
      throw new ConflictError('assignment replay event contains an invalid creation result state')
    }
    return result
  }

  private audit(input: {
    boardId: number
    workspaceId: string | null
    cardId: number
    contractVersion: number
    kind: string
    idempotencyKey: string
    correlationId: string | null
    actor: ActorIdentity
    reason: string | null
    fingerprint: string
    result: JobAssignmentCommandResult
    predecessor?: JobMarketAssignment
  }): void {
    this.events.append({
      boardId: input.boardId,
      workspaceId: input.workspaceId,
      cardId: input.cardId,
      contractId: `card:${input.cardId}:v${input.contractVersion}`,
      correlationId: input.correlationId ?? input.idempotencyKey,
      idempotencyKey: input.idempotencyKey,
      kind: input.kind,
      source: 'job-market',
      payload: {
        assignment_id: input.result.assignment.id,
        predecessor_assignment_id: input.predecessor?.id ?? null,
        predecessor_profile_id: input.predecessor?.profile_id ?? null,
        actor: input.actor,
        reason: input.reason,
        request_fingerprint: input.fingerprint,
        result: input.result,
      },
    })
  }
}

export function mapJobAssignment(row: AssignmentRow): JobMarketAssignment {
  return {
    id: String(row.id),
    board_id: Number(row.board_id),
    card_id: Number(row.card_id),
    profile_id: String(row.profile_id),
    workspace_id: nullableString(row.workspace_id),
    ownership_mode: 'exclusive',
    origin: String(row.origin) as JobAssignmentOrigin,
    status: String(row.status) as JobAssignmentStatus,
    assigned_market_version: Number(row.assigned_market_version),
    version: Number(row.version),
    predecessor_assignment_id: nullableString(row.predecessor_assignment_id),
    predecessor_version: nullableNumber(row.predecessor_version),
    created_actor_type: String(row.created_actor_type),
    created_actor_id: nullableString(row.created_actor_id),
    idempotency_key: String(row.idempotency_key),
    request_fingerprint: String(row.request_fingerprint),
    reason: nullableString(row.reason),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    ended_at: nullableString(row.ended_at),
    ended_actor_type: nullableString(row.ended_actor_type),
    ended_actor_id: nullableString(row.ended_actor_id),
    end_reason: nullableString(row.end_reason),
    end_idempotency_key: nullableString(row.end_idempotency_key),
    end_request_fingerprint: nullableString(row.end_request_fingerprint),
    ended_market_version: nullableNumber(row.ended_market_version),
  }
}

function replayResult(value: unknown): JobAssignmentCommandResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConflictError('assignment replay event does not contain a result snapshot')
  }
  const result = value as Record<string, unknown>
  if (!result.assignment || typeof result.assignment !== 'object' || Array.isArray(result.assignment)) {
    throw new ConflictError('assignment replay event does not reference an assignment')
  }
  if (!result.market || typeof result.market !== 'object' || Array.isArray(result.market)) {
    throw new ConflictError('assignment replay event does not contain a market snapshot')
  }
  const assignment = validatedReplayAssignment(result.assignment as Record<string, unknown>)
  const market = result.market as Record<string, unknown>
  const status = String(market.status) as JobMarketStatus
  const marketVersion = Number(market.market_version)
  if (
    !JOB_MARKET_STATUSES.includes(status)
    || !Number.isSafeInteger(marketVersion)
    || marketVersion <= 0
  ) {
    throw new ConflictError('assignment replay event contains an invalid market snapshot')
  }
  return {
    assignment,
    market: {
      status,
      market_version: marketVersion,
    },
    replayed: true,
  }
}

function positiveInteger(value: unknown, field: string): number {
  const normalized = Number(value)
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw new ValidationError(`${field} must be a positive integer`)
  }
  return normalized
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value)
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value)
}

function assignmentConflict(error: unknown): Error {
  if (error instanceof ValidationError || error instanceof ConflictError || error instanceof NotFoundError) {
    return error
  }
  const message = error instanceof Error ? error.message : String(error)
  if (/database is locked|SQLITE_BUSY/i.test(message)) {
    return new ConflictError('job assignment database is busy; reload and retry')
  }
  if (
    /job market assignment|job market reassignment|UNIQUE constraint failed|version changed/i.test(message)
  ) {
    return new ConflictError(message.replace(/^.*?:\s*/, ''))
  }
  return error instanceof Error ? error : new Error(message)
}

function validatedReplayAssignment(row: Record<string, unknown>): JobMarketAssignment {
  for (const field of [
    'id',
    'profile_id',
    'ownership_mode',
    'origin',
    'status',
    'created_actor_type',
    'idempotency_key',
    'request_fingerprint',
    'created_at',
    'updated_at',
  ]) {
    if (typeof row[field] !== 'string' || !row[field]) {
      throw new ConflictError(`assignment replay event contains invalid ${field}`)
    }
  }
  for (const field of ['board_id', 'card_id', 'assigned_market_version', 'version']) {
    if (!Number.isSafeInteger(row[field]) || Number(row[field]) <= 0) {
      throw new ConflictError(`assignment replay event contains invalid ${field}`)
    }
  }
  if (
    row.ownership_mode !== 'exclusive'
    || !['claim', 'assign', 'reassign'].includes(String(row.origin))
    || !JOB_ASSIGNMENT_STATUSES.includes(String(row.status) as JobAssignmentStatus)
  ) {
    throw new ConflictError('assignment replay event contains invalid assignment lifecycle values')
  }
  for (const field of [
    'workspace_id',
    'predecessor_assignment_id',
    'created_actor_id',
    'reason',
    'ended_at',
    'ended_actor_type',
    'ended_actor_id',
    'end_reason',
    'end_idempotency_key',
    'end_request_fingerprint',
  ]) {
    if (row[field] !== null && typeof row[field] !== 'string') {
      throw new ConflictError(`assignment replay event contains invalid ${field}`)
    }
  }
  for (const field of ['predecessor_version', 'ended_market_version']) {
    if (row[field] !== null && (!Number.isSafeInteger(row[field]) || Number(row[field]) <= 0)) {
      throw new ConflictError(`assignment replay event contains invalid ${field}`)
    }
  }
  return mapJobAssignment(row as AssignmentRow)
}

function immutableAssignmentIdentity(assignment: JobMarketAssignment): Record<string, unknown> {
  return {
    id: assignment.id,
    board_id: assignment.board_id,
    card_id: assignment.card_id,
    profile_id: assignment.profile_id,
    workspace_id: assignment.workspace_id,
    ownership_mode: assignment.ownership_mode,
    origin: assignment.origin,
    assigned_market_version: assignment.assigned_market_version,
    predecessor_assignment_id: assignment.predecessor_assignment_id,
    predecessor_version: assignment.predecessor_version,
    created_actor_type: assignment.created_actor_type,
    created_actor_id: assignment.created_actor_id,
    idempotency_key: assignment.idempotency_key,
    request_fingerprint: assignment.request_fingerprint,
    reason: assignment.reason,
    created_at: assignment.created_at,
  }
}

function terminalAssignmentSnapshot(assignment: JobMarketAssignment): Record<string, unknown> {
  return {
    status: assignment.status,
    version: assignment.version,
    updated_at: assignment.updated_at,
    ended_at: assignment.ended_at,
    ended_actor_type: assignment.ended_actor_type,
    ended_actor_id: assignment.ended_actor_id,
    end_reason: assignment.end_reason,
    end_idempotency_key: assignment.end_idempotency_key,
    end_request_fingerprint: assignment.end_request_fingerprint,
    ended_market_version: assignment.ended_market_version,
  }
}
