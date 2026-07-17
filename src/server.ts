import Fastify, { FastifyInstance } from 'fastify'
import type Database from 'better-sqlite3'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import { generateName } from './names.js'
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

  return server
}

export function listCards(db: Database.Database, boardId: number) {
  return (db.prepare(`
    SELECT c.*, a.name AS owner FROM cards c
    LEFT JOIN agents a ON a.id = c.owner_agent_id
    WHERE c.board_id=? ORDER BY c.updated_at DESC`).all(boardId) as any[])
    .map((c) => ({ ...c, column: c.column_name, paths: JSON.parse(c.paths) }))
}
