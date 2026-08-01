import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AgentProfileService, type AgentProfile } from '../src/agent-os/agent-profiles.js'
import {
  OrganizationAssuranceService,
  SCORECARD_DIMENSIONS,
  type ScorecardDimension,
} from '../src/agent-os/organization-assurance.js'
import { OrganizationCoordinationService } from '../src/agent-os/organization-coordination.js'
import {
  OrganizationService,
  type RoleActivation,
  type Team,
} from '../src/agent-os/organization.js'
import { TaskContractService } from '../src/agent-os/task-contracts.js'
import { openDb } from '../src/db.js'

const actor = { type: 'human', id: 'product-owner' } as const
const future = '2099-12-01T00:00:00.000Z'
const approvalExpiry = '2099-11-01T00:00:00.000Z'

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function createSession(
  db: ReturnType<typeof openDb>,
  boardId: number,
  profile: AgentProfile,
  key: string,
): string {
  const conversation = db.prepare(`SELECT id FROM agent_conversations
    WHERE profile_id=? AND is_default=1`).get(profile.id) as { id: string }
  const workspaceId = `org-gate-workspace-${key}`
  const sessionId = `org-gate-session-${key}`
  db.prepare(`INSERT INTO workspaces
    (id, board_id, name, kind, root_path, status)
    VALUES (?, ?, ?, 'worktree', ?, 'active')`)
    .run(workspaceId, boardId, workspaceId, `/tmp/${workspaceId}`)
  db.prepare(`INSERT INTO agent_sessions
    (id, workspace_id, provider, status, profile_id, conversation_id, mode)
    VALUES (?, ?, 'codex', 'running', ?, ?, 'managed')`)
    .run(sessionId, workspaceId, profile.id, conversation.id)
  return sessionId
}

function activateRole(input: {
  service: OrganizationService
  organizationId: string
  team: Team
  profile: AgentProfile
  sessionId: string
  roleKey: string
  capabilities: string[]
  permissions: string[]
  constraints?: Record<string, unknown>
}): RoleActivation {
  const role = input.service.createRoleDefinition({
    organizationId: input.organizationId,
    key: input.roleKey,
    version: 1,
    name: input.roleKey,
    duties: [`Perform ${input.roleKey} duties against frozen work.`],
    capabilities: input.capabilities,
    permissions: input.permissions,
    budgets: { max_tokens: 100_000, max_cost_cents: 2_000 },
    constraints: input.constraints,
    evidenceTtlDays: 3650,
    actor,
    idempotencyKey: `org-gate-role-${input.roleKey}`,
  })
  const assignment = input.service.assignRole({
    roleDefinitionId: role.id,
    agentProfileId: input.profile.id,
    teamId: input.team.id,
    scopeKind: 'team',
    scopeId: input.team.id,
    validUntil: future,
    reason: `Staff ${input.roleKey} for the audited product slice.`,
    actor,
    idempotencyKey: `org-gate-role-assignment-${input.roleKey}`,
  })
  for (const capability of input.capabilities) {
    input.service.attestCapability({
      organizationId: input.organizationId,
      agentProfileId: input.profile.id,
      roleAssignmentId: assignment.id,
      capability,
      verdict: 'verified',
      evidenceRef: `test://capability/${capability}/verified`,
      evidenceSha256: digest(`capability:${capability}:${input.profile.id}`),
      observedAt: '2026-08-01T12:00:00.000Z',
      expiresAt: future,
      actor,
      idempotencyKey: `org-gate-capability-${input.roleKey}-${capability}`,
    })
  }
  return input.service.activateRole({
    roleAssignmentId: assignment.id,
    sessionId: input.sessionId,
    actor,
    idempotencyKey: `org-gate-activation-${input.roleKey}`,
  })
}

