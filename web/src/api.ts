import { clearRejectedCurrentDeviceAuthority, deviceRequestHeaders, isLoopbackBrowser } from './deviceAuth'
import { createLocalOwnerSessionStore } from './localOwnerSession'

const localOwnerSession = createLocalOwnerSessionStore(
  typeof sessionStorage === 'undefined' ? null : sessionStorage,
)

/** Short-lived owner sessions are loopback-only and persist only in the current browser tab. */
export const getToken = () => isLoopbackBrowser() ? localOwnerSession.get() : ''
export const setToken = (session: string, expiresAt?: string) => {
  if (!isLoopbackBrowser()) throw new Error('owner tokens are accepted only from loopback')
  localOwnerSession.set(session, expiresAt)
}

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

export type LocalOwnerPasswordStatus = { password_set: boolean }
export type LocalOwnerPasswordSession = { session: string; expires_at: string }

const parseAuthResponse = async <T>(response: Response): Promise<T> => {
  const payload = await response.json().catch(() => ({})) as T & { error?: string }
  if (!response.ok) throw new ApiError(response.status, payload.error || 'Authentication failed.')
  return payload
}

export const localOwnerPasswordStatus = async (): Promise<LocalOwnerPasswordStatus> => {
  if (!isLoopbackBrowser()) throw new Error('local owner password is available only on loopback')
  return parseAuthResponse(await fetch('/api/v1/auth/status', {
    cache: 'no-store', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer',
  }))
}

