import { api } from './api'

export type OsId = number | string
export type JsonObject = Record<string, unknown>

export type Workspace = {
  id: OsId
  board_id: number
  card_id: number | null
  name: string
  kind: 'shared' | 'worktree' | string
  root_path: string
  worktree_path: string | null
  branch: string | null
  base_ref: string | null
  status: 'creating' | 'ready' | 'running' | 'stopped' | 'lost' | 'archived' | string
  env_json?: string | JsonObject | null
  created_at: string
  updated_at: string
}

export type AgentSession = {
  id: OsId
  workspace_id: OsId
  agent_id: number | null
  provider: string
  external_id: string | null
  model: string | null
  status: string
  context?: JsonObject
  context_json?: string | JsonObject | null
  job_id?: OsId | null
  workspace_assignment_id?: OsId | null
  profile_id?: OsId | null
  conversation_id?: OsId | null
  job_assignment_id?: OsId | null
  assigned_profile_id?: OsId | null
  assignment_market_version?: number | null
  created_at: string
  updated_at: string
}

export type WorkspaceProcess = {
  id: OsId
  workspace_id: OsId
  name: string
  command: string
  cwd: string
  status: 'starting' | 'running' | 'exited' | 'failed' | 'stopped' | 'lost' | string
  pid: number | null
  exit_code: number | null
  cols: number
  rows: number
  restartable: boolean | number
  started_at: string | null
  ended_at: string | null
  ports?: number[]
}

export type ProcessOutput = {
  process_id: OsId
  seq: number
  stream: 'pty' | 'stdout' | 'stderr' | string
  data: string
  created_at: string
}

export type ContractPromise = string | {
  id?: string
  text: string
  required?: boolean
  deliverable_ids?: string[]
  metadata?: JsonObject
  met?: boolean | 'unverifiable'
  evidence?: string
}

export type AcceptanceCriterion = ContractPromise

export type TaskContract = {
  card_id: number
  objective: string
  deliverables?: ContractPromise[] | string
  acceptance_criteria: AcceptanceCriterion[] | string
  dependencies: Array<number | string> | string
  base_ref: string | null
  verify_commands: string[] | string
  non_goals?: string[] | string
  risks?: string[] | string
  budget_tokens: number | null
  budget_cents: number | null
  priority: number
  policy_id: OsId | null
  workspace_id: OsId | null
  version?: number
  updated_at: string
}

export type OsEvent = {
  id: OsId
  board_id: number
  workspace_id: OsId | null
  card_id: number | null
  session_id: OsId | null
  process_id: OsId | null
  job_id?: OsId | null
  contract_id?: OsId | null
  correlation_id?: OsId | null
  causation_id?: OsId | null
  idempotency_key?: string | null
  event_version?: number
  version?: number
  kind: string
  source: string
  payload: string | JsonObject | null
  created_at: string
}

export type Artifact = {
  id: OsId
  board_id: number
  workspace_id: OsId | null
  card_id: number | null
  kind: string
  name: string
  mime_type: string | null
  path: string | null
  content: string | null
  metadata: string | JsonObject | null
  created_at: string
}

export type EvidenceBundle = {
  card_id?: number
  card?: { id: number; board_id: number; title: string; description?: string; column?: string }
  contract?: TaskContract | null
  workspace?: Workspace | null
  generated_at?: string
  artifacts?: Artifact[]
  diff?: string | { artifact_id?: OsId; name?: string; content?: string | null; path?: string | null } | null
  diffstat?: string | { artifact_id?: OsId; content?: string | null } | null
  changed_files?: Array<string | { path: string; insertions?: number; deletions?: number }>
  verification?: { artifacts?: Artifact[]; events?: OsEvent[] } | JsonObject | null
  review?: JsonObject | null
  reviews?: JsonObject[]
  process_exits?: Array<{ id: OsId; name: string; command: string; status: string; exit_code: number | null; ended_at: string | null }>
  shipped_commit?: string | null
  shipped?: Array<{ source?: string; created_at?: string; detail?: unknown }>
  claims?: Array<string | { source?: string; created_at?: string; claim?: unknown }>
  gaps?: string[]
  events?: OsEvent[]
  [key: string]: unknown
}

export type DeliveryEvidence = string | JsonObject

export type DeliveryOverride = {
  actor: string | null
  reason: string | null
  created_at: string | null
}

export type DeliveryPromise = {
  id: string | null
  text: string
  required: boolean
  deliverable_ids: string[]
  metadata: JsonObject
}

export type DeliveryOutcome = DeliveryPromise & {
  status: string
  evidence: DeliveryEvidence[]
  gaps: string[]
  override: DeliveryOverride | null
  claim: string | null
  note: string | null
  actor: string | null
  created_at: string | null
  updated_at: string | null
}

export type DeliveryClaim = {
  text: string
  source: string | null
  created_at: string | null
}

export type DeliveryAskedSnapshot = {
  objective: string
  deliverables: DeliveryPromise[]
  acceptance_criteria: DeliveryPromise[]
  non_goals: string[]
  risks: string[]
  verify_commands: string[]
  dependencies: OsId[]
  base_ref: string | null
  budget_tokens: number | null
  budget_cents: number | null
  priority: number
  policy_id: OsId | null
  version: string | number | null
  updated_at: string | null
}

export type DeliveryReport = {
  id: OsId
  lineage_id: OsId | null
  card_id: number | null
  contract_id: OsId | null
  job_id: OsId | null
  session_id: OsId | null
  workspace_id: OsId | null
  status: string
  asked: DeliveryAskedSnapshot
  summary: string
  human_summary: string | null
  delivered_items: DeliveryOutcome[]
  deliverable_results: DeliveryOutcome[]
  criterion_results: DeliveryOutcome[]
  changed_files: string[]
  commits: string[]
  artifact_ids: OsId[]
  claims: DeliveryClaim[]
  gaps: string[]
  parent_delivery_id: OsId | null
  sequence: number
  actor_type: string | null
  actor_id: OsId | null
  created_by: string | null
  submitted_by: string | null
  verified_by: string | null
  accepted_by: string | null
  rejected_by: string | null
  acceptance_note: string | null
  rejection_reason: string | null
  created_at: string
  updated_at: string
  submitted_at: string | null
  verified_at: string | null
  reviewed_at: string | null
  accepted_at: string | null
  rejected_at: string | null
  shipped_at: string | null
}

export type DeliveryCollection = {
  deliveries: DeliveryReport[]
  current: DeliveryReport | null
}

export type Policy = {
  id: OsId
  board_id: number
  name: string
  file_globs: string[] | string
  command_globs: string[] | string
  network_hosts: string[] | string
  secret_names: string[] | string
  approval_scope: 'advisory' | 'ask' | 'allow' | 'deny' | string
  created_at: string
  updated_at: string
}

export type PolicyDecision = {
  decision: 'allow' | 'ask' | 'deny'
  reason: string
  policy_id?: OsId
}

export type AttentionItem = {
  id: OsId
  board_id: number
  workspace_id: OsId | null
  card_id: number | null
  agent_id: number | null
  kind: string
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info' | string
  title: string
  detail: string | null
  status: 'open' | 'resolved' | string
  created_at: string
  resolved_at: string | null
}

export type Checkpoint = {
  id: OsId
  workspace_id: OsId
  session_id: OsId | null
  name: string
  git_head: string | null
  patch_artifact_id: OsId | null
  context_json: string | JsonObject | null
  process_recipes: string | JsonObject | null
  created_at: string
}

export type AgentAccessProfile = 'read_only' | 'workspace_write' | 'full_access'

export type Job = {
  id: OsId
  board_id: number
  card_id: number | null
  workspace_id: OsId | null
  provider: string
  driver_id?: string
  model: string | null
  effort?: string | null
  access_profile?: AgentAccessProfile | null
  policy_id?: OsId | null
  contract_version?: number | null
  idempotency_key?: string | null
  job_assignment_id?: OsId | null
  assigned_profile_id?: OsId | null
  assignment_market_version?: number | null
  priority: number
  status: string
  attempts: number
  max_attempts: number
  budget_tokens: number | null
  budget_cents: number | null
  spent_tokens?: number
  spent_cents?: number
  scheduled_at: string
  started_at: string | null
  finished_at: string | null
  error: string | null
  created_at?: string
}

