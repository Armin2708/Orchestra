import { afterEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { openDb } from '../src/db.js'
import { buildServer } from '../src/server.js'
import { loadStoredTranscript } from '../src/conductor.js'

const servers: FastifyInstance[] = []
afterEach(async () => { while (servers.length) await servers.pop()!.close() })

const LINES = [
  { at: '2026-08-04T12:00:00.000Z', kind: 'user', text: 'hello' },
  { at: '2026-08-04T12:00:01.000Z', kind: 'text', text: 'hi — picking up the card now' },
  { at: '2026-08-04T12:00:02.000Z', kind: 'status', text: 'turn finished (end_turn) · 2s' },
]

describe('hired-agent transcript persistence (#108)', () => {
  it('serves stored history for a hired agent that has not resumed yet', async () => {
    const db = openDb(':memory:')
    const server = buildServer(db, undefined, { token: 'owner-secret' })
    servers.push(server)
    await server.ready()
    const operator = { host: 'localhost', authorization: 'Bearer owner-secret' }
    const board = (await server.inject({ method: 'POST', url: '/api/v1/boards/resolve', headers: operator, payload: { project_path: '/p' , create: true } })).json()
    const agent = (await server.inject({ method: 'POST', url: '/api/v1/agents/register', headers: operator, payload: { board_id: board.id, name: 'amber-fox' } })).json()
    expect(agent.id).toBeTypeOf('number')
    db.prepare('INSERT INTO agent_transcripts (agent_id, lines) VALUES (?, ?)')
      .run(agent.id, JSON.stringify(LINES))

    const response = await server.inject({
      method: 'GET', url: `/api/v1/agents/${agent.id}/transcript`,
      headers: { host: 'localhost', authorization: 'Bearer owner-secret' },
    })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.restored).toBe(true)
    expect(body.lines).toEqual(LINES)
    expect(body.working).toBeNull()
  })

  it('loadStoredTranscript tolerates missing rows and malformed payloads', () => {
    const db = openDb(':memory:')
    expect(loadStoredTranscript(db, 42)).toEqual([])
    db.prepare('INSERT INTO agent_transcripts (agent_id, lines) VALUES (?, ?)').run(1, 'not json')
    expect(loadStoredTranscript(db, 1)).toEqual([])
    db.prepare('INSERT INTO agent_transcripts (agent_id, lines) VALUES (?, ?)')
      .run(2, JSON.stringify([{ kind: 'text', text: 'ok', at: 'x' }, { bogus: true }, 'junk']))
    expect(loadStoredTranscript(db, 2)).toEqual([{ kind: 'text', text: 'ok', at: 'x' }])
  })
})
