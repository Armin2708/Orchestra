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
  context_json?: string | JsonObject | null
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

export type AcceptanceCriterion = string | {
  id?: string
  text: string
  met?: boolean | 'unverifiable'
  evidence?: string
}

export type TaskContract = {
  card_id: number
  objective: string
  acceptance_criteria: AcceptanceCriterion[] | string
  dependencies: Array<number | string> | string
  base_ref: string | null
  verify_commands: string[] | string
  budget_tokens: number | null
  budget_cents: number | null
  priority: number
  policy_id: OsId | null
  workspace_id: OsId | null
  updated_at: string
}

export type OsEvent = {
  id: OsId
  board_id: number
  workspace_id: OsId | null
  card_id: number | null
  session_id: OsId | null
  process_id: OsId | null
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

export type Job = {
  id: OsId
  board_id: number
  card_id: number | null
  workspace_id: OsId | null
  provider: string
  model: string | null
  priority: number
  status: string
  attempts: number
  max_attempts: number
  budget_tokens: number | null
  budget_cents: number | null
  scheduled_at: string
  started_at: string | null
  finished_at: string | null
  error: string | null
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
  health?: 'ready' | 'degraded' | 'unavailable' | string
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
  createProcess: async (workspaceId: OsId, input: {
    name?: string; command: string; cwd?: string; env?: Record<string, string>; cols?: number; rows?: number; restartable?: boolean
  }) => normalizeProcess(unwrapEntity<unknown>(await api('POST', `/os/workspaces/${workspaceId}/processes`, input), ['process'])),
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
    unwrapList<Job>(await api('GET', `/os/boards/${boardId}/jobs`), ['jobs']),
  createJob: async (boardId: number, input: Partial<Job>) =>
    unwrapEntity<Job>(await api('POST', `/os/boards/${boardId}/jobs`, input), ['job']),
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
