import { describe, expect, it } from 'vitest'
import { openDb } from '../src/db.js'
import {
  ToolCapabilityRegistry,
  buildDeclaredProviderCapabilityMatrix,
  createDeclaredProviderToolRegistry,
  type ToolCapability,
} from '../src/tool-capabilities.js'
import { SessionToolService } from '../src/agent-os/session-tools.js'

const nativeTool = (overrides: Partial<ToolCapability> = {}): ToolCapability => ({
  schema_version: 1,
  id: 'native:workspace-editor',
  name: 'Workspace editor',
  kind: 'native',
  provider_id: 'codex',
  session_id: null,
  status: 'ready',
  managed_support: 'supported',
  direct_terminal_available: false,
  capabilities: ['file_change'],
  permission: {
    requested: 'approval_required',
    effective: 'allow',
    source: 'provider',
  },
  provenance: {
    evidence: 'observed',
    observed_at: '2026-08-02T10:00:00.000Z',
    executable: null,
    package: null,
    provider_native_id: 'workspace-editor',
  },
  error: null,
  ...overrides,
})

const fixture = () => {
  const db = openDb(':memory:')
  const boardId = Number(db.prepare(`INSERT INTO boards (project_path, name)
    VALUES ('/tools', 'Tools')`).run().lastInsertRowid)
  db.prepare(`INSERT INTO workspaces (id, board_id, name, kind, root_path, status)
    VALUES ('workspace-tools', ?, 'tools', 'shared', '/tools', 'active')`).run(boardId)
  db.prepare(`INSERT INTO agent_sessions
    (id, workspace_id, provider, status, mode, access_profile)
    VALUES ('session-tools', 'workspace-tools', 'codex', 'running', 'managed', 'workspace_write')`).run()
  const matrix = buildDeclaredProviderCapabilityMatrix()
  const registry = new ToolCapabilityRegistry([
    nativeTool(),
    nativeTool({
      id: 'native:restricted-shell',
      name: 'Restricted shell',
      permission: {
        requested: 'approval_required',
        effective: 'deny',
        source: 'provider',
      },
    }),
  ])
  return { db, boardId, matrix, registry }
}