export type SchedulerDispatch = {
  started: OsId[]
  completed: OsId[]
  blocked: OsId[]
  deferred: OsId[]
}

export type OrchestrationIdentity = {
  lifecycle: 'canonical' | 'ambient' | 'legacy' | 'external'
  contract_attached: boolean
  job_id: OsId | null
  workspace_id: OsId | null
  session_id: OsId | null
  job_assignment_id: OsId | null
  assigned_profile_id: OsId | null
  assignment_market_version: number | null
  assignment_id?: OsId | null
  workspace_assignment_id?: OsId | null
  contract_id?: OsId | null
  contract_version?: number | null
  correlation_id?: OsId | null
  idempotency_key?: string | null
}

/** Exact durable lifecycle returned by canonical Board, API, and CLI launch entrypoints. */
export type CanonicalLifecycleSnapshot = {
  mode: 'canonical'
  orchestration: OrchestrationIdentity
  contract: TaskContract
  delivery: DeliveryReport
  job: Job
  workspace: Workspace
  session: AgentSession
  dispatch: SchedulerDispatch
  dispatch_error: string | null
}

/** Exact durable lifecycle read model, keyed by one canonical job. */
export type CanonicalLifecycleRecord = Omit<CanonicalLifecycleSnapshot, 'dispatch' | 'dispatch_error'> & {
  events: OsEvent[]
}

export type ContextItem = {
  id: OsId
  board_id: number
  workspace_id: OsId
  card_id: number | null
  kind: string
  source: string
  content: string
  tokens: number
  pinned: boolean | number
  provenance: string | JsonObject | null
  created_at: string
  updated_at: string
}

export type WorkspaceConflict = {
  id?: OsId
  board_id?: number
  workspace_id?: OsId
  other_workspace_id?: OsId
  workspace_ids?: [OsId, OsId]
  card_id?: number | null
  kind: string
  severity?: string
  paths?: string[]
  detail?: string
  [key: string]: unknown
}

export type DriverCapability = {
  id: string
  name?: string
  available?: boolean
  capabilities?: string[] | JsonObject
  [key: string]: unknown
}

export type AgentProviderModel = {
  value: string
  resolvedModel?: string
  displayName: string
  description: string
  supportsEffort?: boolean
  supportedEffortLevels?: AgentEffort[]
  supportsAdaptiveThinking?: boolean
  supportsFastMode?: boolean
  supportsAutoMode?: boolean
}

export type AgentProviderCatalog = {
  id: string
  name: string
  available: boolean
  capabilities?: string[] | Record<string, boolean>
  auth_state?: 'authenticated' | 'unauthenticated' | 'unavailable' | string
  auth?: {
    status: 'authenticated' | 'unauthenticated' | 'unknown' | string
    updated_at: string
    account?: string
    detail?: string
  }
  health?: {
    available: boolean
    status: 'ready' | 'degraded' | 'unavailable' | string
    updated_at: string
    version?: string
    detail?: string
  } | 'ready' | 'degraded' | 'unavailable' | string
  usage?: {
    updated_at: string
    stale?: boolean
    rate_limits?: unknown
    usage?: unknown
    detail?: string
  }
  usage_health?: 'live' | 'stale' | 'unavailable' | string
  rate_limit_health?: 'live' | 'stale' | 'unavailable' | string
  models: AgentProviderModel[]
  source: 'live' | 'cache' | 'unavailable'
  updated_at: string | null
  detail?: string
}

export type PluginDescriptor = {
  id: string
  name?: string
  version?: string
  enabled?: boolean
  [key: string]: unknown
}

export const AGENT_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type AgentEffort = string
export type AgentDefaultProfile = { provider: string; model: string | null; effort: AgentEffort | null }
export type AgentDefaults = { worker: AgentDefaultProfile; specialist: AgentDefaultProfile }

type CreateProcessInput = {
  name?: string
  cwd?: string
  env?: Record<string, string>
  cols?: number
  rows?: number
  restartable?: boolean
} & ({ interactive: true; command?: never } | { interactive?: false; command: string })

const unwrapList = <T>(value: unknown, keys: string[]): T[] => {
  if (Array.isArray(value)) return value as T[]
  if (!value || typeof value !== 'object') return []
  const record = value as Record<string, unknown>
  for (const key of [...keys, 'items', 'data']) {
    if (Array.isArray(record[key])) return record[key] as T[]
  }
  return []
}

const unwrapEntity = <T>(value: unknown, keys: string[]): T => {
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    for (const key of keys) {
      if (record[key] !== undefined) return record[key] as T
    }
  }
  return value as T
}

const normalizeWorkspace = (value: unknown): Workspace => {
  const row = value as Record<string, unknown>
  return {
    id: row.id as OsId,
    board_id: Number(row.board_id ?? row.boardId),
    card_id: row.card_id === null || row.cardId === null ? null : Number(row.card_id ?? row.cardId),
    name: String(row.name ?? 'Workspace'),
    kind: String(row.kind ?? 'shared'),
    root_path: String(row.root_path ?? row.rootPath ?? ''),
    worktree_path: row.worktree_path === null || row.worktreePath === null ? null : String(row.worktree_path ?? row.worktreePath ?? ''),
    branch: row.branch === null || row.branch === undefined ? null : String(row.branch),
    base_ref: row.base_ref === null || row.baseRef === null ? null : String(row.base_ref ?? row.baseRef ?? ''),
    status: String(row.status ?? 'active'),
    env_json: (row.env_json ?? row.env ?? null) as Workspace['env_json'],
    created_at: String(row.created_at ?? row.createdAt ?? ''),
    updated_at: String(row.updated_at ?? row.updatedAt ?? ''),
  }
}

const normalizeProcess = (value: unknown): WorkspaceProcess => {
  const row = value as Record<string, unknown>
  return {
    id: row.id as OsId,
    workspace_id: (row.workspace_id ?? row.workspaceId) as OsId,
    name: String(row.name ?? 'process'),
    command: String(row.command ?? ''),
    cwd: String(row.cwd ?? ''),
    status: String(row.status ?? 'lost'),
    pid: row.pid === null || row.pid === undefined ? null : Number(row.pid),
    exit_code: row.exit_code === null || row.exitCode === null || (row.exit_code === undefined && row.exitCode === undefined)
      ? null : Number(row.exit_code ?? row.exitCode),
    cols: Number(row.cols ?? 80),
    rows: Number(row.rows ?? 24),
    restartable: Boolean(row.restartable),
    started_at: row.started_at === null || row.startedAt === null ? null : String(row.started_at ?? row.startedAt ?? ''),
    ended_at: row.ended_at === null || row.endedAt === null ? null : String(row.ended_at ?? row.endedAt ?? ''),
    ports: Array.isArray(row.ports) ? row.ports.map(Number) : undefined,
  }
}

const normalizeOutput = (value: unknown): ProcessOutput => {
  const row = value as Record<string, unknown>
  return {
    process_id: (row.process_id ?? row.processId) as OsId,
    seq: Number(row.seq ?? 0),
    stream: String(row.stream ?? 'pty'),
    data: String(row.data ?? ''),
    created_at: String(row.created_at ?? row.createdAt ?? ''),
  }
}

export const parseJson = <T>(value: unknown, fallback: T): T => {
  if (value === null || value === undefined || value === '') return fallback
  if (typeof value !== 'string') return value as T
  try { return JSON.parse(value) as T } catch { return fallback }
}

export const asStringList = (value: unknown): string[] => {
  const parsed = parseJson<unknown>(value, value)
  if (Array.isArray(parsed)) return parsed.map((item) => typeof item === 'string' ? item : String(item))
  if (typeof parsed === 'string') return parsed.split('\n').map((line) => line.trim()).filter(Boolean)
  return []
}

const objectValue = (value: unknown): JsonObject => {
  const parsed = parseJson<unknown>(value, value)
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as JsonObject : {}
}

const firstValue = (row: JsonObject, ...keys: string[]): unknown => {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(row, key)) return row[key]
  }
  return undefined
}

const optionalString = (value: unknown): string | null => {
  if (value === null || value === undefined) return null
  const text = String(value).trim()
  return text || null
}

