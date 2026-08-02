import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { AgentToolControls } from '../web/src/AgentToolControls.js'
import type { SessionToolSnapshot } from '../web/src/agentToolApi.js'

const requireFromWeb = createRequire(new URL('../web/package.json', import.meta.url))
const React = requireFromWeb('react') as typeof import('react')
const { renderToStaticMarkup } = requireFromWeb('react-dom/server') as {
  renderToStaticMarkup: (node: unknown) => string
}

const snapshot: SessionToolSnapshot = {
  schema_version: 1,
  session: {
    id: 'session-1', provider: 'codex', workspace_id: 'workspace-1', board_id: 1,
    mode: 'managed', access_profile: 'workspace_write',
  },
  provider: {
    provider_id: 'codex', display_name: 'Codex CLI', adapter_id: 'codex-app-server',
    adapter_version: '1.0.0', release_state: 'candidate', mode_id: 'native_subscription',
    billing_mode: 'personal_subscription', managed_support: 'candidate',
    accepted_evidence: false, blockers: ['acceptance_evidence_missing'],
  },
  policy: {
    schema_version: 1, session_id: 'session-1', revision: 0,
    default_decision: 'approval_required', rules: [], updated_by: 'system', updated_at: null,
  },
  tools: [{
    schema_version: 1, id: 'provider:codex:cli', name: 'Codex CLI', kind: 'cli',
    provider_id: 'codex', session_id: null, status: 'degraded', managed_support: 'candidate',
    direct_terminal_available: true, capabilities: ['launch'],
    permission: { requested: 'approval_required', effective: 'unknown', source: 'default_closed' },
    provenance: {
      evidence: 'observed', observed_at: '2026-08-02T10:00:00.000Z',
      executable: {
        source: 'path', version: '0.144.6', platform: 'darwin-arm64', health: 'validated',
        path_fingerprint: 'sha256:0123456789abcdef', executable_fingerprint: null,
      },
      package: null, provider_native_id: 'codex-app-server',
    },
    error: { code: 'acceptance_evidence_missing', detail: 'acceptance_evidence_missing' },
  }],
  permission_drift: [{
    tool_id: 'provider:codex:cli', requested: 'approval_required', effective: 'unknown',
    status: 'unknown', reason: 'effective provider permission is unavailable',
  }],
  invocations: [],
  approvals: [{
    id: 'attention-1', kind: 'tool.approval.request', severity: 'critical',
    title: 'Tool approval needed: Codex CLI', detail: '{}', status: 'open',
  }],
  direct_terminal_is_source_of_truth: true,
}

describe('AgentToolControls', () => {
  it('renders support truth, policy controls, drift, approval routing, and privacy state', () => {
    const markup = renderToStaticMarkup(React.createElement(AgentToolControls, {
      snapshot,
      onPolicyChange: () => {},
    }))
    expect(markup).toContain('Direct terminal remains the source of truth')
    expect(markup).toContain('Managed unavailable · terminal available')
    expect(markup).toContain('Acceptance evidence missing')
    expect(markup).toContain('Codex CLI session policy')
    expect(markup).toContain('Ask every time')
    expect(markup).toContain('routed to Needs You')
    expect(markup).toContain('Inputs and outputs stay withheld')
    expect(markup).not.toContain('/Users/')
  })
})
