export type OrchestrationLifecycle = 'canonical' | 'legacy' | 'ambient' | 'external'

export interface OrchestrationIdentity {
  lifecycle: OrchestrationLifecycle
  contract_attached: boolean
  job_id: string | null
  workspace_id: string | null
  session_id: string | null
  job_assignment_id: string | null
  assigned_profile_id: string | null
  assignment_market_version: number | null
  assignment_id?: string | null
  workspace_assignment_id?: string | null
  contract_id?: string | null
  contract_version?: number | null
  correlation_id?: string | null
  idempotency_key?: string | null
}

export interface OrchestrationIdentitySource {
  contract?: { card_id?: number | null; version?: number | null } | null
  job?: {
    id?: string | null
    workspace_id?: string | null
    contract_version?: number | null
    idempotency_key?: string | null
    job_assignment_id?: string | null
    assigned_profile_id?: string | null
    assignment_market_version?: number | null
  } | null
  workspace?: { id?: string | null } | null
  session?: {
    id?: string | null
    workspace_assignment_id?: string | null
    context?: Record<string, unknown> | null
  } | null
}

/** Stable, additive identity metadata shared by canonical and compatibility entrypoints. */
export function orchestrationIdentity(
  lifecycle: OrchestrationLifecycle,
  source: OrchestrationIdentitySource = {},
): OrchestrationIdentity {
  const identity: OrchestrationIdentity = {
    lifecycle,
    contract_attached: lifecycle === 'canonical',
    job_id: source.job?.id ?? null,
    workspace_id: source.workspace?.id ?? source.job?.workspace_id ?? null,
    session_id: source.session?.id ?? null,
    job_assignment_id: source.job?.job_assignment_id ?? null,
    assigned_profile_id: source.job?.assigned_profile_id ?? null,
    assignment_market_version: source.job?.assignment_market_version ?? null,
  }
  if (lifecycle !== 'canonical' || !source.contract) return identity
  const contractVersion = source.job?.contract_version ?? source.contract.version ?? null
  const cardId = source.contract.card_id
  const workspaceAssignmentId = typeof source.session?.workspace_assignment_id === 'string'
    && source.session.workspace_assignment_id.trim()
    ? source.session.workspace_assignment_id.trim()
    : null
  return {
    ...identity,
    assignment_id: workspaceAssignmentId,
    workspace_assignment_id: workspaceAssignmentId,
    contract_id: cardId && contractVersion ? `card:${cardId}:v${contractVersion}` : null,
    contract_version: contractVersion,
    correlation_id: typeof source.session?.context?.correlation_id === 'string'
      ? source.session.context.correlation_id : null,
    idempotency_key: source.job?.idempotency_key ?? null,
  }
}
