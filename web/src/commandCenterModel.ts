import type { Snapshot } from './api'
import type { AgentProfile } from './agentHomeApi'
import type { DeliveryReport, Job, OsId } from './osApi'
import type { OpenWorkGraph } from './openWorkApi'

export const COMMAND_CENTER_SECTIONS = [
  { id: 'work', label: 'Work', description: 'Contracts, jobs, dependencies, and delivery evidence' },
  { id: 'agents', label: 'Agents', description: 'Durable identities, provider sessions, and terminals' },
  { id: 'discussions', label: 'Discussions', description: 'Questions, plans, decisions, and conflicts' },
  { id: 'knowledge', label: 'Knowledge', description: 'Cited project context and accepted findings' },
  { id: 'activity', label: 'Activity', description: 'Causal project events and shipped outcomes' },
] as const

export type CommandCenterSection = typeof COMMAND_CENTER_SECTIONS[number]['id']
export type CommandCenterDensity = 'comfortable' | 'compact'
export type CommandCenterLayout = 'balanced' | 'focus' | 'wide-terminal'
export type CommandCenterTone =
  | 'neutral'
  | 'info'
  | 'running'
  | 'success'
  | 'warning'
  | 'danger'
  | 'unsupported'

export type CommandCenterStatusDomain = 'agent' | 'job' | 'delivery' | 'attention' | 'discussion' | 'process'

export type CanonicalStatus = {
  label: string
  tone: CommandCenterTone
  known: boolean
  terminal: boolean
  description: string
}

export type CommandCenterPreferences = {
  density: CommandCenterDensity
  layout: CommandCenterLayout
  terminalTouchBar: boolean
}

export type CommandCenterSelection = {
  section: CommandCenterSection
  boardId: number | null
  cardId: number | null
  agentId: string | null
  conversationId: string | null
  sessionId: string | null
  jobId: string | null
  discussionId: string | null
  knowledgeId: string | null
  deliveryId: string | null
  workspaceId: string | null
  processId: string | null
  eventId: string | null
}

export type CommandCenterSearchKind = 'agent' | 'work' | 'discussion' | 'knowledge' | 'delivery'

export type CommandCenterSearchRecord = {
  id: string
  kind: CommandCenterSearchKind
  title: string
  description: string
  status: string | null
  boardId: number | null
  href: string
  keywords: string[]
  unavailableReason?: string | null
}

export type CommandCenterKnowledgeRecord = {
  id: string
  boardId: number
  title: string
  summary: string
  source: string
  freshness: string | null
  status: 'available' | 'stale' | 'unavailable'
}

export type CommandCenterDiscussionRecord = {
  id: string
  boardId: number
  title: string
  summary: string
  status: string
  type: 'question' | 'answer' | 'plan' | 'decision' | 'announcement' | 'conflict'
  author: string
  updatedAt: string
  legacyMessageId?: number | null
}

export type SavedCommandCenterView = {
  id: string
  name: string
  section: CommandCenterSection
  query: string
  filters: Record<string, string>
  createdAt: string
}

export const DEFAULT_COMMAND_CENTER_VIEWS: readonly SavedCommandCenterView[] = [
  {
    id: 'preset-active-work', name: 'Active work', section: 'work', query: '',
    filters: { status: 'running,assigned' }, createdAt: 'built-in',
  },
  {
    id: 'preset-blocked-work', name: 'Blocked work', section: 'work', query: '',
    filters: { status: 'blocked' }, createdAt: 'built-in',
  },
  {
    id: 'preset-needs-review', name: 'Needs review', section: 'work', query: '',
    filters: { status: 'submitted' }, createdAt: 'built-in',
  },
  {
    id: 'preset-unanswered', name: 'Unanswered', section: 'discussions', query: '',
    filters: { status: 'open', type: 'question' }, createdAt: 'built-in',
  },
  {
    id: 'preset-conflicts', name: 'Conflicts', section: 'discussions', query: '',
    filters: { status: 'open', type: 'conflict' }, createdAt: 'built-in',
  },
]

