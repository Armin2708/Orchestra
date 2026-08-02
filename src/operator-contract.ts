export const ORCHESTRA_OPERATOR_CONTRACT_V1 = Object.freeze({
  contract_version: 1,
  http_api: {
    prefix: '/api/v1',
    compatibility: 'additive_within_v1',
  },
  agent_os_http_api: {
    prefix: '/api/v1/os',
    compatibility: 'additive_within_v1',
  },
  causal_events: {
    schema_version: 1,
    required_metadata: ['kind', 'actor_type', 'correlation_id', 'causation_id'],
  },
  first_run_config: {
    schema_version: 1,
    unknown_major_behavior: 'fail_closed',
  },
  provider_contract: {
    contract_version: 1,
    support_claim: 'exact_tuple_and_eight_gate_evidence',
  },
  database: {
    migration_policy: 'forward_only',
    downgrade_policy: 'offline_verified_backup_restore_only',
  },
} as const)

export const checkOperatorContractCompatibility = (candidate: {
  contract_version: number
  first_run_schema_version: number
  provider_contract_version: number
}): { compatible: boolean; blockers: string[] } => {
  const blockers: string[] = []
  if (candidate.contract_version !== ORCHESTRA_OPERATOR_CONTRACT_V1.contract_version) {
    blockers.push('operator_contract_major_mismatch')
  }
  if (candidate.first_run_schema_version
    !== ORCHESTRA_OPERATOR_CONTRACT_V1.first_run_config.schema_version) {
    blockers.push('first_run_schema_mismatch')
  }
  if (candidate.provider_contract_version
    !== ORCHESTRA_OPERATOR_CONTRACT_V1.provider_contract.contract_version) {
    blockers.push('provider_contract_mismatch')
  }
  return { compatible: blockers.length === 0, blockers }
}
