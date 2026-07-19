import { execFile } from 'node:child_process'
import type Database from 'better-sqlite3'

// Shipped view: git history joined with the cards/agents that produced it.
// Ground truth is the 'shipped' card_event (payload.hash = full sha, recorded by
// `orchestra shipped` at merge time); #N subject refs and card-id patterns in
// merged branch names are the fallback for commits nobody annotated.

export type ShipFile = { path: string; insertions: number; deletions: number }
export type ShipCard = {
  id: number
  title: string
  agent: string | null
  summary: string | null
  decision: 'approve' | 'send_back' | null
  matched_by: 'shipped' | 'ref'
}
export type ShipCommit = {
  hash: string
  short: string
  date: string
  author: string
  subject: string
  body: string
  files: ShipFile[]
  insertions: number
  deletions: number
  cards: ShipCard[]
}
export type ShipLog = {
  head: string | null
  commits: ShipCommit[]
  offset: number
  limit: number
  has_more: boolean
  error?: string
}

const git = (cwd: string, args: string[]) => new Promise<string>((resolve, reject) => {
  execFile('git', args, { cwd, timeout: 10_000, maxBuffer: 8 * 1024 * 1024 },
    (err, out) => (err ? reject(err) : resolve(String(out))))
})

// \x1e separates commits, \x1f separates fields — both are unprintable in messages
const REC = '\x1e'
const FIELD = '\x1f'
const FORMAT = `${REC}%H${FIELD}%h${FIELD}%aI${FIELD}%an${FIELD}%s${FIELD}%b${FIELD}`

export function parseGitLog(raw: string): ShipCommit[] {
  const commits: ShipCommit[] = []
  for (const rec of raw.split(REC)) {
    if (!rec.trim()) continue
    const [hash, short, date, author, subject, body, tail] = rec.split(FIELD)
    if (!hash || !short) continue
    const files: ShipFile[] = []
    // after the format fields come this commit's --numstat lines: "ins\tdel\tpath"
    for (const line of (tail ?? '').split('\n')) {
      const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/)
      if (m) files.push({
        path: m[3],
        insertions: m[1] === '-' ? 0 : Number(m[1]),
        deletions: m[2] === '-' ? 0 : Number(m[2]),
      })
    }
    commits.push({
      hash, short, date, author,
      subject: (subject ?? '').trim(),
      body: (body ?? '').trim(),
      files,
      insertions: files.reduce((n, f) => n + f.insertions, 0),
      deletions: files.reduce((n, f) => n + f.deletions, 0),
      cards: [],
    })
  }
  return commits
}

