#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
export const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, '..')
export const DEFAULT_MATRIX = path.join(DEFAULT_ROOT, 'docs/quality/beta-quality-matrix.json')
export const DEFAULT_REQUIREMENTS = path.join(DEFAULT_ROOT, 'docs/quality/beta-quality-requirements.json')
export const DEFAULT_EVIDENCE_SCHEMA = path.join(DEFAULT_ROOT, 'docs/quality/beta-quality-evidence.schema.json')

// These are intentionally independent of the JSON files. Changing either contract requires an
// explicit reviewed code change and new evasion tests, not a self-authorized JSON edit.
export const PINNED_REQUIREMENTS_SHA256 = '1f6e4225416dc4da744762f8b7a3e40a102a4a05f4c68d9b7a8dd5f2f36b805d'
export const PINNED_EVIDENCE_SCHEMA_SHA256 = '4cb7ce58e0496c7428c903d02a6ac67b9dd43878b820d8e42842e4169b60748b'

const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))
const repoRelative = (root, file) => path.relative(root, file).split(path.sep).join('/')
const exactKeys = (value, expected) => value && typeof value === 'object' && !Array.isArray(value)
  && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort())

const walk = (directory) => {
  if (!fs.existsSync(directory)) return []
  const files = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...walk(candidate))
    else if (entry.isFile() && /\.(?:[cm]?[jt]s|sql)$/u.test(entry.name)) files.push(candidate)
  }
  return files.sort()
}

const STATE_MACHINE_PATTERNS = [
  /\b(?:type|interface)\s+[A-Za-z0-9_]*(?:State|Status)\b/u,
  /\b(?:export\s+)?const\s+[A-Z0-9_]*(?:STATES|STATUSES|TRANSITIONS)\b/u,
  /\bclass\s+[A-Za-z0-9_]*(?:StateMachine|Supervisor|Lifecycle)\b/u,
  /\b(?:async\s+)?[A-Za-z0-9_]*(?:transition|Transition)[A-Za-z0-9_]*\s*\(/u,
  /CREATE\s+TRIGGER\s+[A-Za-z0-9_]*transition/iu,
  /invalid\s+[A-Za-z0-9 _-]*transition/iu,
  /cannot\s+transition\s+from/iu,
]

export function discoverStateMachineCandidates(root = DEFAULT_ROOT) {
  const candidates = []
  for (const file of walk(path.join(root, 'src'))) {
    const content = fs.readFileSync(file, 'utf8')
    for (const [index, pattern] of STATE_MACHINE_PATTERNS.entries()) {
      const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`
      for (const match of content.matchAll(new RegExp(pattern.source, flags))) {
        candidates.push(`${repoRelative(root, file)}#${index}#${match[0].replace(/\s+/gu, ' ').trim()}`)
      }
    }
  }
  return [...new Set(candidates)].sort()
}

export function discoverStateMachineFiles(root = DEFAULT_ROOT) {
  return [...new Set(discoverStateMachineCandidates(root).map((candidate) =>
    candidate.slice(0, candidate.indexOf('#'))))].sort()
}

export const stateMachineDiscoveryDigest = (root = DEFAULT_ROOT) =>
  sha256(Buffer.from(`${discoverStateMachineCandidates(root).join('\n')}\n`))

const gitFileSha256 = (root, commit, file) => sha256(execFileSync(
  'git', ['show', `${commit}:${file}`], { cwd: root, maxBuffer: 32 * 1024 * 1024 },
))

