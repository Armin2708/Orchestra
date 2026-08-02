import { spawnSync } from 'node:child_process'
import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalJson, manifestContractBinding } from './exact-commit-contract.mjs'
import { assertTarRegularEntries } from './tar-artifact-integrity.mjs'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const contractPath = join(scriptDirectory, 'exact-commit-ci-contract.json')
const trustRootsPath = join(scriptDirectory, 'prior-artifact-trust-roots.json')

const packageName = 'orchestra-board'
const commitPattern = /^[0-9a-f]{40}$/
const sha256Pattern = /^[0-9a-f]{64}$/
const artifactIdPattern = /^[1-9][0-9]*$/
const semverPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/
const maxJsonBytes = 4 * 1024 * 1024
const trustedRepository = 'Armin2708/Orchestra'
const trustedWorkflow = '.github/workflows/ci.yml'
const trustedEvent = 'push'

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
  assertTarRegularEntries(artifactPath)
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
  invariant(value.repository === trustedRepository, `${label} repository is invalid`)
  invariant(value.event === trustedEvent, `${label} event is invalid`)
  invariant(/^refs\/tags\/v\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/.test(String(value.ref ?? '')), `${label} ref is invalid`)
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

const exactKeys = (value, keys, label) => {
  invariant(
    value && typeof value === 'object' && sameJson(Object.keys(value).sort(), [...keys].sort()),
    `${label} contains missing or unsigned fields`,
  )
}

const completePassingGate = (gate, commitSha) =>
  gate?.schema_version === 1 &&
  gate?.commit_sha === commitSha &&
  gate?.status === 'passed' &&
  gate?.exit_code === 0 &&
  Number.isFinite(Date.parse(String(gate?.started_at ?? ''))) &&
  Number.isFinite(Date.parse(String(gate?.completed_at ?? ''))) &&
  Date.parse(gate.started_at) <= Date.parse(gate.completed_at) &&
  String(gate?.invocation?.executable ?? '').trim() !== '' &&
  gate?.runner && typeof gate.runner === 'object' &&
  String(gate.runner.node_version ?? '').trim() !== '' &&
  gate?.details && typeof gate.details === 'object' && !Array.isArray(gate.details)

const signingKeyId = (key) =>
  `sha256:${digest('sha256', key.export({ format: 'der', type: 'spki' }))}`

const verifyMaintainerSignature = ({ receipt, attestation, trustRoots }) => {
  invariant(trustRoots?.schema_version === 1, 'prior artifact trust-root schema is unsupported')
  invariant(trustRoots.repository === trustedRepository, 'prior artifact trust-root repository is invalid')
  invariant(trustRoots.workflow === trustedWorkflow, 'prior artifact trust-root workflow is invalid')
  invariant(trustRoots.event === trustedEvent, 'prior artifact trust-root event is invalid')
  invariant(
    Array.isArray(trustRoots.trusted_signing_keys) && trustRoots.trusted_signing_keys.length > 0,
    'no trusted prior-artifact signing key is configured',
  )
  exactKeys(receipt, ['schema_version', 'kind', 'attestation', 'signature'], 'prior retained-artifact receipt')
  exactKeys(receipt.signature, ['algorithm', 'key_id', 'value'], 'prior retained-artifact signature')
  invariant(receipt.schema_version === 2, 'prior retained-artifact receipt schema is unsupported')
  invariant(receipt.kind === 'maintainer-signature', 'prior retained-artifact receipt trust kind is unsupported')
  invariant(receipt.signature.algorithm === 'ed25519', 'prior retained-artifact signature algorithm is unsupported')
  const trusted = trustRoots.trusted_signing_keys.find((entry) =>
    entry?.key_id === receipt.signature.key_id && entry?.algorithm === 'ed25519')
  invariant(trusted, 'prior retained-artifact signing key is not trusted')
  const publicKey = createPublicKey(trusted.public_key_pem)
  invariant(publicKey.asymmetricKeyType === 'ed25519', 'prior artifact trust root is not an Ed25519 key')
  invariant(signingKeyId(publicKey) === trusted.key_id, 'prior artifact trust-root key id is invalid')
  const encodedSignature = String(receipt.signature.value ?? '')
  invariant(/^[A-Za-z0-9+/]+={0,2}$/.test(encodedSignature), 'prior retained-artifact signature encoding is invalid')
  const signature = Buffer.from(encodedSignature, 'base64')
  invariant(signature.byteLength === 64, 'prior retained-artifact signature length is invalid')
  invariant(
    verifySignature(null, Buffer.from(canonicalJson(attestation)), publicKey, signature),
    'prior retained-artifact signature verification failed',
  )
  return trusted.key_id
}

