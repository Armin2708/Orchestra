import type {
  BriefPreview,
  ContractCriterion,
  ContractDraft,
  ContractEnvelope,
  ContractValidation,
  OpenWorkFilters,
  OpenWorkGraph,
  OpenWorkItem,
  OpenWorkResponse,
  RequiredArtifact,
} from './openWorkApi'

export type OpenWorkRemoteState = {
  phase: 'idle' | 'loading' | 'ready' | 'error'
  items: OpenWorkItem[]
  graph: OpenWorkGraph
  error: string | null
  stale: boolean
  conflict: string | null
}

export type OpenWorkRemoteAction =
  | { type: 'load' }
  | { type: 'loaded'; response: OpenWorkResponse }
  | { type: 'failed'; error: string }
  | { type: 'conflict'; error: string }
  | { type: 'clear-conflict' }

const emptyGraph = (): OpenWorkGraph => ({ nodes: [], edges: [] })
const compareText = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0

export const initialOpenWorkState = (
  response?: OpenWorkResponse,
): OpenWorkRemoteState => response
  ? {
      phase: 'ready',
      items: stableOpenWorkItems(response.items),
      graph: stableOpenWorkGraph(response.graph),
      error: null,
      stale: false,
      conflict: null,
    }
  : {
      phase: 'idle',
      items: [],
      graph: emptyGraph(),
      error: null,
      stale: false,
      conflict: null,
    }

export const openWorkReducer = (
  state: OpenWorkRemoteState,
  action: OpenWorkRemoteAction,
): OpenWorkRemoteState => {
  switch (action.type) {
    case 'load':
      return {
        ...state,
        phase: 'loading',
        error: null,
        stale: false,
      }
    case 'loaded':
      return {
        phase: 'ready',
        items: stableOpenWorkItems(action.response.items),
        graph: stableOpenWorkGraph(action.response.graph),
        error: null,
        stale: false,
        conflict: null,
      }
    case 'failed':
      return state.items.length
        ? {
            ...state,
            phase: 'ready',
            error: action.error,
            stale: true,
          }
        : {
            ...state,
            phase: 'error',
            error: action.error,
            stale: false,
          }
    case 'conflict':
      return {
        ...state,
        conflict: action.error,
        stale: true,
      }
    case 'clear-conflict':
      return {
        ...state,
        conflict: null,
      }
    default:
      return state
  }
}

export const stableOpenWorkItems = (items: OpenWorkItem[]): OpenWorkItem[] =>
  [...items].sort((left, right) =>
    Number(left.dependency_readiness === 'blocked') - Number(right.dependency_readiness === 'blocked')
    || right.priority - left.priority
    || compareText(left.repository, right.repository)
    || compareText(left.title, right.title)
    || left.card_id - right.card_id)

export const stableOpenWorkGraph = (graph: OpenWorkGraph): OpenWorkGraph => ({
  nodes: [...graph.nodes].sort((left, right) =>
    left.board_id - right.board_id
    || left.card_id - right.card_id),
  edges: [...graph.edges].sort((left, right) =>
    left.from_card_id - right.from_card_id
    || left.to_card_id - right.to_card_id
    || compareText(left.blocking_reason, right.blocking_reason)),
})

const savedViewValues = (value: string | undefined) => new Set(
  (value ?? '').split(',').map((item) => item.trim().toLocaleLowerCase()).filter(Boolean),
)

