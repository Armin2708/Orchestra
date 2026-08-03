#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { evaluateBetaQualityMatrix } from './check-beta-quality-matrix.mjs'
import { assertTarRegularEntries } from './tar-artifact-integrity.mjs'

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_ROOT = path.resolve(SCRIPT_DIRECTORY, '..')
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u
const SHA256_PATTERN = /^[0-9a-f]{64}$/u
const PRERELEASE_PATTERN = /^\d+\.\d+\.\d+-[0-9A-Za-z](?:[0-9A-Za-z.-]*[0-9A-Za-z])?$/u
const REQUIRED_PLATFORMS = new Map([
  ['macos-arm64', { os: 'darwin', arch: 'arm64', runnerOs: 'macOS', imagePattern: /^macos-?15$/u }],
  ['ubuntu-24.04-x64', { os: 'linux', arch: 'x64', runnerOs: 'Linux', imagePattern: /^ubuntu24/u }],
])
const REQUIRED_ROLLOUT_STAGES = ['internal', 'canary']
const REQUIRED_SIGNALS = ['installation', 'provider', 'recovery', 'token', 'migration']
const MAX_JSON_BYTES = 16 * 1024 * 1024

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const hasSymlinkComponent = (target) => {
  const resolved = path.resolve(target)
  let current = path.parse(resolved).root
  for (const segment of resolved.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment)
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) return true
  }
  return false
}
const readJson = (file, label) => {
  const resolved = path.resolve(file)
  if (!fs.existsSync(resolved) || hasSymlinkComponent(resolved)) {
    throw new Error(`${label} is missing or uses a symlink`)
  }
  const stat = fs.lstatSync(resolved)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_JSON_BYTES) {
    throw new Error(`${label} must be one bounded regular JSON file`)
  }
  try {
    return JSON.parse(fs.readFileSync(resolved, 'utf8'))
  } catch {
    throw new Error(`${label} is not valid JSON`)
  }
}
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const exactKeys = (value, expected) => isRecord(value) &&
  JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort())

const gate = (id, ok, evidence, blocker = null) => ({
  id,
  status: ok ? 'passed' : 'blocked',
  evidence,
  blocker: ok ? null : blocker,
})

export const isPublishWorkflowFailClosed = (workflowSource) => {
  try {
    const workflow = parseYaml(workflowSource, { uniqueKeys: true })
    return isRecord(workflow) && isRecord(workflow.jobs) &&
      isRecord(workflow.jobs.publish) && workflow.jobs.publish.if === '${{ false }}'
  } catch {
    return false
  }
}

export const inspectArtifact = ({ artifactDirectory, commit, sourceVersion }) => {
  if (!artifactDirectory) return { ok: false, blocker: 'supply --artifact-dir for the one retained candidate' }
  const directory = path.resolve(artifactDirectory)
  if (!fs.existsSync(directory) || hasSymlinkComponent(directory) || !fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink()) {
    return { ok: false, blocker: 'retained artifact directory is missing, symlinked, or not a directory' }
  }
  const metadataPath = path.join(directory, 'package-metadata.json')
  if (!fs.existsSync(metadataPath)) return { ok: false, blocker: 'retained artifact metadata is missing' }
  try {
    const metadata = readJson(metadataPath, 'retained artifact metadata')
    const filename = String(metadata.filename ?? '')
    const tarball = path.join(directory, filename)
    if (path.basename(filename) !== filename || !filename.endsWith('.tgz') || !fs.existsSync(tarball) || hasSymlinkComponent(tarball)) {
      throw new Error('metadata does not identify one retained tarball')
    }
    const stat = fs.lstatSync(tarball)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1) throw new Error('retained tarball is not one non-empty regular file')
    assertTarRegularEntries(tarball)
    const digest = sha256(fs.readFileSync(tarball))
    const checksumPath = path.join(directory, `${filename}.sha256`)
    const checksum = fs.existsSync(checksumPath) && !hasSymlinkComponent(checksumPath)
      ? fs.readFileSync(checksumPath, 'utf8').trim()
      : ''
    const exact = metadata.schema_version === 1 && metadata.commit_sha === commit &&
      metadata.package_version === sourceVersion && metadata.filename === filename &&
      metadata.bytes === stat.size && metadata.sha256 === digest &&
      checksum === `${digest}  ${filename}` &&
      metadata.source_identity?.expected_commit === commit &&
      metadata.source_identity?.observed_commit === commit &&
      metadata.source_identity?.tracked_source_clean === true &&
      metadata.source_identity?.packaged_nonbuild_inputs_tracked === true &&
      metadata.reproducibility?.byte_identical === true &&
      metadata.reproducibility?.second_pack_sha256 === digest
    if (!exact) throw new Error('retained tarball metadata, checksum, source identity, or reproducibility does not bind exact HEAD')
    return {
      ok: true,
      identity: { filename, version: metadata.package_version, bytes: stat.size, sha256: digest },
      rollbackPassed: metadata.lifecycle?.passed === true &&
        metadata.lifecycle?.release_gate?.status === 'passed' &&
        metadata.lifecycle?.release_gate?.prior_evidence_verified === true &&
        metadata.lifecycle?.upgrade?.passed === true &&
        metadata.lifecycle?.rollback?.passed === true &&
        metadata.lifecycle?.previous_artifact?.sha256 !== digest &&
        metadata.lifecycle?.previous_artifact?.version !== metadata.package_version,
    }
  } catch (error) {
    return { ok: false, blocker: error instanceof Error ? error.message : String(error) }
  }
}

