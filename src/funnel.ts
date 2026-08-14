import type Database from 'better-sqlite3'

// The backlog funnel (#178): work descends one altitude at a time, the way an engineering
// org actually decomposes it. An epic is a milestone; below it a feature spec says what
// problem is being solved for whom, a tech spec says how it will be built, and a task is
// the implementable unit an engineer picks up.
//
// Each level has an owning role and its own Definition of Ready, and a child cannot be
// started until its parent is Ready — that gate is the whole point: it stops an engineer
// building against a spec nobody finished.

export const FUNNEL_KINDS = ['feature', 'tech_spec', 'task'] as const
export type FunnelKind = typeof FUNNEL_KINDS[number]

export const FUNNEL_LEVELS: {
  kind: FunnelKind
  label: string
  role: string
  parent: FunnelKind | null
  child: FunnelKind | null
  // what has to be written down before work below it may start
  ready: string
}[] = [
  {
    kind: 'feature',
    label: 'Feature spec',
    role: 'product',
    parent: null,
    child: 'tech_spec',
    ready: 'a problem statement and at least one success metric',
  },
  {
    kind: 'tech_spec',
    label: 'Tech spec',
    role: 'architect',
    parent: 'feature',
    child: 'task',
    ready: 'a design objective, at least one acceptance criterion, and the files it touches',
  },
  {
    kind: 'task',
    label: 'Task',
    role: 'engineer',
    parent: 'tech_spec',
    child: null,
    ready: 'an objective, at least one acceptance criterion, and the files it touches',
  },
]

const LEVEL = new Map(FUNNEL_LEVELS.map((l) => [l.kind, l]))

export const funnelLevel = (kind: string) => LEVEL.get(kind as FunnelKind) ?? LEVEL.get('task')!
export const isFunnelKind = (kind: string): kind is FunnelKind =>
  (FUNNEL_KINDS as readonly string[]).includes(kind)
export const roleForKind = (kind: string) => funnelLevel(kind).role

type CardRow = {
  id: number
  board_id: number
  kind: string
  parent_card_id: number | null
  milestone_id: number | null
  paths: string
  column_name: string
}

const cardRow = (db: Database.Database, id: number) =>
  db.prepare(`SELECT id, board_id, kind, parent_card_id, milestone_id, paths, column_name
    FROM cards WHERE id=?`).get(id) as CardRow | undefined

const contract = (db: Database.Database, id: number) =>
  db.prepare(`SELECT objective, acceptance_criteria FROM task_contracts WHERE card_id=?`)
    .get(id) as { objective: string; acceptance_criteria: string } | undefined

const criteriaCount = (raw: string | undefined) => {
  if (!raw) return 0
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.length : 0
  } catch { return 0 }
}

const pathCount = (raw: string | undefined) => {
  if (!raw) return 0
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.length : 0
  } catch { return 0 }
}

// Ready means "the level below can be written from this". A feature spec needs the problem
// and how success is measured; the two engineering levels also need the surface they touch.
export function funnelReady(db: Database.Database, cardId: number): boolean {
  const card = cardRow(db, cardId)
  if (!card) return false
  const c = contract(db, cardId)
  const hasContract = !!c && String(c.objective ?? '').trim() !== '' && criteriaCount(c?.acceptance_criteria) > 0
  if (!hasContract) return false
  if (card.kind === 'feature') return true
  return pathCount(card.paths) > 0
}

export type FunnelGate = { allowed: true } | { allowed: false; reason: string }

// The handoff gate: a card whose parent is not Ready may not be started. Cards without a
// parent (everything that predates the funnel, and any standalone ticket) are never gated.
export function funnelGate(db: Database.Database, cardId: number): FunnelGate {
  const card = cardRow(db, cardId)
  if (!card) return { allowed: true }
  const parentId = card.parent_card_id
  if (parentId == null) return { allowed: true }
  const parent = cardRow(db, parentId)
  if (!parent) return { allowed: true }
  if (parent.column_name === 'done' || funnelReady(db, parentId)) return { allowed: true }
  const level = funnelLevel(parent.kind)
  return {
    allowed: false,
    reason: `#${parent.id} (${level.label}) is not ready yet — it still needs ${level.ready}.`
      + ` Finish it, or detach this card from it, before starting work below it.`,
  }
}

export class FunnelError extends Error {
  constructor(message: string, readonly status = 400) { super(message) }
}

// Placing a card in the funnel: the parent must be exactly one level up, on the same board,
// and no card may become its own ancestor.
export function placeInFunnel(
  db: Database.Database,
  cardId: number,
  next: { kind?: string; parent_card_id?: number | null },
): void {
  const card = cardRow(db, cardId)
  if (!card) throw new FunnelError(`card ${cardId} not found`, 404)
  const kind = next.kind ?? card.kind
  if (!isFunnelKind(kind)) {
    throw new FunnelError(`kind must be one of ${FUNNEL_KINDS.join(', ')}`)
  }
  const parentId = next.parent_card_id === undefined ? card.parent_card_id : next.parent_card_id

  let milestoneId = card.milestone_id
  if (parentId != null) {
    const parent = cardRow(db, parentId)
    if (!parent) throw new FunnelError(`parent card ${parentId} not found`, 404)
    if (parent.board_id !== card.board_id) throw new FunnelError('parent card belongs to another board')
    if (parent.id === card.id) throw new FunnelError('a card cannot be its own parent')
    const expected = funnelLevel(kind).parent
    if (expected === null) throw new FunnelError(`a ${funnelLevel(kind).label} sits under an epic, not under a card`)
    if (parent.kind !== expected) {
      throw new FunnelError(
        `a ${funnelLevel(kind).label} belongs under a ${funnelLevel(expected).label}, not under a ${funnelLevel(parent.kind).label}`,
      )
    }
    for (let walk: CardRow | undefined = parent; walk; walk = walk.parent_card_id == null ? undefined : cardRow(db, walk.parent_card_id)) {
      if (walk.parent_card_id === card.id) throw new FunnelError('that would make the funnel a loop')
    }
    // children inherit the epic, so a whole branch stays on one milestone
    milestoneId = parent.milestone_id
  }

  db.prepare(`UPDATE cards SET kind=?, parent_card_id=?, milestone_id=coalesce(?, milestone_id),
      updated_at=datetime('now') WHERE id=?`)
    .run(kind, parentId, milestoneId, cardId)
}

// "Break this down": create the next level below a card, pre-linked and pre-scoped.
export function breakdownChild(
  db: Database.Database,
  parentId: number,
  input: { title: string; description?: string; paths?: string[] },
): number {
  const parent = cardRow(db, parentId)
  if (!parent) throw new FunnelError(`card ${parentId} not found`, 404)
  const childKind = funnelLevel(parent.kind).child
  if (!childKind) throw new FunnelError(`a ${funnelLevel(parent.kind).label} is the lowest level — it has no children`)
  const title = String(input.title ?? '').trim()
  if (!title) throw new FunnelError('a title is required')
  // a tech spec starts from the feature's surface unless the caller narrows it
  const paths = input.paths ?? (childKind === 'task' ? JSON.parse(parent.paths) as string[] : [])
  const { lastInsertRowid } = db.prepare(`
    INSERT INTO cards (board_id, title, description, paths, column_name, kind, parent_card_id, milestone_id)
    VALUES (?, ?, ?, ?, 'backlog', ?, ?, ?)`)
    .run(parent.board_id, title, input.description ?? '', JSON.stringify(paths),
      childKind, parent.id, parent.milestone_id)
  return Number(lastInsertRowid)
}