export type CommandCenterGraphNodeKind = 'work' | 'agent' | 'discussion' | 'conflict'

export type CommandCenterGraphNode = {
  id: string
  kind: CommandCenterGraphNodeKind
  label: string
  detail: string
  status: CanonicalStatus
  href: string | null
  lane: number
}

export type CommandCenterGraphEdge = {
  id: string
  from: string
  to: string
  kind: 'depends_on' | 'assigned_to' | 'discussed_in' | 'conflicts_with'
  label: string
  blocked: boolean
}

export type CommandCenterGraph = {
  nodes: CommandCenterGraphNode[]
  edges: CommandCenterGraphEdge[]
}

const DEFAULT_PREFERENCES: CommandCenterPreferences = {
  density: 'comfortable',
  layout: 'balanced',
  terminalTouchBar: true,
}

const sectionSet = new Set<CommandCenterSection>(COMMAND_CENTER_SECTIONS.map((item) => item.id))
const idKeys = [
  'card', 'agent', 'conversation', 'session', 'job', 'discussion', 'knowledge', 'delivery',
  'workspace', 'process', 'event',
] as const

const titleCase = (value: string) => value
  .replace(/[_-]+/g, ' ')
  .replace(/\b\w/g, (character) => character.toUpperCase())

const status = (
  label: string,
  tone: CommandCenterTone,
  description: string,
  terminal = false,
): CanonicalStatus => ({ label, tone, known: true, terminal, description })

const STATUS_TABLE: Record<CommandCenterStatusDomain, Record<string, CanonicalStatus>> = {
  agent: {
    active: status('Running', 'running', 'The agent has an active provider session.'),
    running: status('Running', 'running', 'The agent has an active provider session.'),
    idle: status('Idle', 'neutral', 'The agent is available and has no active turn.'),
    paused: status('Paused', 'warning', 'The provider session is durably paused.'),
    blocked: status('Blocked', 'danger', 'The agent needs an external decision or dependency.'),
    lost: status('Lost', 'danger', 'The provider session could not be reattached.', true),
    stopped: status('Stopped', 'neutral', 'The provider session has stopped.', true),
    failed: status('Failed', 'danger', 'The provider session failed.', true),
    archived: status('Archived', 'neutral', 'The durable agent session is archived.', true),
    unavailable: status('Unavailable', 'unsupported', 'No live provider capability is available.', true),
  },
  job: {
    draft: status('Draft', 'neutral', 'The contract is not published.'),
    open: status('Open', 'info', 'The job is available for assignment.'),
    assigned: status('Assigned', 'info', 'A durable agent identity owns this job.'),
    queued: status('Queued', 'info', 'The job is waiting for scheduler capacity.'),
    scheduled: status('Queued', 'info', 'The job is waiting for scheduler capacity.'),
    running: status('Running', 'running', 'The canonical job is executing.'),
    blocked: status('Blocked', 'danger', 'A dependency or policy blocks execution.'),
    submitted: status('Needs review', 'warning', 'A delivery is waiting for verification.'),
    accepted: status('Verified', 'success', 'The mandatory delivery criteria were accepted.', true),
    completed: status('Completed', 'success', 'Execution completed; inspect delivery evidence.', true),
    rejected: status('Rejected', 'danger', 'The submitted delivery was rejected.', true),
    cancelled: status('Cancelled', 'neutral', 'The canonical job was cancelled.', true),
    failed: status('Failed', 'danger', 'The canonical job failed.', true),
    archived: status('Archived', 'neutral', 'The job is archived.', true),
  },
  delivery: {
    draft: status('Draft', 'neutral', 'No result has been submitted.'),
    submitted: status('Needs review', 'warning', 'The delivery is awaiting verification.'),
    verified: status('Verified', 'success', 'Observed evidence supports the delivery.'),
    accepted: status('Verified', 'success', 'The delivery was accepted with evidence.', true),
    shipped: status('Shipped', 'success', 'A canonical shipped record exists.', true),
    partial: status('Partial', 'warning', 'At least one required promise is not fully supported.'),
    missed: status('Missed', 'danger', 'A required promise was not delivered.', true),
    unverifiable: status('Unverifiable', 'unsupported', 'Available evidence cannot verify the claim.'),
    rejected: status('Rejected', 'danger', 'The delivery was rejected.', true),
  },
  attention: {
    open: status('Needs attention', 'warning', 'A person must review or resolve this item.'),
    critical: status('Critical', 'danger', 'Immediate human attention is required.'),
    resolved: status('Resolved', 'success', 'The attention item has been resolved.', true),
  },
  discussion: {
    open: status('Open', 'info', 'The discussion is active.'),
    answered: status('Answered', 'success', 'An answer exists but may not be accepted.', true),
    resolved: status('Resolved', 'success', 'The discussion has a durable resolution.', true),
    needs_human: status('Needs human', 'warning', 'A human decision is required.'),
    archived: status('Archived', 'neutral', 'The discussion is archived.', true),
    superseded: status('Superseded', 'neutral', 'A newer discussion replaces this one.', true),
    unavailable: status('Unavailable', 'unsupported', 'The canonical Discussion service is not available.', true),
  },
  process: {
    starting: status('Starting', 'info', 'The PTY process is starting.'),
    running: status('Running', 'running', 'The PTY process is live.'),
    exited: status('Exited', 'neutral', 'The PTY process exited.', true),
    stopped: status('Stopped', 'neutral', 'The PTY process was stopped.', true),
    failed: status('Failed', 'danger', 'The PTY process failed.', true),
    lost: status('Lost', 'danger', 'The PTY process could not be recovered.', true),
    unavailable: status('Unavailable', 'unsupported', 'No terminal process is available.', true),
  },
}

