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
import { runPackageLifecycle } from './package-lifecycle-smoke.mjs'
import { verifyPackagedMarkdownLinks } from './package-link-integrity.mjs'

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
for (const required of requiredFiles) {
  if (!packedFiles.has(required)) throw new Error(`package artifact is missing ${required}`)
}
const extractionDirectory = mkdtempSync(join(tmpdir(), 'orchestra-package-extracted-'))
let markdownLinks
try {
  const inventory = spawnSync('tar', ['-tzf', packagePath], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
  if (inventory.status !== 0) throw new Error(inventory.stderr.trim() || 'package inventory failed')
  const entries = inventory.stdout.split(/\r?\n/).filter(Boolean)
  if (!entries.every((entry) =>
    entry === 'package' || entry === 'package/' ||
    (entry.startsWith('package/') && !entry.split('/').includes('..')))) {
    throw new Error('package artifact inventory contains an unsafe path')
  }
  const extracted = spawnSync('tar', ['-xzf', packagePath, '-C', extractionDirectory], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
  if (extracted.status !== 0) throw new Error(extracted.stderr.trim() || 'package extraction failed')
  markdownLinks = verifyPackagedMarkdownLinks({
    root: join(extractionDirectory, 'package'),
    files: packedFiles,
  })
} finally {
  rmSync(extractionDirectory, { recursive: true, force: true })
}

const reproductionDirectory = mkdtempSync(join(tmpdir(), 'orchestra-package-reproduction-'))
let reproduction
try {
  const reproduced = spawnSync(
    'npm',
    [
      'pack',
      '--ignore-scripts',
      '--silent',
      '--json',
      '--pack-destination',
      reproductionDirectory,
    ],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    },
  )
  if (reproduced.status !== 0) {
    throw new Error(
      reproduced.stderr.trim() || reproduced.stdout.trim() || 'reproducibility pack failed',
    )
  }
  let reproducedReport
  try {
    const jsonStart = reproduced.stdout.lastIndexOf('\n[')
    const jsonPayload = jsonStart >= 0 ? reproduced.stdout.slice(jsonStart + 1) : reproduced.stdout
    const reports = JSON.parse(jsonPayload)
    if (!Array.isArray(reports) || reports.length !== 1) throw new Error('expected one package')
    reproducedReport = reports[0]
  } catch (error) {
    throw new Error(
      `reproducibility pack did not return one JSON report: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const reproducedBytes = readFileSync(
    join(reproductionDirectory, basename(reproducedReport.filename)),
  )
  const reproducedSha256 = createHash('sha256').update(reproducedBytes).digest('hex')
  if (!packageBytes.equals(reproducedBytes)) {
    throw new Error(
      `npm package is not byte-reproducible: ${sha256} != ${reproducedSha256}`,
    )
  }
  reproduction = {
    byte_identical: true,
    second_pack_sha256: reproducedSha256,
    scripts_disabled_for_second_pack: true,
  }
} finally {
  rmSync(reproductionDirectory, { recursive: true, force: true })
}

const lifecycle = await runPackageLifecycle({
  artifactPath: packagePath,
  previousArtifactPath: process.env.ORCHESTRA_PREVIOUS_PACKAGE?.trim() || undefined,
})

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
    file_manifest: Array.isArray(packReport.files)
      ? packReport.files
        .map((entry) => ({ path: entry.path, size: entry.size, mode: entry.mode }))
        .sort((left, right) => left.path.localeCompare(right.path))
      : [],
    release_channel: {
      name: 'beta',
      opt_in: true,
      stable_promotion: false,
    },
    provenance: {
      source_commit: expectedSha,
      builder: 'npm pack',
      node_version: process.version,
      npm_user_agent: String(process.env.npm_config_user_agent ?? 'unknown'),
    },
    reproducibility: reproduction,
    lifecycle,
    markdown_links: markdownLinks,
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
