import Fastify, { FastifyInstance } from 'fastify'
import type Database from 'better-sqlite3'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateName } from './names.js'
import { pathsIntersect } from './overlap.js'
import { isSimilar, isShippedMatch } from './similar.js'
import { removeAgentCards, bounceDeadLetters } from './reaper.js'
import { diffStat, hasOpenReviewRequest, recordDecision, listCardDecisions, listBoardDecisions } from './review.js'
import { tokenEquals } from './token.js'
import { VERSION } from './version.js'
import { hardware, claudeUsage } from './system.js'
import { recordTelemetry, boardTelemetry, injectedTotal, TelemetryEntry } from './telemetry.js'
import { boardUsage, usageTotal } from './usage.js'
import { recordShipped } from './shipped.js'

export type Bus = EventEmitter
// minimal surface the server needs from the conductor (injected by the daemon)
export interface ConductorLike {
  isHired(agentId: number): boolean
  hire(opts: { boardId: number; cwd: string; name?: string; model?: string; role?: 'strategist' | 'auditor'; ephemeral?: boolean; resumeSession?: string; permissionMode?: string }): any
  deliver(agentId: number, msg: any): boolean
  task(agentId: number, text: string): boolean
  transcript(agentId: number): any
  subagents(agentId: number): { key: string; label: string }[]
  interruptAgent(agentId: number): Promise<boolean>
  fire(agentId: number): Promise<boolean>
  launch(req: { boardId: number; cardId: number; cwd: string; brief: string }): any
  isLaunched(cardId: number): boolean
  // optional so existing test stubs stay valid; the real Conductor implements all of these
  setPermissionMode?(agentId: number, mode: string): Promise<boolean>
  resolvePermission?(agentId: number, requestId: string, behavior: 'allow' | 'deny', message?: string): boolean
  setModel?(agentId: number, model: string): Promise<boolean>
  setEffort?(agentId: number, level: string): Promise<'ok' | 'busy' | 'not-found' | 'bad-level' | 'no-session'>
}
declare module 'fastify' {
  interface FastifyInstance { db: Database.Database; bus: Bus }
}

export interface ServerOptions { token?: string }

