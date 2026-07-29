import { getToken } from './api'

export type DependencyReadiness = 'ready' | 'blocked'
export type ContractAccessNeed = 'read_only' | 'workspace_write' | 'full_access'
export type ContractVerifierKind = 'command' | 'artifact' | 'human' | 'custom'
export type JobMarketStatus =
  | 'draft'
  | 'open'
  | 'assigned'
  | 'running'
  | 'submitted'
  | 'accepted'
  | 'rejected'
  | 'cancelled'
  | 'archived'

export type OpenWorkFilters = {
  repository: string
  capabilities: string[]
  priority: number | null
  dependencyReadiness: DependencyReadiness | null
  maxTokens: number | null
  maxCostCents: number | null
  maxTimeSeconds: number | null
}

export type OpenWorkConstraints = {
  required_capabilities: string[]
  provider_constraints: string[]
  model_constraints: string[]
  access_needs: ContractAccessNeed[]
}

export type OpenWorkBudgets = {
  tokens: number | null
  cost_cents: number | null
  time_seconds: number | null
  retries: number | null
  coordination_tokens: number | null
  coordination_messages: number | null
}

export type OpenWorkAgentCapacity = {
  active: number
  limit: number
  available: number
}

export type OpenWorkAgent = {
  profile_id: string
  name: string
  provider: string | null
  model: string | null
  access_profile: ContractAccessNeed | null
  workspace_id: string | null
  capabilities: string[]
  eligible: boolean
  ineligibility_reasons: string[]
  capacity: OpenWorkAgentCapacity
}

export type OpenWorkDependency = {
  card_id: number
  title: string
  state: string
  blocking_reason: string
  completion_condition: 'card_done'
  readiness: DependencyReadiness
}

export type OpenWorkCriticalPathNode = {
  card_id: number
  title: string
  state: string
  blocking_reason: string | null
}

export type OpenWorkCriticalPath = {
  path: OpenWorkCriticalPathNode[]
  terminal: 'incomplete' | 'cycle' | 'invalid'
}

export type OpenWorkItem = {
  card_id: number
  board_id: number
  title: string
  repository: string
  status: 'open'
  market_version: number
  priority: number
  constraints: OpenWorkConstraints
  budgets: OpenWorkBudgets
  dependency_readiness: DependencyReadiness
  dependencies: OpenWorkDependency[]
  critical_path: OpenWorkCriticalPath[]
  eligible_agent_count: number
  selected_agent: OpenWorkAgent | null
}

export type OpenWorkGraphNode = {
  card_id: number
  board_id: number
  title: string
  state: string
  readiness: DependencyReadiness
  blocking_reasons: string[]
}

export type OpenWorkGraphEdge = {
  from_card_id: number
  to_card_id: number
  blocking_reason: string
  completion_condition: 'card_done'
  readiness: DependencyReadiness
}

export type OpenWorkGraph = {
  nodes: OpenWorkGraphNode[]
  edges: OpenWorkGraphEdge[]
}

export type OpenWorkResponse = {
  items: OpenWorkItem[]
  graph: OpenWorkGraph
}

export type ContractDeliverable = {
  id: string
  text: string
  required: boolean
  metadata: Record<string, unknown>
}

export type CriterionVerifier = {
  kind: ContractVerifierKind
  command?: string
  artifact_kind?: string
  instructions?: string
}

export type RequiredArtifact = {
  kind: string
  name: string | null
  description: string | null
}

export type ContractCriterion = {
  id: string
  text: string
  required: boolean
  deliverable_ids: string[]
  metadata: Record<string, unknown>
  description: string
  verifier: CriterionVerifier
  required_artifacts: RequiredArtifact[]
  priority: number
  owner: string | null
}

export type ContractDependencyRule = {
  card_id: number
  blocking_reason: string
  completion_condition: 'card_done'
}

export type TaskContract = {
  card_id: number
  objective: string
  deliverables: ContractDeliverable[]
  acceptance_criteria: Array<Omit<ContractCriterion,
    'description' | 'verifier' | 'required_artifacts' | 'priority' | 'owner'>>
  dependencies: number[]
  base_ref: string | null
  verify_commands: string[]
  non_goals: string[]
  risks: string[]
  budget_tokens: number | null
  budget_cents: number | null
  priority: number
  policy_id: string | null
  workspace_id: string | null
  version: number
  updated_at: string
}