export const filterOpenWorkResponse = (
  response: OpenWorkResponse,
  options: {
    boardId: number | null
    query?: string
    filters?: Readonly<Record<string, string>>
  },
): OpenWorkResponse => {
  const boardItems = options.boardId === null
    ? response.items
    : response.items.filter((item) => item.board_id === options.boardId)
  const boardNodes = options.boardId === null
    ? response.graph.nodes
    : response.graph.nodes.filter((node) => node.board_id === options.boardId)
  const boardCardIds = new Set([
    ...boardItems.map((item) => item.card_id),
    ...boardNodes.map((node) => node.card_id),
  ])
  const safeItems = boardItems.map((item) => ({
    ...item,
    dependencies: item.dependencies.filter((dependency) => boardCardIds.has(dependency.card_id)),
    critical_path: item.critical_path.map((path) => ({
      ...path,
      path: path.path.filter((node) => boardCardIds.has(node.card_id)),
    })).filter((path) => path.path.length > 0),
  }))
  const terms = (options.query ?? '').trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  const filters = options.filters ?? {}
  const supportedFilterKeys = new Set(['status'])
  const unknownFilter = Object.entries(filters)
    .some(([key, value]) => value.trim() && !supportedFilterKeys.has(key))
  const statuses = savedViewValues(filters.status)
  const items = unknownFilter ? [] : safeItems.filter((item) => {
    const matchesStatus = statuses.size === 0
      || statuses.has(item.status)
      || statuses.has(item.dependency_readiness)
    if (!matchesStatus) return false
    if (terms.length === 0) return true
    const haystack = [
      item.title,
      item.repository,
      item.selected_agent?.name ?? '',
      ...item.constraints.required_capabilities,
    ].join(' ').toLocaleLowerCase()
    return terms.every((term) => haystack.includes(term))
  })
  const visibleCardIds = new Set(items.flatMap((item) => [
    item.card_id,
    ...item.dependencies.map((dependency) => dependency.card_id),
    ...item.critical_path.flatMap((path) => path.path.map((node) => node.card_id)),
  ]))
  return {
    items,
    graph: {
      nodes: boardNodes.filter((node) => visibleCardIds.has(node.card_id)),
      edges: response.graph.edges.filter((edge) =>
        boardCardIds.has(edge.from_card_id)
        && boardCardIds.has(edge.to_card_id)
        && visibleCardIds.has(edge.from_card_id)
        && visibleCardIds.has(edge.to_card_id)),
    },
  }
}

export type FilterChip = {
  key: string
  label: string
  value: string
}

export const activeFilterChips = (filters: OpenWorkFilters): FilterChip[] => {
  const chips: FilterChip[] = []
  if (filters.repository.trim()) {
    chips.push({ key: 'repository', label: 'Repository', value: filters.repository.trim() })
  }
  for (const capability of [...new Set(filters.capabilities.map((value) => value.trim()).filter(Boolean))]
    .sort(compareText)) {
    chips.push({ key: `capability:${capability}`, label: 'Capability', value: capability })
  }
  if (filters.priority !== null) {
    chips.push({ key: 'priority', label: 'Priority', value: String(filters.priority) })
  }
  if (filters.dependencyReadiness !== null) {
    chips.push({
      key: 'dependency',
      label: 'Dependencies',
      value: filters.dependencyReadiness,
    })
  }
  if (filters.maxTokens !== null) {
    chips.push({ key: 'tokens', label: 'Token ceiling', value: formatInteger(filters.maxTokens) })
  }
  if (filters.maxCostCents !== null) {
    chips.push({
      key: 'cost',
      label: 'Cost ceiling',
      value: formatCents(filters.maxCostCents),
    })
  }
  if (filters.maxTimeSeconds !== null) {
    chips.push({
      key: 'time',
      label: 'Time ceiling',
      value: formatDuration(filters.maxTimeSeconds),
    })
  }
  return chips
}

export const openWorkCounts = (items: OpenWorkItem[]) => ({
  total: items.length,
  ready: items.filter((item) => item.dependency_readiness === 'ready').length,
  blocked: items.filter((item) => item.dependency_readiness === 'blocked').length,
  matched: items.filter((item) => item.selected_agent !== null).length,
})

export const repositoryOptions = (items: OpenWorkItem[]) => [...new Set(
  items.map((item) => item.repository.trim()).filter(Boolean),
)].sort(compareText)

export const capabilityOptions = (items: OpenWorkItem[]) => [...new Set(
  items.flatMap((item) => item.constraints.required_capabilities),
)].sort(compareText)

export const splitListInput = (value: string): string[] => [...new Set(
  value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean),
)].sort(compareText)

export const reconcileRequiredArtifacts = (
  existing: RequiredArtifact[],
  value: string,
): RequiredArtifact[] => {
  const available = new Map<string, RequiredArtifact[]>()
  for (const artifact of existing) {
    const bucket = available.get(artifact.kind) ?? []
    bucket.push(artifact)
    available.set(artifact.kind, bucket)
  }
  return value
    .split(/[\n,]/)
    .map((kind) => kind.trim())
    .filter(Boolean)
    .map((kind) => {
      const preserved = available.get(kind)?.shift()
      return preserved
        ? { ...preserved }
        : { kind, name: null, description: null }
    })
}

