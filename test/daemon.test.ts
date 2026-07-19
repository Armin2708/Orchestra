import { expect, it } from 'vitest'
import {
  codexTokenBudgetForThread,
  codexWorkspaceForThread,
  dataDir,
  port,
  sanitizedCodexEnvironment,
  survivors,
} from '../src/daemon.js'
import { openDb } from '../src/db.js'
import { buildServer } from '../src/server.js'

it('resolves data dir and port from env', () => {
  process.env.ORCHESTRA_HOME = '/tmp/abtest'
  process.env.ORCHESTRA_PORT = '5999'
  expect(dataDir()).toBe('/tmp/abtest')
  expect(port()).toBe(5999)
  delete process.env.ORCHESTRA_HOME; delete process.env.ORCHESTRA_PORT
})

it('serves SSE with correct content type', async () => {
  const s = buildServer(openDb(':memory:')); await s.ready()
  await s.inject({ method: 'POST', url: '/api/v1/boards/resolve', payload: { project_path: '/p' } })
  const res = await s.inject({ method: 'GET', url: '/api/v1/boards/1/events',
    payloadAsStream: true })
  expect(res.headers['content-type']).toContain('text/event-stream')
})

it('restores provider identity and resolves Codex threads across legacy and Agent OS sessions', async () => {
  const db = openDb(':memory:')
  db.prepare("INSERT INTO boards (id, project_path, name) VALUES (1, '/project', 'project')").run()
  db.prepare(`INSERT INTO agents
    (id, board_id, name, kind, status, provider, external_session_id, access_profile)
    VALUES (7, 1, 'codex-owl', 'hired', 'active', 'codex', 'thread-legacy', 'workspace_write')`).run()
  expect(survivors(db)[0]).toMatchObject({
    provider: 'codex', external_session_id: 'thread-legacy', access_profile: 'workspace_write',
  })
  expect(codexWorkspaceForThread(db, 'thread-legacy')).toBe('legacy-agent:7')

  db.prepare(`INSERT INTO workspaces
    (id, board_id, name, kind, root_path, base_ref) VALUES ('workspace-1', 1, 'job', 'shared', '/project', 'HEAD')`).run()
  db.prepare(`INSERT INTO jobs
    (id, board_id, workspace_id, provider, status, budget_tokens)
    VALUES ('job-1', 1, 'workspace-1', 'codex', 'running', 250)`).run()
  db.prepare(`INSERT INTO agent_sessions
    (id, workspace_id, agent_id, provider, external_id, status, context_json)
    VALUES ('session-1', 'workspace-1', 7, 'codex', 'thread-job', 'running', '{"job_id":"job-1"}')`).run()
  expect(codexWorkspaceForThread(db, 'thread-job')).toBe('workspace-1')
  expect(codexTokenBudgetForThread(db, 'thread-job')).toBe(250)
})

it('sanitizes Claude and Orchestra credentials without stripping Codex authentication', () => {
  expect(sanitizedCodexEnvironment({
    PATH: '/bin',
    CODEX_HOME: '/codex',
    OPENAI_API_KEY: 'kept-for-app-server',
    ORCHESTRA_TOKEN: 'removed',
    ANTHROPIC_API_KEY: 'removed',
    CLAUDE_CODE_OAUTH_TOKEN: 'removed',
  })).toEqual({ PATH: '/bin', CODEX_HOME: '/codex', OPENAI_API_KEY: 'kept-for-app-server' })
})
