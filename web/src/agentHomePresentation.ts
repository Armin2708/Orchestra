import type {
  AgentConversation,
  AgentHomeAction,
  AgentHomeCapabilities,
  AgentHomeSnapshot,
  AgentProfile,
  AgentSessionRecord,
  ConversationEvent,
} from './agentHomeApi'
import type { AttentionItem, WorkspaceProcess } from './osApi'

export type AgentHomeSelection = {
  profileId: string | null
  conversationId: string | null
  sessionId: string | null
  processId: string | null
}

const activeSessionStatuses = new Set(['reserved', 'starting', 'running', 'idle', 'stopping'])
const runningProcessStatuses = new Set(['starting', 'running', 'stopping'])

export const chooseProfile = (
  profiles: AgentProfile[],
  requestedId: string | null,
  savedId: string | null,
) => profiles.find((profile) => profile.id === requestedId)
  ?? profiles.find((profile) => profile.id === savedId)
  ?? profiles.find((profile) => profile.status === 'active')
  ?? profiles[0]
  ?? null

export const chooseSession = (
  home: AgentHomeSnapshot | null,
  requestedId: string | null,
): AgentSessionRecord | null => {
  if (!home) return null
  return home.sessions.find((session) => session.id === requestedId)
    ?? home.active_session
    ?? home.sessions.find((session) => activeSessionStatuses.has(session.status))
    ?? home.sessions[0]
    ?? null
}

export const chooseConversation = (
  home: AgentHomeSnapshot | null,
  session: AgentSessionRecord | null,
  requestedId: string | null,
): AgentConversation | null => {
  if (!home) return null
  return home.conversations.find((conversation) => conversation.id === requestedId)
    ?? home.conversations.find((conversation) => conversation.id === session?.conversation_id)
    ?? home.conversations.find((conversation) => conversation.is_default && conversation.status === 'active')
    ?? home.conversations.find((conversation) => conversation.status === 'active')
    ?? home.conversations[0]
    ?? null
}

export const chooseProcess = (
  processes: WorkspaceProcess[],
  requestedId: string | null,
): WorkspaceProcess | null => processes.find((process) => String(process.id) === requestedId)
  ?? processes.find((process) => runningProcessStatuses.has(process.status))
  ?? processes[0]
  ?? null

export const parseAgentHomeSelection = (search: string): AgentHomeSelection => {
  const params = new URLSearchParams(search)
  return {
    profileId: params.get('agent'),
    conversationId: params.get('conversation'),
    sessionId: params.get('session'),
    processId: params.get('process'),
  }
}

export const agentHomeDeepLink = (
  search: string,
  selection: AgentHomeSelection & { boardId?: number | null; jobId?: string | null; workspaceId?: string | null },
  locationParts: { pathname: string; hash?: string } = { pathname: '/', hash: '' },
) => {
  const params = new URLSearchParams(search)
  const values: Array<[string, string | number | null | undefined]> = [
    ['board', selection.boardId],
    ['agent', selection.profileId],
    ['conversation', selection.conversationId],
    ['session', selection.sessionId],
    ['job', selection.jobId],
    ['workspace', selection.workspaceId],
    ['process', selection.processId],
  ]
  for (const [key, value] of values) {
    if (value === null || value === undefined || value === '') params.delete(key)
    else params.set(key, String(value))
  }
  const query = params.toString()
  return `${locationParts.pathname}${query ? `?${query}` : ''}${locationParts.hash ?? ''}`
}

export const capabilityFor = (
  capabilities: AgentHomeCapabilities | null,
  action: AgentHomeAction,
) => capabilities?.actions?.[action] ?? {
  supported: false,
  allowed: false,
  requires_operator: true,
  reason: 'Capability information is not available for this session yet.',
}

export const eventText = (event: ConversationEvent) => {
  if (event.redaction_state === 'withheld') return 'Content withheld by the active redaction policy.'
  if (event.projected_text?.trim()) return event.projected_text
  if (event.kind === 'usage') return 'Provider usage updated.'
  if (event.kind === 'tool') return `Tool requested${metadataName(event) ? `: ${metadataName(event)}` : '.'}`
  if (event.kind === 'tool_result') return `Tool completed${metadataName(event) ? `: ${metadataName(event)}` : '.'}`
  if (event.kind === 'approval') return 'Approval state changed.'
  if (event.kind === 'status') return 'Session status changed.'
  if (event.kind === 'error') return 'The provider reported an error.'
  return 'No projected text was recorded for this event.'
}

export const eventLabel = (event: ConversationEvent) => {
  if (event.kind === 'tool_result') return 'tool result'
  return event.kind
}

export const eventActor = (event: ConversationEvent) =>
  event.actor_id ? `${event.actor_type} · ${event.actor_id}` : event.actor_type

export const metadataName = (event: ConversationEvent) => {
  for (const key of ['tool_name', 'tool', 'name', 'status']) {
    const value = event.metadata[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

export const formatEventTime = (value: string | null | undefined) => {
  if (!value) return 'unknown time'
  const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`
  const date = new Date(normalized)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

export const attentionSummary = (items: AttentionItem[]) => {
  const open = items.filter((item) => item.status === 'open')
  return {
    total: open.length,
    approvals: open.filter((item) => /approval|permission/i.test(item.kind)).length,
    questions: open.filter((item) => /question|ask/i.test(item.kind)).length,
    conflicts: open.filter((item) => /conflict/i.test(item.kind)).length,
    reviews: open.filter((item) => /review/i.test(item.kind)).length,
    failures: open.filter((item) => /fail|error/i.test(item.kind)).length,
  }
}

const numericMetadata = (event: ConversationEvent, keys: string[]) => {
  for (const key of keys) {
    const value = event.metadata[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return 0
}

export const usageSummary = (events: ConversationEvent[]) => events.reduce((summary, event) => {
  if (event.kind !== 'usage') return summary
  summary.input += numericMetadata(event, ['input_tokens', 'input'])
  summary.cached += numericMetadata(event, ['cached_input_tokens', 'cache_read_input_tokens', 'cache_read'])
  summary.output += numericMetadata(event, ['output_tokens', 'output'])
  summary.costCents += numericMetadata(event, ['cost_cents', 'spent_cents'])
  return summary
}, { input: 0, cached: 0, output: 0, costCents: 0 })

export const shortId = (value: string | number | null | undefined, length = 8) => {
  if (value === null || value === undefined || value === '') return '—'
  const text = String(value)
  return text.length > length ? `${text.slice(0, length)}…` : text
}
