import { expect, it, vi } from 'vitest'
import { openDb } from '../src/db.js'
import { buildServer } from '../src/server.js'
import { buildDemoAction } from '../src/demo-cli.js'

const run = async (s: any) => {
  const lines: string[] = []
  const action = buildDemoAction({
    api: async (method, p, body) => {
      const res = await s.inject({ method: method as any, url: `/api/v1${p}`, payload: body as any })
      if (res.statusCode >= 400) throw new Error(`${method} ${p} → ${res.statusCode}`)
      return res.json()
    },
    ensureReady: vi.fn(async () => {}),
    boardUrl: () => 'http://127.0.0.1:4750',
    output: (line) => lines.push(line),
  })
  await action()
  return lines.join('\n')
}

it('seeds a demo board once and is idempotent after that', async () => {
  const s = buildServer(openDb(':memory:')); await s.ready()
  const first = await run(s)
  expect(first).toContain('Demo board seeded')
  expect(first).toContain('overlap')
  const boards = (await s.inject({ method: 'GET', url: '/api/v1/boards' })).json()
  expect(boards).toHaveLength(1)
  const snap = (await s.inject({ method: 'GET', url: `/api/v1/boards/${boards[0].id}/snapshot` })).json()
  expect(snap.cards.length).toBeGreaterThanOrEqual(4)
  expect(snap.agents.map((a: any) => a.name)).toContain('amber-fox')
  expect(snap.cards.some((c: any) => c.column === 'review')).toBe(true)
  expect(snap.threads.length).toBeGreaterThanOrEqual(1)

  const second = await run(s)
  expect(second).toContain('already seeded')
  const after = (await s.inject({ method: 'GET', url: `/api/v1/boards/${boards[0].id}/snapshot` })).json()
  expect(after.cards.length).toBe(snap.cards.length)
})