const optionalId = (value: unknown): OsId | null => {
  if (value === null || value === undefined || value === '') return null
  return typeof value === 'number' ? value : String(value)
}

const optionalNumber = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

const requiredBoolean = (value: unknown, fallback = true): boolean => {
  if (value === null || value === undefined || value === '') return fallback
  if (typeof value === 'string') return !['0', 'false', 'no'].includes(value.trim().toLowerCase())
  if (typeof value === 'number') return value !== 0
  return value !== false
}

const listValue = (value: unknown): unknown[] => {
  const parsed = parseJson<unknown>(value, value)
  if (Array.isArray(parsed)) return parsed
  if (parsed === null || parsed === undefined || parsed === '') return []
  return [parsed]
}

const deliveryText = (row: JsonObject): string => optionalString(firstValue(row,
  'text', 'description', 'deliverable', 'criterion', 'title', 'name', 'summary', 'claim')) ?? ''

const normalizeDeliveryPromise = (value: unknown, index: number): DeliveryPromise => {
  if (typeof value === 'string') return {
    id: null, text: value.trim(), required: true, deliverable_ids: [], metadata: {},
  }
  const row = objectValue(value)
  return {
    id: optionalString(firstValue(row, 'id', 'deliverable_id', 'deliverableId', 'criterion_id', 'criterionId')),
    text: deliveryText(row) || `Outcome ${index + 1}`,
    required: requiredBoolean(firstValue(row, 'required', 'mandatory')),
    deliverable_ids: normalizeIdList(firstValue(row, 'deliverable_ids', 'deliverableIds')).map(String),
    metadata: objectValue(firstValue(row, 'metadata', 'meta')),
  }
}

const normalizePromiseList = (value: unknown): DeliveryPromise[] => {
  const parsed = parseJson<unknown>(value, value)
  const items = Array.isArray(parsed)
    ? parsed
    : typeof parsed === 'string'
      ? parsed.split('\n').map((item) => item.trim()).filter(Boolean)
      : parsed && typeof parsed === 'object' ? Object.values(parsed as JsonObject) : []
  return items.map(normalizeDeliveryPromise).filter((item) => item.text)
}

const normalizeDeliveryEvidence = (value: unknown): DeliveryEvidence[] => {
  const evidence: DeliveryEvidence[] = []
  for (const item of listValue(value)) {
    if (typeof item === 'string') {
      if (item.trim()) evidence.push(item.trim())
    } else if (item && typeof item === 'object' && !Array.isArray(item)) {
      evidence.push(item as JsonObject)
    } else if (item !== null && item !== undefined) evidence.push(String(item))
  }
  return evidence
}

const normalizeDeliveryOverride = (value: unknown): DeliveryOverride | null => {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'string') return { actor: null, reason: value, created_at: null }
  const row = objectValue(value)
  if (!Object.keys(row).length) return null
  return {
    actor: optionalString(firstValue(row, 'actor', 'actor_name', 'actorName', 'reviewer', 'overridden_by', 'overriddenBy')),
    reason: optionalString(firstValue(row, 'reason', 'note', 'summary', 'detail')),
    created_at: optionalString(firstValue(row, 'at', 'created_at', 'createdAt', 'overridden_at', 'overriddenAt')),
  }
}

const normalizeDeliveryOutcome = (value: unknown, index: number, fallbackStatus = 'unverified'): DeliveryOutcome => {
  if (typeof value === 'string') {
    return {
      id: null, text: value.trim(), required: true, deliverable_ids: [], metadata: {},
      status: fallbackStatus, evidence: [], gaps: [], override: null, claim: value.trim(),
      note: null, actor: null, created_at: null, updated_at: null,
    }
  }
  const row = objectValue(value)
  const evidence = firstValue(row, 'evidence_refs', 'evidenceRefs', 'evidence', 'evidence_items', 'evidenceItems', 'artifact_ids', 'artifactIds', 'artifacts')
  return {
    ...normalizeDeliveryPromise(row, index),
    status: optionalString(firstValue(row, 'outcome', 'status', 'result', 'state'))?.toLowerCase().replace(/[\s-]+/g, '_') ?? fallbackStatus,
    evidence: normalizeDeliveryEvidence(evidence),
    gaps: asStringList(firstValue(row, 'gaps', 'gap', 'missing_evidence', 'missingEvidence')),
    override: normalizeDeliveryOverride(firstValue(row, 'override', 'human_override', 'humanOverride')),
    claim: optionalString(firstValue(row, 'claim', 'agent_claim', 'agentClaim')),
    note: optionalString(firstValue(row, 'note', 'verifier_note', 'verifierNote', 'reason')),
    actor: optionalString(firstValue(row, 'actor', 'verified_by', 'verifiedBy')),
    created_at: optionalString(firstValue(row, 'created_at', 'createdAt')),
    updated_at: optionalString(firstValue(row, 'updated_at', 'updatedAt')),
  }
}

const normalizeOutcomeList = (value: unknown, fallbackStatus: string): DeliveryOutcome[] =>
  listValue(value).map((item, index) => normalizeDeliveryOutcome(item, index, fallbackStatus)).filter((item) => item.text)

const normalizeDeliveryClaim = (value: unknown): DeliveryClaim | null => {
  if (typeof value === 'string') return value.trim() ? { text: value.trim(), source: null, created_at: null } : null
  const row = objectValue(value)
  const text = optionalString(firstValue(row, 'claim', 'text', 'summary', 'detail'))
  if (!text) return null
  return {
    text,
    source: optionalString(firstValue(row, 'source', 'agent', 'actor', 'provider')),
    created_at: optionalString(firstValue(row, 'created_at', 'createdAt', 'claimed_at', 'claimedAt')),
  }
}

const normalizePathList = (value: unknown): string[] => listValue(value).flatMap((item) => {
  if (typeof item === 'string') return item.trim() ? [item.trim()] : []
  const row = objectValue(item)
  const path = optionalString(firstValue(row, 'path', 'file', 'name'))
  return path ? [path] : []
})

const normalizeCommitList = (value: unknown): string[] => listValue(value).flatMap((item) => {
  if (typeof item === 'string') return item.trim() ? [item.trim()] : []
  const row = objectValue(item)
  const commit = optionalString(firstValue(row, 'hash', 'sha', 'commit', 'id'))
  return commit ? [commit] : []
})

const normalizeIdList = (value: unknown): OsId[] => listValue(value).flatMap((item) => {
  if (typeof item === 'number') return [item]
  if (typeof item === 'string' && item.trim()) return [item.trim()]
  const row = objectValue(item)
  const id = optionalId(firstValue(row, 'id', 'artifact_id', 'artifactId'))
  return id === null ? [] : [id]
})

const normalizeAskedSnapshot = (value: unknown): DeliveryAskedSnapshot => {
  const row = objectValue(value)
  const version = firstValue(row, 'version', 'contract_version', 'contractVersion')
  return {
    objective: optionalString(firstValue(row, 'objective', 'goal', 'request', 'description')) ?? '',
    deliverables: normalizePromiseList(firstValue(row, 'deliverables', 'promised_outcomes', 'promisedOutcomes', 'outcomes')),
    acceptance_criteria: normalizePromiseList(firstValue(row, 'acceptance_criteria', 'acceptanceCriteria', 'criteria')),
    non_goals: asStringList(firstValue(row, 'non_goals', 'nonGoals', 'out_of_scope', 'outOfScope')),
    risks: asStringList(firstValue(row, 'risks', 'constraints', 'known_risks', 'knownRisks')),
    verify_commands: asStringList(firstValue(row, 'verify_commands', 'verifyCommands', 'verification_commands', 'verificationCommands')),
    dependencies: normalizeIdList(firstValue(row, 'dependencies', 'dependency_ids', 'dependencyIds')),
    base_ref: optionalString(firstValue(row, 'base_ref', 'baseRef')),
    budget_tokens: optionalNumber(firstValue(row, 'budget_tokens', 'budgetTokens')),
    budget_cents: optionalNumber(firstValue(row, 'budget_cents', 'budgetCents')),
    priority: optionalNumber(firstValue(row, 'priority')) ?? 0,
    policy_id: optionalId(firstValue(row, 'policy_id', 'policyId')),
    version: typeof version === 'string' || typeof version === 'number' ? version : null,
    updated_at: optionalString(firstValue(row, 'contract_updated_at', 'contractUpdatedAt', 'updated_at', 'updatedAt')),
  }
}

