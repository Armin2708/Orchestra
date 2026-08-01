import { createHash, randomUUID } from 'node:crypto'
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
import { knowledgeChunkId, knowledgeSourceId } from './knowledge-contracts.js'
import { KnowledgeStore } from './knowledge-store.js'
import type { KnowledgeChunk, KnowledgeSource } from './knowledge-types.js'
import { OrganizationService, RISK_TIERS, type RiskTier } from './organization.js'

export const TRACE_NODE_KINDS = Object.freeze([
  'objective', 'customer_evidence', 'prd', 'design', 'decision', 'contract',
  'assignment', 'session', 'source', 'commit', 'review', 'test', 'build',
  'deployment', 'outcome', 'incident',
] as const)
export type TraceNodeKind = typeof TRACE_NODE_KINDS[number]

export const SCORECARD_DIMENSIONS = Object.freeze([
  'outcome', 'quality', 'reliability', 'flow', 'cost', 'collaboration',
  'capability', 'safety',
] as const)
export type ScorecardDimension = typeof SCORECARD_DIMENSIONS[number]

const ACTIVITY_VOLUME_MARKERS = Object.freeze([
  'commit_count', 'message_count', 'meeting_count', 'lines_of_code', 'hours_online',
  'keystrokes', 'token_count', 'raw_activity',
])

interface CommandInput {
  actor: ActorIdentity
  idempotencyKey: string
  correlationId?: string | null
}

function validateGateGraph(value: GateGraph): GateGraph {
  if (!value || !Array.isArray(value.nodes) || !value.nodes.length) {
    throw new ValidationError('quality gate graph requires nodes')
  }
  const nodes = value.nodes.map((node) => ({
    key: identifier(node.key, 'gate node key'),
    depends_on: stringList(node.depends_on, 'gate dependencies')
      .map((item) => identifier(item, 'gate dependency')),
    evidence_families: stringList(node.evidence_families, 'gate evidence families')
      .map((item) => identifier(item, 'gate evidence family')),
    approver_roles: stringList(node.approver_roles, 'gate approver roles')
      .map((item) => identifier(item, 'gate approver role')),
  }))
  const keys = new Set(nodes.map((node) => node.key))
  if (keys.size !== nodes.length) throw new ValidationError('quality gate node keys must be unique')
  for (const node of nodes) {
    if (node.depends_on.includes(node.key)
      || node.depends_on.some((dependency) => !keys.has(dependency))) {
      throw new ValidationError('quality gate dependency is invalid')
    }
  }
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const byKey = new Map(nodes.map((node) => [node.key, node]))
  const visit = (key: string): void => {
    if (visiting.has(key)) throw new ValidationError('quality gate graph must be acyclic')
    if (visited.has(key)) return
    visiting.add(key)
    for (const dependency of byKey.get(key)?.depends_on ?? []) visit(dependency)
    visiting.delete(key)
    visited.add(key)
  }
  for (const node of nodes) visit(node.key)
  return { nodes }
}

function validateDigestRecords(records: Array<Record<string, unknown>>, field: string): void {
  for (const record of records) {
    boundedString(record.uri, `${field} URI`, 1000)
    sha256(record.sha256, `${field} sha256`)
  }
}

function recordArray(value: unknown, field: string): Array<Record<string, unknown>> {
  if (!Array.isArray(value) || !value.length || value.length > 500) {
    throw new ValidationError(`${field} must be a non-empty array of at most 500 records`)
  }
  return value.map((item) => jsonRecord(item, field))
}

function nonEmptyStringList(value: unknown, field: string): string[] {
  const list = stringList(value, field)
  if (!list.length) throw new ValidationError(`${field} must not be empty`)
  return list.map((item) => boundedString(item, field, 1000))
}

function traceNodeKind(value: unknown): TraceNodeKind {
  if (!TRACE_NODE_KINDS.includes(value as TraceNodeKind)) {
    throw new ValidationError('trace node kind is invalid')
  }
  return value as TraceNodeKind
}

function scorecardDimension(value: unknown): ScorecardDimension {
  if (!SCORECARD_DIMENSIONS.includes(value as ScorecardDimension)) {
    throw new ValidationError('scorecard dimension is invalid')
  }
  return value as ScorecardDimension
}

function riskTier(value: unknown): RiskTier {
  if (!RISK_TIERS.includes(value as RiskTier)) throw new ValidationError('risk tier is invalid')
  return value as RiskTier
}

function unitOfAnalysis(value: unknown): 'product' | 'service' | 'team' | 'role_capability' {
  if (!['product', 'service', 'team', 'role_capability'].includes(String(value))) {
    throw new ForbiddenError('individual activity ranking is not a supported unit of analysis')
  }
  return value as 'product' | 'service' | 'team' | 'role_capability'
}

function confidence(value: unknown): 'low' | 'medium' | 'high' {
  if (!['low', 'medium', 'high'].includes(String(value))) {
    throw new ValidationError('confidence is invalid')
  }
  return value as 'low' | 'medium' | 'high'
}

function failureBehavior(value: unknown): 'block' | 'escalate' | 'rollback' {
  if (!['block', 'escalate', 'rollback'].includes(String(value))) {
    throw new ValidationError('quality gate failure behavior is invalid')
  }
  return value as 'block' | 'escalate' | 'rollback'
}

function gateNodeStatus(value: unknown): 'passed' | 'failed' | 'blocked' | 'waived' {
  if (!['passed', 'failed', 'blocked', 'waived'].includes(String(value))) {
    throw new ValidationError('quality gate node status is invalid')
  }
  return value as 'passed' | 'failed' | 'blocked' | 'waived'
}

function calibrationKind(value: unknown): 'goal' | 'capability' | 'performance' {
  if (!['goal', 'capability', 'performance'].includes(String(value))) {
    throw new ValidationError('calibration review kind is invalid')
  }
  return value as 'goal' | 'capability' | 'performance'
}

function accessDecision(value: unknown):
  'certified' | 'revoke' | 'remediate' | 'insufficient_evidence' {
  if (!['certified', 'revoke', 'remediate', 'insufficient_evidence'].includes(String(value))) {
    throw new ValidationError('access certification decision is invalid')
  }
  return value as ReturnType<typeof accessDecision>
}

function appealReviewKind(value: unknown): 'calibration' | 'access' {
  if (!['calibration', 'access'].includes(String(value))) {
    throw new ValidationError('appeal review kind is invalid')
  }
  return value as 'calibration' | 'access'
}

function appealStatus(value: unknown): 'upheld' | 'modified' | 'rejected' {
  if (!['upheld', 'modified', 'rejected'].includes(String(value))) {
    throw new ValidationError('appeal status is invalid')
  }
  return value as 'upheld' | 'modified' | 'rejected'
}

function incidentSeverity(value: unknown): 'SEV0' | 'SEV1' | 'SEV2' | 'SEV3' {
  if (!['SEV0', 'SEV1', 'SEV2', 'SEV3'].includes(String(value))) {
    throw new ValidationError('incident severity is invalid')
  }
  return value as 'SEV0' | 'SEV1' | 'SEV2' | 'SEV3'
}

function incidentTimelineKind(value: unknown):
  'investigated' | 'decision' | 'mitigation' | 'contained' | 'recovered' {
  if (!['investigated', 'decision', 'mitigation', 'contained', 'recovered']
    .includes(String(value))) throw new ValidationError('incident timeline kind is invalid')
  return value as ReturnType<typeof incidentTimelineKind>
}

function correctiveActionKind(value: unknown): 'corrective' | 'preventive' {
  if (!['corrective', 'preventive'].includes(String(value))) {
    throw new ValidationError('corrective action kind is invalid')
  }
  return value as 'corrective' | 'preventive'
}

function identifier(value: unknown, field: string): string {
  const normalized = boundedString(value, field, 80).toLowerCase()
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(normalized)) {
    throw new ValidationError(`${field} must be a lowercase identifier`)
  }
  return normalized
}

function positiveInteger(value: unknown, field: string): number {
  return boundedInteger(value, field, 1, Number.MAX_SAFE_INTEGER)
}

function boundedInteger(value: unknown, field: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new ValidationError(`${field} must be an integer between ${minimum} and ${maximum}`)
  }
  return Number(value)
}

function nonNegativeNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new ValidationError(`${field} must be a non-negative number`)
  }
  return value
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

function rawSha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

interface GateNode {
  key: string
  depends_on: string[]
  evidence_families: string[]
  approver_roles: string[]
}

interface GateGraph {
  nodes: GateNode[]
}

export interface TraceVerification {
  valid: boolean
  path_node_ids: string[]
  path_kinds: TraceNodeKind[]
  missing_expected_digests: string[]
  digest_mismatches: Array<{ node_id: string; expected: string; actual: string }>
}

