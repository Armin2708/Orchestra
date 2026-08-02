import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalJson } from './exact-commit-contract.mjs'

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url))

export const BETA_QUALITY_PURPOSE = 'orchestra-beta-quality-integration-v1'
export const BETA_QUALITY_REPOSITORY = 'Armin2708/Orchestra'
export const BETA_QUALITY_AUTHORIZATION_SCOPE = 'qa-018-evidence-only'
export const DEFAULT_BETA_QUALITY_TRUST_ROOTS = path.join(
  SCRIPT_DIRECTORY,
  'beta-quality-trust-roots.json',
)
export const PINNED_BETA_QUALITY_TRUST_ROOTS_SHA256 =
  '33a3f67a6057e491df59f907b0b73e7cd6cdb6e942f22cde4d61afa2b110d7ae'

const MAX_JSON_BYTES = 4 * 1024 * 1024
const SHA256_PATTERN = /^[0-9a-f]{64}$/u
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/u

const invariant = (condition, message) => {
  if (!condition) throw new Error(message)
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

const exactKeys = (value, expected, label) => {
  invariant(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} is missing`)
  invariant(
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort()),
    `${label} contains missing or unsigned fields`,
  )
}

const hasSymlinkComponent = (target) => {
  let current = path.parse(path.resolve(target)).root
  for (const segment of path.resolve(target).slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment)
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) return true
  }
  return false
}

const regularJsonFile = (file, label) => {
  const resolved = path.resolve(file)
  invariant(fs.existsSync(resolved), `${label} is missing`)
  invariant(!hasSymlinkComponent(resolved), `${label} must not use a symlink`)
  const stat = fs.lstatSync(resolved)
  invariant(stat.isFile() && !stat.isSymbolicLink(), `${label} must be one regular file`)
  invariant(stat.size > 0 && stat.size <= MAX_JSON_BYTES, `${label} has an invalid size`)
  const bytes = fs.readFileSync(resolved)
  let value
  try {
    value = JSON.parse(bytes.toString('utf8'))
  } catch {
    throw new Error(`${label} is not valid JSON`)
  }
  return { resolved, bytes, value }
}

const signingKeyId = (key) =>
  `sha256:${sha256(key.export({ format: 'der', type: 'spki' }))}`

export const betaQualitySigningPayload = (attestation) => Buffer.from(
  `${BETA_QUALITY_PURPOSE}\0${canonicalJson(attestation)}`,
  'utf8',
)

const verifyWithTrustRoots = ({ manifestPath, receiptPath, trustRoots }) => {
  const manifestFile = regularJsonFile(manifestPath, 'beta quality integration manifest')
  const receiptFile = regularJsonFile(receiptPath, 'beta quality signature receipt')
  const manifest = manifestFile.value
  const receipt = receiptFile.value

  exactKeys(
    trustRoots,
    ['schema_version', 'purpose', 'repository', 'authorization_scope', 'trusted_signing_keys'],
    'beta quality trust roots',
  )
  invariant(trustRoots.schema_version === 1, 'beta quality trust-root schema is unsupported')
  invariant(trustRoots.purpose === BETA_QUALITY_PURPOSE, 'beta quality trust-root purpose is invalid')
  invariant(trustRoots.repository === BETA_QUALITY_REPOSITORY, 'beta quality trust-root repository is invalid')
  invariant(
    trustRoots.authorization_scope === BETA_QUALITY_AUTHORIZATION_SCOPE,
    'beta quality trust-root authorization scope is invalid',
  )
  invariant(
    Array.isArray(trustRoots.trusted_signing_keys) && trustRoots.trusted_signing_keys.length > 0,
    'no trusted beta-quality signing key is configured',
  )

  exactKeys(
    manifest,
    [
      'schema_version', 'purpose', 'repository', 'base_ref', 'integrator_commit',
      'authorization_scope', 'public_release_authorized', 'slices', 'unresolved_findings',
    ],
    'beta quality integration manifest',
  )
  invariant(manifest.schema_version === 2, 'beta quality integration manifest schema is unsupported')
  invariant(manifest.purpose === BETA_QUALITY_PURPOSE, 'beta quality integration manifest purpose is invalid')
  invariant(manifest.repository === BETA_QUALITY_REPOSITORY, 'beta quality integration manifest repository is invalid')
  invariant(COMMIT_PATTERN.test(String(manifest.base_ref ?? '')), 'beta quality integration manifest base is invalid')
  invariant(COMMIT_PATTERN.test(String(manifest.integrator_commit ?? '')), 'beta quality integration manifest commit is invalid')
  invariant(
    manifest.authorization_scope === BETA_QUALITY_AUTHORIZATION_SCOPE,
    'beta quality integration manifest authorization scope is invalid',
  )
  invariant(
    manifest.public_release_authorized === false,
    'beta quality evidence must not authorize a public release',
  )

  exactKeys(receipt, ['schema_version', 'kind', 'attestation', 'signature'], 'beta quality signature receipt')
  exactKeys(
    receipt.attestation,
    ['purpose', 'repository', 'manifest_sha256', 'integrator_commit', 'signed_at', 'authorization_scope'],
    'beta quality signed attestation',
  )
  exactKeys(receipt.signature, ['algorithm', 'key_id', 'value'], 'beta quality signature')
  invariant(receipt.schema_version === 1, 'beta quality signature receipt schema is unsupported')
  invariant(receipt.kind === 'qa-018-evidence-signature', 'beta quality signature receipt kind is unsupported')
  invariant(receipt.signature.algorithm === 'ed25519', 'beta quality signature algorithm is unsupported')
  invariant(
    receipt.attestation.purpose === BETA_QUALITY_PURPOSE &&
      receipt.attestation.repository === BETA_QUALITY_REPOSITORY &&
      receipt.attestation.manifest_sha256 === sha256(manifestFile.bytes) &&
      receipt.attestation.integrator_commit === manifest.integrator_commit &&
      receipt.attestation.authorization_scope === BETA_QUALITY_AUTHORIZATION_SCOPE,
    'beta quality signed attestation does not exactly bind the manifest and QA-only scope',
  )
  invariant(
    SHA256_PATTERN.test(String(receipt.attestation.manifest_sha256 ?? '')),
    'beta quality manifest digest is invalid',
  )
  invariant(
    Number.isFinite(Date.parse(String(receipt.attestation.signed_at ?? ''))),
    'beta quality signature time is invalid',
  )

  const matchingKey = trustRoots.trusted_signing_keys.find((entry) =>
    entry?.key_id === receipt.signature.key_id && entry?.algorithm === 'ed25519')
  invariant(matchingKey, 'beta quality signing key is not trusted')
  exactKeys(
    matchingKey,
    ['algorithm', 'key_id', 'public_key_pem', 'signer', 'status'],
    'beta quality trust-root entry',
  )
  invariant(matchingKey.status !== 'revoked', 'beta quality signing key is revoked')
  invariant(matchingKey.status === 'active', 'beta quality signing key status is invalid')
  invariant(typeof matchingKey.signer === 'string' && matchingKey.signer.length > 0, 'beta quality signer identity is invalid')

  const publicKey = createPublicKey(matchingKey.public_key_pem)
  invariant(publicKey.asymmetricKeyType === 'ed25519', 'beta quality trust root is not an Ed25519 key')
  invariant(signingKeyId(publicKey) === matchingKey.key_id, 'beta quality trust-root key id is invalid')
  const encodedSignature = String(receipt.signature.value ?? '')
  invariant(BASE64_PATTERN.test(encodedSignature), 'beta quality signature encoding is invalid')
  const signature = Buffer.from(encodedSignature, 'base64')
  invariant(signature.byteLength === 64, 'beta quality signature length is invalid')
  invariant(
    verifySignature(null, betaQualitySigningPayload(receipt.attestation), publicKey, signature),
    'beta quality signature verification failed',
  )

  return {
    verified: true,
    purpose: BETA_QUALITY_PURPOSE,
    repository: BETA_QUALITY_REPOSITORY,
    authorization_scope: BETA_QUALITY_AUTHORIZATION_SCOPE,
    public_release_authorized: false,
    integrator_commit: manifest.integrator_commit,
    manifest_sha256: sha256(manifestFile.bytes),
    receipt_sha256: sha256(receiptFile.bytes),
    signing_key_id: matchingKey.key_id,
    signer: matchingKey.signer,
    signed_at: receipt.attestation.signed_at,
  }
}

export function verifyBetaQualitySignature({ manifestPath, receiptPath } = {}) {
  invariant(manifestPath, 'beta quality integration manifest path is required')
  invariant(receiptPath, 'beta quality signature receipt path is required')
  const trustRootFile = regularJsonFile(DEFAULT_BETA_QUALITY_TRUST_ROOTS, 'beta quality trust roots')
  invariant(
    sha256(trustRootFile.bytes) === PINNED_BETA_QUALITY_TRUST_ROOTS_SHA256,
    'beta quality trust roots differ from the pinned immutable digest',
  )
  return verifyWithTrustRoots({ manifestPath, receiptPath, trustRoots: trustRootFile.value })
}

export function verifyBetaQualitySignatureForTesting({ manifestPath, receiptPath, testOnlyTrustRoots } = {}) {
  invariant(process.env.VITEST === 'true', 'test-only beta quality trust injection is unavailable outside Vitest')
  invariant(testOnlyTrustRoots, 'test-only beta quality trust roots are required')
  return verifyWithTrustRoots({ manifestPath, receiptPath, trustRoots: testOnlyTrustRoots })
}
