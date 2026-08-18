import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { openDb } from '../src/db.js'
import { buildServer } from '../src/server.js'
import { TerminalSessionStateService } from '../src/agent-os/terminal-session-state.js'

const servers: FastifyInstance[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

const fixture = async (remote = false, omitResolver = false, pasteImageRoot?: string) => {
  const db = openDb(':memory:')
  const boardId = Number(db.prepare(`INSERT INTO boards (project_path, name)
    VALUES ('/terminal-routes', 'terminal routes')`).run().lastInsertRowid)
  db.prepare(`INSERT INTO workspaces (id, board_id, name, kind, root_path, status)
    VALUES ('workspace-1', ?, 'terminal', 'shared', '/terminal-routes', 'active')`).run(boardId)
  db.prepare(`INSERT INTO processes (
      id, workspace_id, name, command, cwd, status, cols, rows, restartable
    ) VALUES ('process-1', 'workspace-1', 'shell', '/bin/sh', '/terminal-routes',
      'running', 80, 24, 1)`).run()
  const writes: string[] = []
  const terminalSessionState = new TerminalSessionStateService(db, {
    digestKey: Buffer.alloc(32, 9),
    now: () => '2026-08-02T12:00:00.000Z',
    id: () => 'history-1',
  })
  const server = buildServer(db, undefined, {
    agentOs: {
      runtime: {
        writeProcessInput: async (_processId, data) => { writes.push(data) },
        resizeProcess: async () => undefined,
        signalProcess: async () => undefined,
      },
      terminalSessionState,
      ...(pasteImageRoot ? { pasteImageRoot } : {}),
      ...(!omitResolver ? {
        resolveTerminalAccessContext: () => remote
          ? {
              authenticated: true,
              principal: 'remote_device' as const,
              surface: 'unknown' as const,
              scopes: [],
            }
          : {
              authenticated: true,
              principal: 'local_operator' as const,
              surface: 'desktop' as const,
              scopes: [],
            },
      } : {}),
    },
  })
  servers.push(server)
  await server.ready()
  return { db, server, writes }
}

describe('durable terminal route policy', () => {
  it('persists selection and hash-only deliberate command history without projecting command text', async () => {
    const { db, server, writes } = await fixture()
    const selected = await server.inject({
      method: 'PUT',
      url: '/api/v1/os/workspaces/workspace-1/terminal-selection',
      payload: { process_id: 'process-1' },
    })
    expect(selected.statusCode).toBe(200)
    expect(selected.json().selection.selectedProcessId).toBe('process-1')

    const submitted = await server.inject({
      method: 'POST',
      url: '/api/v1/os/processes/process-1/commands',
      payload: { command: 'printf hello' },
    })
    expect(submitted.statusCode).toBe(201)
    expect(writes).toEqual(['printf hello\n'])
    expect(submitted.json().history).toMatchObject({
      retention: 'hash_only',
      projectedText: null,
      redactionState: 'withheld',
    })
    expect(JSON.stringify(db.prepare('SELECT * FROM terminal_command_history').all()))
      .not.toContain('printf hello')
  })

  it('keeps authenticated remote clients view-only without an exact terminal-write grant', async () => {
    const { server, writes } = await fixture(true)
    expect((await server.inject({
      method: 'GET',
      url: '/api/v1/os/processes/process-1',
    })).statusCode).toBe(200)
    const denied = await server.inject({
      method: 'POST',
      url: '/api/v1/os/processes/process-1/input',
      payload: { data: 'whoami\n' },
    })
    expect(denied.statusCode).toBe(403)
    expect(denied.json().error).toContain('remote_view_only_default')
    expect(writes).toEqual([])
  })

  it('validates durable command scope before sending bytes to the PTY', async () => {
    const { server, writes } = await fixture()
    const rejected = await server.inject({
      method: 'POST',
      url: '/api/v1/os/processes/process-1/commands',
      payload: { command: 'printf unsafe', session_id: 'missing-session' },
    })
    expect(rejected.statusCode).toBe(400)
    expect(rejected.json().error).toContain('session_id must identify a session')
    expect(writes).toEqual([])
  })

  it('keeps resolver-free terminal mutation authority authenticated loopback-only', async () => {
    const { server, writes } = await fixture(false, true)
    expect((await server.inject({
      method: 'POST',
      url: '/api/v1/os/processes/process-1/commands',
      payload: { command: 'printf local' },
    })).statusCode).toBe(201)
    expect((await server.inject({
      method: 'POST',
      url: '/api/v1/os/processes/process-1/commands',
      remoteAddress: '203.0.113.7',
      payload: { command: 'printf remote' },
    })).statusCode).toBe(401)
    expect(writes).toEqual(['printf local\n'])
  })
})

describe('terminal image paste', () => {
  // 1x1 transparent PNG
  const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  )
  const pasteRoots: string[] = []
  const pasteRoot = (): string => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-paste-'))
    pasteRoots.push(root)
    return root
  }
  afterEach(() => { for (const root of pasteRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

  it('saves a pasted PNG under the paste root and returns its absolute path', async () => {
    const root = pasteRoot()
    const { server } = await fixture(false, false, root)
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/os/processes/process-1/paste-image',
      payload: { media_type: 'image/png', data: PNG.toString('base64') },
    })
    expect(response.statusCode).toBe(201)
    const saved = response.json()
    expect(saved.path.startsWith(root)).toBe(true)
    expect(saved.path.endsWith('.png')).toBe(true)
    expect(saved.bytes).toBe(PNG.length)
    expect(fs.readFileSync(saved.path)).toEqual(PNG)
  })

  it('rejects unsupported media types and content that fails the magic-byte check', async () => {
    const { server } = await fixture(false, false, pasteRoot())
    expect((await server.inject({
      method: 'POST',
      url: '/api/v1/os/processes/process-1/paste-image',
      payload: { media_type: 'image/svg+xml', data: PNG.toString('base64') },
    })).statusCode).toBe(400)
    expect((await server.inject({
      method: 'POST',
      url: '/api/v1/os/processes/process-1/paste-image',
      payload: { media_type: 'image/png', data: Buffer.from('not a png at all').toString('base64') },
    })).statusCode).toBe(400)
  })

  it('rejects images over the 10 MiB decoded cap', async () => {
    const { server } = await fixture(false, false, pasteRoot())
    const oversized = Buffer.concat([PNG, Buffer.alloc(10 * 1024 * 1024, 7)])
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/os/processes/process-1/paste-image',
      payload: { media_type: 'image/png', data: oversized.toString('base64') },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error).toContain('10 MiB')
  })

  it('keeps remote clients without a terminal-write grant out, like process input', async () => {
    const root = pasteRoot()
    const { server } = await fixture(true, false, root)
    expect((await server.inject({
      method: 'POST',
      url: '/api/v1/os/processes/process-1/paste-image',
      payload: { media_type: 'image/png', data: PNG.toString('base64') },
    })).statusCode).toBe(403)
    expect(fs.readdirSync(root)).toEqual([])
  })
})