export const formatInteger = (value: number | null): string =>
  value === null ? 'Not set' : new Intl.NumberFormat('en-US').format(value)

export const formatCents = (value: number | null): string =>
  value === null ? 'Not set' : new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(value / 100)

export const formatDuration = (seconds: number | null): string => {
  if (seconds === null) return 'Not set'
  if (seconds % 3600 === 0) return `${seconds / 3600}h`
  if (seconds % 60 === 0) return `${seconds / 60}m`
  return `${seconds}s`
}

const cloneRecord = (value: Record<string, unknown>) => structuredClone(value)

const cloneCriterion = (criterion: ContractCriterion): ContractCriterion => ({
  ...criterion,
  deliverable_ids: [...criterion.deliverable_ids],
  metadata: cloneRecord(criterion.metadata),
  verifier: { ...criterion.verifier },
  required_artifacts: criterion.required_artifacts.map((artifact) => ({ ...artifact })),
})

export const contractDraftFromEnvelope = (envelope: ContractEnvelope): ContractDraft => {
  const { contract, job_market: market } = envelope
  return {
    objective: contract.objective,
    deliverables: contract.deliverables.map((deliverable) => ({
      ...deliverable,
      metadata: cloneRecord(deliverable.metadata),
    })),
    acceptance_criteria: market.criteria.map(cloneCriterion),
    dependency_rules: market.dependency_rules.map((dependency) => ({ ...dependency })),
    base_ref: contract.base_ref,
    verify_commands: [...contract.verify_commands],
    non_goals: [...contract.non_goals],
    risks: [...contract.risks],
    required_capabilities: [...market.constraints.required_capabilities],
    provider_constraints: [...market.constraints.provider_constraints],
    model_constraints: [...market.constraints.model_constraints],
    access_needs: [...market.constraints.access_needs],
    budget_tokens: market.budgets.tokens,
    budget_cents: market.budgets.cost_cents,
    budget_time_seconds: market.budgets.time_seconds,
    budget_retries: market.budgets.retries,
    budget_coordination_tokens: market.budgets.coordination_tokens,
    budget_coordination_messages: market.budgets.coordination_messages,
    priority: contract.priority,
    policy_id: contract.policy_id,
    workspace_id: contract.workspace_id,
  }
}

const cleanStrings = (values: string[]) => [...new Set(
  values.map((value) => value.trim()).filter(Boolean),
)]

export const prepareContractDraft = (draft: ContractDraft): ContractDraft => ({
  ...draft,
  deliverables: draft.deliverables.map((deliverable) => ({
    ...deliverable,
    metadata: cloneRecord(deliverable.metadata),
  })),
  acceptance_criteria: draft.acceptance_criteria.map((criterion) => ({
    ...cloneCriterion(criterion),
    deliverable_ids: cleanStrings(criterion.deliverable_ids),
  })),
  dependency_rules: draft.dependency_rules.map((dependency) => ({ ...dependency })),
  verify_commands: cleanStrings(draft.verify_commands),
  non_goals: cleanStrings(draft.non_goals),
  risks: cleanStrings(draft.risks),
  required_capabilities: cleanStrings(draft.required_capabilities),
  provider_constraints: cleanStrings(draft.provider_constraints),
  model_constraints: cleanStrings(draft.model_constraints),
  access_needs: [...new Set(draft.access_needs)],
})

export const nextStableId = (prefix: string, existingIds: string[]): string => {
  const used = new Set(existingIds)
  let sequence = 1
  while (used.has(`${prefix}-${sequence}`)) sequence += 1
  return `${prefix}-${sequence}`
}

export const createDeliverable = (draft: ContractDraft) => ({
  id: nextStableId('deliverable', draft.deliverables.map((item) => item.id)),
  text: '',
  required: true,
  metadata: {},
})

export const createCriterion = (draft: ContractDraft): ContractCriterion => ({
  id: nextStableId('criterion', draft.acceptance_criteria.map((item) => item.id)),
  text: '',
  required: true,
  deliverable_ids: draft.deliverables[0] ? [draft.deliverables[0].id] : [],
  metadata: {},
  description: '',
  verifier: { kind: 'human' },
  required_artifacts: [],
  priority: draft.priority,
  owner: null,
})

