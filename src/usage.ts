import type Database from 'better-sqlite3'
import {
  runBoundCompatibilityMigrationOperation,
} from './agent-os/compatibility-migration-instrumentation.js'

// real SDK token accounting per hired agent — input / cache-read / cache-creation / output.
// deliberately separate from token_telemetry, which estimates orchestra's *injected* context;
// these numbers come from the API's own usage reports, not char heuristics.
export type UsageSplit = { input_tokens: number; cache_read: number; cache_creation: number; output_tokens: number }

export type ProviderUsageSplit = {
  provider: string
  total_tokens: number
  input_tokens: number
  cached_input_tokens: number
  cache_creation_input_tokens: number
  output_tokens: number
  reasoning_output_tokens: number
  cost_cents: number | null
}

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

const usageNumber = (value: unknown): number =>
  Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0

function assertProviderUsageUtcDay(
  db: Database.Database,
  expectedDay: string,
): void {
  const { day } = db.prepare(`SELECT date('now') AS day`).get() as {
    day: string
  }
  if (day !== expectedDay) {
    throw new Error('provider usage crossed a UTC day boundary')
  }
}

export function fromCodexUsage(value: unknown): ProviderUsageSplit {
  const row = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const input = usageNumber(row.inputTokens ?? row.input_tokens)
  const cached = usageNumber(row.cachedInputTokens ?? row.cached_input_tokens)
  const output = usageNumber(row.outputTokens ?? row.output_tokens)
  const reasoning = usageNumber(row.reasoningOutputTokens ?? row.reasoning_output_tokens)
  const reportedTotal = usageNumber(row.totalTokens ?? row.total_tokens)
  return {
    provider: 'codex',
    total_tokens: reportedTotal || input + output,
    input_tokens: input,
    cached_input_tokens: Math.min(cached, input),
    cache_creation_input_tokens: 0,
    output_tokens: output,
    reasoning_output_tokens: Math.min(reasoning, output),
    cost_cents: null,
  }
}

export function recordProviderUsage(
  db: Database.Database,
  boardId: number,
  agentId: number,
  usage: ProviderUsageSplit,
): void {
  if (usage.total_tokens <= 0 && usage.cost_cents == null) return
  const observedAt = new Date()
  const day = observedAt.toISOString().slice(0, 10)
  // Claude reports cache reads as a separate additive bucket. Codex reports cached
  // input as a subset of input_tokens, so mirroring it into the legacy additive
  // cache_read column would inflate usageTotal()/boardUsage() rollups.
  const legacyCacheRead = usage.provider === 'codex' ? 0 : usage.cached_input_tokens
  runBoundCompatibilityMigrationOperation(
    db,
    {
      observed_at: observedAt,
      subject: {
        table: 'agent_usage',
        board_id: boardId,
        agent_id: agentId,
        day,
      },
      success_observations: [
        { operation: 'adapter_translation' },
        { operation: 'projection_refresh' },
      ],
      failure_diagnostic: 'projection_refresh_rejected',
    },
    () => {
      assertProviderUsageUtcDay(db, day)
      const parameters = {
        board_id: boardId,
        agent_id: agentId,
        day,
        provider: usage.provider,
        input_tokens: usage.input_tokens,
        cache_read: legacyCacheRead,
        cache_creation: usage.cache_creation_input_tokens,
        output_tokens: usage.output_tokens,
        total_tokens: usage.total_tokens,
        cached_input_tokens: usage.cached_input_tokens,
        reasoning_output_tokens: usage.reasoning_output_tokens,
        cost_cents: usage.cost_cents,
      }
      const update = db.prepare(`
        UPDATE agent_usage SET
          provider=@provider,
          input_tokens=input_tokens+@input_tokens,
          cache_read=cache_read+@cache_read,
          cache_creation=cache_creation+@cache_creation,
          output_tokens=output_tokens+@output_tokens,
          total_tokens=total_tokens+@total_tokens,
          cached_input_tokens=cached_input_tokens+@cached_input_tokens,
          reasoning_output_tokens=reasoning_output_tokens+@reasoning_output_tokens,
          cost_cents=CASE
            WHEN @cost_cents IS NULL THEN cost_cents
            WHEN cost_cents IS NULL THEN @cost_cents
            ELSE cost_cents+@cost_cents
          END
        WHERE board_id=@board_id AND agent_id=@agent_id AND day=@day
      `).run(parameters)
      if (update.changes === 1) {
        assertProviderUsageUtcDay(db, day)
        return
      }
      if (update.changes !== 0) {
        throw new Error('provider usage update affected an invalid row count')
      }
      const insert = db.prepare(`
        INSERT INTO agent_usage (
          board_id, agent_id, day, provider, input_tokens, cache_read, cache_creation, output_tokens,
          total_tokens, cached_input_tokens, reasoning_output_tokens, cost_cents
        ) VALUES (
          @board_id, @agent_id, @day, @provider, @input_tokens, @cache_read,
          @cache_creation, @output_tokens, @total_tokens, @cached_input_tokens,
          @reasoning_output_tokens, @cost_cents
        )
      `).run(parameters)
      if (insert.changes !== 1) {
        throw new Error('provider usage insert did not persist')
      }
      assertProviderUsageUtcDay(db, day)
    },
  )
}

