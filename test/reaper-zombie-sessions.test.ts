import { expect, it } from 'vitest'
import { openDb } from '../src/db.js'
import { reap } from '../src/reaper.js'

// A daemon restart loses the provider manager's in-memory end path, so legacy
// managed sessions (legacy-qwen:*, legacy-codex-session:*) stayed 'running'
// forever after their agent went gone — permanently eating capacity slots.
it('reap stops sessions whose agent is gone, sparing live ones', () => {
  const db = openDb(':memory:')
  db.prepare(`INSERT INTO boards (id, project_path, name) VALUES (1, '/p', 'p')`).run()
  db.prepare(`INSERT INTO agents (id, board_id, name, status, kind) VALUES (1, 1, 'dead-qwen', 'gone', 'hired')`).run()
  db.prepare(`INSERT INTO agents (id, board_id, name, status, kind) VALUES (2, 1, 'live-fox', 'active', 'hired')`).run()
  db.prepare(`INSERT INTO workspaces (id, board_id, name, kind, root_path, status)
    VALUES ('w1', 1, 'w', 'shared', '/p', 'active')`).run()
  const insert = db.prepare(`INSERT INTO agent_sessions (id, workspace_id, agent_id, provider, status)
    VALUES (?, 'w1', ?, 'qwen', ?)`)
  insert.run('legacy-qwen:1', 1, 'running')
  insert.run('legacy-qwen:2', 2, 'running')

  reap(db)

  const status = (id: string) =>
    (db.prepare(`SELECT status, control_state FROM agent_sessions WHERE id=?`).get(id) as any)
  expect(status('legacy-qwen:1')).toEqual({ status: 'stopped', control_state: 'stopped' })
  expect(status('legacy-qwen:2')).toEqual({ status: 'running', control_state: 'active' })
  expect((db.prepare(`SELECT ended_at FROM agent_sessions WHERE id='legacy-qwen:1'`).get() as any).ended_at).toBeTruthy()
})
