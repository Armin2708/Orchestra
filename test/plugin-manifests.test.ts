import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const root = path.join(__dirname, '..')
const json = (relative: string) => JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'))
// the plugin hook commands pin the exact published version — track package.json
const pinnedPackage = `orchestra-board@${json('package.json').version}`

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
    expect(codex.hooks.SessionStart[0].matcher).toBe('startup|resume|clear|compact')
    expect(codex.hooks.SessionEnd).toBeUndefined()
    expect(JSON.stringify(codex)).toContain('--provider codex')
    expect(JSON.stringify(codex)).toContain(pinnedPackage)
    expect(JSON.stringify(codex)).not.toContain('@latest')
    expect(JSON.stringify(claude)).toContain(pinnedPackage)
    expect(JSON.stringify(claude)).not.toContain('@latest')
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
    for (const manifest of [json('hooks/hooks.json'), json('hooks/codex-hooks.json')]) {
      expect(JSON.stringify(manifest)).toContain(`orchestra-board@${pkg.version}`)
    }
  })
})
