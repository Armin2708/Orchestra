import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const root = path.join(__dirname, '..')
const json = (relative: string) => JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'))

describe('dual-provider plugin manifests', () => {
  it('ships separate Claude and Codex lifecycle contracts', () => {
    const claude = json('hooks/hooks.json')
    const codex = json('hooks/codex-hooks.json')

    expect(claude.hooks.SessionEnd).toHaveLength(1)
    expect(JSON.stringify(claude)).toContain('--provider claude')
    expect(Object.keys(codex.hooks).sort()).toEqual([
      'PermissionRequest', 'PostToolUse', 'SessionStart', 'Stop',
      'SubagentStart', 'SubagentStop', 'UserPromptSubmit',
    ].sort())
    expect(codex.hooks.SessionStart[0].matcher).toBe('startup|resume')
    expect(codex.hooks.SessionEnd).toBeUndefined()
    expect(JSON.stringify(codex)).toContain('--provider codex')
  })

  it('points the Codex plugin at its provider-specific hooks and includes plugin assets in npm', () => {
    const plugin = json('.codex-plugin/plugin.json')
    const pkg = json('package.json')

    expect(plugin).toMatchObject({
      name: 'orchestra',
      version: pkg.version,
      hooks: './hooks/codex-hooks.json',
    })
    expect(pkg.files).toEqual(expect.arrayContaining(['hooks', '.claude-plugin', '.codex-plugin']))
  })
})
