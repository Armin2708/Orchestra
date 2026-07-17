export const api = async (method: string, p: string, body?: unknown) => {
  const res = await fetch(`/api/v1${p}`, {
    method,
    // fastify rejects bodyless requests that carry a json content-type
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export type Card = { id: number; title: string; description: string; column: string; owner: string | null; paths: string[]; updated_at: string }
export type Agent = { id: number; name: string; status: string; last_seen: string; kind?: string; board_id?: number }
export type Thread = { id: number; body: string; from_name: string | null; to_name: string | null; created_at: string; answered: boolean; replies: { id: number; body: string; from_name: string | null; created_at: string }[] }
export type Snapshot = { board: { id: number; name: string }; agents: Agent[]; cards: Card[]; open_questions: any[]; threads: Thread[] }

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
