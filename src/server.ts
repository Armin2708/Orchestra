import Fastify, { FastifyInstance } from 'fastify'
import type Database from 'better-sqlite3'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateName } from './names.js'
import { pathsIntersect } from './overlap.js'
import { isSimilar } from './similar.js'
import { removeAgentCards } from './reaper.js'
import { VERSION } from './version.js'

export type Bus = EventEmitter
// minimal surface the server needs from the conductor (injected by the daemon)
export interface ConductorLike {
  isHired(agentId: number): boolean
  hire(opts: { boardId: number; cwd: string; name?: string; model?: string }): any
  deliver(agentId: number, msg: any): boolean
  task(agentId: number, text: string): boolean
  transcript(agentId: number): any[]
  fire(agentId: number): Promise<boolean>
}
declare module 'fastify' {
  interface FastifyInstance { db: Database.Database; bus: Bus }
}

export function buildServer(db: Database.Database, conductor?: (bus: Bus) => ConductorLike): FastifyInstance {
  const server = Fastify()
  server.decorate('db', db)
  server.decorate('bus', new EventEmitter())
  const maestro = conductor?.(server.bus)
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
      agents: db.prepare(`SELECT * FROM agents WHERE board_id=? ORDER BY name`).all(id),
      cards: listCards(db, id),
      open_questions: db.prepare(`
        SELECT m.*, fa.name AS from_name, ta.name AS to_name FROM messages m
        LEFT JOIN agents fa ON fa.id = m.from_agent_id
        LEFT JOIN agents ta ON ta.id = m.to_agent_id
        WHERE m.board_id=? AND m.reply_to IS NULL
          AND NOT EXISTS (SELECT 1 FROM messages r WHERE r.reply_to = m.id)
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
      return { card, overlaps, similar: similarFor(card, overlaps) }
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
      return { card: updated, overlaps, similar: similarFor(updated, overlaps) }
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
    '/api/v1/messages', (req, reply) => {
      const { board_id, from, to, card_id, body, reply_to } = req.body
      const fromA = agentByName(board_id, from), toA = agentByName(board_id, to)
      // a typo'd recipient must fail loudly, not silently become a broadcast
      if (to && !toA) return reply.code(400).send({ error: `no agent named "${to}" on this board` })
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

  server.post<{ Params: { id: string }; Body: { name?: string; cwd?: string; model?: string } }>(
    '/api/v1/boards/:id/hire', (req, reply) => {
      if (!maestro) return reply.code(501).send({ error: 'conductor not available (daemon-only feature)' })
      const board = db.prepare(`SELECT * FROM boards WHERE id=?`).get(Number(req.params.id)) as any
      if (!board) return reply.code(404).send({ error: 'not found' })
      const agent = maestro.hire({
        boardId: board.id,
        cwd: req.body?.cwd ?? board.project_path,
        name: req.body?.name,
        model: req.body?.model,
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

  server.post<{ Params: { id: string } }>('/api/v1/agents/:id/fire', async (req, reply) => {
    if (!maestro) return reply.code(501).send({ error: 'conductor not available' })
    const ok = await maestro.fire(Number(req.params.id))
    return ok ? { ok: true } : reply.code(404).send({ error: 'not a hired agent' })
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

  server.post<{ Params: { id: string } }>('/api/v1/agents/:id/heartbeat', (req) => {
    const id = Number(req.params.id)
    db.prepare(`UPDATE agents SET status='active', last_seen=datetime('now') WHERE id=?`).run(id)
    const a = db.prepare(`SELECT * FROM agents WHERE id=?`).get(id) as any
    if (a) emit(a.board_id, 'agent', a)
    return a ?? {}
  })

  server.post<{ Params: { id: string } }>('/api/v1/agents/:id/pulse', (req) => {
    const a = db.prepare(`SELECT * FROM agents WHERE id=?`).get(Number(req.params.id)) as any
    db.prepare(`UPDATE agents SET status='active', last_seen=datetime('now') WHERE id=?`).run(a.id)
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

  server.post<{ Params: { id: string } }>('/api/v1/agents/:id/leave', (req) => {
    const id = Number(req.params.id)
    removeAgentCards(db, id) // gone agents leave a clean board
    db.prepare(`UPDATE agents SET status='gone' WHERE id=?`).run(id)
    const a = db.prepare(`SELECT * FROM agents WHERE id=?`).get(id) as any
    emit(a.board_id, 'agent', a)
    emit(a.board_id, 'card', { pruned: id })
    return a
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
