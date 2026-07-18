import type Database from 'better-sqlite3'

// injected-context accounting: every hook emission is estimated at ceil(chars/4) tokens
export type TelemetryEntry = { event: string; chars: number }

export const estimateTokens = (chars: number) => Math.ceil(chars / 4)

// the four injection types orchestra performs (see src/hooks.ts emit sites)
const EVENTS = new Set(['session_start', 'user_prompt_submit', 'post_tool_use', 'stop'])

export function recordTelemetry(db: Database.Database, boardId: number, agentId: number, entries: TelemetryEntry[]): void {
  const upsert = db.prepare(`
    INSERT INTO token_telemetry (board_id, agent_id, hook_event, day, chars, tokens, count)
    VALUES (?, ?, ?, date('now'), ?, ?, 1)
    ON CONFLICT(board_id, agent_id, hook_event, day) DO UPDATE SET
      chars = chars + excluded.chars, tokens = tokens + excluded.tokens, count = count + 1`)
  db.transaction(() => {
    for (const e of entries) {
      const chars = Math.floor(Number(e?.chars))
      if (!Number.isFinite(chars) || chars <= 0 || !EVENTS.has(String(e?.event))) continue
      upsert.run(boardId, agentId, e.event, chars, estimateTokens(chars))
    }
  })()
}

const SUMS = `COALESCE(SUM(chars),0) AS chars, COALESCE(SUM(tokens),0) AS tokens, COALESCE(SUM(count),0) AS count`

export function boardTelemetry(db: Database.Database, boardId: number) {
  return {
    total: db.prepare(`SELECT ${SUMS} FROM token_telemetry WHERE board_id=?`).get(boardId),
    by_event: db.prepare(`
      SELECT hook_event, ${SUMS} FROM token_telemetry WHERE board_id=?
      GROUP BY hook_event ORDER BY tokens DESC`).all(boardId),
    by_agent: db.prepare(`
      SELECT t.agent_id, a.name AS agent_name, ${SUMS} FROM token_telemetry t
      LEFT JOIN agents a ON a.id = t.agent_id WHERE t.board_id=?
      GROUP BY t.agent_id ORDER BY tokens DESC`).all(boardId),
    days: db.prepare(`
      SELECT day, ${SUMS} FROM token_telemetry WHERE board_id=?
      GROUP BY day ORDER BY day`).all(boardId),
  }
}

export function injectedTotal(db: Database.Database) {
  return db.prepare(`SELECT ${SUMS} FROM token_telemetry`).get() as { chars: number; tokens: number; count: number }
}
