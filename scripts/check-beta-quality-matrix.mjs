#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Ajv2020 from 'ajv/dist/2020.js'
import { canonicalJson } from './exact-commit-contract.mjs'
import {
  BETA_QUALITY_AUTHORIZATION_SCOPE,
  BETA_QUALITY_PURPOSE,
  BETA_QUALITY_REPOSITORY,
  verifyBetaQualitySignature,
  verifyBetaQualitySignatureForTesting,
} from './beta-quality-signature.mjs'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
export const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, '..')
export const DEFAULT_MATRIX = path.join(DEFAULT_ROOT, 'docs/quality/beta-quality-matrix.json')
export const DEFAULT_REQUIREMENTS = path.join(DEFAULT_ROOT, 'docs/quality/beta-quality-requirements.json')
export const DEFAULT_EVIDENCE_SCHEMA = path.join(DEFAULT_ROOT, 'docs/quality/beta-quality-evidence.schema.json')
export const DEFAULT_TOOL_EVIDENCE_SCHEMA = path.join(DEFAULT_ROOT, 'docs/quality/beta-quality-tool-evidence.schema.json')
export const DEFAULT_INTEGRATION_MANIFEST_SCHEMA = path.join(DEFAULT_ROOT, 'docs/quality/beta-quality-integration-manifest.schema.json')
export const DEFAULT_SIGNATURE_RECEIPT_SCHEMA = path.join(DEFAULT_ROOT, 'docs/quality/beta-quality-signature-receipt.schema.json')

// These are intentionally independent of the JSON files. Changing a contract requires a reviewed
// code change and new evasion tests, not a self-authorized JSON edit.
export const PINNED_REQUIREMENTS_SHA256 = 'b1c4ef3dafdba3353e80eb61ae90dcb55fd8f7f9904a376ce8c23afc23d1ca46'
export const PINNED_MATRIX_SHA256 = '08290a23d95f315c33582a2addaa7b50df217742728f34266007b1d7b722f44f'
export const PINNED_EVIDENCE_SCHEMA_SHA256 = '5735308109d34c5f72099c433c2329867f70075712cb0a08b0f97efea448ad06'
export const PINNED_TOOL_EVIDENCE_SCHEMA_SHA256 = '4499d3b5aba26a7ab19e7a77f9744576338e1ffadc873fd649c01e8e3a954daa'
export const PINNED_INTEGRATION_MANIFEST_SCHEMA_SHA256 = '9c1bd3fc5e6be4d561fea0ba6e9a7d7961e7de6f9555cf4ffdf3076693904d73'
export const PINNED_SIGNATURE_RECEIPT_SCHEMA_SHA256 = 'e476035408794a6148cd2c8e806fdbcf95e0455e53b855453fbed197135c76eb'
export const REQUIRED_BETA_BASE = '0dd3dd43b9f376370ee73a9e2fe4725974caaae8'

const SLICE_IDS = ['lane_a', 'lane_b', 'lane_c', 'lane_d', 'integrator']
const SOURCE_MARKERS = {
  lane_a: '[beta-lane-a-ready]', lane_b: '[beta-lane-b-ready]',
  lane_c: '[beta-lane-c-ready]', lane_d: '[beta-lane-d-ready]',
  integrator: '[beta-release-candidate]',
}
const REMEDIATION_MARKERS = {
  lane_a: '[beta-lane-a-remediation-ready]', lane_b: '[beta-lane-b-remediation-ready]',
  lane_c: '[beta-lane-c-remediation-ready]', lane_d: '[beta-lane-d-remediation-ready]',
  integrator: '[beta-release-candidate-remediation]',
}

const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const canonicalSha256 = (value) => sha256(Buffer.from(canonicalJson(value)))
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))
const repoRelative = (root, file) => path.relative(root, file).split(path.sep).join('/')
const exactKeys = (value, expected) => value && typeof value === 'object' && !Array.isArray(value)
  && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort())
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const zeroFindings = (value) => exactKeys(value, ['p0', 'p1', 'p2'])
  && value.p0 === 0 && value.p1 === 0 && value.p2 === 0

const hasSymlinkComponent = (target) => {
  let current = path.parse(path.resolve(target)).root
  for (const segment of path.resolve(target).slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment)
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) return true
  }
  return false
}

const resolveInside = (directory, relative) => {
  if (typeof relative !== 'string' || relative.length === 0 || path.isAbsolute(relative)) return null
  const absolute = path.resolve(directory, relative)
  if (hasSymlinkComponent(directory) || hasSymlinkComponent(absolute)) return null
  const base = fs.existsSync(directory) ? fs.realpathSync(directory) : path.resolve(directory)
  const candidate = fs.existsSync(absolute) ? fs.realpathSync(absolute) : absolute
  const resolved = path.relative(base, candidate)
  return resolved && !resolved.startsWith('..') && !path.isAbsolute(resolved) ? candidate : null
}