export const inspectPlatformReports = ({ reportPaths, artifact, commit }) => {
  const observed = new Set()
  const errors = []
  for (const reportPath of reportPaths) {
    try {
      const report = readJson(reportPath, 'platform lifecycle report')
      const platformKey = String(report.platform?.key ?? '')
      const expected = REQUIRED_PLATFORMS.get(platformKey)
      const lifecyclePath = path.resolve(path.dirname(path.resolve(reportPath)), String(report.lifecycle_report?.path ?? ''))
      const lifecycleRelation = path.relative(path.dirname(path.resolve(reportPath)), lifecyclePath)
      const lifecycleRegular = lifecycleRelation && !lifecycleRelation.startsWith('..') && !path.isAbsolute(lifecycleRelation) &&
        fs.existsSync(lifecyclePath) && !hasSymlinkComponent(lifecyclePath) &&
        fs.lstatSync(lifecyclePath).isFile() && !fs.lstatSync(lifecyclePath).isSymbolicLink()
      const lifecycle = lifecycleRegular ? readJson(lifecyclePath, 'full platform lifecycle report') : null
      if (!exactKeys(report, ['schema_version', 'tested_commit', 'artifact', 'platform', 'lifecycle_report', 'status']) ||
        !exactKeys(report.artifact, ['filename', 'version', 'bytes', 'sha256']) ||
        !exactKeys(report.platform, ['key', 'os', 'arch', 'node', 'npm', 'runner_os', 'image_os']) ||
        !exactKeys(report.lifecycle_report, ['path', 'sha256', 'release_gate_status', 'rollback_passed']) ||
        report.schema_version !== 1 || report.status !== 'passed' || !expected ||
        report.tested_commit !== commit || report.artifact?.sha256 !== artifact?.sha256 ||
        report.artifact?.version !== artifact?.version || report.artifact?.filename !== artifact?.filename ||
        report.artifact?.bytes !== artifact?.bytes ||
        report.platform?.os !== expected.os || report.platform?.arch !== expected.arch ||
        report.platform?.runner_os !== expected.runnerOs ||
        !expected.imagePattern.test(String(report.platform?.image_os ?? '')) ||
        report.platform?.node !== '22.20.0' || report.platform?.npm !== '10.9.3' ||
        !SHA256_PATTERN.test(String(report.lifecycle_report?.sha256 ?? '')) ||
        !lifecycleRegular || sha256(fs.readFileSync(lifecyclePath)) !== report.lifecycle_report?.sha256 ||
        report.lifecycle_report?.release_gate_status !== 'passed' ||
        report.lifecycle_report?.rollback_passed !== true || lifecycle?.passed !== true ||
        lifecycle?.release_gate?.status !== 'passed' || lifecycle?.rollback?.passed !== true ||
        lifecycle?.artifact?.sha256 !== artifact?.sha256 ||
        lifecycle?.previous_artifact?.sha256 === artifact?.sha256) {
        throw new Error(`invalid or mismatched platform report ${platformKey || '<unknown>'}`)
      }
      if (observed.has(platformKey)) throw new Error(`duplicate platform report ${platformKey}`)
      observed.add(platformKey)
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error))
    }
  }
  for (const key of REQUIRED_PLATFORMS.keys()) if (!observed.has(key)) errors.push(`missing ${key} lifecycle report`)
  return { ok: errors.length === 0, observed: [...observed].sort(), errors }
}

