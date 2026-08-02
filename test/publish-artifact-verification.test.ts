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
    version: '0.1.0-beta.1',
    bin: { orchestra: './dist/cli.js' },
    scripts: {
      prepack:
        'node -e "require(\'node:fs\').writeFileSync(process.env.QA019_PREPACK_SENTINEL, \'ran\')"',
    },
  }
  const sourcePackagePath = path.join(directory, 'source-package.json')
  writeJson(sourcePackagePath, sourcePackage)
  for (const relative of requiredPackageFiles) {
    const target = path.join(embeddedDirectory, relative)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    if (relative === 'package.json') writeJson(target, sourcePackage)
    else fs.writeFileSync(target, relative.endsWith('.md') ? '# fixture\n' : '{}\n')
  }

  const tarballName = 'orchestra-board-0.1.0-beta.1.tgz'
  const tarballPath = path.join(packageDirectory, tarballName)
  execFileSync('tar', [
    '-czf',
    tarballPath,
    '-C',
    stagingDirectory,
    'package',
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
    required_files: requiredPackageFiles,
    file_manifest: requiredPackageFiles.map((entry) => ({ path: entry, size: 1, mode: 420 })),
    release_channel: { name: 'beta', opt_in: true, stable_promotion: false },
    provenance: { source_commit: commitSha, builder: 'npm pack' },
    reproducibility: {
      byte_identical: true,
      second_pack_sha256: packageSha256,
      scripts_disabled_for_second_pack: true,
    },
    lifecycle: {
      schema_version: 2,
      passed: true,
      artifact: { sha256: packageSha256, version: sourcePackage.version },
      previous_artifact: { sha256: 'd'.repeat(64), version: '0.1.0-beta.0' },
      upgrade: {
        observed: true,
        passed: true,
        mode: 'prior-artifact-upgrade',
        prior_version: '0.1.0-beta.0',
        candidate_version: sourcePackage.version,
        prior_sha256: 'd'.repeat(64),
        candidate_sha256: packageSha256,
        digests_differ: true,
        versions_differ: true,
        candidate_installed_version: sourcePackage.version,
      },
      rollback: {
        observed: true,
        passed: true,
        prior_artifact_restored: true,
        prior_runtime_started: true,
        data_preserved: true,
        active_work_preserved: true,
        artifact_preserved: true,
      },
      package_install_scripts_absent: true,
      dependency_install_scripts_allowed: true,
      provider_hooks_reversible: true,
      provider_hooks: {
        passed: true,
        claudeOnly: {
          claude: { installed: true, own_provider: true, cross_provider: false },
          codex: { installed: false, own_provider: false, cross_provider: false },
        },
        bothIndependent: {
          claude: { installed: true, own_provider: true, cross_provider: false },
          codex: { installed: true, own_provider: true, cross_provider: false },
        },
        codexOnly: {
          claude: { installed: false, own_provider: false, cross_provider: false },
          codex: { installed: true, own_provider: true, cross_provider: false },
        },
      },
      data_preservation: {
        actual_orchestra_database: true,
        active_work_preserved: true,
        artifact_preserved: true,
        schema_before: { integrity_check: 'ok' },
        schema_after_upgrade: { integrity_check: 'ok' },
        schema_after_uninstall: { integrity_check: 'ok' },
      },
      state_preserved_after_upgrade: true,
      state_preserved_after_uninstall: true,
      project_preserved_after_uninstall: true,
      package_removed: true,
      runtime: {
        doctor_contract: true,
        daemon_health: true,
        web_index_served: true,
        graceful_shutdown: true,
      },
      audit: {
        executed: true,
        threshold: 'moderate',
        moderate: 0,
        high: 0,
        critical: 0,
        resolved_lock_sha256: 'e'.repeat(64),
        passed: true,
      },
    },
    markdown_links: { markdown_files: 2, local_links_checked: 0, passed: true },
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
      ref: 'refs/tags/v0.1.0-beta.1',
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
      expectedTag: 'v0.1.0-beta.1',
      expectedRepository: 'owner/orchestra',
      expectedEvent: 'push',
      expectedRef: 'refs/tags/v0.1.0-beta.1',
      expectedRunId: '303',
      expectedRunAttempt: '1',
      packageArtifactId,
      packageArtifactDigest,
      evidenceArtifactId,
      evidenceArtifactDigest,
    },
  }
}

const rewriteMetadata = (sample: ReturnType<typeof fixture>) => {
  writeJson(path.join(sample.packageDirectory, 'package-metadata.json'), sample.metadata)
  sample.manifest.package_artifact = sample.metadata
  writeJson(sample.manifestPath, sample.manifest)
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
      tag: 'v0.1.0-beta.1',
      package_name: 'orchestra-board',
      package_version: '0.1.0-beta.1',
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
      expectedTag: 'v0.1.1-beta.1',
      expectedRef: 'refs/tags/v0.1.1-beta.1',
    })).toThrow('tag does not match the source package version')
  })

  it('rejects a stable-looking version at the beta publication boundary', () => {
    const sample = fixture()
    const sourcePackage = JSON.parse(fs.readFileSync(sample.sourcePackagePath, 'utf8'))
    sourcePackage.version = '0.1.0'
    writeJson(sample.sourcePackagePath, sourcePackage)

    expect(() => verifyPublishArtifact({
      ...sample.arguments,
      expectedTag: 'v0.1.0',
      expectedRef: 'refs/tags/v0.1.0',
    })).toThrow('beta publication requires an explicit SemVer prerelease package version')
  })

  it('rejects any non-passing retained evidence manifest', () => {
    const sample = fixture()
    const manifest = structuredClone(sample.manifest)
    manifest.result = 'failed'
    writeJson(sample.manifestPath, manifest)

    expect(() => verifyPublishArtifact(sample.arguments))
      .toThrow('evidence manifest did not pass')
  })

  it('rejects same-artifact reinstall presented as upgrade evidence', () => {
    const sample = fixture()
    sample.metadata.lifecycle.previous_artifact.sha256 = sample.metadata.sha256
    sample.metadata.lifecycle.previous_artifact.version = sample.metadata.package_version
    sample.metadata.lifecycle.upgrade.prior_sha256 = sample.metadata.sha256
    sample.metadata.lifecycle.upgrade.prior_version = sample.metadata.package_version
    sample.metadata.lifecycle.upgrade.digests_differ = false
    sample.metadata.lifecycle.upgrade.versions_differ = false
    rewriteMetadata(sample)

    expect(() => verifyPublishArtifact(sample.arguments))
      .toThrow('package clean-consumer lifecycle evidence is incomplete')
  })

  it('rejects missing rollback, wrong installed version, or moderate vulnerabilities', () => {
    const sample = fixture()
    sample.metadata.lifecycle.rollback.observed = false
    rewriteMetadata(sample)
    expect(() => verifyPublishArtifact(sample.arguments))
      .toThrow('package clean-consumer lifecycle evidence is incomplete')

    sample.metadata.lifecycle.rollback.observed = true
    sample.metadata.lifecycle.upgrade.candidate_installed_version = '0.1.0-beta.0'
    rewriteMetadata(sample)
    expect(() => verifyPublishArtifact(sample.arguments))
      .toThrow('package clean-consumer lifecycle evidence is incomplete')

    sample.metadata.lifecycle.upgrade.candidate_installed_version = sample.metadata.package_version
    sample.metadata.lifecycle.audit.moderate = 1
    rewriteMetadata(sample)
    expect(() => verifyPublishArtifact(sample.arguments))
      .toThrow('package clean-consumer lifecycle evidence is incomplete')
  })
})
