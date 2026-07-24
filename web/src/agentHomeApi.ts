import { api, ApiError, getToken } from './api'
import type {
  AgentAccessProfile,
  AttentionItem,
  Job,
  JsonObject,
  Workspace,
  WorkspaceProcess,
} from './osApi'

export const AGENT_HOME_EVENT_KINDS = [
  'user',
  'assistant',
  'system',
  'tool',
  'tool_result',
  'approval',
  'usage',
  'status',
  'error',
] as const

export type AgentHomeEventKind = typeof AGENT_HOME_EVENT_KINDS[number]
export type AgentHomeAction = 'resume' | 'pause' | 'stop' | 'retry' | 'fork' | 'rename' | 'archive'

export type AgentProfile = {
  id: string
  board_id: number
  legacy_agent_id: number | null
  name: string
  role: string | null
  default_provider: string | null
  default_model: string | null
  default_effort: string | null
  default_access_profile: AgentAccessProfile | null
  capabilities: string[]
  owner_actor_type: string
  owner_actor_id: string | null
  status: 'active' | 'archived'
  provenance: JsonObject
  created_at: string
  updated_at: string
  archived_at: string | null
}

export type AgentConversation = {
  id: string
  board_id: number
  profile_id: string
  title: string
  status: 'active' | 'archived'
  is_default: boolean
  next_sequence: number
  created_by_actor_type: string
  created_by_actor_id: string | null
  created_at: string
  updated_at: string
  archived_at: string | null
}

export type AgentSessionRecord = {
  id: string
  workspace_id: string
  agent_id: number | null
  provider: string
  external_id: string | null
  model: string | null
  status: string
  context: JsonObject
  profile_id: string | null
  conversation_id: string | null
  job_id: string | null
  mode: 'managed' | 'ambient' | 'compatibility' | string
  driver_id: string | null
  effort: string | null
  access_profile: AgentAccessProfile | null
  provider_thread_id: string | null
  provider_cursor: string | null
  recovery_state: 'recoverable' | 'reattached' | 'lost' | 'not_applicable' | string
  recovery: JsonObject
  history_state: 'complete' | 'partial' | 'unavailable' | string
  started_at: string | null
  ended_at: string | null
  archived_at: string | null
  created_at: string
  updated_at: string
}

export type ConversationEvent = {
  id: string
  board_id: number
  profile_id: string
  conversation_id: string
  session_id: string | null
  sequence: number
  provider: string | null
  provider_event_id: string | null
  provider_thread_id: string | null
  provider_turn_id: string | null
  provider_item_id: string | null
  provider_cursor: string | null
  kind: AgentHomeEventKind
  actor_type: string
  actor_id: string | null
  correlation_id: string | null
  causation_id: string | null
  projected_text: string | null
  metadata: JsonObject
  raw_artifact_id: string | null
  dedupe_key: string
  content_hash: string
  redaction_state: 'none' | 'redacted' | 'withheld'
  retention_class: 'transcript' | 'audit' | 'ephemeral' | 'pinned'
  schema_version: number
  created_at: string
  archived_at: string | null
}

export type AgentHomeSnapshot = {
  profile: AgentProfile
  conversations: AgentConversation[]
  sessions: AgentSessionRecord[]
  active_session: AgentSessionRecord | null
  active_scope: {
    workspace: Workspace | null
    job: Job | null
    processes: WorkspaceProcess[]
    attention: AttentionItem[]
  }
}

export type AgentHomeCapability = {
  supported: boolean
  allowed: boolean
  requires_operator: boolean
  reason: string | null
}

export type AgentHomeCapabilities = {
  provider: string
  actions: Record<AgentHomeAction, AgentHomeCapability>
}

export type AgentHomeLinks = {
  profile_id: string | null
  conversation_id: string | null
  session_id: string | null
  job_id: string | null
  workspace_id: string | null
  event_id: string | null
  process_ids: string[]
  href: string
}

