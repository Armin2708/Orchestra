import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { verifyPublishArtifact } from '../scripts/verify-publish-artifact.mjs'

const root = path.resolve(import.meta.dirname, '..')
const contract = JSON.parse(
  fs.readFileSync(path.join(root, 'scripts/exact-commit-ci-contract.json'), 'utf8'),
)
const temporaryDirectories: string[] = []
const commitSha = 'a'.repeat(40)
const packageArtifactId = '101'
const packageArtifactDigest = 'b'.repeat(64)
const evidenceArtifactId = '202'
const evidenceArtifactDigest = 'c'.repeat(64)

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

const hash = (algorithm: string, bytes: Buffer, encoding: 'hex' | 'base64') =>
  createHash(algorithm).update(bytes).digest(encoding)

const writeJson = (file: string, value: unknown) => {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

const manifestContract = () => ({
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

const fixture = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-publish-artifact-'))
  temporaryDirectories.push(directory)
  const packageDirectory = path.join(directory, 'downloaded-package')
  const evidenceDirectory = path.join(directory, 'downloaded-evidence')
  const outputDirectory = path.join(directory, 'verified')
  const stagingDirectory = path.join(directory, 'staging')
  const embeddedDirectory = path.join(stagingDirectory, 'package')
  fs.mkdirSync(packageDirectory)
  fs.mkdirSync(evidenceDirectory)
  fs.mkdirSync(embeddedDirectory, { recursive: true })

  const sourcePackage = {
    name: 'orchestra-board',
    version: '0.1.0',
    bin: { orchestra: './dist/cli.js' },
    scripts: {
      prepack:
        'node -e "require(\'node:fs\').writeFileSync(process.env.QA019_PREPACK_SENTINEL, \'ran\')"',
    },
  }
  const sourcePackagePath = path.join(directory, 'source-package.json')
  writeJson(sourcePackagePath, sourcePackage)
  writeJson(path.join(embeddedDirectory, 'package.json'), sourcePackage)

  const tarballName = 'orchestra-board-0.1.0.tgz'
  const tarballPath = path.join(packageDirectory, tarballName)
  execFileSync('tar', [
    '-czf',
    tarballPath,
    '-C',
    stagingDirectory,
    'package/package.json',
  ])
  const tarballBytes = fs.readFileSync(tarballPath)
  const packageSha256 = hash('sha256', tarballBytes, 'hex')
  const metadata = {
    schema_version: 1,
    commit_sha: commitSha,
    package_name: sourcePackage.name,
    package_version: sourcePackage.version,
    filename: tarballName,
    bytes: tarballBytes.byteLength,
    sha256: packageSha256,
    npm_integrity: `sha512-${hash('sha512', tarballBytes, 'base64')}`,
    npm_shasum: hash('sha1', tarballBytes, 'hex'),
    required_files: [
      'README.md',
      'dist/cli.js',
      'environment-compatibility.json',
      'package.json',
      'web/dist/index.html',
    ],
    install_smoke: {
      scripts_disabled: true,
      cli_version: sourcePackage.version,
      passed: true,
    },
  }
  writeJson(path.join(packageDirectory, 'package-metadata.json'), metadata)
  fs.writeFileSync(
    path.join(packageDirectory, `${tarballName}.sha256`),
    `${packageSha256}  ${tarballName}\n`,
  )

  const gates = contract.required_gates.map((gateId: string) => ({
    schema_version: 1,
    commit_sha: commitSha,
    gate_id: gateId,
    status: 'passed',
    exit_code: 0,
    started_at: '2026-07-25T00:00:00.000Z',
    completed_at: '2026-07-25T00:00:01.000Z',
    invocation: { executable: 'fixture' },
    runner: {
      platform: 'linux',
      arch: 'x64',
      runner_os: 'Linux',
      runner_arch: 'X64',
      node_version: contract.node_version,
    },
    details: gateId === 'package-upload'
      ? {
          action_outcome: 'success',
          artifact_id: packageArtifactId,
          artifact_digest: packageArtifactDigest,
        }
      : {},
  }))
  const manifest = {
    schema_version: contract.schema_version,
    backlog_item: 'QA-019',
    commit_sha: commitSha,
    generated_at: '2026-07-25T00:00:02.000Z',
    workflow_run: {
      repository: 'owner/orchestra',
      event: 'push',
      ref: 'refs/tags/v0.1.0',
      run_id: '303',
      run_attempt: '1',
    },
    contract: manifestContract(),
    result: 'passed',
    summary: {
      required: contract.required_gates.length,
      passed: contract.required_gates.length,
      failed: 0,
      missing: 0,
      unexpected: 0,
      sha_consistent: true,
      package_consistent: true,
      package_upload_evidence_present: true,
    },
    gates,
    unexpected_gates: [],
    package_artifact: metadata,
  }
  const manifestPath = path.join(evidenceDirectory, 'manifest.json')
  writeJson(manifestPath, manifest)

  return {
    packageDirectory,
    evidenceDirectory,
    outputDirectory,
    sourcePackagePath,
    tarballPath,
    tarballName,
    manifestPath,
    metadata,
    manifest,
    arguments: {
      packageDirectory,
      evidenceDirectory,
      outputDirectory,
      sourcePackagePath,
      expectedSha: commitSha,
      expectedTag: 'v0.1.0',
      expectedRepository: 'owner/orchestra',
      expectedEvent: 'push',
      expectedRef: 'refs/tags/v0.1.0',
      expectedRunId: '303',
      expectedRunAttempt: '1',
      packageArtifactId,
      packageArtifactDigest,
      evidenceArtifactId,
      evidenceArtifactDigest,
    },
  }
}

describe('exact package publish verification', () => {
  it('copies only the same-SHA, same-run, tested tarball into the publish boundary', () => {
    const sample = fixture()
    const originalBytes = fs.readFileSync(sample.tarballPath)
    const result = verifyPublishArtifact(sample.arguments)

    expect(fs.readFileSync(result.verifiedTarball)).toEqual(originalBytes)
    expect(path.basename(result.verifiedTarball)).toBe('verified.tgz')
    expect(result.receipt).toMatchObject({
      schema_version: 1,
      commit_sha: commitSha,
      tag: 'v0.1.0',
      package_name: 'orchestra-board',
      package_version: '0.1.0',
      package_sha256: sample.metadata.sha256,
      package_artifact_id: packageArtifactId,
      package_artifact_digest: packageArtifactDigest,
      evidence_artifact_id: evidenceArtifactId,
      evidence_artifact_digest: evidenceArtifactDigest,
      workflow_run_id: '303',
      workflow_run_attempt: '1',
    })
    expect(JSON.parse(
      fs.readFileSync(path.join(sample.outputDirectory, 'verification-receipt.json'), 'utf8'),
    )).toEqual(result.receipt)

    const lifecycleSentinel = path.join(sample.outputDirectory, 'prepack-ran')
    const dryRun = spawnSync(
      'npm',
      ['publish', result.verifiedTarball, '--dry-run', '--ignore-scripts', '--json'],
      {
        cwd: sample.outputDirectory,
        encoding: 'utf8',
        env: { ...process.env, QA019_PREPACK_SENTINEL: lifecycleSentinel },
      },
    )
    expect(dryRun.status).toBe(0)
    expect(fs.existsSync(lifecycleSentinel)).toBe(false)
  })

  it('rejects a missing package checksum', () => {
    const sample = fixture()
    fs.rmSync(path.join(sample.packageDirectory, `${sample.tarballName}.sha256`))

    expect(() => verifyPublishArtifact(sample.arguments))
      .toThrow('package artifact contains missing or unexpected files')
  })

  it('rejects multiple package tarballs', () => {
    const sample = fixture()
    fs.copyFileSync(sample.tarballPath, path.join(sample.packageDirectory, 'unexpected.tgz'))

    expect(() => verifyPublishArtifact(sample.arguments))
      .toThrow('package artifact must contain exactly one .tgz')
  })

  it('rejects package bytes changed after test and digest evidence', () => {
    const sample = fixture()
    fs.appendFileSync(sample.tarballPath, 'tampered')

    expect(() => verifyPublishArtifact(sample.arguments))
      .toThrow('package metadata byte count does not match')
  })

  it('rejects a package upload identity that differs from the evidence manifest', () => {
    const sample = fixture()
    const manifest = structuredClone(sample.manifest)
    const upload = manifest.gates.find((gate: { gate_id: string }) =>
      gate.gate_id === 'package-upload')
    upload.details.artifact_id = '999'
    writeJson(sample.manifestPath, manifest)

    expect(() => verifyPublishArtifact(sample.arguments))
      .toThrow('package upload evidence does not match the downloaded package artifact')
  })

  it('rejects cross-commit or cross-run evidence', () => {
    const sample = fixture()
    const manifest = structuredClone(sample.manifest)
    manifest.commit_sha = 'd'.repeat(40)
    writeJson(sample.manifestPath, manifest)

    expect(() => verifyPublishArtifact(sample.arguments))
      .toThrow('evidence manifest commit does not match the tag commit')

    writeJson(sample.manifestPath, sample.manifest)
    expect(() => verifyPublishArtifact({
      ...sample.arguments,
      expectedRunId: '404',
    })).toThrow('evidence manifest does not belong to this workflow run and ref')
  })

  it('rejects a tag or source version that does not match the tested package', () => {
    const sample = fixture()

    expect(() => verifyPublishArtifact({
      ...sample.arguments,
      expectedTag: 'v0.1.1',
      expectedRef: 'refs/tags/v0.1.1',
    })).toThrow('tag does not match the source package version')
  })

  it('rejects any non-passing retained evidence manifest', () => {
    const sample = fixture()
    const manifest = structuredClone(sample.manifest)
    manifest.result = 'failed'
    writeJson(sample.manifestPath, manifest)

    expect(() => verifyPublishArtifact(sample.arguments))
      .toThrow('evidence manifest did not pass')
  })
})
