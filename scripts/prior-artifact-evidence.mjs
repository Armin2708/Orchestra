import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

const packageName = 'orchestra-board'
const commitPattern = /^[0-9a-f]{40}$/
const sha256Pattern = /^[0-9a-f]{64}$/
const artifactIdPattern = /^[1-9][0-9]*$/
const semverPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/
const maxJsonBytes = 4 * 1024 * 1024

const invariant = (condition, message) => {
  if (!condition) throw new Error(message)
}

const digest = (algorithm, bytes, encoding = 'hex') =>
  createHash(algorithm).update(bytes).digest(encoding)

const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]))
  }
  return value
}

const sameJson = (left, right) =>
  JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right))

const regularFileBytes = (path, label, maximum = Number.POSITIVE_INFINITY) => {
  const resolved = resolve(path)
  const stat = lstatSync(resolved)
  invariant(stat.isFile() && !stat.isSymbolicLink(), `${label} must be one regular file`)
  invariant(stat.size > 0 && stat.size <= maximum, `${label} has an invalid size`)
  return { resolved, stat, bytes: readFileSync(resolved) }
}

const readJson = (path, label) => {
  const file = regularFileBytes(path, label, maxJsonBytes)
  try {
    return { ...file, value: JSON.parse(file.bytes.toString('utf8')) }
  } catch {
    throw new Error(`${label} is not valid JSON`)
  }
}

const tarballManifest = (artifactPath) => {
  const extracted = spawnSync('tar', ['-xOf', artifactPath, 'package/package.json'], {
    encoding: 'utf8',
    maxBuffer: maxJsonBytes,
  })
  invariant(extracted.status === 0, extracted.stderr.trim() || 'prior artifact manifest is unreadable')
  try {
    return JSON.parse(extracted.stdout)
  } catch {
    throw new Error('prior artifact package manifest is invalid')
  }
}

