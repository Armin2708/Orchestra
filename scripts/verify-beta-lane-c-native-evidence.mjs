import { createHash } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const evidenceRoot = fileURLToPath(new URL(
  '../docs/evidence/beta-lane-c-native-historical/',
  import.meta.url,
))
const manifestPath = path.join(evidenceRoot, 'manifest.json')
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))

if (manifest.schema_version !== 1
  || manifest.classification !== 'historical-non-gating'
  || manifest.exact_marker_bound !== false
  || manifest.exact_artifact_digest !== null
  || !Array.isArray(manifest.claims_not_supported)
  || !manifest.claims_not_supported.includes('REM-017 completion')
  || !manifest.claims_not_supported.includes('REM-GATE completion')
  || !Array.isArray(manifest.files)
  || manifest.files.length !== 5) {
  throw new Error('native evidence manifest must remain explicit historical non-gating evidence')
}

const canonicalRoot = await realpath(evidenceRoot)
const verified = []
for (const entry of manifest.files) {
  if (!entry || typeof entry !== 'object'
    || typeof entry.path !== 'string'
    || !/^[a-z0-9][a-z0-9-]*\.png$/u.test(entry.path)
    || !Number.isSafeInteger(entry.bytes)
    || !Number.isSafeInteger(entry.width)
    || !Number.isSafeInteger(entry.height)
    || !/^[a-f0-9]{64}$/u.test(entry.sha256)) {
    throw new Error('native evidence manifest contains an invalid file entry')
  }
  const candidate = await realpath(path.join(canonicalRoot, entry.path))
  if (path.dirname(candidate) !== canonicalRoot) throw new Error('native evidence path escapes its manifest directory')
  const metadata = await stat(candidate)
  if (!metadata.isFile() || metadata.size !== entry.bytes) throw new Error(`native evidence byte size differs: ${entry.path}`)
  const bytes = await readFile(candidate)
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (digest !== entry.sha256) throw new Error(`native evidence digest differs: ${entry.path}`)
  if (bytes.length < 24 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
    || bytes.readUInt32BE(16) !== entry.width || bytes.readUInt32BE(20) !== entry.height) {
    throw new Error(`native evidence PNG dimensions differ: ${entry.path}`)
  }
  verified.push({ path: entry.path, bytes: entry.bytes, sha256: digest })
}

process.stdout.write(`${JSON.stringify({
  evidence_id: manifest.evidence_id,
  exact_marker_bound: false,
  gate_status: 'open',
  verified,
}, null, 2)}\n`)
