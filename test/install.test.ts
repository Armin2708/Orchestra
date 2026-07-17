import { expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { installHooks, uninstallHooks } from '../src/install.js'

it('installs idempotently, preserves existing hooks, uninstalls cleanly', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ab-')), 'settings.json')
  fs.writeFileSync(f, JSON.stringify({
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'afplay done.aiff' }] }] },
  }))
  installHooks('global', f)
  installHooks('global', f) // idempotent
  const s = JSON.parse(fs.readFileSync(f, 'utf8'))
  expect(s.hooks.SessionStart).toHaveLength(1)
  expect(s.hooks.Stop).toHaveLength(2) // existing + ours
  expect(JSON.stringify(s)).toContain('orchestra hook post-tool-use')

  uninstallHooks('global', f)
  const s2 = JSON.parse(fs.readFileSync(f, 'utf8'))
  expect(JSON.stringify(s2)).not.toContain('orchestra hook')
  expect(s2.hooks.Stop).toHaveLength(1) // existing preserved
})
