import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import {
  actorIdentity,
  boundedString,
  canonicalHash,
  jsonRecord,
  optionalBoundedString,
  stringList,
  type ActorIdentity,
} from './agent-home-support.js'
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from './errors.js'
import { EventStore } from './event-store.js'
import { parseJson, timestamp } from './json.js'
import {
  AUTHORITY_CONTROLS,
  OrganizationService,
  RISK_TIERS,
  type AuthorityControl,
  type AuthorityEvaluation,
  type RiskTier,
} from './organization.js'

export const TEAM_INTERACTION_MODES = Object.freeze([
  'collaboration', 'x_as_a_service', 'facilitating',
] as const)
export type TeamInteractionMode = typeof TEAM_INTERACTION_MODES[number]

export const MESSAGE_INTENTS = Object.freeze([
  'QUESTION', 'ANSWER', 'PROPOSAL', 'DECISION', 'ASSIGNMENT', 'STATUS_UPDATE',
  'BLOCKER', 'REVIEW_REQUEST', 'REVIEW_FINDING', 'APPROVAL', 'REJECTION',
  'EVIDENCE', 'INCIDENT', 'ESCALATION',
] as const)
export type MessageIntent = typeof MESSAGE_INTENTS[number]

const CONTROL_STRENGTH: Readonly<Record<AuthorityControl, number>> = {
  automatic: 0,
  independent_review: 1,
  specialist_approval: 2,
  human_approval: 3,
  two_person: 4,
  prohibited: 5,
}

const BASELINE_CONTROL: Readonly<Record<RiskTier, AuthorityControl>> = {
  R0: 'automatic',
  R1: 'independent_review',
  R2: 'specialist_approval',
  R3: 'two_person',
  R4: 'prohibited',
}

interface CommandInput {
  actor: ActorIdentity
  idempotencyKey: string
  correlationId?: string | null
}

export interface RiskSignals {
  mutating?: boolean
  shared_interface?: boolean
  migration?: boolean
  security_control?: boolean
  production_configuration?: boolean
  destructive?: boolean
  public_release?: boolean
  secrets?: boolean
  identity?: boolean
  material_spend?: boolean
  disallowed?: boolean
}

export interface RiskEvaluation {
  id: string
  organization_id: string
  actor_profile_id: string
  session_id: string
  resource_kind: string
  resource_id: string
  action: string
  environment: string
  signals: RiskSignals
  risk_tier: RiskTier
  control: AuthorityControl
  authority_evaluation: AuthorityEvaluation
  created_at: string
  expires_at: string
}

export interface DurableMessage {
  id: string
  organization_id: string
  thread_id: string
  parent_id: string | null
  causal_id: string | null
  team_id: string | null
  actor_profile_id: string
  session_id: string
  role_activation_id: string
  intent: MessageIntent
  recipient_profile_ids: string[]
  recipient_team_ids: string[]
  visibility: 'private' | 'team' | 'organization' | 'public'
  urgency: 'routine' | 'normal' | 'urgent' | 'critical'
  requested_action: string | null
  deadline: string | null
  expires_at: string | null
  links: Record<string, unknown>
  payload_version: number
  payload: Record<string, unknown>
  summary: string | null
  idempotency_key: string
  receipt_policy: 'none' | 'delivery' | 'read'
  redaction_class: string
  retention_policy: string
  automated: boolean
  fanout_depth: number
  status: 'durable' | 'expired' | 'redacted'
  created_at: string
}

export interface ControlStatus {
  satisfied: boolean
  prohibited: boolean
  required_approvals: number
  valid_approvals: number
  distinct_profiles: number
  distinct_sessions: number
  rejected: boolean
}

export class OrganizationCoordinationService {
  private readonly events: EventStore
  private readonly organization: OrganizationService

  constructor(
    private readonly db: Database.Database,
    events = new EventStore(db),
    organization = new OrganizationService(db, events),
  ) {
    this.events = events
    this.organization = organization
  }

  createTeamInteraction(input: CommandInput & {
    organizationId: string
    mode: TeamInteractionMode
    ownerTeamId: string
    providerTeamId?: string | null
    consumerTeamId?: string | null
    participantTeamIds: string[]
    purpose: string
    serviceContractRef?: string | null
    serviceLevel?: Record<string, unknown>
    exitCondition: string
    startsAt?: string
    expiresAt: string
  }): Record<string, unknown> {
    const organization = this.organization.requireOrganization(input.organizationId)
    const mode = interactionMode(input.mode)
    const ownerTeamId = this.teamInOrganization(input.ownerTeamId, organization.id)
    const providerTeamId = optionalBoundedString(input.providerTeamId, 'provider team id', 200)
    const consumerTeamId = optionalBoundedString(input.consumerTeamId, 'consumer team id', 200)
    if (providerTeamId) this.teamInOrganization(providerTeamId, organization.id)
    if (consumerTeamId) this.teamInOrganization(consumerTeamId, organization.id)
    const participants = stringList(input.participantTeamIds, 'participant team ids')
    for (const teamId of participants) this.teamInOrganization(teamId, organization.id)
    const serviceContractRef = optionalBoundedString(
      input.serviceContractRef,
      'service contract reference',
      1000,
    )
    if (mode === 'x_as_a_service'
      && (!providerTeamId || !consumerTeamId || !serviceContractRef)) {
      throw new ValidationError(
        'x-as-a-service interaction requires provider, consumer, and service contract',
      )
    }
    if (providerTeamId && providerTeamId === consumerTeamId) {
      throw new ValidationError('provider and consumer teams must be distinct')
    }
    const startsAt = optionalIso(input.startsAt, 'starts at') ?? timestamp()
    const expiresAt = requiredIso(input.expiresAt, 'expires at')
    if (expiresAt <= startsAt) throw new ValidationError('interaction must expire after it starts')
    const normalized = {
      mode,
      owner_team_id: ownerTeamId,
      provider_team_id: providerTeamId,
      consumer_team_id: consumerTeamId,
      participants,
      purpose: boundedString(input.purpose, 'interaction purpose', 4000),
      service_contract_ref: serviceContractRef,
      service_level: jsonRecord(input.serviceLevel, 'service level'),
      exit_condition: boundedString(input.exitCondition, 'exit condition', 4000),
      starts_at: startsAt,
      expires_at: expiresAt,
    }
    return this.createCommand({
      boardId: organization.board_id,
      kind: 'organization.team_interaction.created',
      input,
      fingerprint: { command: 'team_interaction.create', organizationId: organization.id, ...normalized },
      table: 'os_team_interactions',
      create: () => {
        const id = randomUUID()
        const at = timestamp()
        this.db.prepare(`INSERT INTO os_team_interactions
          (id, organization_id, mode, owner_team_id, provider_team_id,
           consumer_team_id, participants_json, purpose, service_contract_ref,
           service_level_json, exit_condition, starts_at, expires_at, status,
           created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`)
          .run(id, organization.id, mode, ownerTeamId, providerTeamId, consumerTeamId,
            JSON.stringify(participants), normalized.purpose, serviceContractRef,
            JSON.stringify(normalized.service_level), normalized.exit_condition,
            startsAt, expiresAt, at, at)
        return id
      },
    })
  }

