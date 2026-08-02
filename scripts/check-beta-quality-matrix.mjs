#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Ajv2020 from 'ajv/dist/2020.js'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
export const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, '..')
export const DEFAULT_MATRIX = path.join(DEFAULT_ROOT, 'docs/quality/beta-quality-matrix.json')
export const DEFAULT_REQUIREMENTS = path.join(DEFAULT_ROOT, 'docs/quality/beta-quality-requirements.json')
export const DEFAULT_EVIDENCE_SCHEMA = path.join(DEFAULT_ROOT, 'docs/quality/beta-quality-evidence.schema.json')
export const DEFAULT_TOOL_EVIDENCE_SCHEMA = path.join(DEFAULT_ROOT, 'docs/quality/beta-quality-tool-evidence.schema.json')

// These are intentionally independent of the JSON files. Changing either contract requires an
// explicit reviewed code change and new evasion tests, not a self-authorized JSON edit.
export const PINNED_REQUIREMENTS_SHA256 = '3c5ede5607da020d12c36d9a6686cceee2f617dd5e7a2cf4d24e71ed64ce1b85'
export const PINNED_MATRIX_SHA256 = 'd5ee8665bf1f1512e89e9f9edf961e7e864a65497768659c0edbbce79676adb4'
export const PINNED_EVIDENCE_SCHEMA_SHA256 = '911f14bab9cb2527b75639288cc6c46283f69f2a2bf4f29ecb6496c86edb51c7'
export const PINNED_TOOL_EVIDENCE_SCHEMA_SHA256 = '8cf98e6bd6a8b521a06735397fa68ecaf21242fcc7df4fe82e4fc4a2af889809'

const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))
const repoRelative = (root, file) => path.relative(root, file).split(path.sep).join('/')
const exactKeys = (value, expected) => value && typeof value === 'object' && !Array.isArray(value)
  && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort())
