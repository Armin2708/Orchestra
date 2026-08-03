#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalJson } from './exact-commit-contract.mjs'
import { verifyPackageSourceIdentity } from './package-source-identity.mjs'
import { inspectRetainedPackageArtifact } from './retained-package-artifact.mjs'

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url))
export const DEFAULT_ROOT = path.resolve(SCRIPT_DIRECTORY, '..')
export const DEFAULT_PLAN = path.join(SCRIPT_DIRECTORY, 'beta-dogfood-plan.json')
const MANIFEST_NAME = 'manifest.json'
const LEDGER_NAME = 'events.ndjson'
const SUMMARY_NAME = 'summary.json'
const EVENT_KINDS = new Set([
  'work_cycle_passed',
  'engineering_cycle_passed',
  'engineering_cycle_failed',
  'daemon_interrupted',
  'daemon_recovered',
  'provider_interrupted',
  'provider_recovered',
  'network_interrupted',
  'network_recovered',
  'p0_opened',
  'p0_resolved',
  'p1_opened',
  'p1_resolved',
])

const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))
const iso = (value) => {
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime())) throw new Error('observed time must be a valid ISO timestamp')
  return parsed.toISOString()
}

const hasSymlinkComponent = (target) => {
  let current = path.parse(path.resolve(target)).root
  for (const segment of path.resolve(target).slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment)
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) return true
  }
  return false
}

const isInside = (parent, candidate) => {
  const relative = path.relative(parent, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

const regularFile = (file, label) => {
  if (!path.isAbsolute(file) || !fs.existsSync(file) || hasSymlinkComponent(file)
    || !fs.lstatSync(file).isFile()) throw new Error(`${label} must be an absolute regular file without symlinks`)
  return fs.realpathSync(file)
}

const writeFresh = (file, content) => {
  fs.writeFileSync(file, content, { flag: 'wx', mode: 0o600 })
}

const replaceOwnedFile = (file, content) => {
  const temporary = `${file}.tmp-${process.pid}`
  fs.writeFileSync(temporary, content, { flag: 'wx', mode: 0o600 })
  fs.renameSync(temporary, file)
}

const readPlan = (planPath = DEFAULT_PLAN) => {
  const bytes = fs.readFileSync(planPath)
  const plan = JSON.parse(bytes)
  if (plan.schema_version !== 1 || plan.purpose !== 'orchestra-beta-qa016-dogfood-v1'
    || plan.repository !== 'Armin2708/Orchestra'
    || !Number.isSafeInteger(plan.minimum_duration_ms) || plan.minimum_duration_ms < 86_400_000
    || !Number.isSafeInteger(plan.minimum_work_cycles) || plan.minimum_work_cycles < 3
    || !Number.isSafeInteger(plan.maximum_first_cycle_delay_ms)
    || plan.maximum_first_cycle_delay_ms < 1
    || !Array.isArray(plan.required_interruptions)
    || JSON.stringify([...plan.required_interruptions].sort()) !== JSON.stringify(['daemon', 'network', 'provider'])
    || !Array.isArray(plan.allowed_providers) || plan.allowed_providers.length < 1
    || !Array.isArray(plan.engineering_command) || plan.engineering_command[0] !== 'node_modules/.bin/vitest') {
    throw new Error('QA-016 dogfood plan is malformed or weaker than the beta minimum')
  }
  return { plan, digest: sha256(bytes) }
}

const parseProviders = (value, allowed) => {
  const providers = [...new Set(String(value ?? '').split(',').map((entry) => entry.trim()).filter(Boolean))].sort()
  if (providers.length < 1 || providers.some((provider) => !allowed.includes(provider))) {
    throw new Error(`providers must be a non-empty comma-separated subset of ${allowed.join(',')}`)
  }
  return providers
}

const assertOutputDirectory = (root, output, { create = false } = {}) => {
  if (!path.isAbsolute(output) || hasSymlinkComponent(output)) {
    throw new Error('dogfood evidence directory must be an absolute path without symlinks')
  }
  const canonicalRoot = fs.realpathSync(root)
  const parent = fs.realpathSync(path.dirname(output))
  const expected = path.join(parent, path.basename(output))
  if (isInside(canonicalRoot, expected)) throw new Error('dogfood evidence directory must be outside the repository')
  if (create) {
    fs.mkdirSync(expected, { mode: 0o700 })
    if (fs.realpathSync(expected) !== expected) throw new Error('dogfood evidence directory changed during creation')
  } else if (!fs.existsSync(expected) || !fs.lstatSync(expected).isDirectory()
    || fs.realpathSync(expected) !== expected) {
    throw new Error('dogfood evidence directory is missing or changed')
  }
  return expected
}

const gitHead = (root) => execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
}).trim()