export type JobMarketContract = {
  card_id: number
  status: JobMarketStatus
  market_version: number
  contract: TaskContract
  criteria: ContractCriterion[]
  dependency_rules: ContractDependencyRule[]
  constraints: OpenWorkConstraints
  budgets: OpenWorkBudgets
  published_at: string | null
  archived_at: string | null
  created_at: string
  updated_at: string
}

export type ContractValidation = {
  mode: 'publish' | 'launch'
  valid: boolean
  errors: string[]
  warnings: string[]
}

export type ContractEnvelope = {
  contract: TaskContract
  job_market: JobMarketContract
}

export type ContractDraft = {
  objective: string
  deliverables: ContractDeliverable[]
  acceptance_criteria: ContractCriterion[]
  dependency_rules: ContractDependencyRule[]
  base_ref: string | null
  verify_commands: string[]
  non_goals: string[]
  risks: string[]
  required_capabilities: string[]
  provider_constraints: string[]
  model_constraints: string[]
  access_needs: ContractAccessNeed[]
  budget_tokens: number | null
  budget_cents: number | null
  budget_time_seconds: number | null
  budget_retries: number | null
  budget_coordination_tokens: number | null
  budget_coordination_messages: number | null
  priority: number
  policy_id: string | null
  workspace_id: string | null
}

export type BriefPreview = {
  job_market: JobMarketContract
  validation: ContractValidation
  agent_brief: string
  agent_brief_sha256: string
}

export type OpenWorkMatch = {
  card_id: number
  board_id: number
  market_version: number
  eligible: boolean
  eligible_agent_count: number
  selected_agent: OpenWorkAgent | null
  candidates: OpenWorkAgent[]
  global_capacity: OpenWorkAgentCapacity
  decision_sha256: string | null
}

export type DispatchMatchInput = {
  card_id: number
  market_version: number
  profile_id: string
  provider: string
  model: string
  access_profile: ContractAccessNeed
  workspace_id: string
  decision_sha256: string
}

export type OpenWorkDispatch = {
  replayed: boolean
  match: OpenWorkMatch
  assignment: Record<string, unknown>
  job: Record<string, unknown>
  dispatch: Record<string, unknown>
  agent_brief: string
  agent_brief_sha256: string
}

export class OpenWorkApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly detail: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'OpenWorkApiError'
  }
}

export class OpenWorkProtocolError extends Error {
  constructor(message: string) {
    super(`Invalid Open Work response: ${message}`)
    this.name = 'OpenWorkProtocolError'
  }
}

const emptyFilters: OpenWorkFilters = {
  repository: '',
  capabilities: [],
  priority: null,
  dependencyReadiness: null,
  maxTokens: null,
  maxCostCents: null,
  maxTimeSeconds: null,
}

export const defaultOpenWorkFilters = (): OpenWorkFilters => ({
  ...emptyFilters,
  capabilities: [],
})

const stableUnique = (values: string[]) => [...new Set(
  values.map((value) => value.trim()).filter(Boolean),
)].sort((left, right) => left < right ? -1 : left > right ? 1 : 0)

