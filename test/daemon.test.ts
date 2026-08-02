import { expect, it } from 'vitest'
import {
  codexTokenBudgetForThread,
  codexProviderContractRouting,
  createDaemonProviderToolSurface,
  codexWorkspaceForThread,
  dataDir,
  port,
  sanitizedCodexEnvironment,
  synchronizeDaemonProviderToolSurface,
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

it('forwards only the environment Codex needs plus explicit safe opt-ins', () => {
  expect(sanitizedCodexEnvironment({
    PATH: '/bin',
    Path: 'C:\\Windows\\System32',
    USERPROFILE: 'C:\\Users\\codex',
    CODEX_HOME: '/codex',
    OPENAI_API_KEY: 'removed-from-subscription-mode',
    OPENAI_BASE_URL: 'removed-from-subscription-mode',
    CODEX_API_KEY: 'removed-from-subscription-mode',
    LC_ALL: 'C.UTF-8',
    ORCHESTRA_CODEX_FORWARD_ENV: 'CUSTOM_CA_HINT,AWS_SECRET_ACCESS_KEY,INVALID-NAME',
    CUSTOM_CA_HINT: 'explicitly-forwarded',
    AWS_SECRET_ACCESS_KEY: 'explicitly-forwarded',
    DATABASE_URL: 'not-forwarded',
    ORCHESTRA_TOKEN: 'removed',
    ANTHROPIC_API_KEY: 'removed',
    CLAUDE_CODE_OAUTH_TOKEN: 'removed',
  })).toEqual({
    PATH: '/bin',
    Path: 'C:\\Windows\\System32',
    USERPROFILE: 'C:\\Users\\codex',
    CODEX_HOME: '/codex',
    LC_ALL: 'C.UTF-8',
    CUSTOM_CA_HINT: 'explicitly-forwarded',
    AWS_SECRET_ACCESS_KEY: 'explicitly-forwarded',
  })
})

it('never forwards Claude or Orchestra credentials even when explicitly requested', () => {
  expect(sanitizedCodexEnvironment({
    ORCHESTRA_CODEX_FORWARD_ENV: 'ORCHESTRA_TOKEN,ANTHROPIC_API_KEY,CLAUDE_CONFIG_DIR',
    ORCHESTRA_TOKEN: 'removed',
    ANTHROPIC_API_KEY: 'removed',
    CLAUDE_CONFIG_DIR: 'removed',
  })).toEqual({})
})

it('keeps Codex provider-contract routing opt-in and commit-exact', () => {
  expect(codexProviderContractRouting({})).toEqual({
    enabled: false,
    source_commit: null,
  })
  expect(codexProviderContractRouting({
    ORCHESTRA_CODEX_PROVIDER_CONTRACT: '1',
    ORCHESTRA_PROVIDER_CONTRACT_SOURCE_COMMIT: 'a'.repeat(40),
  })).toEqual({
    enabled: true,
    source_commit: 'a'.repeat(40),
  })
  expect(() => codexProviderContractRouting({
    ORCHESTRA_CODEX_PROVIDER_CONTRACT: 'yes',
  })).toThrow(/must be 0 or 1/)
  expect(() => codexProviderContractRouting({
    ORCHESTRA_CODEX_PROVIDER_CONTRACT: '1',
    ORCHESTRA_PROVIDER_CONTRACT_SOURCE_COMMIT: 'main',
  })).toThrow(/exact 40- or 64-character commit/)
})

it('composes and refreshes the daemon tool surface from verified provider evidence', async () => {
  const checkedAt = '2026-08-02T09:00:00.000Z'
  const doctor = (version: string) => ({
    schema_version: 2 as const,
    contract_schema_version: 1,
    compatibility_schema_version: 1 as const,
    checked_at: checkedAt,
    provider: 'codex' as const,
    mode: 'readiness' as const,
    fail_closed: true as const,
    ready: true,
    status: 'validated' as const,
    compatibility_ready: true,
    compatibility_status: 'validated' as const,
    checks: [{
      id: 'codex_cli', label: 'Codex CLI', required: true,
      status: 'validated' as const, actual: version, expected: version, detail: 'verified',
      executable: {
        source: 'path' as const,
        display: '<$PATH>/codex',
        path_fingerprint: 'sha256:0123456789abcdef',
      },
    }],
  })
  const discovery = (version: string) => ({
    contract_version: 1 as const,
    provider_id: 'codex',
    adapter_id: 'codex-app-server',
    status: 'validated' as const,
    source: 'path' as const,
    version,
    platform: 'darwin-arm64',
    resolved_path: '/opt/codex/bin/codex',
    executable_fingerprint: `sha256:${'a'.repeat(64)}`,
  })
  const current = await createDaemonProviderToolSurface({
    doctor: () => doctor('0.144.6'),
    discoverCodex: async () => discovery('0.144.6'),
    integrations: () => [],
  })
  expect(current.matrix.find((row) => row.provider_id === 'codex'))
    .toMatchObject({ executable: { health: 'validated' } })

  const changed = await createDaemonProviderToolSurface({
    doctor: () => doctor('0.144.6'),
    discoverCodex: async () => discovery('0.145.0'),
    integrations: () => [],
  })
  synchronizeDaemonProviderToolSurface(current, changed)
  expect(current.matrix.find((row) => row.provider_id === 'codex'))
    .toMatchObject({ executable: { health: 'untrusted' } })
  expect(current.registry.get('provider:codex:cli'))
    .toMatchObject({ status: 'unsupported', direct_terminal_available: true })
})
