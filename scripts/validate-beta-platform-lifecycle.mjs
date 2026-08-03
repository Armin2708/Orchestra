#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspectArtifact } from './beta-release-preflight.mjs'
import { runPackageLifecycle } from './package-lifecycle-smoke.mjs'

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(SCRIPT_DIRECTORY, '..')
const SHA256_PATTERN = /^[0-9a-f]{64}$/u
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u
const PRERELEASE_PATTERN = /^\d+\.\d+\.\d+-[0-9A-Za-z](?:[0-9A-Za-z.-]*[0-9A-Za-z])?$/u
const PLATFORMS = new Map([
  ['macos-arm64', { os: 'darwin', arch: 'arm64', runnerOs: 'macOS', imagePattern: /^macos-?15$/u }],
  ['ubuntu-24.04-x64', { os: 'linux', arch: 'x64', runnerOs: 'Linux', imagePattern: /^ubuntu24/u }],
])

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const argument = (name) => {
  const index = process.argv.indexOf(name)
  return index === -1 ? null : process.argv[index + 1]
}

export const validateHostedPlatform = ({
  platformKey,
  platform = process.platform,
  arch = process.arch,
  nodeVersion = process.versions.node,
  npmVersion = execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim(),
  githubActions = process.env.GITHUB_ACTIONS,
  runnerOs = process.env.RUNNER_OS,
  imageOs = process.env.ImageOS,
} = {}) => {
  const expected = PLATFORMS.get(platformKey)
  if (!expected) throw new Error(`unsupported platform evidence key: ${platformKey}`)
  if (platform !== expected.os || arch !== expected.arch) {
    throw new Error(`${platformKey} requires ${expected.os}/${expected.arch}, observed ${platform}/${arch}`)
  }
  if (nodeVersion !== '22.20.0' || npmVersion !== '10.9.3') {
    throw new Error(`release evidence requires Node 22.20.0/npm 10.9.3, observed ${nodeVersion}/${npmVersion}`)
  }
  if (githubActions !== 'true' || runnerOs !== expected.runnerOs || !expected.imagePattern.test(String(imageOs ?? ''))) {
    throw new Error(`${platformKey} evidence requires the declared clean GitHub-hosted runner image`)
  }
  return {
    key: platformKey,
    os: platform,
    arch,
    node: nodeVersion,
    npm: npmVersion,
    runner_os: runnerOs,
    image_os: imageOs,
  }
}

export async function validateBetaPlatformLifecycle({
  artifactDirectory,
  outputDirectory,
  platformKey,
  expectedCommit,
  expectedSha256,
} = {}) {
  if (!artifactDirectory) throw new Error('--artifact-dir is required')
  if (!outputDirectory) throw new Error('--output-dir is required')
  if (!platformKey) throw new Error('--platform is required')
  if (!COMMIT_PATTERN.test(String(expectedCommit ?? ''))) throw new Error('--expected-commit must be a full lowercase commit SHA')
  if (!SHA256_PATTERN.test(String(expectedSha256 ?? ''))) throw new Error('--expected-sha256 must be a lowercase SHA-256 digest')
  const sourcePackage = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  if (!PRERELEASE_PATTERN.test(String(sourcePackage.version ?? ''))) {
    throw new Error('clean-platform release evidence requires an approved explicit source prerelease version')
  }
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
  if (head !== expectedCommit) throw new Error('checked-out source does not match the expected candidate commit')
  if (execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: ROOT, encoding: 'utf8' }).trim()) {
    throw new Error('clean-platform lifecycle refuses a dirty tracked checkout')
  }
  const platform = validateHostedPlatform({ platformKey })
  const artifactInspection = inspectArtifact({
    artifactDirectory,
    commit: expectedCommit,
    sourceVersion: sourcePackage.version,
  })
  if (!artifactInspection.ok) throw new Error(artifactInspection.blocker)
  if (artifactInspection.identity.sha256 !== expectedSha256) throw new Error('retained candidate digest differs from the approved digest')
  if (!artifactInspection.rollbackPassed) throw new Error('retained candidate metadata does not contain a passed signed-prior upgrade/rollback lifecycle')

  const artifacts = path.resolve(artifactDirectory)
  const metadata = JSON.parse(fs.readFileSync(path.join(artifacts, 'package-metadata.json'), 'utf8'))
  const priorFilename = metadata.lifecycle?.previous_artifact?.filename
  const candidatePath = path.join(artifacts, artifactInspection.identity.filename)
  const priorPath = path.join(artifacts, String(priorFilename ?? ''))
  for (const file of [
    priorPath,
    path.join(artifacts, 'prior-evidence-manifest.json'),
    path.join(artifacts, 'prior-retained-artifact-receipt.json'),
  ]) {
    if (!fs.existsSync(file) || !fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) {
      throw new Error('retained candidate is missing its regular signed prior-artifact evidence files')
    }
  }

  const output = path.resolve(outputDirectory)
  if (fs.existsSync(output)) throw new Error('platform evidence output directory must not already exist')
  fs.mkdirSync(output, { recursive: false, mode: 0o700 })
  const priorEvidence = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-prior-platform-evidence-'))
  try {
    fs.copyFileSync(path.join(artifacts, 'prior-evidence-manifest.json'), path.join(priorEvidence, 'manifest.json'))
    fs.copyFileSync(path.join(artifacts, 'prior-retained-artifact-receipt.json'), path.join(priorEvidence, 'retained-artifact-receipt.json'))
    const lifecycle = await runPackageLifecycle({
      artifactPath: candidatePath,
      previousArtifactPath: priorPath,
      previousEvidenceDirectory: priorEvidence,
    })
    if (!lifecycle.passed || lifecycle.release_gate?.status !== 'passed' ||
      lifecycle.upgrade?.passed !== true || lifecycle.rollback?.passed !== true ||
      lifecycle.artifact?.sha256 !== expectedSha256 ||
      lifecycle.previous_artifact?.sha256 === expectedSha256) {
      throw new Error('clean-platform lifecycle did not pass exact-artifact upgrade and rollback')
    }
    const lifecycleBytes = Buffer.from(`${JSON.stringify(lifecycle, null, 2)}\n`)
    const lifecyclePath = path.join(output, 'lifecycle-report.json')
    fs.writeFileSync(lifecyclePath, lifecycleBytes, { flag: 'wx', mode: 0o600 })
    const report = {
      schema_version: 1,
      tested_commit: expectedCommit,
      artifact: artifactInspection.identity,
      platform,
      lifecycle_report: {
        path: 'lifecycle-report.json',
        sha256: sha256(lifecycleBytes),
        release_gate_status: lifecycle.release_gate.status,
        rollback_passed: lifecycle.rollback.passed,
      },
      status: 'passed',
    }
    fs.writeFileSync(
      path.join(output, 'platform-lifecycle-report.json'),
      `${JSON.stringify(report, null, 2)}\n`,
      { flag: 'wx', mode: 0o600 },
    )
    return report
  } finally {
    fs.rmSync(priorEvidence, { recursive: true, force: true })
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const report = await validateBetaPlatformLifecycle({
    artifactDirectory: argument('--artifact-dir'),
    outputDirectory: argument('--output-dir'),
    platformKey: argument('--platform'),
    expectedCommit: argument('--expected-commit'),
    expectedSha256: argument('--expected-sha256'),
  })
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
}