describe('provider-neutral tool capabilities', () => {
  it('keeps the four-provider matrix exact, complete, and fail-closed without real acceptance', () => {
    const matrix = buildDeclaredProviderCapabilityMatrix()
    expect(matrix.map((row) => row.provider_id)).toEqual(['claude', 'codex', 'qwen', 'kimi'])
    expect(matrix.every((row) => row.capabilities.length === 24)).toBe(true)
    expect(matrix.find((row) => row.provider_id === 'claude')).toMatchObject({
      release_state: 'unsupported',
      managed_support: 'policy_blocked',
      accepted_evidence: false,
      mode_support: 'policy_blocked',
    })
    expect(matrix.find((row) => row.provider_id === 'codex')).toMatchObject({
      release_state: 'candidate',
      managed_support: 'candidate',
      accepted_evidence: false,
    })
    expect(matrix.filter((row) => ['qwen', 'kimi'].includes(row.provider_id)))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ provider_id: 'qwen', managed_support: 'unsupported' }),
        expect.objectContaining({ provider_id: 'kimi', managed_support: 'unsupported' }),
      ]))
    expect(matrix.every((row) => row.blockers.includes('acceptance_evidence_missing'))).toBe(true)
  })

  it('normalizes CLI, MCP, plugin, skill, and native metadata without raw paths', () => {
    const { registry } = createDeclaredProviderToolRegistry({
      doctor: {
        schema_version: 2,
        contract_schema_version: 1,
        compatibility_schema_version: 1,
        checked_at: '2026-08-02T09:00:00.000Z',
        provider: 'both',
        mode: 'readiness',
        fail_closed: true,
        ready: false,
        status: 'unsupported',
        compatibility_ready: false,
        compatibility_status: 'unsupported',
        checks: [{
          id: 'codex_cli',
          label: 'Codex CLI',
          required: true,
          status: 'validated',
          actual: '0.144.6',
          expected: 'exactly 0.144.6',
          detail: 'validated',
          executable: {
            source: 'path',
            display: '<$PATH>/codex',
            path_fingerprint: 'sha256:0123456789abcdef',
          },
        }],
      },
    }, [
      { id: 'repo-mcp', name: 'Repository MCP', kind: 'mcp_server', status: 'validated' },
      { id: 'review-plugin', name: 'Review plugin', kind: 'plugin', status: 'experimental' },
      { id: 'test-skill', name: 'Test skill', kind: 'skill', status: 'validated' },
      { id: 'provider-hooks', name: 'Provider hooks', kind: 'native', status: 'unsupported' },
    ])

    expect(new Set(registry.list().map((tool) => tool.kind))).toEqual(new Set([
      'cli', 'mcp_server', 'plugin', 'skill', 'native',
    ]))
    const serialized = JSON.stringify(registry.list())
    expect(serialized).not.toContain('/Users/')
    expect(serialized).toContain('sha256:0123456789abcdef')
    registry.register(nativeTool())
    expect(() => registry.register(nativeTool())).toThrow(/already registered/)
    registry.synchronize([nativeTool({ id: 'native:replacement', name: 'Replacement' })])
    expect(registry.get('native:workspace-editor')).toBeNull()
    expect(registry.get('native:replacement')).toMatchObject({ name: 'Replacement' })
  })

  it('rejects mismatched doctor and executable discovery evidence', () => {
    const doctor = {
      schema_version: 2 as const,
      contract_schema_version: 1,
      compatibility_schema_version: 1 as const,
      checked_at: '2026-08-02T09:00:00.000Z',
      provider: 'codex' as const,
      mode: 'readiness' as const,
      fail_closed: true as const,
      ready: true,
      status: 'validated' as const,
      compatibility_ready: true,
      compatibility_status: 'validated' as const,
      checks: [{
        id: 'codex_cli', label: 'Codex CLI', required: true,
        status: 'validated' as const, actual: '0.144.6', expected: '0.144.6', detail: 'ok',
        executable: { source: 'path' as const, display: '<$PATH>/codex', path_fingerprint: 'sha256:0123456789abcdef' },
      }],
    }
    const mismatched = createDeclaredProviderToolRegistry({
      doctor,
      discoveries: {
        codex: {
          contract_version: 1,
          provider_id: 'codex',
          adapter_id: 'codex-app-server',
          status: 'validated',
          source: 'path',
          version: '0.145.0',
          platform: 'darwin-arm64',
          resolved_path: '/opt/codex/bin/codex',
          executable_fingerprint: `sha256:${'a'.repeat(64)}`,
        },
      },
    })
    expect(mismatched.matrix.find((row) => row.provider_id === 'codex'))
      .toMatchObject({ executable: { health: 'untrusted' } })

    const absent = createDeclaredProviderToolRegistry()
    expect(absent.matrix.every((row) =>
      row.blockers.some((blocker) => blocker.startsWith('executable_')))).toBe(true)
    expect(absent.registry.list().filter((tool) => tool.kind === 'cli')
      .every((tool) => tool.status !== 'ready')).toBe(true)

    const malformed = createDeclaredProviderToolRegistry({
      doctor: {
        ...doctor,
        checks: [{ ...doctor.checks[0], executable: undefined }],
      },
    })
    expect(malformed.matrix.find((row) => row.provider_id === 'codex'))
      .toMatchObject({ executable: { health: 'untrusted' } })
  })
})

