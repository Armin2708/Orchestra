import Fastify, { FastifyInstance } from 'fastify'
import type Database from 'better-sqlite3'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import { generateName } from './names.js'
import { pathsIntersect } from './overlap.js'
import { VERSION } from './version.js'

export type Bus = EventEmitter
declare module 'fastify' {
  interface FastifyInstance { db: Database.Database; bus: Bus }
}

export function buildServer(db: Database.Database): FastifyInstance {
  const server = Fastify()
  server.decorate('db', db)
  server.decorate('bus', new EventEmitter())
  const emit = (board_id: number, type: string, data: unknown) =>
    server.bus.emit('event', { board_id, type, data })

  server.get('/health', () => ({ ok: true, version: VERSION }))

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
      agents: db.prepare(`SELECT * FROM agents WHERE board_id=? ORDER BY name`).all(id),
      cards: listCards(db, id),
      open_questions: db.prepare(`
        SELECT m.*, fa.name AS from_name, ta.name AS to_name FROM messages m
        LEFT JOIN agents fa ON fa.id = m.from_agent_id
        LEFT JOIN agents ta ON ta.id = m.to_agent_id
        WHERE m.board_id=? AND m.reply_to IS NULL
          AND NOT EXISTS (SELECT 1 FROM messages r WHERE r.reply_to = m.id)
        ORDER BY m.id`).all(id),
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
      return { card, overlaps: overlapsFor(card) }
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
      return { card: updated, overlaps: overlapsFor(updated) }
    })

  server.post<{ Params: { id: string }; Body: { column: string; agent?: string } }>(
    '/api/v1/cards/:id/move', (req, reply) => {
      const card = getCard(Number(req.params.id))
      if (!card) return reply.code(404).send({ error: 'not found' })
      if (!COLUMNS.includes(req.body.column)) return reply.code(400).send({ error: 'invalid column' })
      db.prepare(`UPDATE cards SET column_name=?, updated_at=datetime('now') WHERE id=?`)
        .run(req.body.column, card.id)
      const updated = getCard(card.id)
      const actor = agentByName(card.board_id, req.body.agent)
      logEvent(card.id, actor?.id ?? null, 'moved', { to: req.body.column })
      emit(card.board_id, 'card', updated)
      return { card: updated }
    })

  server.get<{ Params: { id: string } }>('/api/v1/cards/:id/events', (req) =>
    db.prepare(`SELECT e.*, a.name AS agent FROM card_events e LEFT JOIN agents a ON a.id=e.agent_id WHERE card_id=? ORDER BY e.id`)
      .all(Number(req.params.id)))

  server.post<{ Body: { board_id: number; from?: string; to?: string; card_id?: number; body: string; reply_to?: number } }>(
    '/api/v1/messages', (req) => {
      const { board_id, from, to, card_id, body, reply_to } = req.body
      const fromA = agentByName(board_id, from), toA = agentByName(board_id, to)
      const { lastInsertRowid } = db.prepare(`
        INSERT INTO messages (board_id, from_agent_id, to_agent_id, card_id, body, reply_to)
        VALUES (?, ?, ?, ?, ?, ?)`)
        .run(board_id, fromA?.id ?? null, toA?.id ?? null, card_id ?? null, body, reply_to ?? null)
      const msg = db.prepare(`SELECT * FROM messages WHERE id=?`).get(Number(lastInsertRowid))
      emit(board_id, 'message', msg)
      return msg
    })

  const inboxSql = `
    SELECT m.*, fa.name AS from_name FROM messages m
    LEFT JOIN agents fa ON fa.id = m.from_agent_id
    WHERE m.board_id = ? AND (m.from_agent_id IS NULL OR m.from_agent_id != ?)
      AND (m.to_agent_id = ?
           OR m.reply_to IN (SELECT id FROM messages WHERE from_agent_id = ?)
           OR m.to_agent_id IS NULL)`

  server.get<{ Params: { id: string } }>('/api/v1/agents/:id/inbox', (req) => {
    const a = db.prepare(`SELECT * FROM agents WHERE id=?`).get(Number(req.params.id)) as any
    return db.prepare(inboxSql + ' ORDER BY m.id').all(a.board_id, a.id, a.id, a.id)
  })

  server.post<{ Params: { id: string } }>('/api/v1/agents/:id/pulse', (req) => {
    const a = db.prepare(`SELECT * FROM agents WHERE id=?`).get(Number(req.params.id)) as any
    db.prepare(`UPDATE agents SET status='active', last_seen=datetime('now') WHERE id=?`).run(a.id)
    const messages = db.prepare(inboxSql + ` AND m.delivered_at IS NULL ORDER BY m.id`)
      .all(a.board_id, a.id, a.id, a.id) as any[]
    const mark = db.prepare(`UPDATE messages SET delivered_at=datetime('now') WHERE id=?`)
    db.transaction(() => messages.forEach((m) => mark.run(m.id)))()
    emit(a.board_id, 'agent', db.prepare(`SELECT * FROM agents WHERE id=?`).get(a.id))
    return { agent: a, messages }
  })

  return server
}

export function listCards(db: Database.Database, boardId: number) {
  return (db.prepare(`
    SELECT c.*, a.name AS owner FROM cards c
    LEFT JOIN agents a ON a.id = c.owner_agent_id
    WHERE c.board_id=? ORDER BY c.updated_at DESC`).all(boardId) as any[])
    .map((c) => ({ ...c, column: c.column_name, paths: JSON.parse(c.paths) }))
}