const sourcePackageVersion = (root) => {
  const manifest = readJson(path.join(root, 'package.json'))
  const version = String(manifest?.version ?? '')
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/u.test(version)) {
    throw new Error('candidate source package version is invalid')
  }
  return version
}

const inspectRetainedCandidate = ({ root, candidateCommit, artifactPath }) => {
  const artifact = regularFile(artifactPath, 'retained candidate artifact')
  const inspected = inspectRetainedPackageArtifact({
    artifactDirectory: path.dirname(artifact),
    commit: candidateCommit,
    sourceVersion: sourcePackageVersion(root),
  })
  if (!inspected.ok) {
    throw new Error(`retained candidate package verification failed: ${inspected.blocker}`)
  }
  if (artifact !== path.join(path.dirname(artifact), inspected.identity.filename)) {
    throw new Error('retained candidate artifact does not match package metadata filename')
  }
  return { artifact, identity: inspected.identity }
}

const assertCandidateSource = ({ root, candidateCommit }) =>
  verifyPackageSourceIdentity({ cwd: root, expectedSha: candidateCommit })

const assertActiveBinding = ({ root, manifest }) => {
  assertCandidateSource({ root, candidateCommit: manifest.candidate_commit })
  const inspected = inspectRetainedCandidate({
    root,
    candidateCommit: manifest.candidate_commit,
    artifactPath: manifest.retained_artifact?.path,
  })
  if (inspected.identity.bytes !== manifest.retained_artifact?.bytes
    || inspected.identity.sha256 !== manifest.retained_artifact?.sha256) {
    throw new Error('retained candidate artifact changed after dogfood began')
  }
  return inspected
}

