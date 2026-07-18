import type Database from 'better-sqlite3'

export function removeAgentCards(db: Database.Database, agentId: number): void {
  // only the agent's abandoned work-in-flight leaves with it; tickets it authored or was
  // assigned (backlog/review/blocked) outlive the agent — released to the pool, history kept
  const sel = `SELECT id FROM cards WHERE owner_agent_id=? AND column_name = 'in_progress'`
  db.prepare(`DELETE FROM card_events WHERE card_id IN (${sel})`).run(agentId)
  db.prepare(`UPDATE messages SET card_id=NULL WHERE card_id IN (${sel})`).run(agentId)
  db.prepare(`DELETE FROM cards WHERE owner_agent_id=? AND column_name = 'in_progress'`).run(agentId)
  db.prepare(`UPDATE cards SET owner_agent_id=NULL, updated_at=datetime('now')
    WHERE owner_agent_id=? AND column_name != 'done'`).run(agentId)
}

// dead-letter routing: a message to an agent that left the board would otherwise sit
// undelivered forever with the sender none the wiser — bounce it as a system reply, which
// closes the open question and lands in the sender's inbox (or the board thread when the
// sender is unknown/also gone). The bounce being a reply is also the idempotency guard.
export function bounceDeadLetters(db: Database.Database, agentId: number): any[] {
  const agent = db.prepare(`SELECT * FROM agents WHERE id=?`).get(agentId) as { name: string } | undefined
  if (!agent) return []
  const dead = db.prepare(`
    SELECT * FROM messages WHERE to_agent_id=? AND delivered_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM messages r WHERE r.reply_to = messages.id)`).all(agentId) as any[]
  const insert = db.prepare(`
    INSERT INTO messages (board_id, from_agent_id, to_agent_id, card_id, body, reply_to)
    VALUES (?, NULL, ?, ?, ?, ?)`)
  return dead.map((m) => {
    const body = `⚠ undeliverable: ${agent.name} left the board before reading msg #${m.id} — it was never seen. Re-ask a live agent or post to the board.`
    const { lastInsertRowid } = insert.run(m.board_id, m.from_agent_id, m.card_id, body, m.id)
    return db.prepare(`SELECT * FROM messages WHERE id=?`).get(Number(lastInsertRowid))
  })
}

export function reap(db: Database.Database): void {
  // hired agents live inside the daemon and only quiet down between tasks — they leave
  // when fired (or when resurrection fails), never by staleness
  const goners = db.prepare(`SELECT id FROM agents
    WHERE status != 'gone' AND kind != 'hired' AND last_seen < datetime('now', '-30 minutes')`).all() as { id: number }[]
  for (const g of goners) { removeAgentCards(db, g.id); bounceDeadLetters(db, g.id) }
  db.prepare(`UPDATE agents SET status='gone'
    WHERE status != 'gone' AND kind != 'hired' AND last_seen < datetime('now', '-30 minutes')`).run()
  db.prepare(`UPDATE agents SET status='idle'
    WHERE status = 'active' AND last_seen < datetime('now', '-5 minutes')`).run()
}
