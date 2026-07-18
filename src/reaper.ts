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

export function reap(db: Database.Database): void {
  // hired agents live inside the daemon and only quiet down between tasks — they leave
  // when fired (or when resurrection fails), never by staleness
  const goners = db.prepare(`SELECT id FROM agents
    WHERE status != 'gone' AND kind != 'hired' AND last_seen < datetime('now', '-30 minutes')`).all() as { id: number }[]
  for (const g of goners) removeAgentCards(db, g.id)
  db.prepare(`UPDATE agents SET status='gone'
    WHERE status != 'gone' AND kind != 'hired' AND last_seen < datetime('now', '-30 minutes')`).run()
  db.prepare(`UPDATE agents SET status='idle'
    WHERE status = 'active' AND last_seen < datetime('now', '-5 minutes')`).run()
}
