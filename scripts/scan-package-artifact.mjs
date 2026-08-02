#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertTarRegularEntries } from './tar-artifact-integrity.mjs'

const invariant = (condition, message) => {
  if (!condition) throw new Error(message)
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const reviewedContract = JSON.parse(
  readFileSync(join(scriptDirectory, 'artifact-secret-scan-reviewed.json'), 'utf8'),
)

const regularFile = (path, label) => {
  const stat = lstatSync(path)
  invariant(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0, `${label} must be a regular file`)
}

const scanTarball = (scanner, tarball, requireCompleteReview) => {
  regularFile(tarball, 'package tarball')
  assertTarRegularEntries(tarball)
  const listing = spawnSync('tar', ['-tzf', tarball], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
  invariant(listing.status === 0, listing.stderr.trim() || 'package tarball listing failed')
  const entries = listing.stdout.trim().split(/\r?\n/).filter(Boolean)
  invariant(entries.length > 0, 'package tarball is empty')
  invariant(
    entries.every((entry) =>
      entry.startsWith('package/') && !entry.split('/').includes('..') && !entry.startsWith('/')),
    'package tarball contains an unsafe path',
  )

  const extracted = mkdtempSync(join(tmpdir(), 'orchestra-artifact-scan-'))
  try {
    const unpack = spawnSync('tar', ['-xzf', tarball, '-C', extracted], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    })
    invariant(unpack.status === 0, unpack.stderr.trim() || 'package tarball extraction failed')
    invariant(existsSync(join(extracted, 'package', 'package.json')), 'extracted package manifest is missing')
    const reportPath = join(extracted, 'gitleaks-report.json')
    const scanRoot = join(extracted, 'package')
    const scan = spawnSync(
      scanner,
      [
        'dir', '.', '--redact', '--no-banner', '--report-format', 'json',
        '--report-path', reportPath,
      ],
      { cwd: scanRoot, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
    )
    invariant(scan.status === 0 || scan.status === 1, scan.stderr.trim() || 'artifact secret scanner failed')
    const findings = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : []
    invariant(Array.isArray(findings), 'artifact secret scan report is invalid')
    const observed = new Set()
    for (const finding of findings) {
      const relativePath = String(finding.File ?? '').replace(/^\.\//, '')
      const line = Number(finding.StartLine)
      const ruleId = String(finding.RuleID ?? '')
      const reviewed = reviewedContract.entries.find((entry) =>
        entry.path === relativePath && entry.rule_id === ruleId && entry.line === line)
      invariant(reviewed, `unreviewed artifact secret finding: ${relativePath}:${ruleId}:${line}`)
      const sourceLines = readFileSync(join(scanRoot, relativePath), 'utf8').split(/\r?\n/)
      const lineSha256 = createHash('sha256').update(`${sourceLines[line - 1]}\n`).digest('hex')
      invariant(
        lineSha256 === reviewed.line_sha256,
        `reviewed artifact secret finding changed: ${relativePath}:${ruleId}:${line}`,
      )
      observed.add(`${relativePath}:${ruleId}:${line}`)
    }
    if (requireCompleteReview) {
      invariant(
        reviewedContract.entries.every((entry) =>
          observed.has(`${entry.path}:${entry.rule_id}:${entry.line}`)),
        'artifact secret-review entries are stale or no longer observed',
      )
    }
    return { entries: entries.length, findings: findings.length }
  } finally {
    rmSync(extracted, { recursive: true, force: true })
  }
}

try {
  invariant(
    process.argv.length === 4,
    'usage: scan-package-artifact.mjs <package-directory> <gitleaks-executable>',
  )
  const packageDirectory = resolve(process.argv[2])
  const scanner = resolve(process.argv[3])
  regularFile(scanner, 'gitleaks executable')
  invariant(reviewedContract.schema_version === 1, 'artifact secret-review schema is unsupported')
  const scannerVersion = spawnSync(scanner, ['version'], { encoding: 'utf8' })
  invariant(
    scannerVersion.status === 0 && scannerVersion.stdout.trim() === reviewedContract.scanner_version,
    'artifact scanner version does not match the reviewed contract',
  )

  const metadata = JSON.parse(readFileSync(join(packageDirectory, 'package-metadata.json'), 'utf8'))
  const candidateName = String(metadata.filename ?? '')
  const priorName = metadata.lifecycle?.passed === true
    ? String(metadata.lifecycle?.previous_artifact?.filename ?? '')
    : null
  const expectedTarballs = [candidateName, ...(priorName ? [priorName] : [])].sort()
  const tarballs = readdirSync(packageDirectory).filter((entry) => entry.endsWith('.tgz')).sort()
  invariant(
    JSON.stringify(tarballs) === JSON.stringify(expectedTarballs),
    'package directory tarballs do not match lifecycle metadata',
  )

  const candidate = scanTarball(scanner, join(packageDirectory, candidateName), true)
  const prior = priorName ? scanTarball(scanner, join(packageDirectory, priorName), false) : null
  const looseReport = join(packageDirectory, '.gitleaks-loose-report.json')
  const looseScan = spawnSync(
    scanner,
    [
      'dir', '.', '--redact', '--no-banner', '--report-format', 'json',
      '--report-path', looseReport,
    ],
    { cwd: packageDirectory, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  )
  const looseFindings = existsSync(looseReport) ? JSON.parse(readFileSync(looseReport, 'utf8')) : []
  rmSync(looseReport, { force: true })
  invariant(looseScan.status === 0, 'loose artifact metadata or receipts contain a secret finding')
  invariant(Array.isArray(looseFindings) && looseFindings.length === 0, 'loose artifact scan is invalid')

  console.log(
    `artifact secret scan passed for ${basename(candidateName)} (${candidate.entries} entries, ` +
    `${candidate.findings} exact reviewed false positive${candidate.findings === 1 ? '' : 's'}` +
    `${prior ? `; prior ${basename(priorName)} ${prior.entries} entries` : ''})`,
  )
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
