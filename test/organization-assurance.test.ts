import { describe, expect, it } from 'vitest'
import { AgentProfileService, type AgentProfile } from '../src/agent-os/agent-profiles.js'
import { OrganizationAssuranceService } from '../src/agent-os/organization-assurance.js'
import { OrganizationService, type RoleActivation } from '../src/agent-os/organization.js'
import { openDb } from '../src/db.js'

const actor = { type: 'human', id: 'owner' }

function fixture() {
  const db = openDb(':memory:')
  const boardId = Number(db.prepare(`INSERT INTO boards (project_path, name)
    VALUES ('/assurance', 'Assurance')`).run().lastInsertRowid)
  const profiles = new AgentProfileService(db)
  const builder = profiles.create({ boardId, name: 'Builder', actor, idempotencyKey: 'builder' })
  const reviewer = profiles.create({ boardId, name: 'Reviewer', actor, idempotencyKey: 'reviewer' })
  const operator = profiles.create({ boardId, name: 'Operator', actor, idempotencyKey: 'operator' })
  const organizationService = new OrganizationService(db)
  const organization = organizationService.createOrganization({
    boardId,
    key: 'acme',
    name: 'Acme',
    mission: 'Deliver and learn safely.',
    actor,
    idempotencyKey: 'organization',
  })
  const team = organizationService.createTeam({
    organizationId: organization.id,
    key: 'product',
    name: 'Product',
    mission: 'Own customer product.',
    actor,
    idempotencyKey: 'team',
  })
  for (const profile of [builder, reviewer, operator]) {
    organizationService.createMembership({
      organizationId: organization.id,
      teamId: team.id,
      agentProfileId: profile.id,
      state: 'active',
      reason: 'Staff assurance fixture.',
      actor,
      idempotencyKey: `membership-${profile.id}`,
    })
  }
  const assurance = new OrganizationAssuranceService(db)
  return { db, boardId, builder, reviewer, operator, organizationService, organization, team, assurance }
}

function activate(
  context: ReturnType<typeof fixture>,
  profile: AgentProfile,
  roleKey: string,
): RoleActivation {
  const role = context.organizationService.createRoleDefinition({
    organizationId: context.organization.id,
    key: roleKey,
    version: 1,
    name: roleKey,
    duties: [`Perform ${roleKey}`],
    capabilities: [],
    permissions: [`${roleKey}.act`],
    actor,
    idempotencyKey: `role-${roleKey}`,
  })
  const assignment = context.organizationService.assignRole({
    roleDefinitionId: role.id,
    agentProfileId: profile.id,
    teamId: context.team.id,
    scopeKind: 'organization',
    scopeId: context.organization.id,
    reason: `Act as ${roleKey}.`,
    actor,
    idempotencyKey: `assignment-${roleKey}-${profile.id}`,
  })
  const conversation = context.db.prepare(`SELECT id FROM agent_conversations
    WHERE profile_id=? AND is_default=1`).get(profile.id) as { id: string }
  const workspaceId = `workspace-${roleKey}`
  const sessionId = `session-${roleKey}`
  context.db.prepare(`INSERT INTO workspaces
    (id, board_id, name, kind, root_path, status)
    VALUES (?, ?, ?, 'worktree', ?, 'active')`)
    .run(workspaceId, context.boardId, workspaceId, `/tmp/${workspaceId}`)
  context.db.prepare(`INSERT INTO agent_sessions
    (id, workspace_id, provider, status, profile_id, conversation_id, mode)
    VALUES (?, ?, 'codex', 'running', ?, ?, 'managed')`)
    .run(sessionId, workspaceId, profile.id, conversation.id)
  return context.organizationService.activateRole({
    roleAssignmentId: assignment.id,
    sessionId,
    actor,
    idempotencyKey: `activation-${roleKey}`,
  })
}