export const createDependencyRule = (): ContractDraft['dependency_rules'][number] => ({
  card_id: 0,
  blocking_reason: '',
  completion_condition: 'card_done',
})

export type ContractDraftErrors = Record<string, string[]>

const addError = (errors: ContractDraftErrors, field: string, message: string) => {
  errors[field] = [...(errors[field] ?? []), message]
}

const validateStableRecords = (
  values: Array<{ id: string; text: string }>,
  group: 'deliverables' | 'criteria',
  errors: ContractDraftErrors,
) => {
  const seen = new Set<string>()
  values.forEach((value, index) => {
    const id = value.id.trim()
    const field = `${group}.${id || index}`
    if (!id) addError(errors, field, 'A stable ID is required.')
    else if (seen.has(id)) addError(errors, group, `Stable ID ${id} is duplicated.`)
    else seen.add(id)
    if (!value.text.trim()) addError(errors, `${field}.text`, 'Description is required.')
  })
}

const validateBudget = (
  value: number | null,
  field: keyof Pick<ContractDraft,
    'budget_tokens' | 'budget_cents' | 'budget_time_seconds' | 'budget_retries'
    | 'budget_coordination_tokens' | 'budget_coordination_messages'>,
  errors: ContractDraftErrors,
) => {
  const minimum = field === 'budget_retries' ? 0 : 1
  if (value !== null && (!Number.isSafeInteger(value) || value < minimum)) {
    addError(
      errors,
      `budgets.${field}`,
      field === 'budget_retries'
        ? 'Use a non-negative whole number or leave this blank.'
        : 'Use a positive whole number or leave this blank.',
    )
  }
}

export const validateContractDraft = (draft: ContractDraft): ContractDraftErrors => {
  const errors: ContractDraftErrors = {}
  if (!draft.objective.trim()) addError(errors, 'objective', 'Objective is required.')
  if (!draft.deliverables.length) {
    addError(errors, 'deliverables', 'At least one deliverable is required.')
  }
  validateStableRecords(draft.deliverables, 'deliverables', errors)
  if (!draft.acceptance_criteria.length) {
    addError(errors, 'criteria', 'At least one acceptance criterion is required.')
  }
  validateStableRecords(draft.acceptance_criteria, 'criteria', errors)

  const deliverableIds = new Set(draft.deliverables.map((item) => item.id))
  for (const [index, criterion] of draft.acceptance_criteria.entries()) {
    const field = `criteria.${criterion.id || index}`
    if (!criterion.description.trim()) {
      addError(errors, `${field}.description`, 'Verification description is required.')
    }
    if (!Number.isSafeInteger(criterion.priority)
      || criterion.priority < -1_000
      || criterion.priority > 1_000) {
      addError(errors, `${field}.priority`, 'Priority must be a whole number from -1000 to 1000.')
    }
    for (const deliverableId of criterion.deliverable_ids) {
      if (!deliverableIds.has(deliverableId)) {
        addError(errors, `${field}.deliverable_ids`, `Deliverable ${deliverableId} does not exist.`)
      }
    }
    if (criterion.verifier.kind === 'command' && !criterion.verifier.command?.trim()) {
      addError(errors, `${field}.verifier`, 'A command verifier needs an exact command.')
    }
    if (criterion.verifier.kind === 'artifact' && !criterion.verifier.artifact_kind?.trim()) {
      addError(errors, `${field}.verifier`, 'An artifact verifier needs an artifact kind.')
    }
    criterion.required_artifacts.forEach((artifact, artifactIndex) => {
      if (!artifact.kind.trim()) {
        addError(errors, `${field}.artifacts.${artifactIndex}`, 'Artifact kind is required.')
      }
    })
  }

  const dependencyIds = new Set<number>()
  draft.dependency_rules.forEach((dependency, index) => {
    const field = `dependencies.${dependency.card_id || index}`
    if (!Number.isSafeInteger(dependency.card_id) || dependency.card_id <= 0) {
      addError(errors, `${field}.card_id`, 'Dependency card ID must be a positive whole number.')
    } else if (dependencyIds.has(dependency.card_id)) {
      addError(errors, 'dependencies', `Dependency ${dependency.card_id} is duplicated.`)
    } else {
      dependencyIds.add(dependency.card_id)
    }
    if (!dependency.blocking_reason.trim()) {
      addError(errors, `${field}.blocking_reason`, 'Blocking reason is required.')
    }
    if (dependency.completion_condition !== 'card_done') {
      addError(errors, `${field}.completion_condition`, 'Only the card_done condition is supported.')
    }
  })

  if (!Number.isSafeInteger(draft.priority)) {
    addError(errors, 'priority', 'Priority must be a whole number.')
  }
  validateBudget(draft.budget_tokens, 'budget_tokens', errors)
  validateBudget(draft.budget_cents, 'budget_cents', errors)
  validateBudget(draft.budget_time_seconds, 'budget_time_seconds', errors)
  validateBudget(draft.budget_retries, 'budget_retries', errors)
  validateBudget(draft.budget_coordination_tokens, 'budget_coordination_tokens', errors)
  validateBudget(draft.budget_coordination_messages, 'budget_coordination_messages', errors)
  return errors
}

