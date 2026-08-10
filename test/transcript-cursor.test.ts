import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { openDb } from '../src/db.js'
import { buildServer } from '../src/server.js'

const OPERATOR_TOKEN = 'transcript-cursor-operator'
const operator = { authorization: `Bearer ${OPERATOR_TOKEN}` }
const servers: FastifyInstance[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
})

type Line = { at: string; kind: string; text: string }

const line = (n: number): Line => ({ at: `2026-08-06T13:0${n % 10}:00.000Z`, kind: 'text', text: `line ${n}` })
const anchor = (l: Line): string => `${l.at}|${l.kind}|${l.text.slice(0, 40)}`

function fixture(lines: Line[]): { server: FastifyInstance; agentId: number; db: ReturnType<typeof openDb> } {
  const db = openDb(':memory:')
  const boardId = Number(db.prepare(
    "INSERT INTO boards (project_path, name) VALUES ('/transcript-cursor', 'Transcript cursor')",
  ).run().lastInsertRowid)
  const agentId = Number(db.prepare(
    "INSERT INTO agents (board_id, name, status) VALUES (?, 'scribe', 'idle')",
  ).run(boardId).lastInsertRowid)
  db.prepare(`INSERT INTO agent_transcripts (agent_id, lines, updated_at)
    VALUES (?, ?, datetime('now'))`).run(agentId, JSON.stringify(lines))
  const server = buildServer(db, undefined, { token: OPERATOR_TOKEN })
  servers.push(server)
  return { server, agentId, db }
}

const read = async (server: FastifyInstance, agentId: number, query = '') => {
  const res = await server.inject({ method: 'GET', url: `/api/v1/agents/${agentId}/transcript${query}`, headers: operator })
  expect(res.statusCode).toBe(200)
  return res.json() as { lines: Line[]; from: number; total: number }
}

describe('transcript delta cursor', () => {
  it('serves the full history when the client holds nothing', async () => {
    const lines = [line(1), line(2), line(3)]
    const { server, agentId } = fixture(lines)
    await server.ready()

    const body = await read(server, agentId)
    expect(body.from).toBe(0)
    expect(body.total).toBe(3)
    expect(body.lines).toHaveLength(3)
  })

  it('serves only new lines when the client anchor still matches the held tail', async () => {
    const lines = [line(1), line(2), line(3), line(4)]
    const { server, agentId } = fixture(lines)
    await server.ready()

    const body = await read(server, agentId, `?since=2&anchor=${encodeURIComponent(anchor(lines[1]))}`)
    expect(body.from).toBe(2)
    expect(body.total).toBe(4)
    expect(body.lines.map((l) => l.text)).toEqual(['line 3', 'line 4'])
  })

  it('returns an empty delta — not a resend — when nothing has changed', async () => {
    const lines = [line(1), line(2)]
    const { server, agentId } = fixture(lines)
    await server.ready()

    const body = await read(server, agentId, `?since=2&anchor=${encodeURIComponent(anchor(lines[1]))}`)
    expect(body.from).toBe(2)
    expect(body.total).toBe(2)
    expect(body.lines).toEqual([])
  })

  it('resends the full history when the anchor no longer matches — a rolled-over or cleared transcript', async () => {
    const lines = [line(5), line(6), line(7)]
    const { server, agentId } = fixture(lines)
    await server.ready()

    // client believes it holds 2 lines ending in "line 2"; the daemon's history has since
    // rolled past that point, so the cursor must not be trusted
    const body = await read(server, agentId, `?since=2&anchor=${encodeURIComponent(anchor(line(2)))}`)
    expect(body.from).toBe(0)
    expect(body.total).toBe(3)
    expect(body.lines.map((l) => l.text)).toEqual(['line 5', 'line 6', 'line 7'])
  })

  it('ignores a cursor that runs past the held history', async () => {
    const lines = [line(1)]
    const { server, agentId } = fixture(lines)
    await server.ready()

    for (const query of ['?since=9&anchor=whatever', '?since=-1&anchor=x', '?since=abc&anchor=x', '?since=1']) {
      const body = await read(server, agentId, query)
      expect(body.from).toBe(0)
      expect(body.lines).toHaveLength(1)
    }
  })
})

describe('prepared statement cache', () => {
  it('reuses one compiled statement per SQL string and keeps results correct', () => {
    const { db, agentId } = fixture([line(1)])
    const sql = 'SELECT name FROM agents WHERE id=?'
    const first = db.prepare(sql)
    const second = db.prepare(sql)

    expect(second).toBe(first)
    expect((first.get(agentId) as { name: string }).name).toBe('scribe')
    // a reused statement must stay usable across differing bindings
    expect(second.get(agentId + 1)).toBeUndefined()
    expect((second.get(agentId) as { name: string }).name).toBe('scribe')
  })

  it('keeps the cache bounded when SQL is built by interpolation', () => {
    const { db } = fixture([line(1)])
    // 600 distinct statements — past the 512 cap, which flushes rather than growing
    for (let n = 0; n < 600; n++) {
      db.prepare(`SELECT ${n} AS n, name FROM agents WHERE id=?`)
    }
    const stable = 'SELECT count(*) AS c FROM agents'
    expect(db.prepare(stable)).toBe(db.prepare(stable))
    expect((db.prepare(stable).get() as { c: number }).c).toBe(1)
  })
})