describe('OrganizationAssuranceService', () => {
  it('preserves and verifies an exact trace and SLSA-style provenance', () => {
    const context = fixture()
    const objective = context.assurance.addTraceNode({
      organizationId: context.organization.id,
      kind: 'objective',
      externalRef: 'objective://checkout',
      version: '1',
      sha256: 'a'.repeat(64),
      actor,
      idempotencyKey: 'trace-objective',
    })
    const source = context.assurance.addTraceNode({
      organizationId: context.organization.id,
      kind: 'source',
      externalRef: 'git://repo/commit/abc',
      version: 'abc',
      sha256: 'b'.repeat(64),
      actor,
      idempotencyKey: 'trace-source',
    })
    const outcome = context.assurance.addTraceNode({
      organizationId: context.organization.id,
      kind: 'outcome',
      externalRef: 'metric://checkout/2026-w31',
      version: '2026-w31',
      sha256: 'c'.repeat(64),
      actor,
      idempotencyKey: 'trace-outcome',
    })
    context.assurance.linkTraceNodes({
      organizationId: context.organization.id,
      fromNodeId: String(objective.id),
      toNodeId: String(source.id),
      relationship: 'governs',
      evidenceRef: 'decision://architecture/1',
      actor,
      idempotencyKey: 'trace-objective-source',
    })
    context.assurance.linkTraceNodes({
      organizationId: context.organization.id,
      fromNodeId: String(source.id),
      toNodeId: String(outcome.id),
      relationship: 'produced',
      evidenceRef: 'deployment://checkout/1',
      actor,
      idempotencyKey: 'trace-source-outcome',
    })
    expect(context.assurance.verifyTrace({
      organizationId: context.organization.id,
      fromNodeId: String(objective.id),
      toNodeId: String(outcome.id),
      expectedDigests: {
        'objective://checkout': 'a'.repeat(64),
        'git://repo/commit/abc': 'b'.repeat(64),
        'metric://checkout/2026-w31': 'c'.repeat(64),
      },
    })).toMatchObject({
      valid: true,
      path_kinds: ['objective', 'source', 'outcome'],
      digest_mismatches: [],
    })
    expect(() => context.assurance.linkTraceNodes({
      organizationId: context.organization.id,
      fromNodeId: String(outcome.id),
      toNodeId: String(objective.id),
      relationship: 'invalid-cycle',
      evidenceRef: 'bad://cycle',
      actor,
      idempotencyKey: 'trace-cycle',
    })).toThrow(/cycle/)

    const provenance = context.assurance.attestProvenance({
      organizationId: context.organization.id,
      subjectKind: 'build',
      subjectId: 'build-1',
      artifactSha256: 'd'.repeat(64),
      sourceUri: 'git://repo/commit/abc',
      sourceSha256: 'b'.repeat(64),
      builderType: 'agent-session',
      builderId: 'session-builder',
      buildType: 'npm-build',
      inputs: [{ uri: 'git://repo/commit/abc', sha256: 'b'.repeat(64) }],
      parameters: { command: 'npm run build' },
      environment: { node: '22.20.0' },
      outputs: [{ uri: 'artifact://build-1', sha256: 'd'.repeat(64) }],
      actor,
      idempotencyKey: 'provenance-build-1',
    })
    expect(context.assurance.verifyProvenance(String(provenance.id), 'd'.repeat(64))).toBe(true)
    context.db.close()
  })

  it('evaluates a risk-selected gate graph and retains explicit override gaps', () => {
    const context = fixture()
    const waiver = activate(context, context.reviewer, 'release-waiver')
    const definition = context.assurance.createQualityGateDefinition({
      organizationId: context.organization.id,
      key: 'release',
      version: 1,
      name: 'Release gate',
      riskTiers: ['R2'],
      graph: {
        nodes: [
          { key: 'tests', depends_on: [], evidence_families: ['test'], approver_roles: [] },
          { key: 'release', depends_on: ['tests'], evidence_families: ['build'], approver_roles: [] },
        ],
      },
      entryCriteria: ['Frozen contract'],
      requiredEvidenceFamilies: ['test', 'build'],
      approverRoleKeys: ['reviewer'],
      timeoutSeconds: 3600,
      waiverRoleKey: 'release-waiver',
      failureBehavior: 'block',
      actor,
      idempotencyKey: 'gate-release',
    })
    const run = context.assurance.startQualityGate({
      definitionId: String(definition.id),
      subjectKind: 'release',
      subjectId: 'release-1',
      artifactSha256: 'e'.repeat(64),
      riskTier: 'R2',
      actor,
      idempotencyKey: 'gate-run-release-1',
    })
    context.assurance.recordQualityGateResult({
      runId: String(run.id),
      nodeKey: 'tests',
      status: 'passed',
      evidenceRefs: ['test://suite/1'],
      evaluatedByProfileId: context.reviewer.id,
      actor,
      idempotencyKey: 'gate-result-tests',
    })
    context.assurance.recordQualityGateResult({
      runId: String(run.id),
      nodeKey: 'release',
      status: 'failed',
      evidenceRefs: ['build://failed/1'],
      finding: 'Canary environment unavailable.',
      evaluatedByProfileId: context.reviewer.id,
      actor,
      idempotencyKey: 'gate-result-release',
    })
    context.assurance.overrideQualityGate({
      runId: String(run.id),
      nodeKey: 'release',
      gap: 'Canary unavailable.',
      authorityRoleKey: 'release-waiver',
      actorProfileId: context.reviewer.id,
      roleActivationId: waiver.id,
      rationale: 'Use staged internal rollout only.',
      scope: 'internal-tenants',
      expiresAt: '2026-12-01T00:00:00.000Z',
      compensatingControl: 'Manual monitoring and instant rollback.',
      followUpRef: 'action://restore-canary',
      actor,
      idempotencyKey: 'gate-override-release',
    })
    expect(context.assurance.evaluateQualityGate(String(run.id))).toMatchObject({
      status: 'overridden',
      missing_nodes: [],
      failed_nodes: [],
      overridden_nodes: ['release'],
      failure_behavior: 'block',
    })
    context.db.close()
  })

  it('builds contextual scorecards and rejects activity ranking while supporting review appeal', () => {
    const context = fixture()
    expect(() => context.assurance.createMetricDefinition({
      organizationId: context.organization.id,
      key: 'commit_count',
      version: 1,
      dimension: 'flow',
      name: 'Commit count',
      purpose: 'Rank workers',
      population: 'agents',
      ownerTeamId: context.team.id,
      source: 'git commit_count',
      windowDefinition: 'weekly',
      freshnessSeconds: 86400,
      uncertaintyDefinition: 'none',
      knownConfounders: [],
      accessPolicy: 'private',
      prohibitedUses: ['individual_ranking', 'activity_volume_productivity'],
      unitOfAnalysis: 'team',
      actor,
      idempotencyKey: 'metric-prohibited',
    })).toThrow(/activity-volume/)
    const metric = context.assurance.createMetricDefinition({
      organizationId: context.organization.id,
      key: 'checkout-outcome',
      version: 1,
      dimension: 'outcome',
      name: 'Checkout completion',
      purpose: 'Measure customer task success.',
      population: 'checkout sessions',
      ownerTeamId: context.team.id,
      source: 'product-analytics',
      windowDefinition: 'weekly cohort',
      freshnessSeconds: 86400,
      uncertaintyDefinition: '95% confidence interval',
      knownConfounders: ['seasonality'],
      accessPolicy: 'team and auditors',
      prohibitedUses: ['individual_ranking', 'activity_volume_productivity'],
      unitOfAnalysis: 'team',
      actor,
      idempotencyKey: 'metric-checkout',
    })
    const scorecard = context.assurance.createScorecard({
      organizationId: context.organization.id,
      subjectKind: 'team',
      subjectId: context.team.id,
      ownerTeamId: context.team.id,
      windowStart: '2026-07-01T00:00:00.000Z',
      windowEnd: '2026-08-01T00:00:00.000Z',
      operatingContext: 'Provider migration affected half the window.',
      confidence: 'medium',
      actor,
      idempotencyKey: 'scorecard-july',
    })
    const observation = context.assurance.recordMetricObservation({
      scorecardId: String(scorecard.id),
      metricDefinitionId: String(metric.id),
      uncertainty: 'No valid analytics export was available.',
      actor,
      idempotencyKey: 'observation-checkout-missing',
    })
    expect(observation.status).toBe('insufficient_evidence')
    expect(context.assurance.calibrateScorecard(String(scorecard.id), {
      actor,
      idempotencyKey: 'calibrate-july',
    }).status).toBe('calibrated')

    const review = context.assurance.createCalibrationReview({
      organizationId: context.organization.id,
      reviewKind: 'capability',
      subjectKind: 'agent_profile',
      subjectId: context.builder.id,
      windowStart: '2026-07-01T00:00:00.000Z',
      windowEnd: '2026-08-01T00:00:00.000Z',
      reviewerProfileId: context.reviewer.id,
      operatingContext: 'New domain and limited samples.',
      uncertainty: 'No verified deliveries.',
      finding: 'Would otherwise be low.',
      confidence: 'medium',
      nextReviewAt: '2026-10-01T00:00:00.000Z',
      actor,
      idempotencyKey: 'calibration-builder',
    })
    expect(review).toMatchObject({ finding: 'INSUFFICIENT_EVIDENCE', confidence: 'low' })
    const appeal = context.assurance.fileReviewAppeal({
      organizationId: context.organization.id,
      reviewKind: 'calibration',
      reviewId: String(review.id),
      appellantProfileId: context.builder.id,
      grounds: 'New evidence is available.',
      evidenceRefs: ['delivery://verified/1'],
      actor,
      idempotencyKey: 'appeal-calibration-builder',
    })
    expect(context.assurance.resolveReviewAppeal(String(appeal.id), {
      status: 'modified',
      independentReviewerProfileId: context.operator.id,
      resolution: 'Review reopened with new evidence.',
      actor,
      idempotencyKey: 'resolve-appeal-builder',
    })).toMatchObject({ status: 'modified', independent_reviewer_profile_id: context.operator.id })
    expect(context.assurance.dashboard(context.organization.id))
      .toMatchObject({ insufficient_evidence_observations: 1, open_appeals: 0 })
    context.db.close()
  })

  it('runs a blameless incident, reviewed postmortem, CAPA, and Knowledge promotion', () => {
    const context = fixture()
    const ownership = context.organizationService.assignOwnership({
      organizationId: context.organization.id,
      teamId: context.team.id,
      resourceKind: 'service',
      resourceId: 'checkout',
      serviceName: 'Checkout',
      serviceLevel: { availability: 99.9 },
      actor,
      idempotencyKey: 'ownership-checkout',
    })
    const incident = context.assurance.openIncident({
      organizationId: context.organization.id,
      key: 'inc-2026-001',
      serviceOwnershipId: ownership.id,
      severity: 'SEV2',
      summary: 'Checkout timeouts.',
      impact: 'Ten percent of checkouts failed.',
      errorBudgetConsumed: 0.25,
      commanderProfileId: context.operator.id,
      startedAt: '2026-08-01T10:00:00.000Z',
      detectedAt: '2026-08-01T10:02:00.000Z',
      evidenceRefs: ['alert://checkout/1'],
      actor,
      idempotencyKey: 'incident-checkout',
    })
    context.assurance.addIncidentTimeline({
      incidentId: String(incident.id),
      eventKind: 'contained',
      summary: 'Disabled failing provider route.',
      evidenceRefs: ['change://feature-flag/1'],
      actorProfileId: context.operator.id,
      occurredAt: '2026-08-01T10:20:00.000Z',
      actor,
      idempotencyKey: 'incident-contained',
    })
    context.assurance.resolveIncident(String(incident.id), {
      summary: 'Provider route recovered and verified.',
      evidenceRefs: ['test://checkout/recovery'],
      actorProfileId: context.operator.id,
      resolvedAt: '2026-08-01T11:00:00.000Z',
      actor,
      idempotencyKey: 'incident-resolved',
    })
    const postmortem = context.assurance.createPostmortem({
      incidentId: String(incident.id),
      authorProfileId: context.operator.id,
      reviewerProfileId: context.reviewer.id,
      summary: 'Provider timeout handling lacked a circuit breaker.',
      causalAnalysis: { contributing_conditions: ['missing circuit breaker'], blame: null },
      impactAnalysis: 'Customer checkout failures consumed 25% of error budget.',
      containmentEvidenceRefs: ['change://feature-flag/1'],
      recoveryEvidenceRefs: ['test://checkout/recovery'],
      lessons: [{
        key: 'provider-circuit-breaker',
        content: 'External checkout providers require a tested circuit breaker and fallback.',
      }],
      actor,
      idempotencyKey: 'postmortem-checkout',
    })
    context.assurance.reviewPostmortem(String(postmortem.id), {
      reviewerProfileId: context.reviewer.id,
      actor,
      idempotencyKey: 'review-postmortem-checkout',
    })
    const action = context.assurance.createCorrectiveAction({
      postmortemId: String(postmortem.id),
      actionKind: 'preventive',
      description: 'Add and exercise checkout circuit breaker.',
      ownerTeamId: context.team.id,
      ownerProfileId: context.builder.id,
      dueAt: '2026-12-01T00:00:00.000Z',
      actor,
      idempotencyKey: 'action-circuit-breaker',
    })
    expect(context.assurance.verifyCorrectiveAction(String(action.id), {
      verificationRef: 'test://circuit-breaker/verified',
      actor,
      idempotencyKey: 'verify-action-circuit-breaker',
    }).status).toBe('verified')
    const promotion = context.assurance.promotePostmortemLesson({
      postmortemId: String(postmortem.id),
      lessonKey: 'provider-circuit-breaker',
      reviewerProfileId: context.reviewer.id,
      actor,
      idempotencyKey: 'promote-circuit-breaker',
    })
    expect(context.db.prepare('SELECT source_kind, freshness_state FROM knowledge_sources WHERE id=?')
      .get(promotion.knowledge_source_id)).toEqual({ source_kind: 'gotcha', freshness_state: 'fresh' })
    expect(context.assurance.dashboard(context.organization.id).incidents).toHaveLength(1)
    context.db.close()
  })
})
