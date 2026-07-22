export type OrchestrationLifecycle = 'canonical' | 'legacy' | 'ambient' | 'external'

export interface OrchestrationIdentity {
  lifecycle: OrchestrationLifecycle
  contract_attached: boolean
  job_id: string | null
  workspace_id: string | null
  session_id: string | null
}

export interface OrchestrationIdentitySource {
  job?: { id?: string | null; workspace_id?: string | null } | null
  workspace?: { id?: string | null } | null
  session?: { id?: string | null } | null
}

/** Stable, additive identity metadata shared by canonical and compatibility entrypoints. */
export function orchestrationIdentity(
  lifecycle: OrchestrationLifecycle,
  source: OrchestrationIdentitySource = {},
): OrchestrationIdentity {
  return {
    lifecycle,
    contract_attached: lifecycle === 'canonical',
    job_id: source.job?.id ?? null,
    workspace_id: source.workspace?.id ?? source.job?.workspace_id ?? null,
    session_id: source.session?.id ?? null,
  }
}