export const inspectRolloutReports = ({ reportPaths, artifact, commit }) => {
  const observed = new Set()
  const errors = []
  for (const reportPath of reportPaths) {
    try {
      const report = readJson(reportPath, 'rollout observation report')
      const stage = String(report.stage ?? '')
      const started = Date.parse(String(report.started_at ?? ''))
      const completed = Date.parse(String(report.completed_at ?? ''))
      if (!exactKeys(report, [
        'schema_version', 'tested_commit', 'artifact', 'stage', 'cohort', 'started_at',
        'completed_at', 'required_duration_seconds', 'signals', 'incidents', 'rollback', 'status',
      ]) || !exactKeys(report.artifact, ['version', 'sha256']) ||
        report.schema_version !== 1 || report.status !== 'passed' ||
        !REQUIRED_ROLLOUT_STAGES.includes(stage) || report.tested_commit !== commit ||
        report.artifact?.sha256 !== artifact?.sha256 || report.artifact?.version !== artifact?.version ||
        typeof report.cohort !== 'string' || report.cohort.trim() === '' ||
        !Number.isFinite(started) || !Number.isFinite(completed) || completed <= started ||
        !Number.isInteger(report.required_duration_seconds) || report.required_duration_seconds < 1 ||
        completed - started < report.required_duration_seconds * 1000 ||
        !exactKeys(report.signals, REQUIRED_SIGNALS) ||
        REQUIRED_SIGNALS.some((signal) => report.signals[signal] !== 'healthy') ||
        !exactKeys(report.incidents, ['p0', 'p1', 'p2']) || report.incidents.p0 !== 0 || report.incidents.p1 !== 0 ||
        !Number.isInteger(report.incidents.p2) || report.incidents.p2 < 0 ||
        !exactKeys(report.rollback, ['owner', 'drill_passed', 'prior_artifact_sha256', 'schema_down_migration']) ||
        typeof report.rollback.owner !== 'string' || report.rollback.owner.trim() === '' ||
        report.rollback.drill_passed !== true || report.rollback.schema_down_migration !== false ||
        !SHA256_PATTERN.test(String(report.rollback.prior_artifact_sha256 ?? '')) ||
        report.rollback.prior_artifact_sha256 === artifact?.sha256) {
        throw new Error(`invalid or incomplete rollout report ${stage || '<unknown>'}`)
      }
      if (observed.has(stage)) throw new Error(`duplicate rollout report ${stage}`)
      observed.add(stage)
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error))
    }
  }
  for (const stage of REQUIRED_ROLLOUT_STAGES) if (!observed.has(stage)) errors.push(`missing ${stage} rollout report`)
  return { ok: errors.length === 0, observed: [...observed].sort(), errors }
}

