import { expect, it } from 'vitest'
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  codexTokenBudgetForThread,
  codexProviderContractRouting,
  createDaemonProviderToolSurface,
  createDaemonProviderToolSurfaceRefresher,
  codexWorkspaceForThread,
  dataDir,
  port,
  providerToolEvidenceSourceCommit,
  sanitizedCodexEnvironment,
  synchronizeDaemonProviderToolSurface,
  survivors,
} from '../src/daemon.js'
import { openDb } from '../src/db.js'
import { buildServer } from '../src/server.js'
import { canonicalHash, stableJson } from '../src/agent-os/agent-home-support.js'
import {
  DECLARED_PROVIDER_ACCEPTANCE_GATE_IDS_V1,
  ProviderAdapterRegistryV1,
  type DeclaredProviderAcceptanceMatrixV1,
} from '../src/provider-adapter-registry.js'
import {
  ProviderAcceptanceEvidenceStoreV1,
  type ProviderAcceptanceEvidenceRecordV1,
} from '../src/provider-acceptance-evidence-store.js'

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
  expect(providerToolEvidenceSourceCommit({
    ORCHESTRA_PROVIDER_CONTRACT_SOURCE_COMMIT: 'b'.repeat(40),
  })).toBe('b'.repeat(40))
  expect(providerToolEvidenceSourceCommit({
    ORCHESTRA_PROVIDER_CONTRACT_SOURCE_COMMIT: 'main',
  })).toBeNull()
})