export const normalizeDeliveryReport = (value: unknown): DeliveryReport => {
  const row = objectValue(value)
  const sequence = Number(firstValue(row, 'sequence', 'revision', 'version') ?? 0)
  const rawCardId = firstValue(row, 'card_id', 'cardId')
  const cardId = Number(rawCardId)
  const rawDeliveredItems = firstValue(row, 'delivered_items', 'deliveredItems', 'outcomes')
  const rawDeliverableResults = firstValue(row, 'deliverable_results', 'deliverableResults')
  return {
    id: optionalId(firstValue(row, 'id', 'delivery_id', 'deliveryId')) ?? `delivery-${Number.isFinite(sequence) ? sequence : 0}`,
    lineage_id: optionalId(firstValue(row, 'lineage_id', 'lineageId')),
    card_id: rawCardId === null || rawCardId === undefined || rawCardId === '' || !Number.isFinite(cardId) ? null : cardId,
    contract_id: optionalId(firstValue(row, 'contract_id', 'contractId')),
    job_id: optionalId(firstValue(row, 'job_id', 'jobId')),
    session_id: optionalId(firstValue(row, 'session_id', 'sessionId')),
    workspace_id: optionalId(firstValue(row, 'workspace_id', 'workspaceId')),
    status: optionalString(firstValue(row, 'status', 'lifecycle_status', 'lifecycleStatus'))?.toLowerCase().replace(/[\s-]+/g, '_') ?? 'submitted',
    asked: normalizeAskedSnapshot(firstValue(row, 'asked', 'asked_snapshot', 'askedSnapshot', 'request_snapshot', 'requestSnapshot')),
    summary: optionalString(firstValue(row, 'summary', 'delivery_summary', 'deliverySummary')) ?? '',
    human_summary: optionalString(firstValue(row, 'human_summary', 'humanSummary', 'review_summary', 'reviewSummary')),
    delivered_items: normalizeOutcomeList(rawDeliveredItems, 'claimed'),
    deliverable_results: normalizeOutcomeList(rawDeliverableResults === undefined ? rawDeliveredItems : rawDeliverableResults, 'unverified'),
    criterion_results: normalizeOutcomeList(firstValue(row, 'criterion_results', 'criterionResults', 'criteria'), 'missing'),
    changed_files: normalizePathList(firstValue(row, 'changed_files', 'changedFiles', 'files')),
    commits: normalizeCommitList(firstValue(row, 'commits', 'commit_ids', 'commitIds')),
    artifact_ids: normalizeIdList(firstValue(row, 'artifact_ids', 'artifactIds', 'artifacts')),
    claims: listValue(firstValue(row, 'claims', 'agent_claims', 'agentClaims')).map(normalizeDeliveryClaim)
      .filter((claim): claim is DeliveryClaim => claim !== null),
    gaps: asStringList(firstValue(row, 'gaps', 'evidence_gaps', 'evidenceGaps')),
    parent_delivery_id: optionalId(firstValue(row, 'parent_report_id', 'parentReportId', 'parent_delivery_id', 'parentDeliveryId')),
    sequence: Number.isFinite(sequence) ? sequence : 0,
    actor_type: optionalString(firstValue(row, 'actor_type', 'actorType')),
    actor_id: optionalId(firstValue(row, 'actor_id', 'actorId')),
    created_by: optionalString(firstValue(row, 'created_by', 'createdBy')),
    submitted_by: optionalString(firstValue(row, 'submitted_by', 'submittedBy', 'actor', 'author')),
    verified_by: optionalString(firstValue(row, 'verified_by', 'verifiedBy')),
    accepted_by: optionalString(firstValue(row, 'accepted_by', 'acceptedBy')),
    rejected_by: optionalString(firstValue(row, 'rejected_by', 'rejectedBy')),
    acceptance_note: optionalString(firstValue(row, 'acceptance_note', 'acceptanceNote')),
    rejection_reason: optionalString(firstValue(row, 'rejection_reason', 'rejectionReason')),
    created_at: optionalString(firstValue(row, 'created_at', 'createdAt')) ?? '',
    updated_at: optionalString(firstValue(row, 'updated_at', 'updatedAt')) ?? '',
    submitted_at: optionalString(firstValue(row, 'submitted_at', 'submittedAt')),
    verified_at: optionalString(firstValue(row, 'verified_at', 'verifiedAt')),
    reviewed_at: optionalString(firstValue(row, 'reviewed_at', 'reviewedAt')),
    accepted_at: optionalString(firstValue(row, 'accepted_at', 'acceptedAt')),
    rejected_at: optionalString(firstValue(row, 'rejected_at', 'rejectedAt')),
    shipped_at: optionalString(firstValue(row, 'shipped_at', 'shippedAt')),
  }
}