export function buildServer(db: Database.Database, conductor?: (bus: Bus) => ConductorLike, opts: ServerOptions = {}): FastifyInstance {
  const server = Fastify()
  server.decorate('db', db)
  server.decorate('bus', new EventEmitter())
  if (opts.token) {
    const expected = opts.token
    // /health and the static UI stay open — the UI is where you enter the token
    server.addHook('onRequest', async (req, reply) => {
      if (!req.url.startsWith('/api/')) return
      const auth = req.headers.authorization
      const bearer = auth?.startsWith('Bearer ') ? auth.slice(7) : undefined
      // EventSource can't set headers, so SSE clients pass ?token= instead
      const query = (req.query ?? {}) as Record<string, string>
      if (tokenEquals(bearer ?? query.token, expected)) return
      return reply.code(401).send({ error: 'unauthorized' })
    })
  }
  const maestro = conductor?.(server.bus)
  const emit = (board_id: number, type: string, data: unknown) =>
    server.bus.emit('event', { board_id, type, data })

  server.get('/health', () => ({ ok: true, version: VERSION }))

  server.get('/api/v1/system', async () => {
    const u = await claudeUsage(db)
    return {
      hardware: hardware(),
      hired: (db.prepare(`SELECT COUNT(*) AS c FROM agents WHERE kind='hired' AND status != 'gone'`).get() as any).c,
      usage: u.usage,
      usage_error: u.usage_error,
      usage_error_since: u.usage_error_since,
      injected: injectedTotal(db),
      // real API tokens consumed by hired agents — not the injected-context estimate above
      agent_usage: usageTotal(db),
    }
  })

  server.get<{ Params: { id: string } }>('/api/v1/boards/:id/telemetry', (req) => ({
    ...boardTelemetry(db, Number(req.params.id)),
    usage: boardUsage(db, Number(req.params.id)),
  }))

  // board-wide activity feed: card events, review decisions, messages, milestones merged
  // reverse-chronologically. Cursor pages on (ts, source, id) strictly-less-than, so rows
  // inserted mid-walk (always newer) can never duplicate or shift an older page.
  server.get<{ Params: { id: string }; Querystring: { cursor?: string; limit?: string; agent?: string; card?: string; type?: string } }>(
    '/api/v1/boards/:id/timeline', (req, reply) => {
      const boardId = Number(req.params.id)
      const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50))
      let cur: { ts: string; source: string; id: number } | null = null
      if (req.query.cursor) {
        try {
          const [ts, source, id] = JSON.parse(Buffer.from(req.query.cursor, 'base64url').toString('utf8'))
          cur = { ts, source, id: Number(id) }
        } catch { return reply.code(400).send({ error: 'bad cursor' }) }
      }
      const rows = db.prepare(`
        SELECT * FROM (
          SELECT e.created_at AS ts, 'card' AS source, e.id AS id, e.type AS type, a.name AS agent,
                 e.card_id AS card_id, c.title AS card_title, e.payload AS detail, NULL AS peer
          FROM card_events e JOIN cards c ON c.id = e.card_id LEFT JOIN agents a ON a.id = e.agent_id
          WHERE c.board_id = @board
          UNION ALL
          SELECT r.decided_at, 'review', r.id, r.decision, NULL, r.card_id, c.title, r.note, NULL
          FROM review_decisions r LEFT JOIN cards c ON c.id = r.card_id
          WHERE r.board_id = @board
          UNION ALL
          SELECT m.created_at, 'message', m.id, 'message', fa.name, m.card_id, mc.title, m.body, ta.name
          FROM messages m LEFT JOIN agents fa ON fa.id = m.from_agent_id
            LEFT JOIN agents ta ON ta.id = m.to_agent_id LEFT JOIN cards mc ON mc.id = m.card_id
          WHERE m.board_id = @board
          UNION ALL
          SELECT ms.created_at, 'milestone', ms.id, 'milestone', NULL, NULL, ms.title, ms.description, NULL
          FROM milestones ms WHERE ms.board_id = @board
        )
        WHERE (@curTs IS NULL OR ts < @curTs OR (ts = @curTs AND (source < @curSrc OR (source = @curSrc AND id < @curId))))
          AND (@agent IS NULL OR agent = @agent OR peer = @agent)
          AND (@card IS NULL OR card_id = @card)
          AND (@type IS NULL OR type = @type OR source = @type)
        ORDER BY ts DESC, source DESC, id DESC
        LIMIT @lim`).all({
        board: boardId,
        curTs: cur?.ts ?? null, curSrc: cur?.source ?? null, curId: cur?.id ?? null,
        agent: req.query.agent ?? null,
        card: req.query.card ? Number(req.query.card) : null,
        type: req.query.type ?? null,
        lim: limit + 1,
      }) as any[]
      const has_more = rows.length > limit
      const page = rows.slice(0, limit)
      const items = page.map((r) => ({
        ts: r.ts, source: r.source, id: r.id, type: r.type, agent: r.agent,
        card_id: r.card_id, card_title: r.card_title, summary: timelineSummary(r),
      }))
      const last = page[page.length - 1]
      const next_cursor = has_more && last
        ? Buffer.from(JSON.stringify([last.ts, last.source, last.id])).toString('base64url') : null
      return { items, next_cursor, has_more }
    })

  // terminal sessions report their live subagents via hook pings; entries expire quickly
  const termSubs = new Map<number, Map<string, number>>()
  const liveTermSubs = (agentId: number): { key: string; label: string }[] => {
    const m = termSubs.get(agentId)
    if (!m) return []
    const now = Date.now()
    for (const [k, t] of m) if (now - t > 90_000) m.delete(k)
    return [...m.keys()].map((key) => ({ key, label: 'subagent' }))
  }

  server.post<{ Body: { project_path: string } }>('/api/v1/boards/resolve', (req) => {
    const p = req.body.project_path
    db.prepare(`INSERT OR IGNORE INTO boards (project_path, name) VALUES (?, ?)`)
      .run(p, path.basename(p))
    return db.prepare(`SELECT * FROM boards WHERE project_path = ?`).get(p)
  })

  server.get('/api/v1/boards', () => db.prepare(`SELECT * FROM boards ORDER BY id`).all())

  server.post<{ Body: { board_id: number; session_id?: string; name?: string } }>(
    '/api/v1/agents/register', (req) => {
      const { board_id, session_id } = req.body
      let name = req.body.name
      if (!name && session_id) {
        // same session re-registering (e.g. lost session file) keeps its identity
        const existing = db.prepare(`SELECT name FROM agents WHERE board_id=? AND session_id=?`).get(board_id, session_id) as any
        if (existing) name = existing.name
      }
      if (!name) {
        do { name = generateName() } while (
          db.prepare(`SELECT 1 FROM agents WHERE board_id=? AND name=?`).get(board_id, name))
      }
      db.prepare(`
        INSERT INTO agents (board_id, name, session_id) VALUES (?, ?, ?)
        ON CONFLICT(board_id, name) DO UPDATE SET
          session_id=excluded.session_id, status='active', last_seen=datetime('now')
      `).run(board_id, name, session_id ?? null)
      const agent = db.prepare(`SELECT * FROM agents WHERE board_id=? AND name=?`).get(board_id, name)
      emit(board_id, 'agent', agent)
      return agent
    })

  server.get<{ Params: { id: string } }>('/api/v1/boards/:id/snapshot', (req) => {
    const id = Number(req.params.id)
    return {
      board: db.prepare(`SELECT * FROM boards WHERE id=?`).get(id),
      agents: (db.prepare(`SELECT * FROM agents WHERE board_id=? ORDER BY name`).all(id) as any[]).map((a) => ({
        ...a,
        subagents: maestro?.isHired(a.id) ? maestro.subagents(a.id) : liveTermSubs(a.id),
      })),
      cards: listCards(db, id),
      ideas: db.prepare(`SELECT * FROM ideas WHERE board_id=? ORDER BY id`).all(id),
      milestones: db.prepare(`SELECT * FROM milestones WHERE board_id=? ORDER BY id`).all(id),
      open_questions: db.prepare(`
        SELECT m.*, fa.name AS from_name, ta.name AS to_name FROM messages m
        LEFT JOIN agents fa ON fa.id = m.from_agent_id
        LEFT JOIN agents ta ON ta.id = m.to_agent_id
        WHERE m.board_id=? AND m.reply_to IS NULL
          AND NOT EXISTS (SELECT 1 FROM messages r WHERE r.reply_to = m.id)
        ORDER BY m.id`).all(id),
      // undelivered mail to agents who already left — actionable, not just history
      dead_letters: db.prepare(`
        SELECT m.*, fa.name AS from_name, ta.name AS to_name,
          EXISTS (SELECT 1 FROM messages r WHERE r.reply_to = m.id) AS bounced
        FROM messages m
        JOIN agents ta ON ta.id = m.to_agent_id AND ta.status='gone'
        LEFT JOIN agents fa ON fa.id = m.from_agent_id
        WHERE m.board_id=? AND m.delivered_at IS NULL
        ORDER BY m.id`).all(id),
      threads: listThreads(db, id),
    }
  })

  const COLUMNS = ['backlog', 'in_progress', 'blocked', 'review', 'done']
  const agentByName = (board_id: number, name?: string) =>
    name ? (db.prepare(`SELECT * FROM agents WHERE board_id=? AND name=?`).get(board_id, name) as any) : undefined
  const getCard = (id: number) => {
    const c = db.prepare(`SELECT c.*, a.name AS owner FROM cards c LEFT JOIN agents a ON a.id=c.owner_agent_id WHERE c.id=?`).get(id) as any
    return c && { ...c, column: c.column_name, paths: JSON.parse(c.paths) }
  }
  const overlapsFor = (card: any) =>
    listCards(db, card.board_id).filter((o) =>
      o.id !== card.id && o.column !== 'done' && o.owner !== card.owner &&
      pathsIntersect(card.paths, o.paths))
  const similarFor = (card: any, overlaps: any[]) => {
    const seen = new Set(overlaps.map((o) => o.id))
    const text = `${card.title} ${card.description}`
    return listCards(db, card.board_id).filter((o) =>
      o.id !== card.id && !seen.has(o.id) && o.column !== 'done' && o.owner !== card.owner &&
      isSimilar(text, `${o.title} ${o.description}`))
  }
  // done cards from the last 30 days that look like the same work already shipped
  const DONE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000
  const doneSimilarFor = (card: any) => {
    const text = `${card.title} ${card.description}`
    return listCards(db, card.board_id).filter((o) =>
      o.id !== card.id && o.column === 'done' &&
      Date.now() - Date.parse(`${o.updated_at.replace(' ', 'T')}Z`) <= DONE_WINDOW_MS &&
      isShippedMatch(text, `${o.title} ${o.description}`))
  }
  const logEvent = (card_id: number, agent_id: number | null, type: string, payload: unknown = {}) =>
    db.prepare(`INSERT INTO card_events (card_id, agent_id, type, payload) VALUES (?, ?, ?, ?)`)
      .run(card_id, agent_id, type, JSON.stringify(payload))

  server.post<{ Body: { board_id: number; title: string; description?: string; paths?: string[]; agent?: string; column?: string } }>(
    '/api/v1/cards', (req, reply) => {
      const { board_id, title, description = '', paths = [], agent, column = 'backlog' } = req.body
      if (!COLUMNS.includes(column)) return reply.code(400).send({ error: 'invalid column' })
      const owner = agentByName(board_id, agent)
      const { lastInsertRowid } = db.prepare(`
        INSERT INTO cards (board_id, title, description, column_name, owner_agent_id, paths)
        VALUES (?, ?, ?, ?, ?, ?)`)
        .run(board_id, title, description, column, owner?.id ?? null, JSON.stringify(paths))
      const card = getCard(Number(lastInsertRowid))
      logEvent(card.id, owner?.id ?? null, 'created', { title })
      emit(board_id, 'card', card)
      const overlaps = overlapsFor(card)
      return { card, overlaps, similar: similarFor(card, overlaps), done_similar: doneSimilarFor(card) }
    })

  server.patch<{ Params: { id: string }; Body: { title?: string; description?: string; paths?: string[]; column?: string; agent?: string } }>(
    '/api/v1/cards/:id', (req, reply) => {
      const card = getCard(Number(req.params.id))
      if (!card) return reply.code(404).send({ error: 'not found' })
      const { title, description, paths, column, agent } = req.body
      if (column && !COLUMNS.includes(column)) return reply.code(400).send({ error: 'invalid column' })
      db.prepare(`
        UPDATE cards SET title=coalesce(?, title), description=coalesce(?, description),
          paths=coalesce(?, paths), column_name=coalesce(?, column_name), updated_at=datetime('now')
        WHERE id=?`)
        .run(title ?? null, description ?? null, paths ? JSON.stringify(paths) : null, column ?? null, card.id)
      const updated = getCard(card.id)
      const actor = agentByName(card.board_id, agent)
      logEvent(card.id, actor?.id ?? null, 'updated', req.body)
      emit(card.board_id, 'card', updated)
      const overlaps = overlapsFor(updated)
      return { card: updated, overlaps, similar: similarFor(updated, overlaps), done_similar: doneSimilarFor(updated) }
    })

  server.post<{ Params: { id: string }; Body: { column: string; agent?: string } }>(
    '/api/v1/cards/:id/move', async (req, reply) => {
      const card = getCard(Number(req.params.id))
      if (!card) return reply.code(404).send({ error: 'not found' })
      if (!COLUMNS.includes(req.body.column)) return reply.code(400).send({ error: 'invalid column' })
      db.prepare(`UPDATE cards SET column_name=?, updated_at=datetime('now') WHERE id=?`)
        .run(req.body.column, card.id)
      const updated = getCard(card.id)
      const actor = agentByName(card.board_id, req.body.agent)
      logEvent(card.id, actor?.id ?? null, 'moved', { to: req.body.column })
      emit(card.board_id, 'card', updated)
      if (req.body.column === 'review') await requestReview(updated, null, updated.owner)
      return { card: updated }
    })

  // earlier milestone steps aren't hard blocks — they're context the assignee must coordinate on
  const prereqSteps = (card: any): any[] => {
    if (!card.milestone_id || card.step_order == null) return []
    return db.prepare(`
      SELECT c.id, c.title, c.column_name, a.name AS owner FROM cards c
      LEFT JOIN agents a ON a.id = c.owner_agent_id
      WHERE c.milestone_id=? AND c.step_order < ? AND c.column_name != 'done'
      ORDER BY c.step_order`).all(card.milestone_id, card.step_order)
  }

  // ── review gates: a finished step parks in review; a human approves or sends it back ──
  const boardPath = (board_id: number) =>
    (db.prepare(`SELECT project_path FROM boards WHERE id=?`).get(board_id) as any)?.project_path ?? ''

  // enrich a card entering review with the agent's summary + changed paths, once per review cycle
  const requestReview = async (card: any, summary: string | null, agentName: string | null) => {
    if (hasOpenReviewRequest(db, card.id)) return
    const stat = await diffStat(boardPath(card.board_id)).catch(() => '')
    logEvent(card.id, null, 'review_request', { summary, diffstat: stat })
    emit(card.board_id, 'review', {
      card_id: card.id, card_title: card.title,
      milestone_id: card.milestone_id ?? null, step_order: card.step_order ?? null,
      agent_name: agentName, status: 'awaiting_approval', summary, diffstat: stat,
    })
  }

  // launched agents finishing a step already park the card in review (conductor exit) — enrich it here
  server.bus.on('event', (e: any) => {
    if (e?.type !== 'launch' || e?.data?.status !== 'finished' || e?.data?.to_column !== 'review') return
    const card = getCard(e.data.card_id)
    if (card) void requestReview(card, e.data.summary ?? null, e.data.agent_name ?? null)
  })

  // the gate: a milestone step can't be launched while an earlier step awaits completion or approval
  server.addHook('onRequest', async (req, reply) => {
    const m = req.method === 'POST' && /^\/api\/(?:v1\/)?cards\/(\d+)\/launch$/.exec(req.url.split('?')[0])
    if (!m) return
    const card = getCard(Number(m[1]))
    if (!card) return
    const blocking = prereqSteps(card)
    if (blocking.length) {
      return reply.code(409).send({
        error: 'step locked — earlier milestone steps need approval first',
        blocking: blocking.map((b) => ({ id: b.id, title: b.title, column: b.column_name })),
      })
    }
  })

  const reviewEvent = (card: any, status: string, extra: Record<string, unknown> = {}) =>
    emit(card.board_id, 'review', {
      card_id: card.id, card_title: card.title,
      milestone_id: card.milestone_id ?? null, step_order: card.step_order ?? null,
      agent_name: card.owner ?? null, status, ...extra,
    })

  server.post<{ Params: { id: string }; Body: { note?: string } }>(
    '/api/v1/cards/:id/approve', async (req, reply) => {
      const card = getCard(Number(req.params.id))
      if (!card) return reply.code(404).send({ error: 'not found' })
      if (card.column !== 'review') return reply.code(409).send({ error: 'card is not in review' })
      const note = req.body?.note?.trim() || null
      const decision = recordDecision(db, card, 'approve', note)
      logEvent(card.id, null, 'review_decision', { decision: 'approve', note })
      db.prepare(`UPDATE cards SET column_name='done', updated_at=datetime('now') WHERE id=?`).run(card.id)
      const updated = getCard(card.id)
      emit(card.board_id, 'card', updated)
      reviewEvent(updated, 'approved', { note })
      const unlocked = card.milestone_id != null && card.step_order != null
        ? db.prepare(`SELECT id, title, column_name FROM cards WHERE milestone_id=? AND step_order > ? ORDER BY step_order LIMIT 1`)
            .get(card.milestone_id, card.step_order) ?? null
        : null
      return { card: updated, decision, unlocked }
    })

  server.post<{ Params: { id: string }; Body: { note: string } }>(
    '/api/v1/cards/:id/send-back', async (req, reply) => {
      const card = getCard(Number(req.params.id))
      if (!card) return reply.code(404).send({ error: 'not found' })
      if (card.column !== 'review') return reply.code(409).send({ error: 'card is not in review' })
      const note = req.body?.note?.trim()
      if (!note) return reply.code(400).send({ error: 'send-back requires a note for the agent' })
      const decision = recordDecision(db, card, 'send_back', note)
      logEvent(card.id, null, 'review_decision', { decision: 'send_back', note })
      db.prepare(`UPDATE cards SET column_name='in_progress', updated_at=datetime('now') WHERE id=?`).run(card.id)
      const updated = getCard(card.id)
      emit(card.board_id, 'card', updated)
      // the reviewer's note reaches the agent through the normal message flow
      if (updated.owner_agent_id) {
        const body = `Review feedback on card #${card.id} "${card.title}": ${note} — the card is back in in_progress; address the feedback and move it to review again when ready.`
        const { lastInsertRowid } = db.prepare(`
          INSERT INTO messages (board_id, to_agent_id, card_id, body) VALUES (?, ?, ?, ?)`)
          .run(card.board_id, updated.owner_agent_id, card.id, body)
        let msg = db.prepare(`SELECT * FROM messages WHERE id=?`).get(Number(lastInsertRowid)) as any
        if (maestro?.isHired(updated.owner_agent_id) && maestro.deliver(updated.owner_agent_id, { ...msg, from_name: null })) {
          db.prepare(`INSERT OR IGNORE INTO deliveries (message_id, agent_id) VALUES (?, ?)`).run(msg.id, updated.owner_agent_id)
          db.prepare(`UPDATE messages SET delivered_at=coalesce(delivered_at, datetime('now')) WHERE id=?`).run(msg.id)
          msg = db.prepare(`SELECT * FROM messages WHERE id=?`).get(msg.id)
        }
        emit(card.board_id, 'message', msg)
      }
      reviewEvent(updated, 'sent_back', { note })
      return { card: updated, decision }
    })

  server.get<{ Params: { id: string } }>('/api/v1/cards/:id/reviews', (req) =>
    listCardDecisions(db, Number(req.params.id)))

  server.get<{ Params: { id: string } }>('/api/v1/boards/:id/reviews', (req) =>
    listBoardDecisions(db, Number(req.params.id)))

  server.post<{ Body: { board_id: number; title: string; description?: string } }>('/api/v1/milestones', (req) => {
    const { board_id, title, description = '' } = req.body
    const { lastInsertRowid } = db.prepare(`INSERT INTO milestones (board_id, title, description) VALUES (?, ?, ?)`)
      .run(board_id, title, description)
    const m = db.prepare(`SELECT * FROM milestones WHERE id=?`).get(Number(lastInsertRowid))
    emit(board_id, 'milestone', m)
    return m
  })

  server.delete<{ Params: { id: string } }>('/api/v1/milestones/:id', (req, reply) => {
    const m = db.prepare(`SELECT * FROM milestones WHERE id=?`).get(Number(req.params.id)) as any
    if (!m) return reply.code(404).send({ error: 'not found' })
    db.prepare(`UPDATE cards SET milestone_id=NULL, step_order=NULL WHERE milestone_id=?`).run(m.id)
    db.prepare(`DELETE FROM milestones WHERE id=?`).run(m.id)
    emit(m.board_id, 'milestone', { deleted: m.id })
    return { ok: true }
  })

  server.post<{ Params: { id: string }; Body: { title: string; description?: string } }>(
    '/api/v1/milestones/:id/steps', (req, reply) => {
      const m = db.prepare(`SELECT * FROM milestones WHERE id=?`).get(Number(req.params.id)) as any
      if (!m) return reply.code(404).send({ error: 'not found' })
      const next = (db.prepare(`SELECT COALESCE(MAX(step_order), 0) AS mx FROM cards WHERE milestone_id=?`).get(m.id) as any).mx + 1
      const { lastInsertRowid } = db.prepare(`
        INSERT INTO cards (board_id, title, description, column_name, milestone_id, step_order)
        VALUES (?, ?, ?, 'backlog', ?, ?)`)
        .run(m.board_id, req.body.title, req.body.description ?? '', m.id, next)
      const card = getCard(Number(lastInsertRowid))
      logEvent(card.id, null, 'created', { milestone: m.title, step: next })
      emit(m.board_id, 'card', card)
      return { card }
    })

  // ── roadmap: ideas → tickets → assignment ─────────────────────────────
  const prereqNote = (card: any) => {
    const prereqs = prereqSteps(card)
    return prereqs.length
      ? ` Heads-up: earlier steps of this milestone are still open: ${prereqs.map((p) =>
          `#${p.id} "${p.title}" (${p.owner ?? 'unassigned'}, ${p.column_name})`).join('; ')}. ` +
        `They are prerequisites in spirit, not blockers — contact their owners first (orchestra ask <owner> "...") to agree boundaries and interfaces, then work in parallel where safe.`
      : ''
  }
  const assignmentBrief = (card: any) =>
    `You've been assigned card #${card.id}: "${card.title}".` +
    (card.description ? ` Scope: ${card.description}.` : '') + prereqNote(card) +
    ` Start now; keep the card updated (orchestra card update ${card.id} / orchestra card move ${card.id} <column>) and move it to done when finished.`

  // launched agents never self-report done — the daemon parks the card in review for a human
  const launchBrief = (card: any) =>
    `You've been launched on card #${card.id}: "${card.title}".` +
    (card.description ? ` Scope: ${card.description}.` : '') + prereqNote(card) +
    ` This card is already registered to you and in in_progress — do NOT create another card for this work.` +
    ` Work the ticket autonomously to completion; do not wait for human input.` +
    ` When you finish, do NOT move the card to done or review yourself — end your final message with a short summary of what you changed and how you verified it; the daemon parks the card in review for human approval.` +
    ` If you cannot complete the ticket, state exactly what blocked you and stop.`

  const notifyAssignment = (card: any, agentRow: any) => {
    db.prepare(`UPDATE cards SET owner_agent_id=?, column_name='in_progress', updated_at=datetime('now') WHERE id=?`)
      .run(agentRow.id, card.id)
    const updated = getCard(card.id)
    logEvent(card.id, agentRow.id, 'updated', { assigned_to: agentRow.name })
    emit(card.board_id, 'card', updated)
    const brief = assignmentBrief(updated)
    // every assignment is a board message — the you→agent arrow shows for all agent kinds
    const { lastInsertRowid } = db.prepare(`
      INSERT INTO messages (board_id, to_agent_id, card_id, body) VALUES (?, ?, ?, ?)`)
      .run(card.board_id, agentRow.id, card.id, brief)
    let msg = db.prepare(`SELECT * FROM messages WHERE id=?`).get(Number(lastInsertRowid)) as any
    if (maestro?.isHired(agentRow.id) && maestro.deliver(agentRow.id, { ...msg, from_name: null })) {
      db.prepare(`INSERT OR IGNORE INTO deliveries (message_id, agent_id) VALUES (?, ?)`).run(msg.id, agentRow.id)
      db.prepare(`UPDATE messages SET delivered_at=coalesce(delivered_at, datetime('now')) WHERE id=?`).run(msg.id)
      msg = db.prepare(`SELECT * FROM messages WHERE id=?`).get(msg.id)
    }
    emit(card.board_id, 'message', msg)
    return updated
  }

  server.post<{ Body: { board_id: number; text: string } }>('/api/v1/ideas', (req) => {
    const { board_id, text } = req.body
    const { lastInsertRowid } = db.prepare(`INSERT INTO ideas (board_id, text) VALUES (?, ?)`).run(board_id, text)
    const idea = db.prepare(`SELECT * FROM ideas WHERE id=?`).get(Number(lastInsertRowid))
    emit(board_id, 'idea', idea)
    return idea
  })

  server.delete<{ Params: { id: string } }>('/api/v1/ideas/:id', (req, reply) => {
    const idea = db.prepare(`SELECT * FROM ideas WHERE id=?`).get(Number(req.params.id)) as any
    if (!idea) return reply.code(404).send({ error: 'not found' })
    db.prepare(`DELETE FROM ideas WHERE id=?`).run(idea.id)
    emit(idea.board_id, 'idea', { deleted: idea.id })
    return { ok: true }
  })

  // idea becomes a ticket; optionally assigned (and briefed) in the same step
  server.post<{ Params: { id: string }; Body: { agent?: string } }>('/api/v1/ideas/:id/promote', (req, reply) => {
    const idea = db.prepare(`SELECT * FROM ideas WHERE id=?`).get(Number(req.params.id)) as any
    if (!idea) return reply.code(404).send({ error: 'not found' })
    const [title, ...rest] = idea.text.split('\n')
    const { lastInsertRowid } = db.prepare(`
      INSERT INTO cards (board_id, title, description, column_name) VALUES (?, ?, ?, 'backlog')`)
      .run(idea.board_id, title.slice(0, 200), rest.join('\n').trim())
    let card = getCard(Number(lastInsertRowid))
    logEvent(card.id, null, 'created', { from_idea: idea.id })
    db.prepare(`DELETE FROM ideas WHERE id=?`).run(idea.id)
    emit(idea.board_id, 'idea', { deleted: idea.id })
    emit(idea.board_id, 'card', card)
    const agentRow = agentByName(idea.board_id, req.body?.agent)
    if (req.body?.agent && !agentRow) return reply.code(400).send({ error: `no agent named "${req.body.agent}"` })
    if (agentRow?.name === 'strategist' || agentRow?.name.startsWith('auditor-')) return reply.code(400).send({ error: 'planner agents write tickets — they do not take them' })
    if (agentRow) card = notifyAssignment(card, agentRow)
    return { card, done_similar: doneSimilarFor(card) }
  })

  server.post<{ Params: { id: string }; Body: { agent: string } }>('/api/v1/cards/:id/assign', (req, reply) => {
    const card = getCard(Number(req.params.id))
    if (!card) return reply.code(404).send({ error: 'not found' })
    const agentRow = agentByName(card.board_id, req.body.agent)
    if (!agentRow) return reply.code(400).send({ error: `no agent named "${req.body.agent}"` })
    if (agentRow.name === 'strategist' || agentRow.name.startsWith('auditor-')) return reply.code(400).send({ error: 'planner agents write tickets — they do not take them' })
    return { card: notifyAssignment(card, agentRow) }
  })

  // launch a fresh autonomous agent directly on a ticket; queued past the concurrency cap
  server.post<{ Params: { id: string } }>('/api/v1/cards/:id/launch', (req, reply) => {
    if (!maestro) return reply.code(501).send({ error: 'conductor not available (daemon-only feature)' })
    const card = getCard(Number(req.params.id))
    if (!card) return reply.code(404).send({ error: 'not found' })
    if (card.column === 'done') return reply.code(400).send({ error: 'card is already done' })
    if (maestro.isLaunched(card.id)) return reply.code(409).send({ error: 'card already launched or queued' })
    if (card.owner_agent_id && maestro.isHired(card.owner_agent_id))
      return reply.code(409).send({ error: `already being worked by ${card.owner}` })
    const board = db.prepare(`SELECT * FROM boards WHERE id=?`).get(card.board_id) as any
    return maestro.launch({ boardId: card.board_id, cardId: card.id, cwd: board.project_path, brief: launchBrief(card) })
  })

  // bring a completed card back to the backlog, unowned, ready to reassign
  server.post<{ Params: { id: string } }>('/api/v1/cards/:id/restore', (req, reply) => {
    const card = getCard(Number(req.params.id))
    if (!card) return reply.code(404).send({ error: 'not found' })
    db.prepare(`UPDATE cards SET column_name='backlog', owner_agent_id=NULL, updated_at=datetime('now') WHERE id=?`).run(card.id)
    const updated = getCard(card.id)
    logEvent(card.id, null, 'restored', { from: card.column })
    emit(card.board_id, 'card', updated)
    return { card: updated }
  })

  server.get<{ Params: { id: string } }>('/api/v1/cards/:id/events', (req) =>
    db.prepare(`SELECT e.*, a.name AS agent FROM card_events e LEFT JOIN agents a ON a.id=e.agent_id WHERE card_id=? ORDER BY e.id`)
      .all(Number(req.params.id)))

  // ground-truth merge record from the integrator; thin wrapper over recordShipped (#54)
  server.post<{ Params: { id: string }; Body: { hash: string; by?: string } }>(
    '/api/v1/cards/:id/shipped', async (req, reply) => {
      const card = getCard(Number(req.params.id))
      if (!card) return reply.code(404).send({ error: 'not found' })
      if (!req.body?.hash) return reply.code(400).send({ error: 'hash required' })
      const board = db.prepare(`SELECT * FROM boards WHERE id=?`).get(card.board_id) as any
      const by = req.body.by ?? null
      const r = await recordShipped(db, server.bus, card, board.project_path,
        { hash: req.body.hash, by, agentId: agentByName(card.board_id, by ?? undefined)?.id ?? null })
      if ('error' in r) return reply.code(400).send({ error: r.error })
      return r
    })

  server.post<{ Body: { board_id: number; from?: string; to?: string; card_id?: number; body: string; reply_to?: number } }>(
    '/api/v1/messages', (req, reply) => {
      const { board_id, from, to, card_id, body, reply_to } = req.body
      const fromA = agentByName(board_id, from), toA = agentByName(board_id, to)
      // a typo'd recipient must fail loudly, not silently become a broadcast
      if (to && !toA) return reply.code(400).send({ error: `no agent named "${to}" on this board` })
      // a gone recipient would leave the message undelivered forever — refuse up front
      if (toA && toA.status === 'gone')
        return reply.code(409).send({ error: `agent "${to}" is gone — the message would never be delivered; ask a live agent or post to the board (no --to)` })
      // a reply without an explicit recipient targets the original sender, not the whole board
      let toId = toA?.id ?? null
      if (toId === null && reply_to) {
        const orig = db.prepare(`SELECT from_agent_id FROM messages WHERE id=?`).get(reply_to) as any
        toId = orig?.from_agent_id ?? null
      }
      const { lastInsertRowid } = db.prepare(`
        INSERT INTO messages (board_id, from_agent_id, to_agent_id, card_id, body, reply_to)
        VALUES (?, ?, ?, ?, ?, ?)`)
        .run(board_id, fromA?.id ?? null, toId, card_id ?? null, body, reply_to ?? null)
      let msg = db.prepare(`SELECT * FROM messages WHERE id=?`).get(Number(lastInsertRowid)) as any
      // hired agents get instant delivery — no waiting for a hook to fire
      const targets = new Set<number>()
      if (toA && maestro?.isHired(toA.id)) targets.add(toA.id)
      if (reply_to) {
        const orig = db.prepare(`SELECT from_agent_id FROM messages WHERE id=?`).get(reply_to) as any
        if (orig?.from_agent_id && maestro?.isHired(orig.from_agent_id)) targets.add(orig.from_agent_id)
      }
      if (!toA && !reply_to) {
        // broadcast: every hired agent on the board except the sender hears it now
        for (const a of db.prepare(`SELECT id FROM agents WHERE board_id=? AND kind='hired' AND status != 'gone'`).all(board_id) as any[]) {
          if (a.id !== fromA?.id && maestro?.isHired(a.id)) targets.add(a.id)
        }
      }
      const markDelivered = db.prepare(`INSERT OR IGNORE INTO deliveries (message_id, agent_id) VALUES (?, ?)`)
      for (const id of targets) {
        if (maestro!.deliver(id, { ...msg, from_name: fromA?.name ?? null })) {
          markDelivered.run(msg.id, id)
          db.prepare(`UPDATE messages SET delivered_at=coalesce(delivered_at, datetime('now')) WHERE id=?`).run(msg.id)
        }
      }
      if (targets.size) msg = db.prepare(`SELECT * FROM messages WHERE id=?`).get(msg.id)
      emit(board_id, 'message', msg)
      return msg
    })

  server.post<{ Params: { id: string }; Body: { name?: string; cwd?: string; model?: string; role?: 'strategist' | 'auditor'; ephemeral?: boolean; resumeSession?: string; permissionMode?: string } }>(
    '/api/v1/boards/:id/hire', (req, reply) => {
      if (!maestro) return reply.code(501).send({ error: 'conductor not available (daemon-only feature)' })
      const board = db.prepare(`SELECT * FROM boards WHERE id=?`).get(Number(req.params.id)) as any
      if (!board) return reply.code(404).send({ error: 'not found' })
      const agent = maestro.hire({
        boardId: board.id,
        cwd: req.body?.cwd ?? board.project_path,
        name: req.body?.name,
        model: req.body?.model,
        role: req.body?.role,
        ephemeral: req.body?.ephemeral,
        // /resume revives a stopped agent with its memory and permission mode intact (#44)
        resumeSession: req.body?.resumeSession,
        permissionMode: req.body?.permissionMode,
      })
      emit(board.id, 'agent', agent)
      return agent
    })

  server.post<{ Params: { id: string }; Body: { text: string } }>(
    '/api/v1/agents/:id/task', (req, reply) => {
      if (!maestro) return reply.code(501).send({ error: 'conductor not available' })
      const ok = maestro.task(Number(req.params.id), req.body.text)
      return ok ? { ok: true } : reply.code(404).send({ error: 'not a hired agent' })
    })

  server.post<{ Params: { id: string } }>('/api/v1/agents/:id/interrupt', async (req, reply) => {
    if (!maestro) return reply.code(501).send({ error: 'conductor not available' })
    const ok = await maestro.interruptAgent(Number(req.params.id))
    return ok ? { ok: true } : reply.code(404).send({ error: 'not a hired agent' })
  })

  server.post<{ Params: { id: string } }>('/api/v1/agents/:id/fire', async (req, reply) => {
    if (!maestro) return reply.code(501).send({ error: 'conductor not available' })
    const ok = await maestro.fire(Number(req.params.id))
    return ok ? { ok: true } : reply.code(404).send({ error: 'not a hired agent' })
  })

  // live-switch a hired agent's permission mode (persisted for daemon-restart resume)
  const PERMISSION_MODES = ['bypassPermissions', 'acceptEdits', 'plan']
  server.post<{ Params: { id: string }; Body: { mode?: string } | null }>(
    '/api/v1/agents/:id/permission-mode', async (req, reply) => {
      if (!maestro) return reply.code(501).send({ error: 'conductor not available' })
      const mode = req.body?.mode ?? ''
      if (!PERMISSION_MODES.includes(mode)) return reply.code(400).send({ error: `mode must be one of: ${PERMISSION_MODES.join(', ')}` })
      const ok = (await maestro.setPermissionMode?.(Number(req.params.id), mode)) ?? false
      return ok ? { ok: true, mode } : reply.code(404).send({ error: 'not a hired agent' })
    })

  // answer a pending canUseTool ask surfaced in the terminal
  server.post<{ Params: { id: string; requestId: string }; Body: { behavior?: string; message?: string } | null }>(
    '/api/v1/agents/:id/permissions/:requestId', (req, reply) => {
      if (!maestro) return reply.code(501).send({ error: 'conductor not available' })
      const behavior = req.body?.behavior
      if (behavior !== 'allow' && behavior !== 'deny') return reply.code(400).send({ error: `behavior must be 'allow' or 'deny'` })
      const ok = maestro.resolvePermission?.(Number(req.params.id), req.params.requestId, behavior, req.body?.message) ?? false
      return ok ? { ok: true } : reply.code(404).send({ error: 'no pending permission request with that id' })
    })

  // live-switch a hired agent's model — applies from the next turn (persisted for restart resume)
  server.post<{ Params: { id: string }; Body: { model?: string } | null }>(
    '/api/v1/agents/:id/model', async (req, reply) => {
      if (!maestro) return reply.code(501).send({ error: 'conductor not available' })
      const model = req.body?.model
      if (!model || typeof model !== 'string') return reply.code(400).send({ error: 'model is required' })
      const ok = (await maestro.setModel?.(Number(req.params.id), model)) ?? false
      return ok ? { ok: true, model } : reply.code(404).send({ error: 'not a hired agent' })
    })

  // change reasoning effort — a spawn param, so the daemon restarts the session with resume;
  // 409 while a turn is running, mirroring the launch gate
  const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max']
  server.post<{ Params: { id: string }; Body: { level?: string } | null }>(
    '/api/v1/agents/:id/effort', async (req, reply) => {
      if (!maestro) return reply.code(501).send({ error: 'conductor not available' })
      const level = req.body?.level ?? ''
      if (!EFFORT_LEVELS.includes(level)) return reply.code(400).send({ error: `level must be one of: ${EFFORT_LEVELS.join(', ')}` })
      const r = (await maestro.setEffort?.(Number(req.params.id), level)) ?? 'not-found'
      if (r === 'ok') return { ok: true, level }
      if (r === 'busy') return reply.code(409).send({ error: 'agent is mid-turn — wait or interrupt, then retry' })
      if (r === 'no-session') return reply.code(409).send({ error: 'agent has no resumable session yet — send a first prompt before changing effort' })
      if (r === 'bad-level') return reply.code(400).send({ error: `level must be one of: ${EFFORT_LEVELS.join(', ')}` })
      return reply.code(404).send({ error: 'not a hired agent' })
    })

  server.get<{ Params: { id: string } }>('/api/v1/agents/:id/transcript', (req, reply) => {
    if (!maestro) return reply.code(501).send({ error: 'conductor not available' })
    return maestro.transcript(Number(req.params.id))
  })

  const inboxSql = `
    SELECT m.*, fa.name AS from_name FROM messages m
    LEFT JOIN agents fa ON fa.id = m.from_agent_id
    WHERE m.board_id = ? AND (m.from_agent_id IS NULL OR m.from_agent_id != ?)
      AND (m.to_agent_id = ?
           OR m.reply_to IN (SELECT id FROM messages WHERE from_agent_id = ?)
           OR (m.to_agent_id IS NULL AND m.reply_to IS NULL))`

  server.get<{ Params: { id: string } }>('/api/v1/agents/:id/inbox', (req) => {
    const a = db.prepare(`SELECT * FROM agents WHERE id=?`).get(Number(req.params.id)) as any
    return db.prepare(inboxSql + ' ORDER BY m.id').all(a.board_id, a.id, a.id, a.id)
  })

  server.delete<{ Params: { id: string } }>('/api/v1/messages/:id', (req, reply) => {
    const id = Number(req.params.id)
    const msg = db.prepare(`SELECT * FROM messages WHERE id=?`).get(id) as any
    if (!msg) return reply.code(404).send({ error: 'not found' })
    db.prepare(`DELETE FROM messages WHERE reply_to=?`).run(id)
    db.prepare(`DELETE FROM messages WHERE id=?`).run(id)
    emit(msg.board_id, 'message', { deleted: id })
    return { ok: true }
  })

  server.delete<{ Params: { id: string } }>('/api/v1/cards/:id', (req, reply) => {
    const card = db.prepare(`SELECT * FROM cards WHERE id=?`).get(Number(req.params.id)) as any
    if (!card) return reply.code(404).send({ error: 'not found' })
    db.prepare(`DELETE FROM card_events WHERE card_id=?`).run(card.id)
    db.prepare(`UPDATE messages SET card_id=NULL WHERE card_id=?`).run(card.id)
    db.prepare(`DELETE FROM cards WHERE id=?`).run(card.id)
    emit(card.board_id, 'card', { deleted: card.id })
    return { ok: true }
  })

  server.delete<{ Params: { id: string } }>('/api/v1/agents/:id', (req, reply) => {
    const a = db.prepare(`SELECT * FROM agents WHERE id=?`).get(Number(req.params.id)) as any
    if (!a) return reply.code(404).send({ error: 'not found' })
    db.prepare(`UPDATE cards SET owner_agent_id=NULL WHERE owner_agent_id=?`).run(a.id)
    db.prepare(`DELETE FROM agents WHERE id=?`).run(a.id)
    emit(a.board_id, 'agent', { deleted: a.id })
    return { ok: true }
  })

  server.delete<{ Params: { id: string } }>('/api/v1/boards/:id', (req, reply) => {
    const id = Number(req.params.id)
    if (!db.prepare(`SELECT 1 FROM boards WHERE id=?`).get(id)) return reply.code(404).send({ error: 'not found' })
    db.prepare(`DELETE FROM messages WHERE board_id=?`).run(id)
    db.prepare(`DELETE FROM card_events WHERE card_id IN (SELECT id FROM cards WHERE board_id=?)`).run(id)
    db.prepare(`DELETE FROM cards WHERE board_id=?`).run(id)
    db.prepare(`DELETE FROM agents WHERE board_id=?`).run(id)
    db.prepare(`DELETE FROM boards WHERE id=?`).run(id)
    emit(id, 'board', { deleted: id })
    return { ok: true }
  })

  server.post<{ Params: { id: string }; Body: { key?: string } }>('/api/v1/agents/:id/subping', (req) => {
    const id = Number(req.params.id)
    if (!termSubs.has(id)) termSubs.set(id, new Map())
    termSubs.get(id)!.set(String(req.body?.key ?? 'sub'), Date.now())
    const a = db.prepare(`SELECT * FROM agents WHERE id=?`).get(id) as any
    if (a) emit(a.board_id, 'agent', { id, subs: true })
    return { ok: true }
  })

  server.post<{ Params: { id: string }; Body: { telemetry?: TelemetryEntry[] } | null }>('/api/v1/agents/:id/heartbeat', (req) => {
    const id = Number(req.params.id)
    db.prepare(`UPDATE agents SET status='active', last_seen=datetime('now') WHERE id=?`).run(id)
    const a = db.prepare(`SELECT * FROM agents WHERE id=?`).get(id) as any
    if (a && req.body?.telemetry) recordTelemetry(db, a.board_id, a.id, req.body.telemetry)
    if (a) emit(a.board_id, 'agent', a)
    return a ?? {}
  })

  server.post<{ Params: { id: string }; Body: { telemetry?: TelemetryEntry[] } | null }>('/api/v1/agents/:id/pulse', (req) => {
    const a = db.prepare(`SELECT * FROM agents WHERE id=?`).get(Number(req.params.id)) as any
    db.prepare(`UPDATE agents SET status='active', last_seen=datetime('now') WHERE id=?`).run(a.id)
    if (req.body?.telemetry) recordTelemetry(db, a.board_id, a.id, req.body.telemetry)
    // per-recipient delivery: one agent consuming a broadcast must not hide it from the others
    const messages = db.prepare(inboxSql +
      ` AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.message_id = m.id AND d.agent_id = ?) ORDER BY m.id`)
      .all(a.board_id, a.id, a.id, a.id, a.id) as any[]
    const mark = db.prepare(`INSERT OR IGNORE INTO deliveries (message_id, agent_id) VALUES (?, ?)`)
    const stamp = db.prepare(`UPDATE messages SET delivered_at=coalesce(delivered_at, datetime('now')) WHERE id=?`)
    db.transaction(() => messages.forEach((m) => { mark.run(m.id, a.id); stamp.run(m.id) }))()
    emit(a.board_id, 'agent', db.prepare(`SELECT * FROM agents WHERE id=?`).get(a.id))
    return { agent: a, messages }
  })

  server.post<{ Params: { id: string }; Body: { telemetry?: TelemetryEntry[] } | null }>('/api/v1/agents/:id/leave', (req) => {
    const id = Number(req.params.id)
    const boardOf = db.prepare(`SELECT board_id FROM agents WHERE id=?`).get(id) as any
    if (boardOf && req.body?.telemetry) recordTelemetry(db, boardOf.board_id, id, req.body.telemetry)
    removeAgentCards(db, id) // gone agents leave a clean board
    db.prepare(`UPDATE agents SET status='gone' WHERE id=?`).run(id)
    const a = db.prepare(`SELECT * FROM agents WHERE id=?`).get(id) as any
    for (const bounce of bounceDeadLetters(db, id) as any[]) {
      // hired senders hear the bounce immediately; session senders get it on next pulse
      const sender = bounce.to_agent_id
      if (sender && maestro?.isHired(sender) && maestro.deliver(sender, { ...bounce, from_name: null })) {
        db.prepare(`INSERT OR IGNORE INTO deliveries (message_id, agent_id) VALUES (?, ?)`).run(bounce.id, sender)
        db.prepare(`UPDATE messages SET delivered_at=coalesce(delivered_at, datetime('now')) WHERE id=?`).run(bounce.id)
      }
      emit(a.board_id, 'message', bounce)
    }
    emit(a.board_id, 'agent', a)
    emit(a.board_id, 'card', { pruned: id })
    return a
  })

  // one global stream — browsers cap per-host connections, so per-board streams starve the app
  server.get('/api/v1/events', (req, reply) => {
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache', connection: 'keep-alive',
    })
    const onEvent = (e: unknown) => reply.raw.write(`data: ${JSON.stringify(e)}\n\n`)
    server.bus.on('event', onEvent)
    const ping = setInterval(() => reply.raw.write(': ping\n\n'), 25_000)
    req.raw.on('close', () => { server.bus.off('event', onEvent); clearInterval(ping) })
  })

  server.get<{ Params: { id: string } }>('/api/v1/boards/:id/events', (req, reply) => {
    const boardId = Number(req.params.id)
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache', connection: 'keep-alive',
    })
    const onEvent = (e: { board_id: number; type: string; data: unknown }) => {
      if (e.board_id === boardId) reply.raw.write(`data: ${JSON.stringify(e)}\n\n`)
    }
    server.bus.on('event', onEvent)
    const ping = setInterval(() => reply.raw.write(': ping\n\n'), 25_000)
    req.raw.on('close', () => { server.bus.off('event', onEvent); clearInterval(ping) })
  })

  // static web UI (built by Task 13; 404s harmlessly before that)
  const webDist = fileURLToPath(new URL('../web/dist', import.meta.url))
  if (fs.existsSync(webDist)) {
    server.register(import('@fastify/static'), { root: webDist })
  }

  return server
}

