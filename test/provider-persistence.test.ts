import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { openDb } from '../src/db.js'
import { buildServer } from '../src/server.js'
import {
  CODEX_PROVIDER_ID,
  codexProviderCatalog,
  normalizeProviderModels,
  readProviderModelCache,
  writeProviderModelCache,
} from '../src/agent-providers.js'
import { fromCodexUsage, providerBoardUsage, recordProviderUsage, usageTotal } from '../src/usage.js'

it('backfills legacy Claude identity and keeps subsequent SDK session writes synchronized', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-provider-db-'))
  const file = path.join(dir, 'legacy.db')
  const legacy = new Database(file)
  legacy.exec(`
    CREATE TABLE boards (id INTEGER PRIMARY KEY, project_path TEXT NOT NULL UNIQUE, name TEXT NOT NULL);
    CREATE TABLE agents (
      id INTEGER PRIMARY KEY, board_id INTEGER NOT NULL, name TEXT NOT NULL, session_id TEXT,
      status TEXT NOT NULL DEFAULT 'active', last_seen TEXT NOT NULL DEFAULT (datetime('now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')), sdk_session TEXT, UNIQUE(board_id, name)
    );
    INSERT INTO boards (id, project_path, name) VALUES (1, '/legacy', 'legacy');
    INSERT INTO agents (id, board_id, name, sdk_session) VALUES (1, 1, 'legacy-fox', 'claude-session-1');
  `)
  legacy.close()

  const db = openDb(file)
  expect(db.prepare(`SELECT provider, external_session_id, provider_state_json FROM agents WHERE id=1`).get())
    .toMatchObject({ provider: 'claude', external_session_id: 'claude-session-1', provider_state_json: '{}' })

  db.prepare(`UPDATE agents SET sdk_session='claude-session-2' WHERE id=1`).run()
  expect(db.prepare(`SELECT external_session_id FROM agents WHERE id=1`).get())
    .toMatchObject({ external_session_id: 'claude-session-2' })

  const indexes = db.prepare(`SELECT name FROM sqlite_master WHERE type='index'`).all().map((row: any) => row.name)
  expect(indexes).toContain('agents_provider_session_idx')
  expect(indexes).toContain('agents_board_provider_status_idx')
  db.close()
  fs.rmSync(dir, { recursive: true })
})

it('persists Codex identity and reported token totals without double-counting cached input', () => {
  const db = openDb(':memory:')
  db.prepare(`INSERT INTO boards (id, project_path, name) VALUES (1, '/p', 'p')`).run()
  db.prepare(`INSERT INTO agents (
    id, board_id, name, provider, external_session_id, provider_state_json, access_profile
  ) VALUES (1, 1, 'codex-owl', 'codex', 'thread-1', '{"turnId":"turn-1"}', 'workspace_write')`).run()

  const usage = fromCodexUsage({
    totalTokens: 150,
    inputTokens: 100,
    cachedInputTokens: 80,
    outputTokens: 50,
    reasoningOutputTokens: 20,
  })
  recordProviderUsage(db, 1, 1, usage)

  expect(db.prepare(`SELECT provider, total_tokens, input_tokens, cached_input_tokens,
    cache_read, output_tokens, reasoning_output_tokens FROM agent_usage`).get()).toMatchObject({
      provider: 'codex', total_tokens: 150, input_tokens: 100, cached_input_tokens: 80,
      cache_read: 0, output_tokens: 50, reasoning_output_tokens: 20,
    })
  expect(providerBoardUsage(db, 1).total).toMatchObject({ total_tokens: 150, input_tokens: 100 })
  expect(usageTotal(db)).toMatchObject({ input_tokens: 100, cache_read: 0, output_tokens: 50 })
})

it('keeps provider model caches isolated and normalizes app-server reasoning options', () => {
  const db = openDb(':memory:')
  const models = normalizeProviderModels([{
    id: 'gpt-5.4',
    model: 'gpt-5.4',
    displayName: 'GPT-5.4',
    description: 'Codex model',
    isDefault: true,
    defaultReasoningEffort: 'xhigh',
    supportedReasoningEfforts: [
      { reasoningEffort: 'low', description: 'Fast' },
      { reasoningEffort: 'xhigh', description: 'Deep' },
    ],
  }])
  expect(models).toEqual([expect.objectContaining({
    value: 'gpt-5.4', isDefault: true, defaultEffort: 'xhigh',
    supportedEffortLevels: ['low', 'xhigh'], supportsEffort: true,
  })])

  writeProviderModelCache(db, models, CODEX_PROVIDER_ID)
  expect(readProviderModelCache(db)).toBeNull()
  expect(readProviderModelCache(db, CODEX_PROVIDER_ID)?.models).toEqual(models)
  expect(codexProviderCatalog({ available: true, models, source: 'live' }))
    .toMatchObject({ id: 'codex', name: 'Codex', available: true, models })
})

it('namespaces ambient registrations by provider and refuses provider identity collisions', async () => {
  const db = openDb(':memory:')
  const server = buildServer(db)
  await server.ready()
  const board = (await server.inject({
    method: 'POST', url: '/api/v1/boards/resolve', payload: { project_path: '/ambient' },
  })).json()

  const codex = await server.inject({
    method: 'POST',
    url: '/api/v1/agents/register',
    payload: { board_id: board.id, provider: 'codex', session_id: 'shared-looking-id', name: 'ambient-owl' },
  })
  expect(codex.statusCode).toBe(200)
  expect(codex.json()).toMatchObject({
    provider: 'codex', session_id: 'shared-looking-id', external_session_id: 'shared-looking-id',
    session_token: expect.any(String),
  })

  const takeover = await server.inject({
    method: 'POST',
    url: '/api/v1/agents/register',
    payload: { board_id: board.id, provider: 'codex', session_id: 'different-id', name: 'ambient-owl' },
  })
  expect(takeover.statusCode).toBe(409)
  // re-registering the same provider identity under a different env name is NOT a
  // collision: the stored identity name wins over the session's stale env name (#129),
  // so the agent keeps its operator-assigned name instead of stranding its hooks
  const duplicateIdentity = await server.inject({
    method: 'POST',
    url: '/api/v1/agents/register',
    payload: { board_id: board.id, provider: 'codex', session_id: 'shared-looking-id', name: 'other-owl' },
  })
  expect(duplicateIdentity.statusCode).toBe(200)
  expect(duplicateIdentity.json()).toMatchObject({ id: codex.json().id, name: 'ambient-owl' })
  // re-registration rotated the session credential — heartbeats must use the new token
  const currentToken = duplicateIdentity.json().session_token
  expect((await server.inject({
    method: 'POST',
    url: `/api/v1/agents/${codex.json().id}/heartbeat`,
    payload: { provider: 'claude', session_id: 'shared-looking-id', session_token: currentToken },
  })).statusCode).toBe(403)
  expect((await server.inject({
    method: 'POST',
    url: `/api/v1/agents/${codex.json().id}/heartbeat`,
    payload: {
      provider: 'codex', session_id: 'shared-looking-id', session_token: currentToken,
    },
  })).statusCode).toBe(200)

  const collision = await server.inject({
    method: 'POST',
    url: '/api/v1/agents/register',
    payload: { board_id: board.id, provider: 'claude', session_id: 'another-id', name: 'ambient-owl' },
  })
  expect(collision.statusCode).toBe(409)
  expect(await server.inject({
    method: 'POST',
    url: '/api/v1/agents/register',
    payload: { board_id: board.id, provider: '../codex', session_id: 'bad' },
  })).toMatchObject({ statusCode: 400 })
  await server.close()
})
