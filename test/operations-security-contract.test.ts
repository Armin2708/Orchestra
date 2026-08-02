import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const root = path.resolve(import.meta.dirname, '..')
const operationsRoot = path.join(root, 'src', 'operations')
const sources = fs.readdirSync(operationsRoot)
  .filter((name) => name.endsWith('.ts'))
  .map((name) => ({ name, source: fs.readFileSync(path.join(operationsRoot, name), 'utf8') }))

describe('operations security and documentation contract', () => {
  it('has no shell, dynamic execution, network, or unsafe temporary-file primitive', () => {
    const joined = sources.filter(({ name }) => name !== 'credentials.ts')
      .map(({ source }) => source).join('\n')
    for (const forbidden of [
      "node:child_process",
      'exec(',
      'execSync(',
      'spawn(',
      'spawnSync(',
      'eval(',
      'new Function(',
      "node:http",
      "node:https",
      'fetch(',
      'mkdtempSync(',
      'process.env',
    ]) expect(joined).not.toContain(forbidden)
    const credentials = sources.find(({ name }) => name === 'credentials.ts')?.source ?? ''
    expect(credentials).toContain("const KEYCHAIN_COMMAND = '/usr/bin/security'")
    expect(credentials).toContain("env: { PATH: '/usr/bin:/bin', LANG: 'C' }")
    expect(credentials).not.toContain('shell: true')
  })

  it('keeps diagnostics path creation exclusive and credential storage fail closed', () => {
    const diagnostics = sources.find(({ name }) => name === 'diagnostics.ts')?.source ?? ''
    expect(diagnostics).toContain('path.basename(artifact.filename)')
    expect(diagnostics).toContain('fs.constants.O_EXCL')
    expect(diagnostics).toContain('0o600')

    const credentials = sources.find(({ name }) => name === 'credentials.ts')?.source ?? ''
    expect(credentials).toContain('PlatformCredentialUnavailableError')
    expect(credentials).toContain('store.replace(')
    expect(credentials).not.toMatch(/writeFile|localStorage|sessionStorage|better-sqlite3/)
  })

  it('documents every owned OPS acceptance item without changing backlog state', () => {
    const document = fs.readFileSync(path.join(root, 'docs', 'operations-hardening.md'), 'utf8')
    for (const item of [
      'OPS-009', 'OPS-010', 'OPS-012', 'OPS-013', 'OPS-014', 'OPS-015', 'OPS-016',
      'OPS-017', 'OPS-018', 'OPS-019', 'OPS-021', 'OPS-022',
    ]) expect(document).toContain(`\`${item}\``)
    expect(document).toContain('does not update authoritative backlog')
    expect(document).toContain('local-only')
    expect(document).toContain('External service')
  })
})