const validateEvidenceReport = ({ root, reportPath, requirements, requirementKeys, errors }) => {
  if (!reportPath) {
    errors.push('release mode requires --evidence-report')
    return
  }
  const absoluteReport = path.resolve(reportPath)
  if (!fs.existsSync(absoluteReport)) {
    errors.push(`missing evidence report: ${reportPath}`)
    return
  }
  const report = readJson(absoluteReport)
  const topLevelKeys = ['schema_version', 'tested_commit', 'requirements_sha256', 'schema_sha256', 'artifacts', 'commands', 'case_results', 'tool_reports']
  if (!globalThis.Object || !Array.isArray(report.artifacts) || !Array.isArray(report.commands)
    || !Array.isArray(report.case_results) || !topLevelKeys.every((key) => Object.hasOwn(report, key))
    || Object.keys(report).some((key) => !topLevelKeys.includes(key))) errors.push('evidence report has missing or unknown top-level fields')
  if (report.schema_version !== 1 || report.artifacts.length === 0 || report.commands.length === 0 || report.case_results.length === 0) errors.push('evidence report schema/version arrays are empty or invalid')
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  if (!/^[0-9a-f]{40}$/u.test(report.tested_commit ?? '') || report.tested_commit !== head) errors.push('evidence report is not bound to exact HEAD')
  if (report.requirements_sha256 !== PINNED_REQUIREMENTS_SHA256) errors.push('evidence report requirements digest mismatch')
  if (report.schema_sha256 !== PINNED_EVIDENCE_SCHEMA_SHA256) errors.push('evidence report schema digest mismatch')

  const artifacts = new Map()
  for (const artifact of Array.isArray(report.artifacts) ? report.artifacts : []) {
    if (!exactKeys(artifact, ['path', 'sha256']) || !artifact?.path || !/^[0-9a-f]{64}$/u.test(artifact.sha256 ?? '') || artifacts.has(artifact.path)) {
      errors.push('evidence report contains invalid or duplicate artifacts')
      continue
    }
    artifacts.set(artifact.path, artifact.sha256)
  }
  for (const artifactPath of requirements.artifact_paths) {
    if (!artifacts.has(artifactPath)) errors.push(`evidence report missing artifact ${artifactPath}`)
    else if (gitFileSha256(root, report.tested_commit, artifactPath) !== artifacts.get(artifactPath)) errors.push(`artifact digest mismatch: ${artifactPath}`)
  }

  const commands = new Map()
  for (const command of Array.isArray(report.commands) ? report.commands : []) {
    if (!exactKeys(command, ['id', 'argv', 'exit_code', 'log_path', 'log_sha256', 'test_files', 'tests', 'failed']) || !command?.id || commands.has(command.id)) { errors.push('evidence report contains invalid or duplicate commands'); continue }
    const expected = requirements.commands[command.id]
    if (!expected || JSON.stringify(command.argv) !== JSON.stringify(expected)) errors.push(`unknown or altered command ${command.id}`)
    const log = path.resolve(path.dirname(absoluteReport), command.log_path ?? '')
    if (!command.log_path || !fs.existsSync(log) || sha256(fs.readFileSync(log)) !== command.log_sha256) {
      errors.push(`missing or altered command log ${command.id}`)
    } else {
      try {
        const observed = readJson(log)
        if (observed.success !== true || observed.numFailedTests !== 0
          || observed.numTotalTestSuites !== command.test_files
          || observed.numTotalTests !== command.tests) errors.push(`command ${command.id} result does not match its Vitest JSON artifact`)
      } catch {
        errors.push(`command ${command.id} log is not machine-verifiable Vitest JSON`)
      }
    }
    if (command.exit_code !== 0 || command.failed !== 0 || !Number.isInteger(command.tests) || command.tests < 1 || !Number.isInteger(command.test_files) || command.test_files < 1) errors.push(`command ${command.id} has no passing executed test result`)
    if (expected) {
      const rerun = spawnSync(expected[0], expected.slice(1), {
        cwd: root,
        encoding: 'utf8',
        env: process.env,
        maxBuffer: 64 * 1024 * 1024,
      })
      try {
        const observed = JSON.parse(rerun.stdout ?? '')
        if (rerun.status !== 0 || observed.success !== true || observed.numFailedTests !== 0
          || observed.numTotalTestSuites !== command.test_files
          || observed.numTotalTests !== command.tests) errors.push(`release rerun did not reproduce command ${command.id}`)
      } catch {
        errors.push(`release rerun did not produce machine-verifiable Vitest JSON for ${command.id}`)
      }
    }
    commands.set(command.id, command)
  }

  const results = new Map()
  for (const result of Array.isArray(report.case_results) ? report.case_results : []) {
    const key = `${result?.item}/${result?.case}`
    if (!exactKeys(result, ['item', 'case', 'command_ids', 'status']) || !requirementKeys.has(key) || results.has(key) || result.status !== 'passed' || !Array.isArray(result.command_ids) || result.command_ids.length === 0) {
      errors.push(`invalid, unknown, or duplicate case result ${key}`)
      continue
    }
    const declared = requirements._matrix.get(key).command_ids
    if (JSON.stringify(result.command_ids) !== JSON.stringify(declared) || result.command_ids.some((id) => !commands.has(id))) errors.push(`case result command binding mismatch ${key}`)
    results.set(key, result)
  }
  for (const key of requirementKeys) if (!results.has(key)) errors.push(`release evidence missing required case ${key}`)

  for (const tool of ['gitnexus', 'graphify']) {
    const entry = report.tool_reports?.[tool]
    const file = path.resolve(path.dirname(absoluteReport), entry?.path ?? '')
    if (!exactKeys(entry, ['tested_commit', 'path', 'sha256']) || !entry?.path || entry.tested_commit !== head || !fs.existsSync(file) || sha256(fs.readFileSync(file)) !== entry.sha256) {
      errors.push(`missing, altered, or non-exact ${tool} report`)
      continue
    }
    try {
      const toolReport = readJson(file)
      if (!exactKeys(toolReport, ['tool', 'tested_commit', 'result', 'result_sha256'])
        || toolReport.tool !== tool || toolReport.tested_commit !== head
        || toolReport.result === null || typeof toolReport.result !== 'object'
        || sha256(Buffer.from(JSON.stringify(toolReport.result))) !== toolReport.result_sha256) {
        errors.push(`invalid machine-verifiable ${tool} report payload`)
      }
    } catch {
      errors.push(`invalid machine-verifiable ${tool} report payload`)
    }
  }
}

