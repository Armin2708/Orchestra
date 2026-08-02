#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  constants as fsConstants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const contractPath = join(scriptDirectory, 'exact-commit-ci-contract.json')
const commitShaPattern = /^[0-9a-f]{40}$/
const sha256Pattern = /^[0-9a-f]{64}$/
const sha1Pattern = /^[0-9a-f]{40}$/
const artifactIdPattern = /^[1-9][0-9]*$/
const maxJsonBytes = 1024 * 1024
const requiredPackageFiles = [
  'README.md',
  '.claude-plugin/plugin.json',
  '.codex-plugin/plugin.json',
  'dist/cli.js',
  'environment-compatibility.json',
  'hooks/codex-hooks.json',
  'hooks/hooks.json',
  'package.json',
  'docs/beta-release-operations.md',
  'web/dist/index.html',
]

const invariant = (condition, message) => {
  if (!condition) throw new Error(message)
}

const requiredString = (value, label, pattern) => {
  const normalized = String(value ?? '').trim()
  invariant(normalized !== '', `${label} is required`)
  if (pattern) invariant(pattern.test(normalized), `${label} is invalid`)
  return normalized
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const sha1 = (bytes) => createHash('sha1').update(bytes).digest('hex')
const integrity = (bytes) => `sha512-${createHash('sha512').update(bytes).digest('base64')}`

const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    )
  }
  return value
}

const sameJson = (left, right) =>
  JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right))

const readJson = (path, label) => {
  const stat = lstatSync(path)
  invariant(stat.isFile() && !stat.isSymbolicLink(), `${label} must be one regular file`)
  invariant(stat.size > 0 && stat.size <= maxJsonBytes, `${label} has an invalid size`)
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw new Error(`${label} is not valid JSON`)
  }
}

const exactRegularFiles = (directory, label) => {
  const stat = lstatSync(directory)
  invariant(stat.isDirectory() && !stat.isSymbolicLink(), `${label} must be one real directory`)
  const entries = readdirSync(directory, { withFileTypes: true })
  for (const entry of entries) {
    invariant(entry.isFile() && !entry.isSymbolicLink(), `${label} contains non-file ${entry.name}`)
  }
  return entries.map((entry) => entry.name).sort()
}

const tarballPackageJson = (tarball) => {
  const extracted = spawnSync('tar', ['-xOf', tarball, 'package/package.json'], {
    encoding: 'utf8',
    maxBuffer: maxJsonBytes,
  })
  invariant(
    extracted.status === 0,
    extracted.stderr.trim() || 'package artifact has no readable package/package.json',
  )
  try {
    return JSON.parse(extracted.stdout)
  } catch {
    throw new Error('package artifact contains an invalid package/package.json')
  }
}

