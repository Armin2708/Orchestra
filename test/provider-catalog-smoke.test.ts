import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { evaluateCatalogSmoke } from '../src/provider-catalog-smoke.js'

const asList = (raw: unknown): readonly unknown[] => (Array.isArray(raw) ? raw : [])

const deps = (over: Partial<Parameters<typeof evaluateCatalogSmoke>[0]> = {}) => ({
  resolveExecutable: () => '/bundled/claude',
  readVersion: () => '2.1.222 (Claude Code)',
  readModels: () => [{ value: 'opus' }, { value: 'sonnet' }],
  ...over,
})

describe('provider catalog smoke gate', () => {
  it('passes when the CLI reports a version and a non-empty catalog', () => {
    const result = evaluateCatalogSmoke(deps(), asList)
    expect(result.ok).toBe(true)
    expect(result.version).toBe('2.1.222')
    expect(result.modelCount).toBe(2)
    expect(result.failures).toEqual([])
  })

  // The bug this gate exists for: everything builds, but the picker would be empty.
  it('FAILS on an empty model catalog even when the CLI is otherwise healthy', () => {
    const result = evaluateCatalogSmoke(deps({ readModels: () => [] }), asList)
    expect(result.ok).toBe(false)
    expect(result.failures.join(' ')).toMatch(/EMPTY model catalog/)
  })

  it('fails when the CLI reports no parseable version', () => {
    const result = evaluateCatalogSmoke(deps({ readVersion: () => null }), asList)
    expect(result.ok).toBe(false)
    expect(result.failures.join(' ')).toMatch(/parseable --version/)
  })

  it('fails closed when no bundled CLI resolves for the platform', () => {
    const result = evaluateCatalogSmoke(deps({ resolveExecutable: () => null }), asList)
    expect(result.ok).toBe(false)
    expect(result.executable).toBeNull()
    expect(result.failures.join(' ')).toMatch(/no provider CLI resolved/)
  })

  it('reports a throwing catalog probe as a failure instead of crashing', () => {
    const result = evaluateCatalogSmoke(
      deps({ readModels: () => { throw new Error('spawn EACCES') } }),
      asList,
    )
    expect(result.ok).toBe(false)
    expect(result.failures.join(' ')).toMatch(/spawn EACCES/)
  })
})

describe('check-provider-catalog.mjs release gate', () => {
  const runGate = (cliPath: string) => {
    try {
      execFileSync(process.execPath, ['scripts/check-provider-catalog.mjs'], {
        encoding: 'utf8',
        env: { ...process.env, ORCHESTRA_CATALOG_SMOKE_CLI: cliPath },
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30_000,
      })
      return 0
    } catch (error) {
      return (error as { status?: number }).status ?? 1
    }
  }

  const stubCli = (name: string, script: string): string => {
    const dir = mkdtempSync(join(tmpdir(), 'catalog-smoke-'))
    const path = join(dir, name)
    writeFileSync(path, script)
    chmodSync(path, 0o755)
    return path
  }

  it('exits non-zero for a CLI whose catalog is empty', () => {
    const cli = stubCli('empty', '#!/bin/sh\ncase "$1" in --version) echo "9.9.9 (Fake)";; *) echo "[]";; esac\n')
    expect(runGate(cli)).not.toBe(0)
  })

  it('exits non-zero for a CLI that cannot run at all', () => {
    const cli = stubCli('broken', '#!/bin/sh\nexit 1\n')
    expect(runGate(cli)).not.toBe(0)
  })

  it('exits zero for a healthy CLI', () => {
    const cli = stubCli(
      'healthy',
      '#!/bin/sh\ncase "$1" in --version) echo "2.1.222 (Claude Code)";; '
      + '*) echo \'{"models":[{"value":"opus"},{"value":"sonnet"}]}\';; esac\n',
    )
    expect(runGate(cli)).toBe(0)
  })
})