describe('durable session tool policy and provenance', () => {
  it('routes approvals globally, detects drift, and withholds sensitive invocation content', () => {
    const { db, boardId, matrix, registry } = fixture()
    const service = new SessionToolService(db, registry, matrix)

    const initial = service.snapshot('session-tools')
    expect(initial.policy).toMatchObject({ revision: 0, default_decision: 'approval_required' })
    expect(initial.permission_drift).toEqual(expect.arrayContaining([
      expect.objectContaining({ tool_id: 'native:workspace-editor', status: 'more_permissive' }),
      expect.objectContaining({ tool_id: 'native:restricted-shell', status: 'more_restrictive' }),
    ]))

    const approval = service.requestInvocation('session-tools', {
      toolId: 'native:workspace-editor',
      actor: { type: 'agent', id: 'agent-1' },
      requestId: 'approval-1',
      idempotencyKey: 'authorize-approval-1',
    })
    expect(approval).toMatchObject({
      decision: 'approval_required',
      approval_request_id: 'approval-1',
      attention: { kind: 'tool.approval.request', severity: 'critical' },
    })
    const replayedApproval = service.requestInvocation('session-tools', {
      toolId: 'native:workspace-editor',
      actor: { type: 'agent', id: 'agent-1' },
      requestId: 'approval-1',
      idempotencyKey: 'authorize-approval-1',
    })
    expect(replayedApproval.approval_request_id).toBe('approval-1')
    expect(replayedApproval.attention?.id).toBe(approval.attention?.id)
    expect(service.snapshot('session-tools').approvals).toHaveLength(1)

    const policy = service.setPolicy('session-tools', {
      defaultDecision: 'deny',
      rules: [{ target: 'native:workspace-editor', decision: 'allow' }],
      expectedRevision: 0,
      actor: { type: 'human', id: 'operator' },
      idempotencyKey: 'policy-1',
    })
    expect(policy).toMatchObject({ revision: 1, default_decision: 'deny' })
    expect(service.setPolicy('session-tools', {
      defaultDecision: 'deny',
      rules: [{ target: 'native:workspace-editor', decision: 'allow' }],
      expectedRevision: 0,
      actor: { type: 'human', id: 'operator' },
      idempotencyKey: 'policy-1',
    })).toEqual(policy)
    expect(() => service.setPolicy('session-tools', {
      defaultDecision: 'allow',
      expectedRevision: 0,
      actor: { type: 'human', id: 'operator' },
      idempotencyKey: 'policy-stale',
    })).toThrow(/revision changed/)

    expect(service.requestInvocation('session-tools', {
      toolId: 'native:workspace-editor',
      actor: { type: 'agent', id: 'agent-1' },
      idempotencyKey: 'authorize-allow-1',
    })).toMatchObject({ decision: 'allow', attention: null })

    const invocationInput = {
      toolId: 'native:workspace-editor',
      status: 'completed' as const,
      arguments: { password: 'SECRET-SENTINEL', command: 'deploy' },
      providerCallId: 'provider-call-1',
      providerEventId: 'provider-event-1',
      actor: { type: 'agent', id: 'agent-1' },
      idempotencyKey: 'invocation-event-1',
    }
    const invocation = service.recordInvocation('session-tools', invocationInput)
    expect(invocation).toMatchObject({
      input_state: 'withheld',
      output_state: 'withheld',
      argument_count: 2,
    })
    expect(invocation.argument_digest).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(service.recordInvocation('session-tools', invocationInput)).toEqual(invocation)
    const durable = db.prepare(`SELECT payload FROM os_events WHERE board_id=?
      AND kind='session.tool_invocation.recorded'`).get(boardId) as { payload: string }
    expect(durable.payload).not.toContain('SECRET-SENTINEL')
    expect(durable.payload).not.toContain('deploy')

    const restarted = new SessionToolService(db, registry, matrix).snapshot('session-tools')
    expect(restarted.policy.revision).toBe(1)
    expect(restarted.invocations).toEqual([
      expect.objectContaining({ invocation_id: expect.stringMatching(/^tool-invocation-/) }),
    ])
    db.close()
  })

  it('does not infer terminal availability without executable evidence', () => {
    const { db, matrix } = fixture()
    const { registry } = createDeclaredProviderToolRegistry()
    const service = new SessionToolService(db, registry, matrix)
    const codex = service.snapshot('session-tools').tools.find((tool) =>
      tool.id === 'provider:codex:cli')!
    expect(codex.direct_terminal_available).toBe(false)
    expect(codex.managed_support).toBe('candidate')
    expect(service.requestInvocation('session-tools', {
      toolId: codex.id,
      actor: { type: 'agent', id: 'agent-1' },
      idempotencyKey: 'authorize-codex-unaccepted',
    })).toMatchObject({ decision: 'deny', attention: null })
    db.close()
  })
})
