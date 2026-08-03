import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  evaluateBetaReleasePreflight,
  inspectArtifact,
  inspectPlatformReports,
  inspectRolloutReports,
} from '../scripts/beta-release-preflight.mjs'
import { validateHostedPlatform } from '../scripts/validate-beta-platform-lifecycle.mjs'

const root = path.resolve(import.meta.dirname, '..')
const temporaryDirectories: string[] = []
const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

const temporaryDirectory = (prefix: string) => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  temporaryDirectories.push(directory)
  return directory
}

const writeJson = (file: string, value: unknown) => {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

const artifactFixture = () => {
  const directory = temporaryDirectory('orchestra-release-preflight-artifact-')
  const staging = path.join(directory, 'staging', 'package')
  fs.mkdirSync(staging, { recursive: true })
  writeJson(path.join(staging, 'package.json'), {
    name: 'orchestra-board', version: '0.1.0', bin: { orchestra: './dist/cli.js' },
  })
  const filename = 'orchestra-board-0.1.0.tgz'
  const tarball = path.join(directory, filename)
  execFileSync('tar', ['-czf', tarball, '-C', path.dirname(staging), 'package'])
  const bytes = fs.readFileSync(tarball)
  const sha256 = digest(bytes)
  const commit = 'a'.repeat(40)
  writeJson(path.join(directory, 'package-metadata.json'), {
    schema_version: 1,
    commit_sha: commit,
    package_version: '0.1.0',
    filename,
    bytes: bytes.byteLength,
    sha256,
    source_identity: {
      expected_commit: commit,
      observed_commit: commit,
      tracked_source_clean: true,
      packaged_nonbuild_inputs_tracked: true,
    },
    reproducibility: { byte_identical: true, second_pack_sha256: sha256 },
    lifecycle: { passed: false, release_gate: { status: 'incomplete' } },
  })
  fs.writeFileSync(path.join(directory, `${filename}.sha256`), `${sha256}  ${filename}\n`)
  return { directory, tarball, commit, filename, sha256, bytes: bytes.byteLength }
}

describe('beta release preflight', () => {
  it('keeps the prepared source blocked without approval and external evidence', () => {
    const report = evaluateBetaReleasePreflight({ root, proposedVersion: '0.1.0-beta.1' })
    const gates = new Map(report.gates.map((entry) => [entry.id, entry.status]))

    expect(report).toMatchObject({
      status: 'blocked',
      public_action_authorized: false,
      proposed_version: '0.1.0-beta.1',
    })
    expect(gates.get('prerelease-proposal')).toBe('passed')
    expect(gates.get('approved-source-version')).toBe('blocked')
    expect(gates.get('publication-remains-fail-closed')).toBe('passed')
    expect(gates.get('npm-beta-protection-observed')).toBe('blocked')
    expect(gates.get('prior-artifact-production-trust')).toBe('blocked')
    expect(gates.get('qa-018-production-trust')).toBe('blocked')
    expect(report.blockers.map((entry) => entry.id)).toContain('clean-macos-and-linux')
  })

  it('binds retained bytes, checksum, exact source, and reproducibility without calling rollback passed', () => {
    const sample = artifactFixture()
    expect(inspectArtifact({
      artifactDirectory: sample.directory,
      commit: sample.commit,
      sourceVersion: '0.1.0',
    })).toEqual({
      ok: true,
      identity: {
        filename: sample.filename,
        version: '0.1.0',
        bytes: sample.bytes,
        sha256: sample.sha256,
      },
      rollbackPassed: false,
    })

    const metadataPath = path.join(sample.directory, 'package-metadata.json')
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'))
    metadata.sha256 = 'b'.repeat(64)
    writeJson(metadataPath, metadata)
    expect(inspectArtifact({
      artifactDirectory: sample.directory,
      commit: sample.commit,
      sourceVersion: '0.1.0',
    })).toMatchObject({ ok: false })
  })

  it('requires both exact clean-platform reports and verifies their retained lifecycle bytes', () => {
    const directory = temporaryDirectory('orchestra-release-platform-reports-')
    const artifact = { filename: 'candidate.tgz', version: '0.1.0-beta.1', bytes: 42, sha256: 'c'.repeat(64) }
    const commit = 'd'.repeat(40)
    const reports: string[] = []
    for (const [key, platform] of [
      ['macos-arm64', { os: 'darwin', arch: 'arm64', runner_os: 'macOS', image_os: 'macos-15' }],
      ['ubuntu-24.04-x64', { os: 'linux', arch: 'x64', runner_os: 'Linux', image_os: 'ubuntu24' }],
    ] as const) {
      const reportDirectory = path.join(directory, key)
      fs.mkdirSync(reportDirectory)
      const lifecycleBytes = Buffer.from(`${JSON.stringify({
        passed: true,
        release_gate: { status: 'passed' },
        artifact: { sha256: artifact.sha256 },
        previous_artifact: { sha256: '2'.repeat(64) },
        rollback: { passed: true },
      })}\n`)
      fs.writeFileSync(path.join(reportDirectory, 'lifecycle-report.json'), lifecycleBytes)
      const reportPath = path.join(reportDirectory, 'platform-lifecycle-report.json')
      writeJson(reportPath, {
        schema_version: 1,
        tested_commit: commit,
        artifact,
        platform: { key, ...platform, node: '22.20.0', npm: '10.9.3' },
        lifecycle_report: {
          path: 'lifecycle-report.json', sha256: digest(lifecycleBytes),
          release_gate_status: 'passed', rollback_passed: true,
        },
        status: 'passed',
      })
      reports.push(reportPath)
    }

    expect(inspectPlatformReports({ reportPaths: reports, artifact, commit })).toEqual({
      ok: true,
      observed: ['macos-arm64', 'ubuntu-24.04-x64'],
      errors: [],
    })
    fs.appendFileSync(path.join(directory, 'macos-arm64', 'lifecycle-report.json'), 'tampered')
    expect(inspectPlatformReports({ reportPaths: reports, artifact, commit })).toMatchObject({ ok: false })
  })

  it('requires internal and canary duration, healthy signals, zero P0/P1, and distinct rollback bytes', () => {
    const directory = temporaryDirectory('orchestra-release-rollout-reports-')
    const artifact = { version: '0.1.0-beta.1', sha256: 'e'.repeat(64) }
    const commit = 'f'.repeat(40)
    const reports = ['internal', 'canary'].map((stage) => {
      const file = path.join(directory, `${stage}.json`)
      writeJson(file, {
        schema_version: 1,
        tested_commit: commit,
        artifact,
        stage,
        cohort: `${stage}-testers`,
        started_at: '2026-08-01T00:00:00.000Z',
        completed_at: '2026-08-01T01:00:00.000Z',
        required_duration_seconds: 3600,
        signals: {
          installation: 'healthy', provider: 'healthy', recovery: 'healthy',
          token: 'healthy', migration: 'healthy',
        },
        incidents: { p0: 0, p1: 0, p2: 0 },
        rollback: {
          owner: 'release-owner', drill_passed: true,
          prior_artifact_sha256: '1'.repeat(64), schema_down_migration: false,
        },
        status: 'passed',
      })
      return file
    })
    expect(inspectRolloutReports({ reportPaths: reports, artifact, commit })).toEqual({
      ok: true, observed: ['canary', 'internal'], errors: [],
    })

    const canary = JSON.parse(fs.readFileSync(reports[1], 'utf8'))
    canary.completed_at = '2026-08-01T00:59:59.000Z'
    writeJson(reports[1], canary)
    expect(inspectRolloutReports({ reportPaths: reports, artifact, commit })).toMatchObject({ ok: false })
  })

  it('accepts only the declared clean hosted runner tuples', () => {
    expect(validateHostedPlatform({
      platformKey: 'ubuntu-24.04-x64', platform: 'linux', arch: 'x64',
      nodeVersion: '22.20.0', npmVersion: '10.9.3', githubActions: 'true',
      runnerOs: 'Linux', imageOs: 'ubuntu24',
    })).toMatchObject({ key: 'ubuntu-24.04-x64', os: 'linux', arch: 'x64' })

    expect(() => validateHostedPlatform({
      platformKey: 'ubuntu-24.04-x64', platform: 'linux', arch: 'x64',
      nodeVersion: '22.20.0', npmVersion: '10.9.3', githubActions: 'true',
      runnerOs: 'Linux', imageOs: 'ubuntu22',
    })).toThrow('clean GitHub-hosted runner image')
  })

  it('keeps the clean-platform workflow manual, exact-artifact-only, and non-publishing', () => {
    const workflow = fs.readFileSync(path.join(root, '.github/workflows/beta-platform-lifecycle.yml'), 'utf8')
    expect(workflow).toContain('workflow_dispatch:')
    expect(workflow).not.toMatch(/^\s*push:/mu)
    expect(workflow).toContain('runner: macos-15')
    expect(workflow).toContain('runner: ubuntu-24.04')
    expect(workflow).toContain('artifact-ids: ${{ inputs.candidate_artifact_id }}')
    expect(workflow).toContain('run-id: ${{ inputs.source_run_id }}')
    expect(workflow).toContain('github-token: ${{ github.token }}')
    expect(workflow).toContain('digest-mismatch: error')
    expect(workflow).toContain('CANDIDATE_SHA256: ${{ inputs.candidate_sha256 }}')
    expect(workflow).toContain('--expected-sha256 "$CANDIDATE_SHA256"')
    expect(workflow).not.toContain('[[ "${{ inputs.')
    expect(workflow).not.toContain('npm pack')
    expect(workflow).not.toContain('npm publish')
    expect(workflow).not.toContain('npm run build')
    expect(workflow).not.toContain('contents: write')
  })
})
