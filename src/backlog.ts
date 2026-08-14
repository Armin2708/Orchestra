import type Database from 'better-sqlite3'

// Stack-ranked backlog: rank REAL, smaller = higher. Insertions take the midpoint between
// neighbors; when floating-point runs out of room the whole board's backlog renormalizes
// to integer steps in the same transaction.
const GAP = 1024
const MIN_GAP = 1e-9

export type RankPosition = {
  before?: number
  after?: number
  top?: boolean
  bottom?: boolean
}

type RankedRow = { id: number; rank: number }

const backlogRanks = (db: Database.Database, boardId: number, excludeId: number): RankedRow[] =>
  db.prepare(`SELECT id, rank FROM cards
    WHERE board_id=? AND column_name='backlog' AND rank IS NOT NULL AND id != ?
    ORDER BY rank, id`).all(boardId, excludeId) as RankedRow[]

// the placement math itself, shared by every ranked list on a board: midpoint between
// the neighbours, and a renormalize pass when floating point runs out of room
function placeBetween(
  ranked: RankedRow[],
  rowId: number,
  position: RankPosition,
  missing: (id: number) => string,
  write: (id: number, rank: number) => void,
): number {
  let index: number
  if (position.top) index = 0
  else if (position.bottom) index = ranked.length
  else if (position.before != null) {
    index = ranked.findIndex((row) => row.id === position.before)
    if (index < 0) throw new Error(missing(position.before))
  } else if (position.after != null) {
    const at = ranked.findIndex((row) => row.id === position.after)
    if (at < 0) throw new Error(missing(position.after))
    index = at + 1
  } else throw new Error('rank position requires before, after, top, or bottom')

  const lo = index > 0 ? ranked[index - 1].rank : null
  const hi = index < ranked.length ? ranked[index].rank : null
  const rank = lo === null && hi === null ? 0
    : lo === null ? hi! - GAP
      : hi === null ? lo + GAP
        : (lo + hi) / 2
  if (lo !== null && hi !== null && hi - lo < MIN_GAP) {
    const order = [...ranked.slice(0, index), { id: rowId, rank: 0 }, ...ranked.slice(index)]
    order.forEach((row, i) => write(row.id, i * GAP))
    return index * GAP
  }
  write(rowId, rank)
  return rank
}

export function rankBetween(
  db: Database.Database,
  cardId: number,
  position: RankPosition,
): number {
  const apply = db.transaction((): number => {
    const card = db.prepare(`SELECT id, board_id FROM cards WHERE id=?`)
      .get(cardId) as { id: number; board_id: number } | undefined
    if (!card) throw new Error(`card ${cardId} not found`)
    const update = db.prepare(`UPDATE cards SET rank=?, updated_at=datetime('now') WHERE id=?`)
    return placeBetween(
      backlogRanks(db, card.board_id, cardId),
      cardId,
      position,
      (id) => `card ${id} is not a ranked backlog card`,
      (id, rank) => { update.run(rank, id) },
    )
  })
  return apply.immediate()
}

// The roadmap orders milestones the same way the backlog orders cards. Milestones that
// predate ranking sort last by id, so an unranked board still reads in creation order.
const milestoneRanks = (db: Database.Database, boardId: number, excludeId: number): RankedRow[] =>
  db.prepare(`SELECT id, rank FROM milestones
    WHERE board_id=? AND rank IS NOT NULL AND id != ?
    ORDER BY rank, id`).all(boardId, excludeId) as RankedRow[]

export function milestoneRankBetween(
  db: Database.Database,
  milestoneId: number,
  position: RankPosition,
): number {
  const apply = db.transaction((): number => {
    const milestone = db.prepare(`SELECT id, board_id FROM milestones WHERE id=?`)
      .get(milestoneId) as { id: number; board_id: number } | undefined
    if (!milestone) throw new Error(`milestone ${milestoneId} not found`)
    const update = db.prepare(`UPDATE milestones SET rank=? WHERE id=?`)
    // milestones created before ranking have no rank to sit against. Seed the whole board
    // in its current display order first, so the operator's first drag can't fail.
    const unranked = db.prepare(`SELECT count(*) AS n FROM milestones WHERE board_id=? AND rank IS NULL`)
      .get(milestone.board_id) as { n: number }
    if (unranked.n > 0) {
      const all = db.prepare(`SELECT id FROM milestones WHERE board_id=?
        ORDER BY rank IS NULL, rank, id`).all(milestone.board_id) as { id: number }[]
      all.forEach((row, i) => update.run(i * GAP, row.id))
    }
    return placeBetween(
      milestoneRanks(db, milestone.board_id, milestoneId),
      milestoneId,
      position,
      (id) => `milestone ${id} is not a ranked milestone`,
      (id, rank) => { update.run(rank, id) },
    )
  })
  return apply.immediate()
}

// Definition of Ready: the card carries a task contract with a real objective and at least
// one acceptance criterion. Raw notes stay in triage until groomed.
export function isReady(db: Database.Database, cardId: number): boolean {
  const row = db.prepare(`SELECT objective, acceptance_criteria FROM task_contracts WHERE card_id=?`)
    .get(cardId) as { objective: string; acceptance_criteria: string } | undefined
  if (!row || !String(row.objective).trim()) return false
  try {
    const criteria = JSON.parse(row.acceptance_criteria)
    return Array.isArray(criteria) && criteria.length > 0
  } catch { return false }
}

// Atomically claim the top-ranked ready backlog card for an agent: two concurrent claimers
// get different cards. Returns the claimed card (with owner name) or null.
export function claimNext(
  db: Database.Database,
  boardId: number,
  agentName?: string,
): Record<string, unknown> | null {
  const claim = db.transaction((): Record<string, unknown> | null => {
    const top = db.prepare(`SELECT c.id FROM cards c
      JOIN task_contracts t ON t.card_id = c.id
      WHERE c.board_id=? AND c.column_name='backlog' AND c.rank IS NOT NULL
        AND trim(t.objective) != '' AND json_array_length(t.acceptance_criteria) > 0
      ORDER BY c.rank, c.id LIMIT 1`).get(boardId) as { id: number } | undefined
    if (!top) return null
    const agent = agentName
      ? db.prepare(`SELECT id FROM agents WHERE board_id=? AND name=?`).get(boardId, agentName) as { id: number } | undefined
      : undefined
    db.prepare(`UPDATE cards SET column_name='in_progress',
        owner_agent_id=coalesce(?, owner_agent_id), updated_at=datetime('now')
      WHERE id=?`).run(agent?.id ?? null, top.id)
    return db.prepare(`SELECT c.*, a.name AS owner FROM cards c
      LEFT JOIN agents a ON a.id=c.owner_agent_id WHERE c.id=?`).get(top.id) as Record<string, unknown>
  })
  return claim.immediate()
}
