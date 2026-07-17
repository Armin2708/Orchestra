import type Database from 'better-sqlite3'

export function removeAgentCards(db: Database.Database, agentId: number): void {
  db.prepare(`DELETE FROM card_events WHERE card_id IN (SELECT id FROM cards WHERE owner_agent_id=?)`).run(agentId)
  db.prepare(`UPDATE messages SET card_id=NULL WHERE card_id IN (SELECT id FROM cards WHERE owner_agent_id=?)`).run(agentId)
  db.prepare(`DELETE FROM cards WHERE owner_agent_id=?`).run(agentId)
}

export function reap(db: Database.Database): void {
  const goners = db.prepare(`SELECT id FROM agents
    WHERE status != 'gone' AND last_seen < datetime('now', '-30 minutes')`).all() as { id: number }[]
  for (const g of goners) removeAgentCards(db, g.id)
  db.prepare(`UPDATE agents SET status='gone'
    WHERE status != 'gone' AND last_seen < datetime('now', '-30 minutes')`).run()
  db.prepare(`UPDATE agents SET status='idle'
    WHERE status = 'active' AND last_seen < datetime('now', '-5 minutes')`).run()
}