const queryInteger = (value: number | null, name: string, minimum = 0) => {
  if (value === null) return null
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer greater than or equal to ${minimum}`)
  }
  return String(value)
}

export const serializeOpenWorkFilters = (filters: OpenWorkFilters): string => {
  const params = new URLSearchParams()
  const repository = filters.repository.trim()
  if (repository) params.set('repository', repository)
  for (const capability of stableUnique(filters.capabilities)) {
    params.append('capability', capability)
  }
  const priority = queryInteger(filters.priority, 'priority', Number.MIN_SAFE_INTEGER)
  const maxTokens = queryInteger(filters.maxTokens, 'maxTokens')
  const maxCostCents = queryInteger(filters.maxCostCents, 'maxCostCents')
  const maxTimeSeconds = queryInteger(filters.maxTimeSeconds, 'maxTimeSeconds')
  if (priority !== null) params.set('priority', priority)
  if (filters.dependencyReadiness !== null) {
    params.set('dependency_readiness', filters.dependencyReadiness)
  }
  if (maxTokens !== null) params.set('max_tokens', maxTokens)
  if (maxCostCents !== null) params.set('max_cost_cents', maxCostCents)
  if (maxTimeSeconds !== null) params.set('max_time_seconds', maxTimeSeconds)
  return params.toString()
}

const record = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new OpenWorkProtocolError(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

const array = (value: unknown, label: string): unknown[] => {
  if (!Array.isArray(value)) throw new OpenWorkProtocolError(`${label} must be an array`)
  return value
}

const string = (value: unknown, label: string): string => {
  if (typeof value !== 'string') throw new OpenWorkProtocolError(`${label} must be a string`)
  return value
}

const nullableString = (value: unknown, label: string): string | null => {
  if (value === null) return null
  return string(value, label)
}

const boolean = (value: unknown, label: string): boolean => {
  if (typeof value !== 'boolean') throw new OpenWorkProtocolError(`${label} must be a boolean`)
  return value
}

const integer = (value: unknown, label: string, minimum = 0): number => {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    throw new OpenWorkProtocolError(`${label} must be an integer greater than or equal to ${minimum}`)
  }
  return Number(value)
}

const signedInteger = (
  value: unknown,
  label: string,
  minimum = Number.MIN_SAFE_INTEGER,
  maximum = Number.MAX_SAFE_INTEGER,
): number => {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new OpenWorkProtocolError(`${label} must be an integer from ${minimum} to ${maximum}`)
  }
  return Number(value)
}

const nullableInteger = (value: unknown, label: string): number | null => {
  if (value === null) return null
  return integer(value, label)
}

const stringArray = (value: unknown, label: string) =>
  array(value, label).map((item, index) => string(item, `${label}[${index}]`))

const readiness = (value: unknown, label: string): DependencyReadiness => {
  if (value !== 'ready' && value !== 'blocked') {
    throw new OpenWorkProtocolError(`${label} must be ready or blocked`)
  }
  return value
}

const JOB_MARKET_STATUSES: readonly JobMarketStatus[] = [
  'draft',
  'open',
  'assigned',
  'running',
  'submitted',
  'accepted',
  'rejected',
  'cancelled',
  'archived',
]

const jobMarketStatus = (value: unknown, label: string): JobMarketStatus => {
  if (typeof value !== 'string' || !JOB_MARKET_STATUSES.includes(value as JobMarketStatus)) {
    throw new OpenWorkProtocolError(`${label} is not a supported job market status`)
  }
  return value as JobMarketStatus
}

const accessNeed = (value: unknown, label: string): ContractAccessNeed => {
  if (value !== 'read_only' && value !== 'workspace_write' && value !== 'full_access') {
    throw new OpenWorkProtocolError(`${label} is not a supported access profile`)
  }
  return value
}

const accessNeedArray = (value: unknown, label: string) =>
  array(value, label).map((item, index) => accessNeed(item, `${label}[${index}]`))

const sha256 = (value: unknown, label: string) => {
  const digest = string(value, label)
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw new OpenWorkProtocolError(`${label} must be a lowercase SHA-256 digest`)
  }
  return digest
}

const nullableSha256 = (value: unknown, label: string) => {
  if (value === null) return null
  return sha256(value, label)
}

const parseCapacity = (value: unknown, label: string): OpenWorkAgentCapacity => {
  const row = record(value, label)
  return {
    active: integer(row.active, `${label}.active`),
    limit: integer(row.limit, `${label}.limit`),
    available: integer(row.available, `${label}.available`),
  }
}

const parseAgent = (value: unknown, label: string): OpenWorkAgent => {
  const row = record(value, label)
  return {
    profile_id: string(row.profile_id, `${label}.profile_id`),
    name: string(row.name, `${label}.name`),
    provider: nullableString(row.provider, `${label}.provider`),
    model: nullableString(row.model, `${label}.model`),
    access_profile: row.access_profile === null
      ? null
      : accessNeed(row.access_profile, `${label}.access_profile`),
    workspace_id: nullableString(row.workspace_id, `${label}.workspace_id`),
    capabilities: stringArray(row.capabilities, `${label}.capabilities`),
    eligible: boolean(row.eligible, `${label}.eligible`),
    ineligibility_reasons: stringArray(row.ineligibility_reasons, `${label}.ineligibility_reasons`),
    capacity: parseCapacity(row.capacity, `${label}.capacity`),
  }
}

const parseConstraints = (value: unknown, label: string): OpenWorkConstraints => {
  const row = record(value, label)
  return {
    required_capabilities: stringArray(row.required_capabilities, `${label}.required_capabilities`),
    provider_constraints: stringArray(row.provider_constraints, `${label}.provider_constraints`),
    model_constraints: stringArray(row.model_constraints, `${label}.model_constraints`),
    access_needs: accessNeedArray(row.access_needs, `${label}.access_needs`),
  }
}

const parseBudgets = (value: unknown, label: string): OpenWorkBudgets => {
  const row = record(value, label)
  return {
    tokens: nullableInteger(row.tokens, `${label}.tokens`),
    cost_cents: nullableInteger(row.cost_cents, `${label}.cost_cents`),
    time_seconds: nullableInteger(row.time_seconds, `${label}.time_seconds`),
    retries: nullableInteger(row.retries, `${label}.retries`),
    coordination_tokens: nullableInteger(row.coordination_tokens, `${label}.coordination_tokens`),
    coordination_messages: nullableInteger(row.coordination_messages, `${label}.coordination_messages`),
  }
}

const parseDependency = (value: unknown, label: string): OpenWorkDependency => {
  const row = record(value, label)
  if (row.completion_condition !== 'card_done') {
    throw new OpenWorkProtocolError(`${label}.completion_condition must be card_done`)
  }
  return {
    card_id: integer(row.card_id, `${label}.card_id`, 1),
    title: string(row.title, `${label}.title`),
    state: string(row.state, `${label}.state`),
    blocking_reason: string(row.blocking_reason, `${label}.blocking_reason`),
    completion_condition: 'card_done',
    readiness: readiness(row.readiness, `${label}.readiness`),
  }
}

const parseCriticalPathNode = (value: unknown, label: string): OpenWorkCriticalPathNode => {
  const row = record(value, label)
  return {
    card_id: integer(row.card_id, `${label}.card_id`, 1),
    title: string(row.title, `${label}.title`),
    state: string(row.state, `${label}.state`),
    blocking_reason: nullableString(row.blocking_reason, `${label}.blocking_reason`),
  }
}

const parseCriticalPath = (value: unknown, label: string): OpenWorkCriticalPath => {
  const row = record(value, label)
  if (row.terminal !== 'incomplete' && row.terminal !== 'cycle' && row.terminal !== 'invalid') {
    throw new OpenWorkProtocolError(`${label}.terminal must be incomplete, cycle, or invalid`)
  }
  return {
    path: array(row.path, `${label}.path`).map((item, index) =>
      parseCriticalPathNode(item, `${label}.path[${index}]`)),
    terminal: row.terminal,
  }
}

const parseOpenWorkItem = (value: unknown, label: string): OpenWorkItem => {
  const row = record(value, label)
  if (row.status !== 'open') {
    throw new OpenWorkProtocolError(`${label}.status must be open`)
  }
  return {
    card_id: integer(row.card_id, `${label}.card_id`, 1),
    board_id: integer(row.board_id, `${label}.board_id`, 1),
    title: string(row.title, `${label}.title`),
    repository: string(row.repository, `${label}.repository`),
    status: 'open',
    market_version: integer(row.market_version, `${label}.market_version`, 1),
    priority: signedInteger(row.priority, `${label}.priority`),
    constraints: parseConstraints(row.constraints, `${label}.constraints`),
    budgets: parseBudgets(row.budgets, `${label}.budgets`),
    dependency_readiness: readiness(row.dependency_readiness, `${label}.dependency_readiness`),
    dependencies: array(row.dependencies, `${label}.dependencies`).map((item, index) =>
      parseDependency(item, `${label}.dependencies[${index}]`)),
    critical_path: array(row.critical_path, `${label}.critical_path`).map((item, index) =>
      parseCriticalPath(item, `${label}.critical_path[${index}]`)),
    eligible_agent_count: integer(row.eligible_agent_count, `${label}.eligible_agent_count`),
    selected_agent: row.selected_agent === null
      ? null
      : parseAgent(row.selected_agent, `${label}.selected_agent`),
  }
}

const parseGraphNode = (value: unknown, label: string): OpenWorkGraphNode => {
  const row = record(value, label)
  return {
    card_id: integer(row.card_id, `${label}.card_id`, 1),
    board_id: integer(row.board_id, `${label}.board_id`, 1),
    title: string(row.title, `${label}.title`),
    state: string(row.state, `${label}.state`),
    readiness: readiness(row.readiness, `${label}.readiness`),
    blocking_reasons: stringArray(row.blocking_reasons, `${label}.blocking_reasons`),
  }
}

const parseGraphEdge = (value: unknown, label: string): OpenWorkGraphEdge => {
  const row = record(value, label)
  if (row.completion_condition !== 'card_done') {
    throw new OpenWorkProtocolError(`${label}.completion_condition must be card_done`)
  }
  return {
    from_card_id: integer(row.from_card_id, `${label}.from_card_id`, 1),
    to_card_id: integer(row.to_card_id, `${label}.to_card_id`, 1),
    blocking_reason: string(row.blocking_reason, `${label}.blocking_reason`),
    completion_condition: 'card_done',
    readiness: readiness(row.readiness, `${label}.readiness`),
  }
}

export const parseOpenWorkResponse = (value: unknown): OpenWorkResponse => {
  const row = record(value, 'response')
  const graph = record(row.graph, 'response.graph')
  return {
    items: array(row.items, 'response.items').map((item, index) =>
      parseOpenWorkItem(item, `response.items[${index}]`)),
    graph: {
      nodes: array(graph.nodes, 'response.graph.nodes').map((item, index) =>
        parseGraphNode(item, `response.graph.nodes[${index}]`)),
      edges: array(graph.edges, 'response.graph.edges').map((item, index) =>
        parseGraphEdge(item, `response.graph.edges[${index}]`)),
    },
  }
}

const parseVerifier = (value: unknown, label: string): CriterionVerifier => {
  const row = record(value, label)
  if (!['command', 'artifact', 'human', 'custom'].includes(String(row.kind))) {
    throw new OpenWorkProtocolError(`${label}.kind is invalid`)
  }
  const result: CriterionVerifier = {
    kind: row.kind as ContractVerifierKind,
  }
  if (row.command !== undefined) result.command = string(row.command, `${label}.command`)
  if (row.artifact_kind !== undefined) {
    result.artifact_kind = string(row.artifact_kind, `${label}.artifact_kind`)
  }
  if (row.instructions !== undefined) {
    result.instructions = string(row.instructions, `${label}.instructions`)
  }
  return result
}

const parseArtifact = (value: unknown, label: string): RequiredArtifact => {
  const row = record(value, label)
  return {
    kind: string(row.kind, `${label}.kind`),
    name: nullableString(row.name, `${label}.name`),
    description: nullableString(row.description, `${label}.description`),
  }
}

const parseDeliverable = (value: unknown, label: string): ContractDeliverable => {
  const row = record(value, label)
  return {
    id: string(row.id, `${label}.id`),
    text: string(row.text, `${label}.text`),
    required: boolean(row.required, `${label}.required`),
    metadata: record(row.metadata, `${label}.metadata`),
  }
}

const parseBaseCriterion = (value: unknown, label: string) => {
  const row = record(value, label)
  return {
    id: string(row.id, `${label}.id`),
    text: string(row.text, `${label}.text`),
    required: boolean(row.required, `${label}.required`),
    deliverable_ids: stringArray(row.deliverable_ids, `${label}.deliverable_ids`),
    metadata: record(row.metadata, `${label}.metadata`),
  }
}

const parseCriterion = (value: unknown, label: string): ContractCriterion => {
  const row = record(value, label)
  return {
    ...parseBaseCriterion(row, label),
    description: string(row.description, `${label}.description`),
    verifier: parseVerifier(row.verifier, `${label}.verifier`),
    required_artifacts: array(row.required_artifacts, `${label}.required_artifacts`)
      .map((item, index) => parseArtifact(item, `${label}.required_artifacts[${index}]`)),
    priority: signedInteger(row.priority, `${label}.priority`, -1_000, 1_000),
    owner: nullableString(row.owner, `${label}.owner`),
  }
}

const parseDependencyRule = (value: unknown, label: string): ContractDependencyRule => {
  const row = record(value, label)
  if (row.completion_condition !== 'card_done') {
    throw new OpenWorkProtocolError(`${label}.completion_condition must be card_done`)
  }
  return {
    card_id: integer(row.card_id, `${label}.card_id`, 1),
    blocking_reason: string(row.blocking_reason, `${label}.blocking_reason`),
    completion_condition: 'card_done',
  }
}

const parseTaskContract = (value: unknown, label: string): TaskContract => {
  const row = record(value, label)
  return {
    card_id: integer(row.card_id, `${label}.card_id`, 1),
    objective: string(row.objective, `${label}.objective`),
    deliverables: array(row.deliverables, `${label}.deliverables`).map((item, index) =>
      parseDeliverable(item, `${label}.deliverables[${index}]`)),
    acceptance_criteria: array(row.acceptance_criteria, `${label}.acceptance_criteria`)
      .map((item, index) => parseBaseCriterion(item, `${label}.acceptance_criteria[${index}]`)),
    dependencies: array(row.dependencies, `${label}.dependencies`)
      .map((item, index) => integer(item, `${label}.dependencies[${index}]`, 1)),
    base_ref: nullableString(row.base_ref, `${label}.base_ref`),
    verify_commands: stringArray(row.verify_commands, `${label}.verify_commands`),
    non_goals: stringArray(row.non_goals, `${label}.non_goals`),
    risks: stringArray(row.risks, `${label}.risks`),
    budget_tokens: nullableInteger(row.budget_tokens, `${label}.budget_tokens`),
    budget_cents: nullableInteger(row.budget_cents, `${label}.budget_cents`),
    priority: signedInteger(row.priority, `${label}.priority`),
    policy_id: nullableString(row.policy_id, `${label}.policy_id`),
    workspace_id: nullableString(row.workspace_id, `${label}.workspace_id`),
    version: integer(row.version, `${label}.version`, 1),
    updated_at: string(row.updated_at, `${label}.updated_at`),
  }
}

const parseJobMarket = (value: unknown, label: string): JobMarketContract => {
  const row = record(value, label)
  return {
    card_id: integer(row.card_id, `${label}.card_id`, 1),
    status: jobMarketStatus(row.status, `${label}.status`),
    market_version: integer(row.market_version, `${label}.market_version`, 1),
    contract: parseTaskContract(row.contract, `${label}.contract`),
    criteria: array(row.criteria, `${label}.criteria`).map((item, index) =>
      parseCriterion(item, `${label}.criteria[${index}]`)),
    dependency_rules: array(row.dependency_rules, `${label}.dependency_rules`)
      .map((item, index) => parseDependencyRule(item, `${label}.dependency_rules[${index}]`)),
    constraints: parseConstraints(row.constraints, `${label}.constraints`),
    budgets: parseBudgets(row.budgets, `${label}.budgets`),
    published_at: nullableString(row.published_at, `${label}.published_at`),
    archived_at: nullableString(row.archived_at, `${label}.archived_at`),
    created_at: string(row.created_at, `${label}.created_at`),
    updated_at: string(row.updated_at, `${label}.updated_at`),
  }
}

export const parseContractEnvelope = (value: unknown): ContractEnvelope => {
  const row = record(value, 'response')
  const envelope = {
    contract: parseTaskContract(row.contract, 'response.contract'),
    job_market: parseJobMarket(row.job_market, 'response.job_market'),
  }
  if (envelope.contract.card_id !== envelope.job_market.card_id
    || envelope.contract.version !== envelope.job_market.contract.version) {
    throw new OpenWorkProtocolError('contract and job_market identities do not match')
  }
  return envelope
}

const parseValidation = (value: unknown, label: string): ContractValidation => {
  const row = record(value, label)
  if (row.mode !== 'publish' && row.mode !== 'launch') {
    throw new OpenWorkProtocolError(`${label}.mode must be publish or launch`)
  }
  return {
    mode: row.mode,
    valid: boolean(row.valid, `${label}.valid`),
    errors: stringArray(row.errors, `${label}.errors`),
    warnings: stringArray(row.warnings, `${label}.warnings`),
  }
}

export const parseBriefPreview = (value: unknown): BriefPreview => {
  const response = record(value, 'response')
  const row = record(response.preview, 'response.preview')
  return {
    job_market: parseJobMarket(row.job_market, 'response.preview.job_market'),
    validation: parseValidation(row.validation, 'response.preview.validation'),
    // These two values are deliberately returned byte-for-byte from JSON parsing.
    agent_brief: string(row.agent_brief, 'response.preview.agent_brief'),
    agent_brief_sha256: sha256(row.agent_brief_sha256, 'response.preview.agent_brief_sha256'),
  }
}

const parseMatch = (value: unknown, label: string): OpenWorkMatch => {
  const row = record(value, label)
  return {
    card_id: integer(row.card_id, `${label}.card_id`, 1),
    board_id: integer(row.board_id, `${label}.board_id`, 1),
    market_version: integer(row.market_version, `${label}.market_version`, 1),
    eligible: boolean(row.eligible, `${label}.eligible`),
    eligible_agent_count: integer(row.eligible_agent_count, `${label}.eligible_agent_count`),
    selected_agent: row.selected_agent === null ? null : parseAgent(row.selected_agent, `${label}.selected_agent`),
    candidates: array(row.candidates, `${label}.candidates`).map((item, index) =>
      parseAgent(item, `${label}.candidates[${index}]`)),
    global_capacity: parseCapacity(row.global_capacity, `${label}.global_capacity`),
    decision_sha256: nullableSha256(row.decision_sha256, `${label}.decision_sha256`),
  }
}

export const parseMatchResponse = (value: unknown): OpenWorkMatch => {
  const row = record(value, 'response')
  return parseMatch(row.match, 'response.match')
}

export const parseDispatchResponse = (value: unknown): OpenWorkDispatch => {
  const row = record(value, 'response')
  const assignment = record(row.assignment, 'response.assignment')
  const job = record(row.job, 'response.job')
  const hasEntityId = (entity: Record<string, unknown>) =>
    (typeof entity.id === 'string' && entity.id.length > 0)
    || (typeof entity.id === 'number' && Number.isSafeInteger(entity.id) && entity.id > 0)
  if (!hasEntityId(assignment)) {
    throw new OpenWorkProtocolError('response.assignment must contain one durable id')
  }
  if (!hasEntityId(job)) {
    throw new OpenWorkProtocolError('response.job must contain exactly one durable job id')
  }
  return {
    replayed: boolean(row.replayed, 'response.replayed'),
    match: parseMatch(row.match, 'response.match'),
    assignment,
    job,
    dispatch: record(row.dispatch, 'response.dispatch'),
    // A dispatch brief is the realized backend brief. It is never reconstructed here.
    agent_brief: string(row.agent_brief, 'response.agent_brief'),
    agent_brief_sha256: sha256(row.agent_brief_sha256, 'response.agent_brief_sha256'),
  }
}

const responseError = async (response: Response): Promise<OpenWorkApiError> => {
  const text = await response.text()
  let detail: Record<string, unknown> = {}
  try {
    detail = record(JSON.parse(text), 'error response')
  } catch (error) {
    if (error instanceof OpenWorkProtocolError || error instanceof SyntaxError) detail = {}
    else throw error
  }
  const message = typeof detail.error === 'string'
    ? detail.error
    : text || `Request failed (${response.status})`
  const code = typeof detail.code === 'string' ? detail.code : 'request_failed'
  return new OpenWorkApiError(response.status, code, message, detail)
}

const requestJson = async (
  method: string,
  path: string,
  body?: unknown,
  options: { idempotencyKey?: string } = {},
): Promise<unknown> => {
  const headers: Record<string, string> = {}
  const token = typeof localStorage === 'undefined' ? '' : getToken()
  if (token) headers.authorization = `Bearer ${token}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey
  const response = await fetch(`/api/v1${path}`, {
    method,
    headers: Object.keys(headers).length ? headers : undefined,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!response.ok) throw await responseError(response)
  return await response.json()
}

export const dispatchInputFromMatch = (match: OpenWorkMatch): DispatchMatchInput => {
  const selected = match.selected_agent
  if (!match.eligible || !selected || !selected.eligible
    || !selected.provider || !selected.model || !selected.access_profile || !selected.workspace_id
    || !match.decision_sha256) {
    throw new Error('A dispatch requires one explicitly selected eligible agent with complete provider, access, workspace, and decision evidence.')
  }
  return {
    card_id: match.card_id,
    market_version: match.market_version,
    profile_id: selected.profile_id,
    provider: selected.provider,
    model: selected.model,
    access_profile: selected.access_profile,
    workspace_id: selected.workspace_id,
    decision_sha256: match.decision_sha256,
  }
}

export const createDispatchIdempotencyKey = (
  cardId: number,
  decisionSha256: string,
  nonce = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`,
) => `open-work:dispatch:${cardId}:${decisionSha256.slice(0, 12)}:${nonce}`

export type OpenWorkClient = {
  list: (filters: OpenWorkFilters) => Promise<OpenWorkResponse>
  getContract: (cardId: number) => Promise<ContractEnvelope>
  updateContract: (
    cardId: number,
    draft: ContractDraft,
    expectedMarketVersion: number,
  ) => Promise<ContractEnvelope>
  previewBrief: (
    cardId: number,
    draft: ContractDraft,
    expectedMarketVersion: number,
  ) => Promise<BriefPreview>
  publishContract: (cardId: number, expectedMarketVersion: number) => Promise<ContractEnvelope>
  match: (cardId: number, expectedMarketVersion: number) => Promise<OpenWorkMatch>
  dispatch: (
    cardId: number,
    match: OpenWorkMatch,
    idempotencyKey: string,
  ) => Promise<OpenWorkDispatch>
}

export const openWorkApi: OpenWorkClient = {
  list: async (filters) => {
    const query = serializeOpenWorkFilters(filters)
    return parseOpenWorkResponse(await requestJson('GET', `/os/open-work${query ? `?${query}` : ''}`))
  },
  getContract: async (cardId) =>
    parseContractEnvelope(await requestJson('GET', `/os/cards/${cardId}/contract`)),
  updateContract: async (cardId, draft, expectedMarketVersion) =>
    parseContractEnvelope(await requestJson('PUT', `/os/cards/${cardId}/contract`, {
      ...draft,
      expected_market_version: expectedMarketVersion,
      actor: 'human',
    })),
  previewBrief: async (cardId, draft, expectedMarketVersion) =>
    parseBriefPreview(await requestJson('POST', `/os/cards/${cardId}/contract/brief-preview`, {
      contract: draft,
      expected_market_version: expectedMarketVersion,
    })),
  publishContract: async (cardId, expectedMarketVersion) =>
    parseContractEnvelope(await requestJson('POST', `/os/cards/${cardId}/contract/publish`, {
      actor: 'human',
      expected_market_version: expectedMarketVersion,
    })),
  match: async (cardId, expectedMarketVersion) =>
    parseMatchResponse(await requestJson('POST', `/os/cards/${cardId}/open-work/match`, {
      expected_market_version: expectedMarketVersion,
    })),
  dispatch: async (cardId, match, idempotencyKey) =>
    parseDispatchResponse(await requestJson('POST', `/os/cards/${cardId}/open-work/dispatch`, {
      match: dispatchInputFromMatch(match),
      confirm: true,
    }, { idempotencyKey })),
}