it('composes and refreshes the daemon tool surface from verified provider evidence', async () => {
  const checkedAt = '2026-08-02T09:00:00.000Z'
  const sourceCommit = 'a'.repeat(40)
  const doctor = (version: string) => ({
    schema_version: 2 as const,
    contract_schema_version: 1,
    compatibility_schema_version: 1 as const,
    checked_at: checkedAt,
    provider: 'both' as const,
    mode: 'readiness' as const,
    fail_closed: true as const,
    ready: true,
    status: 'validated' as const,
    compatibility_ready: true,
    compatibility_status: 'validated' as const,
    checks: [
      {
        id: 'claude_bundled_cli', label: 'Claude bundled CLI', required: true,
        status: 'validated' as const, actual: '2.1.212', expected: '2.1.212', detail: 'verified',
        executable: {
          source: 'sdk_bundled' as const,
          display: '<sdk>/claude',
          path_fingerprint: 'sha256:0123456789abcdef',
        },
      },
      {
        id: 'codex_cli', label: 'Codex CLI', required: true,
        status: 'validated' as const, actual: version, expected: version, detail: 'verified',
        executable: {
          source: 'path' as const,
          display: '<$PATH>/codex',
          path_fingerprint: 'sha256:0123456789abcdef',
        },
      },
    ],
  })
  const discovery = (
    providerId: 'claude' | 'codex' | 'qwen' | 'kimi',
    version: string | null,
    status: 'validated' | 'missing' = 'validated',
  ) => ({
    contract_version: 1 as const,
    provider_id: providerId,
    adapter_id: {
      claude: 'claude-agent-sdk',
      codex: 'codex-app-server',
      qwen: 'qwen-code-cli',
      kimi: 'kimi-code-acp',
    }[providerId],
    status,
    source: providerId === 'claude' ? 'sdk_bundled' as const : 'path' as const,
    version,
    platform: 'darwin-arm64',
    resolved_path: status === 'validated' && providerId !== 'claude'
      ? `/opt/${providerId}/bin/${providerId}`
      : null,
    executable_fingerprint: `sha256:${'a'.repeat(64)}`,
  })
  const discoveries = (codexVersion: string) => ({
    claude: discovery('claude', '2.1.212'),
    codex: discovery('codex', codexVersion),
    qwen: discovery('qwen', null, 'missing'),
    kimi: discovery('kimi', null, 'missing'),
  })
  const acceptanceMatrix: DeclaredProviderAcceptanceMatrixV1 = {
    contract_version: 1,
    provider_id: 'codex',
    adapter_id: 'codex-app-server',
    adapter_version: '1.0.0',
    mode_id: 'native_subscription',
    runtime_mode: 'native_cli',
    billing_mode: 'personal_subscription',
    credential_kind: 'provider_account_session',
    executable_version: '0.144.6',
    platform: 'darwin-arm64',
    source_commit: sourceCommit,
    observed_at: checkedAt,
    gates: Object.fromEntries(DECLARED_PROVIDER_ACCEPTANCE_GATE_IDS_V1.map((id) => [
      id,
      { state: 'passed' as const, evidence_refs: [`evidence/${id}.json`] },
    ])) as DeclaredProviderAcceptanceMatrixV1['gates'],
  }
  const acceptance: ProviderAcceptanceEvidenceRecordV1 = {
    id: `pe_${'a'.repeat(64)}`,
    matrix: acceptanceMatrix,
    matrix_sha256: 'b'.repeat(64),
    artifact_ref: 'evidence/provider-acceptance.json',
    artifact_sha256: 'c'.repeat(64),
    recorded_at: checkedAt,
  }
  const current = await createDaemonProviderToolSurface({
    doctor: () => doctor('0.144.6'),
    discoveries: async () => discoveries('0.144.6'),
    acceptanceEvidence: () => [acceptance],
    sourceCommit: () => sourceCommit,
    integrations: () => [],
  })
  expect(current.matrix.find((row) => row.provider_id === 'codex'))
    .toMatchObject({
      accepted_evidence: true,
      managed_support: 'candidate',
      executable: { health: 'validated' },
    })
  expect(current.matrix.map((row) => row.provider_id).sort())
    .toEqual(['claude', 'codex', 'kimi', 'qwen'])
  expect(current.matrix.filter((row) => row.provider_id !== 'codex')
    .every((row) => row.managed_support !== 'supported')).toBe(true)

  const wrongSource = await createDaemonProviderToolSurface({
    doctor: () => doctor('0.144.6'),
    discoveries: async () => discoveries('0.144.6'),
    acceptanceEvidence: () => [acceptance],
    sourceCommit: () => 'd'.repeat(40),
    integrations: () => [],
  })
  expect(wrongSource.matrix.find((row) => row.provider_id === 'codex'))
    .toMatchObject({ accepted_evidence: false, managed_support: 'candidate' })

  const evidenceRoot = mkdtempSync(join(tmpdir(), 'orchestra-daemon-evidence-'))
  const evidencePath = join(evidenceRoot, 'codex-matrix.json')
  const evidenceDb = openDb(':memory:')
  try {
    writeFileSync(evidencePath, `${stableJson(acceptanceMatrix)}\n`, { mode: 0o600 })
    const evidenceStore = new ProviderAcceptanceEvidenceStoreV1(evidenceDb)
    evidenceStore.record(new ProviderAdapterRegistryV1(), acceptanceMatrix, {
      artifact_ref: pathToFileURL(evidencePath).href,
      artifact_sha256: canonicalHash(acceptanceMatrix),
    })
    unlinkSync(evidencePath)
    const missingRetainedArtifact = await createDaemonProviderToolSurface({
      doctor: () => doctor('0.144.6'),
      discoveries: async () => discoveries('0.144.6'),
      acceptanceEvidence: () => evidenceStore.verified(),
      sourceCommit: () => sourceCommit,
      integrations: () => [],
    })
    expect(missingRetainedArtifact.matrix.find((row) => row.provider_id === 'codex'))
      .toMatchObject({ accepted_evidence: false, managed_support: 'candidate' })
  } finally {
    evidenceDb.close()
    rmSync(evidenceRoot, { recursive: true, force: true })
  }

  const changed = await createDaemonProviderToolSurface({
    doctor: () => doctor('0.144.6'),
    discoveries: async () => discoveries('0.145.0'),
    acceptanceEvidence: () => [acceptance],
    sourceCommit: () => sourceCommit,
    integrations: () => [],
  })
  synchronizeDaemonProviderToolSurface(current, changed)
  expect(current.matrix.find((row) => row.provider_id === 'codex'))
    .toMatchObject({ executable: { health: 'untrusted' } })
  expect(current.registry.get('provider:codex:cli'))
    .toMatchObject({ status: 'unsupported', direct_terminal_available: true })
  expect(current.matrix.find((row) => row.provider_id === 'codex'))
    .toMatchObject({ accepted_evidence: false })

  const refreshed = await createDaemonProviderToolSurface({
    doctor: () => doctor('0.146.0'),
    discoveries: async () => discoveries('0.146.0'),
    integrations: () => [],
  })
  let resolveOlder!: (value: typeof current) => void
  let resolveNewer!: (value: typeof current) => void
  const older = new Promise<typeof current>((resolve) => { resolveOlder = resolve })
  const newer = new Promise<typeof current>((resolve) => { resolveNewer = resolve })
  const pending = [older, newer]
  let fallbackCount = 0
  const refresh = createDaemonProviderToolSurfaceRefresher(
    current,
    async () => pending.shift()!,
    () => {
      fallbackCount += 1
      return changed
    },
  )
  const olderRefresh = refresh()
  const newerRefresh = refresh()
  resolveNewer(refreshed)
  await newerRefresh
  resolveOlder(changed)
  await olderRefresh
  expect(current.matrix.find((row) => row.provider_id === 'codex'))
    .toMatchObject({ executable: { version: '0.146.0' } })
  expect(fallbackCount).toBe(0)

  let rejectStale!: (error: Error) => void
  let resolveLatest!: (value: typeof current) => void
  const staleFailure = new Promise<typeof current>((_resolve, reject) => {
    rejectStale = reject
  })
  const latest = new Promise<typeof current>((resolve) => { resolveLatest = resolve })
  pending.push(staleFailure, latest)
  const staleRefresh = refresh()
  const latestRefresh = refresh()
  resolveLatest(refreshed)
  await latestRefresh
  rejectStale(new Error('stale inspection failed'))
  await staleRefresh
  expect(current.matrix.find((row) => row.provider_id === 'codex'))
    .toMatchObject({ executable: { version: '0.146.0' } })
  expect(fallbackCount).toBe(0)

  pending.push(Promise.reject(new Error('latest inspection failed')))
  await refresh()
  expect(fallbackCount).toBe(1)
  expect(current.matrix.find((row) => row.provider_id === 'codex'))
    .toMatchObject({ executable: { version: '0.145.0' } })
})