export function evaluateBetaQualityMatrix({
  root = DEFAULT_ROOT,
  matrixPath = DEFAULT_MATRIX,
  requirementsPath = DEFAULT_REQUIREMENTS,
  schemaPath = DEFAULT_EVIDENCE_SCHEMA,
  mode = 'current-base',
  evidenceReport = null,
} = {}) {
  if (!['current-base', 'release'].includes(mode)) throw new Error(`unknown matrix mode: ${mode}`)
  const errors = []
  const requirementsBytes = fs.readFileSync(requirementsPath)
  const schemaBytes = fs.readFileSync(schemaPath)
  if (sha256(requirementsBytes) !== PINNED_REQUIREMENTS_SHA256) errors.push('requirements manifest digest differs from the pinned immutable digest')
  if (sha256(schemaBytes) !== PINNED_EVIDENCE_SCHEMA_SHA256) errors.push('evidence schema digest differs from the pinned immutable digest')
  const requirements = JSON.parse(requirementsBytes)
  const matrix = readJson(matrixPath)
  if (!exactKeys(requirements, ['schema_version', 'allowed_items', 'allowed_statuses', 'required_cases', 'required_statuses', 'commands', 'future_command_ids', 'artifact_paths', 'classified_state_machine_files', 'state_machine_discovery_sha256'])
    || requirements.schema_version !== 1
    || !Array.isArray(requirements.allowed_items) || requirements.allowed_items.length === 0
    || !Array.isArray(requirements.required_cases) || requirements.required_cases.length === 0
    || !Array.isArray(requirements.artifact_paths) || requirements.artifact_paths.length === 0
    || !Array.isArray(requirements.classified_state_machine_files) || requirements.classified_state_machine_files.length === 0) errors.push('requirements manifest schema/required arrays are empty or invalid')
  if (matrix.schema_version !== 2 || !Array.isArray(matrix.requirements) || matrix.requirements.length === 0) errors.push('matrix schema is invalid or empty')
  const requirementKeys = new Set(requirements.required_cases)
  const matrixKeys = new Set()
  const matrixMap = new Map()
  for (const entry of matrix.requirements ?? []) {
    const key = `${entry?.item}/${entry?.case}`
    const exact = ['case', 'command_ids', 'item', ...(entry.status === 'lane-dependent' ? ['lane'] : []), 'status'].sort()
    if (JSON.stringify(Object.keys(entry ?? {}).sort()) !== JSON.stringify(exact)) errors.push(`${key}: missing or unknown fields`)
    if (!requirementKeys.has(key) || matrixKeys.has(key)) errors.push(`${key}: unknown or duplicate case`)
    if (!requirements.allowed_items.includes(entry.item) || !requirements.allowed_statuses.includes(entry.status) || entry.status === 'covered') errors.push(`${key}: item/status is not allowed`)
    const requiredStatus = requirements.required_statuses[key] ?? 'prerequisite'
    if (entry.status !== requiredStatus) errors.push(`${key}: status differs from immutable requirement ${requiredStatus}`)
    if (!Array.isArray(entry.command_ids) || entry.command_ids.length === 0 || entry.command_ids.some((id) => !requirements.commands[id] && !requirements.future_command_ids.includes(id))) errors.push(`${key}: command binding is empty or unknown`)
    if (entry.status === 'lane-dependent' && !['A', 'B', 'C', 'D'].includes(entry.lane)) errors.push(`${key}: lane is missing or invalid`)
    matrixKeys.add(key)
    matrixMap.set(key, entry)
  }
  for (const key of requirementKeys) if (!matrixKeys.has(key)) errors.push(`matrix is missing required case ${key}`)
  for (const item of requirements.allowed_items) if (![...matrixKeys].some((key) => key.startsWith(`${item}/`))) errors.push(`matrix is missing required item ${item}`)
  for (const [id, argv] of Object.entries(requirements.commands)) if (!Array.isArray(argv) || argv.length === 0 || argv.some((value) => typeof value !== 'string' || value.length === 0)) errors.push(`command ${id} is empty`)
  for (const file of requirements.artifact_paths) if (!file || !fs.existsSync(path.join(root, file))) errors.push(`required artifact path is empty or missing: ${file}`)

  const discovered = discoverStateMachineFiles(root)
  const discoveryDigest = stateMachineDiscoveryDigest(root)
  if (requirements.state_machine_discovery_sha256 !== discoveryDigest) errors.push('state-machine discovery digest changed; candidates are missing classification review')
  const classified = new Set(requirements.classified_state_machine_files)
  for (const file of discovered) if (!classified.has(file)) errors.push(`unclassified state-machine candidate: ${file}`)
  for (const file of classified) if (!discovered.includes(file)) errors.push(`classified state-machine file no longer contains a discoverable candidate: ${file}`)

  requirements._matrix = matrixMap
  if (mode === 'release') {
    const trackedDirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root, encoding: 'utf8' }).trim()
    if (trackedDirty) errors.push('release evidence cannot validate a dirty tracked worktree')
    validateEvidenceReport({ root, reportPath: evidenceReport, requirements, requirementKeys, errors })
  }
  const unresolved = [...matrixMap.values()].map((entry) => ({ item: entry.item, case: entry.case, status: entry.status, lane: entry.lane ?? null }))
  return { ok: errors.length === 0, mode, errors, unresolved, discovered, discovery_digest: discoveryDigest }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  if (process.argv.includes('--discover')) {
    process.stdout.write(`${JSON.stringify(discoverStateMachineFiles(), null, 2)}\n`)
  } else {
    const modeIndex = process.argv.indexOf('--mode')
    const evidenceIndex = process.argv.indexOf('--evidence-report')
    const result = evaluateBetaQualityMatrix({
      mode: modeIndex === -1 ? 'release' : process.argv[modeIndex + 1],
      evidenceReport: evidenceIndex === -1 ? null : process.argv[evidenceIndex + 1],
    })
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    process.exitCode = result.ok ? 0 : 1
  }
}
