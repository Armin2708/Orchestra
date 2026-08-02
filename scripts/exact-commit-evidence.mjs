#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { manifestContractBinding } from './exact-commit-contract.mjs'
import { verifyPackageSourceIdentity } from './package-source-identity.mjs'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const contractPath = join(scriptDirectory, 'exact-commit-ci-contract.json')
const shaPattern = /^[0-9a-f]{40}$/
const sha256Pattern = /^[0-9a-f]{64}$/
const gatePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const safeDetailKeys = new Set(['artifact_digest', 'artifact_id'])

export const readEvidenceContract = () =>
  JSON.parse(readFileSync(contractPath, 'utf8'))

const requireSha = (value, label) => {
  const normalized = String(value ?? '').trim().toLowerCase()
  if (!shaPattern.test(normalized)) {
    throw new Error(`${label} must be a full 40-character lowercase commit SHA`)
  }
  return normalized
}

const requireGateId = (value) => {
  const gateId = String(value ?? '').trim()
  if (!gatePattern.test(gateId)) {
    throw new Error(`invalid CI evidence gate id: ${JSON.stringify(value)}`)
  }
  return gateId
}

const evidenceDirectory = () => {
  const configured = process.env.CI_EVIDENCE_DIR?.trim()
  if (!configured) throw new Error('CI_EVIDENCE_DIR is required')
  return resolve(configured)
}

const evidenceSha = (override) =>
  requireSha(override ?? process.env.CI_EVIDENCE_SHA ?? process.env.GITHUB_SHA, 'CI evidence SHA')

const recordPath = (directory, gateId) => join(directory, 'records', `${gateId}.json`)

const writeJsonAtomic = (path, value) => {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  renameSync(temporary, path)
}

const runnerIdentity = () => ({
  platform: process.platform,
  arch: process.arch,
  runner_os: process.env.RUNNER_OS ?? null,
  runner_arch: process.env.RUNNER_ARCH ?? null,
  node_version: process.version.replace(/^v/, ''),
})

const initialRecord = ({ gateId, sha, startedAt, executable }) => ({
  schema_version: 1,
  commit_sha: sha,
  gate_id: gateId,
  status: 'running',
  exit_code: null,
  started_at: startedAt,
  completed_at: null,
  invocation: {
    executable: basename(executable),
  },
  runner: runnerIdentity(),
  details: {},
})

const completedRecord = (record, exitCode, details = {}) => ({
  ...record,
  status: exitCode === 0 ? 'passed' : 'failed',
  exit_code: exitCode,
  completed_at: new Date().toISOString(),
  details,
})

const waitForChild = (child) => new Promise((resolveExit) => {
  child.once('error', (error) => {
    console.error(error instanceof Error ? error.message : String(error))
    resolveExit(1)
  })
  child.once('exit', (code, signal) => {
    if (signal) console.error(`command terminated by signal ${signal}`)
    resolveExit(Number.isInteger(code) ? code : 1)
  })
})

export async function runEvidenceGate(gateIdInput, command, args) {
  const gateId = requireGateId(gateIdInput)
  if (!command) throw new Error(`gate ${gateId} requires a command`)
  const directory = evidenceDirectory()
  const sha = evidenceSha()
  const startedAt = new Date().toISOString()
  const record = initialRecord({ gateId, sha, startedAt, executable: command })
  const outputPath = recordPath(directory, gateId)
  writeJsonAtomic(outputPath, record)

  let exitCode = 1
  try {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: 'inherit',
    })
    exitCode = await waitForChild(child)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
  }

  writeJsonAtomic(outputPath, completedRecord(record, exitCode))
  return exitCode
}

