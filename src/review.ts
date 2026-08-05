import { execFile } from 'node:child_process'
import type Database from 'better-sqlite3'

// Changed-paths summary for a review request. Only the card's OWN delivery is
// authoritative — a per-card branch, or (in the shared-checkout workflow where
// cards have no branch) the card's own commits found by the "(#id)" convention.
// We deliberately never fall back to `git diff HEAD`: on a shared checkout that
// is every agent's mixed working tree, which pollutes the diffstat with stray
// files that have nothing to do with this card. Better empty than misleading.
export async function diffStat(cwd: string, branch?: string | null, cardId?: number | null): Promise<string> {
  const git = (args: string[]) => new Promise<{ ok: boolean; out: string }>((resolve) => {
    execFile('git', args, { cwd, timeout: 5_000, maxBuffer: 256 * 1024 },
      (err, out) => resolve({ ok: !err, out: err ? '' : String(out).trim() }))
  })
  if (branch) {
    const ref = await git(['rev-parse', '--verify', `${branch}^{commit}`])
    if (ref.ok) {
      const remoteHead = await git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
      const bases = ['main', remoteHead.out, 'master', 'HEAD'].filter(Boolean)
      let base = 'HEAD'
      for (const candidate of bases) {
        if ((await git(['rev-parse', '--verify', `${candidate}^{commit}`])).ok) { base = candidate; break }
      }
      const delivery = await git(['diff', '--stat', `${base}...${branch}`])
      if (!delivery.ok) return ''
      return delivery.out || `branch ${branch}: no changes relative to ${base}`
    }
  }
  // no branch: show the card's own shipped commit(s) if the history records them,
  // matching the "feat(x): … (#id)" / "#id" message convention. Never the working tree.
  if (cardId) {
    // -E (POSIX ERE — git has no \b on macOS); anchor so #135 never matches #1350
    const hash = await git(['log', '-1', '--format=%H', '-E', `--grep=#${cardId}([^0-9]|$)`])
    if (hash.ok && hash.out) {
      const show = await git(['show', '--stat', '--format=%h %s', hash.out])
      if (show.out) return show.out
    }
  }
  return ''
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