export const contractDraftReady = (draft: ContractDraft) =>
  Object.keys(validateContractDraft(draft)).length === 0

export const firstFieldError = (
  errors: ContractDraftErrors,
  field: string,
): string | null => errors[field]?.[0] ?? null

export const mapBackendValidation = (
  validation: Pick<ContractValidation, 'errors' | 'warnings'>,
): ContractDraftErrors => {
  const mapped: ContractDraftErrors = {}
  for (const message of validation.errors) {
    const criterion = message.match(/criterion ([^\s]+)/i)?.[1]
    const dependency = message.match(/dependency (\d+)/i)?.[1]
    const lower = message.toLowerCase()
    if (criterion) addError(mapped, `criteria.${criterion}`, message)
    else if (dependency) addError(mapped, `dependencies.${dependency}`, message)
    else if (lower.includes('objective')) addError(mapped, 'objective', message)
    else if (lower.includes('deliverable')) addError(mapped, 'deliverables', message)
    else if (/provider|model|access|capabilit/.test(lower)) addError(mapped, 'constraints', message)
    else if (/budget|token|cost|time|retr|coordination/.test(lower)) addError(mapped, 'budgets', message)
    else addError(mapped, 'form', message)
  }
  for (const message of validation.warnings) addError(mapped, 'warnings', message)
  return mapped
}

export const previewIsCurrent = (
  preview: BriefPreview | null,
  previewSourceMarketVersion: number | null,
  currentMarketVersion: number,
  draftRevision: number,
  previewRevision: number,
) => preview !== null
  && previewSourceMarketVersion === currentMarketVersion
  && draftRevision === 0
  && previewRevision === draftRevision

export const contractEditorStatus = (
  draft: ContractDraft,
  preview: BriefPreview | null,
  previewSourceMarketVersion: number | null,
  currentMarketVersion: number,
  draftRevision: number,
  previewRevision: number,
) => {
  const localErrors = validateContractDraft(draft)
  const localReady = Object.keys(localErrors).length === 0
  const dirty = draftRevision > 0
  const previewCurrent = previewIsCurrent(
    preview,
    previewSourceMarketVersion,
    currentMarketVersion,
    draftRevision,
    previewRevision,
  )
  return {
    localErrors,
    localReady,
    dirty,
    previewCurrent,
    publishReady: localReady && previewCurrent && preview!.validation.valid,
  }
}

export const contractVersionIsStale = (
  cachedMarketVersion: number | null,
  queueMarketVersion: number,
) => cachedMarketVersion !== null && cachedMarketVersion !== queueMarketVersion

export const isMatchStale = (
  matchVersion: number | null,
  selectedItem: OpenWorkItem | null,
) => matchVersion !== null
  && (selectedItem === null || selectedItem.market_version !== matchVersion)

export const safeRecordValue = (
  value: Record<string, unknown>,
  key: string,
): string | null => {
  const candidate = value[key]
  if (typeof candidate === 'string') return candidate
  if (typeof candidate === 'number' && Number.isFinite(candidate)) return String(candidate)
  return null
}
