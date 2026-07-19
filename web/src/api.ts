export const getToken = () => localStorage.getItem('orchestra-token') ?? ''
export const setToken = (t: string) => localStorage.setItem('orchestra-token', t)

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

export const api = async (method: string, p: string, body?: unknown) => {
  const headers: Record<string, string> = {}
  const token = getToken()
  if (token) headers.authorization = `Bearer ${token}`
  // fastify rejects bodyless requests that carry a json content-type
  if (body !== undefined) headers['content-type'] = 'application/json'
  const res = await fetch(`/api/v1${p}`, {
    method,
    headers: Object.keys(headers).length ? headers : undefined,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) throw new ApiError(res.status, await res.text())
  return res.json()
}

// EventSource can't set headers — the daemon accepts ?token= on SSE routes
export const streamUrl = () => {
  const token = getToken()
  return token ? `/api/v1/events?token=${encodeURIComponent(token)}` : '/api/v1/events'
}

export type VerificationCriterion = { text: string; met: boolean | 'unverifiable'; evidence: string }
// latest verifier verdict for a review card (#52); running = a verify was requested after the last verdict
export type Verification = { running: boolean; verdict: 'pass' | 'gaps' | 'fail' | null; tested?: boolean; criteria?: VerificationCriterion[]; at?: string; by?: string | null }
export type Card = { id: number; title: string; description: string; column: string; owner: string | null; paths: string[]; updated_at: string; milestone_id?: number | null; step_order?: number | null; verification?: Verification }
export type Agent = { id: number; name: string; status: string; last_seen: string; kind?: string; board_id?: number; subagents?: { key: string; label: string }[] }
export type Milestone = { id: number; board_id: number; title: string; description: string; created_at: string }
export type Idea = { id: number; board_id: number; text: string; created_at: string }
export type ReviewDecision = { id: number; board_id: number; card_id: number; card_title?: string; milestone_id: number | null; step_order: number | null; decision: 'approve' | 'send_back'; note: string | null; decided_at: string }
export type Thread = { id: number; body: string; from_name: string | null; to_name: string | null; created_at: string; answered: boolean; replies: { id: number; body: string; from_name: string | null; created_at: string }[] }
export type Snapshot = { board: { id: number; name: string }; agents: Agent[]; cards: Card[]; open_questions: any[]; threads: Thread[]; ideas: Idea[]; milestones: Milestone[] }

// deterministic identity color per agent name — muted, editorial
export function agentHue(name: string): number {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return (h % 12) * 30 // 12 well-separated hues
}
export const agentInk = (name: string) => `hsl(${agentHue(name)} 42% 34%)`
export const agentWash = (name: string) => `hsl(${agentHue(name)} 45% 94%)`
export const initials = (name: string) =>
  name.split('-').map((w) => w[0]?.toUpperCase() ?? '').slice(0, 2).join('')

export function timeAgo(sqlUtc: string): string {
  const t = new Date(sqlUtc.replace(' ', 'T') + 'Z').getTime()
  const s = Math.max(0, (Date.now() - t) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

// GET /boards/:id/timeline — merged activity feed, cursor-paged
export type TimelineItem = {
  ts: string; source: 'card' | 'review' | 'message' | 'milestone'; id: number; type: string
  agent: string | null; card_id: number | null; card_title: string | null; summary: string
}
export type TimelinePage = { items: TimelineItem[]; next_cursor: string | null; has_more: boolean }
export const fetchTimeline = (
  boardId: number,
  opts: { cursor?: string; limit?: number; agent?: string; card?: number; type?: string } = {},
): Promise<TimelinePage> => {
  const q = new URLSearchParams()
  if (opts.cursor) q.set('cursor', opts.cursor)
  if (opts.limit) q.set('limit', String(opts.limit))
  if (opts.agent) q.set('agent', opts.agent)
  if (opts.card) q.set('card', String(opts.card))
  if (opts.type) q.set('type', opts.type)
  const qs = q.toString()
  return api('GET', `/boards/${boardId}/timeline${qs ? `?${qs}` : ''}`)
}

export type SystemInfo = {
  hardware: { cores: number; total_gb: number; capacity: number }
  hired: number
  usage: {
    five_hour: { utilization: number; resets_at: string | null }
    seven_day: { utilization: number; resets_at: string | null }
    stale_since?: string // present when the daemon serves the last cached payload
  } | null
  usage_error?: 'keychain' | 'offline' | 'none' | null
  usage_error_since?: string | null
  injected?: { chars: number; tokens: number; count: number }
  // real API tokens consumed by hired agents (SDK usage reports) — distinct from the injected estimate
  agent_usage?: UsageSplit
}

export type UsageSplit = { input_tokens: number; cache_read: number; cache_creation: number; output_tokens: number }

// GET /boards/:id/shipped — annotated commit history joined with cards
export type ShipFile = { path: string; insertions: number; deletions: number }
export type ShipCard = { id: number; title: string; agent: string | null; summary: string | null; decision: 'approve' | 'send_back' | null; matched_by: 'shipped' | 'ref' }
export type ShipCommit = { hash: string; short: string; date: string; author: string; subject: string; body: string; files: ShipFile[]; insertions: number; deletions: number; cards: ShipCard[] }
export type ShipLog = { head: string | null; commits: ShipCommit[]; offset: number; limit: number; has_more: boolean; error?: string }

// GET /boards/:id/telemetry — injected-context accounting (tokens = ceil(chars/4))
export type TelemetryCount = { chars: number; tokens: number; count: number }
export type Telemetry = {
  total: TelemetryCount
  by_event: ({ hook_event: string } & TelemetryCount)[]
  by_agent: ({ agent_id: number; agent_name: string } & TelemetryCount)[]
  days: ({ day: string } & TelemetryCount)[]
  // real API token usage (agent_usage table) — separate metric from the injected estimate above
  usage?: {
    total: UsageSplit
    by_agent: ({ agent_id: number; agent_name: string } & UsageSplit)[]
    days: ({ day: string } & UsageSplit)[]
  }
}
