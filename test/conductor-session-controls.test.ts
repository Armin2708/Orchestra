import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'
import { openDb } from '../src/db.js'

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }))
import { query } from '@anthropic-ai/claude-agent-sdk'
import { Conductor } from '../src/conductor.js'

function liveSession() {
  let servers = [{ name: 'github', status: 'connected' }]
  return {
    mcpServerStatus: vi.fn(async () => servers),
    toggleMcpServer: vi.fn(async (name: string, enabled: boolean) => {
      servers = [{ name, status: enabled ? 'connected' : 'disabled' }]
    }),
    reconnectMcpServer: vi.fn(async (name: string) => {
      servers = [{ name, status: 'connected' }]
    }),
    reloadPlugins: vi.fn(async () => ({
      commands: [{ name: 'review', description: 'Review changes' }],
      plugins: [{ name: 'review-tools', path: '/plugins/review-tools' }],
      error_count: 0,
    })),
    interrupt: async () => {},
    async *[Symbol.asyncIterator]() { await new Promise(() => {}) },
  }
}

it('uses the live Claude SDK query for MCP and plugin controls', async () => {
  const db = openDb(':memory:')
  db.prepare(`INSERT INTO boards (project_path, name) VALUES ('/p', 'p')`).run()
  const session = liveSession()
  ;(query as any).mockReturnValue(session)
  const conductor = new Conductor(db, new EventEmitter())
  const agent = conductor.hire({ boardId: 1, cwd: '/p' })

  await expect(conductor.mcpStatus(agent.id)).resolves.toEqual([{ name: 'github', status: 'connected' }])
  await expect(conductor.toggleMcpServer(agent.id, 'github', false)).resolves.toEqual([{ name: 'github', status: 'disabled' }])
  expect(session.toggleMcpServer).toHaveBeenCalledWith('github', false)
  await expect(conductor.reconnectMcpServer(agent.id, 'github')).resolves.toEqual([{ name: 'github', status: 'connected' }])
  expect(session.reconnectMcpServer).toHaveBeenCalledWith('github')

  await expect(conductor.reloadPlugins(agent.id)).resolves.toMatchObject({
    plugins: [{ name: 'review-tools', path: '/plugins/review-tools' }],
  })
  expect(conductor.transcript(agent.id).info?.commands).toEqual([{ name: 'review', description: 'Review changes' }])
  await expect(conductor.mcpStatus(404)).resolves.toBeNull()
})