export function verifyExactCommit(gateIdInput, expectedShaInput, cwdInput = process.cwd()) {
  const gateId = requireGateId(gateIdInput)
  const expectedSha = evidenceSha(expectedShaInput)
  const directory = evidenceDirectory()
  const startedAt = new Date().toISOString()
  const record = initialRecord({
    gateId,
    sha: expectedSha,
    startedAt,
    executable: 'git',
  })
  const outputPath = recordPath(directory, gateId)
  writeJsonAtomic(outputPath, record)

  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: cwdInput,
    encoding: 'utf8',
  })
  const observedSha = String(result.stdout ?? '').trim().toLowerCase()
  let sourceIdentity = null
  let sourceIdentityError = null
  if (result.status === 0 && observedSha === expectedSha) {
    try {
      sourceIdentity = verifyPackageSourceIdentity({ cwd: cwdInput, expectedSha })
    } catch (error) {
      sourceIdentityError = error instanceof Error ? error.message : String(error)
    }
  }
  const passed = result.status === 0 && observedSha === expectedSha && sourceIdentity !== null
  const details = {
    expected_sha: expectedSha,
    observed_sha: shaPattern.test(observedSha) ? observedSha : null,
    tracked_source_clean: sourceIdentity?.tracked_source_clean === true,
    source_identity_error: sourceIdentityError,
  }
  writeJsonAtomic(outputPath, completedRecord(record, passed ? 0 : 1, details))

  if (!passed) {
    console.error(
      sourceIdentityError ??
      `checkout mismatch: expected ${expectedSha}, observed ${observedSha || 'unavailable'}`,
    )
  } else {
    console.log(`exact checkout verified at ${expectedSha}`)
  }
  return passed ? 0 : 1
}

export function verifyToolchain(gateIdInput) {
  const gateId = requireGateId(gateIdInput)
  const contract = readEvidenceContract()
  const sha = evidenceSha()
  const directory = evidenceDirectory()
  const startedAt = new Date().toISOString()
  const record = initialRecord({
    gateId,
    sha,
    startedAt,
    executable: 'node',
  })
  const outputPath = recordPath(directory, gateId)
  writeJsonAtomic(outputPath, record)

  const npm = spawnSync('npm', ['--version'], { encoding: 'utf8' })
  const actualNode = process.version.replace(/^v/, '')
  const actualNpm = String(npm.stdout ?? '').trim()
  const passed =
    npm.status === 0 &&
    actualNode === contract.node_version &&
    actualNpm === contract.npm_version
  const details = {
    expected_node: contract.node_version,
    actual_node: actualNode,
    expected_npm: contract.npm_version,
    actual_npm: actualNpm || null,
  }
  writeJsonAtomic(outputPath, completedRecord(record, passed ? 0 : 1, details))

  if (!passed) {
    console.error(
      `toolchain mismatch: expected Node ${contract.node_version}/npm ${contract.npm_version}, ` +
      `observed Node ${actualNode}/npm ${actualNpm || 'unavailable'}`,
    )
  } else {
    console.log(`exact toolchain verified: Node ${actualNode}, npm ${actualNpm}`)
  }
  return passed ? 0 : 1
}

export function recordExternalGate(gateIdInput, outcomeInput, detailArguments = []) {
  const gateId = requireGateId(gateIdInput)
  const outcome = String(outcomeInput ?? '').trim().toLowerCase()
  const sha = evidenceSha()
  const now = new Date().toISOString()
  const details = {}
  for (const argument of detailArguments) {
    const separator = argument.indexOf('=')
    if (separator <= 0) throw new Error(`invalid external gate detail: ${argument}`)
    const key = argument.slice(0, separator)
    const value = argument.slice(separator + 1)
    if (!safeDetailKeys.has(key)) throw new Error(`external gate detail ${key} is not allowed`)
    if (value !== '') details[key] = value
  }
  const passed = outcome === 'success'
  const record = {
    schema_version: 1,
    commit_sha: sha,
    gate_id: gateId,
    status: passed ? 'passed' : 'failed',
    exit_code: passed ? 0 : 1,
    started_at: now,
    completed_at: now,
    invocation: { executable: 'github-action' },
    runner: runnerIdentity(),
    details: { action_outcome: outcome || 'unknown', ...details },
  }
  writeJsonAtomic(recordPath(evidenceDirectory(), gateId), record)
  return passed ? 0 : 1
}

const auditCounts = (report) => {
  const vulnerabilities = report?.metadata?.vulnerabilities
  if (!vulnerabilities || typeof vulnerabilities !== 'object') return null
  return {
    info: Number(vulnerabilities.info ?? 0),
    low: Number(vulnerabilities.low ?? 0),
    moderate: Number(vulnerabilities.moderate ?? 0),
    high: Number(vulnerabilities.high ?? 0),
    critical: Number(vulnerabilities.critical ?? 0),
    total: Number(vulnerabilities.total ?? 0),
  }
}

const moderatePackages = (report) =>
  Object.values(report?.vulnerabilities ?? {})
    .filter((vulnerability) => vulnerability?.severity === 'moderate')
    .map((vulnerability) => String(vulnerability.name))
    .sort()