export function evaluateBetaReleasePreflight({
  root = DEFAULT_ROOT,
  proposedVersion = null,
  artifactDirectory = null,
  qualityEvidencePath = null,
  platformReportPaths = [],
  rolloutReportPaths = [],
} = {}) {
  const repository = path.resolve(root)
  const sourcePackage = readJson(path.join(repository, 'package.json'), 'source package manifest')
  const contract = readJson(path.join(repository, 'scripts/beta-release-contract.json'), 'beta release contract')
  const priorTrust = readJson(path.join(repository, 'scripts/prior-artifact-trust-roots.json'), 'prior-artifact trust roots')
  const qualityTrust = readJson(path.join(repository, 'scripts/beta-quality-trust-roots.json'), 'beta-quality trust roots')
  const workflow = fs.readFileSync(path.join(repository, '.github/workflows/ci.yml'), 'utf8')
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim()
  const trackedStatus = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: repository, encoding: 'utf8' }).trim()
  const proposal = String(proposedVersion ?? '').trim()
  const artifact = inspectArtifact({ artifactDirectory, commit, sourceVersion: sourcePackage.version })
  const platforms = inspectPlatformReports({ reportPaths: platformReportPaths, artifact: artifact.identity, commit })
  const rollout = inspectRolloutReports({ reportPaths: rolloutReportPaths, artifact: artifact.identity, commit })
  let quality = { ok: false, errors: ['supply --quality-evidence from the signed exact-head QA-018 runner'] }
  if (qualityEvidencePath) {
    quality = evaluateBetaQualityMatrix({ root: repository, mode: 'release', evidenceReport: qualityEvidencePath })
  }

  const publishWorkflowFailClosed = isPublishWorkflowFailClosed(workflow)
  const publishFailClosed = contract.publication_approval?.workflow_publish_enabled === false &&
    publishWorkflowFailClosed
  const protectionObserved = contract.publication_approval?.required_reviewers_verified === true &&
    contract.publication_approval?.workflow_publish_enabled === false &&
    publishWorkflowFailClosed
  const gates = [
    gate('exact-clean-source', COMMIT_PATTERN.test(commit) && trackedStatus === '', { commit, tracked: trackedStatus === '' }, 'use one clean exact candidate commit'),
    gate('prerelease-proposal', PRERELEASE_PATTERN.test(proposal), { proposed_version: proposal || null }, 'supply an explicit SemVer prerelease proposal such as 0.1.0-beta.1'),
    gate('approved-source-version', PRERELEASE_PATTERN.test(String(sourcePackage.version)) && sourcePackage.version === proposal, { source_version: sourcePackage.version }, 'human approval and the reviewed version-only source change are still required'),
    gate('retained-exact-artifact', artifact.ok, artifact.identity ?? null, artifact.blocker),
    gate('distinct-signed-prior-and-rollback', artifact.ok && artifact.rollbackPassed, artifact.ok ? { release_gate: artifact.rollbackPassed ? 'passed' : 'incomplete' } : null, 'supply a different-version signed prior artifact and pass real upgrade/rollback'),
    gate('qa-018-signed-exact-slices', quality.ok === true, { report: qualityEvidencePath, errors: quality.errors ?? [] }, 'run the signed exact-head QA-018 evidence checker with a reviewed production public key'),
    gate('clean-macos-and-linux', platforms.ok, { observed: platforms.observed, errors: platforms.errors }, 'run the manual exact-artifact platform workflow on both clean runners'),
    gate('publication-remains-fail-closed', publishFailClosed, { disabled: publishFailClosed }, 'restore the disabled publish boundary before preparation continues'),
    gate('npm-beta-protection-observed', protectionObserved, {
      reviewers_verified: contract.publication_approval?.required_reviewers_verified === true,
      workflow_enabled: contract.publication_approval?.workflow_publish_enabled === true,
    }, 'observe npm-beta required reviewers and record that reviewed evidence while publication remains disabled'),
    gate('internal-and-canary-monitoring', rollout.ok, { observed: rollout.observed, errors: rollout.errors }, 'complete exact-artifact internal and named-canary observation plus rollback drills'),
    gate('prior-artifact-production-trust', Array.isArray(priorTrust.trusted_signing_keys) && priorTrust.trusted_signing_keys.length > 0, { trusted_keys: priorTrust.trusted_signing_keys?.length ?? 0 }, 'review and pin a maintainer-controlled prior-artifact public key; never add private material'),
    gate('qa-018-production-trust', Array.isArray(qualityTrust.trusted_signing_keys) && qualityTrust.trusted_signing_keys.length > 0, { trusted_keys: qualityTrust.trusted_signing_keys?.length ?? 0 }, 'review and pin an independent QA-018 public key; never add private material'),
  ]
  const blockers = gates.filter((entry) => entry.status !== 'passed').map((entry) => ({ id: entry.id, blocker: entry.blocker }))
  return {
    schema_version: 1,
    release_channel: 'beta',
    tested_commit: commit,
    proposed_version: proposal || null,
    artifact: artifact.identity ?? null,
    status: blockers.length === 0 ? 'ready-for-human-publication-approval' : 'blocked',
    public_action_authorized: false,
    gates,
    blockers,
  }
}

const argumentsFor = (argv) => {
  const values = { platformReportPaths: [], rolloutReportPaths: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`unknown or incomplete argument: ${key}`)
    if (key === '--proposed-version') values.proposedVersion = value
    else if (key === '--artifact-dir') values.artifactDirectory = value
    else if (key === '--quality-evidence') values.qualityEvidencePath = value
    else if (key === '--platform-report') values.platformReportPaths.push(value)
    else if (key === '--rollout-report') values.rolloutReportPaths.push(value)
    else throw new Error(`unknown or incomplete argument: ${key}`)
    index += 1
  }
  return values
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const result = evaluateBetaReleasePreflight(argumentsFor(process.argv.slice(2)))
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  process.exitCode = result.status === 'ready-for-human-publication-approval' ? 0 : 2
}