export interface GateEvaluation {
  run_id: string
  status: 'passed' | 'failed' | 'blocked' | 'overridden'
  missing_nodes: string[]
  failed_nodes: string[]
  overridden_nodes: string[]
  failure_behavior: 'block' | 'escalate' | 'rollback'
}

export interface OrganizationDashboard {
  organization_id: string
  scorecards: Record<string, unknown>[]
  incidents: Record<string, unknown>[]
  overdue_corrective_actions: Record<string, unknown>[]
  stale_metric_observations: number
  overdue_access_certifications: number
  open_appeals: number
  insufficient_evidence_observations: number
}

export class OrganizationAssuranceService {
  private readonly events: EventStore
  private readonly organization: OrganizationService
  private readonly knowledge: KnowledgeStore

  constructor(
    private readonly db: Database.Database,
    events = new EventStore(db),
    organization = new OrganizationService(db, events),
    knowledge = new KnowledgeStore(db),
  ) {
    this.events = events
    this.organization = organization
    this.knowledge = knowledge
  }

  addTraceNode(input: CommandInput & {
    organizationId: string
    kind: TraceNodeKind
    externalRef: string
    version: string
    sha256: string
    metadata?: Record<string, unknown>
  }): Record<string, unknown> {
    const organization = this.organization.requireOrganization(input.organizationId)
    const normalized = {
      node_kind: traceNodeKind(input.kind),
      external_ref: boundedString(input.externalRef, 'trace external reference', 1000),
      version: boundedString(input.version, 'trace version', 300),
      sha256: sha256(input.sha256, 'trace sha256'),
      metadata: jsonRecord(input.metadata, 'trace metadata'),
    }
    return this.createCommand({
      boardId: organization.board_id,
      kind: 'organization.trace.node_added',
      input,
      fingerprint: { command: 'trace.node.add', organizationId: organization.id, ...normalized },
      table: 'os_trace_nodes',
      create: () => {
        const id = randomUUID()
        this.db.prepare(`INSERT INTO os_trace_nodes
          (id, organization_id, node_kind, external_ref, version, sha256,
           metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(id, organization.id, normalized.node_kind, normalized.external_ref,
            normalized.version, normalized.sha256, JSON.stringify(normalized.metadata), timestamp())
        return id
      },
    })
  }

  linkTraceNodes(input: CommandInput & {
    organizationId: string
    fromNodeId: string
    toNodeId: string
    relationship: string
    evidenceRef: string
  }): Record<string, unknown> {
    const organization = this.organization.requireOrganization(input.organizationId)
    const from = this.recordInOrganization('os_trace_nodes', input.fromNodeId,
      organization.id, 'source trace node')
    const to = this.recordInOrganization('os_trace_nodes', input.toNodeId,
      organization.id, 'target trace node')
    const normalized = {
      from_node_id: String(from.id),
      to_node_id: String(to.id),
      relationship: boundedString(input.relationship, 'trace relationship', 160),
      evidence_ref: boundedString(input.evidenceRef, 'trace edge evidence reference', 1000),
    }
    return this.createCommand({
      boardId: organization.board_id,
      kind: 'organization.trace.edge_added',
      input,
      fingerprint: { command: 'trace.edge.add', organizationId: organization.id, ...normalized },
      table: 'os_trace_edges',
      create: () => {
        if (this.traceReachable(String(to.id), String(from.id), organization.id)) {
          throw new ConflictError('trace edge would create a cycle')
        }
        const id = randomUUID()
        this.db.prepare(`INSERT INTO os_trace_edges
          (id, organization_id, from_node_id, to_node_id, relationship,
           evidence_ref, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(id, organization.id, from.id, to.id, normalized.relationship,
            normalized.evidence_ref, timestamp())
        return id
      },
    })
  }

  verifyTrace(input: {
    organizationId: string
    fromNodeId: string
    toNodeId: string
    expectedDigests?: Record<string, string>
  }): TraceVerification {
    const organization = this.organization.requireOrganization(input.organizationId)
    const start = this.recordInOrganization('os_trace_nodes', input.fromNodeId,
      organization.id, 'source trace node')
    const target = this.recordInOrganization('os_trace_nodes', input.toNodeId,
      organization.id, 'target trace node')
    const path = this.tracePath(String(start.id), String(target.id), organization.id)
    const expected = input.expectedDigests ?? {}
    const missing: string[] = []
    const mismatches: TraceVerification['digest_mismatches'] = []
    const kinds: TraceNodeKind[] = []
    for (const id of path) {
      const node = this.requireRecord('os_trace_nodes', id, 'trace node')
      kinds.push(String(node.node_kind) as TraceNodeKind)
      const expectedDigest = expected[String(node.external_ref)]
      if (!expectedDigest) missing.push(String(node.external_ref))
      else if (expectedDigest !== node.sha256) {
        mismatches.push({ node_id: id, expected: expectedDigest, actual: String(node.sha256) })
      }
    }
    return {
      valid: path.length > 0 && missing.length === 0 && mismatches.length === 0,
      path_node_ids: path,
      path_kinds: kinds,
      missing_expected_digests: missing,
      digest_mismatches: mismatches,
    }
  }

  attestProvenance(input: CommandInput & {
    organizationId: string
    subjectKind: string
    subjectId: string
    artifactSha256: string
    sourceUri: string
    sourceSha256: string
    builderType: string
    builderId: string
    buildType: string
    inputs: Array<Record<string, unknown>>
    parameters?: Record<string, unknown>
    environment: Record<string, unknown>
    outputs: Array<Record<string, unknown>>
    predicateType?: string
    signatureRef?: string | null
  }): Record<string, unknown> {
    const organization = this.organization.requireOrganization(input.organizationId)
    const artifactDigest = sha256(input.artifactSha256, 'artifact sha256')
    const outputs = recordArray(input.outputs, 'provenance outputs')
    if (!outputs.some((output) => output.sha256 === artifactDigest)) {
      throw new ValidationError('provenance outputs must contain the subject artifact digest')
    }
    validateDigestRecords(recordArray(input.inputs, 'provenance inputs'), 'provenance input')
    validateDigestRecords(outputs, 'provenance output')
    const normalized = {
      subject_kind: boundedString(input.subjectKind, 'subject kind', 120),
      subject_id: boundedString(input.subjectId, 'subject id', 300),
      artifact_sha256: artifactDigest,
      source_uri: boundedString(input.sourceUri, 'source URI', 1000),
      source_sha256: sha256(input.sourceSha256, 'source sha256'),
      builder_type: boundedString(input.builderType, 'builder type', 120),
      builder_id: boundedString(input.builderId, 'builder id', 300),
      build_type: boundedString(input.buildType, 'build type', 200),
      inputs: input.inputs,
      parameters: jsonRecord(input.parameters, 'build parameters'),
      environment: jsonRecord(input.environment, 'build environment'),
      outputs,
      predicate_type: boundedString(
        input.predicateType ?? 'https://slsa.dev/provenance/v1',
        'predicate type',
        500,
      ),
      signature_ref: optionalBoundedString(input.signatureRef, 'signature reference', 1000),
    }
    return this.createCommand({
      boardId: organization.board_id,
      kind: 'organization.provenance.attested',
      input,
      fingerprint: { command: 'provenance.attest', organizationId: organization.id, ...normalized },
      table: 'os_provenance_attestations',
      create: () => {
        const id = randomUUID()
        this.db.prepare(`INSERT INTO os_provenance_attestations
          (id, organization_id, subject_kind, subject_id, artifact_sha256,
           source_uri, source_sha256, builder_type, builder_id, build_type,
           inputs_json, parameters_json, environment_json, outputs_json,
           predicate_type, signature_ref, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(id, organization.id, normalized.subject_kind, normalized.subject_id,
            artifactDigest, normalized.source_uri, normalized.source_sha256,
            normalized.builder_type, normalized.builder_id, normalized.build_type,
            JSON.stringify(normalized.inputs), JSON.stringify(normalized.parameters),
            JSON.stringify(normalized.environment), JSON.stringify(outputs),
            normalized.predicate_type, normalized.signature_ref, timestamp())
        return id
      },
    })
  }

  verifyProvenance(id: string, expectedArtifactSha256: string): boolean {
    const record = this.requireRecord('os_provenance_attestations', id, 'provenance attestation')
    const digest = sha256(expectedArtifactSha256, 'expected artifact sha256')
    const outputs = parseJson<Array<Record<string, unknown>>>(record.outputs_json, [])
    return record.artifact_sha256 === digest && outputs.some((output) => output.sha256 === digest)
  }

  createQualityGateDefinition(input: CommandInput & {
    organizationId: string
    key: string
    version: number
    name: string
    riskTiers: RiskTier[]
    graph: GateGraph
    entryCriteria: string[]
    requiredEvidenceFamilies: string[]
    approverRoleKeys: string[]
    timeoutSeconds: number
    waiverRoleKey?: string | null
    failureBehavior: 'block' | 'escalate' | 'rollback'
  }): Record<string, unknown> {
    const organization = this.organization.requireOrganization(input.organizationId)
    const graph = validateGateGraph(input.graph)
    const tiers = stringList(input.riskTiers, 'risk tiers').map(riskTier)
    if (!tiers.length) throw new ValidationError('quality gate requires risk tiers')
    const normalized = {
      gate_key: identifier(input.key, 'quality gate key'),
      version: positiveInteger(input.version, 'quality gate version'),
      name: boundedString(input.name, 'quality gate name', 200),
      risk_tiers: tiers,
      graph,
      entry_criteria: nonEmptyStringList(input.entryCriteria, 'entry criteria'),
      required_evidence_families: nonEmptyStringList(
        input.requiredEvidenceFamilies,
        'required evidence families',
      ),
      approver_role_keys: stringList(input.approverRoleKeys, 'approver role keys')
        .map((item) => identifier(item, 'approver role key')),
      timeout_seconds: boundedInteger(input.timeoutSeconds, 'timeout seconds', 1, 31536000),
      waiver_role_key: input.waiverRoleKey
        ? identifier(input.waiverRoleKey, 'waiver role key') : null,
      failure_behavior: failureBehavior(input.failureBehavior),
    }
    return this.createCommand({
      boardId: organization.board_id,
      kind: 'organization.quality_gate.defined',
      input,
      fingerprint: { command: 'quality_gate.define', organizationId: organization.id, ...normalized },
      table: 'os_quality_gate_definitions',
      create: () => {
        const id = randomUUID()
        this.db.prepare(`INSERT INTO os_quality_gate_definitions
          (id, organization_id, gate_key, version, name, risk_tiers_json,
           graph_json, entry_criteria_json, required_evidence_families_json,
           approver_role_keys_json, timeout_seconds, waiver_role_key,
           failure_behavior, status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`)
          .run(id, organization.id, normalized.gate_key, normalized.version,
            normalized.name, JSON.stringify(tiers), JSON.stringify(graph),
            JSON.stringify(normalized.entry_criteria),
            JSON.stringify(normalized.required_evidence_families),
            JSON.stringify(normalized.approver_role_keys), normalized.timeout_seconds,
            normalized.waiver_role_key, normalized.failure_behavior, timestamp())
        return id
      },
    })
  }

  startQualityGate(input: CommandInput & {
    definitionId: string
    subjectKind: string
    subjectId: string
    artifactSha256: string
    riskTier: RiskTier
  }): Record<string, unknown> {
    const definition = this.requireRecord(
      'os_quality_gate_definitions', input.definitionId, 'quality gate definition',
    )
    const organization = this.organization.requireOrganization(String(definition.organization_id))
    if (definition.status !== 'active') throw new ConflictError('quality gate definition is retired')
    const tier = riskTier(input.riskTier)
    const tiers = parseJson<string[]>(definition.risk_tiers_json, [])
    if (!tiers.includes(tier)) throw new ValidationError('quality gate does not apply to risk tier')
    const normalized = {
      definition_id: String(definition.id),
      subject_kind: boundedString(input.subjectKind, 'subject kind', 120),
      subject_id: boundedString(input.subjectId, 'subject id', 300),
      artifact_sha256: sha256(input.artifactSha256, 'artifact sha256'),
      risk_tier: tier,
    }
    return this.createCommand({
      boardId: organization.board_id,
      kind: 'organization.quality_gate.started',
      input,
      fingerprint: { command: 'quality_gate.start', organizationId: organization.id, ...normalized },
      table: 'os_quality_gate_runs',
      create: () => {
        const id = randomUUID()
        const at = timestamp()
        const deadline = new Date(Date.parse(at) + Number(definition.timeout_seconds) * 1000)
          .toISOString()
        this.db.prepare(`INSERT INTO os_quality_gate_runs
          (id, organization_id, definition_id, subject_kind, subject_id,
           artifact_sha256, risk_tier, status, started_at, deadline)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)`)
          .run(id, organization.id, definition.id, normalized.subject_kind,
            normalized.subject_id, normalized.artifact_sha256, tier, at, deadline)
        return id
      },
    })
  }

  recordQualityGateResult(input: CommandInput & {
    runId: string
    nodeKey: string
    status: 'passed' | 'failed' | 'blocked' | 'waived'
    evidenceRefs?: string[]
    approvalIds?: string[]
    finding?: string | null
    evaluatedByProfileId: string
  }): Record<string, unknown> {
    const run = this.requireRecord('os_quality_gate_runs', input.runId, 'quality gate run')
    const organization = this.organization.requireOrganization(String(run.organization_id))
    if (run.status !== 'running') throw new ConflictError('quality gate run is terminal')
    const definition = this.requireRecord(
      'os_quality_gate_definitions', String(run.definition_id), 'quality gate definition',
    )
    const graph = parseJson<GateGraph>(definition.graph_json, { nodes: [] })
    const nodeKey = identifier(input.nodeKey, 'gate node key')
    const node = graph.nodes.find((candidate) => candidate.key === nodeKey)
    if (!node) throw new NotFoundError('quality gate node not found')
    const evidence = stringList(input.evidenceRefs, 'gate evidence references')
    const approvals = stringList(input.approvalIds, 'gate approval ids')
    if (input.status === 'passed' && node.evidence_families.length && !evidence.length) {
      throw new ValidationError('passed gate node requires evidence')
    }
    if (input.status === 'passed' && node.approver_roles.length && !approvals.length) {
      throw new ValidationError('passed gate node requires approvals')
    }
    for (const approvalId of approvals) this.requireValidControlApproval(
      approvalId,
      organization.id,
      String(run.subject_kind),
      String(run.subject_id),
      String(run.artifact_sha256),
    )
    const evaluator = this.profileOnBoard(input.evaluatedByProfileId, organization.board_id)
    const normalized = {
      run_id: String(run.id),
      node_key: nodeKey,
      status: gateNodeStatus(input.status),
      evidence_refs: evidence,
      approval_ids: approvals,
      finding: optionalBoundedString(input.finding, 'gate finding', 8000),
      evaluated_by_profile_id: evaluator,
    }
    return this.createCommand({
      boardId: organization.board_id,
      kind: 'organization.quality_gate.result_recorded',
      input,
      fingerprint: { command: 'quality_gate.result', organizationId: organization.id, ...normalized },
      table: 'os_quality_gate_results',
      create: () => {
        const id = randomUUID()
        this.db.prepare(`INSERT INTO os_quality_gate_results
          (id, organization_id, run_id, node_key, status, evidence_refs_json,
           approval_ids_json, finding, evaluated_by_profile_id, evaluated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(id, organization.id, run.id, nodeKey, normalized.status,
            JSON.stringify(evidence), JSON.stringify(approvals), normalized.finding,
            evaluator, timestamp())
        return id
      },
    })
  }

  overrideQualityGate(input: CommandInput & {
    runId: string
    nodeKey: string
    gap: string
    authorityRoleKey: string
    actorProfileId: string
    roleActivationId: string
    rationale: string
    scope: string
    expiresAt: string
    compensatingControl: string
    followUpRef: string
  }): Record<string, unknown> {
    const run = this.requireRecord('os_quality_gate_runs', input.runId, 'quality gate run')
    const organization = this.organization.requireOrganization(String(run.organization_id))
    const definition = this.requireRecord(
      'os_quality_gate_definitions', String(run.definition_id), 'quality gate definition',
    )
    const roleKey = identifier(input.authorityRoleKey, 'authority role key')
    if (!definition.waiver_role_key || definition.waiver_role_key !== roleKey) {
      throw new ForbiddenError('role is not authorized to waive this quality gate')
    }
    const actorProfileId = this.profileOnBoard(input.actorProfileId, organization.board_id)
    const activation = this.db.prepare(`SELECT definition.role_key
      FROM os_role_activations activation
      JOIN os_role_assignments assignment ON assignment.id=activation.role_assignment_id
      JOIN os_role_definitions definition ON definition.id=assignment.role_definition_id
      WHERE activation.id=? AND activation.organization_id=?
        AND activation.agent_profile_id=? AND activation.status='active'`)
      .get(input.roleActivationId, organization.id, actorProfileId) as { role_key: string } | undefined
    if (!activation || activation.role_key !== roleKey) {
      throw new ForbiddenError('override requires the active waiver role')
    }
    const graph = parseJson<GateGraph>(definition.graph_json, { nodes: [] })
    const nodeKey = identifier(input.nodeKey, 'gate node key')
    if (!graph.nodes.some((node) => node.key === nodeKey)) {
      throw new NotFoundError('quality gate node not found')
    }
    const expiresAt = requiredIso(input.expiresAt, 'override expiry')
    if (expiresAt <= timestamp()) throw new ValidationError('override expiry must be future')
    const normalized = {
      run_id: String(run.id),
      node_key: nodeKey,
      gap: boundedString(input.gap, 'override gap', 8000),
      authority_role_key: roleKey,
      actor_profile_id: actorProfileId,
      role_activation_id: boundedString(input.roleActivationId, 'role activation id', 200),
      rationale: boundedString(input.rationale, 'override rationale', 8000),
      scope: boundedString(input.scope, 'override scope', 2000),
      expires_at: expiresAt,
      compensating_control: boundedString(
        input.compensatingControl,
        'compensating control',
        8000,
      ),
      follow_up_ref: boundedString(input.followUpRef, 'follow-up reference', 1000),
    }
    return this.createCommand({
      boardId: organization.board_id,
      kind: 'organization.quality_gate.overridden',
      input,
      fingerprint: { command: 'quality_gate.override', organizationId: organization.id, ...normalized },
      table: 'os_quality_gate_overrides',
      create: () => {
        const id = randomUUID()
        this.db.prepare(`INSERT INTO os_quality_gate_overrides
          (id, organization_id, run_id, node_key, gap, authority_role_key,
           actor_profile_id, role_activation_id, rationale, scope, expires_at,
           compensating_control, follow_up_ref, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(id, organization.id, run.id, nodeKey, normalized.gap, roleKey,
            actorProfileId, normalized.role_activation_id, normalized.rationale,
            normalized.scope, expiresAt, normalized.compensating_control,
            normalized.follow_up_ref, timestamp())
        return id
      },
    })
  }

  evaluateQualityGate(runId: string): GateEvaluation {
    const run = this.requireRecord('os_quality_gate_runs', runId, 'quality gate run')
    if (run.status !== 'running') return this.persistedGateEvaluation(run)
    const definition = this.requireRecord(
      'os_quality_gate_definitions', String(run.definition_id), 'quality gate definition',
    )
    const graph = parseJson<GateGraph>(definition.graph_json, { nodes: [] })
    const results = this.db.prepare(`SELECT * FROM os_quality_gate_results WHERE run_id=?`)
      .all(run.id) as Record<string, unknown>[]
    const byNode = new Map(results.map((result) => [String(result.node_key), result]))
    const overrides = this.db.prepare(`SELECT node_key FROM os_quality_gate_overrides
      WHERE run_id=? AND revoked_at IS NULL AND expires_at>?`).all(run.id, timestamp()) as
      Array<{ node_key: string }>
    const overridden = new Set(overrides.map((item) => item.node_key))
    const missing: string[] = []
    const failed: string[] = []
    for (const node of graph.nodes) {
      const result = byNode.get(node.key)
      if (!result) missing.push(node.key)
      else if (!['passed', 'waived'].includes(String(result.status)) && !overridden.has(node.key)) {
        failed.push(node.key)
      } else if (result.status === 'waived' && !overridden.has(node.key)) {
        failed.push(node.key)
      }
    }
    let status: GateEvaluation['status'] = 'passed'
    if (failed.length) status = 'failed'
    else if (missing.length) status = 'blocked'
    else if (overridden.size) status = 'overridden'
    const at = timestamp()
    this.db.prepare(`UPDATE os_quality_gate_runs SET status=?, completed_at=? WHERE id=?`)
      .run(status, at, run.id)
    this.events.append({
      boardId: this.organization.requireOrganization(String(run.organization_id)).board_id,
      kind: 'organization.quality_gate.evaluated',
      source: 'organization-assurance',
      payload: {
        run_id: run.id,
        status,
        missing_nodes: missing,
        failed_nodes: failed,
        overridden_nodes: [...overridden],
      },
    })
    return {
      run_id: String(run.id),
      status,
      missing_nodes: missing,
      failed_nodes: failed,
      overridden_nodes: [...overridden].sort(),
      failure_behavior: String(definition.failure_behavior) as GateEvaluation['failure_behavior'],
    }
  }

  createMetricDefinition(input: CommandInput & {
    organizationId: string
    key: string
    version: number
    dimension: ScorecardDimension
    name: string
    purpose: string
    population: string
    ownerTeamId: string
    source: string
    windowDefinition: string
    freshnessSeconds: number
    uncertaintyDefinition: string
    knownConfounders: string[]
    accessPolicy: string
    prohibitedUses: string[]
    unitOfAnalysis: 'product' | 'service' | 'team' | 'role_capability'
  }): Record<string, unknown> {
    const organization = this.organization.requireOrganization(input.organizationId)
    const ownerTeam = this.organization.requireTeam(input.ownerTeamId)
    if (ownerTeam.organization_id !== organization.id) throw new ValidationError('metric owner is outside organization')
    const key = identifier(input.key, 'metric key')
    const searchable = `${key} ${input.name} ${input.source}`.toLowerCase()
    if (ACTIVITY_VOLUME_MARKERS.some((marker) => searchable.includes(marker))) {
      throw new ForbiddenError('raw activity-volume metrics are prohibited')
    }
    const prohibited = stringList(input.prohibitedUses, 'prohibited uses')
    for (const required of ['individual_ranking', 'activity_volume_productivity']) {
      if (!prohibited.includes(required)) {
        throw new ValidationError(`metric must prohibit ${required}`)
      }
    }
    const normalized = {
      metric_key: key,
      version: positiveInteger(input.version, 'metric version'),
      dimension: scorecardDimension(input.dimension),
      name: boundedString(input.name, 'metric name', 200),
      purpose: boundedString(input.purpose, 'metric purpose', 4000),
      population: boundedString(input.population, 'metric population', 2000),
      owner_team_id: ownerTeam.id,
      source: boundedString(input.source, 'metric source', 1000),
      window_definition: boundedString(input.windowDefinition, 'window definition', 1000),
      freshness_seconds: boundedInteger(
        input.freshnessSeconds,
        'freshness seconds',
        1,
        31536000,
      ),
      uncertainty_definition: boundedString(
        input.uncertaintyDefinition,
        'uncertainty definition',
        4000,
      ),
      known_confounders: stringList(input.knownConfounders, 'known confounders'),
      access_policy: boundedString(input.accessPolicy, 'metric access policy', 1000),
      prohibited_uses: prohibited,
      unit_of_analysis: unitOfAnalysis(input.unitOfAnalysis),
    }
    return this.createCommand({
      boardId: organization.board_id,
      kind: 'organization.metric.defined',
      input,
      fingerprint: { command: 'metric.define', organizationId: organization.id, ...normalized },
      table: 'os_metric_definitions',
      create: () => {
        const id = randomUUID()
        this.db.prepare(`INSERT INTO os_metric_definitions
          (id, organization_id, metric_key, version, dimension, name, purpose,
           population, owner_team_id, source, window_definition, freshness_seconds,
           uncertainty_definition, known_confounders_json, access_policy,
           prohibited_uses_json, unit_of_analysis, status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`)
          .run(id, organization.id, key, normalized.version, normalized.dimension,
            normalized.name, normalized.purpose, normalized.population, ownerTeam.id,
            normalized.source, normalized.window_definition, normalized.freshness_seconds,
            normalized.uncertainty_definition, JSON.stringify(normalized.known_confounders),
            normalized.access_policy, JSON.stringify(prohibited), normalized.unit_of_analysis,
            timestamp())
        return id
      },
    })
  }

  createScorecard(input: CommandInput & {
    organizationId: string
    subjectKind: 'product' | 'service' | 'team' | 'role_capability'
    subjectId: string
    ownerTeamId: string
    windowStart: string
    windowEnd: string
    operatingContext: string
    confidence: 'low' | 'medium' | 'high'
  }): Record<string, unknown> {
    const organization = this.organization.requireOrganization(input.organizationId)
    const team = this.organization.requireTeam(input.ownerTeamId)
    if (team.organization_id !== organization.id) throw new ValidationError('scorecard owner is outside organization')
    const windowStart = requiredIso(input.windowStart, 'scorecard window start')
    const windowEnd = requiredIso(input.windowEnd, 'scorecard window end')
    if (windowEnd <= windowStart) throw new ValidationError('scorecard window is invalid')
    const normalized = {
      subject_kind: unitOfAnalysis(input.subjectKind),
      subject_id: boundedString(input.subjectId, 'scorecard subject id', 300),
      owner_team_id: team.id,
      window_start: windowStart,
      window_end: windowEnd,
      operating_context: boundedString(input.operatingContext, 'operating context', 8000),
      confidence: confidence(input.confidence),
    }
    return this.createCommand({
      boardId: organization.board_id,
      kind: 'organization.scorecard.created',
      input,
      fingerprint: { command: 'scorecard.create', organizationId: organization.id, ...normalized },
      table: 'os_scorecards',
      create: () => {
        const id = randomUUID()
        this.db.prepare(`INSERT INTO os_scorecards
          (id, organization_id, subject_kind, subject_id, owner_team_id,
           window_start, window_end, operating_context, confidence, status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?)`)
          .run(id, organization.id, normalized.subject_kind, normalized.subject_id,
            team.id, windowStart, windowEnd, normalized.operating_context,
            normalized.confidence, timestamp())
        return id
      },
    })
  }

  recordMetricObservation(input: CommandInput & {
    scorecardId: string
    metricDefinitionId: string
    value?: Record<string, unknown> | null
    evidenceRefs?: string[]
    uncertainty: string
    observedAt?: string
  }): Record<string, unknown> {
    const scorecard = this.requireRecord('os_scorecards', input.scorecardId, 'scorecard')
    const organization = this.organization.requireOrganization(String(scorecard.organization_id))
    if (scorecard.status !== 'draft') throw new ConflictError('scorecard is already calibrated')
    const metric = this.recordInOrganization(
      'os_metric_definitions', input.metricDefinitionId, organization.id, 'metric definition',
    )
    if (metric.status !== 'active') throw new ConflictError('metric definition is retired')
    if (metric.unit_of_analysis !== scorecard.subject_kind) {
      throw new ValidationError('metric unit does not match scorecard subject')
    }
    const evidence = stringList(input.evidenceRefs, 'metric evidence references')
    const value = input.value ? jsonRecord(input.value, 'metric value') : {}
    const status = evidence.length && Object.keys(value).length
      ? 'observed' : 'insufficient_evidence'
    const observedAt = optionalIso(input.observedAt, 'observed at') ?? timestamp()
    const expiresAt = new Date(Date.parse(observedAt) + Number(metric.freshness_seconds) * 1000)
      .toISOString()
    const normalized = {
      scorecard_id: String(scorecard.id),
      metric_definition_id: String(metric.id),
      status,
      value,
      evidence_refs: evidence,
      uncertainty: boundedString(input.uncertainty, 'metric uncertainty', 4000),
      observed_at: observedAt,
      expires_at: expiresAt,
    }
    return this.createCommand({
      boardId: organization.board_id,
      kind: 'organization.metric.observed',
      input,
      fingerprint: { command: 'metric.observe', organizationId: organization.id, ...normalized },
      table: 'os_metric_observations',
      create: () => {
        const id = randomUUID()
        this.db.prepare(`INSERT INTO os_metric_observations
          (id, organization_id, scorecard_id, metric_definition_id, status,
           value_json, evidence_refs_json, uncertainty, observed_at, expires_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(id, organization.id, scorecard.id, metric.id, status,
            JSON.stringify(value), JSON.stringify(evidence), normalized.uncertainty,
            observedAt, expiresAt)
        return id
      },
    })
  }

  calibrateScorecard(scorecardId: string, input: CommandInput): Record<string, unknown> {
    const scorecard = this.requireRecord('os_scorecards', scorecardId, 'scorecard')
    const organization = this.organization.requireOrganization(String(scorecard.organization_id))
    if (scorecard.status !== 'draft') throw new ConflictError('scorecard is already calibrated')
    return this.updateCommand({
      boardId: organization.board_id,
      kind: 'organization.scorecard.calibrated',
      input,
      fingerprint: { command: 'scorecard.calibrate', scorecardId: scorecard.id },
      resultId: String(scorecard.id),
      table: 'os_scorecards',
      update: () => {
        const observations = this.db.prepare(`SELECT COUNT(*) AS total,
          sum(CASE WHEN status='insufficient_evidence' THEN 1 ELSE 0 END) AS insufficient
          FROM os_metric_observations WHERE scorecard_id=?`).get(scorecard.id) as
          { total: number; insufficient: number }
        if (!observations.total) throw new ValidationError('scorecard requires metric observations')
        this.db.prepare(`UPDATE os_scorecards SET status='calibrated', calibrated_at=?
          WHERE id=? AND status='draft'`).run(timestamp(), scorecard.id)
      },
    })
  }

  createCalibrationReview(input: CommandInput & {
    organizationId: string
    reviewKind: 'goal' | 'capability' | 'performance'
    subjectKind: string
    subjectId: string
    windowStart: string
    windowEnd: string
    reviewerProfileId: string
    assignedGoals?: string[]
    evidenceRefs?: string[]
    operatingContext: string
    uncertainty: string
    finding: string
    confidence: 'low' | 'medium' | 'high'
    nextReviewAt: string
  }): Record<string, unknown> {
    const organization = this.organization.requireOrganization(input.organizationId)
    const reviewer = this.profileOnBoard(input.reviewerProfileId, organization.board_id)
    const subjectKind = boundedString(input.subjectKind, 'review subject kind', 120)
    const subjectId = boundedString(input.subjectId, 'review subject id', 300)
    if (subjectKind === 'agent_profile' && subjectId === reviewer) {
      throw new ForbiddenError('calibration review must be independent')
    }
    const windowStart = requiredIso(input.windowStart, 'review window start')
    const windowEnd = requiredIso(input.windowEnd, 'review window end')
    const nextReviewAt = requiredIso(input.nextReviewAt, 'next review at')
    if (windowEnd <= windowStart || nextReviewAt <= windowEnd) {
      throw new ValidationError('calibration review windows are invalid')
    }
    const evidence = stringList(input.evidenceRefs, 'review evidence references')
    const finding = evidence.length
      ? boundedString(input.finding, 'review finding', 8000)
      : 'INSUFFICIENT_EVIDENCE'
    const reviewConfidence = evidence.length ? confidence(input.confidence) : 'low'
    const normalized = {
      review_kind: calibrationKind(input.reviewKind),
      subject_kind: subjectKind,
      subject_id: subjectId,
      window_start: windowStart,
      window_end: windowEnd,
      reviewer_profile_id: reviewer,
      assigned_goals: stringList(input.assignedGoals, 'assigned goals'),
      evidence_refs: evidence,
      operating_context: boundedString(input.operatingContext, 'operating context', 8000),
      uncertainty: boundedString(input.uncertainty, 'review uncertainty', 4000),
      finding,
      confidence: reviewConfidence,
      next_review_at: nextReviewAt,
    }
    return this.createCommand({
      boardId: organization.board_id,
      kind: 'organization.calibration.completed',
      input,
      fingerprint: { command: 'calibration.create', organizationId: organization.id, ...normalized },
      table: 'os_calibration_reviews',
      create: () => {
        const id = randomUUID()
        const at = timestamp()
        this.db.prepare(`INSERT INTO os_calibration_reviews
          (id, organization_id, review_kind, subject_kind, subject_id,
           window_start, window_end, reviewer_profile_id, assigned_goals_json,
           evidence_refs_json, operating_context, uncertainty, finding, confidence,
           status, next_review_at, created_at, completed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'complete', ?, ?, ?)`)
          .run(id, organization.id, normalized.review_kind, subjectKind, subjectId,
            windowStart, windowEnd, reviewer, JSON.stringify(normalized.assigned_goals),
            JSON.stringify(evidence), normalized.operating_context, normalized.uncertainty,
            finding, reviewConfidence, nextReviewAt, at, at)
        return id
      },
    })
  }

  certifyAccess(input: CommandInput & {
    organizationId: string
    roleAssignmentId: string
    reviewerProfileId: string
    decision: 'certified' | 'revoke' | 'remediate' | 'insufficient_evidence'
    evidenceRefs?: string[]
    reason: string
    expiresAt: string
    remediationRef?: string | null
  }): Record<string, unknown> {
    const organization = this.organization.requireOrganization(input.organizationId)
    const assignment = this.recordInOrganization(
      'os_role_assignments', input.roleAssignmentId, organization.id, 'role assignment',
    )
    const reviewer = this.profileOnBoard(input.reviewerProfileId, organization.board_id)
    if (assignment.agent_profile_id === reviewer) {
      throw new ForbiddenError('access certification must be independently reviewed')
    }
    const decision = accessDecision(input.decision)
    const evidence = stringList(input.evidenceRefs, 'access certification evidence')
    if (decision !== 'insufficient_evidence' && !evidence.length) {
      throw new ValidationError('access certification decision requires evidence')
    }
    const remediationRef = optionalBoundedString(
      input.remediationRef,
      'remediation reference',
      1000,
    )
    if (decision === 'remediate' && !remediationRef) {
      throw new ValidationError('remediation decision requires remediation reference')
    }
    const reviewedAt = timestamp()
    const expiresAt = requiredIso(input.expiresAt, 'access certification expiry')
    if (expiresAt <= reviewedAt) throw new ValidationError('access certification must expire in future')
    const normalized = {
      role_assignment_id: String(assignment.id),
      reviewer_profile_id: reviewer,
      decision,
      evidence_refs: evidence,
      reason: boundedString(input.reason, 'access certification reason', 8000),
      reviewed_at: reviewedAt,
      expires_at: expiresAt,
      remediation_ref: remediationRef,
    }
    return this.createCommand({
      boardId: organization.board_id,
      kind: 'organization.access.certified',
      input,
      fingerprint: { command: 'access.certify', organizationId: organization.id, ...normalized },
      table: 'os_access_certifications',
      create: () => {
        const id = randomUUID()
        this.db.prepare(`INSERT INTO os_access_certifications
          (id, organization_id, role_assignment_id, reviewer_profile_id, decision,
           evidence_refs_json, reason, reviewed_at, expires_at, remediation_ref)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(id, organization.id, assignment.id, reviewer, decision,
            JSON.stringify(evidence), normalized.reason, reviewedAt, expiresAt,
            remediationRef)
        if (decision === 'revoke') {
          this.db.prepare(`UPDATE os_role_assignments SET status='revoked',
            revoked_at=?, updated_at=? WHERE id=? AND status IN ('active','suspended')`)
            .run(reviewedAt, reviewedAt, assignment.id)
          this.db.prepare(`UPDATE os_role_activations SET status='revoked', ended_at=?,
            end_reason='access certification revoked' WHERE role_assignment_id=? AND status='active'`)
            .run(reviewedAt, assignment.id)
        }
        return id
      },
    })
  }

  fileReviewAppeal(input: CommandInput & {
    organizationId: string
    reviewKind: 'calibration' | 'access'
    reviewId: string
    appellantProfileId: string
    grounds: string
    evidenceRefs: string[]
  }): Record<string, unknown> {
    const organization = this.organization.requireOrganization(input.organizationId)
    const reviewKind = appealReviewKind(input.reviewKind)
    const table = reviewKind === 'calibration'
      ? 'os_calibration_reviews' : 'os_access_certifications'
    this.recordInOrganization(table, input.reviewId, organization.id, 'review')
    const normalized = {
      review_kind: reviewKind,
      review_id: boundedString(input.reviewId, 'review id', 300),
      appellant_profile_id: this.profileOnBoard(input.appellantProfileId, organization.board_id),
      grounds: boundedString(input.grounds, 'appeal grounds', 8000),
      evidence_refs: nonEmptyStringList(input.evidenceRefs, 'appeal evidence references'),
    }
    return this.createCommand({
      boardId: organization.board_id,
      kind: 'organization.review.appealed',
      input,
      fingerprint: { command: 'review.appeal', organizationId: organization.id, ...normalized },
      table: 'os_review_appeals',
      create: () => {
        const id = randomUUID()
        this.db.prepare(`INSERT INTO os_review_appeals
          (id, organization_id, review_kind, review_id, appellant_profile_id,
           grounds, evidence_refs_json, status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)`)
          .run(id, organization.id, reviewKind, normalized.review_id,
            normalized.appellant_profile_id, normalized.grounds,
            JSON.stringify(normalized.evidence_refs), timestamp())
        return id
      },
    })
  }

  resolveReviewAppeal(id: string, input: CommandInput & {
    status: 'upheld' | 'modified' | 'rejected'
    independentReviewerProfileId: string
    resolution: string
  }): Record<string, unknown> {
    const appeal = this.requireRecord('os_review_appeals', id, 'review appeal')
    const organization = this.organization.requireOrganization(String(appeal.organization_id))
    if (appeal.status !== 'open') throw new ConflictError('review appeal is terminal')
    const reviewer = this.profileOnBoard(input.independentReviewerProfileId, organization.board_id)
    if (reviewer === appeal.appellant_profile_id) {
      throw new ForbiddenError('appeal reviewer must be independent')
    }
    const status = appealStatus(input.status)
    const resolution = boundedString(input.resolution, 'appeal resolution', 8000)
    return this.updateCommand({
      boardId: organization.board_id,
      kind: 'organization.review.appeal_resolved',
      input,
      fingerprint: { command: 'review.appeal.resolve', appealId: appeal.id, status, reviewer, resolution },
      resultId: String(appeal.id),
      table: 'os_review_appeals',
      update: () => {
        this.db.prepare(`UPDATE os_review_appeals SET status=?,
          independent_reviewer_profile_id=?, resolution=?, resolved_at=?
          WHERE id=? AND status='open'`)
          .run(status, reviewer, resolution, timestamp(), appeal.id)
      },
    })
  }

  openIncident(input: CommandInput & {
    organizationId: string
    key: string
    serviceOwnershipId: string
    severity: 'SEV0' | 'SEV1' | 'SEV2' | 'SEV3'
    summary: string
    impact: string
    errorBudgetConsumed: number
    commanderProfileId: string
    startedAt: string
    detectedAt: string
    evidenceRefs: string[]
  }): Record<string, unknown> {
    const organization = this.organization.requireOrganization(input.organizationId)
    const ownership = this.recordInOrganization(
      'os_team_ownerships', input.serviceOwnershipId, organization.id, 'service ownership',
    )
    if (ownership.resource_kind !== 'service' || ownership.effective_until !== null) {
      throw new ValidationError('incident requires current service ownership')
    }
    const startedAt = requiredIso(input.startedAt, 'incident start')
    const detectedAt = requiredIso(input.detectedAt, 'incident detection')
    if (detectedAt < startedAt) throw new ValidationError('incident detection precedes start')
    const commander = this.profileOnBoard(input.commanderProfileId, organization.board_id)
    const evidence = nonEmptyStringList(input.evidenceRefs, 'incident evidence references')
    const normalized = {
      incident_key: identifier(input.key, 'incident key'),
      service_ownership_id: String(ownership.id),
      severity: incidentSeverity(input.severity),
      summary: boundedString(input.summary, 'incident summary', 8000),
      impact: boundedString(input.impact, 'incident impact', 8000),
      error_budget_consumed: nonNegativeNumber(
        input.errorBudgetConsumed,
        'error budget consumed',
      ),
      commander_profile_id: commander,
      started_at: startedAt,
      detected_at: detectedAt,
      evidence_refs: evidence,
    }
    return this.createCommand({
      boardId: organization.board_id,
      kind: 'organization.incident.opened',
      input,
      fingerprint: { command: 'incident.open', organizationId: organization.id, ...normalized },
      table: 'os_incidents',
      create: () => {
        const id = randomUUID()
        const at = timestamp()
        this.db.prepare(`INSERT INTO os_incidents
          (id, organization_id, incident_key, service_ownership_id, severity,
           status, summary, impact, error_budget_consumed, commander_profile_id,
           started_at, detected_at, created_at)
          VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?)`)
          .run(id, organization.id, normalized.incident_key, ownership.id,
            normalized.severity, normalized.summary, normalized.impact,
            normalized.error_budget_consumed, commander, startedAt, detectedAt, at)
        this.db.prepare(`INSERT INTO os_incident_timeline
          (id, organization_id, incident_id, event_kind, summary,
           evidence_refs_json, actor_profile_id, occurred_at, created_at)
          VALUES (?, ?, ?, 'detected', ?, ?, ?, ?, ?)`)
          .run(randomUUID(), organization.id, id, normalized.summary,
            JSON.stringify(evidence), commander, detectedAt, at)
        return id
      },
    })
  }

  addIncidentTimeline(input: CommandInput & {
    incidentId: string
    eventKind: 'investigated' | 'decision' | 'mitigation' | 'contained' | 'recovered'
    summary: string
    evidenceRefs: string[]
    actorProfileId: string
    occurredAt: string
  }): Record<string, unknown> {
    const incident = this.requireRecord('os_incidents', input.incidentId, 'incident')
    const organization = this.organization.requireOrganization(String(incident.organization_id))
    if (['resolved', 'closed'].includes(String(incident.status))) {
      throw new ConflictError('incident is terminal')
    }
    const kind = incidentTimelineKind(input.eventKind)
    const occurredAt = requiredIso(input.occurredAt, 'timeline occurrence')
    const normalized = {
      incident_id: String(incident.id),
      event_kind: kind,
      summary: boundedString(input.summary, 'timeline summary', 8000),
      evidence_refs: nonEmptyStringList(input.evidenceRefs, 'timeline evidence references'),
      actor_profile_id: this.profileOnBoard(input.actorProfileId, organization.board_id),
      occurred_at: occurredAt,
    }
    return this.createCommand({
      boardId: organization.board_id,
      kind: 'organization.incident.timeline_added',
      input,
      fingerprint: { command: 'incident.timeline.add', organizationId: organization.id, ...normalized },
      table: 'os_incident_timeline',
      create: () => {
        const id = randomUUID()
        const at = timestamp()
        this.db.prepare(`INSERT INTO os_incident_timeline
          (id, organization_id, incident_id, event_kind, summary,
           evidence_refs_json, actor_profile_id, occurred_at, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(id, organization.id, incident.id, kind, normalized.summary,
            JSON.stringify(normalized.evidence_refs), normalized.actor_profile_id,
            occurredAt, at)
        if (kind === 'contained') {
          this.db.prepare(`UPDATE os_incidents SET status='contained', contained_at=?
            WHERE id=? AND status='open'`).run(occurredAt, incident.id)
        }
        return id
      },
    })
  }

  resolveIncident(id: string, input: CommandInput & {
    summary: string
    evidenceRefs: string[]
    actorProfileId: string
    resolvedAt: string
  }): Record<string, unknown> {
    const incident = this.requireRecord('os_incidents', id, 'incident')
    const organization = this.organization.requireOrganization(String(incident.organization_id))
    if (!['open', 'contained'].includes(String(incident.status))) {
      throw new ConflictError('incident is terminal')
    }
    const resolvedAt = requiredIso(input.resolvedAt, 'incident resolution time')
    const actorProfileId = this.profileOnBoard(input.actorProfileId, organization.board_id)
    const summary = boundedString(input.summary, 'incident resolution summary', 8000)
    const evidence = nonEmptyStringList(input.evidenceRefs, 'incident recovery evidence')
    return this.updateCommand({
      boardId: organization.board_id,
      kind: 'organization.incident.resolved',
      input,
      fingerprint: {
        command: 'incident.resolve', incidentId: incident.id, resolvedAt,
        actorProfileId, summary, evidence,
      },
      resultId: String(incident.id),
      table: 'os_incidents',
      update: () => {
        const containedAt = incident.contained_at ?? resolvedAt
        this.db.prepare(`UPDATE os_incidents SET status='resolved', contained_at=?,
          resolved_at=? WHERE id=? AND status IN ('open','contained')`)
          .run(containedAt, resolvedAt, incident.id)
        this.db.prepare(`INSERT INTO os_incident_timeline
          (id, organization_id, incident_id, event_kind, summary,
           evidence_refs_json, actor_profile_id, occurred_at, created_at)
          VALUES (?, ?, ?, 'resolved', ?, ?, ?, ?, ?)`)
          .run(randomUUID(), organization.id, incident.id, summary,
            JSON.stringify(evidence), actorProfileId, resolvedAt, timestamp())
      },
    })
  }

  createPostmortem(input: CommandInput & {
    incidentId: string
    authorProfileId: string
    reviewerProfileId: string
    summary: string
    causalAnalysis: Record<string, unknown>
    impactAnalysis: string
    containmentEvidenceRefs: string[]
    recoveryEvidenceRefs: string[]
    lessons: Array<{ key: string; content: string }>
  }): Record<string, unknown> {
    const incident = this.requireRecord('os_incidents', input.incidentId, 'incident')
    const organization = this.organization.requireOrganization(String(incident.organization_id))
    if (incident.status !== 'resolved') throw new ConflictError('postmortem requires resolved incident')
    const author = this.profileOnBoard(input.authorProfileId, organization.board_id)
    const reviewer = this.profileOnBoard(input.reviewerProfileId, organization.board_id)
    if (author === reviewer) throw new ForbiddenError('postmortem requires independent reviewer')
    if (!Array.isArray(input.lessons) || !input.lessons.length) {
      throw new ValidationError('postmortem requires reusable lessons')
    }
    const lessons = input.lessons.map((lesson) => ({
      key: identifier(lesson.key, 'lesson key'),
      content: boundedString(lesson.content, 'lesson content', 12000),
    }))
    const normalized = {
      incident_id: String(incident.id),
      author_profile_id: author,
      reviewer_profile_id: reviewer,
      summary: boundedString(input.summary, 'postmortem summary', 12000),
      causal_analysis: jsonRecord(input.causalAnalysis, 'causal analysis'),
      impact_analysis: boundedString(input.impactAnalysis, 'impact analysis', 12000),
      containment_evidence_refs: nonEmptyStringList(
        input.containmentEvidenceRefs,
        'containment evidence references',
      ),
      recovery_evidence_refs: nonEmptyStringList(
        input.recoveryEvidenceRefs,
        'recovery evidence references',
      ),
      lessons,
    }
    return this.createCommand({
      boardId: organization.board_id,
      kind: 'organization.postmortem.created',
      input,
      fingerprint: { command: 'postmortem.create', organizationId: organization.id, ...normalized },
      table: 'os_postmortems',
      create: () => {
        const id = randomUUID()
        this.db.prepare(`INSERT INTO os_postmortems
          (id, organization_id, incident_id, author_profile_id, reviewer_profile_id,
           blameless, summary, causal_analysis_json, impact_analysis,
           containment_evidence_refs_json, recovery_evidence_refs_json, lessons_json,
           status, created_at)
          VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, 'draft', ?)`)
          .run(id, organization.id, incident.id, author, reviewer, normalized.summary,
            JSON.stringify(normalized.causal_analysis), normalized.impact_analysis,
            JSON.stringify(normalized.containment_evidence_refs),
            JSON.stringify(normalized.recovery_evidence_refs), JSON.stringify(lessons),
            timestamp())
        return id
      },
    })
  }

  reviewPostmortem(id: string, input: CommandInput & {
    reviewerProfileId: string
  }): Record<string, unknown> {
    const postmortem = this.requireRecord('os_postmortems', id, 'postmortem')
    const organization = this.organization.requireOrganization(String(postmortem.organization_id))
    const reviewer = this.profileOnBoard(input.reviewerProfileId, organization.board_id)
    if (postmortem.reviewer_profile_id !== reviewer) {
      throw new ForbiddenError('only assigned independent reviewer may review postmortem')
    }
    return this.updateCommand({
      boardId: organization.board_id,
      kind: 'organization.postmortem.reviewed',
      input,
      fingerprint: { command: 'postmortem.review', postmortemId: postmortem.id, reviewer },
      resultId: String(postmortem.id),
      table: 'os_postmortems',
      update: () => {
        this.db.prepare(`UPDATE os_postmortems SET status='reviewed', reviewed_at=?
          WHERE id=? AND status='draft'`).run(timestamp(), postmortem.id)
      },
    })
  }

  createCorrectiveAction(input: CommandInput & {
    postmortemId: string
    actionKind: 'corrective' | 'preventive'
    description: string
    ownerTeamId: string
    ownerProfileId: string
    dueAt: string
  }): Record<string, unknown> {
    const postmortem = this.requireRecord('os_postmortems', input.postmortemId, 'postmortem')
    const organization = this.organization.requireOrganization(String(postmortem.organization_id))
    if (postmortem.status !== 'reviewed') {
      throw new ConflictError('corrective action requires reviewed postmortem')
    }
    const team = this.organization.requireTeam(input.ownerTeamId)
    if (team.organization_id !== organization.id) throw new ValidationError('action owner team is outside organization')
    const dueAt = requiredIso(input.dueAt, 'corrective action due date')
    if (dueAt <= timestamp()) throw new ValidationError('corrective action due date must be future')
    const normalized = {
      postmortem_id: String(postmortem.id),
      action_kind: correctiveActionKind(input.actionKind),
      description: boundedString(input.description, 'corrective action description', 8000),
      owner_team_id: team.id,
      owner_profile_id: this.profileOnBoard(input.ownerProfileId, organization.board_id),
      due_at: dueAt,
    }
    return this.createCommand({
      boardId: organization.board_id,
      kind: 'organization.corrective_action.created',
      input,
      fingerprint: { command: 'corrective_action.create', organizationId: organization.id, ...normalized },
      table: 'os_corrective_actions',
      create: () => {
        const id = randomUUID()
        this.db.prepare(`INSERT INTO os_corrective_actions
          (id, organization_id, postmortem_id, action_kind, description,
           owner_team_id, owner_profile_id, due_at, status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`)
          .run(id, organization.id, postmortem.id, normalized.action_kind,
            normalized.description, team.id, normalized.owner_profile_id, dueAt, timestamp())
        return id
      },
    })
  }

  verifyCorrectiveAction(id: string, input: CommandInput & {
    verificationRef: string
  }): Record<string, unknown> {
    const action = this.requireRecord('os_corrective_actions', id, 'corrective action')
    const organization = this.organization.requireOrganization(String(action.organization_id))
    if (action.status !== 'open') throw new ConflictError('corrective action is terminal')
    const verificationRef = boundedString(input.verificationRef, 'verification reference', 1000)
    return this.updateCommand({
      boardId: organization.board_id,
      kind: 'organization.corrective_action.verified',
      input,
      fingerprint: { command: 'corrective_action.verify', actionId: action.id, verificationRef },
      resultId: String(action.id),
      table: 'os_corrective_actions',
      update: () => {
        this.db.prepare(`UPDATE os_corrective_actions SET status='verified',
          verification_ref=?, completed_at=? WHERE id=? AND status='open'`)
          .run(verificationRef, timestamp(), action.id)
      },
    })
  }

  promotePostmortemLesson(input: CommandInput & {
    postmortemId: string
    lessonKey: string
    reviewerProfileId: string
  }): Record<string, unknown> {
    const postmortem = this.requireRecord('os_postmortems', input.postmortemId, 'postmortem')
    const organization = this.organization.requireOrganization(String(postmortem.organization_id))
    if (postmortem.status !== 'reviewed') throw new ConflictError('lesson requires reviewed postmortem')
    const reviewer = this.profileOnBoard(input.reviewerProfileId, organization.board_id)
    const lessonKey = identifier(input.lessonKey, 'lesson key')
    const lessons = parseJson<Array<{ key: string; content: string }>>(postmortem.lessons_json, [])
    const lesson = lessons.find((candidate) => candidate.key === lessonKey)
    if (!lesson) throw new NotFoundError('postmortem lesson not found')
    const content = boundedString(lesson.content, 'lesson content', 12000)
    const lessonDigest = rawSha256(content)
    const normalized = {
      postmortem_id: String(postmortem.id),
      lesson_key: lessonKey,
      lesson_sha256: lessonDigest,
      reviewer_profile_id: reviewer,
    }
    return this.createCommand({
      boardId: organization.board_id,
      kind: 'organization.knowledge.promoted',
      input,
      fingerprint: { command: 'knowledge.promote', organizationId: organization.id, ...normalized },
      table: 'os_knowledge_promotions',
      create: () => {
        const at = timestamp()
        const locator = `incident://${postmortem.incident_id}/postmortem/${postmortem.id}/${lessonKey}`
        const sourceId = knowledgeSourceId({
          repository_key: `organization-${organization.id}`,
          source_kind: 'gotcha',
          normalized_locator: locator,
          source_revision: String(postmortem.id),
          content_sha256: lessonDigest,
        })
        const source: KnowledgeSource = {
          id: sourceId,
          source_kind: 'gotcha',
          trust_class: 'reference',
          title: `Incident lesson: ${lessonKey}`,
          locator,
          normalized_locator: locator,
          source_revision: String(postmortem.id),
          content_sha256: lessonDigest,
          freshness_policy: 'manual_until_superseded',
          freshness_state: 'fresh',
          redaction_state: 'none',
          content_state: 'present',
          ingest_state: 'active',
          access_scope: { kind: 'board' },
          targets: {
            board_id: organization.board_id,
            workspace_id: null,
            card_id: null,
            contract_ref: null,
            contract_version: null,
            contract_snapshot_sha256: null,
            job_id: null,
            profile_id: null,
            session_id: null,
            delivery_report_id: null,
          },
          provenance: {
            repository_key: `organization-${organization.id}`,
            base_commit_sha: lessonDigest,
            worktree_state_hash: null,
            relative_root: '.',
            adapter_id: 'organization-assurance',
            adapter_version: '1',
            adapter_index_commit_sha: null,
            observed_at: at,
          },
          created_at: at,
          updated_at: at,
        }
        this.knowledge.putSource(source)
        const sourceRange = {
          start_line: 1,
          end_line: content.split('\n').length,
          start_byte: 0,
          end_byte: Buffer.byteLength(content, 'utf8'),
        }
        const chunk: KnowledgeChunk = {
          id: knowledgeChunkId({
            source_id: sourceId,
            ordinal: 0,
            content_sha256: lessonDigest,
            source_range: sourceRange,
          }),
          source_id: sourceId,
          ordinal: 0,
          content,
          content_sha256: lessonDigest,
          character_count: content.length,
          byte_count: Buffer.byteLength(content, 'utf8'),
          estimated_tokens: Math.ceil(content.length / 4),
          source_range: sourceRange,
          symbol: null,
          created_at: at,
        }
        this.knowledge.putChunk(organization.board_id, chunk)
        const id = randomUUID()
        this.db.prepare(`INSERT INTO os_knowledge_promotions
          (id, organization_id, board_id, postmortem_id, lesson_key, lesson_sha256,
           knowledge_source_id, reviewer_profile_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(id, organization.id, organization.board_id, postmortem.id, lessonKey, lessonDigest,
            sourceId, reviewer, at)
        return id
      },
    })
  }

  dashboard(organizationId: string): OrganizationDashboard {
    const organization = this.organization.requireOrganization(organizationId)
    const now = timestamp()
    const count = (sql: string): number => Number((this.db.prepare(sql)
      .get(organization.id, now) as { count: number }).count)
    return {
      organization_id: organization.id,
      scorecards: this.db.prepare(`SELECT * FROM os_scorecards
        WHERE organization_id=? ORDER BY window_end DESC`).all(organization.id) as Record<string, unknown>[],
      incidents: this.db.prepare(`SELECT * FROM os_incidents
        WHERE organization_id=? ORDER BY started_at DESC`).all(organization.id) as Record<string, unknown>[],
      overdue_corrective_actions: this.db.prepare(`SELECT * FROM os_corrective_actions
        WHERE organization_id=? AND status='open' AND due_at<? ORDER BY due_at`)
        .all(organization.id, now) as Record<string, unknown>[],
      stale_metric_observations: count(`SELECT COUNT(*) AS count FROM os_metric_observations
        WHERE organization_id=? AND expires_at<?`),
      overdue_access_certifications: count(`SELECT COUNT(*) AS count FROM os_access_certifications
        WHERE organization_id=? AND expires_at<?`),
      open_appeals: count(`SELECT COUNT(*) AS count FROM os_review_appeals
        WHERE organization_id=? AND status='open' AND ? IS NOT NULL`),
      insufficient_evidence_observations: count(`SELECT COUNT(*) AS count FROM os_metric_observations
        WHERE organization_id=? AND status='insufficient_evidence' AND ? IS NOT NULL`),
    }
  }

  private persistedGateEvaluation(run: Record<string, unknown>): GateEvaluation {
    const definition = this.requireRecord(
      'os_quality_gate_definitions', String(run.definition_id), 'quality gate definition',
    )
    return {
      run_id: String(run.id),
      status: String(run.status) as GateEvaluation['status'],
      missing_nodes: [],
      failed_nodes: [],
      overridden_nodes: [],
      failure_behavior: String(definition.failure_behavior) as GateEvaluation['failure_behavior'],
    }
  }

  private requireValidControlApproval(
    id: string,
    organizationId: string,
    subjectKind: string,
    subjectId: string,
    artifactSha256: string,
  ): void {
    const approval = this.recordInOrganization(
      'os_control_approvals', id, organizationId, 'control approval',
    )
    if (approval.subject_kind !== subjectKind || approval.subject_id !== subjectId
      || approval.artifact_sha256 !== artifactSha256 || approval.decision !== 'approved'
      || approval.revoked_at !== null || String(approval.expires_at) <= timestamp()) {
      throw new ForbiddenError('control approval is not valid for quality gate subject')
    }
  }

  private traceReachable(from: string, to: string, organizationId: string): boolean {
    return this.tracePath(from, to, organizationId).length > 0
  }

  private tracePath(from: string, to: string, organizationId: string): string[] {
    const queue: Array<{ id: string; path: string[] }> = [{ id: from, path: [from] }]
    const visited = new Set<string>()
    while (queue.length) {
      const current = queue.shift()
      if (!current || visited.has(current.id)) continue
      if (current.id === to) return current.path
      visited.add(current.id)
      const next = this.db.prepare(`SELECT to_node_id FROM os_trace_edges
        WHERE organization_id=? AND from_node_id=? ORDER BY created_at, id`)
        .all(organizationId, current.id) as Array<{ to_node_id: string }>
      for (const edge of next) queue.push({ id: edge.to_node_id, path: [...current.path, edge.to_node_id] })
    }
    return []
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
        source: 'organization-assurance',
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
        source: 'organization-assurance',
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
      throw new ConflictError('idempotency key was used for a different assurance command')
    }
    return payload.result_id
  }

  private load<T>(table: string, id: string, map?: (row: Record<string, unknown>) => T): T {
    const row = this.requireRecord(table, id, 'assurance record')
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

  private profileOnBoard(profileId: string, boardId: number): string {
    const id = boundedString(profileId, 'agent profile id', 200)
    const profile = this.db.prepare('SELECT board_id, status FROM agent_profiles WHERE id=?')
      .get(id) as { board_id: number; status: string } | undefined
    if (!profile || profile.board_id !== boardId || profile.status !== 'active') {
      throw new NotFoundError('active agent profile not found on organization board')
    }
    return id
  }
}