export function initializeDogfoodEvidence({
  root,
  output,
  candidateCommit,
  artifactPath,
  providers,
  now = new Date(),
  planPath = DEFAULT_PLAN,
}) {
  const repository = fs.realpathSync(root)
  if (!/^[0-9a-f]{40}$/u.test(candidateCommit) || gitHead(repository) !== candidateCommit) {
    throw new Error('candidate commit must equal exact repository HEAD')
  }
  assertCandidateSource({ root: repository, candidateCommit })
  const inspected = inspectRetainedCandidate({
    root: repository,
    candidateCommit,
    artifactPath,
  })
  const artifact = inspected.artifact
  const { plan, digest: planSha256 } = readPlan(planPath)
  const selectedProviders = parseProviders(providers, plan.allowed_providers)
  const directory = assertOutputDirectory(repository, output, { create: true })
  fs.mkdirSync(path.join(directory, 'artifacts'), { mode: 0o700 })
  const artifactBytes = fs.readFileSync(artifact)
  const manifest = {
    schema_version: 1,
    purpose: plan.purpose,
    repository: plan.repository,
    candidate_commit: candidateCommit,
    retained_artifact: {
      path: artifact,
      bytes: artifactBytes.byteLength,
      sha256: sha256(artifactBytes),
    },
    providers: selectedProviders,
    started_at: iso(now),
    plan_sha256: planSha256,
    minimum_duration_ms: plan.minimum_duration_ms,
    minimum_work_cycles: plan.minimum_work_cycles,
    required_interruptions: plan.required_interruptions,
    release_authorized: false,
  }
  writeFresh(path.join(directory, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`)
  writeFresh(path.join(directory, LEDGER_NAME), '')
  return manifest
}

const readEvidence = ({ root, output, planPath = DEFAULT_PLAN }) => {
  const directory = assertOutputDirectory(root, output)
  const manifestPath = path.join(directory, MANIFEST_NAME)
  const ledgerPath = path.join(directory, LEDGER_NAME)
  if (hasSymlinkComponent(manifestPath) || hasSymlinkComponent(ledgerPath)
    || !fs.lstatSync(manifestPath).isFile() || !fs.lstatSync(ledgerPath).isFile()) {
    throw new Error('dogfood manifest and ledger must be regular files without symlinks')
  }
  const manifest = readJson(manifestPath)
  const lines = fs.readFileSync(ledgerPath, 'utf8').split('\n').filter(Boolean)
  const events = lines.map((line) => JSON.parse(line))
  const { plan, digest } = readPlan(planPath)
  return { directory, manifest, events, plan, planSha256: digest }
}

const validateManifest = ({ root, manifest, planSha256, plan, errors }) => {
  const exactKeys = [
    'schema_version', 'purpose', 'repository', 'candidate_commit', 'retained_artifact',
    'providers', 'started_at', 'plan_sha256', 'minimum_duration_ms', 'minimum_work_cycles',
    'required_interruptions', 'release_authorized',
  ]
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)
    || JSON.stringify(Object.keys(manifest).sort()) !== JSON.stringify(exactKeys.sort())) {
    errors.push('manifest has missing or unknown fields')
    return
  }
  if (manifest.schema_version !== 1 || manifest.purpose !== plan.purpose
    || manifest.repository !== plan.repository || manifest.plan_sha256 !== planSha256
    || manifest.minimum_duration_ms !== plan.minimum_duration_ms
    || manifest.minimum_work_cycles !== plan.minimum_work_cycles
    || JSON.stringify(manifest.required_interruptions) !== JSON.stringify(plan.required_interruptions)
    || manifest.release_authorized !== false) errors.push('manifest differs from the immutable QA-016 plan')
  if (!manifest.retained_artifact || typeof manifest.retained_artifact !== 'object'
    || Array.isArray(manifest.retained_artifact)
    || JSON.stringify(Object.keys(manifest.retained_artifact).sort())
      !== JSON.stringify(['bytes', 'path', 'sha256'])) errors.push('manifest retained artifact shape is invalid')
  if (!/^[0-9a-f]{40}$/u.test(manifest.candidate_commit ?? '')) errors.push('manifest candidate commit is invalid')
  else {
    try {
      execFileSync('git', ['cat-file', '-e', `${manifest.candidate_commit}^{commit}`], { cwd: root, stdio: 'ignore' })
    } catch { errors.push('manifest candidate commit does not exist') }
  }
  try {
    assertActiveBinding({ root, manifest })
  } catch (error) { errors.push(error instanceof Error ? error.message : String(error)) }
  try { iso(manifest.started_at) } catch (error) { errors.push(error instanceof Error ? error.message : String(error)) }
  try {
    const normalized = parseProviders((manifest.providers ?? []).join(','), plan.allowed_providers)
    if (JSON.stringify(normalized) !== JSON.stringify(manifest.providers)) errors.push('manifest providers are not unique and canonical')
  } catch (error) { errors.push(error instanceof Error ? error.message : String(error)) }
}

const recordPayload = (record) => ({
  schema_version: record.schema_version,
  sequence: record.sequence,
  observed_at: record.observed_at,
  kind: record.kind,
  provider: record.provider,
  incident_id: record.incident_id,
  evidence: record.evidence,
  previous_record_sha256: record.previous_record_sha256,
})

const recordDigest = (record) => sha256(canonicalJson(recordPayload(record)))

const engineeringReportPasses = (report, plan) => {
  const observedFiles = new Set((report?.testResults ?? []).map((result) => path.basename(result.name ?? '')))
  const requiredFiles = plan.engineering_command
    .filter((argument) => argument.endsWith('.test.ts'))
    .map((argument) => path.basename(argument))
  const statuses = (report?.testResults ?? []).flatMap((result) =>
    (result.assertionResults ?? []).map((assertion) => assertion.status))
  return report?.success === true && report.numFailedTests === 0
    && report.numPendingTests === 0 && report.numTodoTests === 0
    && report.numPassedTests === report.numTotalTests && report.numTotalTests > 0
    && statuses.length >= report.numTotalTests && statuses.every((status) => status === 'passed')
    && requiredFiles.every((file) => observedFiles.has(file))
}

const copyEvidence = ({ directory, sequence, source }) => {
  const evidence = regularFile(source, 'event evidence')
  if (isInside(directory, evidence)) throw new Error('event evidence source must be outside the dogfood evidence directory')
  const safeName = path.basename(evidence).replace(/[^A-Za-z0-9._-]/gu, '_').slice(0, 96) || 'evidence.bin'
  const relative = `artifacts/${String(sequence).padStart(6, '0')}-${safeName}`
  const destination = path.join(directory, relative)
  const bytes = fs.readFileSync(evidence)
  writeFresh(destination, bytes)
  return { path: relative, bytes: bytes.byteLength, sha256: sha256(bytes) }
}

const appendDogfoodEvent = ({
  root,
  output,
  kind,
  evidencePath,
  provider = null,
  incidentId = null,
  now = new Date(),
  planPath = DEFAULT_PLAN,
}) => {
  if (!EVENT_KINDS.has(kind)) throw new Error(`unknown dogfood event kind: ${kind}`)
  const loaded = readEvidence({ root, output, planPath })
  assertActiveBinding({ root, manifest: loaded.manifest })
  const sequence = loaded.events.length + 1
  const isProviderEvent = kind.startsWith('provider_') || kind === 'work_cycle_passed'
  if (isProviderEvent && !loaded.manifest.providers.includes(provider)) {
    throw new Error('provider-bound events require a provider declared in the manifest')
  }
  if (!isProviderEvent && provider !== null) throw new Error('provider is only valid for provider interruption events')
  const isIncident = /^p[01]_(?:opened|resolved)$/u.test(kind)
  if (isIncident !== (typeof incidentId === 'string' && incidentId.length > 0)) {
    throw new Error('P0/P1 events require one non-empty incident id; other events forbid it')
  }
  const event = {
    schema_version: 1,
    sequence,
    observed_at: iso(now),
    kind,
    provider: isProviderEvent ? provider : null,
    incident_id: isIncident ? incidentId : null,
    evidence: copyEvidence({ directory: loaded.directory, sequence, source: evidencePath }),
    previous_record_sha256: loaded.events.at(-1)?.record_sha256 ?? null,
  }
  const complete = { ...event, record_sha256: recordDigest(event) }
  fs.appendFileSync(path.join(loaded.directory, LEDGER_NAME), `${JSON.stringify(complete)}\n`, { mode: 0o600 })
  return complete
}

export function appendDogfoodObservation(input) {
  if (String(input.kind).startsWith('engineering_cycle_')) {
    throw new Error('engineering cycle events can only be created by the pinned cycle command')
  }
  return appendDogfoodEvent(input)
}

const validateEvents = ({ directory, manifest, events, plan, now, errors }) => {
  let previous = null
  let previousTime = Date.parse(manifest.started_at)
  const opened = { p0: new Set(), p1: new Set() }
  for (const [index, event] of events.entries()) {
    const expectedKeys = [
      'schema_version', 'sequence', 'observed_at', 'kind', 'provider', 'incident_id',
      'evidence', 'previous_record_sha256', 'record_sha256',
    ]
    if (!event || typeof event !== 'object' || Array.isArray(event)
      || JSON.stringify(Object.keys(event).sort()) !== JSON.stringify(expectedKeys.sort())
      || event.schema_version !== 1 || event.sequence !== index + 1 || !EVENT_KINDS.has(event.kind)
      || event.previous_record_sha256 !== previous || event.record_sha256 !== recordDigest(event)) {
      errors.push(`event ${index + 1} has invalid shape, sequence, or hash chain`)
      continue
    }
    const observed = Date.parse(event.observed_at)
    if (!Number.isFinite(observed) || observed < previousTime || observed > now.getTime() + 300_000) {
      errors.push(`event ${event.sequence} has a non-monotonic or future timestamp`)
    }
    previousTime = observed
    previous = event.record_sha256
    const evidencePath = path.resolve(directory, event.evidence?.path ?? '')
    const relative = path.relative(directory, evidencePath)
    if (!relative.startsWith('artifacts/') || relative.startsWith('..') || path.isAbsolute(relative)
      || hasSymlinkComponent(evidencePath) || !fs.existsSync(evidencePath)
      || !fs.lstatSync(evidencePath).isFile()) errors.push(`event ${event.sequence} evidence path is invalid`)
    else {
      const bytes = fs.readFileSync(evidencePath)
      if (bytes.byteLength !== event.evidence.bytes || sha256(bytes) !== event.evidence.sha256) {
        errors.push(`event ${event.sequence} evidence digest changed`)
      }
      if (event.kind.startsWith('engineering_cycle_')) {
        let passed = false
        try { passed = engineeringReportPasses(JSON.parse(bytes), plan) } catch { passed = false }
        if ((event.kind === 'engineering_cycle_passed') !== passed) {
          errors.push(`event ${event.sequence} engineering result does not match its retained Vitest JSON`)
        }
      }
    }
    const providerEvent = event.kind.startsWith('provider_') || event.kind === 'work_cycle_passed'
    if ((providerEvent && !manifest.providers.includes(event.provider))
      || (!providerEvent && event.provider !== null)) errors.push(`event ${event.sequence} provider binding is invalid`)
    const incident = /^p([01])_(opened|resolved)$/u.exec(event.kind)
    if ((incident && (typeof event.incident_id !== 'string' || event.incident_id.length === 0))
      || (!incident && event.incident_id !== null)) errors.push(`event ${event.sequence} incident binding is invalid`)
    if (incident) {
      const key = `p${incident[1]}`
      if (incident[2] === 'opened') opened[key].add(event.incident_id)
      else if (!opened[key].delete(event.incident_id)) errors.push(`event ${event.sequence} resolves an unopened ${key.toUpperCase()} incident`)
    }
  }
  return opened
}

const pairedInterruption = (events, interruption, recovery, provider = null) => {
  let waiting = false
  for (const event of events) {
    if (provider !== null && event.provider !== provider) continue
    if (event.kind === interruption) waiting = true
    if (waiting && event.kind === recovery) return true
  }
  return false
}

export function verifyDogfoodEvidence({ root, output, now = new Date(), planPath = DEFAULT_PLAN }) {
  const repository = fs.realpathSync(root)
  const loaded = readEvidence({ root: repository, output, planPath })
  const errors = []
  validateManifest({ root: repository, ...loaded, errors })
  const opened = validateEvents({ ...loaded, now, errors })
  const started = Date.parse(loaded.manifest.started_at)
  const elapsedMs = now.getTime() - started
  if (!Number.isFinite(elapsedMs) || elapsedMs < loaded.plan.minimum_duration_ms) {
    errors.push('minimum 24-hour dogfood duration has not elapsed')
  }
  const workCycles = loaded.events.filter((event) => event.kind === 'work_cycle_passed')
  if (workCycles.length < loaded.plan.minimum_work_cycles) errors.push('too few retained real-work cycles')
  for (const provider of loaded.manifest.providers ?? []) {
    if (!workCycles.some((event) => event.provider === provider)) {
      errors.push(`no retained real-work cycle exists for ${provider}`)
    }
  }
  if (workCycles.length > 0
    && Date.parse(workCycles[0].observed_at) - started > loaded.plan.maximum_first_cycle_delay_ms) {
    errors.push('first retained real-work cycle began too late')
  }
  if (workCycles.length > 0
    && Date.parse(workCycles.at(-1).observed_at) - started < loaded.plan.minimum_duration_ms) {
    errors.push('retained real-work cycles do not span the minimum duration')
  }
  for (const [interruption, recovery] of [
    ['daemon_interrupted', 'daemon_recovered'],
    ['network_interrupted', 'network_recovered'],
  ]) {
    if (!pairedInterruption(loaded.events, interruption, recovery)) errors.push(`missing ordered ${interruption}/${recovery} evidence`)
  }
  for (const provider of loaded.manifest.providers ?? []) {
    if (!pairedInterruption(loaded.events, 'provider_interrupted', 'provider_recovered', provider)) {
      errors.push(`missing ordered provider interruption/recovery evidence for ${provider}`)
    }
  }
  if (opened.p0.size > 0 || opened.p1.size > 0) errors.push('unresolved P0/P1 incidents remain')
  if (!loaded.events.some((event) => event.kind === 'engineering_cycle_passed')) {
    errors.push('no deterministic engineering interruption cycle was retained')
  }
  const complete = errors.length === 0
  const summary = {
    schema_version: 1,
    purpose: loaded.plan.purpose,
    candidate_commit: loaded.manifest.candidate_commit,
    artifact_sha256: loaded.manifest.retained_artifact.sha256,
    observed_at: iso(now),
    elapsed_ms: elapsedMs,
    event_count: loaded.events.length,
    work_cycle_count: workCycles.length,
    providers: loaded.manifest.providers,
    status: complete ? 'eligible_for_independent_review' : 'incomplete',
    qa016_closed: false,
    requires_independent_review: true,
    release_authorized: false,
    errors,
  }
  replaceOwnedFile(path.join(loaded.directory, SUMMARY_NAME), `${JSON.stringify(summary, null, 2)}\n`)
  return summary
}

export function runEngineeringCycle({ root, output, now = new Date(), planPath = DEFAULT_PLAN }) {
  const loaded = readEvidence({ root, output, planPath })
  assertActiveBinding({ root, manifest: loaded.manifest })
  const executable = path.resolve(root, loaded.plan.engineering_command[0])
  if (!fs.existsSync(executable) || !isInside(fs.realpathSync(root), fs.realpathSync(executable))) {
    throw new Error('engineering cycle executable is unavailable inside the repository')
  }
  const execution = spawnSync(executable, loaded.plan.engineering_command.slice(1), {
    cwd: root,
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 64 * 1024 * 1024,
  })
  const temporaryDirectory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-dogfood-cycle-')),
  )
  const log = path.join(temporaryDirectory, 'vitest.json')
  try {
    fs.writeFileSync(log, execution.stdout ?? '', { mode: 0o600 })
    let passed = false
    try {
      const report = JSON.parse(execution.stdout ?? '')
      passed = execution.status === 0 && engineeringReportPasses(report, loaded.plan)
    } catch { passed = false }
    const event = appendDogfoodEvent({
      root, output,
      kind: passed ? 'engineering_cycle_passed' : 'engineering_cycle_failed',
      evidencePath: log,
      now,
      planPath,
    })
    return { passed, event, stderr: execution.stderr ?? '' }
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true })
  }
}

const parseArguments = (argv) => {
  const [command, ...rest] = argv
  if (!['init', 'record', 'cycle', 'verify'].includes(command)) throw new Error('usage: run-beta-dogfood.mjs <init|record|cycle|verify> [options]')
  const values = new Map()
  for (let index = 0; index < rest.length; index += 2) {
    const name = rest[index]
    const value = rest[index + 1]
    if (!name?.startsWith('--') || value === undefined || value.startsWith('--') || values.has(name)) {
      throw new Error('dogfood options must be unique --name value pairs')
    }
    values.set(name, value)
  }
  const required = command === 'init'
    ? ['--output-dir', '--candidate-commit', '--artifact', '--providers']
    : command === 'record'
      ? ['--output-dir', '--kind', '--evidence']
      : ['--output-dir']
  if (required.some((name) => !values.has(name))) throw new Error(`missing required option for ${command}`)
  const allowed = command === 'init'
    ? new Set(['--output-dir', '--candidate-commit', '--artifact', '--providers'])
    : command === 'record'
      ? new Set(['--output-dir', '--kind', '--evidence', '--provider', '--incident-id'])
      : new Set(['--output-dir'])
  for (const name of values.keys()) if (!allowed.has(name)) throw new Error(`unknown option for ${command}: ${name}`)
  return { command, values }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  try {
    const { command, values } = parseArguments(process.argv.slice(2))
    const output = values.get('--output-dir')
    let result
    if (command === 'init') {
      result = initializeDogfoodEvidence({
        root: DEFAULT_ROOT,
        output,
        candidateCommit: values.get('--candidate-commit'),
        artifactPath: values.get('--artifact'),
        providers: values.get('--providers'),
      })
    } else if (command === 'record') {
      result = appendDogfoodObservation({
        root: DEFAULT_ROOT,
        output,
        kind: values.get('--kind'),
        evidencePath: values.get('--evidence'),
        provider: values.get('--provider') ?? null,
        incidentId: values.get('--incident-id') ?? null,
      })
    } else if (command === 'cycle') {
      result = runEngineeringCycle({ root: DEFAULT_ROOT, output })
      if (!result.passed) process.exitCode = 1
    } else {
      result = verifyDogfoodEvidence({ root: DEFAULT_ROOT, output })
      if (result.status !== 'eligible_for_independent_review') process.exitCode = 1
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