const resolveLocalExecutable = (directory, relative) => {
  if (typeof relative !== 'string' || path.isAbsolute(relative)) return null
  const base = fs.realpathSync(directory)
  const absolute = path.resolve(directory, relative)
  if (!fs.existsSync(absolute)) return null
  const candidate = fs.realpathSync(absolute)
  const resolved = path.relative(base, candidate)
  return resolved && !resolved.startsWith('..') && !path.isAbsolute(resolved) ? candidate : null
}

const artifactFile = ({ directory, artifact, label, errors }) => {
  if (!exactKeys(artifact, ['path', 'sha256'])) {
    errors.push(`${label} artifact reference is malformed`)
    return null
  }
  const file = resolveInside(directory, artifact.path)
  if (!file) {
    errors.push(`${label} artifact is outside the evidence directory or uses a symlink`)
    return null
  }
  if (!fs.existsSync(file) || !fs.lstatSync(file).isFile()
    || sha256(fs.readFileSync(file)) !== artifact.sha256) {
    errors.push(`${label} artifact is missing or has a digest mismatch`)
    return null
  }
  return file
}

const readEvidenceArtifact = ({ directory, artifact, label, errors, json = true }) => {
  const file = artifactFile({ directory, artifact, label, errors })
  if (!file || !json) return file
  try { return readJson(file) } catch (error) {
    errors.push(`${label} artifact JSON is malformed: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

const unwrapMachineJson = (value) => {
  if (isRecord(value) && Array.isArray(value.content)) {
    const block = value.content.find((entry) => entry?.type === 'text' && typeof entry.text === 'string')
    if (block) {
      try { return JSON.parse(block.text.split('\n\n---\n')[0]) } catch { return null }
    }
  }
  return value
}

const validateWithSchema = (schema, value, label, errors) => {
  try {
    const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false })
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

const commitExists = (root, commit) =>
  spawnSync('git', ['cat-file', '-e', `${commit}^{commit}`], { cwd: root }).status === 0
const isAncestor = (root, ancestor, descendant) =>
  spawnSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], { cwd: root }).status === 0
const commitMessage = (root, commit) => execFileSync(
  'git', ['show', '-s', '--format=%B', commit], { cwd: root, encoding: 'utf8' },
)

const normalizeSignedArtifact = (kind, artifact) => ({ kind, path: artifact?.path, sha256: artifact?.sha256 })
const sortSignedArtifacts = (artifacts) => [...artifacts].sort((left, right) =>
  `${left.kind}\0${left.path}\0${left.sha256}`.localeCompare(`${right.kind}\0${right.path}\0${right.sha256}`))

const validateCheckpoint = ({ root, checkpoint, expectedMarker, priorCommit, requiredBase, head, label, errors }) => {
  if (!isRecord(checkpoint)) return null
  const commit = checkpoint.commit
  if (checkpoint.base_ref !== requiredBase
    || checkpoint.range !== `${requiredBase}..${commit}`
    || checkpoint.marker !== expectedMarker) errors.push(`${label} base, range, or marker is not exact`)
  if (!commitExists(root, commit)) {
    errors.push(`${label} commit does not exist in the repository`)
    return null
  }
  if (!isAncestor(root, requiredBase, commit)) errors.push(`${label} commit does not descend from the required beta base`)
  if (!isAncestor(root, commit, head)) errors.push(`${label} commit is not integrated into exact HEAD`)
  if (priorCommit && !isAncestor(root, priorCommit, commit)) errors.push(`${label} checkpoint order is not monotonic`)
  if (!commitMessage(root, commit).includes(expectedMarker)) errors.push(`${label} marker is absent from the actual commit message`)
  return commit
}

const requestDigest = (request) => canonicalSha256({ api: request.api, arguments: request.arguments })

const validateToolReport = ({
  root, evidenceDirectory, slice, tool, wrapper, toolSchema, requiredBase, head, artifactInventory, errors,
}) => {
  const label = `${slice.slice_id} ${tool}`
  const file = artifactFile({
    directory: evidenceDirectory,
    artifact: { path: wrapper?.path, sha256: wrapper?.sha256 },
    label: `${label} report`, errors,
  })
  if (!file) return { highRiskRequests: [] }
  let report
  try { report = readJson(file) } catch (error) {
    errors.push(`${label} report JSON is malformed: ${error instanceof Error ? error.message : String(error)}`)
    return { highRiskRequests: [] }
  }
  const schemaValid = validateWithSchema(toolSchema, report, `${label} report`, errors)
  if (!isRecord(report)) return { highRiskRequests: [] }
  if (report.tool !== tool || report.slice_id !== slice.slice_id
    || report.tested_commit !== slice.accepted_commit
    || report.base_ref !== requiredBase
    || report.range !== `${requiredBase}..${slice.accepted_commit}`
    || report.tool_version !== wrapper.tool_version
    || wrapper.tested_commit !== slice.accepted_commit) errors.push(`${label} report does not match the signed slice inventory`)
  if (wrapper.requests_sha256 !== canonicalSha256(report.requests)) errors.push(`${label} exact request digest does not match the signed slice inventory`)
  if (slice.slice_id === 'integrator' && report.tested_commit !== head) errors.push(`${label} report is not bound to exact HEAD`)
  if (!zeroFindings(report.unresolved_findings)) errors.push(`${label} report has unresolved P0/P1/P2 findings`)

  const expectedArtifacts = []
  const highRiskRequests = []
  if (tool === 'gitnexus') {
    const impactRepositories = new Set()
    for (const request of Array.isArray(report.requests?.impact) ? report.requests.impact : []) {
      expectedArtifacts.push(normalizeSignedArtifact('gitnexus-impact', request.result))
      const raw = unwrapMachineJson(readEvidenceArtifact({
        directory: evidenceDirectory, artifact: request.result,
        label: `${label} impact ${request.request_id ?? 'unknown'}`, errors,
      }))
      const observedTarget = raw?.target?.name ?? raw?.target?.filePath ?? raw?.target?.id
      if (!isRecord(raw) || !isRecord(raw.target) || typeof raw.risk !== 'string'
        || !isRecord(raw.summary) || observedTarget !== request.arguments?.target) {
        errors.push(`${label} raw impact output is null, malformed, or does not match its exact request`)
      }
      const rawRisk = String(raw?.risk ?? '').toUpperCase()
      if (rawRisk !== request.observed_risk) errors.push(`${label} signed impact risk differs from the raw result`)
      if (request.observed_risk === 'UNKNOWN') errors.push(`${label} impact risk is unresolved`)
      if (request.api !== 'mcp__gitnexus__impact'
        || typeof request.arguments?.repo !== 'string' || request.arguments.repo.length === 0
        || request.arguments?.direction !== 'upstream'
        || !Number.isInteger(request.arguments?.maxDepth)
        || typeof request.arguments?.minConfidence !== 'number'
        || typeof request.arguments?.includeTests !== 'boolean') errors.push(`${label} impact request does not preserve the exact GitNexus MCP invocation`)
      impactRepositories.add(request.arguments?.repo)
      if (['HIGH', 'CRITICAL'].includes(request.observed_risk)) {
        highRiskRequests.push({
          request_sha256: requestDigest(request),
          target: request.arguments.target,
          risk: request.observed_risk,
          checkpoint_commit: slice.accepted_commit,
        })
      }
    }
    const detectRequest = report.requests?.detect_changes
    expectedArtifacts.push(normalizeSignedArtifact('gitnexus-detect-changes', detectRequest?.result))
    const rawDetect = unwrapMachineJson(readEvidenceArtifact({
      directory: evidenceDirectory, artifact: detectRequest?.result,
      label: `${label} detect_changes`, errors,
    }))
    if (detectRequest?.api !== 'mcp__gitnexus__detect_changes'
      || typeof detectRequest?.arguments?.repo !== 'string'
      || detectRequest.arguments.repo.length === 0
      || detectRequest?.arguments?.worktree !== detectRequest?.arguments?.repo
      || detectRequest?.arguments?.scope !== 'compare'
      || detectRequest?.arguments?.base_ref !== requiredBase) errors.push(`${label} detect_changes request is not an exact compare against the beta base`)
    if (impactRepositories.size !== 1 || !impactRepositories.has(detectRequest?.arguments?.repo)) errors.push(`${label} GitNexus requests do not use one exact repository/worktree identity`)
    if (slice.slice_id === 'integrator'
      && path.resolve(String(detectRequest?.arguments?.worktree ?? '')) !== fs.realpathSync(root)) errors.push(`${label} detect_changes worktree is not the exact integrator worktree`)
    if (!isRecord(rawDetect) || !isRecord(rawDetect.summary)
      || !Number.isInteger(rawDetect.summary.changed_files)
      || typeof rawDetect.summary.risk_level !== 'string'
      || !Array.isArray(rawDetect.affected_processes)) errors.push(`${label} raw detect_changes output is null, malformed, or lacks semantic fields`)
  } else {
    const update = report.requests?.update
    const status = report.requests?.status
    expectedArtifacts.push(normalizeSignedArtifact('graphify-update', update?.result))
    expectedArtifacts.push(normalizeSignedArtifact('graphify-status', status?.result))
    expectedArtifacts.push(normalizeSignedArtifact('graphify-graph', report.artifacts?.graph))
    expectedArtifacts.push(normalizeSignedArtifact('graphify-manifest', report.artifacts?.manifest))
    if (JSON.stringify(update?.argv) !== JSON.stringify(['graphify', 'update', '.'])
      || update?.exit_code !== 0 || status?.exit_code !== 0) errors.push(`${label} requests do not retain a successful exact Graphify update/status invocation`)
    const rawUpdate = readEvidenceArtifact({ directory: evidenceDirectory, artifact: update?.result, label: `${label} update`, errors, json: false })
    const rawStatus = readEvidenceArtifact({ directory: evidenceDirectory, artifact: status?.result, label: `${label} status`, errors })
    const graphFile = readEvidenceArtifact({ directory: evidenceDirectory, artifact: report.artifacts?.graph, label: `${label} graph`, errors, json: false })
    const manifestFile = readEvidenceArtifact({ directory: evidenceDirectory, artifact: report.artifacts?.manifest, label: `${label} manifest`, errors, json: false })
    const expectedStatusArgv = isRecord(rawStatus) ? [
      'node', 'scripts/capture-graphify-status.mjs',
      '--graph', rawStatus.graph_path,
      '--manifest', rawStatus.manifest_path,
      '--tested-commit', report.tested_commit,
    ] : []
    if (!rawUpdate) errors.push(`${label} raw Graphify update stdout is missing`)
    if (JSON.stringify(status?.argv) !== JSON.stringify(expectedStatusArgv)) errors.push(`${label} status request is not the exact supported capture-graphify-status invocation`)
    if (!isRecord(rawStatus) || rawStatus.schema_version !== 1 || rawStatus.operation !== 'status'
      || rawStatus.tested_commit !== report.tested_commit
      || typeof rawStatus.graph_path !== 'string' || typeof rawStatus.manifest_path !== 'string'
      || rawStatus.graph_sha256 !== report.artifacts?.graph?.sha256
      || rawStatus.manifest_sha256 !== report.artifacts?.manifest?.sha256) errors.push(`${label} raw status output does not bind the retained graph and manifest`)
    if (graphFile) {
      try {
        const graph = readJson(graphFile)
        if (graph.built_at_commit !== report.tested_commit
          || !Array.isArray(graph.nodes) || !Array.isArray(graph.links)) errors.push(`${label} graph lacks exact-commit semantic fields`)
      } catch { errors.push(`${label} graph JSON is malformed`) }
    }
    if (manifestFile) {
      try {
        const manifest = readJson(manifestFile)
        if (!isRecord(manifest) || Object.keys(manifest).length === 0) errors.push(`${label} Graphify manifest is empty`)
      } catch { errors.push(`${label} Graphify manifest JSON is malformed`) }
    }
  }

  if (schemaValid && JSON.stringify(sortSignedArtifacts(wrapper.raw_artifacts ?? []))
    !== JSON.stringify(sortSignedArtifacts(expectedArtifacts))) errors.push(`${label} raw artifact inventory does not exactly match the signed manifest`)
  for (const artifact of expectedArtifacts) {
    const prior = artifactInventory.get(artifact.path)
    if (prior) errors.push(`${label} reuses raw artifact path ${artifact.path}`)
    else artifactInventory.set(artifact.path, artifact.sha256)
  }
  return { highRiskRequests }
}

export function verifyQa018EvidenceBundle({
  root = DEFAULT_ROOT,
  evidenceDirectory,
  manifestReference,
  receiptReference,
  integrationSchema = readJson(DEFAULT_INTEGRATION_MANIFEST_SCHEMA),
  signatureSchema = readJson(DEFAULT_SIGNATURE_RECEIPT_SCHEMA),
  toolSchema = readJson(DEFAULT_TOOL_EVIDENCE_SCHEMA),
  testOnlyTrustRoots = null,
  testOnlyRequiredBase = null,
  testOnlyHead = null,
} = {}) {
  const errors = []
  if (!manifestReference && !receiptReference) return { ok: false, verified: false, errors: ['QA-018 integration manifest and signature receipt are required'] }
  if (!manifestReference || !receiptReference) return { ok: false, verified: false, errors: ['QA-018 integration manifest and signature receipt must be supplied together'] }
  const manifestFile = artifactFile({ directory: evidenceDirectory, artifact: manifestReference, label: 'QA-018 integration manifest', errors })
  const receiptFile = artifactFile({ directory: evidenceDirectory, artifact: receiptReference, label: 'QA-018 signature receipt', errors })
  let manifest = null
  let receipt = null
  if (manifestFile) {
    try { manifest = readJson(manifestFile) } catch (error) { errors.push(`QA-018 integration manifest JSON is malformed: ${error instanceof Error ? error.message : String(error)}`) }
  }
  if (receiptFile) {
    try { receipt = readJson(receiptFile) } catch (error) { errors.push(`QA-018 signature receipt JSON is malformed: ${error instanceof Error ? error.message : String(error)}`) }
  }
  if (manifest) validateWithSchema(integrationSchema, manifest, 'QA-018 integration manifest', errors)
  if (receipt) validateWithSchema(signatureSchema, receipt, 'QA-018 signature receipt', errors)
  if ((testOnlyRequiredBase || testOnlyHead) && process.env.VITEST !== 'true') throw new Error('test-only QA-018 Git identity is unavailable outside Vitest')
  const requiredBase = testOnlyRequiredBase ?? REQUIRED_BETA_BASE
  const head = testOnlyHead ?? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  if (!isRecord(manifest) || manifest.purpose !== BETA_QUALITY_PURPOSE
    || manifest.repository !== BETA_QUALITY_REPOSITORY
    || manifest.base_ref !== requiredBase
    || manifest.integrator_commit !== head
    || manifest.authorization_scope !== BETA_QUALITY_AUTHORIZATION_SCOPE
    || manifest.public_release_authorized !== false) errors.push('QA-018 manifest is not bound to the repository, beta base, exact HEAD, and QA-only scope')
  if (!zeroFindings(manifest?.unresolved_findings)) errors.push('QA-018 manifest has unresolved P0/P1/P2 findings')

  let signatureVerified = false
  if (manifestFile && receiptFile) {
    try {
      const verification = testOnlyTrustRoots
        ? verifyBetaQualitySignatureForTesting({ manifestPath: manifestFile, receiptPath: receiptFile, testOnlyTrustRoots })
        : verifyBetaQualitySignature({ manifestPath: manifestFile, receiptPath: receiptFile })
      signatureVerified = verification.verified === true
        && verification.integrator_commit === head
        && verification.authorization_scope === BETA_QUALITY_AUTHORIZATION_SCOPE
        && verification.public_release_authorized === false
      if (!signatureVerified) errors.push('QA-018 signature verification did not establish exact-head QA-only authorization')
    } catch (error) {
      errors.push(`QA-018 signature verification failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const slices = Array.isArray(manifest?.slices) ? manifest.slices : []
  const observedSliceIds = slices.map((slice) => slice?.slice_id)
  if (JSON.stringify([...observedSliceIds].sort()) !== JSON.stringify([...SLICE_IDS].sort())) errors.push('QA-018 slice inventory must contain each lane and the integrator exactly once')
  const artifactInventory = new Map()
  for (const slice of slices) {
    if (!isRecord(slice) || !SLICE_IDS.includes(slice.slice_id)) continue
    const sourceCommit = validateCheckpoint({
      root, checkpoint: slice.source_checkpoint, expectedMarker: SOURCE_MARKERS[slice.slice_id],
      priorCommit: requiredBase, requiredBase, head, label: `${slice.slice_id} source checkpoint`, errors,
    })
    let lastCheckpoint = sourceCommit
    for (const [index, checkpoint] of (slice.accepted_remediation_checkpoints ?? []).entries()) {
      lastCheckpoint = validateCheckpoint({
        root, checkpoint, expectedMarker: REMEDIATION_MARKERS[slice.slice_id],
        priorCommit: lastCheckpoint, requiredBase, head,
        label: `${slice.slice_id} remediation checkpoint ${index + 1}`, errors,
      }) ?? lastCheckpoint
    }
    if (slice.accepted_commit !== lastCheckpoint) errors.push(`${slice.slice_id} accepted commit does not equal its final accepted checkpoint`)
    if (slice.slice_id === 'integrator' && slice.accepted_commit !== head) errors.push('integrator accepted commit is not exact HEAD')
    if (!zeroFindings(slice.unresolved_findings)) errors.push(`${slice.slice_id} has unresolved P0/P1/P2 findings`)
    const gitResult = validateToolReport({
      root, evidenceDirectory, slice, tool: 'gitnexus', wrapper: slice.tool_reports?.gitnexus,
      toolSchema, requiredBase, head, artifactInventory, errors,
    })
    validateToolReport({
      root, evidenceDirectory, slice, tool: 'graphify', wrapper: slice.tool_reports?.graphify,
      toolSchema, requiredBase, head, artifactInventory, errors,
    })
    const dispositions = Array.isArray(slice.risk_dispositions) ? slice.risk_dispositions : []
    const dispositionKeys = new Set()
    for (const disposition of dispositions) {
      const key = `${disposition?.request_sha256}\0${disposition?.target}\0${disposition?.risk}\0${disposition?.checkpoint_commit}`
      if (dispositionKeys.has(key)) errors.push(`${slice.slice_id} has a duplicate HIGH/CRITICAL disposition`)
      dispositionKeys.add(key)
    }
    for (const request of gitResult.highRiskRequests) {
      const matches = dispositions.filter((entry) => entry?.request_sha256 === request.request_sha256
        && entry?.target === request.target && entry?.risk === request.risk
        && entry?.checkpoint_commit === request.checkpoint_commit
        && entry?.disposition === 'accepted-after-independent-review')
      if (matches.length !== 1) errors.push(`${slice.slice_id} ${request.risk} impact ${request.target} lacks one exact signed independent-review disposition`)
    }
    if (dispositions.length !== gitResult.highRiskRequests.length) errors.push(`${slice.slice_id} has an unmatched or missing HIGH/CRITICAL disposition`)
  }
  return { ok: signatureVerified && errors.length === 0, verified: signatureVerified && errors.length === 0, errors }
}

const validateEvidenceReport = ({
  root, reportPath, requirements, requirementKeys, evidenceSchema, toolSchema,
  integrationSchema, signatureSchema, errors,
}) => {
  if (!reportPath) {
    errors.push('release mode requires --evidence-report')
    return
  }
  const absoluteReport = path.resolve(reportPath)
  if (!fs.existsSync(absoluteReport) || hasSymlinkComponent(absoluteReport) || !fs.lstatSync(absoluteReport).isFile()) {
    errors.push(`missing evidence report: ${reportPath}`)
    return
  }
  let report
  try { report = readJson(absoluteReport) } catch (error) {
    errors.push(`malformed evidence report: ${error instanceof Error ? error.message : String(error)}`)
    return
  }
  validateWithSchema(evidenceSchema, report, 'evidence report', errors)
  if (!isRecord(report)) {
    errors.push('evidence report root must be an object')
    return
  }
  const topLevelKeys = [
    'schema_version', 'tested_commit', 'requirements_sha256', 'schema_sha256',
    'tool_schema_sha256', 'integration_schema_sha256', 'signature_schema_sha256',
    'qa018_closure_supported', 'integration_manifest', 'qa018_signature_receipt',
    'artifacts', 'commands', 'case_results',
  ]
  if (!exactKeys(report, topLevelKeys)) errors.push('evidence report has missing or unknown top-level fields')
  if (report.schema_version !== 2 || !Array.isArray(report.artifacts) || report.artifacts.length === 0
    || !Array.isArray(report.commands) || report.commands.length === 0
    || !Array.isArray(report.case_results) || report.case_results.length === 0) errors.push('evidence report schema/version arrays are empty or invalid')
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  if (!/^[0-9a-f]{40}$/u.test(report.tested_commit ?? '') || report.tested_commit !== head) errors.push('evidence report is not bound to exact HEAD')
  if (report.requirements_sha256 !== PINNED_REQUIREMENTS_SHA256) errors.push('evidence report requirements digest mismatch')
  if (report.schema_sha256 !== PINNED_EVIDENCE_SCHEMA_SHA256) errors.push('evidence report schema digest mismatch')
  if (report.tool_schema_sha256 !== PINNED_TOOL_EVIDENCE_SCHEMA_SHA256) errors.push('evidence report tool schema digest mismatch')
  if (report.integration_schema_sha256 !== PINNED_INTEGRATION_MANIFEST_SCHEMA_SHA256) errors.push('evidence report integration schema digest mismatch')
  if (report.signature_schema_sha256 !== PINNED_SIGNATURE_RECEIPT_SCHEMA_SHA256) errors.push('evidence report signature schema digest mismatch')

  const evidenceDirectory = path.dirname(absoluteReport)
  const qa018 = verifyQa018EvidenceBundle({
    root, evidenceDirectory, manifestReference: report.integration_manifest,
    receiptReference: report.qa018_signature_receipt, integrationSchema, signatureSchema,
    toolSchema,
  })
  if (report.integration_manifest || report.qa018_signature_receipt || report.qa018_closure_supported) errors.push(...qa018.errors)
  if (report.qa018_closure_supported !== qa018.ok) errors.push('evidence report QA-018 closure flag does not match independent signature and inventory verification')

  const artifacts = new Map()
  for (const artifact of Array.isArray(report.artifacts) ? report.artifacts : []) {
    if (!exactKeys(artifact, ['path', 'sha256']) || !artifact.path
      || !/^[0-9a-f]{64}$/u.test(artifact.sha256 ?? '') || artifacts.has(artifact.path)) {
      errors.push('evidence report contains invalid or duplicate artifacts')
      continue
    }
    artifacts.set(artifact.path, artifact.sha256)
  }
  const exactHead = report.tested_commit === head && /^[0-9a-f]{40}$/u.test(report.tested_commit ?? '')
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
    const commandKeys = ['id', 'argv', 'exit_code', 'log_path', 'log_sha256', 'test_files', 'tests', 'passed', 'failed', 'pending', 'skipped', 'todo']
    if (!exactKeys(command, commandKeys) || !command.id || commands.has(command.id)) {
      errors.push('evidence report contains invalid or duplicate commands')
      continue
    }
    const expected = requirements.commands[command.id]
    if (!expected || JSON.stringify(command.argv) !== JSON.stringify(expected)) errors.push(`unknown or altered command ${command.id}`)
    const log = resolveInside(evidenceDirectory, command.log_path)
    if (!log) errors.push(`command log is outside evidence directory ${command.id}`)
    if (!log || !fs.existsSync(log) || sha256(fs.readFileSync(log)) !== command.log_sha256) {
      errors.push(`missing or altered command log ${command.id}`)
    } else {
      try {
        const observed = readJson(log)
        const statuses = Array.isArray(observed.testResults) ? observed.testResults.flatMap((suite) =>
          Array.isArray(suite?.assertionResults) ? suite.assertionResults.map((assertion) => assertion?.status) : []) : []
        const skipped = statuses.filter((status) => status === 'skipped').length
        if (observed.success !== true || observed.numFailedTests !== 0 || observed.numPendingTests !== 0
          || observed.numTodoTests !== 0 || observed.numPassedTests !== observed.numTotalTests || skipped !== 0
          || observed.numTotalTestSuites !== command.test_files || observed.numTotalTests !== command.tests
          || observed.numPassedTests !== command.passed || command.pending !== 0
          || command.skipped !== 0 || command.todo !== 0) errors.push(`command ${command.id} result does not match its complete Vitest JSON artifact`)
      } catch { errors.push(`command ${command.id} log is not machine-verifiable Vitest JSON`) }
    }
    if (command.exit_code !== 0 || command.failed !== 0 || command.pending !== 0
      || command.skipped !== 0 || command.todo !== 0 || !Number.isInteger(command.tests)
      || command.tests < 1 || command.passed !== command.tests || !Number.isInteger(command.test_files)
      || command.test_files < 1) errors.push(`command ${command.id} has incomplete, skipped, pending, todo, or failing tests`)
    if (expected) {
      const executable = resolveLocalExecutable(root, expected[0])
      if (!executable || expected[0] !== 'node_modules/.bin/vitest' || !fs.existsSync(executable)) {
        errors.push(`command ${command.id} does not use the pinned local Vitest executable`)
      } else {
        const rerun = spawnSync(executable, expected.slice(1), {
          cwd: root, encoding: 'utf8', env: process.env, maxBuffer: 64 * 1024 * 1024,
        })
        try {
          const observed = JSON.parse(rerun.stdout ?? '')
          const statuses = Array.isArray(observed.testResults) ? observed.testResults.flatMap((suite) =>
            Array.isArray(suite?.assertionResults) ? suite.assertionResults.map((assertion) => assertion?.status) : []) : []
          if (rerun.status !== 0 || observed.success !== true || observed.numFailedTests !== 0
            || observed.numPendingTests !== 0 || observed.numTodoTests !== 0
            || observed.numPassedTests !== observed.numTotalTests || statuses.some((status) => status === 'skipped')
            || observed.numTotalTestSuites !== command.test_files || observed.numTotalTests !== command.tests
            || observed.numPassedTests !== command.passed) errors.push(`release rerun did not reproduce complete command ${command.id}`)
        } catch { errors.push(`release rerun did not produce machine-verifiable Vitest JSON for ${command.id}`) }
      }
    }
    commands.set(command.id, command)
  }

  const results = new Map()
  for (const result of Array.isArray(report.case_results) ? report.case_results : []) {
    const key = `${result?.item}/${result?.case}`
    if (!exactKeys(result, ['item', 'case', 'command_ids', 'status'])
      || !requirementKeys.has(key) || results.has(key) || result.status !== 'passed'
      || !Array.isArray(result.command_ids) || result.command_ids.length === 0) {
      errors.push(`invalid, unknown, or duplicate case result ${key}`)
      continue
    }
    const declared = requirements._matrix.get(key).command_ids
    const toolOnly = declared.length === 1 && declared[0] === 'qa018-tool-reports'
    if (JSON.stringify(result.command_ids) !== JSON.stringify(declared)
      || (toolOnly ? !qa018.ok : result.command_ids.some((id) => !commands.has(id)))) errors.push(`case result command binding mismatch ${key}`)
    results.set(key, result)
  }
  for (const key of requirementKeys) if (!results.has(key)) errors.push(`release evidence missing required case ${key}`)
}

export function evaluateBetaQualityMatrix({
  root = DEFAULT_ROOT,
  matrixPath = DEFAULT_MATRIX,
  requirementsPath = DEFAULT_REQUIREMENTS,
  schemaPath = DEFAULT_EVIDENCE_SCHEMA,
  toolSchemaPath = DEFAULT_TOOL_EVIDENCE_SCHEMA,
  integrationSchemaPath = DEFAULT_INTEGRATION_MANIFEST_SCHEMA,
  signatureSchemaPath = DEFAULT_SIGNATURE_RECEIPT_SCHEMA,
  mode = 'current-base',
  evidenceReport = null,
} = {}) {
  if (!['current-base', 'release'].includes(mode)) throw new Error(`unknown matrix mode: ${mode}`)
  const errors = []
  let requirementsBytes; let matrixBytes; let schemaBytes; let toolSchemaBytes
  let integrationSchemaBytes; let signatureSchemaBytes
  try {
    requirementsBytes = fs.readFileSync(requirementsPath)
    matrixBytes = fs.readFileSync(matrixPath)
    schemaBytes = fs.readFileSync(schemaPath)
    toolSchemaBytes = fs.readFileSync(toolSchemaPath)
    integrationSchemaBytes = fs.readFileSync(integrationSchemaPath)
    signatureSchemaBytes = fs.readFileSync(signatureSchemaPath)
  } catch (error) {
    return { ok: false, mode, errors: [`quality contract is unreadable: ${error instanceof Error ? error.message : String(error)}`], unresolved: [], discovered: [], discovery_digest: null, discovery_scope: 'advisory-regex' }
  }
  if (sha256(requirementsBytes) !== PINNED_REQUIREMENTS_SHA256) errors.push('requirements manifest digest differs from the pinned immutable digest')
  if (sha256(matrixBytes) !== PINNED_MATRIX_SHA256) errors.push('quality matrix digest differs from the pinned immutable digest')
  if (sha256(schemaBytes) !== PINNED_EVIDENCE_SCHEMA_SHA256) errors.push('evidence schema digest differs from the pinned immutable digest')
  if (sha256(toolSchemaBytes) !== PINNED_TOOL_EVIDENCE_SCHEMA_SHA256) errors.push('tool evidence schema digest differs from the pinned immutable digest')
  if (sha256(integrationSchemaBytes) !== PINNED_INTEGRATION_MANIFEST_SCHEMA_SHA256) errors.push('integration manifest schema digest differs from the pinned immutable digest')
  if (sha256(signatureSchemaBytes) !== PINNED_SIGNATURE_RECEIPT_SCHEMA_SHA256) errors.push('signature receipt schema digest differs from the pinned immutable digest')
  let requirements; let matrix; let evidenceSchema; let toolSchema; let integrationSchema; let signatureSchema
  try {
    requirements = JSON.parse(requirementsBytes)
    matrix = JSON.parse(matrixBytes)
    evidenceSchema = JSON.parse(schemaBytes)
    toolSchema = JSON.parse(toolSchemaBytes)
    integrationSchema = JSON.parse(integrationSchemaBytes)
    signatureSchema = JSON.parse(signatureSchemaBytes)
  } catch (error) {
    return { ok: false, mode, errors: [...errors, `quality contract JSON is malformed: ${error instanceof Error ? error.message : String(error)}`], unresolved: [], discovered: [], discovery_digest: null, discovery_scope: 'advisory-regex' }
  }
  const requirementsValid = isRecord(requirements)
    && exactKeys(requirements, ['schema_version', 'allowed_items', 'allowed_statuses', 'required_cases', 'required_statuses', 'commands', 'future_command_ids', 'artifact_paths', 'classified_state_machine_files', 'state_machine_discovery_sha256'])
    && requirements.schema_version === 1 && Array.isArray(requirements.allowed_items)
    && requirements.allowed_items.length > 0 && Array.isArray(requirements.allowed_statuses)
    && isRecord(requirements.required_statuses) && isRecord(requirements.commands)
    && Array.isArray(requirements.future_command_ids) && Array.isArray(requirements.required_cases)
    && requirements.required_cases.length > 0 && Array.isArray(requirements.artifact_paths)
    && requirements.artifact_paths.length > 0 && Array.isArray(requirements.classified_state_machine_files)
    && requirements.classified_state_machine_files.length > 0
    && typeof requirements.state_machine_discovery_sha256 === 'string'
  if (!requirementsValid) {
    errors.push('requirements manifest schema/required arrays are empty or invalid')
    return { ok: false, mode, errors, unresolved: [], discovered: [], discovery_digest: null, discovery_scope: 'advisory-regex' }
  }
  if (!isRecord(matrix) || matrix.schema_version !== 2
    || !Array.isArray(matrix.requirements) || matrix.requirements.length === 0) {
    errors.push('matrix schema is invalid or empty')
    return { ok: false, mode, errors, unresolved: [], discovered: [], discovery_digest: null, discovery_scope: 'advisory-regex' }
  }
  const requirementKeys = new Set(requirements.required_cases)
  const matrixKeys = new Set()
  const matrixMap = new Map()
  for (const entry of matrix.requirements ?? []) {
    if (!isRecord(entry)) {
      errors.push('matrix contains a non-object requirement entry')
      continue
    }
    const key = `${entry.item}/${entry.case}`
    const expectedKeys = ['case', 'command_ids', 'item', ...(entry.status === 'lane-dependent' ? ['lane'] : []), 'status']
    if (!exactKeys(entry, expectedKeys)) errors.push(`${key}: missing or unknown fields`)
    if (!requirementKeys.has(key) || matrixKeys.has(key)) errors.push(`${key}: unknown or duplicate case`)
    if (!requirements.allowed_items.includes(entry.item)
      || !requirements.allowed_statuses.includes(entry.status) || entry.status === 'covered') errors.push(`${key}: item/status is not allowed`)
    const requiredStatus = requirements.required_statuses[key] ?? 'prerequisite'
    if (entry.status !== requiredStatus) errors.push(`${key}: status differs from immutable requirement ${requiredStatus}`)
    if (!Array.isArray(entry.command_ids) || entry.command_ids.length === 0
      || entry.command_ids.some((id) => !requirements.commands[id]
        && !requirements.future_command_ids.includes(id))) errors.push(`${key}: command binding is empty or unknown`)
    if (entry.status === 'lane-dependent' && !['A', 'B', 'C', 'D'].includes(entry.lane)) errors.push(`${key}: lane is missing or invalid`)
    matrixKeys.add(key)
    matrixMap.set(key, entry)
  }
  for (const key of requirementKeys) if (!matrixKeys.has(key)) errors.push(`matrix is missing required case ${key}`)
  for (const item of requirements.allowed_items) if (![...matrixKeys].some((key) => key.startsWith(`${item}/`))) errors.push(`matrix is missing required item ${item}`)
  for (const [id, argv] of Object.entries(requirements.commands)) if (!Array.isArray(argv)
    || argv.length === 0 || argv.some((value) => typeof value !== 'string' || value.length === 0)) errors.push(`command ${id} is empty`)
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
    validateEvidenceReport({
      root, reportPath: evidenceReport, requirements, requirementKeys, evidenceSchema,
      toolSchema, integrationSchema, signatureSchema, errors,
    })
  }
  const unresolved = [...matrixMap.values()].map((entry) => ({
    item: entry.item, case: entry.case, status: entry.status, lane: entry.lane ?? null,
  }))
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