// card ids cited in the message: "#N" refs plus ids encoded in merged branch
// names — fix/46-creator-vs-owner, feat/41-model-effort, slash-commands-40.
// Subject and branch refs are authoritative; body refs are consulted only when
// they yield nothing, since merge bodies routinely *mention* other cards
// ("resolved conflict with #41") without having shipped them.
export function refCardIds(subject: string, body: string): number[] {
  const ids = new Set<number>()
  const text = `${subject}\n${body}`
  for (const m of subject.matchAll(/#(\d{1,6})\b/g)) ids.add(Number(m[1]))
  const branches = [...text.matchAll(/[Mm]erge (?:remote-tracking )?branch '([^']+)'/g)].map((m) => m[1])
  for (const m of text.matchAll(/[Mm]erge pull request #\d+ from \S+?\/(\S+)/g)) branches.push(m[1])
  for (const b of branches) {
    const leading = b.match(/(?:^|\/)(\d{1,6})-/) // fix/46-creator-vs-owner
    if (leading) ids.add(Number(leading[1]))
    const trailing = b.match(/-(\d{1,6})$/) // slash-commands-40
    if (trailing) ids.add(Number(trailing[1]))
  }
  if (ids.size === 0) for (const m of body.matchAll(/#(\d{1,6})\b/g)) ids.add(Number(m[1]))
  return [...ids]
}

// parsed git output cached per (cwd, head, offset, limit) — polling only pays a rev-parse
const logCache = new Map<string, ShipCommit[]>()
const CACHE_MAX = 64

export async function shiplog(
  db: Database.Database,
  board: { id: number; project_path: string },
  opts: { offset?: number; limit?: number } = {},
): Promise<ShipLog> {
  const offset = Math.max(0, Math.floor(opts.offset ?? 0))
  const limit = Math.min(200, Math.max(1, Math.floor(opts.limit ?? 50)))
  let head: string
  try {
    head = (await git(board.project_path, ['rev-parse', 'HEAD'])).trim()
  } catch (e: any) {
    return { head: null, commits: [], offset, limit, has_more: false, error: 'not a git repository (or no commits yet)' }
  }

  const key = `${board.project_path}\n${head}\n${offset}\n${limit}`
  let commits = logCache.get(key)
  if (!commits) {
    // limit+1 tells us whether another page exists without a second git call
    const raw = await git(board.project_path, [
      'log', '--first-parent', '--numstat', `--max-count=${limit + 1}`, `--skip=${offset}`,
      `--pretty=format:${FORMAT}`,
    ]).catch(() => '')
    commits = parseGitLog(raw)
    if (logCache.size >= CACHE_MAX) logCache.delete(logCache.keys().next().value as string)
    logCache.set(key, commits)
  }
  const has_more = commits.length > limit
  const page = commits.slice(0, limit).map((c) => ({ ...c, cards: [] as ShipCard[] }))

  // ground truth first: 'shipped' card_events map full sha → card id
  const shippedRows = db.prepare(`
    SELECT e.card_id, e.payload FROM card_events e
    JOIN cards c ON c.id = e.card_id
    WHERE c.board_id = ? AND e.type = 'shipped'`).all(board.id) as { card_id: number; payload: string }[]
  const byHash = new Map<string, number[]>()
  for (const r of shippedRows) {
    try {
      const hash = JSON.parse(r.payload)?.hash
      if (typeof hash === 'string' && hash) {
        const list = byHash.get(hash) ?? []
        if (!list.includes(r.card_id)) list.push(r.card_id)
        byHash.set(hash, list)
      }
    } catch { /* malformed payload — skip */ }
  }

  const cardRow = db.prepare(`
    SELECT c.id, c.title, a.name AS owner FROM cards c
    LEFT JOIN agents a ON a.id = c.owner_agent_id
    WHERE c.id = ? AND c.board_id = ?`)
  const exitRow = db.prepare(`
    SELECT payload FROM card_events WHERE card_id = ? AND type = 'agent_exit' ORDER BY id DESC LIMIT 1`)
  const decisionRow = db.prepare(`
    SELECT decision FROM review_decisions WHERE card_id = ? ORDER BY id DESC LIMIT 1`)

  const enrich = (id: number, matched_by: ShipCard['matched_by']): ShipCard | null => {
    const c = cardRow.get(id, board.id) as any
    if (!c) return null // a #N that isn't a card on this board (e.g. an issue number)
    let summary: string | null = null
    let agent: string | null = c.owner ?? null
    const exit = exitRow.get(id) as any
    if (exit) {
      try {
        const p = JSON.parse(exit.payload)
        summary = p.summary || p.reason || null
        agent = agent ?? p.agent ?? null
      } catch { /* ignore */ }
    }
    const d = decisionRow.get(id) as any
    return { id, title: c.title, agent, summary, decision: d?.decision ?? null, matched_by }
  }

  for (const commit of page) {
    const seen = new Set<number>()
    for (const id of byHash.get(commit.hash) ?? []) {
      const card = enrich(id, 'shipped')
      if (card) { commit.cards.push(card); seen.add(id) }
    }
    // regex fallback only for ids the ground truth didn't already claim
    for (const id of refCardIds(commit.subject, commit.body)) {
      if (seen.has(id)) continue
      const card = enrich(id, 'ref')
      if (card) { commit.cards.push(card); seen.add(id) }
    }
  }

  return { head, commits: page, offset, limit, has_more }
}
