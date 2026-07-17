import type Database from 'better-sqlite3'

export function reap(db: Database.Database): void {
  db.prepare(`UPDATE agents SET status='gone'
    WHERE status != 'gone' AND last_seen < datetime('now', '-30 minutes')`).run()
  db.prepare(`UPDATE agents SET status='idle'
    WHERE status = 'active' AND last_seen < datetime('now', '-5 minutes')`).run()
}
