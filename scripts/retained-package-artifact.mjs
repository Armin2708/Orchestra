import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { assertTarRegularEntries } from './tar-artifact-integrity.mjs'

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

const readMetadata = (file) => {
  const resolved = path.resolve(file)
  if (!fs.existsSync(resolved) || hasSymlinkComponent(resolved)) {
    throw new Error('retained artifact metadata is missing or uses a symlink')
  }
  const stat = fs.lstatSync(resolved)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 16 * 1024 * 1024) {
    throw new Error('retained artifact metadata must be one bounded regular JSON file')
  }
  try {
    return JSON.parse(fs.readFileSync(resolved, 'utf8'))
  } catch {
    throw new Error('retained artifact metadata is not valid JSON')
  }
}

export const inspectRetainedPackageArtifact = ({ artifactDirectory, commit, sourceVersion }) => {
  if (!artifactDirectory) return { ok: false, blocker: 'supply the retained candidate artifact directory' }
  const directory = path.resolve(artifactDirectory)
  if (!fs.existsSync(directory) || hasSymlinkComponent(directory)
    || !fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink()) {
    return { ok: false, blocker: 'retained artifact directory is missing, symlinked, or not a directory' }
  }
  try {
    const metadata = readMetadata(path.join(directory, 'package-metadata.json'))
    const filename = String(metadata.filename ?? '')
    const tarball = path.join(directory, filename)
    if (path.basename(filename) !== filename || !filename.endsWith('.tgz')
      || !fs.existsSync(tarball) || hasSymlinkComponent(tarball)) {
      throw new Error('metadata does not identify one retained tarball')
    }
    const stat = fs.lstatSync(tarball)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1) {
      throw new Error('retained tarball is not one non-empty regular file')
    }
    assertTarRegularEntries(tarball)
    const digest = sha256(fs.readFileSync(tarball))
    const checksumPath = path.join(directory, `${filename}.sha256`)
    const checksum = fs.existsSync(checksumPath) && !hasSymlinkComponent(checksumPath)
      ? fs.readFileSync(checksumPath, 'utf8').trim()
      : ''
    const exact = metadata.schema_version === 1 && metadata.commit_sha === commit
      && metadata.package_version === sourceVersion && metadata.filename === filename
      && metadata.bytes === stat.size && metadata.sha256 === digest
      && checksum === `${digest}  ${filename}`
      && metadata.source_identity?.expected_commit === commit
      && metadata.source_identity?.observed_commit === commit
      && metadata.source_identity?.tracked_source_clean === true
      && metadata.source_identity?.packaged_nonbuild_inputs_tracked === true
      && metadata.reproducibility?.byte_identical === true
      && metadata.reproducibility?.second_pack_sha256 === digest
    if (!exact) {
      throw new Error('retained tarball metadata, checksum, source identity, or reproducibility does not bind exact HEAD')
    }
    return {
      ok: true,
      identity: { filename, version: metadata.package_version, bytes: stat.size, sha256: digest },
      rollbackPassed: metadata.lifecycle?.passed === true
        && metadata.lifecycle?.release_gate?.status === 'passed'
        && metadata.lifecycle?.release_gate?.prior_evidence_verified === true
        && metadata.lifecycle?.upgrade?.passed === true
        && metadata.lifecycle?.rollback?.passed === true
        && metadata.lifecycle?.previous_artifact?.sha256 !== digest
        && metadata.lifecycle?.previous_artifact?.version !== metadata.package_version,
    }
  } catch (error) {
    return { ok: false, blocker: error instanceof Error ? error.message : String(error) }
  }
}