export type AgentSessionDetails = {
  session: AgentSessionRecord
  capabilities: AgentHomeCapabilities | null
  links: AgentHomeLinks | null
}

export type AgentHomeSearch = {
  events: ConversationEvent[]
  next_cursor: number
  has_more: boolean
  links?: AgentHomeLinks | null
}

export type ConversationSearchFilters = {
  query?: string
  after?: number
  limit?: number
  kinds?: AgentHomeEventKind[]
  actorType?: string
  actorId?: string
  tool?: string
  status?: string
  from?: string
  to?: string
  sessionId?: string
}

export type AgentSessionActionResult = {
  action: {
    type: AgentHomeAction
    target_session_id: string
    replayed: boolean
  }
  session: AgentSessionRecord
  created_session: AgentSessionRecord | null
  capabilities: AgentHomeCapabilities
  links: AgentHomeLinks
}

export class AgentHomeApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message)
  }
}

const asRecord = (value: unknown): JsonObject =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {}

const asArray = <T,>(value: unknown): T[] => Array.isArray(value) ? value as T[] : []

const idempotencyKey = (scope: string) => {
  const suffix = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`
  return `agent-home:${scope}:${suffix}`
}

const errorFromResponse = async (response: Response) => {
  const text = await response.text()
  let detail: JsonObject = {}
  try { detail = asRecord(JSON.parse(text)) } catch { /* retain the text fallback */ }
  return new AgentHomeApiError(
    response.status,
    typeof detail.code === 'string' ? detail.code : 'request_failed',
    typeof detail.error === 'string' ? detail.error : text || `Request failed (${response.status})`,
  )
}

const agentHomeFetch = async (
  method: string,
  path: string,
  body?: unknown,
  options: { idempotencyScope?: string; accept?: string } = {},
) => {
  const headers: Record<string, string> = {}
  const token = getToken()
  if (token) headers.authorization = `Bearer ${token}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (options.accept) headers.accept = options.accept
  if (options.idempotencyScope) headers['idempotency-key'] = idempotencyKey(options.idempotencyScope)
  const response = await fetch(`/api/v1${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!response.ok) throw await errorFromResponse(response)
  return response
}

const fallbackSearch = async (
  conversationId: string,
  filters: ConversationSearchFilters,
): Promise<AgentHomeSearch> => {
  const params = new URLSearchParams()
  params.set('after', String(filters.after ?? 0))
  params.set('limit', String(Math.min(500, Math.max(filters.limit ?? 200, 200))))
  if (filters.kinds?.length) params.set('kinds', filters.kinds.join(','))
  const raw = asRecord(await api('GET', `/os/conversations/${conversationId}/events?${params}`))
  const query = filters.query?.trim().toLocaleLowerCase()
  const events = asArray<ConversationEvent>(raw.events).filter((event) => {
    if (filters.sessionId && event.session_id !== filters.sessionId) return false
    if (filters.actorType && event.actor_type !== filters.actorType) return false
    if (filters.actorId && event.actor_id !== filters.actorId) return false
    if (filters.from && event.created_at < filters.from) return false
    if (filters.to && event.created_at > filters.to) return false
    const metadata = JSON.stringify(event.metadata).toLocaleLowerCase()
    if (filters.tool && !metadata.includes(filters.tool.toLocaleLowerCase())) return false
    if (filters.status && !metadata.includes(filters.status.toLocaleLowerCase())
      && !event.projected_text?.toLocaleLowerCase().includes(filters.status.toLocaleLowerCase())) return false
    if (query && !`${event.projected_text ?? ''} ${metadata} ${event.actor_type} ${event.actor_id ?? ''}`
      .toLocaleLowerCase().includes(query)) return false
    return true
  })
  return {
    events,
    next_cursor: Number(raw.next_sequence ?? events[events.length - 1]?.sequence ?? filters.after ?? 0),
    has_more: false,
  }
}

export const agentHomeApi = {
  listProfiles: async (boardId: number, includeArchived = false): Promise<AgentProfile[]> => {
    const suffix = includeArchived ? '?archived=true' : ''
    const raw = asRecord(await api('GET', `/os/boards/${boardId}/agent-profiles${suffix}`))
    return asArray<AgentProfile>(raw.profiles)
  },

  createProfile: async (boardId: number, input: {
    name: string
    role?: string | null
    default_provider?: string | null
    default_model?: string | null
    default_effort?: string | null
    default_access_profile?: AgentAccessProfile | null
  }): Promise<AgentProfile> => {
    const response = await agentHomeFetch(
      'POST',
      `/os/boards/${boardId}/agent-profiles`,
      input,
      { idempotencyScope: `create-profile:${boardId}` },
    )
    return asRecord(await response.json()).profile as AgentProfile
  },

  getHome: async (profileId: string): Promise<AgentHomeSnapshot> => {
    const raw = asRecord(await api('GET', `/os/agent-profiles/${encodeURIComponent(profileId)}/home`))
    return raw.home as AgentHomeSnapshot
  },

  getSession: async (sessionId: string): Promise<AgentSessionDetails> => {
    const raw = asRecord(await api('GET', `/os/sessions/${encodeURIComponent(sessionId)}`))
    return {
      session: raw.session as AgentSessionRecord,
      capabilities: Object.keys(asRecord(raw.capabilities)).length
        ? raw.capabilities as AgentHomeCapabilities
        : null,
      links: Object.keys(asRecord(raw.links)).length ? raw.links as AgentHomeLinks : null,
    }
  },

  searchConversation: async (
    conversationId: string,
    filters: ConversationSearchFilters = {},
  ): Promise<AgentHomeSearch> => {
    const params = new URLSearchParams()
    if (filters.query) params.set('query', filters.query)
    if (filters.after !== undefined) params.set('after', String(filters.after))
    if (filters.limit !== undefined) params.set('limit', String(filters.limit))
    if (filters.kinds?.length) params.set('kind', filters.kinds.join(','))
    if (filters.actorType) params.set('actor_type', filters.actorType)
    if (filters.actorId) params.set('actor_id', filters.actorId)
    if (filters.tool) params.set('tool', filters.tool)
    if (filters.status) params.set('status', filters.status)
    if (filters.from) params.set('from', filters.from)
    if (filters.to) params.set('to', filters.to)
    if (filters.sessionId) params.set('session_id', filters.sessionId)
    try {
      const raw = asRecord(await api(
        'GET',
        `/os/conversations/${encodeURIComponent(conversationId)}/search?${params}`,
      ))
      return {
        events: asArray<ConversationEvent>(raw.events),
        next_cursor: Number(raw.next_cursor ?? 0),
        has_more: raw.has_more === true,
        links: Object.keys(asRecord(raw.links)).length ? raw.links as AgentHomeLinks : null,
      }
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 404) throw error
      return fallbackSearch(conversationId, filters)
    }
  },

  sessionAction: async (
    sessionId: string,
    action: AgentHomeAction,
    body: JsonObject = {},
  ): Promise<AgentSessionActionResult> => {
    const response = await agentHomeFetch(
      'POST',
      `/os/sessions/${encodeURIComponent(sessionId)}/${action}`,
      body,
      { idempotencyScope: `${action}:${sessionId}` },
    )
    return await response.json() as AgentSessionActionResult
  },

  readExport: async (
    conversationId: string,
    format: 'human' | 'json',
    sessionId?: string,
  ): Promise<{ content: string; mimeType: string }> => {
    const params = new URLSearchParams({ format })
    if (sessionId) params.set('session_id', sessionId)
    const response = await agentHomeFetch(
      'GET',
      `/os/conversations/${encodeURIComponent(conversationId)}/export?${params}`,
      undefined,
      { accept: format === 'json' ? 'application/json' : 'text/plain' },
    )
    return {
      content: await response.text(),
      mimeType: response.headers.get('content-type')?.split(';')[0]
        ?? (format === 'json' ? 'application/json' : 'text/plain'),
    }
  },
}
