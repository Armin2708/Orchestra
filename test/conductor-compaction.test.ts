import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'
import { openDb } from '../src/db.js'

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }))
import { query } from '@anthropic-ai/claude-agent-sdk'
import { Conductor, compactCommandPrompt } from '../src/conductor.js'

/** An SDK handle whose stream we drive message by message. */
function scriptedSession() {
  const pending: any[] = []
  let wake: (() => void) | null = null
  return {
    emit(message: any) { pending.push(message); wake?.() },
    interrupt: async () => {},
    async *[Symbol.asyncIterator]() {
      for (;;) {
        while (pending.length) yield pending.shift()
        await new Promise<void>((resolve) => { wake = resolve })
      }
    },
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

it('recognizes the SDK compaction command, with or without instructions', () => {
  expect(compactCommandPrompt('/compact')).toBe(true)
  expect(compactCommandPrompt('  /compact keep the API contract  ')).toBe(true)
  expect(compactCommandPrompt('/COMPACT')).toBe(true)
  expect(compactCommandPrompt('/compaction')).toBe(false)
  expect(compactCommandPrompt('tell me about /compact')).toBe(false)
})

it('marks a /compact turn as compacting and reports the boundary', async () => {
  const db = openDb(':memory:')
  db.prepare(`INSERT INTO boards (project_path, name) VALUES ('/p', 'p')`).run()
  const session = scriptedSession()
  ;(query as any).mockReturnValue(session)
  const conductor = new Conductor(db, new EventEmitter())
  const agent = conductor.hire({ boardId: 1, cwd: '/p' })

  expect(conductor.transcript(agent.id).working).toBeNull()

  conductor.task(agent.id, '/compact')
  expect(conductor.transcript(agent.id).working?.kind).toBe('compact')

  session.emit({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 45200 } })
  await settle()
  const after = conductor.transcript(agent.id)
  expect(after.lines.at(-1)).toMatchObject({
    kind: 'status',
    text: '✻ Context compacted (manual) · 45.2k tokens summarized',
  })
  // the summary has landed — the rest of the turn is ordinary work again
  expect(after.working?.kind).toBe('work')

  session.emit({ type: 'result', subtype: 'success' })
  await settle()
  expect(conductor.transcript(agent.id).working).toBeNull()
})

it('leaves an ordinary turn marked as work', async () => {
  const db = openDb(':memory:')
  db.prepare(`INSERT INTO boards (project_path, name) VALUES ('/p', 'p')`).run()
  ;(query as any).mockReturnValue(scriptedSession())
  const conductor = new Conductor(db, new EventEmitter())
  const agent = conductor.hire({ boardId: 1, cwd: '/p' })

  conductor.task(agent.id, 'ship the release notes')
  expect(conductor.transcript(agent.id).working?.kind).toBe('work')
})
