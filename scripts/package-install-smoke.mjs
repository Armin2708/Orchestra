#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'

const shaPattern = /^[0-9a-f]{40}$/
const expectedSha = String(process.env.CI_EVIDENCE_SHA ?? process.env.GITHUB_SHA ?? '')
  .trim()
  .toLowerCase()
const evidenceDirectory = process.env.CI_EVIDENCE_DIR?.trim()

if (!shaPattern.test(expectedSha)) throw new Error('CI_EVIDENCE_SHA must be a full commit SHA')
if (!evidenceDirectory) throw new Error('CI_EVIDENCE_DIR is required')

const packageDirectory = resolve(evidenceDirectory, 'package')
mkdirSync(packageDirectory, { recursive: true })
const packed = spawnSync(
  'npm',
  ['pack', '--silent', '--json', '--pack-destination', packageDirectory],
  {
    cwd: process.cwd(),
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  },
)
if (packed.status !== 0) {
  throw new Error(packed.stderr.trim() || packed.stdout.trim() || 'npm pack failed')
}

let packReport
try {
  const jsonStart = packed.stdout.lastIndexOf('\n[')
  const jsonPayload = jsonStart >= 0 ? packed.stdout.slice(jsonStart + 1) : packed.stdout
  const reports = JSON.parse(jsonPayload)
  if (!Array.isArray(reports) || reports.length !== 1) throw new Error('expected one package')
  packReport = reports[0]
} catch (error) {
  throw new Error(
    `npm pack did not return one JSON report: ${error instanceof Error ? error.message : String(error)}`,
  )
}

const packagePath = join(packageDirectory, basename(packReport.filename))
const packageBytes = readFileSync(packagePath)
const sha256 = createHash('sha256').update(packageBytes).digest('hex')
const packedFiles = new Set(
  Array.isArray(packReport.files) ? packReport.files.map((entry) => entry.path) : [],
)
const requiredFiles = [
  'README.md',
  'dist/cli.js',
  'environment-compatibility.json',
  'package.json',
  'web/dist/index.html',
]
for (const required of requiredFiles) {
  if (!packedFiles.has(required)) throw new Error(`package artifact is missing ${required}`)
}

const smokeDirectory = mkdtempSync(join(tmpdir(), 'orchestra-package-smoke-'))
try {
  writeFileSync(
    join(smokeDirectory, 'package.json'),
    '{"name":"orchestra-package-smoke","version":"1.0.0","private":true}\n',
  )
  const installed = spawnSync(
    'npm',
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error', packagePath],
    { cwd: smokeDirectory, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  )
  if (installed.status !== 0) {
    throw new Error(installed.stderr.trim() || installed.stdout.trim() || 'package install smoke failed')
  }
  const executable = join(smokeDirectory, 'node_modules', '.bin', 'orchestra')
  const version = spawnSync(executable, ['--version'], {
    cwd: smokeDirectory,
    encoding: 'utf8',
  })
  if (version.status !== 0 || version.stdout.trim() !== String(packReport.version)) {
    throw new Error(
      version.stderr.trim() ||
      `installed CLI reported ${JSON.stringify(version.stdout.trim())}, ` +
      `expected ${JSON.stringify(packReport.version)}`,
    )
  }

  const metadata = {
    schema_version: 1,
    commit_sha: expectedSha,
    package_name: packReport.name,
    package_version: packReport.version,
    filename: basename(packagePath),
    bytes: packageBytes.byteLength,
    sha256,
    npm_integrity: packReport.integrity,
    npm_shasum: packReport.shasum,
    required_files: requiredFiles,
    install_smoke: {
      scripts_disabled: true,
      cli_version: version.stdout.trim(),
      passed: true,
    },
  }
  writeFileSync(
    join(packageDirectory, 'package-metadata.json'),
    `${JSON.stringify(metadata, null, 2)}\n`,
    { mode: 0o600 },
  )
  writeFileSync(
    join(packageDirectory, `${basename(packagePath)}.sha256`),
    `${sha256}  ${basename(packagePath)}\n`,
    { mode: 0o600 },
  )
  console.log(
    `package ${packReport.name}@${packReport.version} installed from ${basename(packagePath)} ` +
    `(${sha256})`,
  )
} finally {
  rmSync(smokeDirectory, { recursive: true, force: true })
}
