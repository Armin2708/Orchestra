import { expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { openDb } from '../src/db.js'

// the SDK spawns a real claude subprocess — tests drive a hand-cranked session instead
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }))
import { query } from '@anthropic-ai/claude-agent-sdk'
import { Conductor } from '../src/conductor.js'

// a controllable fake of the SDK's streaming query, with the commands control request
function fakeSession(supported?: { name: string; description: string }[]) {
  const msgs: any[] = []
  let notify: (() => void) | null = null
  let closed = false
  const wake = () => { notify?.(); notify = null }
  return {
    emit(m: any) { msgs.push(m); wake() },
    close() { closed = true; wake() },
    query: {
      interrupt: async () => {},
      ...(supported ? { supportedCommands: async () => supported } : {}),
      async *[Symbol.asyncIterator]() {
        while (true) {
          while (msgs.length) yield msgs.shift()
          if (closed) return
          await new Promise<void>((r) => { notify = r })
        }
      },
    },
  }
}

function setup(supported?: { name: string; description: string }[]) {
  const db = openDb(':memory:')
  const sessions: ReturnType<typeof fakeSession>[] = []
  ;(query as any).mockImplementation(() => {
    const s = fakeSession(supported)
    sessions.push(s)
    return s.query
  })
  const conductor = new Conductor(db, new EventEmitter())
  db.prepare(`INSERT INTO boards (project_path, name) VALUES ('/p', 'p')`).run()
  return { conductor, sessions }
}

const until = async (cond: () => boolean) => {
  for (let i = 0; i < 200; i++) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error('condition never became true')
}

it('captures slash_commands at init and exposes them via transcript() info', async () => {
  const t = setup([
    { name: 'compact', description: 'Clear history but keep a summary' },
    { name: 'review', description: 'Review a pull request' },
  ])
  const agent = t.conductor.hire({ boardId: 1, cwd: '/p' })
  t.sessions[0].emit({ type: 'system', subtype: 'init', model: 'claude-fable-5', slash_commands: ['compact', 'review'] })

  await until(() => (t.conductor.transcript(agent.id).info?.commands?.length ?? 0) > 0)
  // supportedCommands() backfills descriptions onto the init names
  await until(() => t.conductor.transcript(agent.id).info!.commands[0].description !== '')
  expect(t.conductor.transcript(agent.id).info!.commands).toEqual([
    { name: 'compact', description: 'Clear history but keep a summary' },
    { name: 'review', description: 'Review a pull request' },
  ])
})

it('falls back to bare init names when the CLI lacks supportedCommands', async () => {
  const t = setup() // no control request available
  const agent = t.conductor.hire({ boardId: 1, cwd: '/p' })
  t.sessions[0].emit({ type: 'system', subtype: 'init', model: 'x', slash_commands: ['compact'] })
  await until(() => (t.conductor.transcript(agent.id).info?.commands?.length ?? 0) > 0)
  expect(t.conductor.transcript(agent.id).info!.commands).toEqual([{ name: 'compact', description: '' }])
})

it('commands_changed REPLACES the cached list mid-session', async () => {
  const t = setup()
  const agent = t.conductor.hire({ boardId: 1, cwd: '/p' })
  const s = t.sessions[0]
  s.emit({ type: 'system', subtype: 'init', model: 'x', slash_commands: ['compact', 'review'] })
  await until(() => (t.conductor.transcript(agent.id).info?.commands?.length ?? 0) === 2)

  s.emit({ type: 'system', subtype: 'commands_changed', commands: [
    { name: 'deploy', description: 'Ship it' },
  ] })
  await until(() => t.conductor.transcript(agent.id).info?.commands?.length === 1)
  expect(t.conductor.transcript(agent.id).info!.commands).toEqual([{ name: 'deploy', description: 'Ship it' }])
})

it('a slash command sent as a task goes through the normal push path unchanged', async () => {
  const t = setup()
  const agent = t.conductor.hire({ boardId: 1, cwd: '/p' })
  t.sessions[0].emit({ type: 'system', subtype: 'init', model: 'x', slash_commands: ['compact'] })
  expect(t.conductor.task(agent.id, '/compact keep decisions')).toBe(true)
  const lines = t.conductor.transcript(agent.id).lines
  expect(lines.some((l) => l.kind === 'user' && l.text === '/compact keep decisions')).toBe(true)
})