export function commandCenterStatus(domain: CommandCenterStatusDomain, rawStatus: string | null | undefined): CanonicalStatus {
  const normalized = rawStatus?.trim().toLowerCase().replace(/[ -]+/g, '_') ?? 'unavailable'
  const match = STATUS_TABLE[domain][normalized]
  if (match) return match
  return {
    label: rawStatus?.trim() ? titleCase(rawStatus.trim()) : 'Unavailable',
    tone: rawStatus?.trim() ? 'neutral' : 'unsupported',
    known: false,
    terminal: false,
    description: rawStatus?.trim()
      ? `The backend reported the unrecognized ${domain} state “${rawStatus.trim()}”.`
      : `No ${domain} state was reported.`,
  }
}

const positiveInteger = (value: string | null) => {
  if (!value) return null
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

const valueOrNull = (params: URLSearchParams, key: string) => {
  const value = params.get(key)?.trim()
  return value ? value : null
}

export function parseCommandCenterSelection(search: string): CommandCenterSelection {
  const params = new URLSearchParams(search)
  const savedSection = params.get('section')
  const section = sectionSet.has(savedSection as CommandCenterSection)
    ? savedSection as CommandCenterSection
    : params.has('agent') || params.has('session') || params.has('conversation')
      ? 'agents'
      : params.has('discussion')
        ? 'discussions'
        : params.has('knowledge')
          ? 'knowledge'
          : params.has('job') || params.has('delivery') || params.has('card')
            ? 'work'
            : 'work'

  return {
    section,
    boardId: positiveInteger(params.get('board')),
    cardId: positiveInteger(params.get('card')),
    agentId: valueOrNull(params, 'agent'),
    conversationId: valueOrNull(params, 'conversation'),
    sessionId: valueOrNull(params, 'session'),
    jobId: valueOrNull(params, 'job'),
    discussionId: valueOrNull(params, 'discussion'),
    knowledgeId: valueOrNull(params, 'knowledge'),
    deliveryId: valueOrNull(params, 'delivery'),
    workspaceId: valueOrNull(params, 'workspace'),
    processId: valueOrNull(params, 'process'),
    eventId: valueOrNull(params, 'event'),
  }
}

export function commandCenterDeepLink(
  currentSearch: string,
  patch: Partial<CommandCenterSelection>,
  location: { pathname?: string; hash?: string } = {},
): string {
  const params = new URLSearchParams(currentSearch)
  params.delete('view')
  if (patch.section) params.set('section', patch.section)
  if (patch.boardId !== undefined) {
    if (patch.boardId === null) params.delete('board')
    else params.set('board', String(patch.boardId))
  }
  const patchRecord = patch as Record<string, unknown>
  const selectionKeys: Array<[typeof idKeys[number], keyof CommandCenterSelection]> = [
    ['card', 'cardId'], ['agent', 'agentId'], ['conversation', 'conversationId'], ['session', 'sessionId'],
    ['job', 'jobId'], ['discussion', 'discussionId'], ['knowledge', 'knowledgeId'],
    ['delivery', 'deliveryId'], ['workspace', 'workspaceId'], ['process', 'processId'],
    ['event', 'eventId'],
  ]
  for (const [queryKey, patchKey] of selectionKeys) {
    if (!(patchKey in patchRecord)) continue
    const value = patch[patchKey]
    if (value === null || value === '') params.delete(queryKey)
    else if (value !== undefined) params.set(queryKey, String(value))
  }
  const query = params.toString()
  return `${location.pathname ?? '/'}${query ? `?${query}` : ''}${location.hash ?? ''}`
}

export function legacyCommandCenterRedirect(savedView: string | null): Pick<CommandCenterSelection, 'section'> & { legacy: string | null } {
  if (savedView === 'agents') return { section: 'agents', legacy: savedView }
  if (savedView === 'messages') return { section: 'discussions', legacy: savedView }
  if (savedView === 'timeline' || savedView === 'shipped') return { section: 'activity', legacy: savedView }
  if (savedView === 'workspaces' || savedView === 'open-work' || savedView === 'board'
    || savedView === 'review' || savedView === 'card-drawer') {
    return { section: 'work', legacy: savedView }
  }
  return { section: 'work', legacy: null }
}

export function readCommandCenterPreferences(raw: string | null): CommandCenterPreferences {
  if (!raw) return { ...DEFAULT_PREFERENCES }
  try {
    const value = JSON.parse(raw) as Partial<CommandCenterPreferences>
    return {
      density: value.density === 'compact' ? 'compact' : 'comfortable',
      layout: ['balanced', 'focus', 'wide-terminal'].includes(value.layout ?? '')
        ? value.layout as CommandCenterLayout
        : 'balanced',
      terminalTouchBar: value.terminalTouchBar !== false,
    }
  } catch {
    return { ...DEFAULT_PREFERENCES }
  }
}

export function parseSavedCommandCenterViews(raw: string | null): SavedCommandCenterView[] {
  if (!raw) return []
  try {
    const value = JSON.parse(raw)
    if (!Array.isArray(value)) return []
    return value.filter((item): item is SavedCommandCenterView => Boolean(
      item && typeof item === 'object'
      && typeof item.id === 'string'
      && typeof item.name === 'string'
      && sectionSet.has(item.section)
      && typeof item.query === 'string'
      && item.filters && typeof item.filters === 'object'
      && typeof item.createdAt === 'string',
    )).slice(0, 12)
  } catch {
    return []
  }
}

const searchable = (record: CommandCenterSearchRecord) => [
  record.title,
  record.description,
  record.status ?? '',
  record.kind,
  ...record.keywords,
].join(' ').toLocaleLowerCase()

export function searchCommandCenter(
  records: readonly CommandCenterSearchRecord[],
  query: string,
  limit = 12,
): CommandCenterSearchRecord[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return []
  return records
    .map((record) => {
      const haystack = searchable(record)
      if (!terms.every((term) => haystack.includes(term))) return null
      const title = record.title.toLocaleLowerCase()
      const score = terms.reduce((total, term) => total
        + (title === term ? 8 : title.startsWith(term) ? 5 : title.includes(term) ? 3 : 1), 0)
      return { record, score }
    })
    .filter((item): item is { record: CommandCenterSearchRecord; score: number } => item !== null)
    .sort((a, b) => b.score - a.score || a.record.title.localeCompare(b.record.title))
    .slice(0, Math.max(1, limit))
    .map(({ record }) => record)
}

const savedFilterValues = (value: string) => value.split(',')
  .map((item) => item.trim().toLocaleLowerCase())
  .filter(Boolean)

export function filterCommandCenterSearchRecords(
  records: readonly CommandCenterSearchRecord[],
  filters: Readonly<Record<string, string>>,
): CommandCenterSearchRecord[] {
  const active = Object.entries(filters).filter(([, value]) => value.trim())
  if (active.length === 0) return [...records]
  return records.filter((record) => active.every(([key, value]) => {
    const expected = savedFilterValues(value)
    if (key === 'status') {
      const domain: CommandCenterStatusDomain = record.kind === 'agent'
        ? 'agent'
        : record.kind === 'discussion'
          ? 'discussion'
          : record.kind === 'delivery'
            ? 'delivery'
            : 'job'
      const actual = record.status?.toLocaleLowerCase() ?? ''
      return expected.some((statusValue) =>
        actual === statusValue
        || actual === commandCenterStatus(domain, statusValue).label.toLocaleLowerCase())
    }
    if (key === 'type') {
      const keywords = new Set(record.keywords.map((item) => item.toLocaleLowerCase()))
      return expected.some((typeValue) => keywords.has(typeValue))
    }
    return false
  }))
}

export function projectScopedJobs(
  snapshots: readonly Snapshot[],
  jobs: readonly Job[],
): Job[] {
  const boardIds = new Set(snapshots.map((snapshot) => snapshot.board.id))
  return jobs.filter((job) => boardIds.has(job.board_id))
}

export function commandCenterProjectProjection(input: {
  snapshots: readonly Snapshot[]
  agentProfiles: readonly AgentProfile[]
  jobs: readonly Job[]
  savedView?: SavedCommandCenterView | null
}) {
  const jobs = projectScopedJobs(input.snapshots, input.jobs)
  const boardIds = new Set(input.snapshots.map((snapshot) => snapshot.board.id))
  const agentProfiles = input.agentProfiles.filter((profile) => boardIds.has(profile.board_id))
  const allSearchRecords = commandCenterSearchRecords({
    snapshots: input.snapshots,
    agentProfiles,
    jobs,
  })
  const kindForSection: Partial<Record<CommandCenterSection, CommandCenterSearchKind>> = {
    work: 'work',
    agents: 'agent',
    discussions: 'discussion',
    knowledge: 'knowledge',
  }
  const savedKind = input.savedView ? kindForSection[input.savedView.section] : undefined
  const sectionRecords = savedKind
    ? allSearchRecords.filter((record) => record.kind === savedKind)
    : allSearchRecords
  return {
    jobs,
    searchRecords: filterCommandCenterSearchRecords(
      sectionRecords,
      input.savedView?.filters ?? {},
    ),
  }
}

const deliverySummary = (delivery: DeliveryReport) =>
  delivery.human_summary || delivery.summary || delivery.gaps[0] || 'Delivery evidence'

export function commandCenterSearchRecords(input: {
  snapshots: readonly Snapshot[]
  agentProfiles: readonly AgentProfile[]
  jobs?: readonly Job[]
  discussions?: readonly CommandCenterDiscussionRecord[]
  knowledge?: readonly CommandCenterKnowledgeRecord[]
  deliveries?: readonly DeliveryReport[]
}): CommandCenterSearchRecord[] {
  const boardNames = new Map(input.snapshots.map((snapshot) => [snapshot.board.id, snapshot.board.name]))
  const legacyAgents = new Map(input.snapshots.flatMap((snapshot) => snapshot.agents.map((agent) => [
    `${snapshot.board.id}:${agent.id}`,
    agent,
  ] as const)))
  const records: CommandCenterSearchRecord[] = []
  for (const profile of input.agentProfiles.filter((item) => item.status === 'active')) {
    const linkedAgent = profile.legacy_agent_id === null
      ? undefined
      : legacyAgents.get(`${profile.board_id}:${profile.legacy_agent_id}`)
    const provider = linkedAgent?.provider ?? profile.default_provider
    records.push({
      id: `agent:${profile.board_id}:${profile.id}`,
      kind: 'agent',
      title: profile.name,
      description: `${provider ?? 'Provider unavailable'} · ${boardNames.get(profile.board_id) ?? `Project ${profile.board_id}`}`,
      status: commandCenterStatus('agent', linkedAgent?.status ?? profile.status).label,
      boardId: profile.board_id,
      href: commandCenterDeepLink('', {
        section: 'agents', boardId: profile.board_id, agentId: profile.id,
      }),
      keywords: [
        provider ?? '',
        linkedAgent?.model ?? profile.default_model ?? '',
        ...(linkedAgent?.capabilities ?? profile.capabilities),
      ],
    })
  }
  for (const snapshot of input.snapshots) {
    for (const card of snapshot.cards) {
      records.push({
        id: `work:${snapshot.board.id}:${card.id}`,
        kind: 'work',
        title: card.title,
        description: card.description || `Work item in ${boardNames.get(snapshot.board.id)}`,
        status: commandCenterStatus('job', card.column).label,
        boardId: snapshot.board.id,
        href: commandCenterDeepLink('', { section: 'work', boardId: snapshot.board.id, cardId: card.id }),
        keywords: [card.owner ?? '', ...card.paths],
      })
    }
  }
  for (const job of input.jobs ?? []) {
    records.push({
      id: `job:${job.id}`,
      kind: 'work',
      title: `Job ${job.id}`,
      description: `${job.provider} · ${boardNames.get(job.board_id) ?? `Project ${job.board_id}`}`,
      status: commandCenterStatus('job', job.status).label,
      boardId: job.board_id,
      href: commandCenterDeepLink('', { section: 'work', boardId: job.board_id, jobId: String(job.id) }),
      keywords: [job.model ?? '', job.effort ?? '', job.access_profile ?? ''],
    })
  }
  for (const discussion of input.discussions ?? []) {
    records.push({
      id: `discussion:${discussion.id}`,
      kind: 'discussion',
      title: discussion.title,
      description: discussion.summary,
      status: commandCenterStatus('discussion', discussion.status).label,
      boardId: discussion.boardId,
      href: commandCenterDeepLink('', { section: 'discussions', boardId: discussion.boardId, discussionId: discussion.id }),
      keywords: [discussion.author, discussion.type],
    })
  }
  for (const item of input.knowledge ?? []) {
    records.push({
      id: `knowledge:${item.id}`,
      kind: 'knowledge',
      title: item.title,
      description: item.summary,
      status: titleCase(item.status),
      boardId: item.boardId,
      href: commandCenterDeepLink('', { section: 'knowledge', boardId: item.boardId, knowledgeId: item.id }),
      keywords: [item.source, item.freshness ?? ''],
      unavailableReason: item.status === 'unavailable' ? 'Knowledge browse is unavailable for this project.' : null,
    })
  }
  for (const delivery of input.deliveries ?? []) {
    records.push({
      id: `delivery:${delivery.id}`,
      kind: 'delivery',
      title: `Delivery ${delivery.sequence || delivery.id}`,
      description: deliverySummary(delivery),
      status: commandCenterStatus('delivery', delivery.status).label,
      boardId: null,
      href: commandCenterDeepLink('', {
        section: 'work',
        jobId: delivery.job_id === null ? null : String(delivery.job_id),
        deliveryId: String(delivery.id),
      }),
      keywords: [...delivery.changed_files, ...delivery.commits],
    })
  }
  return records
}

const graphNodeId = (kind: CommandCenterGraphNodeKind, id: OsId) => `${kind}:${id}`

export function buildCommandCenterGraph(input: {
  graph: OpenWorkGraph
  assignments?: Array<{ cardId: number; agentId: string; agentName: string; status: string }>
  discussions?: Array<{ id: string; cardId: number; title: string; status: string }>
  conflicts?: Array<{ id: string; cardId: number; otherCardId: number | null; title: string; severity: string }>
}): CommandCenterGraph {
  const nodes = new Map<string, CommandCenterGraphNode>()
  const edges: CommandCenterGraphEdge[] = []
  const dependedOn = new Set(input.graph.edges.map((edge) => edge.to_card_id))
  for (const item of input.graph.nodes) {
    nodes.set(graphNodeId('work', item.card_id), {
      id: graphNodeId('work', item.card_id),
      kind: 'work',
      label: item.title,
      detail: item.blocking_reasons.join(' · ') || `Task ${item.card_id}`,
      status: commandCenterStatus('job', item.readiness === 'blocked' ? 'blocked' : item.state),
      href: commandCenterDeepLink('', { section: 'work', boardId: item.board_id, cardId: item.card_id }),
      lane: dependedOn.has(item.card_id) ? 0 : 1,
    })
  }
  for (const edge of input.graph.edges) {
    edges.push({
      id: `dependency:${edge.from_card_id}:${edge.to_card_id}`,
      from: graphNodeId('work', edge.from_card_id),
      to: graphNodeId('work', edge.to_card_id),
      kind: 'depends_on',
      label: edge.blocking_reason,
      blocked: edge.readiness === 'blocked',
    })
  }
  for (const assignment of input.assignments ?? []) {
    const agentId = graphNodeId('agent', assignment.agentId)
    nodes.set(agentId, {
      id: agentId,
      kind: 'agent',
      label: assignment.agentName,
      detail: 'Durable assignee',
      status: commandCenterStatus('agent', assignment.status),
      href: commandCenterDeepLink('', { section: 'agents', agentId: assignment.agentId }),
      lane: 2,
    })
    edges.push({
      id: `assignment:${assignment.cardId}:${assignment.agentId}`,
      from: graphNodeId('work', assignment.cardId),
      to: agentId,
      kind: 'assigned_to',
      label: 'Assigned to',
      blocked: false,
    })
  }
  for (const discussion of input.discussions ?? []) {
    const discussionId = graphNodeId('discussion', discussion.id)
    nodes.set(discussionId, {
      id: discussionId,
      kind: 'discussion',
      label: discussion.title,
      detail: 'Linked discussion',
      status: commandCenterStatus('discussion', discussion.status),
      href: commandCenterDeepLink('', { section: 'discussions', discussionId: discussion.id }),
      lane: 2,
    })
    edges.push({
      id: `discussion:${discussion.cardId}:${discussion.id}`,
      from: graphNodeId('work', discussion.cardId),
      to: discussionId,
      kind: 'discussed_in',
      label: 'Discussed in',
      blocked: false,
    })
  }
  for (const conflict of input.conflicts ?? []) {
    const conflictId = graphNodeId('conflict', conflict.id)
    nodes.set(conflictId, {
      id: conflictId,
      kind: 'conflict',
      label: conflict.title,
      detail: `${titleCase(conflict.severity)} conflict`,
      status: commandCenterStatus('attention', conflict.severity === 'critical' ? 'critical' : 'open'),
      href: conflict.cardId ? commandCenterDeepLink('', { section: 'work', cardId: conflict.cardId }) : null,
      lane: 2,
    })
    edges.push({
      id: `conflict:${conflict.cardId}:${conflict.id}`,
      from: graphNodeId('work', conflict.cardId),
      to: conflictId,
      kind: 'conflicts_with',
      label: 'Conflicts with',
      blocked: true,
    })
    if (conflict.otherCardId !== null) {
      edges.push({
        id: `conflict:${conflict.otherCardId}:${conflict.id}`,
        from: graphNodeId('work', conflict.otherCardId),
        to: conflictId,
        kind: 'conflicts_with',
        label: 'Conflicts with',
        blocked: true,
      })
    }
  }
  return { nodes: [...nodes.values()], edges }
}