const resolveInside = (directory, relative) => {
  if (typeof relative !== 'string' || relative.length === 0 || path.isAbsolute(relative)) return null
  const absolute = path.resolve(directory, relative)
  const base = fs.existsSync(directory) ? fs.realpathSync(directory) : path.resolve(directory)
  const candidate = fs.existsSync(absolute) ? fs.realpathSync(absolute) : absolute
  const resolved = path.relative(base, candidate)
  return resolved && !resolved.startsWith('..') && !path.isAbsolute(resolved) ? candidate : null
}
const validateWithSchema = (schema, value, label, errors) => {
  try {
    const ajv = new Ajv2020({ allErrors: true, strict: false })
    const validate = ajv.compile(schema)
    const valid = validate(value)
    if (!valid) errors.push(`${label} schema validation failed: ${ajv.errorsText(validate.errors, { separator: '; ' })}`)
    return valid
  } catch (error) {
    errors.push(`${label} schema validation failed: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

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
  /\b(?:type|interface|enum)\s+[A-Za-z0-9_]*(?:State|Status)\b/u,
  /\b(?:export\s+)?const\s+[A-Za-z0-9_]*(?:States|Statuses|Transitions|STATES|STATUSES|TRANSITIONS)\b/u,
  /\bclass\s+[A-Za-z0-9_]*(?:StateMachine|Supervisor|Lifecycle|Workflow)\b/u,
  /\b(?:async\s+)?[A-Za-z0-9_]*(?:transition|Transition)[A-Za-z0-9_]*\s*\(/u,
  /CREATE\s+TRIGGER\s+[A-Za-z0-9_]*transition/iu,
  /invalid\s+[A-Za-z0-9 _-]*transition/iu,
  /cannot\s+transition\s+from/iu,
  /\b(?:const|let)\s+[A-Za-z0-9_]*(?:transition|Transition|setStatus|setState)[A-Za-z0-9_]*\s*=\s*(?:async\s*)?\(/u,
  /\b(?:setStatus|setState)\s*\(/u,
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

const validateEvidenceReport = ({ root, reportPath, requirements, requirementKeys, evidenceSchema, toolSchema, errors }) => {
  if (!reportPath) {
    errors.push('release mode requires --evidence-report')
    return
  }
  const absoluteReport = path.resolve(reportPath)
  if (!fs.existsSync(absoluteReport)) {
    errors.push(`missing evidence report: ${reportPath}`)
    return
  }
  let report
  try { report = readJson(absoluteReport) } catch (error) {
    errors.push(`malformed evidence report: ${error instanceof Error ? error.message : String(error)}`)
    return
  }
  validateWithSchema(evidenceSchema, report, 'evidence report', errors)
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    errors.push('evidence report root must be an object')
    return
  }
  const topLevelKeys = ['schema_version', 'tested_commit', 'requirements_sha256', 'schema_sha256', 'tool_schema_sha256', 'artifacts', 'commands', 'case_results', 'tool_reports']
  if (!globalThis.Object || !Array.isArray(report.artifacts) || !Array.isArray(report.commands)
    || !Array.isArray(report.case_results) || !topLevelKeys.every((key) => Object.hasOwn(report, key))
    || Object.keys(report).some((key) => !topLevelKeys.includes(key))) errors.push('evidence report has missing or unknown top-level fields')
  if (report.schema_version !== 1 || report.artifacts.length === 0 || report.commands.length === 0 || report.case_results.length === 0) errors.push('evidence report schema/version arrays are empty or invalid')
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  if (!/^[0-9a-f]{40}$/u.test(report.tested_commit ?? '') || report.tested_commit !== head) errors.push('evidence report is not bound to exact HEAD')
  if (report.requirements_sha256 !== PINNED_REQUIREMENTS_SHA256) errors.push('evidence report requirements digest mismatch')
  if (report.schema_sha256 !== PINNED_EVIDENCE_SCHEMA_SHA256) errors.push('evidence report schema digest mismatch')
  if (report.tool_schema_sha256 !== PINNED_TOOL_EVIDENCE_SCHEMA_SHA256) errors.push('evidence report tool schema digest mismatch')

  const artifacts = new Map()
  for (const artifact of Array.isArray(report.artifacts) ? report.artifacts : []) {
    if (!exactKeys(artifact, ['path', 'sha256']) || !artifact?.path || !/^[0-9a-f]{64}$/u.test(artifact.sha256 ?? '') || artifacts.has(artifact.path)) {
      errors.push('evidence report contains invalid or duplicate artifacts')
      continue
    }
    artifacts.set(artifact.path, artifact.sha256)
  }
  const exactHead = /^[0-9a-f]{40}$/u.test(report.tested_commit ?? '') && report.tested_commit === head
  for (const artifactPath of requirements.artifact_paths) {
    if (!artifacts.has(artifactPath)) errors.push(`evidence report missing artifact ${artifactPath}`)
    else if (exactHead) {
      try {
        if (gitFileSha256(root, report.tested_commit, artifactPath) !== artifacts.get(artifactPath)) errors.push(`artifact digest mismatch: ${artifactPath}`)
      } catch { errors.push(`artifact is unavailable at exact HEAD: ${artifactPath}`) }
    }
  }

  const commands = new Map()
  for (const command of Array.isArray(report.commands) ? report.commands : []) {
    if (!exactKeys(command, ['id', 'argv', 'exit_code', 'log_path', 'log_sha256', 'test_files', 'tests', 'failed']) || !command?.id || commands.has(command.id)) { errors.push('evidence report contains invalid or duplicate commands'); continue }
    const expected = requirements.commands[command.id]
    if (!expected || JSON.stringify(command.argv) !== JSON.stringify(expected)) errors.push(`unknown or altered command ${command.id}`)
    const log = resolveInside(path.dirname(absoluteReport), command.log_path)
    if (!log) errors.push(`command log is outside evidence directory ${command.id}`)
    if (!log || !fs.existsSync(log) || sha256(fs.readFileSync(log)) !== command.log_sha256) {
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
      const executable = resolveInside(root, expected[0])
      if (!executable || expected[0] !== 'node_modules/.bin/vitest' || !fs.existsSync(executable)) {
        errors.push(`command ${command.id} does not use the pinned local Vitest executable`)
        commands.set(command.id, command)
        continue
      }
      const rerun = spawnSync(executable, expected.slice(1), {
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
    const toolOnly = declared.length === 1 && declared[0] === 'qa018-tool-reports'
    if (JSON.stringify(result.command_ids) !== JSON.stringify(declared) || (!toolOnly && result.command_ids.some((id) => !commands.has(id)))) errors.push(`case result command binding mismatch ${key}`)
    results.set(key, result)
  }
  for (const key of requirementKeys) if (!results.has(key)) errors.push(`release evidence missing required case ${key}`)

  for (const lane of ['lane_a', 'lane_b', 'lane_c', 'lane_d', 'integrator']) {
    for (const tool of ['gitnexus', 'graphify']) {
      const entry = report.tool_reports?.[lane]?.[tool]
      const file = resolveInside(path.dirname(absoluteReport), entry?.path)
      if (!file) errors.push(`${lane} ${tool} report is outside evidence directory`)
      if (!exactKeys(entry, ['tested_commit', 'path', 'sha256']) || !entry?.path || !file || !fs.existsSync(file) || sha256(fs.readFileSync(file)) !== entry.sha256) {
        errors.push(`missing or altered ${lane} ${tool} report`)
        continue
      }
      let toolReport
      try { toolReport = readJson(file) } catch (error) {
        errors.push(`malformed ${lane} ${tool} report: ${error instanceof Error ? error.message : String(error)}`)
        continue
      }
      const schemaValid = validateWithSchema(toolSchema, toolReport, `${lane} ${tool} report`, errors)
      const commitMatches = entry.tested_commit === toolReport.tested_commit
      if (!commitMatches || toolReport.tool !== tool || toolReport.lane !== lane) errors.push(`invalid identity binding for ${lane} ${tool} report`)
      if (tool === 'graphify' && toolReport.source_commit !== toolReport.tested_commit) errors.push(`invalid source commit for ${lane} graphify report`)
      if (lane === 'integrator') {
        if (entry.tested_commit !== head) errors.push(`integrator ${tool} report is not bound to exact HEAD`)
      } else if (/^[0-9a-f]{40}$/u.test(entry.tested_commit ?? '')) {
        const ancestor = spawnSync('git', ['merge-base', '--is-ancestor', entry.tested_commit, head], { cwd: root })
        if (ancestor.status !== 0) errors.push(`${lane} ${tool} report commit is not integrated into exact HEAD`)
      } else errors.push(`${lane} ${tool} report has an invalid commit`)
      if (!schemaValid) continue
    }
  }
}

export function evaluateBetaQualityMatrix({
  root = DEFAULT_ROOT,
  matrixPath = DEFAULT_MATRIX,
  requirementsPath = DEFAULT_REQUIREMENTS,
  schemaPath = DEFAULT_EVIDENCE_SCHEMA,
  toolSchemaPath = DEFAULT_TOOL_EVIDENCE_SCHEMA,
  mode = 'current-base',
  evidenceReport = null,
} = {}) {
  if (!['current-base', 'release'].includes(mode)) throw new Error(`unknown matrix mode: ${mode}`)
  const errors = []
  let requirementsBytes; let matrixBytes; let schemaBytes; let toolSchemaBytes
  try {
    requirementsBytes = fs.readFileSync(requirementsPath)
    matrixBytes = fs.readFileSync(matrixPath)
    schemaBytes = fs.readFileSync(schemaPath)
    toolSchemaBytes = fs.readFileSync(toolSchemaPath)
  } catch (error) {
    return { ok: false, mode, errors: [`quality contract is unreadable: ${error instanceof Error ? error.message : String(error)}`], unresolved: [], discovered: [], discovery_digest: null, discovery_scope: 'advisory-regex' }
  }
  if (sha256(requirementsBytes) !== PINNED_REQUIREMENTS_SHA256) errors.push('requirements manifest digest differs from the pinned immutable digest')
  if (sha256(matrixBytes) !== PINNED_MATRIX_SHA256) errors.push('quality matrix digest differs from the pinned immutable digest')
  if (sha256(schemaBytes) !== PINNED_EVIDENCE_SCHEMA_SHA256) errors.push('evidence schema digest differs from the pinned immutable digest')
  if (sha256(toolSchemaBytes) !== PINNED_TOOL_EVIDENCE_SCHEMA_SHA256) errors.push('tool evidence schema digest differs from the pinned immutable digest')
  let requirements; let matrix; let evidenceSchema; let toolSchema
  try {
    requirements = JSON.parse(requirementsBytes)
    matrix = JSON.parse(matrixBytes)
    evidenceSchema = JSON.parse(schemaBytes)
    toolSchema = JSON.parse(toolSchemaBytes)
  } catch (error) {
    return { ok: false, mode, errors: [...errors, `quality contract JSON is malformed: ${error instanceof Error ? error.message : String(error)}`], unresolved: [], discovered: [], discovery_digest: null, discovery_scope: 'advisory-regex' }
  }
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
    validateEvidenceReport({ root, reportPath: evidenceReport, requirements, requirementKeys, evidenceSchema, toolSchema, errors })
  }
  const unresolved = [...matrixMap.values()].map((entry) => ({ item: entry.item, case: entry.case, status: entry.status, lane: entry.lane ?? null }))
  return { ok: errors.length === 0, mode, errors, unresolved, discovered, discovery_digest: discoveryDigest, discovery_scope: 'advisory-regex' }
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
