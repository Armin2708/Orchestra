import { createHash } from 'node:crypto'

export const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    )
  }
  return value
}

export const canonicalJson = (value) => JSON.stringify(canonicalize(value))

export const contractSha256 = (contract) =>
  createHash('sha256').update(canonicalJson(contract)).digest('hex')

export const manifestContractBinding = (contract) => ({
  contract_schema_version: contract.schema_version,
  contract_sha256: contractSha256(contract),
  workflow: contract.workflow,
  runner: contract.runner,
  node_version: contract.node_version,
  npm_version: contract.npm_version,
  codex_cli_version: contract.codex_cli_version,
  artifact_retention_days: contract.artifact_retention_days,
  accepted_moderate_packages_by_gate: contract.accepted_moderate_packages_by_gate,
  action_pins: contract.action_pins,
  required_gates: contract.required_gates,
})
