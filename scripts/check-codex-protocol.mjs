#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const contract = JSON.parse(readFileSync(new URL('./codex-protocol-contract.json', import.meta.url), 'utf8'))
const command = process.env.ORCHESTRA_CODEX_COMMAND?.trim() || 'codex'
const allowUnsupported = process.env.ORCHESTRA_CODEX_PROTOCOL_ALLOW_UNSUPPORTED === '1'

const run = (args) => spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const versionResult = run(['--version'])
if (versionResult.status !== 0) {
  console.error(`Codex CLI is required for protocol verification: ${versionResult.stderr.trim() || versionResult.error?.message || 'not found'}`)
  process.exit(1)
}
const versionOutput = versionResult.stdout.trim()
if (!versionOutput.includes(contract.cli_version) && !allowUnsupported) {
  console.error(`Codex protocol target is ${contract.cli_version}, but installed CLI reports ${versionOutput}.`)
  console.error('Review and update the snapshot, or set ORCHESTRA_CODEX_PROTOCOL_ALLOW_UNSUPPORTED=1 for an intentional local comparison.')
  process.exit(1)
}

const output = mkdtempSync(join(tmpdir(), 'orchestra-codex-protocol-'))
try {
  const generated = run(['app-server', 'generate-ts', '--experimental', '--out', output])
  if (generated.status !== 0) {
    console.error(generated.stderr.trim() || generated.stdout.trim() || 'Codex protocol generation failed.')
    process.exitCode = 1
  } else {
    const files = readdirSync(output, { recursive: true })
      .filter((file) => typeof file === 'string' && file.endsWith('.ts'))
      .sort()
    const hash = createHash('sha256')
    for (const file of files) {
      hash.update(file).update('\0').update(readFileSync(join(output, file))).update('\0')
    }
    const actual = { file_count: files.length, sha256: hash.digest('hex') }
    if (actual.file_count !== contract.file_count || actual.sha256 !== contract.sha256) {
      console.error('Codex app-server protocol drift detected.')
      console.error(`expected ${contract.file_count} files / ${contract.sha256}`)
      console.error(`actual   ${actual.file_count} files / ${actual.sha256}`)
      console.error('Audit src/codex/protocol.ts and runtime mappings, then update scripts/codex-protocol-contract.json deliberately.')
      process.exitCode = 1
    } else {
      console.log(`Codex app-server protocol ${contract.cli_version} verified (${actual.file_count} files, ${actual.sha256.slice(0, 12)}…).`)
    }
  }
} finally {
  rmSync(output, { recursive: true, force: true })
}