const tarballInventory = (artifactPath) => {
  const listed = spawnSync('tar', ['-tzf', artifactPath], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
  invariant(listed.status === 0, listed.stderr.trim() || 'prior artifact inventory is unreadable')
  const entries = listed.stdout.split(/\r?\n/).filter(Boolean).filter((entry) => !entry.endsWith('/'))
  invariant(
    entries.every((entry) => entry.startsWith('package/') && !entry.split('/').includes('..')),
    'prior artifact inventory contains an unsafe path',
  )
  return entries.map((entry) => entry.slice('package/'.length)).sort()
}

const exactWorkflowIdentity = (value, label) => {
  invariant(value && typeof value === 'object', `${label} is missing`)
  invariant(String(value.repository ?? '').trim() !== '', `${label} repository is missing`)
  invariant(String(value.event ?? '').trim() !== '', `${label} event is missing`)
  invariant(String(value.ref ?? '').trim() !== '', `${label} ref is missing`)
  invariant(artifactIdPattern.test(String(value.run_id ?? '')), `${label} run id is invalid`)
  invariant(artifactIdPattern.test(String(value.run_attempt ?? '')), `${label} run attempt is invalid`)
  return {
    repository: value.repository,
    event: value.event,
    ref: value.ref,
    run_id: String(value.run_id),
    run_attempt: String(value.run_attempt),
  }
}

export function verifyPriorArtifactEvidence({
  artifactPath,
  evidenceDirectory,
  manifestPath,
  receiptPath,
  publishReceiptPath,
} = {}) {
  invariant(artifactPath, 'prior artifact path is required')
  const artifactFile = regularFileBytes(artifactPath, 'prior package artifact')
  invariant(artifactFile.resolved.endsWith('.tgz'), 'prior package artifact must be a .tgz')
  const artifact = {
    filename: basename(artifactFile.resolved),
    bytes: artifactFile.stat.size,
    sha256: digest('sha256', artifactFile.bytes),
    npm_shasum: digest('sha1', artifactFile.bytes),
    npm_integrity: `sha512-${digest('sha512', artifactFile.bytes, 'base64')}`,
  }
  const packageManifest = tarballManifest(artifactFile.resolved)
  invariant(packageManifest.name === packageName, 'prior artifact package name is invalid')
  invariant(semverPattern.test(String(packageManifest.version ?? '')), 'prior artifact version is invalid')
  artifact.name = packageManifest.name
  artifact.version = packageManifest.version

  const directory = evidenceDirectory ? resolve(evidenceDirectory) : undefined
  invariant(
    directory || (manifestPath && receiptPath),
    'prior exact-commit evidence directory or explicit manifest and receipt paths are required',
  )
  const manifestFile = readJson(
    manifestPath ?? join(directory, 'manifest.json'),
    'prior exact-commit evidence manifest',
  )
  const receiptFile = readJson(
    receiptPath ?? join(directory, 'retained-artifact-receipt.json'),
    'prior retained-artifact receipt',
  )
  const manifest = manifestFile.value
  const receipt = receiptFile.value
  const manifestSha256 = digest('sha256', manifestFile.bytes)
  const receiptSha256 = digest('sha256', receiptFile.bytes)

  invariant(manifest.schema_version === 1, 'prior evidence manifest schema is unsupported')
  invariant(manifest.backlog_item === 'QA-019', 'prior evidence manifest is not exact-commit evidence')
  invariant(commitPattern.test(String(manifest.commit_sha ?? '')), 'prior evidence commit is invalid')
  invariant(manifest.result === 'passed', 'prior exact-commit evidence did not pass')
  const workflowRun = exactWorkflowIdentity(manifest.workflow_run, 'prior evidence workflow')
  invariant(manifest.contract?.workflow === '.github/workflows/ci.yml', 'prior CI workflow is invalid')
  const requiredGates = manifest.contract?.required_gates
  invariant(
    Array.isArray(requiredGates) &&
      ['exact-commit', 'package-artifact', 'package-secret-scan', 'package-upload']
        .every((gate) => requiredGates.includes(gate)) &&
      new Set(requiredGates).size === requiredGates.length,
    'prior exact-commit gate contract is incomplete',
  )
  invariant(Array.isArray(manifest.gates) && manifest.gates.length > 0, 'prior evidence gates are missing')
  invariant(
    manifest.gates.every((gate) =>
      gate?.schema_version === 1 &&
      gate?.commit_sha === manifest.commit_sha &&
      gate?.status === 'passed' &&
      gate?.exit_code === 0),
    'prior evidence contains a non-passing or cross-commit gate',
  )
  invariant(
    sameJson(manifest.gates.map((gate) => gate.gate_id), requiredGates) &&
      manifest.summary?.required === requiredGates.length &&
      manifest.summary?.passed === requiredGates.length &&
      manifest.summary?.failed === 0 &&
      manifest.summary?.missing === 0 &&
      manifest.summary?.unexpected === 0 &&
      manifest.summary?.sha_consistent === true &&
      manifest.summary?.package_consistent === true &&
      manifest.summary?.package_upload_evidence_present === true,
    'prior exact-commit evidence summary is incomplete',
  )
  const uploadGate = manifest.gates.find((gate) => gate.gate_id === 'package-upload')
  invariant(
    uploadGate?.details?.action_outcome === 'success' &&
      artifactIdPattern.test(String(uploadGate?.details?.artifact_id ?? '')) &&
      sha256Pattern.test(String(uploadGate?.details?.artifact_digest ?? '')),
    'prior package upload identity is incomplete',
  )

  const metadata = manifest.package_artifact
  invariant(metadata?.commit_sha === manifest.commit_sha, 'prior package metadata commit is invalid')
  invariant(metadata?.package_name === artifact.name, 'prior package name does not match evidence')
  invariant(metadata?.package_version === artifact.version, 'prior package version does not match evidence')
  invariant(metadata?.filename === artifact.filename, 'prior package filename does not match evidence')
  invariant(metadata?.bytes === artifact.bytes, 'prior package byte count does not match evidence')
  invariant(metadata?.sha256 === artifact.sha256, 'prior package SHA-256 does not match evidence')
  invariant(metadata?.npm_shasum === artifact.npm_shasum, 'prior npm shasum does not match evidence')
  invariant(metadata?.npm_integrity === artifact.npm_integrity, 'prior npm integrity does not match evidence')
  invariant(
    metadata?.provenance?.source_commit === manifest.commit_sha &&
      metadata?.provenance?.builder === 'npm pack',
    'prior package provenance does not match the exact source commit',
  )
  invariant(Array.isArray(metadata?.file_manifest), 'prior package file manifest is missing')
  invariant(
    sameJson(metadata.file_manifest.map((entry) => entry?.path).sort(), tarballInventory(artifactFile.resolved)),
    'prior package inventory does not match exact-commit evidence',
  )

  invariant(receipt.schema_version === 1, 'prior retained-artifact receipt schema is unsupported')
  invariant(
    receipt.kind === 'retained-internal' || receipt.kind === 'published-provenance',
    'prior retained-artifact receipt trust kind is invalid',
  )
  invariant(receipt.decision === 'trusted', 'prior retained artifact is not explicitly trusted')
  invariant(receipt.source_commit === manifest.commit_sha, 'prior receipt commit does not match evidence')
  invariant(receipt.evidence_manifest_sha256 === manifestSha256, 'prior receipt is not bound to evidence')
  invariant(sameJson(receipt.workflow_run, workflowRun), 'prior receipt workflow does not match evidence')
  for (const field of ['name', 'version', 'filename', 'bytes', 'sha256', 'npm_shasum', 'npm_integrity']) {
    invariant(receipt.artifact?.[field] === artifact[field], `prior receipt artifact ${field} is invalid`)
  }
  invariant(
    Number.isFinite(Date.parse(String(receipt.trust?.approved_at ?? ''))) &&
      String(receipt.trust?.approved_by ?? '').trim() !== '' &&
      String(receipt.trust?.approval_id ?? '').trim() !== '' &&
      receipt.trust?.exact_commit_ci_passed === true,
    'prior receipt trust approval is incomplete',
  )

  let publishReceiptSha256 = null
  if (receipt.kind === 'published-provenance') {
    const published = readJson(
      publishReceiptPath ?? join(directory, 'verification-receipt.json'),
      'prior publish verification receipt',
    )
    publishReceiptSha256 = digest('sha256', published.bytes)
    invariant(
      receipt.trust?.verification_receipt_sha256 === publishReceiptSha256,
      'prior publish receipt digest does not match trust approval',
    )
    invariant(
      published.value?.commit_sha === manifest.commit_sha &&
        published.value?.package_name === artifact.name &&
        published.value?.package_version === artifact.version &&
        published.value?.package_sha256 === artifact.sha256 &&
        String(published.value?.workflow_run_id) === workflowRun.run_id &&
        String(published.value?.workflow_run_attempt) === workflowRun.run_attempt,
      'prior publish receipt does not match the retained artifact and workflow',
    )
    invariant(
      receipt.trust?.registry === 'https://registry.npmjs.org' &&
        receipt.trust?.dist_tag === 'beta' &&
        receipt.trust?.npm_provenance_verified === true,
      'prior npm publication provenance is not verified',
    )
  } else {
    invariant(
      String(receipt.trust?.rationale ?? '').trim() !== '',
      'prior retained-internal receipt requires a trust rationale',
    )
  }

  return {
    verified: true,
    trust_kind: receipt.kind,
    source_commit: manifest.commit_sha,
    evidence_manifest_sha256: manifestSha256,
    receipt_sha256: receiptSha256,
    publish_receipt_sha256: publishReceiptSha256,
    workflow_run: workflowRun,
    artifact,
  }
}