  assignResponsibility(input: CommandInput & {
    organizationId: string
    workKind: string
    workId: string
    driProfileId: string
    deciderProfileId: string
    consulted?: string[]
    reviewerProfileIds: string[]
    informed?: string[]
    riskTier: RiskTier
  }): Record<string, unknown> {
    const organization = this.organization.requireOrganization(input.organizationId)
    const dri = this.profileOnBoard(input.driProfileId, organization.board_id)
    const decider = this.profileOnBoard(input.deciderProfileId, organization.board_id)
    const tier = riskTier(input.riskTier)
    const reviewers = stringList(input.reviewerProfileIds, 'reviewer profile ids')
    if (!reviewers.length && tier !== 'R0') throw new ValidationError('reviewers are required above R0')
    for (const profileId of reviewers) this.profileOnBoard(profileId, organization.board_id)
    if (reviewers.includes(dri)) throw new ValidationError('DRI cannot be an independent reviewer')
    if (tier !== 'R0' && dri === decider) {
      throw new ValidationError('DRI and decider must be distinct above R0')
    }
    const normalized = {
      work_kind: boundedString(input.workKind, 'work kind', 120),
      work_id: boundedString(input.workId, 'work id', 300),
      dri_profile_id: dri,
      decider_profile_id: decider,
      consulted: stringList(input.consulted, 'consulted parties'),
      reviewers,
      informed: stringList(input.informed, 'informed parties'),
      risk_tier: tier,
    }
    return this.createCommand({
      boardId: organization.board_id,
      kind: 'organization.responsibility.assigned',
      input,
      fingerprint: { command: 'responsibility.assign', organizationId: organization.id, ...normalized },
      table: 'os_responsibility_assignments',
      create: () => {
        const id = randomUUID()
        const at = timestamp()
        this.db.prepare(`INSERT INTO os_responsibility_assignments
          (id, organization_id, work_kind, work_id, dri_profile_id, decider_profile_id,
           consulted_json, reviewer_profile_ids_json, informed_json, risk_tier,
           status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`)
          .run(id, organization.id, normalized.work_kind, normalized.work_id,
            dri, decider, JSON.stringify(normalized.consulted), JSON.stringify(reviewers),
            JSON.stringify(normalized.informed), tier, at, at)
        return id
      },
    })
  }

  createObjective(input: CommandInput & {
    organizationId: string
    parentId?: string | null
    key: string
    version: number
    statement: string
    outcomeDefinition: Record<string, unknown>
    customerEvidenceRefs: string[]
    ownerTeamId: string
    validFrom?: string
    validUntil?: string | null
  }): Record<string, unknown> {
    const organization = this.organization.requireOrganization(input.organizationId)
    const ownerTeamId = this.teamInOrganization(input.ownerTeamId, organization.id)
    const parentId = optionalBoundedString(input.parentId, 'parent objective id', 200)
    if (parentId) this.recordInOrganization('os_objectives', parentId, organization.id, 'objective')
    const evidence = stringList(input.customerEvidenceRefs, 'customer evidence references')
    if (!evidence.length) throw new ValidationError('objective requires customer evidence')
    const validFrom = optionalIso(input.validFrom, 'valid from') ?? timestamp()
    const validUntil = optionalIso(input.validUntil, 'valid until')
    if (validUntil && validUntil <= validFrom) throw new ValidationError('objective validity window is invalid')
    const normalized = {
      parent_id: parentId,
      objective_key: identifier(input.key, 'objective key'),
      version: positiveInteger(input.version, 'objective version'),
      statement: boundedString(input.statement, 'objective statement', 8000),
      outcome_definition: jsonRecord(input.outcomeDefinition, 'outcome definition'),
      customer_evidence_refs: evidence,
      owner_team_id: ownerTeamId,
      valid_from: validFrom,
      valid_until: validUntil,
    }
    return this.createCommand({
      boardId: organization.board_id,
      kind: 'organization.objective.created',
      input,
      fingerprint: { command: 'objective.create', organizationId: organization.id, ...normalized },
      table: 'os_objectives',
      create: () => {
        const id = randomUUID()
        this.db.prepare(`INSERT INTO os_objectives
          (id, organization_id, parent_id, objective_key, version, statement,
           outcome_definition_json, customer_evidence_refs_json, owner_team_id,
           status, valid_from, valid_until, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`)
          .run(id, organization.id, parentId, normalized.objective_key, normalized.version,
            normalized.statement, JSON.stringify(normalized.outcome_definition),
            JSON.stringify(evidence), ownerTeamId, validFrom, validUntil, timestamp())
        return id
      },
    })
  }

  createTeamGoal(input: CommandInput & {
    organizationId: string
    objectiveId: string
    teamId: string
    key: string
    version: number
    statement: string
    measure: Record<string, unknown>
    designRef: string
    designVersion: string
    designSha256: string
    contractCardId: number
    contractFrozenAt?: string
  }): Record<string, unknown> {
    const organization = this.organization.requireOrganization(input.organizationId)
    const objective = this.recordInOrganization(
      'os_objectives', input.objectiveId, organization.id, 'objective',
    )
    if (objective.status !== 'active') throw new ConflictError('objective is not active')
    const teamId = this.teamInOrganization(input.teamId, organization.id)
    const contractCardId = positiveInteger(input.contractCardId, 'contract card id')
    const contract = this.db.prepare(`SELECT contract.*, card.board_id
      FROM task_contracts contract JOIN cards card ON card.id=contract.card_id
      WHERE contract.card_id=?`).get(contractCardId) as Record<string, unknown> | undefined
    if (!contract || Number(contract.board_id) !== organization.board_id) {
      throw new NotFoundError('task contract not found on organization board')
    }
    const contractSnapshot = { ...contract }
    delete contractSnapshot.board_id
    const contractSha256 = canonicalHash(contractSnapshot)
    const frozenAt = optionalIso(input.contractFrozenAt, 'contract frozen at') ?? timestamp()
    const normalized = {
      objective_id: String(objective.id),
      team_id: teamId,
      goal_key: identifier(input.key, 'goal key'),
      version: positiveInteger(input.version, 'goal version'),
      statement: boundedString(input.statement, 'goal statement', 8000),
      measure: jsonRecord(input.measure, 'goal measure'),
      design_ref: boundedString(input.designRef, 'design reference', 1000),
      design_version: boundedString(input.designVersion, 'design version', 200),
      design_sha256: sha256(input.designSha256, 'design sha256'),
      contract_card_id: contractCardId,
      contract_version: Number(contract.version),
      contract_sha256: contractSha256,
      contract_frozen_at: frozenAt,
    }
    return this.createCommand({
      boardId: organization.board_id,
      kind: 'organization.team_goal.created',
      input,
      fingerprint: { command: 'team_goal.create', organizationId: organization.id, ...normalized },
      table: 'os_team_goals',
      create: () => {
        const id = randomUUID()
        this.db.prepare(`INSERT INTO os_team_goals
          (id, organization_id, objective_id, team_id, goal_key, version, statement,
           measure_json, design_ref, design_version, design_sha256, contract_card_id,
           contract_version, contract_sha256, contract_frozen_at, status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`)
          .run(id, organization.id, objective.id, teamId, normalized.goal_key,
            normalized.version, normalized.statement, JSON.stringify(normalized.measure),
            normalized.design_ref, normalized.design_version, normalized.design_sha256,
            contractCardId, normalized.contract_version, contractSha256, frozenAt, timestamp())
        return id
      },
    })
  }