describe('ORG-GATE professional agent organization acceptance', () => {
  it('delivers, reviews, releases, learns, restarts, and replays without transcript dependency', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orchestra-org-gate-'))
    const databasePath = join(directory, 'organization-gate.sqlite')
    let db = openDb(databasePath)

    try {
      const boardId = Number(db.prepare(`INSERT INTO boards (project_path, name)
        VALUES ('/organization-gate', 'Organization Gate')`).run().lastInsertRowid)
      const profiles = new AgentProfileService(db)
      const builder = profiles.create({
        boardId,
        name: 'Product Builder',
        provider: 'codex',
        actor,
        idempotencyKey: 'org-gate-profile-builder',
      })
      const productOwner = profiles.create({
        boardId,
        name: 'Product Owner',
        provider: 'codex',
        actor,
        idempotencyKey: 'org-gate-profile-product-owner',
      })
      const specialist = profiles.create({
        boardId,
        name: 'Platform Security Reviewer',
        provider: 'claude',
        actor,
        idempotencyKey: 'org-gate-profile-specialist',
      })
      const incidentCommander = profiles.create({
        boardId,
        name: 'Reliability Commander',
        provider: 'codex',
        actor,
        idempotencyKey: 'org-gate-profile-incident-commander',
      })

      const organizationService = new OrganizationService(db)
      const organizationInput = {
        boardId,
        key: 'orchestra-labs',
        name: 'Orchestra Labs',
        mission: 'Deliver customer outcomes through bounded, auditable agent teams.',
        actor,
        idempotencyKey: 'org-gate-organization',
      } as const
      const organization = organizationService.createOrganization(organizationInput)
      const area = organizationService.createProductArea({
        organizationId: organization.id,
        key: 'checkout',
        name: 'Checkout',
        mission: 'Own the checkout customer journey and its supporting services.',
        actor,
        idempotencyKey: 'org-gate-area-checkout',
      })
      const productTeam = organizationService.createTeam({
        organizationId: organization.id,
        productAreaId: area.id,
        key: 'checkout-product',
        name: 'Checkout Product',
        mission: 'Own checkout outcomes and the product backlog.',
        actor,
        idempotencyKey: 'org-gate-team-product',
      })
      const platformTeam = organizationService.createTeam({
        organizationId: organization.id,
        productAreaId: area.id,
        key: 'delivery-platform',
        name: 'Delivery Platform',
        mission: 'Provide safe build and delivery services under an SLO.',
        actor,
        idempotencyKey: 'org-gate-team-platform',
      })

      const positions = [
        organizationService.createPosition({
          teamId: productTeam.id,
          key: 'product-engineer',
          roleFamily: 'engineering',
          title: 'Product Engineer',
          capacityMilli: 100_000,
          state: 'filled',
          actor,
          idempotencyKey: 'org-gate-position-builder',
        }),
        organizationService.createPosition({
          teamId: productTeam.id,
          key: 'product-owner',
          roleFamily: 'product',
          title: 'Product Owner',
          capacityMilli: 100_000,
          state: 'filled',
          actor,
          idempotencyKey: 'org-gate-position-owner',
        }),
        organizationService.createPosition({
          teamId: platformTeam.id,
          key: 'security-reviewer',
          roleFamily: 'security',
          title: 'Security Reviewer',
          capacityMilli: 100_000,
          state: 'filled',
          actor,
          idempotencyKey: 'org-gate-position-specialist',
        }),
        organizationService.createPosition({
          teamId: platformTeam.id,
          key: 'incident-commander',
          roleFamily: 'reliability',
          title: 'Incident Commander',
          capacityMilli: 100_000,
          state: 'filled',
          actor,
          idempotencyKey: 'org-gate-position-commander',
        }),
      ]
      for (const [profile, team, position, key] of [
        [builder, productTeam, positions[0], 'builder'],
        [productOwner, productTeam, positions[1], 'owner'],
        [specialist, platformTeam, positions[2], 'specialist'],
        [incidentCommander, platformTeam, positions[3], 'commander'],
      ] as const) {
        organizationService.createMembership({
          organizationId: organization.id,
          teamId: team.id,
          agentProfileId: profile.id,
          positionId: position.id,
          allocationMilli: 100_000,
          state: 'active',
          reason: 'Staff the ORG-GATE bounded delivery organization.',
          actor,
          idempotencyKey: `org-gate-membership-${key}`,
        })
      }

      const builderSession = createSession(db, boardId, builder, 'builder')
      const ownerSession = createSession(db, boardId, productOwner, 'owner')
      const specialistSession = createSession(db, boardId, specialist, 'specialist')
      const commanderSession = createSession(db, boardId, incidentCommander, 'commander')
      const builderActivation = activateRole({
        service: organizationService,
        organizationId: organization.id,
        team: productTeam,
        profile: builder,
        sessionId: builderSession,
        roleKey: 'product-builder',
        capabilities: ['typescript', 'checkout-domain'],
        permissions: ['source.write', 'test.execute'],
        constraints: { incompatible_role_keys: ['security-reviewer'] },
      })
      const ownerActivation = activateRole({
        service: organizationService,
        organizationId: organization.id,
        team: productTeam,
        profile: productOwner,
        sessionId: ownerSession,
        roleKey: 'product-owner',
        capabilities: ['product-decision'],
        permissions: ['objective.decide', 'escalation.resolve'],
      })
      const specialistActivation = activateRole({
        service: organizationService,
        organizationId: organization.id,
        team: platformTeam,
        profile: specialist,
        sessionId: specialistSession,
        roleKey: 'security-reviewer',
        capabilities: ['security-review'],
        permissions: ['source.approve', 'gate.evaluate'],
        constraints: { incompatible_role_keys: ['product-builder'] },
      })
      activateRole({
        service: organizationService,
        organizationId: organization.id,
        team: platformTeam,
        profile: incidentCommander,
        sessionId: commanderSession,
        roleKey: 'incident-commander',
        capabilities: ['incident-response'],
        permissions: ['incident.command'],
      })

      const productOwnership = organizationService.assignOwnership({
        organizationId: organization.id,
        teamId: productTeam.id,
        resourceKind: 'product',
        resourceId: 'checkout-success',
        serviceName: 'Checkout customer outcome',
        serviceLevel: { objective: 'completion_rate>=0.90' },
        actor,
        idempotencyKey: 'org-gate-ownership-product',
      })
      const buildServiceOwnership = organizationService.assignOwnership({
        organizationId: organization.id,
        teamId: platformTeam.id,
        resourceKind: 'service',
        resourceId: 'verified-build',
        serviceName: 'Verified Build Service',
        serviceLevel: {
          availability_percent: 99.9,
          response_minutes: 30,
          error_budget_percent: 0.1,
        },
        actor,
        idempotencyKey: 'org-gate-ownership-build-service',
      })
      expect(productOwnership.team_id).toBe(productTeam.id)
      expect(buildServiceOwnership.team_id).toBe(platformTeam.id)

      organizationService.createAuthorityPolicy({
        organizationId: organization.id,
        key: 'shared-source-r2',
        version: 1,
        name: 'Shared source changes',
        scopeKind: 'team',
        resourceKind: 'source',
        actions: ['write'],
        riskTier: 'R2',
        decision: 'review',
        control: 'specialist_approval',
        requiredRoles: ['product-builder'],
        constraints: { rollback_evidence_required: true },
        priority: 100,
        actor,
        idempotencyKey: 'org-gate-policy-source-r2',
      })
      expect(organizationService.evaluateAuthority({
        organizationId: organization.id,
        agentProfileId: builder.id,
        sessionId: builderSession,
        scopeKind: 'team',
        resourceKind: 'source',
        action: 'write',
        riskTier: 'R2',
      })).toMatchObject({
        permitted: true,
        decision: 'review',
        control: 'specialist_approval',
        active_role_keys: ['product-builder'],
      })

      const coordination = new OrganizationCoordinationService(db)
      const assurance = new OrganizationAssuranceService(db)
      const interaction = coordination.createTeamInteraction({
        organizationId: organization.id,
        mode: 'x_as_a_service',
        ownerTeamId: productTeam.id,
        providerTeamId: platformTeam.id,
        consumerTeamId: productTeam.id,
        participantTeamIds: [productTeam.id, platformTeam.id],
        purpose: 'Consume the verified build service for the checkout product slice.',
        serviceContractRef: 'service://verified-build/v1',
        serviceLevel: { response_minutes: 30, availability_percent: 99.9 },
        exitCondition: 'The product slice is deployed and its outcome is observed.',
        expiresAt: future,
        actor,
        idempotencyKey: 'org-gate-interaction-build-service',
      })
      const objective = coordination.createObjective({
        organizationId: organization.id,
        key: 'checkout-success',
        version: 1,
        statement: 'Increase successful checkout completion without reducing reliability.',
        outcomeDefinition: { metric: 'completion_rate', target: 0.90, reliability_slo: 0.999 },
        customerEvidenceRefs: ['research://checkout/usability/2026-08'],
        ownerTeamId: productTeam.id,
        actor,
        idempotencyKey: 'org-gate-objective-checkout',
      })
      const cardId = Number(db.prepare(`INSERT INTO cards
        (board_id, title, description)
        VALUES (?, 'Reliable checkout adapter', 'Deliver a verified checkout adapter.')`)
        .run(boardId).lastInsertRowid)
      const contracts = new TaskContractService(db)
      contracts.getOrCreate(cardId)
      const contract = contracts.put(cardId, {
        objective: 'Deliver the research-backed checkout adapter under the build-service SLO.',
        verify_commands: ['npm test', 'npm run build'],
        non_goals: ['Replace the payment provider.'],
        risks: ['Shared checkout interface', 'Provider timeout'],
        budget_tokens: 80_000,
        budget_cents: 2_000,
        priority: 100,
      })
      const goal = coordination.createTeamGoal({
        organizationId: organization.id,
        objectiveId: String(objective.id),
        teamId: productTeam.id,
        key: 'checkout-adapter',
        version: 1,
        statement: 'Ship the validated checkout adapter.',
        measure: { completion_rate: 0.90, availability_percent: 99.9 },
        designRef: 'figma://checkout/adapter-flow',
        designVersion: 'v3',
        designSha256: digest('figma:checkout:adapter-flow:v3'),
        contractCardId: cardId,
        actor,
        idempotencyKey: 'org-gate-goal-checkout-adapter',
      })
      expect(goal).toMatchObject({
        objective_id: objective.id,
        contract_card_id: cardId,
        contract_version: contract.version,
      })
      expect(String(goal.contract_sha256)).toMatch(/^[0-9a-f]{64}$/)
      const responsibility = coordination.assignResponsibility({
        organizationId: organization.id,
        workKind: 'contract_card',
        workId: String(cardId),
        driProfileId: builder.id,
        deciderProfileId: productOwner.id,
        consulted: ['customer-research', 'delivery-platform'],
        reviewerProfileIds: [specialist.id],
        informed: ['checkout-stakeholders'],
        riskTier: 'R2',
        actor,
        idempotencyKey: 'org-gate-responsibility-checkout',
      })
      for (const [team, key, values] of [
        [productTeam, 'product', { available: 200_000, allocated: 180_000, wip: 2, queued: 1 }],
        [platformTeam, 'platform', { available: 200_000, allocated: 150_000, wip: 1, queued: 2 }],
      ] as const) {
        coordination.captureCapacity({
          organizationId: organization.id,
          teamId: team.id,
          windowStart: '2026-08-01T00:00:00.000Z',
          windowEnd: '2026-08-08T00:00:00.000Z',
          availableMilli: values.available,
          allocatedMilli: values.allocated,
          wipLimit: 3,
          currentWip: values.wip,
          queuedDemand: values.queued,
          blockedCount: key === 'product' ? 1 : 0,
          oldestBlockedAt: key === 'product' ? '2026-08-01T10:00:00.000Z' : null,
          constraints: { review_slots: 1, required_skill: key === 'product' ? 'checkout' : 'security' },
          sourceRefs: [`capacity://${key}/2026-w31`],
          actor,
          idempotencyKey: `org-gate-capacity-${key}`,
        })
      }

      const blockerMessageInput = {
        organizationId: organization.id,
        threadId: `contract-card-${cardId}`,
        teamId: productTeam.id,
        actorProfileId: builder.id,
        sessionId: builderSession,
        roleActivationId: builderActivation.id,
        intent: 'BLOCKER' as const,
        recipientProfileIds: [specialist.id],
        requestedAction: 'Restore the verified build service within its SLO.',
        deadline: future,
        links: {
          work_id: `contract-card-${cardId}`,
          contract_card_id: cardId,
          team_interaction_id: interaction.id,
          service_ownership_id: buildServiceOwnership.id,
        },
        payload: { symptom: 'build service timeout', attempts: 2 },
        summary: 'The product slice is blocked on the platform build service.',
        automated: true,
        actor,
        idempotencyKey: 'org-gate-message-blocker',
      }
      const blockerMessage = coordination.sendMessage(blockerMessageInput)
      expect(blockerMessage).toMatchObject({
        intent: 'BLOCKER',
        recipient_profile_ids: [specialist.id],
        recipient_team_ids: [],
        fanout_depth: 0,
        status: 'durable',
      })
      const automatedParent = coordination.sendMessage({
        organizationId: organization.id,
        threadId: 'org-gate-ack-loop',
        actorProfileId: builder.id,
        sessionId: builderSession,
        roleActivationId: builderActivation.id,
        intent: 'QUESTION',
        recipientProfileIds: [specialist.id],
        links: {},
        automated: true,
        actor,
        idempotencyKey: 'org-gate-message-ack-parent',
      })
      expect(() => coordination.sendMessage({
        organizationId: organization.id,
        threadId: 'org-gate-ack-loop',
        parentId: automatedParent.id,
        actorProfileId: builder.id,
        sessionId: builderSession,
        roleActivationId: builderActivation.id,
        intent: 'ANSWER',
        recipientProfileIds: [specialist.id],
        links: {},
        automated: true,
        actor,
        idempotencyKey: 'org-gate-message-prohibited-ack',
      })).toThrow(/acknowledgement loops/)

      const decision = coordination.recordDecision({
        organizationId: organization.id,
        key: 'build-service-recovery',
        version: 1,
        question: 'How should the product slice proceed after the build-service SLO breach?',
        ownerTeamId: productTeam.id,
        deciderProfileId: productOwner.id,
        responsibilityId: String(responsibility.id),
        consulted: [specialist.id],
        options: [
          { id: 'restore', summary: 'Restore the service and preserve provenance.' },
          { id: 'fallback', summary: 'Use the bounded approved fallback.' },
        ],
        evidenceRefs: ['log://verified-build/timeout', 'slo://verified-build/v1'],
        constraints: { release_window: '2026-w31' },
        selectedOption: 'restore',
        rationale: 'Restoration keeps the exact attested build path and bounds risk.',
        acceptedRisks: ['Release may be delayed by thirty minutes.'],
        actor,
        idempotencyKey: 'org-gate-decision-build-recovery',
      })
      const escalation = coordination.createEscalation({
        organizationId: organization.id,
        sourceKind: 'service_dependency',
        sourceId: String(interaction.id),
        threshold: 'Verified build response SLO breached.',
        attemptedActions: ['Retried twice', 'Checked provider status and capacity'],
        evidenceRefs: ['log://verified-build/timeout', 'capacity://platform/2026-w31'],
        riskOfWaiting: 'The product release window and outcome experiment will be missed.',
        options: ['Restore the service', 'Use the approved fallback'],
        recommendation: 'Restore the service and preserve provenance.',
        requiredAuthority: `product-owner:${productOwner.id}`,
        targetRoleKey: 'product-owner',
        responseDeadline: future,
        actor,
        idempotencyKey: 'org-gate-escalation-build-service',
      })
      const resolvedEscalation = coordination.resolveEscalation(String(escalation.id), {
        status: 'resolved',
        resolution: 'The product owner selected restoration; the service recovered within the bounded extension.',
        decisionId: String(decision.id),
        actor,
        idempotencyKey: 'org-gate-escalation-resolution',
      })
      expect(resolvedEscalation).toMatchObject({
        status: 'resolved',
        decision_id: decision.id,
        target_role_key: 'product-owner',
      })
      expect(decision.decider_profile_id).toBe(productOwner.id)
      expect(ownerActivation.agent_profile_id).toBe(productOwner.id)

      const sourceDigest = digest('git://orchestra/checkout/commit/abc123')
      coordination.recordParticipation({
        organizationId: organization.id,
        subjectKind: 'change',
        subjectId: 'checkout-adapter-v1',
        artifactSha256: sourceDigest,
        agentProfileId: builder.id,
        sessionId: builderSession,
        participationKind: 'author',
        actor,
        idempotencyKey: 'org-gate-participation-author',
      })
      const risk = coordination.assessRisk({
        organizationId: organization.id,
        actorProfileId: builder.id,
        sessionId: builderSession,
        scopeKind: 'team',
        resourceKind: 'source',
        resourceId: 'checkout-adapter-v1',
        action: 'write',
        environment: 'shared',
        signals: { mutating: true, shared_interface: true },
        expiresAt: future,
        actor,
        idempotencyKey: 'org-gate-risk-checkout-adapter',
      })
      expect(risk).toMatchObject({ risk_tier: 'R2', control: 'specialist_approval' })
      expect(() => coordination.recordControlApproval({
        riskEvaluationId: risk.id,
        subjectKind: 'change',
        subjectId: 'checkout-adapter-v1',
        artifactSha256: sourceDigest,
        decision: 'approved',
        approverProfileId: builder.id,
        sessionId: builderSession,
        roleActivationId: builderActivation.id,
        approverPrincipalType: 'agent',
        specialistRoleKey: 'product-builder',
        rationale: 'Attempted self approval.',
        expiresAt: approvalExpiry,
        actor,
        idempotencyKey: 'org-gate-prohibited-self-approval',
      })).toThrow(/history-based separation/)
      const specialistApproval = coordination.recordControlApproval({
        riskEvaluationId: risk.id,
        subjectKind: 'change',
        subjectId: 'checkout-adapter-v1',
        artifactSha256: sourceDigest,
        decision: 'approved',
        approverProfileId: specialist.id,
        sessionId: specialistSession,
        roleActivationId: specialistActivation.id,
        approverPrincipalType: 'agent',
        specialistRoleKey: 'security-reviewer',
        rationale: 'Shared-interface and rollback evidence passed specialist review.',
        expiresAt: approvalExpiry,
        actor,
        idempotencyKey: 'org-gate-specialist-approval',
      })
      expect(coordination.controlStatus({
        organizationId: organization.id,
        subjectKind: 'change',
        subjectId: 'checkout-adapter-v1',
        artifactSha256: sourceDigest,
        control: 'specialist_approval',
      })).toMatchObject({ satisfied: true, valid_approvals: 1, distinct_profiles: 1 })

      const traceSpecification = [
        ['objective', `objective://${objective.id}/v1`],
        ['customer_evidence', 'research://checkout/usability/2026-08'],
        ['design', 'figma://checkout/adapter-flow/v3'],
        ['decision', `decision://${decision.id}/v1`],
        ['contract', `contract://card/${cardId}/v${contract.version}`],
        ['assignment', `responsibility://${responsibility.id}`],
        ['session', `session://${builderSession}`],
        ['source', 'git://orchestra/checkout/commit/abc123'],
        ['review', `approval://${specialistApproval.id}`],
        ['test', 'test://checkout/full-suite/1690'],
        ['build', 'build://checkout/verified/v1'],
        ['deployment', 'deployment://checkout/canary/v1'],
        ['outcome', 'metric://checkout/completion/2026-w31'],
      ] as const
      const traceNodes: Array<Record<string, unknown>> = []
      const expectedDigests: Record<string, string> = {}
      for (const [index, [kind, externalRef]] of traceSpecification.entries()) {
        const sha256 = kind === 'source' ? sourceDigest : digest(`${kind}:${externalRef}`)
        expectedDigests[externalRef] = sha256
        traceNodes.push(assurance.addTraceNode({
          organizationId: organization.id,
          kind,
          externalRef,
          version: kind === 'contract' ? String(contract.version) : '1',
          sha256,
          metadata: { ordinal: index, evidence_only: true },
          actor,
          idempotencyKey: `org-gate-trace-node-${kind}`,
        }))
      }
      for (let index = 0; index < traceNodes.length - 1; index += 1) {
        assurance.linkTraceNodes({
          organizationId: organization.id,
          fromNodeId: String(traceNodes[index].id),
          toNodeId: String(traceNodes[index + 1].id),
          relationship: 'produces_verified_successor',
          evidenceRef: `trace-evidence://org-gate/${index + 1}`,
          actor,
          idempotencyKey: `org-gate-trace-edge-${index + 1}`,
        })
      }
      const traceVerification = assurance.verifyTrace({
        organizationId: organization.id,
        fromNodeId: String(traceNodes[0].id),
        toNodeId: String(traceNodes.at(-1)?.id),
        expectedDigests,
      })
      expect(traceVerification).toMatchObject({
        valid: true,
        path_kinds: traceSpecification.map(([kind]) => kind),
        missing_expected_digests: [],
        digest_mismatches: [],
      })

      const buildDigest = expectedDigests['build://checkout/verified/v1']
      const provenanceInput = {
        organizationId: organization.id,
        subjectKind: 'build',
        subjectId: 'checkout-build-v1',
        artifactSha256: buildDigest,
        sourceUri: 'git://orchestra/checkout/commit/abc123',
        sourceSha256: sourceDigest,
        builderType: 'agent-session',
        builderId: builderSession,
        buildType: 'npm-production-build',
        inputs: [
          { uri: 'git://orchestra/checkout/commit/abc123', sha256: sourceDigest },
          { uri: `contract://card/${cardId}/v${contract.version}`, sha256: expectedDigests[`contract://card/${cardId}/v${contract.version}`] },
        ],
        parameters: { command: 'npm run build', clean: true },
        environment: { node: '22.20.0', os: 'darwin', isolation: 'worktree' },
        outputs: [{ uri: 'build://checkout/verified/v1', sha256: buildDigest }],
        actor,
        idempotencyKey: 'org-gate-provenance-build',
      } as const
      const provenance = assurance.attestProvenance(provenanceInput)
      expect(assurance.verifyProvenance(String(provenance.id), buildDigest)).toBe(true)
      expect(db.prepare(`SELECT source_uri, source_sha256, builder_type, builder_id,
        build_type, inputs_json, parameters_json, environment_json, outputs_json
        FROM os_provenance_attestations WHERE id=?`).get(provenance.id)).toEqual({
        source_uri: provenanceInput.sourceUri,
        source_sha256: sourceDigest,
        builder_type: provenanceInput.builderType,
        builder_id: builderSession,
        build_type: provenanceInput.buildType,
        inputs_json: JSON.stringify(provenanceInput.inputs),
        parameters_json: JSON.stringify(provenanceInput.parameters),
        environment_json: JSON.stringify(provenanceInput.environment),
        outputs_json: JSON.stringify(provenanceInput.outputs),
      })

      const gateDefinition = assurance.createQualityGateDefinition({
        organizationId: organization.id,
        key: 'r2-product-delivery',
        version: 1,
        name: 'R2 product delivery gate',
        riskTiers: ['R2'],
        graph: {
          nodes: [
            { key: 'ready', depends_on: [], evidence_families: ['contract'], approver_roles: [] },
            { key: 'design', depends_on: ['ready'], evidence_families: ['design'], approver_roles: [] },
            { key: 'review', depends_on: ['design'], evidence_families: ['review'], approver_roles: ['security-reviewer'] },
            { key: 'tests', depends_on: ['review'], evidence_families: ['test'], approver_roles: [] },
            { key: 'build', depends_on: ['tests'], evidence_families: ['provenance'], approver_roles: [] },
            { key: 'release', depends_on: ['build'], evidence_families: ['deployment'], approver_roles: [] },
            { key: 'outcome', depends_on: ['release'], evidence_families: ['metric'], approver_roles: [] },
          ],
        },
        entryCriteria: ['Frozen contract', 'Named DRI and decider', 'R2 risk evaluation'],
        requiredEvidenceFamilies: ['contract', 'design', 'review', 'test', 'provenance', 'deployment', 'metric'],
        approverRoleKeys: ['security-reviewer'],
        timeoutSeconds: 3600,
        failureBehavior: 'block',
        actor,
        idempotencyKey: 'org-gate-definition-r2-delivery',
      })
      const gateRun = assurance.startQualityGate({
        definitionId: String(gateDefinition.id),
        subjectKind: 'change',
        subjectId: 'checkout-adapter-v1',
        artifactSha256: sourceDigest,
        riskTier: 'R2',
        actor,
        idempotencyKey: 'org-gate-run-r2-delivery',
      })
      const gateEvidence: Record<string, string> = {
        ready: `contract://card/${cardId}/v${contract.version}`,
        design: 'figma://checkout/adapter-flow/v3',
        review: `approval://${specialistApproval.id}`,
        tests: 'test://checkout/full-suite/1690',
        build: `provenance://${provenance.id}`,
        release: 'deployment://checkout/canary/v1',
        outcome: 'metric://checkout/completion/2026-w31',
      }
      for (const nodeKey of ['ready', 'design', 'review', 'tests', 'build', 'release', 'outcome']) {
        assurance.recordQualityGateResult({
          runId: String(gateRun.id),
          nodeKey,
          status: 'passed',
          evidenceRefs: [gateEvidence[nodeKey]],
          approvalIds: nodeKey === 'review' ? [String(specialistApproval.id)] : [],
          finding: `${nodeKey} evidence verified.`,
          evaluatedByProfileId: specialist.id,
          actor,
          idempotencyKey: `org-gate-result-${nodeKey}`,
        })
      }
      expect(assurance.evaluateQualityGate(String(gateRun.id))).toMatchObject({
        status: 'passed',
        missing_nodes: [],
        failed_nodes: [],
        overridden_nodes: [],
        failure_behavior: 'block',
      })

      expect(() => assurance.createMetricDefinition({
        organizationId: organization.id,
        key: 'commit_count',
        version: 1,
        dimension: 'flow',
        name: 'Commit count ranking',
        purpose: 'Rank individual workers by output volume.',
        population: 'individual agents',
        ownerTeamId: productTeam.id,
        source: 'git commit_count',
        windowDefinition: 'weekly',
        freshnessSeconds: 86_400,
        uncertaintyDefinition: 'none',
        knownConfounders: [],
        accessPolicy: 'private',
        prohibitedUses: ['individual_ranking', 'activity_volume_productivity'],
        unitOfAnalysis: 'team',
        actor,
        idempotencyKey: 'org-gate-prohibited-activity-metric',
      })).toThrow(/activity-volume/)
      const scorecard = assurance.createScorecard({
        organizationId: organization.id,
        subjectKind: 'team',
        subjectId: productTeam.id,
        ownerTeamId: productTeam.id,
        windowStart: '2026-07-01T00:00:00.000Z',
        windowEnd: '2026-08-01T00:00:00.000Z',
        operatingContext: 'A provider migration and one simulated service incident affected the window.',
        confidence: 'high',
        actor,
        idempotencyKey: 'org-gate-scorecard-product',
      })
      const metricDefinitions: Array<Record<string, unknown>> = []
      for (const [index, dimension] of SCORECARD_DIMENSIONS.entries()) {
        const metric = assurance.createMetricDefinition({
          organizationId: organization.id,
          key: `checkout-${dimension}`,
          version: 1,
          dimension,
          name: `Checkout ${dimension}`,
          purpose: `Measure the team's ${dimension} contribution to the accepted product outcome.`,
          population: 'Checkout product and service over the delivery window.',
          ownerTeamId: productTeam.id,
          source: `telemetry://${dimension}`,
          windowDefinition: 'monthly delivery window',
          freshnessSeconds: 31_536_000,
          uncertaintyDefinition: 'Bounded by source freshness and sample size.',
          knownConfounders: ['provider migration', 'seasonality'],
          accessPolicy: 'team, reviewers, and auditors',
          prohibitedUses: ['individual_ranking', 'activity_volume_productivity'],
          unitOfAnalysis: 'team',
          actor,
          idempotencyKey: `org-gate-metric-${dimension}`,
        })
        metricDefinitions.push(metric)
        assurance.recordMetricObservation({
          scorecardId: String(scorecard.id),
          metricDefinitionId: String(metric.id),
          value: { normalized_value: Number((0.90 + index * 0.01).toFixed(2)), unit: 'ratio' },
          evidenceRefs: [`telemetry://${dimension}/2026-w31`],
          uncertainty: 'The sample is sufficient for the bounded acceptance window.',
          observedAt: '2026-08-01T12:00:00.000Z',
          actor,
          idempotencyKey: `org-gate-observation-${dimension}`,
        })
      }
      expect(assurance.calibrateScorecard(String(scorecard.id), {
        actor,
        idempotencyKey: 'org-gate-scorecard-calibration',
      }).status).toBe('calibrated')
      expect(new Set(metricDefinitions.map((metric) => metric.dimension)))
        .toEqual(new Set<ScorecardDimension>(SCORECARD_DIMENSIONS))

      const incident = assurance.openIncident({
        organizationId: organization.id,
        key: 'inc-org-gate-001',
        serviceOwnershipId: buildServiceOwnership.id,
        severity: 'SEV2',
        summary: 'Verified build service timed out during checkout delivery.',
        impact: 'The product team was blocked and the release window was at risk.',
        errorBudgetConsumed: 0.25,
        commanderProfileId: incidentCommander.id,
        startedAt: '2026-08-01T10:00:00.000Z',
        detectedAt: '2026-08-01T10:02:00.000Z',
        evidenceRefs: ['alert://verified-build/timeout'],
        actor,
        idempotencyKey: 'org-gate-incident-build-service',
      })
      assurance.addIncidentTimeline({
        incidentId: String(incident.id),
        eventKind: 'contained',
        summary: 'Traffic moved to the bounded recovery worker.',
        evidenceRefs: ['change://verified-build/recovery-worker'],
        actorProfileId: incidentCommander.id,
        occurredAt: '2026-08-01T10:20:00.000Z',
        actor,
        idempotencyKey: 'org-gate-incident-contained',
      })
      assurance.resolveIncident(String(incident.id), {
        summary: 'The build service recovered and the product artifact was reverified.',
        evidenceRefs: ['test://verified-build/recovery'],
        actorProfileId: incidentCommander.id,
        resolvedAt: '2026-08-01T11:00:00.000Z',
        actor,
        idempotencyKey: 'org-gate-incident-resolved',
      })
      const postmortem = assurance.createPostmortem({
        incidentId: String(incident.id),
        authorProfileId: incidentCommander.id,
        reviewerProfileId: specialist.id,
        summary: 'Recovery-worker capacity was not exercised under the provider migration load.',
        causalAnalysis: {
          contributing_conditions: ['provider migration load', 'unexercised recovery capacity'],
          blame: null,
        },
        impactAnalysis: 'The incident consumed 25% of the service error budget and blocked delivery.',
        containmentEvidenceRefs: ['change://verified-build/recovery-worker'],
        recoveryEvidenceRefs: ['test://verified-build/recovery'],
        lessons: [{
          key: 'exercise-recovery-capacity',
          content: 'Exercise verified-build recovery capacity whenever provider topology changes.',
        }],
        actor,
        idempotencyKey: 'org-gate-postmortem-build-service',
      })
      expect(postmortem.author_profile_id).not.toBe(postmortem.reviewer_profile_id)
      expect(JSON.parse(String(postmortem.causal_analysis_json))).toMatchObject({ blame: null })
      expect(assurance.reviewPostmortem(String(postmortem.id), {
        reviewerProfileId: specialist.id,
        actor,
        idempotencyKey: 'org-gate-postmortem-review',
      }).status).toBe('reviewed')
      const correctiveAction = assurance.createCorrectiveAction({
        postmortemId: String(postmortem.id),
        actionKind: 'preventive',
        description: 'Add a provider-topology recovery capacity exercise to the release gate.',
        ownerTeamId: platformTeam.id,
        ownerProfileId: specialist.id,
        dueAt: future,
        actor,
        idempotencyKey: 'org-gate-corrective-action',
      })
      expect(assurance.verifyCorrectiveAction(String(correctiveAction.id), {
        verificationRef: 'test://verified-build/recovery-capacity/verified',
        actor,
        idempotencyKey: 'org-gate-corrective-action-verified',
      }).status).toBe('verified')
      const promotion = assurance.promotePostmortemLesson({
        postmortemId: String(postmortem.id),
        lessonKey: 'exercise-recovery-capacity',
        reviewerProfileId: specialist.id,
        actor,
        idempotencyKey: 'org-gate-knowledge-promotion',
      })
      expect(db.prepare(`SELECT source_kind, trust_class, freshness_state, ingest_state
        FROM knowledge_sources WHERE id=?`).get(promotion.knowledge_source_id)).toEqual({
        source_kind: 'gotcha',
        trust_class: 'reference',
        freshness_state: 'fresh',
        ingest_state: 'active',
      })
      expect((db.prepare(`SELECT COUNT(*) AS count FROM knowledge_chunks
        WHERE source_id=?`).get(promotion.knowledge_source_id) as { count: number }).count).toBe(1)

      const organizationBeforeRestart = organizationService.organizationSnapshot(organization.id)
      const coordinationBeforeRestart = coordination.coordinationSnapshot(organization.id)
      const assuranceBeforeRestart = assurance.dashboard(organization.id)
      expect((organizationBeforeRestart.teams as unknown[])).toHaveLength(2)
      expect((coordinationBeforeRestart.capacity as unknown[])).toHaveLength(2)
      expect((coordinationBeforeRestart.escalations as Array<{ status: string }>)[0].status).toBe('resolved')
      expect(assuranceBeforeRestart.metric_definitions.map((metric) => metric.dimension).sort())
        .toEqual([...SCORECARD_DIMENSIONS].sort())
      expect(assuranceBeforeRestart.quality_gate_runs[0]).toMatchObject({
        risk_tier: 'R2',
        status: 'passed',
      })
      expect(assuranceBeforeRestart.incidents[0]).toMatchObject({
        status: 'resolved',
        error_budget_consumed: 0.25,
      })
      expect(assuranceBeforeRestart.postmortems[0]).toMatchObject({ status: 'reviewed' })
      expect(assuranceBeforeRestart.corrective_actions[0]).toMatchObject({ status: 'verified' })
      expect(assuranceBeforeRestart.knowledge_promotions).toHaveLength(1)
      expect((db.prepare(`SELECT COUNT(*) AS count FROM conversation_events`)
        .get() as { count: number }).count).toBe(0)

      const eventCountBeforeReplay = (db.prepare(`SELECT COUNT(*) AS count FROM os_events`)
        .get() as { count: number }).count
      const restartProof = {
        boardId,
        organizationId: organization.id,
        objectiveId: String(objective.id),
        decisionId: String(decision.id),
        traceStartId: String(traceNodes[0].id),
        traceEndId: String(traceNodes.at(-1)?.id),
        provenanceId: String(provenance.id),
        gateRunId: String(gateRun.id),
        messageId: String(blockerMessage.id),
        promotionSourceId: String(promotion.knowledge_source_id),
      }

      db.close()
      db = openDb(databasePath)
      const restartedOrganization = new OrganizationService(db)
      const restartedCoordination = new OrganizationCoordinationService(db)
      const restartedAssurance = new OrganizationAssuranceService(db)

      expect(restartedOrganization.organizationSnapshot(restartProof.organizationId))
        .toEqual(organizationBeforeRestart)
      expect(restartedCoordination.coordinationSnapshot(restartProof.organizationId))
        .toEqual(coordinationBeforeRestart)
      expect(restartedAssurance.dashboard(restartProof.organizationId))
        .toEqual(assuranceBeforeRestart)
      expect(restartedOrganization.evaluateAuthority({
        organizationId: restartProof.organizationId,
        agentProfileId: builder.id,
        sessionId: builderSession,
        scopeKind: 'team',
        resourceKind: 'source',
        action: 'write',
        riskTier: 'R2',
      })).toMatchObject({ permitted: true, control: 'specialist_approval' })
      expect(restartedAssurance.verifyTrace({
        organizationId: restartProof.organizationId,
        fromNodeId: restartProof.traceStartId,
        toNodeId: restartProof.traceEndId,
        expectedDigests,
      })).toEqual(traceVerification)
      expect(restartedAssurance.verifyProvenance(restartProof.provenanceId, buildDigest)).toBe(true)
      expect(restartedAssurance.evaluateQualityGate(restartProof.gateRunId).status).toBe('passed')

      expect(restartedOrganization.createOrganization(organizationInput).id)
        .toBe(restartProof.organizationId)
      expect(restartedAssurance.addTraceNode({
        organizationId: restartProof.organizationId,
        kind: traceSpecification[0][0],
        externalRef: traceSpecification[0][1],
        version: '1',
        sha256: expectedDigests[traceSpecification[0][1]],
        metadata: { ordinal: 0, evidence_only: true },
        actor,
        idempotencyKey: 'org-gate-trace-node-objective',
      }).id).toBe(restartProof.traceStartId)
      expect(restartedCoordination.sendMessage(blockerMessageInput).id)
        .toBe(restartProof.messageId)
      expect((db.prepare(`SELECT COUNT(*) AS count FROM os_events`)
        .get() as { count: number }).count).toBe(eventCountBeforeReplay)
      expect((db.prepare(`SELECT COUNT(*) AS count FROM os_events
        WHERE idempotency_key IN (
          'org-gate-organization',
          'org-gate-trace-node-objective',
          'org-gate-message-blocker'
        )`).get() as { count: number }).count).toBe(3)

      const durableAudit = JSON.stringify({
        organization: restartedOrganization.organizationSnapshot(restartProof.organizationId),
        coordination: restartedCoordination.coordinationSnapshot(restartProof.organizationId),
        assurance: restartedAssurance.dashboard(restartProof.organizationId),
        events: db.prepare(`SELECT kind, source, payload FROM os_events
          WHERE board_id=? ORDER BY rowid`).all(restartProof.boardId),
      }).toLowerCase()
      for (const prohibited of [
        'raw_transcript',
        'raw transcript',
        'chain_of_thought',
        'chain-of-thought',
        'private_reasoning',
        'private reasoning',
      ]) expect(durableAudit).not.toContain(prohibited)
      expect((db.prepare(`SELECT COUNT(*) AS count FROM conversation_events`)
        .get() as { count: number }).count).toBe(0)
      expect(db.prepare(`SELECT status FROM os_decision_records WHERE id=?`)
        .get(restartProof.decisionId)).toEqual({ status: 'effective' })
      expect(db.prepare(`SELECT ingest_state FROM knowledge_sources WHERE id=?`)
        .get(restartProof.promotionSourceId)).toEqual({ ingest_state: 'active' })
    } finally {
      if (db.open) db.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
