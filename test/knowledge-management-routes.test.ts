import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { knowledgeManagementPlugin } from '../src/agent-os/knowledge-management-routes.js'
import { openDb } from '../src/db.js'

const temporary: string[] = []
afterEach(() => { for (const item of temporary.splice(0)) fs.rmSync(item, { recursive: true, force: true }) })

describe('Knowledge management route module', () => {
  it('keeps reads available while operator-gating freshness and review mutations', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-kno-routes-'))
    temporary.push(directory)
    const db = openDb(path.join(directory, 'db.sqlite'))
    db.prepare('INSERT INTO boards (id, project_path, name) VALUES (1, ?, ?)').run(directory, 'Routes')
    const app = Fastify()
    await app.register(knowledgeManagementPlugin, { prefix: '/api/v1/os', db, isOperator: () => false })
    expect((await app.inject({ method: 'GET', url: '/api/v1/os/boards/1/knowledge' })).statusCode)
      .toBe(200)
    const refresh = await app.inject({ method: 'POST', url: '/api/v1/os/boards/1/knowledge/refresh', payload: {} })
    expect(refresh.statusCode).toBe(403)
    expect(refresh.json()).toMatchObject({ code: 'forbidden' })
    await app.close(); db.close()
  })
})