export function runAuditGate(gateIdInput, prefix) {
  const gateId = requireGateId(gateIdInput)
  const contract = readEvidenceContract()
  const sha = evidenceSha()
  const directory = evidenceDirectory()
  const startedAt = new Date().toISOString()
  const record = initialRecord({
    gateId,
    sha,
    startedAt,
    executable: 'npm',
  })
  const outputPath = recordPath(directory, gateId)
  writeJsonAtomic(outputPath, record)

  const args = ['audit', '--json', '--audit-level=high']
  if (prefix) args.push('--prefix', prefix)
  const result = spawnSync('npm', args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
  let report = null
  try {
    report = JSON.parse(result.stdout || '{}')
  } catch {
    // A missing or malformed report is a failed audit gate; raw output is not retained.
  }
  const counts = auditCounts(report)
  const observedModerates = moderatePackages(report)
  const acceptedModerates = contract.accepted_moderate_packages_by_gate?.[gateId]
  const reviewedModeratesMatch =
    Array.isArray(acceptedModerates) &&
    JSON.stringify(observedModerates) === JSON.stringify([...acceptedModerates].sort())
  const passed =
    result.status === 0 &&
    counts !== null &&
    counts.high === 0 &&
    counts.critical === 0 &&
    reviewedModeratesMatch
  const details = {
    audit_level: 'high',
    dependency_scope: prefix || 'root',
    vulnerabilities: counts,
    moderate_packages: observedModerates,
    accepted_moderate_packages: acceptedModerates ?? null,
    reviewed_moderates_match: reviewedModeratesMatch,
  }
  writeJsonAtomic(outputPath, completedRecord(record, passed ? 0 : 1, details))

  if (counts) {
    console.log(
      `audit ${prefix || 'root'}: ${counts.low} low, ${counts.moderate} moderate, ` +
      `${counts.high} high, ${counts.critical} critical`,
    )
  }
  if (!passed) {
    const diagnostic = String(result.stderr ?? '').trim()
    if (!reviewedModeratesMatch) {
      console.error(
        `moderate dependency findings changed: expected ` +
        `${JSON.stringify(acceptedModerates ?? null)}, observed ${JSON.stringify(observedModerates)}`,
      )
    }
    console.error(diagnostic || `npm audit did not produce a passing reviewed report`)
  }
  return passed ? 0 : 1
}

const readRecords = (directory) => {
  const directoryPath = join(directory, 'records')
  try {
    return readdirSync(directoryPath)
      .filter((entry) => entry.endsWith('.json'))
      .sort()
      .map((entry) => JSON.parse(readFileSync(join(directoryPath, entry), 'utf8')))
  } catch {
    return []
  }
}

const readOptionalJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

export function createEvidenceManifest({
  contract,
  expectedSha,
  records,
  packageArtifact,
  generatedAt,
  workflowRun,
}) {
  const byGate = new Map(records.map((record) => [record.gate_id, record]))
  const orderedGates = contract.required_gates.map((gateId) => {
    const record = byGate.get(gateId)
    if (record) return record
    return {
      schema_version: 1,
      commit_sha: expectedSha,
      gate_id: gateId,
      status: 'missing',
      exit_code: null,
      started_at: null,
      completed_at: null,
      invocation: null,
      runner: null,
      details: {},
    }
  })
  const unexpectedGates = records
    .filter((record) => !contract.required_gates.includes(record.gate_id))
    .sort((left, right) => String(left.gate_id).localeCompare(String(right.gate_id)))
  const shaConsistent = records.every((record) => record.commit_sha === expectedSha)
  const packageConsistent =
    packageArtifact !== null &&
    packageArtifact.commit_sha === expectedSha &&
    sha256Pattern.test(String(packageArtifact.sha256 ?? '')) &&
    packageArtifact.install_smoke?.passed === true &&
    packageArtifact.install_smoke?.cli_version === packageArtifact.package_version &&
    packageArtifact.lifecycle?.local_rehearsal_passed === true &&
    packageArtifact.lifecycle?.release_gate?.status === 'passed' &&
    packageArtifact.lifecycle?.passed === true
  const requiredPassed = orderedGates.every((record) =>
    record.schema_version === 1 &&
    record.status === 'passed' &&
    record.exit_code === 0)
  const uploadGate = byGate.get('package-upload')
  const uploadEvidencePresent =
    uploadGate?.status === 'passed' &&
    sha256Pattern.test(String(uploadGate.details?.artifact_digest ?? '')) &&
    /^[1-9][0-9]*$/.test(String(uploadGate.details?.artifact_id ?? ''))
  const passed =
    requiredPassed &&
    shaConsistent &&
    packageConsistent &&
    uploadEvidencePresent &&
    unexpectedGates.length === 0

  return {
    schema_version: contract.schema_version,
    backlog_item: contract.backlog_item,
    commit_sha: expectedSha,
    generated_at: generatedAt,
    workflow_run: workflowRun,
    contract: manifestContractBinding(contract),
    result: passed ? 'passed' : 'failed',
    summary: {
      required: orderedGates.length,
      passed: orderedGates.filter((record) => record.status === 'passed').length,
      failed: orderedGates.filter((record) => record.status === 'failed').length,
      missing: orderedGates.filter((record) => record.status === 'missing').length,
      unexpected: unexpectedGates.length,
      sha_consistent: shaConsistent,
      package_consistent: packageConsistent,
      package_upload_evidence_present: uploadEvidencePresent,
    },
    gates: orderedGates,
    unexpected_gates: unexpectedGates,
    package_artifact: packageArtifact,
  }
}

export function finalizeEvidence(expectedShaInput) {
  const expectedSha = evidenceSha(expectedShaInput)
  const contract = readEvidenceContract()
  const directory = evidenceDirectory()
  const records = readRecords(directory)
  const packageArtifact = readOptionalJson(join(directory, 'package', 'package-metadata.json'))
  const manifest = createEvidenceManifest({
    contract,
    expectedSha,
    records,
    packageArtifact,
    generatedAt: new Date().toISOString(),
    workflowRun: {
      repository: process.env.GITHUB_REPOSITORY ?? null,
      event: process.env.GITHUB_EVENT_NAME ?? null,
      ref: process.env.GITHUB_REF ?? null,
      run_id: process.env.GITHUB_RUN_ID ?? null,
      run_attempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    },
  })
  writeJsonAtomic(join(directory, 'manifest.json'), manifest)
  console.log(
    `exact-commit evidence for ${expectedSha}: ${manifest.result} ` +
    `(${manifest.summary.passed}/${manifest.summary.required} required gates passed)`,
  )
  return manifest.result === 'passed' ? 0 : 1
}

const parseRunArguments = (args) => {
  const separator = args.indexOf('--')
  if (separator !== 1 || args.length < 3) {
    throw new Error('usage: exact-commit-evidence.mjs run <gate-id> -- <command> [args...]')
  }
  return {
    gateId: args[0],
    command: args[2],
    commandArgs: args.slice(3),
  }
}

async function main() {
  const [subcommand, ...args] = process.argv.slice(2)
  switch (subcommand) {
    case 'run': {
      const parsed = parseRunArguments(args)
      return runEvidenceGate(parsed.gateId, parsed.command, parsed.commandArgs)
    }
    case 'verify-commit':
      if (args.length !== 2) {
        throw new Error('usage: exact-commit-evidence.mjs verify-commit <gate-id> <sha>')
      }
      return verifyExactCommit(args[0], args[1])
    case 'verify-toolchain':
      if (args.length !== 1) {
        throw new Error('usage: exact-commit-evidence.mjs verify-toolchain <gate-id>')
      }
      return verifyToolchain(args[0])
    case 'record':
      if (args.length < 2) {
        throw new Error('usage: exact-commit-evidence.mjs record <gate-id> <outcome> [key=value...]')
      }
      return recordExternalGate(args[0], args[1], args.slice(2))
    case 'audit': {
      if (args.length !== 1 && !(args.length === 3 && args[1] === '--prefix')) {
        throw new Error('usage: exact-commit-evidence.mjs audit <gate-id> [--prefix <directory>]')
      }
      return runAuditGate(args[0], args[2])
    }
    case 'finalize':
      if (args.length !== 1) {
        throw new Error('usage: exact-commit-evidence.mjs finalize <sha>')
      }
      return finalizeEvidence(args[0])
    default:
      throw new Error(
        'usage: exact-commit-evidence.mjs ' +
        '<run|verify-commit|verify-toolchain|record|audit|finalize> ...',
      )
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
