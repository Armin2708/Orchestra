import { expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { openDb } from '../src/db.js'
import { reap } from '../src/reaper.js'

const setup = () => {
  const db = openDb(':memory:')
  db.prepare(`INSERT INTO boards (project_path, name) VALUES ('/p','p')`).run()
  return db
}

const addAgent = (db: Database.Database, name: string, lastSeen: string, extra: { kind?: string; status?: string } = {}) =>
  Number(db.prepare(`INSERT INTO agents (board_id, name, kind, status, last_seen) VALUES (1, ?, ?, ?, datetime('now', ?))`)
    .run(name, extra.kind ?? 'session', extra.status ?? 'active', lastSeen).lastInsertRowid)

const addMirrorProfile = (db: Database.Database, agentId: number, name: string, status = 'active') => {
  const id = `legacy-agent:${agentId}`
  db.prepare(`INSERT INTO agent_profiles (
      id, board_id, legacy_agent_id, name, capabilities_json, owner_actor_type, owner_actor_id,
      status, provenance_json, created_at, updated_at, archived_at
    ) VALUES (?, 1, ?, ?, '[]', 'migration', '022-legacy-projection-forward-plan', ?,
      '{"source":"legacy_agents"}', datetime('now'), datetime('now'), ?)`)
    .run(id, agentId, name, status, status === 'archived' ? new Date().toISOString() : null)
  return id
}

const profile = (db: Database.Database, id: string) =>
  db.prepare(`SELECT * FROM agent_profiles WHERE id=?`).get(id) as Record<string, unknown> | undefined

it('archives mirror profiles of gone agents and keeps live ones visible', () => {
  const db = setup()
  const dead = addAgent(db, 'gone-otter', '-40 minutes')
  const live = addAgent(db, 'fresh-otter', '-1 minutes')
  const deadProfile = addMirrorProfile(db, dead, 'gone-otter')
  addMirrorProfile(db, live, 'fresh-otter')
  // user-created identity (no legacy linkage) must never be touched
  db.prepare(`INSERT INTO agent_profiles (
      id, board_id, legacy_agent_id, name, capabilities_json, owner_actor_type,
      status, provenance_json, created_at, updated_at
    ) VALUES ('user-profile', 1, NULL, 'my-agent', '[]', 'operator', 'active', '{}',
      datetime('now'), datetime('now'))`).run()

  reap(db)

  expect(profile(db, deadProfile)?.status).toBe('archived')
  expect(profile(db, deadProfile)?.archived_at).toBeTruthy()
  expect(profile(db, `legacy-agent:${live}`)?.status).toBe('active')
  expect(profile(db, 'user-profile')?.status).toBe('active')
})

it('creates a mirror profile with a default conversation for live agents that lack one', () => {
  const db = setup()
  const live = addAgent(db, 'fresh-otter', '-1 minutes')
  addAgent(db, 'gone-otter', '-40 minutes') // gone agents never get a profile made for them

  reap(db)

  const mirror = profile(db, `legacy-agent:${live}`)
  expect(mirror?.status).toBe('active')
  expect(mirror?.name).toBe('fresh-otter')
  expect(Number(mirror?.legacy_agent_id)).toBe(live)
  const conversation = db.prepare(`SELECT * FROM agent_conversations
    WHERE profile_id=? AND is_default=1 AND status='active'`).get(`legacy-agent:${live}`)
  expect(conversation).toBeDefined()
  expect(db.prepare(`SELECT count(*) n FROM agent_profiles WHERE name='gone-otter'`).get()).toMatchObject({ n: 0 })
})

it('revives an archived mirror (and its default conversation) when the agent returns', () => {
  const db = setup()
  const agent = addAgent(db, 'phoenix-otter', '-1 minutes', { status: 'gone' })
  const id = addMirrorProfile(db, agent, 'phoenix-otter', 'archived')
  db.prepare(`INSERT INTO agent_conversations (
      id, board_id, profile_id, title, status, is_default, created_by_actor_type,
      created_at, updated_at, archived_at
    ) VALUES ('legacy-conversation:${agent}', 1, ?, 'phoenix-otter conversation', 'archived', 1,
      'migration', datetime('now'), datetime('now'), datetime('now'))`).run(id)
  db.prepare(`UPDATE agents SET status='active', last_seen=datetime('now') WHERE id=?`).run(agent)

  reap(db)

  expect(profile(db, id)?.status).toBe('active')
  expect(profile(db, id)?.archived_at).toBeNull()
  const conversation = db.prepare(`SELECT status FROM agent_conversations WHERE id=?`)
    .get(`legacy-conversation:${agent}`) as { status: string }
  expect(conversation.status).toBe('active')
})

it('leaves a mirror active while it still has a live canonical session', () => {
  const db = setup()
  const agent = addAgent(db, 'busy-otter', '-40 minutes', { status: 'gone' })
  const id = addMirrorProfile(db, agent, 'busy-otter')
  db.prepare(`INSERT INTO agent_conversations (
      id, board_id, profile_id, title, status, is_default, created_by_actor_type, created_at, updated_at
    ) VALUES ('conv-1', 1, ?, 'busy-otter conversation', 'active', 1, 'system', datetime('now'), datetime('now'))`).run(id)
  db.prepare(`INSERT INTO workspaces (id, board_id, name, kind, root_path)
    VALUES ('ws-1', 1, 'ws', 'checkout', '/p')`).run()
  db.prepare(`INSERT INTO agent_sessions (id, workspace_id, provider, status, profile_id, conversation_id)
    VALUES ('sess-1', 'ws-1', 'claude', 'running', ?, 'conv-1')`).run(id)

  reap(db)

  expect(profile(db, id)?.status).toBe('active')
})

it('skips mirror creation when the profile name is already claimed by another identity', () => {
  const db = setup()
  const live = addAgent(db, 'taken-name', '-1 minutes')
  db.prepare(`INSERT INTO agent_profiles (
      id, board_id, legacy_agent_id, name, capabilities_json, owner_actor_type,
      status, provenance_json, created_at, updated_at
    ) VALUES ('user-profile', 1, NULL, 'taken-name', '[]', 'operator', 'active', '{}',
      datetime('now'), datetime('now'))`).run()

  reap(db)

  expect(profile(db, `legacy-agent:${live}`)).toBeUndefined()
})