export function verifyPriorArtifactEvidence({
  artifactPath,
  evidenceDirectory,
  manifestPath,
  receiptPath,
  trustRoots,
} = {}) {
  invariant(artifactPath, 'prior artifact path is required')
  const artifactFile = regularFileBytes(artifactPath, 'prior package artifact')
  invariant(artifactFile.resolved.endsWith('.tgz'), 'prior package artifact must be a .tgz')
  assertTarRegularEntries(artifactFile.resolved)
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
  const checkedContract = readJson(contractPath, 'checked exact-commit contract').value
  const checkedTrustRoots = trustRoots ?? readJson(trustRootsPath, 'prior artifact trust roots').value
  const manifestSha256 = digest('sha256', manifestFile.bytes)
  const receiptSha256 = digest('sha256', receiptFile.bytes)

  invariant(manifest.schema_version === 1, 'prior evidence manifest schema is unsupported')
  invariant(manifest.backlog_item === 'QA-019', 'prior evidence manifest is not exact-commit evidence')
  invariant(commitPattern.test(String(manifest.commit_sha ?? '')), 'prior evidence commit is invalid')
  invariant(manifest.result === 'passed', 'prior exact-commit evidence did not pass')
  const workflowRun = exactWorkflowIdentity(manifest.workflow_run, 'prior evidence workflow')
  invariant(
    workflowRun.ref === `refs/tags/v${artifact.version}`,
    'prior evidence workflow ref does not match the retained artifact version',
  )
  invariant(
    sameJson(manifest.contract, manifestContractBinding(checkedContract)),
    'prior CI contract does not match the complete checked-in contract',
  )
  const requiredGates = manifest.contract?.required_gates
  invariant(
    sameJson(requiredGates, checkedContract.required_gates),
    'prior exact-commit gate contract does not match the checked-in contract',
  )
  invariant(Array.isArray(manifest.gates), 'prior evidence gates are missing')
  invariant(
    manifest.gates.every((gate) => completePassingGate(gate, manifest.commit_sha)),
    'prior evidence contains an incomplete, non-passing, or cross-commit gate outcome',
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
  invariant(
    Array.isArray(manifest.unexpected_gates) && manifest.unexpected_gates.length === 0,
    'prior exact-commit evidence contains unexpected gates',
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

  const expectedAttestation = {
    schema_version: 1,
    repository: trustedRepository,
    workflow: trustedWorkflow,
    event: trustedEvent,
    ref: `refs/tags/v${artifact.version}`,
    tag: `v${artifact.version}`,
    source_commit: manifest.commit_sha,
    workflow_run: {
      run_id: workflowRun.run_id,
      run_attempt: workflowRun.run_attempt,
    },
    package_upload: {
      artifact_id: String(uploadGate.details.artifact_id),
      artifact_digest: uploadGate.details.artifact_digest,
    },
    evidence_manifest: {
      sha256: manifestSha256,
      contract_schema_version: manifest.contract.contract_schema_version,
      contract_sha256: manifest.contract.contract_sha256,
    },
    artifact,
  }
  invariant(
    sameJson(receipt.attestation, expectedAttestation),
    'prior retained-artifact attestation does not exactly match artifact, contract, workflow, and upload evidence',
  )
  const signingKey = verifyMaintainerSignature({
    receipt,
    attestation: expectedAttestation,
    trustRoots: checkedTrustRoots,
  })

  return {
    verified: true,
    trust_kind: receipt.kind,
    signing_key_id: signingKey,
    source_commit: manifest.commit_sha,
    evidence_manifest_sha256: manifestSha256,
    receipt_sha256: receiptSha256,
    contract_sha256: manifest.contract.contract_sha256,
    workflow_run: workflowRun,
    artifact,
  }
}
