import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { hookSettingsPath, installHooks, uninstallHooks } from '../src/install.js'

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-hooks-'))
const read = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'))
const write = (file: string, value: any) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value))
}

describe('provider hook installation', () => {
  it('keeps the legacy Claude call signature idempotent and preserves existing hooks', () => {
    const file = path.join(temp(), 'settings.json')
    write(file, {
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'afplay done.aiff' }] }] },
    })
    installHooks('global', file)
    installHooks('global', file)

    const settings = read(file)
    expect(settings.hooks.SessionStart).toHaveLength(1)
    expect(settings.hooks.Stop).toHaveLength(2)
    expect(JSON.stringify(settings)).toContain('orchestra hook post-tool-use --provider claude')
    expect(settings.hooks.SessionEnd).toHaveLength(1)

    uninstallHooks('global', file)
    const removed = read(file)
    expect(JSON.stringify(removed)).not.toContain('orchestra hook')
    expect(removed.hooks.Stop).toHaveLength(1)
  })

  it('installs both providers globally, preserves unrelated entries, and removes only Orchestra hooks', () => {
    const home = temp()
    const claudePath = hookSettingsPath('global', 'claude', { home })
    const codexPath = hookSettingsPath('global', 'codex', { home })
    write(claudePath, {
      permissions: { allow: ['Read'] },
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'existing-claude-hook' }] }] },
    })
    write(codexPath, {
      description: 'keep me',
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'existing-codex-hook' }] }] },
    })

    installHooks('global', { provider: 'both', roots: { home } })
    installHooks('global', { provider: 'both', roots: { home } })

    const claude = read(claudePath)
    const codex = read(codexPath)
    expect(claude.permissions).toEqual({ allow: ['Read'] })
    expect(claude.hooks.Stop).toHaveLength(2)
    expect(claude.hooks.SessionEnd).toHaveLength(1)
    expect(codex.description).toBe('keep me')
    expect(codex.hooks.Stop).toHaveLength(2)
    expect(codex.hooks.SessionStart[0].matcher).toBe('startup|resume')
    expect(Object.keys(codex.hooks).sort()).toEqual([
      'PermissionRequest', 'PostToolUse', 'SessionStart', 'Stop',
      'SubagentStart', 'SubagentStop', 'UserPromptSubmit',
    ].sort())
    expect(codex.hooks.SessionEnd).toBeUndefined()
    expect(JSON.stringify(codex)).toContain('--provider codex')

    uninstallHooks('global', { provider: 'both', roots: { home } })
    expect(read(claudePath)).toEqual({
      permissions: { allow: ['Read'] },
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'existing-claude-hook' }] }] },
    })
    expect(read(codexPath)).toEqual({
      description: 'keep me',
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'existing-codex-hook' }] }] },
    })
  })

  it('resolves and installs project-local Codex hooks without touching Claude config', () => {
    const cwd = temp()
    const codexPath = hookSettingsPath('project', 'codex', { cwd })
    const claudePath = hookSettingsPath('project', 'claude', { cwd })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    installHooks('project', { provider: 'codex', roots: { cwd } })

    expect(codexPath).toBe(path.join(cwd, '.codex', 'hooks.json'))
    expect(claudePath).toBe(path.join(cwd, '.claude', 'settings.json'))
    expect(fs.existsSync(codexPath)).toBe(true)
    expect(fs.existsSync(claudePath)).toBe(false)
    expect(read(codexPath).hooks.SessionEnd).toBeUndefined()
    log.mockRestore()
  })

  it('treats old provider-less Orchestra entries as Claude during upgrades and uninstall', () => {
    const file = path.join(temp(), 'settings.json')
    write(file, {
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: 'orchestra hook session-start' }] }],
      },
    })

    installHooks('global', file)
    expect(read(file).hooks.SessionStart).toHaveLength(1)
    uninstallHooks('global', file)
    expect(read(file).hooks.SessionStart).toBeUndefined()
  })
})
