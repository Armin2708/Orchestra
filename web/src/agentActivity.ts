// Shared "is this agent actually working right now" derivation for every surface
// that lists agents (teams roster, agent console rail, kanban owner chips).

// SQLite datetime('now') strings are UTC but carry no zone marker.
export function dbTimeMs(ts: string | null | undefined): number | null {
  if (!ts) return null
  const iso = ts.includes('T') ? ts : `${ts.replace(' ', 'T')}Z`
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? null : ms
}

// Hooks/conductor touch last_seen on every tool call and stream event; an 'active'
// agent silent for longer than this most likely died mid-turn — don't keep pulsing.
const FRESH_MS = 10 * 60 * 1000

export type AgentActivity = 'working' | 'idle' | 'gone'

export function agentActivity(agent: { status: string; last_seen?: string | null }): AgentActivity {
  if (agent.status === 'gone') return 'gone'
  if (agent.status === 'active' || agent.status === 'starting') {
    const seen = dbTimeMs(agent.last_seen)
    if (seen === null || Date.now() - seen < FRESH_MS) return 'working'
  }
  return 'idle'
}
