import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const sourceCli = path.join(repoRoot, 'src', 'cli.ts')
const tempRoots = new Set<string>()

afterEach(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true })
  tempRoots.clear()
})

describe('daemon environment preflight', () => {
  it('fails before opening state when a required runtime tool is missing', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'orchestra-environment-preflight-'))
    tempRoots.add(root)
    const emptyBin = path.join(root, 'empty-bin')
    const orchestraHome = path.join(root, 'orchestra-home')
    mkdirSync(emptyBin)

    const result = spawnSync(process.execPath, [tsxCli, sourceCli, 'serve'], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        ...process.env,
        PATH: emptyBin,
        ORCHESTRA_HOME: orchestraHome,
      },
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Managed runtime compatibility check failed')
    expect(result.stderr).toContain('npm: unsupported (not found)')
    expect(existsSync(orchestraHome)).toBe(false)
  })
})
