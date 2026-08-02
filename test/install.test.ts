import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  hookSettingsPath,
  installHooks,
  runHookInstallTransaction,
  uninstallHooks,
} from '../src/install.js'

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-hooks-'))
const read = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'))
const write = (file: string, value: any) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value))
}

describe('provider hook installation', () => {
  it('installs Claude idempotently and preserves existing hooks', () => {
    const home = temp()
    const file = path.join(home, 'settings.json')
    const options = {
      provider: 'claude' as const,
      settingsPaths: { claude: file },
      roots: { home },
    }
    write(file, {
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'afplay done.aiff' }] }] },
    })
    installHooks('global', options)
    installHooks('global', options)

    const settings = read(file)
    expect(settings.hooks.SessionStart).toHaveLength(1)
    expect(settings.hooks.Stop).toHaveLength(2)
    expect(JSON.stringify(settings)).toContain('orchestra hook post-tool-use --provider claude')
    expect(settings.hooks.SessionEnd).toHaveLength(1)

    uninstallHooks('global', options)
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
    expect(codex.hooks.SessionStart[0].matcher).toBe('startup|resume|clear|compact')
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

  it('honors CODEX_HOME for global Codex hooks', () => {
    const codexHome = temp()
    expect(hookSettingsPath('global', 'codex', { codexHome }))
      .toBe(path.join(codexHome, 'hooks.json'))
  })

  it('treats old provider-less Orchestra entries as Claude during upgrades and uninstall', () => {
    const home = temp()
    const file = path.join(home, 'settings.json')
    const options = {
      provider: 'claude' as const,
      settingsPaths: { claude: file },
      roots: { home },
    }
    write(file, {
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: 'orchestra hook session-start' }] }],
      },
    })

    installHooks('global', options)
    expect(read(file).hooks.SessionStart).toHaveLength(1)
    uninstallHooks('global', options)
    expect(read(file).hooks.SessionStart).toBeUndefined()
  })

  it('refuses a contended writer lock without changing existing bytes or mode', () => {
    const home = temp()
    const file = path.join(home, 'settings.json')
    const options = {
      provider: 'claude' as const,
      settingsPaths: { claude: file },
      roots: { home },
    }
    const original = '{"description":"exact bytes"}\n'
    write(file, { description: 'placeholder' })
    fs.writeFileSync(file, original)
    fs.chmodSync(file, 0o640)
    fs.writeFileSync(`${file}.orchestra.lock`, 'another writer\n', { mode: 0o600 })

    expect(() => installHooks('global', options)).toThrow('locked by another writer')
    expect(fs.readFileSync(file, 'utf8')).toBe(original)
    expect(fs.statSync(file).mode & 0o777).toBe(0o640)
  })

  it('refuses rollback over an unrecognized concurrent edit', () => {
    const home = temp()
    const file = path.join(home, 'settings.json')
    const options = {
      provider: 'claude' as const,
      settingsPaths: { claude: file },
      roots: { home },
    }
    write(file, { description: 'before' })
    const concurrent = JSON.stringify({ description: 'concurrent owner' })

    expect(() => runHookInstallTransaction('global', options, (transaction) => {
      installHooks('global', options, transaction)
      fs.writeFileSync(file, concurrent)
      throw new Error('simulated downstream failure')
    })).toThrow('cleanup was incomplete')
    expect(read(file)).toEqual({ description: 'concurrent owner' })
  })

  it('rolls an earlier provider back exactly when a later provider is contended', () => {
    const home = temp()
    const claudePath = hookSettingsPath('global', 'claude', { home })
    const codexPath = hookSettingsPath('global', 'codex', { home })
    write(claudePath, { description: 'claude exact' })
    write(codexPath, { description: 'codex exact' })
    const claudeBytes = fs.readFileSync(claudePath, 'utf8')
    const codexBytes = fs.readFileSync(codexPath, 'utf8')
    fs.chmodSync(claudePath, 0o640)
    fs.chmodSync(codexPath, 0o600)
    fs.writeFileSync(`${codexPath}.orchestra.lock`, 'other writer\n', { mode: 0o600 })

    expect(() => installHooks('global', { provider: 'both', roots: { home } }))
      .toThrow('locked by another writer')
    expect(fs.readFileSync(claudePath, 'utf8')).toBe(claudeBytes)
    expect(fs.statSync(claudePath).mode & 0o777).toBe(0o640)
    expect(fs.readFileSync(codexPath, 'utf8')).toBe(codexBytes)

    fs.unlinkSync(`${codexPath}.orchestra.lock`)
    installHooks('global', { provider: 'both', roots: { home } })
    expect(JSON.stringify(read(claudePath))).toContain('--provider claude')
    expect(JSON.stringify(read(codexPath))).toContain('--provider codex')
  })

  it.skipIf(process.platform === 'win32')('never follows or replaces a provider settings symlink', () => {
    const root = temp()
    const target = path.join(root, 'real-settings.json')
    const link = path.join(root, 'settings.json')
    fs.writeFileSync(target, '{"description":"outside owner"}\n')
    fs.symlinkSync(target, link)

    expect(() => installHooks('global', {
      provider: 'claude',
      settingsPaths: { claude: link },
      roots: { home: root },
    })).toThrow('regular non-symlink file')
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true)
    expect(fs.readFileSync(target, 'utf8')).toBe('{"description":"outside owner"}\n')
    expect(fs.existsSync(`${link}.orchestra.lock`)).toBe(false)
  })

  it.skipIf(process.platform === 'win32')('releases every acquired provider lock when a later snapshot fails', () => {
    const home = temp()
    const claudePath = hookSettingsPath('global', 'claude', { home })
    const codexPath = hookSettingsPath('global', 'codex', { home })
    const outside = path.join(temp(), 'outside-hooks.json')
    const claudeBytes = '{"description":"preserve first provider"}\n'
    fs.mkdirSync(path.dirname(claudePath), { recursive: true })
    fs.mkdirSync(path.dirname(codexPath), { recursive: true })
    fs.writeFileSync(claudePath, claudeBytes)
    fs.writeFileSync(outside, '{"description":"outside owner"}\n')
    fs.symlinkSync(outside, codexPath)

    expect(() => installHooks('global', { provider: 'both', roots: { home } }))
      .toThrow('regular non-symlink file')
    expect(fs.readFileSync(claudePath, 'utf8')).toBe(claudeBytes)
    expect(fs.lstatSync(codexPath).isSymbolicLink()).toBe(true)
    expect(fs.existsSync(`${claudePath}.orchestra.lock`)).toBe(false)
    expect(fs.existsSync(`${codexPath}.orchestra.lock`)).toBe(false)
  })

  it.skipIf(process.platform === 'win32')('rejects a project .codex parent symlink escape', () => {
    const cwd = temp()
    const outside = temp()
    fs.symlinkSync(outside, path.join(cwd, '.codex'))

    expect(() => installHooks('project', { provider: 'codex', roots: { cwd } }))
      .toThrow('parent component must be a physical directory')
    expect(fs.existsSync(path.join(outside, 'hooks.json'))).toBe(false)
  })

  it.skipIf(process.platform === 'win32')('rejects global .claude and .codex parent symlink escapes', () => {
    const claudeHome = temp()
    const codexHome = temp()
    const claudeOutside = temp()
    const codexOutside = temp()
    fs.symlinkSync(claudeOutside, path.join(claudeHome, '.claude'))
    fs.symlinkSync(codexOutside, path.join(codexHome, '.codex'))

    expect(() => installHooks('global', { provider: 'claude', roots: { home: claudeHome } }))
      .toThrow('parent component must be a physical directory')
    expect(() => installHooks('global', { provider: 'codex', roots: { home: codexHome } }))
      .toThrow('parent component must be a physical directory')
    expect(fs.existsSync(path.join(claudeOutside, 'settings.json'))).toBe(false)
    expect(fs.existsSync(path.join(codexOutside, 'hooks.json'))).toBe(false)
  })
})
