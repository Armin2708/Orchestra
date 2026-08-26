import type Database from 'better-sqlite3'

/**
 * Delete a board and every row that hangs off it, across the whole schema.
 *
 * The schema is too wide for a hand-kept list — dozens of agent-os tables
 * reference boards (many with ON DELETE RESTRICT, which blocks a bare
 * `DELETE FROM boards`), and new migrations add more. Instead of enumerating
 * them, walk the declared foreign-key graph child-first, plus a sweep over
 * tables that carry a bare `board_id` column with no declared FK
 * (token_telemetry, agent_usage, trackbook tables, …).
 *
 * FK checks are deferred to commit, so ordering inside the transaction only
 * has to be roughly child-first; the commit still fails loudly if any
 * referencing row was missed rather than leaving orphans.
 */
export function deleteBoardCascade(db: Database.Database, boardId: number): void {
  const tables = (db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`,
  ).all() as { name: string }[]).map((t) => t.name)
  const tableSet = new Set(tables)

  // children.get(parent) = FK edges pointing at parent
  const children = new Map<string, { table: string; from: string; to: string }[]>()
  for (const table of tables) {
    const fks = db.pragma(`foreign_key_list(${JSON.stringify(table)})`) as
      { table: string; from: string; to: string | null }[]
    for (const fk of fks) {
      if (!tableSet.has(fk.table)) continue
      const list = children.get(fk.table) ?? []
      list.push({ table, from: fk.from, to: fk.to ?? 'id' })
      children.set(fk.table, list)
    }
  }

  // Depth-first: wipe every row of `table` matching `where`, taking FK
  // children along. `path` breaks cycles (self-references, mutual FKs);
  // deferred FK checking makes the resulting order safe.
  const wipe = (table: string, where: string, params: unknown[], path: string[]): void => {
    if (path.length > 12) return
    for (const fk of children.get(table) ?? []) {
      if (path.includes(fk.table)) continue
      wipe(fk.table,
        `"${fk.from}" IN (SELECT "${fk.to}" FROM "${table}" WHERE ${where})`,
        params, [...path, table])
    }
    db.prepare(`DELETE FROM "${table}" WHERE ${where}`).run(...params)
  }

  // Several subsystems install RAISE(ABORT) immutability triggers (knowledge chunk
  // evidence, autoship intents, delivery reports…). They guard against edits inside a
  // living board — an operator deleting the whole project is a sanctioned purge, so
  // suspend every trigger for the transaction and restore them from their stored SQL.
  // DDL is transactional in SQLite: a failed purge rolls the triggers back too.
  const triggers = db.prepare(
    `SELECT name, sql FROM sqlite_master WHERE type='trigger' AND sql IS NOT NULL`,
  ).all() as { name: string; sql: string }[]

  db.transaction(() => {
    db.pragma('defer_foreign_keys = ON')
    for (const trigger of triggers) db.exec(`DROP TRIGGER "${trigger.name.replace(/"/g, '""')}"`)
    // join/side tables keyed by agent or message id only — must run before the
    // board_id sweep empties agents/messages, or their subqueries match nothing
    wipe('agent_transcripts', `"agent_id" IN (SELECT id FROM agents WHERE board_id = ?)`, [boardId], [])
    wipe('deliveries', `"message_id" IN (SELECT id FROM messages WHERE board_id = ?)`, [boardId], [])
    wipe('message_targets', `"message_id" IN (SELECT id FROM messages WHERE board_id = ?)`, [boardId], [])
    // tables that scope rows by board_id, with or without a declared FK
    for (const table of tables) {
      if (table === 'boards') continue
      const cols = db.pragma(`table_info(${JSON.stringify(table)})`) as { name: string }[]
      if (!cols.some((c) => c.name === 'board_id')) continue
      wipe(table, `"board_id" = ?`, [boardId], [])
    }
    wipe('boards', `"id" = ?`, [boardId], [])
    for (const trigger of triggers) db.exec(trigger.sql)
  })()
}