export const authenticateLocalOwnerPassword = async (
  mode: 'setup' | 'login',
  password: string,
): Promise<LocalOwnerPasswordSession> => {
  if (!isLoopbackBrowser()) throw new Error('local owner password is available only on loopback')
  const result = await parseAuthResponse<LocalOwnerPasswordSession>(await fetch(`/api/v1/auth/${mode}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
    cache: 'no-store',
    credentials: 'omit',
    redirect: 'error',
    referrerPolicy: 'no-referrer',
  }))
  setToken(result.session, result.expires_at)
  return result
}

export const boundedIdempotencyKey = (value: string): string => {
  const key = value.trim()
  if (!key || key.length > 128 || /[\u0000-\u001f\u007f,]/u.test(key)) {
    throw new Error('idempotency-key must be 1-128 characters without controls or commas')
  }
  return key
}

export const api = async (method: string, p: string, body?: unknown, extraHeaders: Record<string, string> = {}) => {
  // a loopback browser IS the operator (#91-93); presenting a leftover remote
  // device credential would demote it to that device's scopes, so never attach
  // device proof on loopback origins
  const headers: Record<string, string> = isLoopbackBrowser() ? {} : await deviceRequestHeaders(method, p)
  for (const name of ['x-orchestra-step-up-grant', 'x-orchestra-step-up-nonce']) {
    if (extraHeaders[name]) headers[name] = extraHeaders[name]
  }
  if (extraHeaders['idempotency-key'] !== undefined) {
    headers['idempotency-key'] = boundedIdempotencyKey(extraHeaders['idempotency-key'])
  }
  const token = getToken()
  if (token) headers.authorization = `Bearer ${token}`
  // fastify rejects bodyless requests that carry a json content-type
  if (body !== undefined) headers['content-type'] = 'application/json'
  const res = await fetch(`/api/v1${p}`, {
    method,
    headers: Object.keys(headers).length ? headers : undefined,
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
    credentials: 'omit',
    redirect: 'error',
    referrerPolicy: 'no-referrer',
  })
  if (res.status === 401 && headers.authorization?.startsWith('Bearer ')) localOwnerSession.clear()
  if (res.status === 401 && headers.authorization?.startsWith('Device ')) {
    await clearRejectedCurrentDeviceAuthority()
  }
  if (!res.ok) throw new ApiError(res.status, await res.text())
  return res.json()
}

/**
 * Binary GET returning an object URL. <img src="/api/v1/…"> cannot carry the
 * Bearer/Device proof headers api() attaches, so image evidence is fetched here
 * and handed to the DOM as a blob URL. Callers must revokeObjectURL on unmount.
 */
export const apiObjectUrl = async (p: string): Promise<string> => {
  const headers: Record<string, string> = isLoopbackBrowser() ? {} : await deviceRequestHeaders('GET', p)
  const token = getToken()
  if (token) headers.authorization = `Bearer ${token}`
  const res = await fetch(`/api/v1${p}`, {
    method: 'GET',
    headers: Object.keys(headers).length ? headers : undefined,
    cache: 'no-store',
    credentials: 'omit',
    redirect: 'error',
    referrerPolicy: 'no-referrer',
  })
  if (!res.ok) throw new ApiError(res.status, await res.text())
  return URL.createObjectURL(await res.blob())
}

/** EventSource cannot carry proof headers; clients use authenticated polling instead. */
export const streamUrl = () => '/api/v1/events'

export type VerificationCriterion = { text: string; met: boolean | 'unverifiable'; evidence: string }
// latest verifier verdict for a review card (#52); running = a verify was requested after the last verdict
// queued = waiting for the single verifier slot (#150); only one verifier runs board-wide
export type Verification = { running: boolean; queued?: boolean; verdict: 'pass' | 'gaps' | 'fail' | null; tested?: boolean; criteria?: VerificationCriterion[]; at?: string; by?: string | null }
// board_id is a client-side annotation set only by the merged all-projects view
export type Card = { id: number; title: string; description: string; column: string; owner: string | null; paths: string[]; updated_at: string; milestone_id?: number | null; step_order?: number | null; verification?: Verification; rank?: number | null; ready?: boolean; stale?: boolean; kind?: string; parent_card_id?: number | null; funnel_ready?: boolean; funnel_role?: string; board_id?: number }
export type Agent = {
  id: number
  name: string
  status: string
  last_seen: string
  kind?: string
  created_at?: string
  board_id?: number
  provider?: string
  capabilities?: string[]
  access_profile?: 'read_only' | 'workspace_write' | 'full_access' | null
  model?: string | null
  effort?: string | null
  subagents?: { key: string; label: string }[]
  // rank by real recorded tokens on the board (#109); null until usage exists
  effort_rank?: number | null
  effort_tokens?: number
  // client-side annotation: home project name, set only by the merged all-projects view
  project?: string
}
export type Milestone = { id: number; board_id: number; title: string; description: string; created_at: string; status?: 'open' | 'shipped' | 'dropped'; outcome?: string; rank?: number | null }
export type Idea = { id: number; board_id: number; text: string; created_at: string }
export type ReviewDecision = { id: number; board_id: number; card_id: number; card_title?: string; milestone_id: number | null; step_order: number | null; decision: 'approve' | 'send_back'; note: string | null; decided_at: string }
export const MESSAGE_KINDS = ['ask', 'reply', 'task', 'notify', 'announce', 'swarm'] as const
export type MessageKind = typeof MESSAGE_KINDS[number]
export type BoardMessage = {
  id: number
  board_id: number
  card_id: number | null
  kind: MessageKind
  body: string
  from_name: string | null
  to_name: string | null
  reply_to: number | null
  created_at: string
  delivered_at: string | null
  recipient_count: number
  delivered_count: number
  // operator mail fields — set when an agent addressed the human explicitly
  to_human?: number
  subject?: string | null
  mail_type?: string | null
  attachments?: string | null
}
export type Thread = BoardMessage & { answered: boolean; replies: BoardMessage[] }
export type Snapshot = { board: { id: number; name: string }; agents: Agent[]; cards: Card[]; open_questions: BoardMessage[]; threads: Thread[]; ideas: Idea[]; milestones: Milestone[] }

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

export type SystemProviderInfo = {
  id: string
  name: string
  auth?: { status?: string; account?: string; detail?: string }
  usage?: unknown
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
  providers?: SystemProviderInfo[]
  // agents paused by usage limits + when the daemon's autowake timer resumes them (#62)
  paused_limit?: number
  autowake_at?: string | null
  autowake_enabled?: boolean
}

export type UsageSplit = { input_tokens: number; cache_read: number; cache_creation: number; output_tokens: number }

// GET /boards/:id/shipped — annotated commit history joined with cards;
// ?ref=remote logs the push/upstream ref (the Git tab's Pushes pane)
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
