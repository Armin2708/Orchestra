import { api } from './api'

export type ToolPolicyDecision = 'allow' | 'approval_required' | 'deny'
export type ToolCapabilityKind = 'cli' | 'mcp_server' | 'plugin' | 'skill' | 'native'

export type SessionToolPolicyRule = {
  target: string
  decision: ToolPolicyDecision
}

export type SessionToolPolicy = {
  schema_version: 1
  session_id: string
  revision: number
  default_decision: ToolPolicyDecision
  rules: SessionToolPolicyRule[]
  updated_by: string
  updated_at: string | null
}

export type SessionToolCapability = {
  schema_version: 1
  id: string
  name: string
  kind: ToolCapabilityKind
  provider_id: string | null
  session_id: string | null
  status: 'ready' | 'degraded' | 'unavailable' | 'unsupported' | 'unknown'
  managed_support: 'supported' | 'candidate' | 'policy_blocked' | 'unsupported' | 'unknown'
  direct_terminal_available: boolean
  capabilities: string[]
  permission: {
    requested: ToolPolicyDecision
    effective: ToolPolicyDecision | 'unknown'
    source: string
  }
  provenance: {
    evidence: 'observed' | 'declared' | 'unknown'
    observed_at: string | null
    executable: {
      source: string
      version: string | null
      platform: string | null
      health: string
      path_fingerprint: string | null
      executable_fingerprint: string | null
    } | null
    package: {
      package_id: string
      version: string | null
      source: string
    } | null
    provider_native_id: string | null
  }
  error: { code: string; detail: string } | null
}

export type SessionToolSnapshot = {
  schema_version: 1
  session: {
    id: string
    provider: string
    workspace_id: string
    board_id: number
    mode: string
    access_profile: string | null
  }
  provider: {
    provider_id: string
    display_name: string
    adapter_id: string
    adapter_version: string
    release_state: string
    mode_id: string
    billing_mode: string
    managed_support: string
    accepted_evidence: boolean
    blockers: string[]
  } | null
  policy: SessionToolPolicy
  tools: SessionToolCapability[]
  permission_drift: Array<{
    tool_id: string
    requested: ToolPolicyDecision
    effective: ToolPolicyDecision | 'unknown'
    status: 'aligned' | 'unknown' | 'more_restrictive' | 'more_permissive'
    reason: string
  }>
  invocations: Array<{
    invocation_id: string
    tool_id: string
    status: string
    argument_digest: string | null
    input_state: 'withheld'
    output_state: 'withheld'
    error_code: string | null
    observed_at: string
  }>
  approvals: Array<{
    id: string
    kind: string
    severity: string
    title: string
    detail: string
    status: string
  }>
  direct_terminal_is_source_of_truth: true
}

const requestKey = (scope: string): string =>
  `session-tools:${scope}:${globalThis.crypto?.randomUUID?.() ?? Date.now()}`

export const agentToolApi = {
  async getSessionTools(sessionId: string): Promise<SessionToolSnapshot> {
    const raw = await api('GET', `/os/sessions/${encodeURIComponent(sessionId)}/tools`) as {
      tools: SessionToolSnapshot
    }
    return raw.tools
  },

  async updatePolicy(
    sessionId: string,
    policy: Pick<SessionToolPolicy, 'default_decision' | 'rules' | 'revision'>,
  ): Promise<SessionToolPolicy> {
    const raw = await api(
      'PUT',
      `/os/sessions/${encodeURIComponent(sessionId)}/tools/policy`,
      {
        default_decision: policy.default_decision,
        rules: policy.rules,
        expected_revision: policy.revision,
        idempotency_key: requestKey(`policy:${sessionId}`),
      },
    ) as { policy: SessionToolPolicy }
    return raw.policy
  },

  async authorize(sessionId: string, toolId: string): Promise<{
    decision: ToolPolicyDecision
    reason: string
    approval_request_id: string | null
  }> {
    const raw = await api(
      'POST',
      `/os/sessions/${encodeURIComponent(sessionId)}/tools/authorize`,
      {
        tool_id: toolId,
        idempotency_key: requestKey(`authorize:${sessionId}:${toolId}`),
      },
    ) as { authorization: {
      decision: ToolPolicyDecision
      reason: string
      approval_request_id: string | null
    } }
    return raw.authorization
  },
}