const tarballFileInventory = (tarball) => {
  const listed = spawnSync('tar', ['-tzf', tarball], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
  invariant(listed.status === 0, listed.stderr.trim() || 'package artifact inventory is unreadable')
  const files = listed.stdout.split(/\r?\n/).filter(Boolean).filter((entry) => !entry.endsWith('/'))
  invariant(
    files.every((entry) => entry.startsWith('package/') && !entry.split('/').includes('..')),
    'package artifact inventory contains an unsafe path',
  )
  return files.map((entry) => entry.slice('package/'.length)).sort()
}

const expectedManifestContract = (contract) => ({
  workflow: contract.workflow,
  runner: contract.runner,
  node_version: contract.node_version,
  npm_version: contract.npm_version,
  codex_cli_version: contract.codex_cli_version,
  artifact_retention_days: contract.artifact_retention_days,
  accepted_moderate_packages_by_gate: contract.accepted_moderate_packages_by_gate,
  action_pins: contract.action_pins,
  required_gates: contract.required_gates,
})

const prepareOutputDirectory = (directory) => {
  if (existsSync(directory)) {
    const entries = exactRegularFiles(directory, 'verified output directory')
    invariant(entries.length === 0, 'verified output directory must be empty')
  } else {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
  }
}

export function verifyPublishArtifact({
  packageDirectory,
  evidenceDirectory,
  outputDirectory,
  sourcePackagePath,
  expectedSha,
  expectedTag,
  expectedRepository,
  expectedEvent,
  expectedRef,
  expectedRunId,
  expectedRunAttempt,
  packageArtifactId,
  packageArtifactDigest,
  evidenceArtifactId,
  evidenceArtifactDigest,
}) {
  const commitSha = requiredString(expectedSha, 'expected commit SHA', commitShaPattern)
  const tag = requiredString(expectedTag, 'expected tag')
  const repository = requiredString(expectedRepository, 'expected repository')
  const event = requiredString(expectedEvent, 'expected event')
  const ref = requiredString(expectedRef, 'expected ref')
  const runId = requiredString(expectedRunId, 'expected workflow run id', artifactIdPattern)
  const runAttempt = requiredString(expectedRunAttempt, 'expected workflow run attempt', artifactIdPattern)
  const packageId = requiredString(packageArtifactId, 'package artifact id', artifactIdPattern)
  const packageDigest = requiredString(
    packageArtifactDigest,
    'package artifact digest',
    sha256Pattern,
  )
  const evidenceId = requiredString(evidenceArtifactId, 'evidence artifact id', artifactIdPattern)
  const evidenceDigest = requiredString(
    evidenceArtifactDigest,
    'evidence artifact digest',
    sha256Pattern,
  )
  invariant(packageId !== evidenceId, 'package and evidence artifact ids must differ')

  const resolvedPackageDirectory = resolve(packageDirectory)
  const resolvedEvidenceDirectory = resolve(evidenceDirectory)
  const resolvedOutputDirectory = resolve(outputDirectory)
  const packageFiles = exactRegularFiles(resolvedPackageDirectory, 'package artifact')
  const tarballs = packageFiles.filter((file) => file.endsWith('.tgz'))
  invariant(tarballs.length === 1, 'package artifact must contain exactly one .tgz')
  const tarballName = tarballs[0]
  const expectedPackageFiles = [
    tarballName,
    `${tarballName}.sha256`,
    'package-metadata.json',
  ].sort()
  invariant(
    sameJson(packageFiles, expectedPackageFiles),
    'package artifact contains missing or unexpected files',
  )
  const evidenceFiles = exactRegularFiles(resolvedEvidenceDirectory, 'evidence artifact')
  invariant(
    sameJson(evidenceFiles, ['manifest.json']),
    'evidence artifact must contain only manifest.json',
  )

  const tarballPath = join(resolvedPackageDirectory, tarballName)
  const tarballStat = lstatSync(tarballPath)
  invariant(
    tarballStat.isFile() && !tarballStat.isSymbolicLink() && tarballStat.size > 0,
    'package tarball must be one non-empty regular file',
  )
  const tarballBytes = readFileSync(tarballPath)
  const actualSha256 = sha256(tarballBytes)
  const metadata = readJson(
    join(resolvedPackageDirectory, 'package-metadata.json'),
    'package metadata',
  )
  const checksum = readFileSync(
    join(resolvedPackageDirectory, `${tarballName}.sha256`),
    'utf8',
  ).trim()

  invariant(metadata.schema_version === 1, 'package metadata schema is unsupported')
  invariant(metadata.commit_sha === commitSha, 'package metadata commit does not match the tag commit')
  invariant(metadata.filename === tarballName, 'package metadata filename does not match the tarball')
  invariant(metadata.bytes === tarballBytes.byteLength, 'package metadata byte count does not match')
  invariant(metadata.sha256 === actualSha256, 'package tarball SHA-256 does not match metadata')
  invariant(checksum === `${actualSha256}  ${tarballName}`, 'package checksum file does not match')
  invariant(sha1Pattern.test(String(metadata.npm_shasum ?? '')), 'package npm shasum is invalid')
  invariant(metadata.npm_shasum === sha1(tarballBytes), 'package npm shasum does not match')
  invariant(metadata.npm_integrity === integrity(tarballBytes), 'package npm integrity does not match')
  invariant(
    sameJson(metadata.required_files, requiredPackageFiles),
    'package metadata required-file inventory does not match the release contract',
  )
  invariant(Array.isArray(metadata.file_manifest), 'package file manifest is missing')
  const manifestPaths = metadata.file_manifest.map((entry) => entry?.path).sort()
  invariant(
    sameJson(manifestPaths, tarballFileInventory(tarballPath)),
    'package file manifest does not match the retained tarball',
  )
  invariant(
    metadata.release_channel?.name === 'beta' &&
      metadata.release_channel?.opt_in === true &&
      metadata.release_channel?.stable_promotion === false,
    'package metadata is not an opt-in beta artifact',
  )
  invariant(
    metadata.provenance?.source_commit === commitSha && metadata.provenance?.builder === 'npm pack',
    'package provenance does not match the release commit and builder',
  )
  invariant(
    metadata.reproducibility?.byte_identical === true &&
      metadata.reproducibility?.second_pack_sha256 === actualSha256 &&
      metadata.reproducibility?.scripts_disabled_for_second_pack === true,
    'package byte reproducibility evidence is incomplete',
  )
  invariant(
    metadata.lifecycle?.passed === true &&
      metadata.lifecycle?.artifact?.sha256 === actualSha256 &&
      metadata.lifecycle?.package_install_scripts_absent === true &&
      metadata.lifecycle?.dependency_install_scripts_allowed === true &&
      metadata.lifecycle?.provider_hooks_reversible === true &&
      metadata.lifecycle?.state_preserved_after_upgrade === true &&
      metadata.lifecycle?.state_preserved_after_uninstall === true &&
      metadata.lifecycle?.project_preserved_after_uninstall === true &&
      metadata.lifecycle?.package_removed === true &&
      metadata.lifecycle?.runtime?.doctor_contract === true &&
      metadata.lifecycle?.runtime?.daemon_health === true &&
      metadata.lifecycle?.runtime?.web_index_served === true &&
      metadata.lifecycle?.audit?.executed === true &&
      metadata.lifecycle?.audit?.high === 0 &&
      metadata.lifecycle?.audit?.critical === 0 &&
      metadata.lifecycle?.audit?.passed === true,
    'package clean-consumer lifecycle evidence is incomplete',
  )
  invariant(
    metadata.markdown_links?.passed === true &&
      metadata.markdown_links?.markdown_files > 0,
    'packaged Markdown link verification did not pass',
  )
  invariant(metadata.install_smoke?.passed === true, 'package install smoke did not pass')
  invariant(
    metadata.install_smoke?.scripts_disabled === true,
    'package install smoke did not use the no-scripts safety boundary',
  )
  invariant(
    metadata.install_smoke?.cli_version === metadata.package_version,
    'package install smoke version does not match package metadata',
  )

  const sourcePackage = readJson(resolve(sourcePackagePath), 'source package manifest')
  invariant(
    /^\d+\.\d+\.\d+-[0-9A-Za-z][0-9A-Za-z.-]*$/.test(String(sourcePackage.version ?? '')),
    'beta publication requires an explicit SemVer prerelease package version',
  )
  invariant(tag === `v${sourcePackage.version}`, 'tag does not match the source package version')
  invariant(ref === `refs/tags/${tag}`, 'workflow ref does not match the release tag')
  invariant(metadata.package_name === sourcePackage.name, 'package name does not match source')
  invariant(metadata.package_version === sourcePackage.version, 'package version does not match source')

  const embeddedPackage = tarballPackageJson(tarballPath)
  invariant(embeddedPackage.name === sourcePackage.name, 'tarball package name does not match source')
  invariant(embeddedPackage.version === sourcePackage.version, 'tarball package version does not match source')
  invariant(
    embeddedPackage.bin?.orchestra === './dist/cli.js',
    'tarball package executable does not match the release contract',
  )

  const manifestPath = join(resolvedEvidenceDirectory, 'manifest.json')
  const manifestBytes = readFileSync(manifestPath)
  const manifest = readJson(manifestPath, 'evidence manifest')
  const contract = readJson(contractPath, 'CI evidence contract')
  invariant(manifest.schema_version === contract.schema_version, 'evidence manifest schema is unsupported')
  invariant(manifest.backlog_item === 'QA-019', 'evidence manifest is not QA-019 evidence')
  invariant(manifest.commit_sha === commitSha, 'evidence manifest commit does not match the tag commit')
  invariant(manifest.result === 'passed', 'evidence manifest did not pass')
  invariant(
    sameJson(manifest.contract, expectedManifestContract(contract)),
    'evidence manifest contract does not match checked-out source',
  )
  invariant(
    manifest.workflow_run?.repository === repository &&
      manifest.workflow_run?.event === event &&
      manifest.workflow_run?.ref === ref &&
      manifest.workflow_run?.run_id === runId &&
      manifest.workflow_run?.run_attempt === runAttempt,
    'evidence manifest does not belong to this workflow run and ref',
  )
  invariant(
    Number.isFinite(Date.parse(String(manifest.generated_at ?? ''))),
    'evidence manifest generated_at is invalid',
  )
  invariant(
    sameJson(manifest.package_artifact, metadata),
    'evidence manifest package metadata does not match the downloaded package artifact',
  )
  invariant(Array.isArray(manifest.gates), 'evidence manifest gates are missing')
  invariant(
    sameJson(
      manifest.gates.map((gate) => gate.gate_id),
      contract.required_gates,
    ),
    'evidence manifest gate inventory does not match the release contract',
  )
  invariant(
    manifest.gates.every((gate) =>
      gate.schema_version === 1 &&
      gate.commit_sha === commitSha &&
      gate.status === 'passed' &&
      gate.exit_code === 0),
    'evidence manifest contains a non-passing or cross-commit gate',
  )
  invariant(
    manifest.summary?.required === contract.required_gates.length &&
      manifest.summary?.passed === contract.required_gates.length &&
      manifest.summary?.failed === 0 &&
      manifest.summary?.missing === 0 &&
      manifest.summary?.unexpected === 0 &&
      manifest.summary?.sha_consistent === true &&
      manifest.summary?.package_consistent === true &&
      manifest.summary?.package_upload_evidence_present === true,
    'evidence manifest summary is not a complete passing result',
  )
  invariant(
    Array.isArray(manifest.unexpected_gates) && manifest.unexpected_gates.length === 0,
    'evidence manifest contains unexpected gates',
  )
  const packageUpload = manifest.gates.find((gate) => gate.gate_id === 'package-upload')
  invariant(
    packageUpload?.details?.action_outcome === 'success' &&
      packageUpload?.details?.artifact_id === packageId &&
      packageUpload?.details?.artifact_digest === packageDigest,
    'package upload evidence does not match the downloaded package artifact',
  )

  prepareOutputDirectory(resolvedOutputDirectory)
  const verifiedTarball = join(resolvedOutputDirectory, 'verified.tgz')
  copyFileSync(tarballPath, verifiedTarball, fsConstants.COPYFILE_EXCL)
  invariant(
    sha256(readFileSync(verifiedTarball)) === actualSha256,
    'verified tarball copy changed after validation',
  )
  const receipt = {
    schema_version: 1,
    commit_sha: commitSha,
    tag,
    package_name: metadata.package_name,
    package_version: metadata.package_version,
    package_sha256: actualSha256,
    package_artifact_id: packageId,
    package_artifact_digest: packageDigest,
    evidence_artifact_id: evidenceId,
    evidence_artifact_digest: evidenceDigest,
    evidence_manifest_sha256: sha256(manifestBytes),
    workflow_run_id: runId,
    workflow_run_attempt: runAttempt,
  }
  writeFileSync(
    join(resolvedOutputDirectory, 'verification-receipt.json'),
    `${JSON.stringify(receipt, null, 2)}\n`,
    { encoding: 'utf8', flag: 'wx', mode: 0o600 },
  )
  console.log(
    `verified ${metadata.package_name}@${metadata.package_version} from workflow ` +
    `${runId}.${runAttempt} at ${commitSha}`,
  )
  return { verifiedTarball, receipt }
}

const cliArguments = process.argv.slice(2)
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    invariant(
      cliArguments.length === 3,
      'usage: verify-publish-artifact.mjs <package-dir> <evidence-dir> <output-dir>',
    )
    verifyPublishArtifact({
      packageDirectory: cliArguments[0],
      evidenceDirectory: cliArguments[1],
      outputDirectory: cliArguments[2],
      sourcePackagePath: join(process.cwd(), 'package.json'),
      expectedSha: process.env.GITHUB_SHA,
      expectedTag: process.env.GITHUB_REF_NAME,
      expectedRepository: process.env.GITHUB_REPOSITORY,
      expectedEvent: process.env.GITHUB_EVENT_NAME,
      expectedRef: process.env.GITHUB_REF,
      expectedRunId: process.env.GITHUB_RUN_ID,
      expectedRunAttempt: process.env.GITHUB_RUN_ATTEMPT,
      packageArtifactId: process.env.PACKAGE_ARTIFACT_ID,
      packageArtifactDigest: process.env.PACKAGE_ARTIFACT_DIGEST,
      evidenceArtifactId: process.env.EVIDENCE_ARTIFACT_ID,
      evidenceArtifactDigest: process.env.EVIDENCE_ARTIFACT_DIGEST,
    })
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
