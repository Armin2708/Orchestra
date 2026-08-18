import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDb } from '../src/db.js'
import { createGraphifyAutoSync } from '../src/agent-os/knowledge-graphify-autosync.js'

const roots: string[] = []
const projectRoot = (): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-autosync-'))
  roots.push(root)
  return root
}
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

const fixture = (withGraph = true) => {
  const db = openDb(':memory:')
  const root = projectRoot()
  if (withGraph) {
    fs.mkdirSync(path.join(root, 'graphify-out'), { recursive: true })
    fs.writeFileSync(path.join(root, 'graphify-out', 'graph.json'), '{"nodes":[]}')
  }
  const boardId = Number(db.prepare(
    'INSERT INTO boards (project_path, name) VALUES (?, ?)',
  ).run(root, 'autosync').lastInsertRowid)
  const calls: number[] = []
  const sync = createGraphifyAutoSync(db, {
    ingest: (_db, input) => { calls.push(input.board_id); return { board_id: input.board_id } as never },
  })
  return { db, root, boardId, calls, sync }
}

describe('graphify auto-sync', () => {
  it('ingests a board with graphify output on the first tick and stays quiet while unchanged', () => {
    const { boardId, calls, sync } = fixture()
    sync.tick()
    expect(calls).toEqual([boardId])
    sync.tick()
    sync.tick()
    expect(calls).toEqual([boardId])
  })

  it('re-ingests when the graph file changes', () => {
    const { root, boardId, calls, sync } = fixture()
    sync.tick()
    const graph = path.join(root, 'graphify-out', 'graph.json')
    fs.writeFileSync(graph, '{"nodes":[{"id":"a"}]}')
    fs.utimesSync(graph, new Date(), new Date(Date.now() + 5_000))
    sync.tick()
    expect(calls).toEqual([boardId, boardId])
  })

  it('skips boards without graphify output entirely', () => {
    const { calls, sync } = fixture(false)
    sync.tick()
    expect(calls).toEqual([])
  })

  it('isolates ingest failures so the tick never throws and retries on the next change', () => {
    const db = openDb(':memory:')
    const root = projectRoot()
    fs.mkdirSync(path.join(root, 'graphify-out'), { recursive: true })
    const graph = path.join(root, 'graphify-out', 'graph.json')
    fs.writeFileSync(graph, '{}')
    db.prepare('INSERT INTO boards (project_path, name) VALUES (?, ?)').run(root, 'boom')
    let attempts = 0
    const sync = createGraphifyAutoSync(db, {
      ingest: () => { attempts += 1; throw new Error('knowledge service down') },
    })
    expect(() => sync.tick()).not.toThrow()
    expect(attempts).toBe(1)
    // unchanged file after a failure: retry is deferred until the graph changes again
    sync.tick()
    expect(attempts).toBe(1)
    fs.utimesSync(graph, new Date(), new Date(Date.now() + 5_000))
    sync.tick()
    expect(attempts).toBe(2)
  })
})
