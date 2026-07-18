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

export type Card = { id: number; title: string; description: string; column: string; owner: string | null; paths: string[]; updated_at: string; milestone_id?: number | null; step_order?: number | null }
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

export type SystemInfo = {
  hardware: { cores: number; total_gb: number; capacity: number }
  hired: number
  usage: {
    five_hour: { utilization: number; resets_at: string | null }
    seven_day: { utilization: number; resets_at: string | null }
  } | null
  injected?: { chars: number; tokens: number; count: number }
}

// GET /boards/:id/telemetry — injected-context accounting (tokens = ceil(chars/4))
export type TelemetryCount = { chars: number; tokens: number; count: number }
export type Telemetry = {
  total: TelemetryCount
  by_event: ({ hook_event: string } & TelemetryCount)[]
  by_agent: ({ agent_id: number; agent_name: string } & TelemetryCount)[]
  days: ({ day: string } & TelemetryCount)[]
}