export function recordUsage(db: Database.Database, boardId: number, agentId: number, u: UsageSplit): void {
  if (!hasUsage(u)) return
  recordProviderUsage(db, boardId, agentId, {
    provider: 'claude',
    total_tokens: u.input_tokens + u.cache_read + u.cache_creation + u.output_tokens,
    input_tokens: u.input_tokens,
    cached_input_tokens: u.cache_read,
    cache_creation_input_tokens: u.cache_creation,
    output_tokens: u.output_tokens,
    reasoning_output_tokens: 0,
    cost_cents: null,
  })
}

const SUMS = `COALESCE(SUM(input_tokens),0) AS input_tokens, COALESCE(SUM(cache_read),0) AS cache_read,
  COALESCE(SUM(cache_creation),0) AS cache_creation, COALESCE(SUM(output_tokens),0) AS output_tokens`
const PROVIDER_SUMS = `COALESCE(SUM(total_tokens),0) AS total_tokens,
  COALESCE(SUM(input_tokens),0) AS input_tokens,
  COALESCE(SUM(cached_input_tokens),0) AS cached_input_tokens,
  COALESCE(SUM(output_tokens),0) AS output_tokens,
  COALESCE(SUM(reasoning_output_tokens),0) AS reasoning_output_tokens,
  SUM(cost_cents) AS cost_cents`

export function providerBoardUsage(db: Database.Database, boardId: number) {
  return {
    total: db.prepare(`SELECT ${PROVIDER_SUMS} FROM agent_usage WHERE board_id=?`).get(boardId),
    by_provider: db.prepare(`SELECT provider, ${PROVIDER_SUMS} FROM agent_usage
      WHERE board_id=? GROUP BY provider ORDER BY total_tokens DESC`).all(boardId),
    by_agent: db.prepare(`SELECT u.agent_id, a.name AS agent_name, u.provider, ${PROVIDER_SUMS}
      FROM agent_usage u LEFT JOIN agents a ON a.id=u.agent_id WHERE u.board_id=?
      GROUP BY u.agent_id, u.provider ORDER BY total_tokens DESC`).all(boardId),
  }
}

export function providerUsageTotal(db: Database.Database) {
  return {
    total: db.prepare(`SELECT ${PROVIDER_SUMS} FROM agent_usage`).get(),
    by_provider: db.prepare(`SELECT provider, ${PROVIDER_SUMS} FROM agent_usage
      GROUP BY provider ORDER BY total_tokens DESC`).all(),
  }
}

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
    normalized: providerBoardUsage(db, boardId),
  }
}

export function usageTotal(db: Database.Database): UsageSplit {
  return db.prepare(`SELECT ${SUMS} FROM agent_usage`).get() as UsageSplit
}
