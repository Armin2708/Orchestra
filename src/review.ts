import { execFile } from 'node:child_process'
import type Database from 'better-sqlite3'

// Changed-paths summary for a review request. A card branch is authoritative: review
// the delivery against main instead of accidentally showing the shared checkout's HEAD.
export async function diffStat(cwd: string, branch?: string | null): Promise<string> {
  const git = (args: string[]) => new Promise<{ ok: boolean; out: string }>((resolve) => {
    execFile('git', args, { cwd, timeout: 5_000, maxBuffer: 256 * 1024 },
      (err, out) => resolve({ ok: !err, out: err ? '' : String(out).trim() }))
  })
  if (branch) {
    const ref = await git(['rev-parse', '--verify', `${branch}^{commit}`])
    if (ref.ok) {
      const delivery = await git(['diff', '--stat', `main...${branch}`])
      return delivery.out || `branch ${branch}: no changes relative to main`
    }
  }
  const working = await git(['diff', '--stat', 'HEAD'])
  if (working.out) return working.out
  return (await git(['show', '--stat', '--format=%h %s', 'HEAD'])).out
}

// one open request per review cycle: a request is open until a decision lands after it
export function hasOpenReviewRequest(db: Database.Database, cardId: number): boolean {
  const row = db.prepare(`
    SELECT
      (SELECT COALESCE(MAX(id), 0) FROM card_events WHERE card_id=? AND type='review_request') AS req,
      (SELECT COALESCE(MAX(id), 0) FROM card_events WHERE card_id=? AND type='review_decision') AS dec
  `).get(cardId, cardId) as { req: number; dec: number }
  return row.req > row.dec
}

export function recordDecision(db: Database.Database, card: {
  id: number; board_id: number; milestone_id?: number | null; step_order?: number | null
}, decision: 'approve' | 'send_back', note: string | null) {
  const { lastInsertRowid } = db.prepare(`
    INSERT INTO review_decisions (board_id, card_id, milestone_id, step_order, decision, note)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .run(card.board_id, card.id, card.milestone_id ?? null, card.step_order ?? null, decision, note)
  return db.prepare(`SELECT * FROM review_decisions WHERE id=?`).get(Number(lastInsertRowid))
}

export const listCardDecisions = (db: Database.Database, cardId: number) =>
  db.prepare(`SELECT * FROM review_decisions WHERE card_id=? ORDER BY id DESC`).all(cardId)

export const listBoardDecisions = (db: Database.Database, boardId: number) =>
  db.prepare(`
    SELECT d.*, c.title AS card_title FROM review_decisions d
    JOIN cards c ON c.id = d.card_id
    WHERE d.board_id=? ORDER BY d.id DESC`).all(boardId)
