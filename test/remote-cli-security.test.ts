import { spawnSync } from 'node:child_process'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('remote CLI pre-exposure validation', () => {
  for (const args of [
    ['--board', 'not-a-board'],
    ['--scope', 'observe', 'unknown-scope'],
  ]) {
    it(`rejects ${args.join(' ')} before daemon or tunnel startup`, () => {
      const orchestraHome = mkdtempSync(join(tmpdir(), 'orchestra-remote-cli-'))
      const result = spawnSync(process.execPath, [
        '--import', 'tsx', 'src/cli.ts', 'remote', ...args,
      ], {
        cwd: process.cwd(),
        encoding: 'utf8',
        timeout: 10_000,
        env: { ...process.env, ORCHESTRA_HOME: orchestraHome },
      })
      expect(result.status).not.toBe(0)
      expect(`${result.stdout}${result.stderr}`).toMatch(/--board values|--scope contains/u)
      expect(existsSync(join(orchestraHome, 'remote.json'))).toBe(false)
      expect(existsSync(join(orchestraHome, 'daemon.pid'))).toBe(false)
    })
  }
})