export const normalizeDeliveriesResponse = (value: unknown): DeliveryCollection => {
  const parsed = parseJson<unknown>(value, value)
  const row = objectValue(parsed)
  const rawDeliveries = listValue(Array.isArray(parsed) ? parsed : firstValue(row, 'deliveries', 'items', 'data'))
    .flatMap((item) => {
      const parsedItem = parseJson<unknown>(item, item)
      return parsedItem && typeof parsedItem === 'object' && !Array.isArray(parsedItem) ? [parsedItem] : []
    })
  const deliveries = rawDeliveries.map(normalizeDeliveryReport).sort((a, b) =>
    b.sequence - a.sequence || new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
  const rawCurrent = firstValue(row, 'current', 'current_delivery', 'currentDelivery')
  const parsedCurrent = parseJson<unknown>(rawCurrent, rawCurrent)
  const explicitCurrent = parsedCurrent && typeof parsedCurrent === 'object' && !Array.isArray(parsedCurrent)
    ? normalizeDeliveryReport(parsedCurrent) : null
  const current = explicitCurrent ?? deliveries[0] ?? null
  const ordered = current
    ? [current, ...deliveries.filter((delivery) => String(delivery.id) !== String(current.id))]
    : deliveries
  return { deliveries: ordered, current }
}

const accessProfiles = new Set<AgentAccessProfile>(['read_only', 'workspace_write', 'full_access'])

const normalizeAccessProfile = (value: unknown): AgentAccessProfile | null => {
  const profile = optionalString(value)
  return profile && accessProfiles.has(profile as AgentAccessProfile) ? profile as AgentAccessProfile : null
}

export const normalizeJob = (value: unknown): Job => {
  const row = objectValue(value)
  return {
    id: optionalId(firstValue(row, 'id', 'job_id', 'jobId')) ?? '',
    board_id: Number(firstValue(row, 'board_id', 'boardId')),
    card_id: optionalNumber(firstValue(row, 'card_id', 'cardId')),
    workspace_id: optionalId(firstValue(row, 'workspace_id', 'workspaceId')),
    provider: optionalString(firstValue(row, 'provider')) ?? '',
    ...(optionalString(firstValue(row, 'driver_id', 'driverId')) !== null
      ? { driver_id: optionalString(firstValue(row, 'driver_id', 'driverId'))! } : {}),
    model: optionalString(firstValue(row, 'model')),
    ...(firstValue(row, 'effort') !== undefined ? { effort: optionalString(firstValue(row, 'effort')) } : {}),
    ...(firstValue(row, 'access_profile', 'accessProfile') !== undefined
      ? { access_profile: normalizeAccessProfile(firstValue(row, 'access_profile', 'accessProfile')) } : {}),
    ...(firstValue(row, 'policy_id', 'policyId') !== undefined
      ? { policy_id: optionalId(firstValue(row, 'policy_id', 'policyId')) } : {}),
    ...(firstValue(row, 'contract_version', 'contractVersion') !== undefined
      ? { contract_version: optionalNumber(firstValue(row, 'contract_version', 'contractVersion')) } : {}),
    ...(firstValue(row, 'idempotency_key', 'idempotencyKey') !== undefined
      ? { idempotency_key: optionalString(firstValue(row, 'idempotency_key', 'idempotencyKey')) } : {}),
    job_assignment_id: optionalId(firstValue(row, 'job_assignment_id', 'jobAssignmentId')),
    assigned_profile_id: optionalId(firstValue(row, 'assigned_profile_id', 'assignedProfileId')),
    assignment_market_version: optionalNumber(
      firstValue(row, 'assignment_market_version', 'assignmentMarketVersion'),
    ),
    priority: optionalNumber(firstValue(row, 'priority')) ?? 0,
    status: optionalString(firstValue(row, 'status')) ?? 'unknown',
    attempts: optionalNumber(firstValue(row, 'attempts')) ?? 0,
    max_attempts: optionalNumber(firstValue(row, 'max_attempts', 'maxAttempts')) ?? 1,
    budget_tokens: optionalNumber(firstValue(row, 'budget_tokens', 'budgetTokens')),
    budget_cents: optionalNumber(firstValue(row, 'budget_cents', 'budgetCents')),
    ...(firstValue(row, 'spent_tokens', 'spentTokens') !== undefined
      ? { spent_tokens: optionalNumber(firstValue(row, 'spent_tokens', 'spentTokens')) ?? 0 } : {}),
    ...(firstValue(row, 'spent_cents', 'spentCents') !== undefined
      ? { spent_cents: optionalNumber(firstValue(row, 'spent_cents', 'spentCents')) ?? 0 } : {}),
    scheduled_at: optionalString(firstValue(row, 'scheduled_at', 'scheduledAt')) ?? '',
    started_at: optionalString(firstValue(row, 'started_at', 'startedAt')),
    finished_at: optionalString(firstValue(row, 'finished_at', 'finishedAt')),
    error: optionalString(firstValue(row, 'error')),
    ...(firstValue(row, 'created_at', 'createdAt') !== undefined
      ? { created_at: optionalString(firstValue(row, 'created_at', 'createdAt')) ?? '' } : {}),
  }
}

export const normalizeAgentSession = (value: unknown): AgentSession => {
  const row = objectValue(value)
  const contextValue = firstValue(row, 'context', 'context_json', 'contextJson')
  return {
    id: optionalId(firstValue(row, 'id', 'session_id', 'sessionId')) ?? '',
    workspace_id: optionalId(firstValue(row, 'workspace_id', 'workspaceId')) ?? '',
    agent_id: optionalNumber(firstValue(row, 'agent_id', 'agentId')),
    provider: optionalString(firstValue(row, 'provider')) ?? '',
    external_id: optionalString(firstValue(row, 'external_id', 'externalId')),
    model: optionalString(firstValue(row, 'model')),
    status: optionalString(firstValue(row, 'status')) ?? 'unknown',
    context: objectValue(contextValue),
    context_json: contextValue as AgentSession['context_json'],
    job_id: optionalId(firstValue(row, 'job_id', 'jobId')),
    workspace_assignment_id: optionalId(
      firstValue(row, 'workspace_assignment_id', 'workspaceAssignmentId'),
    ),
    profile_id: optionalId(firstValue(row, 'profile_id', 'profileId')),
    conversation_id: optionalId(firstValue(row, 'conversation_id', 'conversationId')),
    job_assignment_id: optionalId(firstValue(row, 'job_assignment_id', 'jobAssignmentId')),
    assigned_profile_id: optionalId(firstValue(row, 'assigned_profile_id', 'assignedProfileId')),
    assignment_market_version: optionalNumber(
      firstValue(row, 'assignment_market_version', 'assignmentMarketVersion'),
    ),
    created_at: optionalString(firstValue(row, 'created_at', 'createdAt')) ?? '',
    updated_at: optionalString(firstValue(row, 'updated_at', 'updatedAt')) ?? '',
  }
}

const requiredEntity = (row: JsonObject, key: string): JsonObject => {
  const entity = objectValue(row[key])
  if (!Object.keys(entity).length) throw new Error(`canonical lifecycle response is missing ${key}`)
  return entity
}

const canonicalError = (detail: string): never => {
  throw new Error(`invalid canonical lifecycle: ${detail}`)
}

const requiredCanonicalId = (value: unknown, label: string): OsId => {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value
  return canonicalError(`${label} must be a non-empty id`)
}

const optionalCanonicalId = (value: unknown, label: string): OsId | null => {
  if (value === null || value === undefined) return null
  return requiredCanonicalId(value, label)
}

const requiredCanonicalString = (value: unknown, label: string): string => {
  if (typeof value === 'string' && value.trim()) return value.trim()
  return canonicalError(`${label} must be a non-empty string`)
}

const optionalCanonicalString = (value: unknown, label: string): string | null => {
  if (value === null || value === undefined) return null
  return requiredCanonicalString(value, label)
}

const requiredCanonicalInteger = (value: unknown, label: string): number => {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value
  return canonicalError(`${label} must be a positive integer`)
}

const optionalCanonicalInteger = (value: unknown, label: string): number | null => {
  if (value === null || value === undefined) return null
  return requiredCanonicalInteger(value, label)
}

const sameCanonicalId = (left: OsId | null | undefined, right: OsId | null | undefined) =>
  left !== null && left !== undefined && right !== null && right !== undefined && String(left) === String(right)

const requireSameCanonicalId = (left: OsId | null | undefined, right: OsId | null | undefined, label: string) => {
  if (!sameCanonicalId(left, right)) canonicalError(`${label} does not match`)
}

type CanonicalAssignmentIdentity = {
  jobAssignmentId: OsId
  assignedProfileId: OsId
  assignmentMarketVersion: number
}

const canonicalAssignmentIdentity = (
  row: JsonObject,
  label: string,
): CanonicalAssignmentIdentity | null => {
  const values = [
    firstValue(row, 'job_assignment_id', 'jobAssignmentId'),
    firstValue(row, 'assigned_profile_id', 'assignedProfileId'),
    firstValue(row, 'assignment_market_version', 'assignmentMarketVersion'),
  ]
  const present = values.map((value) => value !== null && value !== undefined)
  if (!present.some(Boolean)) return null
  if (!present.every(Boolean)) canonicalError(`${label} assignment identity is incomplete`)
  return {
    jobAssignmentId: requiredCanonicalId(values[0], `${label}.job_assignment_id`),
    assignedProfileId: requiredCanonicalId(values[1], `${label}.assigned_profile_id`),
    assignmentMarketVersion: requiredCanonicalInteger(
      values[2],
      `${label}.assignment_market_version`,
    ),
  }
}

const sameCanonicalAssignment = (
  left: CanonicalAssignmentIdentity | null,
  right: CanonicalAssignmentIdentity | null,
) => left === null && right === null
  || left !== null && right !== null
    && String(left.jobAssignmentId) === String(right.jobAssignmentId)
    && String(left.assignedProfileId) === String(right.assignedProfileId)
    && left.assignmentMarketVersion === right.assignmentMarketVersion

const normalizeCanonicalIdentity = (row: JsonObject): OrchestrationIdentity => {
  if (firstValue(row, 'lifecycle') !== 'canonical') canonicalError('orchestration.lifecycle is not canonical')
  if (firstValue(row, 'contract_attached', 'contractAttached') !== true) {
    canonicalError('orchestration.contract_attached must be true')
  }
  return {
    lifecycle: 'canonical',
    contract_attached: true,
    job_id: requiredCanonicalId(firstValue(row, 'job_id', 'jobId'), 'orchestration.job_id'),
    workspace_id: requiredCanonicalId(firstValue(row, 'workspace_id', 'workspaceId'), 'orchestration.workspace_id'),
    session_id: requiredCanonicalId(firstValue(row, 'session_id', 'sessionId'), 'orchestration.session_id'),
    job_assignment_id: optionalCanonicalId(
      firstValue(row, 'job_assignment_id', 'jobAssignmentId'),
      'orchestration.job_assignment_id',
    ),
    assigned_profile_id: optionalCanonicalId(
      firstValue(row, 'assigned_profile_id', 'assignedProfileId'),
      'orchestration.assigned_profile_id',
    ),
    assignment_market_version: optionalCanonicalInteger(
      firstValue(row, 'assignment_market_version', 'assignmentMarketVersion'),
      'orchestration.assignment_market_version',
    ),
    assignment_id: optionalCanonicalId(
      firstValue(row, 'assignment_id', 'assignmentId'),
      'orchestration.assignment_id',
    ),
    workspace_assignment_id: optionalCanonicalId(
      firstValue(row, 'workspace_assignment_id', 'workspaceAssignmentId'),
      'orchestration.workspace_assignment_id',
    ),
    contract_id: requiredCanonicalId(firstValue(row, 'contract_id', 'contractId'), 'orchestration.contract_id'),
    contract_version: requiredCanonicalInteger(
      firstValue(row, 'contract_version', 'contractVersion'),
      'orchestration.contract_version',
    ),
    correlation_id: optionalCanonicalId(
      firstValue(row, 'correlation_id', 'correlationId'),
      'orchestration.correlation_id',
    ),
    idempotency_key: optionalCanonicalString(
      firstValue(row, 'idempotency_key', 'idempotencyKey'),
      'orchestration.idempotency_key',
    ),
  }
}

type CanonicalLifecycleCore = Omit<CanonicalLifecycleRecord, 'events'>

const normalizeCanonicalCore = (value: unknown): CanonicalLifecycleCore => {
  const row = objectValue(value)
  if (firstValue(row, 'mode') !== 'canonical') canonicalError('mode is not canonical')
  const identity = normalizeCanonicalIdentity(requiredEntity(row, 'orchestration'))
  const contractRow = requiredEntity(row, 'contract')
  const deliveryRow = requiredEntity(row, 'delivery')
  const jobRow = requiredEntity(row, 'job')
  const workspaceRow = requiredEntity(row, 'workspace')
  const sessionRow = requiredEntity(row, 'session')

  const contractCardId = requiredCanonicalInteger(firstValue(contractRow, 'card_id', 'cardId'), 'contract.card_id')
  const contractVersion = requiredCanonicalInteger(firstValue(contractRow, 'version'), 'contract.version')
  requiredCanonicalString(firstValue(contractRow, 'objective'), 'contract.objective')
  for (const key of ['deliverables', 'acceptance_criteria', 'dependencies', 'verify_commands', 'non_goals', 'risks']) {
    if (!Array.isArray(contractRow[key])) canonicalError(`contract.${key} must be an array`)
  }
  const contractWorkspaceId = requiredCanonicalId(
    firstValue(contractRow, 'workspace_id', 'workspaceId'),
    'contract.workspace_id',
  )
  const contract = contractRow as unknown as TaskContract

  const delivery = normalizeDeliveryReport(deliveryRow)
  const deliveryId = requiredCanonicalId(firstValue(deliveryRow, 'id'), 'delivery.id')
  const deliveryCardId = requiredCanonicalInteger(firstValue(deliveryRow, 'card_id', 'cardId'), 'delivery.card_id')
  const deliveryContractId = requiredCanonicalId(
    firstValue(deliveryRow, 'contract_id', 'contractId'),
    'delivery.contract_id',
  )
  const deliveryJobId = requiredCanonicalId(firstValue(deliveryRow, 'job_id', 'jobId'), 'delivery.job_id')
  const deliveryWorkspaceId = requiredCanonicalId(
    firstValue(deliveryRow, 'workspace_id', 'workspaceId'),
    'delivery.workspace_id',
  )
  const deliverySessionId = requiredCanonicalId(
    firstValue(deliveryRow, 'session_id', 'sessionId'),
    'delivery.session_id',
  )
  requiredCanonicalString(firstValue(deliveryRow, 'status'), 'delivery.status')
  delivery.id = deliveryId
  delivery.card_id = deliveryCardId
  delivery.contract_id = deliveryContractId
  delivery.job_id = deliveryJobId
  delivery.workspace_id = deliveryWorkspaceId
  delivery.session_id = deliverySessionId

  const job = normalizeJob(jobRow)
  const jobAssignment = canonicalAssignmentIdentity(jobRow, 'job')
  const jobId = requiredCanonicalId(firstValue(jobRow, 'id'), 'job.id')
  const jobBoardId = requiredCanonicalInteger(firstValue(jobRow, 'board_id', 'boardId'), 'job.board_id')
  const jobCardId = requiredCanonicalInteger(firstValue(jobRow, 'card_id', 'cardId'), 'job.card_id')
  const jobWorkspaceId = requiredCanonicalId(firstValue(jobRow, 'workspace_id', 'workspaceId'), 'job.workspace_id')
  const jobContractVersion = requiredCanonicalInteger(
    firstValue(jobRow, 'contract_version', 'contractVersion'),
    'job.contract_version',
  )
  requiredCanonicalString(firstValue(jobRow, 'provider'), 'job.provider')
  requiredCanonicalString(firstValue(jobRow, 'driver_id', 'driverId'), 'job.driver_id')
  const jobStatus = requiredCanonicalString(firstValue(jobRow, 'status'), 'job.status')
  const accessProfile = normalizeAccessProfile(firstValue(jobRow, 'access_profile', 'accessProfile'))
  if (!accessProfile) canonicalError('job.access_profile is invalid')
  job.id = jobId
  job.board_id = jobBoardId
  job.card_id = jobCardId
  job.workspace_id = jobWorkspaceId
  job.contract_version = jobContractVersion
  job.access_profile = accessProfile
  job.job_assignment_id = jobAssignment?.jobAssignmentId ?? null
  job.assigned_profile_id = jobAssignment?.assignedProfileId ?? null
  job.assignment_market_version = jobAssignment?.assignmentMarketVersion ?? null

  const workspace = normalizeWorkspace(workspaceRow)
  const workspaceId = requiredCanonicalId(firstValue(workspaceRow, 'id'), 'workspace.id')
  const workspaceBoardId = requiredCanonicalInteger(
    firstValue(workspaceRow, 'board_id', 'boardId'),
    'workspace.board_id',
  )
  const rawWorkspaceCardId = firstValue(workspaceRow, 'card_id', 'cardId')
  const workspaceCardId = rawWorkspaceCardId === null
    ? null : requiredCanonicalInteger(rawWorkspaceCardId, 'workspace.card_id')
  requiredCanonicalString(firstValue(workspaceRow, 'status'), 'workspace.status')
  workspace.id = workspaceId
  workspace.board_id = workspaceBoardId
  workspace.card_id = workspaceCardId

  const session = normalizeAgentSession(sessionRow)
  const sessionAssignment = canonicalAssignmentIdentity(sessionRow, 'session')
  const sessionId = requiredCanonicalId(firstValue(sessionRow, 'id'), 'session.id')
  const sessionWorkspaceId = requiredCanonicalId(
    firstValue(sessionRow, 'workspace_id', 'workspaceId'),
    'session.workspace_id',
  )
  requiredCanonicalString(firstValue(sessionRow, 'provider'), 'session.provider')
  const sessionStatus = requiredCanonicalString(firstValue(sessionRow, 'status'), 'session.status')
  session.id = sessionId
  session.workspace_id = sessionWorkspaceId
  session.job_assignment_id = sessionAssignment?.jobAssignmentId ?? null
  session.assigned_profile_id = sessionAssignment?.assignedProfileId ?? null
  session.assignment_market_version = sessionAssignment?.assignmentMarketVersion ?? null

  const identityAssignment = canonicalAssignmentIdentity(
    identity as unknown as JsonObject,
    'orchestration',
  )
  if (!sameCanonicalAssignment(jobAssignment, sessionAssignment)
    || !sameCanonicalAssignment(jobAssignment, identityAssignment)) {
    canonicalError('job, session, and orchestration assignment identities do not match')
  }

  requireSameCanonicalId(identity.job_id, jobId, 'orchestration.job_id')
  requireSameCanonicalId(identity.workspace_id, workspaceId, 'orchestration.workspace_id')
  requireSameCanonicalId(identity.session_id, sessionId, 'orchestration.session_id')
  requireSameCanonicalId(jobWorkspaceId, workspaceId, 'job.workspace_id')
  requireSameCanonicalId(contractWorkspaceId, workspaceId, 'contract.workspace_id')
  requireSameCanonicalId(sessionWorkspaceId, workspaceId, 'session.workspace_id')
  requireSameCanonicalId(deliveryJobId, jobId, 'delivery.job_id')
  requireSameCanonicalId(deliveryWorkspaceId, workspaceId, 'delivery.workspace_id')
  requireSameCanonicalId(deliverySessionId, sessionId, 'delivery.session_id')
  requireSameCanonicalId(deliveryContractId, identity.contract_id, 'delivery.contract_id')
  if (contractCardId !== jobCardId || contractCardId !== deliveryCardId
    || (workspaceCardId !== null && contractCardId !== workspaceCardId)) {
    canonicalError('card ids do not match')
  }
  if (jobBoardId !== workspaceBoardId) canonicalError('board ids do not match')
  if (contractVersion !== jobContractVersion || contractVersion !== identity.contract_version) {
    canonicalError('contract versions do not match')
  }
  const expectedContractId = `card:${contractCardId}:v${contractVersion}`
  if (String(identity.contract_id) !== expectedContractId) canonicalError('orchestration.contract_id is invalid')
  const sessionJobId = optionalCanonicalId(session.context?.job_id, 'session.context.job_id')
  if (sessionJobId !== null) requireSameCanonicalId(sessionJobId, jobId, 'session.context.job_id')
  const relationalSessionJobId = optionalCanonicalId(
    firstValue(sessionRow, 'job_id', 'jobId'),
    'session.job_id',
  )
  const sessionWorkspaceAssignmentId = requiredCanonicalId(
    firstValue(sessionRow, 'workspace_assignment_id', 'workspaceAssignmentId'),
    'session.workspace_assignment_id',
  )
  requireSameCanonicalId(
    identity.assignment_id,
    sessionWorkspaceAssignmentId,
    'orchestration.assignment_id',
  )
  requireSameCanonicalId(
    identity.workspace_assignment_id,
    sessionWorkspaceAssignmentId,
    'orchestration.workspace_assignment_id',
  )
  if (relationalSessionJobId !== null) {
    requireSameCanonicalId(relationalSessionJobId, jobId, 'session.job_id')
  }
  if (jobAssignment) {
    requireSameCanonicalId(relationalSessionJobId, jobId, 'session.job_id')
    const sessionProfileId = optionalCanonicalId(
      firstValue(sessionRow, 'profile_id', 'profileId'),
      'session.profile_id',
    )
    if (sessionProfileId === null) {
      const unlinkedState = `${jobStatus}:${sessionStatus}`
      if (![
        'queued:reserved',
        'blocked:failed',
        'cancelled:stopped',
        'cancelled:failed',
      ].includes(unlinkedState)) {
        canonicalError('active assigned session.profile_id is missing')
      }
    } else {
      requireSameCanonicalId(
        sessionProfileId,
        jobAssignment.assignedProfileId,
        'session.profile_id',
      )
    }
  }
  const sessionCorrelationId = optionalCanonicalId(
    session.context?.correlation_id,
    'session.context.correlation_id',
  )
  if (identity.correlation_id !== null) {
    requireSameCanonicalId(sessionCorrelationId, identity.correlation_id, 'session.context.correlation_id')
  }
  if (job.provider !== session.provider) canonicalError('provider identities do not match')
  if (Number(delivery.asked.version) !== contractVersion) {
    canonicalError('delivery asked contract version does not match')
  }
  if ((job.idempotency_key ?? null) !== (identity.idempotency_key ?? null)) {
    canonicalError('idempotency keys do not match')
  }

  return {
    mode: 'canonical',
    orchestration: identity,
    contract,
    delivery,
    job,
    workspace,
    session,
  }
}

const normalizeCanonicalDispatch = (value: unknown, jobId: OsId): SchedulerDispatch => {
  const row = requiredEntity({ dispatch: value }, 'dispatch')
  const dispatch = {} as SchedulerDispatch
  for (const key of ['started', 'completed', 'blocked', 'deferred'] as const) {
    const values = row[key]
    if (!Array.isArray(values)) canonicalError(`dispatch.${key} must be an array`)
    dispatch[key] = (values as unknown[]).map((id: unknown, index: number) =>
      requiredCanonicalId(id, `dispatch.${key}[${index}]`))
    if (dispatch[key].some((id) => !sameCanonicalId(id, jobId))) {
      canonicalError(`dispatch.${key} contains a different job`)
    }
  }
  return dispatch
}

const normalizeCanonicalEvent = (
  value: unknown,
  jobId: OsId,
  boardId: number,
  workspaceId: OsId,
  cardId: number,
  contractId: OsId,
  sessionId: OsId,
  correlationId: OsId,
): OsEvent => {
  const row = objectValue(value)
  if (!Object.keys(row).length) canonicalError('events contains a non-object record')
  const eventJobId = requiredCanonicalId(firstValue(row, 'job_id', 'jobId'), 'event.job_id')
  const eventBoardId = requiredCanonicalInteger(firstValue(row, 'board_id', 'boardId'), 'event.board_id')
  requireSameCanonicalId(eventJobId, jobId, 'event.job_id')
  if (eventBoardId !== boardId) canonicalError('event.board_id does not match')
  const event: OsEvent = {
    id: requiredCanonicalId(firstValue(row, 'id'), 'event.id'),
    board_id: eventBoardId,
    workspace_id: requiredCanonicalId(firstValue(row, 'workspace_id', 'workspaceId'), 'event.workspace_id'),
    card_id: requiredCanonicalInteger(firstValue(row, 'card_id', 'cardId'), 'event.card_id'),
    session_id: optionalCanonicalId(firstValue(row, 'session_id', 'sessionId'), 'event.session_id'),
    process_id: optionalCanonicalId(firstValue(row, 'process_id', 'processId'), 'event.process_id'),
    job_id: eventJobId,
    contract_id: requiredCanonicalId(firstValue(row, 'contract_id', 'contractId'), 'event.contract_id'),
    correlation_id: requiredCanonicalId(
      firstValue(row, 'correlation_id', 'correlationId'),
      'event.correlation_id',
    ),
    causation_id: optionalCanonicalId(firstValue(row, 'causation_id', 'causationId'), 'event.causation_id'),
    idempotency_key: optionalCanonicalString(
      firstValue(row, 'idempotency_key', 'idempotencyKey'),
      'event.idempotency_key',
    ),
    event_version: firstValue(row, 'event_version', 'eventVersion') == null
      ? 1 : requiredCanonicalInteger(firstValue(row, 'event_version', 'eventVersion'), 'event.event_version'),
    kind: requiredCanonicalString(firstValue(row, 'kind'), 'event.kind'),
    source: requiredCanonicalString(firstValue(row, 'source'), 'event.source'),
    payload: parseJson<JsonObject | null>(firstValue(row, 'payload'), null),
    created_at: requiredCanonicalString(firstValue(row, 'created_at', 'createdAt'), 'event.created_at'),
  }
  requireSameCanonicalId(event.workspace_id, workspaceId, 'event.workspace_id')
  if (event.card_id !== cardId) canonicalError('event.card_id does not match')
  requireSameCanonicalId(event.contract_id, contractId, 'event.contract_id')
  if (event.session_id !== null) requireSameCanonicalId(event.session_id, sessionId, 'event.session_id')
  requireSameCanonicalId(event.correlation_id, correlationId, 'event.correlation_id')
  return event
}

/** Normalize a launch response only when all canonical records and exact links are present. */
export const normalizeCanonicalLifecycleResponse = (value: unknown): CanonicalLifecycleSnapshot => {
  const row = objectValue(value)
  const core = normalizeCanonicalCore(row)
  return {
    ...core,
    dispatch: normalizeCanonicalDispatch(row.dispatch, core.job.id),
    dispatch_error: optionalCanonicalString(
      firstValue(row, 'dispatch_error', 'dispatchError'),
      'dispatch_error',
    ),
  }
}

/** Normalize a job-keyed lifecycle read model without borrowing board/workspace state. */
export const normalizeCanonicalLifecycleRecord = (value: unknown): CanonicalLifecycleRecord => {
  const row = objectValue(value)
  const core = normalizeCanonicalCore(row)
  if (core.orchestration.correlation_id === null) {
    canonicalError('orchestration.correlation_id is required for exact events')
  }
  const eventValues = row.events
  if (!Array.isArray(eventValues) || eventValues.length === 0) {
    canonicalError('events must contain at least one exact job event')
  }
  return {
    ...core,
    events: (eventValues as unknown[])
      .map((event: unknown) => normalizeCanonicalEvent(
        event,
        core.job.id,
        core.job.board_id,
        core.workspace.id,
        core.contract.card_id,
        core.orchestration.contract_id!,
        core.session.id,
        core.orchestration.correlation_id!,
      )),
  }
}

export const osApi = {
  listWorkspaces: async (boardId: number) =>
    unwrapList<unknown>(await api('GET', `/os/boards/${boardId}/workspaces`), ['workspaces']).map(normalizeWorkspace),
  createWorkspace: async (boardId: number, input: Partial<Workspace> & { name: string }) =>
    normalizeWorkspace(unwrapEntity<unknown>(await api('POST', `/os/boards/${boardId}/workspaces`, input), ['workspace'])),
  getWorkspace: async (workspaceId: OsId) =>
    normalizeWorkspace(unwrapEntity<unknown>(await api('GET', `/os/workspaces/${workspaceId}`), ['workspace'])),
  updateWorkspace: async (workspaceId: OsId, input: Partial<Workspace>) =>
    normalizeWorkspace(unwrapEntity<unknown>(await api('PATCH', `/os/workspaces/${workspaceId}`, input), ['workspace'])),
  archiveWorkspace: (workspaceId: OsId) => api('DELETE', `/os/workspaces/${workspaceId}`),

  listProcesses: async (workspaceId: OsId) =>
    unwrapList<unknown>(await api('GET', `/os/workspaces/${workspaceId}/processes`), ['processes']).map(normalizeProcess),
  createProcess: async (workspaceId: OsId, input: CreateProcessInput) =>
    normalizeProcess(unwrapEntity<unknown>(await api('POST', `/os/workspaces/${workspaceId}/processes`, input), ['process'])),
  readProcessOutput: async (processId: OsId, after = 0) => {
    const raw = await api('GET', `/os/processes/${processId}/output?after=${after}`)
    const items = unwrapList<unknown>(raw, ['output', 'chunks']).map(normalizeOutput)
    const explicit = raw && typeof raw === 'object'
      ? Number((raw as Record<string, unknown>).next_seq ?? (raw as Record<string, unknown>).nextSeq ?? NaN)
      : NaN
    return { items, nextSeq: Number.isFinite(explicit) ? explicit : items.reduce((max, item) => Math.max(max, item.seq), after) }
  },
  writeProcessInput: (processId: OsId, data: string) => api('POST', `/os/processes/${processId}/input`, { data }),
  resizeProcess: (processId: OsId, cols: number, rows: number) => api('POST', `/os/processes/${processId}/resize`, { cols, rows }),
  signalProcess: (processId: OsId, signal: string) => api('POST', `/os/processes/${processId}/signal`, { signal }),
  stopProcess: async (processId: OsId) =>
    normalizeProcess(unwrapEntity<unknown>(
      await api('POST', `/os/processes/${processId}/signal`, { signal: 'SIGTERM', escalate: true }),
      ['process'],
    )),
  restartProcess: async (processId: OsId) =>
    normalizeProcess(unwrapEntity<unknown>(await api('POST', `/os/processes/${processId}/restart`), ['process'])),

  listEvents: async (boardId: number) =>
    unwrapList<OsEvent>(await api('GET', `/os/boards/${boardId}/events`), ['events']),
  listAttention: async (boardId: number) =>
    unwrapList<AttentionItem>(await api('GET', `/os/boards/${boardId}/attention`), ['attention', 'attention_items']),
  resolveAttention: (attentionId: OsId) => api('POST', `/os/attention/${attentionId}/resolve`),

  getContract: async (cardId: number) =>
    unwrapEntity<TaskContract>(await api('GET', `/os/cards/${cardId}/contract`), ['contract']),
  updateContract: async (cardId: number, input: Partial<TaskContract>) =>
    unwrapEntity<TaskContract>(await api('PUT', `/os/cards/${cardId}/contract`, input), ['contract']),
  getEvidence: async (cardId: number) => {
    const raw = await api('GET', `/os/cards/${cardId}/evidence`)
    if (Array.isArray(raw)) return { artifacts: raw as Artifact[] } as EvidenceBundle
    const bundle = unwrapEntity<EvidenceBundle | null>(raw, ['evidence'])
    const artifacts = unwrapList<Artifact>(raw, ['artifacts'])
    return { ...(bundle ?? {}), artifacts: artifacts.length > 0 ? artifacts : bundle?.artifacts ?? [] }
  },
  createEvidence: async (cardId: number, input: Partial<Artifact>) =>
    unwrapEntity<Artifact>(await api('POST', `/os/cards/${cardId}/evidence`, input), ['artifact']),
  getDeliveries: async (cardId: number) =>
    normalizeDeliveriesResponse(await api('GET', `/os/cards/${cardId}/deliveries`)),

  getContext: async (workspaceId: OsId) =>
    unwrapList<ContextItem>(await api('GET', `/os/workspaces/${workspaceId}/context`), ['context', 'context_items']),
  updateContext: async (workspaceId: OsId, input: { items: Partial<ContextItem>[] }) =>
    unwrapList<ContextItem>(await api('PUT', `/os/workspaces/${workspaceId}/context`, { context: input.items }), ['context', 'context_items']),

  listPolicies: async (boardId: number) =>
    unwrapList<Policy>(await api('GET', `/os/boards/${boardId}/policies`), ['policies']),
  createPolicy: async (boardId: number, input: Partial<Policy> & { name: string }) =>
    unwrapEntity<Policy>(await api('POST', `/os/boards/${boardId}/policies`, input), ['policy']),
  evaluatePolicy: async (policyId: OsId, input: JsonObject) =>
    unwrapEntity<PolicyDecision>(await api('POST', `/os/policies/${policyId}/evaluate`, input), ['result', 'evaluation']),

  listCheckpoints: async (workspaceId: OsId) =>
    unwrapList<Checkpoint>(await api('GET', `/os/workspaces/${workspaceId}/checkpoints`), ['checkpoints']),
  createCheckpoint: async (workspaceId: OsId, input: Partial<Checkpoint>) =>
    unwrapEntity<Checkpoint>(await api('POST', `/os/workspaces/${workspaceId}/checkpoints`, input), ['checkpoint']),
  forkCheckpoint: async (checkpointId: OsId, input: JsonObject = {}) =>
    normalizeWorkspace(unwrapEntity<unknown>(await api('POST', `/os/checkpoints/${checkpointId}/fork`, input), ['workspace'])),

  listJobs: async (boardId: number) =>
    unwrapList<unknown>(await api('GET', `/os/boards/${boardId}/jobs`), ['jobs']).map(normalizeJob),
  getJobLifecycle: async (jobId: OsId) =>
    normalizeCanonicalLifecycleRecord(await api('GET', `/os/jobs/${jobId}`)),
  createJob: async (boardId: number, input: Partial<Job> & { card_id: number }) =>
    normalizeCanonicalLifecycleResponse(await api('POST', `/os/boards/${boardId}/jobs`, input)),
  cancelJob: (jobId: OsId) => api('POST', `/os/jobs/${jobId}/cancel`),
  listConflicts: async (boardId: number) =>
    unwrapList<WorkspaceConflict>(await api('GET', `/os/boards/${boardId}/conflicts`), ['conflicts']),
  listDrivers: async () => unwrapList<DriverCapability>(await api('GET', '/os/drivers'), ['drivers']),
  listAgentProviders: async () => unwrapList<AgentProviderCatalog>(await api('GET', '/os/providers'), ['providers']),
  listPlugins: async () => unwrapList<PluginDescriptor>(await api('GET', '/os/plugins'), ['plugins']),
  getAgentDefaults: async () =>
    unwrapEntity<AgentDefaults>(await api('GET', '/os/settings/agent-defaults'), ['defaults']),
  saveAgentDefaults: async (defaults: AgentDefaults) =>
    unwrapEntity<AgentDefaults>(await api('PUT', '/os/settings/agent-defaults', defaults), ['defaults']),
}