// one human-readable line per feed item; payloads are stored as JSON strings
function timelineSummary(r: { source: string; type: string; agent: string | null; card_title: string | null; detail: string | null; peer: string | null }): string {
  const clip = (s: string, n = 140) => (s.length > n ? s.slice(0, n - 1) + '…' : s)
  if (r.source === 'message') return clip(`${r.agent ?? 'human'} → ${r.peer ?? 'all'}: ${r.detail ?? ''}`)
  if (r.source === 'review') return clip(`${r.type === 'approve' ? 'approved' : 'sent back'} "${r.card_title ?? '?'}"${r.detail ? ` — ${r.detail}` : ''}`)
  if (r.source === 'milestone') return clip(`milestone "${r.card_title ?? ''}"${r.detail ? ` — ${r.detail}` : ''}`)
  let p: any = {}
  try { p = JSON.parse(r.detail ?? '{}') } catch { /* raw payload stays out of the summary */ }
  const title = r.card_title ? `"${r.card_title}"` : ''
  if (r.type === 'created') return clip(`created ${title}`)
  if (r.type === 'moved') return clip(`moved ${title}${p.from ? ` ${p.from}` : ''}${p.to ? ` → ${p.to}` : ''}`)
  if (r.type === 'shipped') return clip(`shipped ${title}${p.hash ? ` @ ${String(p.hash).slice(0, 7)}` : ''}${p.subject ? ` — ${p.subject}` : ''}`)
  return clip(`${r.type} ${title}`)
}

export function listThreads(db: Database.Database, boardId: number) {
  const msgs = db.prepare(`
    SELECT m.*, fa.name AS from_name, ta.name AS to_name FROM messages m
    LEFT JOIN agents fa ON fa.id = m.from_agent_id
    LEFT JOIN agents ta ON ta.id = m.to_agent_id
    WHERE m.board_id=? ORDER BY m.id`).all(boardId) as any[]
  return msgs
    .filter((m) => !m.reply_to)
    .map((root) => {
      const replies = msgs.filter((r) => r.reply_to === root.id)
      return { ...root, replies, answered: replies.length > 0 }
    })
    .reverse() // newest thread first
}

export function listCards(db: Database.Database, boardId: number) {
  return (db.prepare(`
    SELECT c.*, a.name AS owner FROM cards c
    LEFT JOIN agents a ON a.id = c.owner_agent_id
    WHERE c.board_id=? ORDER BY c.updated_at DESC`).all(boardId) as any[])
    .map((c) => ({ ...c, column: c.column_name, paths: JSON.parse(c.paths) }))
}