  captureCapacity(input: CommandInput & {
    organizationId: string
    teamId: string
    windowStart: string
    windowEnd: string
    availableMilli: number
    allocatedMilli: number
    wipLimit: number
    currentWip: number
    queuedDemand: number
    blockedCount: number
    oldestBlockedAt?: string | null
    constraints?: Record<string, unknown>
    sourceRefs: string[]
  }): Record<string, unknown> {
    const organization = this.organization.requireOrganization(input.organizationId)
    const teamId = this.teamInOrganization(input.teamId, organization.id)
    const windowStart = requiredIso(input.windowStart, 'window start')
    const windowEnd = requiredIso(input.windowEnd, 'window end')
    if (windowEnd <= windowStart) throw new ValidationError('capacity window is invalid')
    const normalized = {
      team_id: teamId,
      window_start: windowStart,
      window_end: windowEnd,
      available_milli: nonNegativeInteger(input.availableMilli, 'available capacity'),
      allocated_milli: nonNegativeInteger(input.allocatedMilli, 'allocated capacity'),
      wip_limit: nonNegativeInteger(input.wipLimit, 'WIP limit'),
      current_wip: nonNegativeInteger(input.currentWip, 'current WIP'),
      queued_demand: nonNegativeInteger(input.queuedDemand, 'queued demand'),
      blocked_count: nonNegativeInteger(input.blockedCount, 'blocked count'),
      oldest_blocked_at: optionalIso(input.oldestBlockedAt, 'oldest blocked at'),
      constraints: jsonRecord(input.constraints, 'capacity constraints'),
      source_refs: stringList(input.sourceRefs, 'capacity source references'),
    }
    if (normalized.blocked_count > 0 && !normalized.oldest_blocked_at) {
      throw new ValidationError('blocked capacity requires oldest blocked timestamp')
    }
    if (!normalized.source_refs.length) throw new ValidationError('capacity snapshot requires sources')
    return this.createCommand({
      boardId: organization.board_id,
      kind: 'organization.capacity.captured',
      input,
      fingerprint: { command: 'capacity.capture', organizationId: organization.id, ...normalized },
      table: 'os_capacity_snapshots',
      create: () => {
        const id = randomUUID()
        this.db.prepare(`INSERT INTO os_capacity_snapshots
          (id, organization_id, team_id, window_start, window_end, available_milli,
           allocated_milli, wip_limit, current_wip, queued_demand, blocked_count,
           oldest_blocked_at, constraints_json, source_refs_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(id, organization.id, teamId, windowStart, windowEnd,
            normalized.available_milli, normalized.allocated_milli, normalized.wip_limit,
            normalized.current_wip, normalized.queued_demand, normalized.blocked_count,
            normalized.oldest_blocked_at, JSON.stringify(normalized.constraints),
            JSON.stringify(normalized.source_refs), timestamp())
        return id
      },
    })
  }

  sendMessage(input: CommandInput & {
    organizationId: string
    threadId: string
    parentId?: string | null
    causalId?: string | null
    teamId?: string | null
    actorProfileId: string
    sessionId: string
    roleActivationId: string
    intent: MessageIntent
    recipientProfileIds?: string[]
    recipientTeamIds?: string[]
    visibility?: DurableMessage['visibility']
    urgency?: DurableMessage['urgency']
    requestedAction?: string | null
    deadline?: string | null
    expiresAt?: string | null
    links: Record<string, unknown>
    payloadVersion?: number
    payload?: Record<string, unknown>
    summary?: string | null
    receiptPolicy?: DurableMessage['receipt_policy']
    redactionClass?: string
    retentionPolicy?: string
    automated?: boolean
  }): DurableMessage {
    const organization = this.organization.requireOrganization(input.organizationId)
    const actorProfileId = this.profileOnBoard(input.actorProfileId, organization.board_id)
    const intent = messageIntent(input.intent)
    const parentId = optionalBoundedString(input.parentId, 'parent message id', 200)
    const causalId = optionalBoundedString(input.causalId, 'causal message id', 200)
    const threadId = boundedString(input.threadId, 'thread id', 300)
    let fanoutDepth = 0
    let parent: Record<string, unknown> | null = null
    if (parentId) {
      parent = this.recordInOrganization('os_message_envelopes', parentId,
        organization.id, 'parent message')
      if (String(parent.thread_id) !== threadId) {
        throw new ValidationError('parent message belongs to a different thread')
      }
      fanoutDepth = Number(parent.fanout_depth) + 1
      if (fanoutDepth > 3) throw new ForbiddenError('automated message fanout depth exceeded')
    }
    if (causalId) this.recordInOrganization(
      'os_message_envelopes', causalId, organization.id, 'causal message',
    )
    const recipientProfiles = stringList(input.recipientProfileIds, 'recipient profile ids')
    const recipientTeams = stringList(input.recipientTeamIds, 'recipient team ids')
    if (!recipientProfiles.length && !recipientTeams.length) {
      throw new ValidationError('message requires targeted recipients')
    }
    if (recipientProfiles.length + recipientTeams.length > 50) {
      throw new ValidationError('message may target at most 50 recipients')
    }
    for (const profileId of recipientProfiles) this.profileOnBoard(profileId, organization.board_id)
    for (const teamId of recipientTeams) this.teamInOrganization(teamId, organization.id)
    const automated = input.automated ?? false
    if (automated && parent?.automated === 1 && !parent.requested_action
      && ['ANSWER', 'STATUS_UPDATE'].includes(intent)) {
      throw new ForbiddenError('automated acknowledgement loops are prohibited')
    }
    const links = jsonRecord(input.links, 'message links')
    assertIntentLinks(intent, links)
    const teamId = optionalBoundedString(input.teamId, 'team id', 200)
    if (teamId) this.teamInOrganization(teamId, organization.id)
    const normalized = {
      thread_id: threadId,
      parent_id: parentId,
      causal_id: causalId,
      team_id: teamId,
      actor_profile_id: actorProfileId,
      session_id: boundedString(input.sessionId, 'session id', 200),
      role_activation_id: boundedString(input.roleActivationId, 'role activation id', 200),
      intent,
      recipient_profiles: recipientProfiles,
      recipient_teams: recipientTeams,
      visibility: visibility(input.visibility ?? 'team'),
      urgency: urgency(input.urgency ?? 'normal'),
      requested_action: optionalBoundedString(input.requestedAction, 'requested action', 4000),
      deadline: optionalIso(input.deadline, 'deadline'),
      expires_at: optionalIso(input.expiresAt, 'expires at'),
      links,
      payload_version: positiveInteger(input.payloadVersion ?? 1, 'payload version'),
      payload: jsonRecord(input.payload, 'message payload'),
      summary: optionalBoundedString(input.summary, 'message summary', 8000),
      receipt_policy: receiptPolicy(input.receiptPolicy ?? 'delivery'),
      redaction_class: boundedString(input.redactionClass ?? 'internal', 'redaction class', 80),
      retention_policy: boundedString(input.retentionPolicy ?? 'work-record', 'retention policy', 120),
      automated,
      fanout_depth: fanoutDepth,
    }
    return this.createCommand({
      boardId: organization.board_id,
      kind: 'organization.message.sent',
      input,
      fingerprint: { command: 'message.send', organizationId: organization.id, ...normalized },
      table: 'os_message_envelopes',
      map: mapMessage,
      create: (_actor, key) => {
        const id = randomUUID()
        this.db.prepare(`INSERT INTO os_message_envelopes
          (id, organization_id, thread_id, parent_id, causal_id, team_id,
           actor_profile_id, session_id, role_activation_id, intent,
           recipient_profile_ids_json, recipient_team_ids_json, visibility, urgency,
           requested_action, deadline, expires_at, links_json, payload_version,
           payload_json, summary, idempotency_key, receipt_policy, redaction_class,
           retention_policy, automated, fanout_depth, status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
            'durable', ?)`)
          .run(id, organization.id, threadId, parentId, causalId, teamId, actorProfileId,
            normalized.session_id, normalized.role_activation_id, intent,
            JSON.stringify(recipientProfiles), JSON.stringify(recipientTeams),
            normalized.visibility, normalized.urgency, normalized.requested_action,
            normalized.deadline, normalized.expires_at, JSON.stringify(links),
            normalized.payload_version, JSON.stringify(normalized.payload), normalized.summary,
            key, normalized.receipt_policy, normalized.redaction_class,
            normalized.retention_policy, automated ? 1 : 0, fanoutDepth, timestamp())
        return id
      },
    })
  }

  recordDecision(input: CommandInput & {
    organizationId: string
    key: string
    version: number
    question: string
    ownerTeamId: string
    deciderProfileId: string
    responsibilityId: string
    consulted?: string[]
    options: Array<Record<string, unknown>>
    evidenceRefs: string[]
    constraints?: Record<string, unknown>
    selectedOption: string
    rationale: string
    acceptedRisks?: string[]
    effectiveFrom?: string
    effectiveUntil?: string | null
    reviewAt?: string | null
    supersedesId?: string | null
  }): Record<string, unknown> {
    const organization = this.organization.requireOrganization(input.organizationId)
    const ownerTeamId = this.teamInOrganization(input.ownerTeamId, organization.id)
    const decider = this.profileOnBoard(input.deciderProfileId, organization.board_id)
    const responsibility = this.recordInOrganization(
      'os_responsibility_assignments', input.responsibilityId, organization.id, 'responsibility',
    )
    if (responsibility.status !== 'active' || responsibility.decider_profile_id !== decider) {
      throw new ForbiddenError('decision must be made by the assigned active decider')
    }
    if (!Array.isArray(input.options) || input.options.length < 2) {
      throw new ValidationError('decision requires at least two options')
    }
    const selectedOption = boundedString(input.selectedOption, 'selected option', 500)
    const optionIds = input.options.map((option) => boundedString(option.id, 'option id', 500))
    if (!optionIds.includes(selectedOption)) throw new ValidationError('selected option is not declared')
    const evidence = stringList(input.evidenceRefs, 'decision evidence references')
    if (!evidence.length) throw new ValidationError('decision requires evidence')
    const effectiveFrom = optionalIso(input.effectiveFrom, 'effective from') ?? timestamp()
    const effectiveUntil = optionalIso(input.effectiveUntil, 'effective until')
    const reviewAt = optionalIso(input.reviewAt, 'review at')
    if (effectiveUntil && effectiveUntil <= effectiveFrom) {
      throw new ValidationError('decision effective window is invalid')
    }
    const supersedesId = optionalBoundedString(input.supersedesId, 'superseded decision id', 200)
    if (supersedesId) this.recordInOrganization(
      'os_decision_records', supersedesId, organization.id, 'superseded decision',
    )
    const normalized = {
      decision_key: identifier(input.key, 'decision key'),
      version: positiveInteger(input.version, 'decision version'),
      question: boundedString(input.question, 'decision question', 8000),
      owner_team_id: ownerTeamId,
      decider_profile_id: decider,
      responsibility_id: String(responsibility.id),
      consulted: stringList(input.consulted, 'consulted parties'),
      options: input.options.map((option) => jsonRecord(option, 'decision option')),
      evidence_refs: evidence,
      constraints: jsonRecord(input.constraints, 'decision constraints'),
      selected_option: selectedOption,
      rationale: boundedString(input.rationale, 'decision rationale', 12000),
      accepted_risks: stringList(input.acceptedRisks, 'accepted risks'),
      effective_from: effectiveFrom,
      effective_until: effectiveUntil,
      review_at: reviewAt,
      supersedes_id: supersedesId,
    }
    return this.createCommand({
      boardId: organization.board_id,
      kind: 'organization.decision.recorded',
      input,
      fingerprint: { command: 'decision.record', organizationId: organization.id, ...normalized },
      table: 'os_decision_records',
      create: () => {
        const id = randomUUID()
        const at = timestamp()
        if (supersedesId) {
          this.db.prepare(`UPDATE os_decision_records SET status='superseded'
            WHERE id=? AND status='effective'`).run(supersedesId)
        }
        this.db.prepare(`INSERT INTO os_decision_records
          (id, organization_id, decision_key, version, question, owner_team_id,
           decider_profile_id, responsibility_id, consulted_json, options_json,
           evidence_refs_json, constraints_json, selected_option, rationale,
           accepted_risks_json, effective_from, effective_until, review_at,
           supersedes_id, status, created_at, decided_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'effective', ?, ?)`)
          .run(id, organization.id, normalized.decision_key, normalized.version,
            normalized.question, ownerTeamId, decider, responsibility.id,
            JSON.stringify(normalized.consulted), JSON.stringify(normalized.options),
            JSON.stringify(evidence), JSON.stringify(normalized.constraints), selectedOption,
            normalized.rationale, JSON.stringify(normalized.accepted_risks), effectiveFrom,
            effectiveUntil, reviewAt, supersedesId, at, at)
        return id
      },
    })
  }

  createEscalation(input: CommandInput & {
    organizationId: string
    sourceKind: string
    sourceId: string
    threshold: string
    attemptedActions: string[]
    evidenceRefs: string[]
    riskOfWaiting: string
    options: string[]
    recommendation: string
    requiredAuthority: string
    targetRoleKey: string
    responseDeadline: string
  }): Record<string, unknown> {
    const organization = this.organization.requireOrganization(input.organizationId)
    const responseDeadline = requiredIso(input.responseDeadline, 'response deadline')
    if (responseDeadline <= timestamp()) throw new ValidationError('response deadline must be in the future')
    const attempted = stringList(input.attemptedActions, 'attempted actions')
    const evidence = stringList(input.evidenceRefs, 'escalation evidence references')
    const options = stringList(input.options, 'escalation options')
    if (!attempted.length || !evidence.length || !options.length) {
      throw new ValidationError('escalation requires attempts, evidence, and bounded options')
    }
    const normalized = {
      source_kind: boundedString(input.sourceKind, 'source kind', 120),
      source_id: boundedString(input.sourceId, 'source id', 300),
      threshold: boundedString(input.threshold, 'escalation threshold', 1000),
      attempted_actions: attempted,
      evidence_refs: evidence,
      risk_of_waiting: boundedString(input.riskOfWaiting, 'risk of waiting', 4000),
      options,
      recommendation: boundedString(input.recommendation, 'recommendation', 4000),
      required_authority: boundedString(input.requiredAuthority, 'required authority', 1000),
      target_role_key: identifier(input.targetRoleKey, 'target role key'),
      response_deadline: responseDeadline,
    }
    return this.createCommand({
      boardId: organization.board_id,
      kind: 'organization.escalation.created',
      input,
      fingerprint: { command: 'escalation.create', organizationId: organization.id, ...normalized },
      table: 'os_escalations',
      create: () => {
        const id = randomUUID()
        this.db.prepare(`INSERT INTO os_escalations
          (id, organization_id, source_kind, source_id, threshold,
           attempted_actions_json, evidence_refs_json, risk_of_waiting, options_json,
           recommendation, required_authority, target_role_key, response_deadline,
           status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`)
          .run(id, organization.id, normalized.source_kind, normalized.source_id,
            normalized.threshold, JSON.stringify(attempted), JSON.stringify(evidence),
            normalized.risk_of_waiting, JSON.stringify(options), normalized.recommendation,
            normalized.required_authority, normalized.target_role_key, responseDeadline, timestamp())
        return id
      },
    })
  }

  resolveEscalation(id: string, input: CommandInput & {
    status: 'resolved' | 'rejected'
    resolution: string
    decisionId?: string | null
  }): Record<string, unknown> {
    const escalation = this.requireRecord('os_escalations', id, 'escalation')
    const organization = this.organization.requireOrganization(String(escalation.organization_id))
    if (escalation.status !== 'open') throw new ConflictError('escalation is not open')
    const status = input.status
    if (!['resolved', 'rejected'].includes(status)) throw new ValidationError('resolution status is invalid')
    const decisionId = optionalBoundedString(input.decisionId, 'decision id', 200)
    if (status === 'resolved' && !decisionId) {
      throw new ValidationError('resolved escalation requires a decision record')
    }
    if (decisionId) this.recordInOrganization(
      'os_decision_records', decisionId, organization.id, 'decision',
    )
    const resolution = boundedString(input.resolution, 'escalation resolution', 8000)
    return this.updateCommand({
      boardId: organization.board_id,
      kind: 'organization.escalation.resolved',
      input,
      fingerprint: { command: 'escalation.resolve', escalationId: id, status, resolution, decisionId },
      resultId: String(escalation.id),
      table: 'os_escalations',
      update: () => {
        const result = this.db.prepare(`UPDATE os_escalations SET status=?, resolution=?,
          decision_id=?, resolved_at=? WHERE id=? AND status='open'`)
          .run(status, resolution, decisionId, timestamp(), escalation.id)
        if (result.changes !== 1) throw new ConflictError('escalation is no longer open')
      },
    })
  }

  assessRisk(input: CommandInput & {
    organizationId: string
    actorProfileId: string
    sessionId: string
    scopeKind: string
    resourceKind: string
    resourceId: string
    action: string
    environment: string
    signals?: RiskSignals
    expiresAt: string
  }): RiskEvaluation {
    const organization = this.organization.requireOrganization(input.organizationId)
    const profileId = this.profileOnBoard(input.actorProfileId, organization.board_id)
    const sessionId = boundedString(input.sessionId, 'session id', 200)
    const signals = normalizeRiskSignals(input.signals)
    const tier = selectRiskTier(signals)
    const authority = this.organization.evaluateAuthority({
      organizationId: organization.id,
      agentProfileId: profileId,
      sessionId,
      scopeKind: boundedString(input.scopeKind, 'scope kind', 120),
      resourceKind: boundedString(input.resourceKind, 'resource kind', 120),
      action: boundedString(input.action, 'action', 160),
      riskTier: tier,
    })
    const baseline = BASELINE_CONTROL[tier]
    const control = authority.permitted
      ? strongerControl(baseline, authority.control)
      : 'prohibited'
    const expiresAt = requiredIso(input.expiresAt, 'risk evaluation expiry')
    if (expiresAt <= timestamp()) throw new ValidationError('risk evaluation expiry must be in the future')
    const normalized = {
      actor_profile_id: profileId,
      session_id: sessionId,
      resource_kind: boundedString(input.resourceKind, 'resource kind', 120),
      resource_id: boundedString(input.resourceId, 'resource id', 300),
      action: boundedString(input.action, 'action', 160),
      environment: boundedString(input.environment, 'environment', 120),
      signals,
      risk_tier: tier,
      control,
      authority_evaluation: authority,
      expires_at: expiresAt,
    }
    return this.createCommand({
      boardId: organization.board_id,
      kind: 'organization.risk.assessed',
      input,
      fingerprint: { command: 'risk.assess', organizationId: organization.id, ...normalized },
      table: 'os_risk_evaluations',
      map: mapRiskEvaluation,
      create: () => {
        const id = randomUUID()
        this.db.prepare(`INSERT INTO os_risk_evaluations
          (id, organization_id, actor_profile_id, session_id, resource_kind,
           resource_id, action, environment, signals_json, risk_tier, control,
           authority_evaluation_json, created_at, expires_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(id, organization.id, profileId, sessionId, normalized.resource_kind,
            normalized.resource_id, normalized.action, normalized.environment,
            JSON.stringify(signals), tier, control, JSON.stringify(authority),
            timestamp(), expiresAt)
        return id
      },
    })
  }

  recordParticipation(input: CommandInput & {
    organizationId: string
    subjectKind: string
    subjectId: string
    artifactSha256: string
    agentProfileId: string
    sessionId: string
    participationKind: 'dri' | 'author' | 'operator' | 'contributor' | 'reviewer' | 'approver' | 'releaser'
  }): Record<string, unknown> {
    const organization = this.organization.requireOrganization(input.organizationId)
    const normalized = {
      subject_kind: boundedString(input.subjectKind, 'subject kind', 120),
      subject_id: boundedString(input.subjectId, 'subject id', 300),
      artifact_sha256: sha256(input.artifactSha256, 'artifact sha256'),
      agent_profile_id: this.profileOnBoard(input.agentProfileId, organization.board_id),
      session_id: boundedString(input.sessionId, 'session id', 200),
      participation_kind: participationKind(input.participationKind),
    }
    return this.createCommand({
      boardId: organization.board_id,
      kind: 'organization.participation.recorded',
      input,
      fingerprint: { command: 'participation.record', organizationId: organization.id, ...normalized },
      table: 'os_participation_history',
      create: () => {
        const id = randomUUID()
        this.db.prepare(`INSERT INTO os_participation_history
          (id, organization_id, subject_kind, subject_id, artifact_sha256,
           agent_profile_id, session_id, participation_kind, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(id, organization.id, normalized.subject_kind, normalized.subject_id,
            normalized.artifact_sha256, normalized.agent_profile_id,
            normalized.session_id, normalized.participation_kind, timestamp())
        return id
      },
    })
  }

  recordControlApproval(input: CommandInput & {
    riskEvaluationId: string
    subjectKind: string
    subjectId: string
    artifactSha256: string
    decision: 'approved' | 'rejected'
    approverProfileId: string
    sessionId: string
    roleActivationId: string
    approverPrincipalType: 'human' | 'agent'
    specialistRoleKey?: string | null
    rationale: string
    expiresAt: string
  }): Record<string, unknown> {
    const evaluation = mapRiskEvaluation(this.requireRecord(
      'os_risk_evaluations', input.riskEvaluationId, 'risk evaluation',
    ))
    const organization = this.organization.requireOrganization(evaluation.organization_id)
    if (evaluation.control === 'automatic' || evaluation.control === 'prohibited') {
      throw new ForbiddenError(`control ${evaluation.control} cannot receive an approval`)
    }
    if (evaluation.expires_at <= timestamp()) throw new ForbiddenError('risk evaluation has expired')
    const approverProfileId = this.profileOnBoard(input.approverProfileId, organization.board_id)
    const sessionId = boundedString(input.sessionId, 'session id', 200)
    const roleActivationId = boundedString(input.roleActivationId, 'role activation id', 200)
    const subjectKind = boundedString(input.subjectKind, 'subject kind', 120)
    const subjectId = boundedString(input.subjectId, 'subject id', 300)
    const artifactSha256 = sha256(input.artifactSha256, 'artifact sha256')
    const prior = this.db.prepare(`SELECT participation_kind FROM os_participation_history
      WHERE organization_id=? AND subject_kind=? AND subject_id=? AND artifact_sha256=?
        AND (agent_profile_id=? OR session_id=?)
        AND participation_kind IN ('dri','author','operator') LIMIT 1`)
      .get(organization.id, subjectKind, subjectId, artifactSha256,
        approverProfileId, sessionId) as { participation_kind: string } | undefined
    if (prior) {
      throw new ForbiddenError(
        `history-based separation of duties blocks ${prior.participation_kind} from approval`,
      )
    }
    const activeRole = this.db.prepare(`SELECT definition.role_key
      FROM os_role_activations activation
      JOIN os_role_assignments assignment ON assignment.id=activation.role_assignment_id
      JOIN os_role_definitions definition ON definition.id=assignment.role_definition_id
      WHERE activation.id=? AND activation.organization_id=?
        AND activation.agent_profile_id=? AND activation.session_id=?
        AND activation.status='active'`)
      .get(roleActivationId, organization.id, approverProfileId, sessionId) as
      { role_key: string } | undefined
    if (!activeRole) throw new ForbiddenError('approval requires an active approver role')
    const specialistRoleKey = optionalBoundedString(
      input.specialistRoleKey,
      'specialist role key',
      80,
    )
    if (evaluation.control === 'specialist_approval'
      && (!specialistRoleKey || specialistRoleKey !== activeRole.role_key)) {
      throw new ForbiddenError('specialist approval requires the declared active specialist role')
    }
    if (evaluation.control === 'two_person' && input.approverPrincipalType !== 'human') {
      throw new ForbiddenError('R3 two-person control requires human approvers')
    }
    const expiresAt = requiredIso(input.expiresAt, 'approval expiry')
    if (expiresAt <= timestamp() || expiresAt > evaluation.expires_at) {
      throw new ValidationError('approval expiry must be future and within risk evaluation validity')
    }
    const decision = approvalDecision(input.decision)
    const normalized = {
      risk_evaluation_id: evaluation.id,
      subject_kind: subjectKind,
      subject_id: subjectId,
      artifact_sha256: artifactSha256,
      risk_tier: evaluation.risk_tier,
      control: evaluation.control,
      decision,
      approver_profile_id: approverProfileId,
      session_id: sessionId,
      role_activation_id: roleActivationId,
      approver_principal_type: input.approverPrincipalType,
      specialist_role_key: specialistRoleKey,
      rationale: boundedString(input.rationale, 'approval rationale', 8000),
      expires_at: expiresAt,
    }
    return this.createCommand({
      boardId: organization.board_id,
      kind: 'organization.control.approval_recorded',
      input,
      fingerprint: { command: 'control.approve', organizationId: organization.id, ...normalized },
      table: 'os_control_approvals',
      create: () => {
        const id = randomUUID()
        const at = timestamp()
        this.db.prepare(`INSERT INTO os_control_approvals
          (id, organization_id, subject_kind, subject_id, artifact_sha256,
           risk_tier, control, decision, approver_profile_id, session_id,
           role_activation_id, approver_principal_type, specialist_role_key,
           rationale, expires_at, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(id, organization.id, subjectKind, subjectId, artifactSha256,
            evaluation.risk_tier, evaluation.control, decision, approverProfileId,
            sessionId, roleActivationId, input.approverPrincipalType,
            specialistRoleKey, normalized.rationale, expiresAt, at)
        this.db.prepare(`INSERT INTO os_participation_history
          (id, organization_id, subject_kind, subject_id, artifact_sha256,
           agent_profile_id, session_id, participation_kind, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'approver', ?)
          ON CONFLICT DO NOTHING`)
          .run(randomUUID(), organization.id, subjectKind, subjectId, artifactSha256,
            approverProfileId, sessionId, at)
        return id
      },
    })
  }

  controlStatus(input: {
    organizationId: string
    subjectKind: string
    subjectId: string
    artifactSha256: string
    control: AuthorityControl
  }): ControlStatus {
    const organization = this.organization.requireOrganization(input.organizationId)
    const subjectKind = boundedString(input.subjectKind, 'subject kind', 120)
    const subjectId = boundedString(input.subjectId, 'subject id', 300)
    const digest = sha256(input.artifactSha256, 'artifact sha256')
    const control = authorityControl(input.control)
    if (control === 'automatic') {
      return {
        satisfied: true, prohibited: false, required_approvals: 0, valid_approvals: 0,
        distinct_profiles: 0, distinct_sessions: 0, rejected: false,
      }
    }
    if (control === 'prohibited') {
      return {
        satisfied: false, prohibited: true, required_approvals: 0, valid_approvals: 0,
        distinct_profiles: 0, distinct_sessions: 0, rejected: false,
      }
    }
    const approvals = this.db.prepare(`SELECT decision, approver_profile_id, session_id
      FROM os_control_approvals WHERE organization_id=? AND subject_kind=? AND subject_id=?
        AND artifact_sha256=? AND control=? AND revoked_at IS NULL AND expires_at>?
      ORDER BY created_at`).all(
      organization.id, subjectKind, subjectId, digest, control, timestamp(),
    ) as Array<{ decision: string; approver_profile_id: string; session_id: string }>
    const approved = approvals.filter((item) => item.decision === 'approved')
    const profiles = new Set(approved.map((item) => item.approver_profile_id))
    const sessions = new Set(approved.map((item) => item.session_id))
    const required = control === 'two_person' ? 2 : 1
    const rejected = approvals.some((item) => item.decision === 'rejected')
    return {
      satisfied: !rejected && approved.length >= required
        && profiles.size >= required && sessions.size >= required,
      prohibited: false,
      required_approvals: required,
      valid_approvals: approved.length,
      distinct_profiles: profiles.size,
      distinct_sessions: sessions.size,
      rejected,
    }
  }

  coordinationSnapshot(organizationId: string): Record<string, unknown> {
    const organization = this.organization.requireOrganization(organizationId)
    return {
      interactions: this.rows('os_team_interactions', organization.id),
      responsibilities: this.rows('os_responsibility_assignments', organization.id),
      objectives: this.rows('os_objectives', organization.id),
      goals: this.rows('os_team_goals', organization.id),
      capacity: this.rows('os_capacity_snapshots', organization.id),
      decisions: this.rows('os_decision_records', organization.id),
      escalations: this.rows('os_escalations', organization.id),
    }
  }

  private createCommand<T = Record<string, unknown>>(input: {
    boardId: number
    kind: string
    input: CommandInput
    fingerprint: Record<string, unknown>
    table: string
    map?: (row: Record<string, unknown>) => T
    create: (actor: ActorIdentity, idempotencyKey: string) => string
  }): T {
    const actor = actorIdentity(input.input.actor)
    const key = boundedString(input.input.idempotencyKey, 'idempotency key', 200)
    const fingerprint = canonicalHash(input.fingerprint)
    const replayId = this.replayId(input.boardId, key, input.kind, fingerprint)
    if (replayId) return this.load(input.table, replayId, input.map)
    return this.db.transaction(() => {
      const raced = this.replayId(input.boardId, key, input.kind, fingerprint)
      if (raced) return this.load(input.table, raced, input.map)
      const id = input.create(actor, key)
      this.events.append({
        boardId: input.boardId,
        actor,
        kind: input.kind,
        source: 'organization-coordination',
        idempotencyKey: key,
        correlationId: input.input.correlationId ?? key,
        payload: { result_id: id, request_fingerprint: fingerprint, actor },
      })
      return this.load(input.table, id, input.map)
    }).immediate()
  }

  private updateCommand(input: {
    boardId: number
    kind: string
    input: CommandInput
    fingerprint: Record<string, unknown>
    resultId: string
    table: string
    update: (actor: ActorIdentity) => void
  }): Record<string, unknown> {
    const actor = actorIdentity(input.input.actor)
    const key = boundedString(input.input.idempotencyKey, 'idempotency key', 200)
    const fingerprint = canonicalHash(input.fingerprint)
    const replayId = this.replayId(input.boardId, key, input.kind, fingerprint)
    if (replayId) return this.load<Record<string, unknown>>(input.table, replayId)
    return this.db.transaction(() => {
      const raced = this.replayId(input.boardId, key, input.kind, fingerprint)
      if (raced) return this.load<Record<string, unknown>>(input.table, raced)
      input.update(actor)
      this.events.append({
        boardId: input.boardId,
        actor,
        kind: input.kind,
        source: 'organization-coordination',
        idempotencyKey: key,
        correlationId: input.input.correlationId ?? key,
        payload: { result_id: input.resultId, request_fingerprint: fingerprint, actor },
      })
      return this.load<Record<string, unknown>>(input.table, input.resultId)
    }).immediate()
  }

  private replayId(boardId: number, key: string, kind: string, fingerprint: string): string | null {
    const row = this.db.prepare(`SELECT kind, payload FROM os_events
      WHERE board_id=? AND idempotency_key=?`).get(boardId, key) as
      { kind: string; payload: string } | undefined
    if (!row) return null
    const payload = parseJson<Record<string, unknown>>(row.payload, {})
    if (row.kind !== kind || payload.request_fingerprint !== fingerprint
      || typeof payload.result_id !== 'string') {
      throw new ConflictError('idempotency key was used for a different coordination command')
    }
    return payload.result_id
  }

  private load<T>(table: string, id: string, map?: (row: Record<string, unknown>) => T): T {
    const row = this.requireRecord(table, id, 'coordination record')
    return (map ? map(row) : row) as T
  }

  private requireRecord(table: string, id: string, label: string): Record<string, unknown> {
    const value = boundedString(id, `${label} id`, 300)
    const row = this.db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(value) as
      Record<string, unknown> | undefined
    if (!row) throw new NotFoundError(`${label} not found`)
    return row
  }

  private recordInOrganization(
    table: string,
    id: string,
    organizationId: string,
    label: string,
  ): Record<string, unknown> {
    const row = this.requireRecord(table, id, label)
    if (row.organization_id !== organizationId) throw new ValidationError(`${label} is outside organization`)
    return row
  }

  private teamInOrganization(teamId: string, organizationId: string): string {
    const team = this.organization.requireTeam(teamId)
    if (team.organization_id !== organizationId || team.status !== 'active') {
      throw new ValidationError('team is outside organization or inactive')
    }
    return team.id
  }

  private profileOnBoard(profileId: string, boardId: number): string {
    const id = boundedString(profileId, 'agent profile id', 200)
    const profile = this.db.prepare('SELECT board_id, status FROM agent_profiles WHERE id=?')
      .get(id) as { board_id: number; status: string } | undefined
    if (!profile || profile.board_id !== boardId || profile.status !== 'active') {
      throw new NotFoundError('active agent profile not found on organization board')
    }
    return id
  }

  private rows(table: string, organizationId: string): Record<string, unknown>[] {
    return this.db.prepare(`SELECT * FROM ${table} WHERE organization_id=? ORDER BY created_at`)
      .all(organizationId) as Record<string, unknown>[]
  }
}

function mapMessage(row: Record<string, unknown>): DurableMessage {
  return {
    id: String(row.id),
    organization_id: String(row.organization_id),
    thread_id: String(row.thread_id),
    parent_id: nullable(row.parent_id),
    causal_id: nullable(row.causal_id),
    team_id: nullable(row.team_id),
    actor_profile_id: String(row.actor_profile_id),
    session_id: String(row.session_id),
    role_activation_id: String(row.role_activation_id),
    intent: String(row.intent) as MessageIntent,
    recipient_profile_ids: parseJson(row.recipient_profile_ids_json, []),
    recipient_team_ids: parseJson(row.recipient_team_ids_json, []),
    visibility: String(row.visibility) as DurableMessage['visibility'],
    urgency: String(row.urgency) as DurableMessage['urgency'],
    requested_action: nullable(row.requested_action),
    deadline: nullable(row.deadline),
    expires_at: nullable(row.expires_at),
    links: parseJson(row.links_json, {}),
    payload_version: Number(row.payload_version),
    payload: parseJson(row.payload_json, {}),
    summary: nullable(row.summary),
    idempotency_key: String(row.idempotency_key),
    receipt_policy: String(row.receipt_policy) as DurableMessage['receipt_policy'],
    redaction_class: String(row.redaction_class),
    retention_policy: String(row.retention_policy),
    automated: Number(row.automated) === 1,
    fanout_depth: Number(row.fanout_depth),
    status: String(row.status) as DurableMessage['status'],
    created_at: String(row.created_at),
  }
}

function mapRiskEvaluation(row: Record<string, unknown>): RiskEvaluation {
  return {
    id: String(row.id),
    organization_id: String(row.organization_id),
    actor_profile_id: String(row.actor_profile_id),
    session_id: String(row.session_id),
    resource_kind: String(row.resource_kind),
    resource_id: String(row.resource_id),
    action: String(row.action),
    environment: String(row.environment),
    signals: parseJson(row.signals_json, {}),
    risk_tier: String(row.risk_tier) as RiskTier,
    control: String(row.control) as AuthorityControl,
    authority_evaluation: parseJson(row.authority_evaluation_json, deniedAuthority()),
    created_at: String(row.created_at),
    expires_at: String(row.expires_at),
  }
}

function deniedAuthority(): AuthorityEvaluation {
  return {
    permitted: false,
    decision: 'deny',
    control: 'prohibited',
    policy_id: null,
    risk_tier: 'R4',
    active_role_keys: [],
    missing_role_keys: [],
    reason: 'invalid persisted authority evaluation',
  }
}

function selectRiskTier(signals: RiskSignals): RiskTier {
  if (signals.disallowed) return 'R4'
  if (signals.destructive || signals.public_release || signals.secrets
    || signals.identity || signals.material_spend) return 'R3'
  if (signals.shared_interface || signals.migration || signals.security_control
    || signals.production_configuration) return 'R2'
  if (signals.mutating) return 'R1'
  return 'R0'
}

function normalizeRiskSignals(value: RiskSignals | undefined): RiskSignals {
  const source = jsonRecord(value, 'risk signals')
  const result: RiskSignals = {}
  for (const key of [
    'mutating', 'shared_interface', 'migration', 'security_control',
    'production_configuration', 'destructive', 'public_release', 'secrets',
    'identity', 'material_spend', 'disallowed',
  ] as const) {
    if (source[key] !== undefined && typeof source[key] !== 'boolean') {
      throw new ValidationError(`risk signal ${key} must be boolean`)
    }
    if (source[key] === true) result[key] = true
  }
  return result
}

function strongerControl(left: AuthorityControl, right: AuthorityControl): AuthorityControl {
  return CONTROL_STRENGTH[left] >= CONTROL_STRENGTH[right] ? left : right
}

function assertIntentLinks(intent: MessageIntent, links: Record<string, unknown>): void {
  const required: Partial<Record<MessageIntent, string>> = {
    DECISION: 'decision_id',
    ASSIGNMENT: 'work_id',
    STATUS_UPDATE: 'work_id',
    BLOCKER: 'work_id',
    REVIEW_REQUEST: 'artifact_id',
    REVIEW_FINDING: 'artifact_id',
    APPROVAL: 'artifact_id',
    REJECTION: 'artifact_id',
    EVIDENCE: 'evidence_ref',
    INCIDENT: 'incident_id',
    ESCALATION: 'escalation_id',
  }
  const key = required[intent]
  if (key && (typeof links[key] !== 'string' || !String(links[key]).trim())) {
    throw new ValidationError(`${intent} message requires link ${key}`)
  }
}

function interactionMode(value: unknown): TeamInteractionMode {
  if (!TEAM_INTERACTION_MODES.includes(value as TeamInteractionMode)) {
    throw new ValidationError('team interaction mode is invalid')
  }
  return value as TeamInteractionMode
}

function messageIntent(value: unknown): MessageIntent {
  if (!MESSAGE_INTENTS.includes(value as MessageIntent)) {
    throw new ValidationError('message intent is invalid')
  }
  return value as MessageIntent
}

function riskTier(value: unknown): RiskTier {
  if (!RISK_TIERS.includes(value as RiskTier)) throw new ValidationError('risk tier is invalid')
  return value as RiskTier
}

function authorityControl(value: unknown): AuthorityControl {
  if (!AUTHORITY_CONTROLS.includes(value as AuthorityControl)) {
    throw new ValidationError('authority control is invalid')
  }
  return value as AuthorityControl
}

function visibility(value: unknown): DurableMessage['visibility'] {
  if (!['private', 'team', 'organization', 'public'].includes(String(value))) {
    throw new ValidationError('message visibility is invalid')
  }
  return value as DurableMessage['visibility']
}

function urgency(value: unknown): DurableMessage['urgency'] {
  if (!['routine', 'normal', 'urgent', 'critical'].includes(String(value))) {
    throw new ValidationError('message urgency is invalid')
  }
  return value as DurableMessage['urgency']
}

function receiptPolicy(value: unknown): DurableMessage['receipt_policy'] {
  if (!['none', 'delivery', 'read'].includes(String(value))) {
    throw new ValidationError('message receipt policy is invalid')
  }
  return value as DurableMessage['receipt_policy']
}

function participationKind(value: unknown):
  'dri' | 'author' | 'operator' | 'contributor' | 'reviewer' | 'approver' | 'releaser' {
  if (!['dri', 'author', 'operator', 'contributor', 'reviewer', 'approver', 'releaser']
    .includes(String(value))) throw new ValidationError('participation kind is invalid')
  return value as ReturnType<typeof participationKind>
}

function approvalDecision(value: unknown): 'approved' | 'rejected' {
  if (!['approved', 'rejected'].includes(String(value))) {
    throw new ValidationError('approval decision is invalid')
  }
  return value as 'approved' | 'rejected'
}

function identifier(value: unknown, field: string): string {
  const normalized = boundedString(value, field, 80).toLowerCase()
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(normalized)) {
    throw new ValidationError(`${field} must be a lowercase identifier`)
  }
  return normalized
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new ValidationError(`${field} must be a positive integer`)
  }
  return Number(value)
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new ValidationError(`${field} must be a non-negative integer`)
  }
  return Number(value)
}

function optionalIso(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === '') return null
  return requiredIso(value, field)
}

function requiredIso(value: unknown, field: string): string {
  const normalized = boundedString(value, field, 64)
  if (Number.isNaN(Date.parse(normalized))) throw new ValidationError(`${field} must be an ISO timestamp`)
  return new Date(normalized).toISOString()
}

function sha256(value: unknown, field: string): string {
  const normalized = boundedString(value, field, 64).toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(normalized)) throw new ValidationError(`${field} must be lowercase sha256`)
  return normalized
}

function nullable(value: unknown): string | null {
  return value == null ? null : String(value)
}
