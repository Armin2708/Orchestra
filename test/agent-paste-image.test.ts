import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { openDb } from '../src/db.js'
import { buildServer } from '../src/server.js'

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

it('saves a chat-pasted image to a file the agent can read', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-paste-test-'))
  const s = buildServer(openDb(':memory:'), undefined, { agentOs: { pasteImageRoot: root } })
  await s.ready()
  const b = (await s.inject({ method: 'POST', url: '/api/v1/boards/resolve', payload: { project_path: '/p' } })).json()
  const a = (await s.inject({ method: 'POST', url: '/api/v1/agents/register', payload: { board_id: b.id, name: 'amber-fox' } })).json()

  const res = await s.inject({ method: 'POST', url: `/api/v1/agents/${a.id}/paste-image`,
    payload: { media_type: 'image/png', data: PNG_1PX } })
  expect(res.statusCode).toBe(201)
  const saved = res.json()
  expect(saved.path.startsWith(root)).toBe(true)
  expect(saved.path.endsWith('.png')).toBe(true)
  expect(fs.readFileSync(saved.path)).toEqual(Buffer.from(PNG_1PX, 'base64'))
  expect(saved.bytes).toBe(Buffer.from(PNG_1PX, 'base64').byteLength)

  // declared type must match the actual bytes
  const forged = await s.inject({ method: 'POST', url: `/api/v1/agents/${a.id}/paste-image`,
    payload: { media_type: 'image/jpeg', data: PNG_1PX } })
  expect(forged.statusCode).toBe(400)

  const missing = await s.inject({ method: 'POST', url: '/api/v1/agents/999/paste-image',
    payload: { media_type: 'image/png', data: PNG_1PX } })
  expect(missing.statusCode).toBe(404)
})
