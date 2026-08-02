import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const root = path.resolve(import.meta.dirname, '..')
const contract = JSON.parse(
  fs.readFileSync(path.join(root, 'scripts/artifact-secret-scan-reviewed.json'), 'utf8'),
)
const scanner = fs.readFileSync(path.join(root, 'scripts/scan-package-artifact.mjs'), 'utf8')

describe('REL-010 exact artifact secret-scan review contract', () => {
  it('permits only exact path/rule/line/source-line reviewed findings', () => {
    expect(contract.schema_version).toBe(1)
    expect(contract.scanner_version).toBe('8.30.1')
    expect(contract.entries.length).toBeGreaterThan(0)
    expect(new Set(contract.entries.map((entry: Record<string, unknown>) =>
      `${entry.path}:${entry.rule_id}:${entry.line}`)).size).toBe(contract.entries.length)

    for (const entry of contract.entries) {
      expect(entry.path).toMatch(/^[A-Za-z0-9._/-]+$/)
      expect(entry.path).not.toContain('..')
      expect(entry.rule_id).toMatch(/^[a-z0-9-]+$/)
      expect(entry.line).toBeGreaterThan(0)
      expect(entry.line_sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(entry.rationale.length).toBeGreaterThan(40)
    }
    expect(scanner).toContain('entry.path === relativePath')
    expect(scanner).toContain('entry.rule_id === ruleId')
    expect(scanner).toContain('entry.line === line')
    expect(scanner).toContain('lineSha256 === reviewed.line_sha256')
    expect(scanner).toContain('artifact secret-review entries are stale or no longer observed')
    expect(scanner).not.toContain('--exit-code 0')
    expect(scanner).not.toContain('gitleaks:allow')
  })
})
