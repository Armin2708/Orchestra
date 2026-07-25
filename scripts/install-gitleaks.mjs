#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const contract = JSON.parse(
  readFileSync(join(scriptDirectory, 'exact-commit-ci-contract.json'), 'utf8'),
)
const evidenceDirectory = process.env.CI_EVIDENCE_DIR?.trim()

if (!evidenceDirectory) throw new Error('CI_EVIDENCE_DIR is required')
if (process.platform !== 'linux' || process.arch !== 'x64') {
  throw new Error(`the pinned CI gitleaks archive supports linux/x64, not ${process.platform}/${process.arch}`)
}

const version = contract.gitleaks.version
const expectedSha256 = contract.gitleaks.linux_x64_archive_sha256
const toolsDirectory = resolve(evidenceDirectory, 'tools')
const archive = join(toolsDirectory, `gitleaks_${version}_linux_x64.tar.gz`)
const binary = join(toolsDirectory, 'gitleaks')
const source =
  `https://github.com/gitleaks/gitleaks/releases/download/v${version}/` +
  `gitleaks_${version}_linux_x64.tar.gz`

mkdirSync(toolsDirectory, { recursive: true })
const response = await fetch(source, { redirect: 'follow' })
if (!response.ok) throw new Error(`gitleaks download failed with HTTP ${response.status}`)
const archiveBytes = Buffer.from(await response.arrayBuffer())
const actualSha256 = createHash('sha256').update(archiveBytes).digest('hex')
if (actualSha256 !== expectedSha256) {
  throw new Error(`gitleaks archive checksum mismatch: expected ${expectedSha256}, got ${actualSha256}`)
}
writeFileSync(archive, archiveBytes, { mode: 0o600 })

try {
  const extracted = spawnSync('tar', ['-xzf', archive, '-C', toolsDirectory, 'gitleaks'], {
    encoding: 'utf8',
  })
  if (extracted.status !== 0) {
    throw new Error(extracted.stderr.trim() || 'could not extract the pinned gitleaks archive')
  }
  chmodSync(binary, 0o700)
  const reported = spawnSync(binary, ['version'], { encoding: 'utf8' })
  if (reported.status !== 0 || !reported.stdout.includes(version)) {
    throw new Error(
      reported.stderr.trim() ||
      `installed gitleaks did not report the expected version ${version}`,
    )
  }
  writeFileSync(
    join(toolsDirectory, 'gitleaks-install.json'),
    `${JSON.stringify({
      version,
      archive_sha256: actualSha256,
      source,
      reported_version: reported.stdout.trim(),
    }, null, 2)}\n`,
    { mode: 0o600 },
  )
  console.log(`gitleaks ${version} installed with verified archive checksum`)
} finally {
  rmSync(archive, { force: true })
}
