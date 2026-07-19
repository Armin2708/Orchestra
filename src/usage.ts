import type Database from 'better-sqlite3'

// real SDK token accounting per hired agent — input / cache-read / cache-creation / output.
// deliberately separate from token_telemetry, which estimates orchestra's *injected* context;
// these numbers come from the API's own usage reports, not char heuristics.
export type UsageSplit = { input_tokens: number; cache_read: number; cache_creation: number; output_tokens: number }

export const emptyUsage = (): UsageSplit => ({ input_tokens: 0, cache_read: 0, cache_creation: 0, output_tokens: 0 })

export const hasUsage = (u: UsageSplit): boolean =>
  u.input_tokens > 0 || u.cache_read > 0 || u.cache_creation > 0 || u.output_tokens > 0

// map an SDK usage object (assistant message or result); missing/garbage fields count 0
export function fromSdkUsage(u: any): UsageSplit {
  const n = (v: unknown) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0)
  return {
    input_tokens: n(u?.input_tokens),
    cache_read: n(u?.cache_read_input_tokens),
    cache_creation: n(u?.cache_creation_input_tokens),
    output_tokens: n(u?.output_tokens),
  }
}

export function addUsage(into: UsageSplit, add: UsageSplit): UsageSplit {
  into.input_tokens += add.input_tokens
  into.cache_read += add.cache_read
  into.cache_creation += add.cache_creation
  into.output_tokens += add.output_tokens
  return into
}

// a turn's authoritative usage is the result message's; a result without one
// (errors, older CLIs) falls back to the sum of its assistant messages
export const turnUsage = (resultUsage: any, fallback: UsageSplit): UsageSplit =>
  resultUsage ? fromSdkUsage(resultUsage) : { ...fallback }

export function recordUsage(db: Database.Database, boardId: number, agentId: number, u: UsageSplit): void {
  if (!hasUsage(u)) return
  db.prepare(`
    INSERT INTO agent_usage (board_id, agent_id, day, input_tokens, cache_read, cache_creation, output_tokens)
    VALUES (?, ?, date('now'), ?, ?, ?, ?)
    ON CONFLICT(board_id, agent_id, day) DO UPDATE SET
      input_tokens = input_tokens + excluded.input_tokens,
      cache_read = cache_read + excluded.cache_read,
      cache_creation = cache_creation + excluded.cache_creation,
      output_tokens = output_tokens + excluded.output_tokens`)
    .run(boardId, agentId, u.input_tokens, u.cache_read, u.cache_creation, u.output_tokens)
}

const SUMS = `COALESCE(SUM(input_tokens),0) AS input_tokens, COALESCE(SUM(cache_read),0) AS cache_read,
  COALESCE(SUM(cache_creation),0) AS cache_creation, COALESCE(SUM(output_tokens),0) AS output_tokens`

export function boardUsage(db: Database.Database, boardId: number) {
  return {
    total: db.prepare(`SELECT ${SUMS} FROM agent_usage WHERE board_id=?`).get(boardId),
    by_agent: db.prepare(`
      SELECT u.agent_id, a.name AS agent_name, ${SUMS} FROM agent_usage u
      LEFT JOIN agents a ON a.id = u.agent_id WHERE u.board_id=?
      GROUP BY u.agent_id ORDER BY input_tokens + cache_read + cache_creation DESC`).all(boardId),
    days: db.prepare(`
      SELECT day, ${SUMS} FROM agent_usage WHERE board_id=?
      GROUP BY day ORDER BY day`).all(boardId),
  }
}

export function usageTotal(db: Database.Database): UsageSplit {
  return db.prepare(`SELECT ${SUMS} FROM agent_usage`).get() as UsageSplit
}
