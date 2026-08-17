import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { installWorkflows } from '../src/install.js'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })

describe('workflows pack', () => {
  it('ships six generalized command files with no personal references', () => {
    // fileURLToPath, not URL.pathname: pathname keeps percent-encoding, so a checkout
    // under a path with a space would break the readFileSync below.
    const packDir = fileURLToPath(new URL('../workflows', import.meta.url))
    const pack = fs.readdirSync(packDir)
    expect(pack.sort()).toEqual(['build.md', 'execute.md', 'issue-plan.md', 'open-pr.md', 'plan.md', 'review-comments.md'])
    for (const f of pack) {
      const body = fs.readFileSync(path.join(packDir, f), 'utf8')
      expect(body).not.toMatch(/\/Users\/|~\/Vault|arminrad|Dolphy|TeamCreate/i)
      expect(body.startsWith('---\ndescription:')).toBe(true)
    }
  })

  it('copies the pack into a project .claude/commands and is idempotent', () => {
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-wf-'))
    dirs.push(target)
    const written = installWorkflows('project', target)
    expect(written).toHaveLength(6)
    expect(fs.existsSync(path.join(target, '.claude', 'commands', 'build.md'))).toBe(true)
    expect(installWorkflows('project', target)).toHaveLength(0) // unchanged → nothing rewritten
  })
})
