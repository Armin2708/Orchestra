import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export type HookProvider = 'claude' | 'codex'
export type InstallProvider = HookProvider | 'both'
export type HookScope = 'global' | 'project'

export interface HookInstallOptions {
  /** Claude remains the default for backwards compatibility. */
  provider?: InstallProvider
  /** Test/embedding override; normal CLI installs use the provider defaults. */
  settingsPaths?: Partial<Record<HookProvider, string>>
  /** Test/embedding override for resolving global and project locations. */
  roots?: { home?: string; cwd?: string; codexHome?: string }
}

const MARKER = 'orchestra hook'
const command = (event: string, provider: HookProvider) =>
  `${MARKER} ${event} --provider ${provider}`

const CLAUDE_HOOKS: Record<string, any> = {
  SessionStart: { hooks: [{ type: 'command', command: command('session-start', 'claude') }] },
  PostToolUse: { matcher: '*', hooks: [{ type: 'command', command: command('post-tool-use', 'claude') }] },
  UserPromptSubmit: { hooks: [{ type: 'command', command: command('user-prompt-submit', 'claude') }] },
  Stop: { hooks: [{ type: 'command', command: command('stop', 'claude') }] },
  SessionEnd: { hooks: [{ type: 'command', command: command('session-end', 'claude') }] },
}

const CODEX_HOOKS: Record<string, any> = {
  SessionStart: {
    matcher: 'startup|resume|clear|compact',
    hooks: [{ type: 'command', command: command('session-start', 'codex') }],
  },
  PostToolUse: { matcher: '*', hooks: [{ type: 'command', command: command('post-tool-use', 'codex') }] },
  UserPromptSubmit: { hooks: [{ type: 'command', command: command('user-prompt-submit', 'codex') }] },
  Stop: { hooks: [{ type: 'command', command: command('stop', 'codex') }] },
  PermissionRequest: { matcher: '*', hooks: [{ type: 'command', command: command('permission-request', 'codex') }] },
  SubagentStart: { matcher: '*', hooks: [{ type: 'command', command: command('subagent-start', 'codex') }] },
  SubagentStop: { matcher: '*', hooks: [{ type: 'command', command: command('subagent-stop', 'codex') }] },
}

const hooksFor = (provider: HookProvider) => provider === 'claude' ? CLAUDE_HOOKS : CODEX_HOOKS

export function hookSettingsPath(
  scope: HookScope,
  provider: HookProvider,
  roots: HookInstallOptions['roots'] = {},
): string {
  const root = scope === 'global' ? (roots?.home ?? os.homedir()) : (roots?.cwd ?? process.cwd())
  if (provider === 'claude') return path.join(root, '.claude', 'settings.json')
  if (scope === 'project') return path.join(root, '.codex', 'hooks.json')
  const codexHome = roots?.codexHome
    ?? (roots?.home === undefined ? process.env.CODEX_HOME : undefined)
    ?? path.join(root, '.codex')
  return path.join(codexHome, 'hooks.json')
}

const markerProvider = (entry: any): HookProvider | undefined => {
  const encoded = JSON.stringify(entry?.hooks ?? [])
  if (!encoded.includes(MARKER)) return undefined
  const explicit = encoded.match(/--provider(?:=|\s+)(claude|codex)/)?.[1]
  // Orchestra hooks installed before provider support were Claude hooks.
  return explicit === 'codex' ? 'codex' : 'claude'
}

const hasMarker = (entry: any, provider: HookProvider) => markerProvider(entry) === provider

function providersFor(provider: InstallProvider): HookProvider[] {
  if (provider === 'both') return ['claude', 'codex']
  if (provider === 'claude' || provider === 'codex') return [provider]
  throw new Error(`unsupported hook provider: ${provider}`)
}

function optionsFrom(value?: string | HookInstallOptions): HookInstallOptions {
  // Preserve installHooks(scope, explicitClaudeSettingsPath) for existing callers.
  return typeof value === 'string' ? { provider: 'claude', settingsPaths: { claude: value } } : (value ?? {})
}

export type HookSettingsSnapshot = Readonly<{
  settingsPath: string
  exists: boolean
  content: string | null
  mode: number | null
}>

const snapshotPath = (settingsPath: string): HookSettingsSnapshot => {
  let before: fs.Stats
  try {
    before = fs.lstatSync(settingsPath)
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      return { settingsPath, exists: false, content: null, mode: null }
    }
    throw error
  }
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(`hook configuration must be a regular non-symlink file: ${settingsPath}`)
  }
  const content = fs.readFileSync(settingsPath, 'utf8')
  const after = fs.lstatSync(settingsPath)
  if (before.dev !== after.dev || before.ino !== after.ino
    || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    throw new Error(`hook configuration changed while snapshotting ${settingsPath}`)
  }
  return {
    settingsPath,
    exists: true,
    content,
    mode: after.mode & 0o777,
  }
}

const snapshotMatches = (expected: HookSettingsSnapshot): boolean => {
  const current = snapshotPath(expected.settingsPath)
  return current.exists === expected.exists
    && current.content === expected.content
    && current.mode === expected.mode
}

const settingsWithProviderHooks = (
  snapshot: HookSettingsSnapshot,
  provider: HookProvider,
): Record<string, any> => {
  const settings = snapshot.exists ? JSON.parse(snapshot.content!) : {}
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new Error(`hook configuration must contain a JSON object: ${snapshot.settingsPath}`)
  }
  const result = structuredClone(settings)
  result.hooks ??= {}
  if (!result.hooks || typeof result.hooks !== 'object' || Array.isArray(result.hooks)) {
    throw new Error(`hook configuration hooks must be an object: ${snapshot.settingsPath}`)
  }
  for (const [event, entry] of Object.entries(hooksFor(provider))) {
    result.hooks[event] ??= []
    if (!Array.isArray(result.hooks[event])) {
      throw new Error(`hook configuration event must be an array: ${event}`)
    }
    if (!result.hooks[event].some((candidate: any) => hasMarker(candidate, provider))) {
      result.hooks[event].push(entry)
    }
  }
  return result
}

const lockPathFor = (settingsPath: string) => `${settingsPath}.orchestra.lock`

const withHookLock = <T>(settingsPath: string, action: () => T): T => {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true, mode: 0o700 })
  const lockPath = lockPathFor(settingsPath)
  let descriptor: number
  try {
    descriptor = fs.openSync(lockPath, 'wx', 0o600)
  } catch (error: any) {
    if (error?.code === 'EEXIST') {
      throw new Error(`hook configuration is locked by another writer: ${settingsPath}`)
    }
    throw error
  }
  const lockToken = `${process.pid}:${randomUUID()}\n`
  try {
    fs.writeFileSync(descriptor, lockToken)
    fs.fsyncSync(descriptor)
    if ((fs.fstatSync(descriptor).mode & 0o777) !== 0o600) {
      throw new Error(`hook writer lock mode did not verify as 600: ${settingsPath}`)
    }
    return action()
  } finally {
    fs.closeSync(descriptor)
    const currentLock = fs.readFileSync(lockPath, 'utf8')
    if (currentLock !== lockToken) {
      throw new Error(`hook writer lock changed concurrently; refusing removal: ${settingsPath}`)
    }
    fs.unlinkSync(lockPath)
  }
}

function writeVerified(
  settingsPath: string,
  value: any,
  expected: HookSettingsSnapshot,
): void {
  const serialized = JSON.stringify(value, null, 2) + '\n'
  withHookLock(settingsPath, () => {
    if (!snapshotMatches(expected)) {
      throw new Error(`hook configuration changed concurrently; refusing to overwrite ${settingsPath}`)
    }
    const temporary = path.join(
      path.dirname(settingsPath),
      `.${path.basename(settingsPath)}.${process.pid}.${randomUUID()}.tmp`,
    )
    const mode = expected.mode ?? 0o600
    let descriptor: number | null = null
    try {
      descriptor = fs.openSync(temporary, 'wx', mode)
      fs.writeFileSync(descriptor, serialized)
      fs.fsyncSync(descriptor)
      fs.closeSync(descriptor)
      descriptor = null
      if (!snapshotMatches(expected)) {
        throw new Error(`hook configuration changed concurrently; refusing to overwrite ${settingsPath}`)
      }
      fs.renameSync(temporary, settingsPath)
      fs.chmodSync(settingsPath, mode)
      const verified = snapshotPath(settingsPath)
      if (verified.content !== serialized || verified.mode !== mode) {
        throw new Error(`hook configuration changed while writing ${settingsPath}`)
      }
    } finally {
      if (descriptor !== null) fs.closeSync(descriptor)
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary)
    }
  })
}

export function snapshotHookSettings(
  scope: HookScope,
  provider: HookProvider,
  options: HookInstallOptions = {},
): HookSettingsSnapshot {
  return snapshotPath(options.settingsPaths?.[provider]
    ?? hookSettingsPath(scope, provider, options.roots))
}

const recognizedInstalledMutation = (
  previous: HookSettingsSnapshot,
  current: HookSettingsSnapshot,
  provider: HookProvider,
): boolean => {
  if (!current.exists || current.content === null
    || current.mode !== (previous.mode ?? 0o600)) return false
  try {
    return JSON.stringify(JSON.parse(current.content))
      === JSON.stringify(settingsWithProviderHooks(previous, provider))
  } catch {
    return false
  }
}

export function restoreHookSettingsAfterFailedInstall(
  previous: HookSettingsSnapshot,
  provider: HookProvider,
): void {
  withHookLock(previous.settingsPath, () => {
    const current = snapshotPath(previous.settingsPath)
    if (current.exists === previous.exists
      && current.content === previous.content
      && current.mode === previous.mode) return
    if (!recognizedInstalledMutation(previous, current, provider)) {
      throw new Error(
        `hook configuration changed concurrently; refusing rollback for ${previous.settingsPath}`,
      )
    }
    if (previous.exists) {
      const temporary = `${previous.settingsPath}.${process.pid}.${randomUUID()}.restore`
      let descriptor: number | null = null
      try {
        descriptor = fs.openSync(temporary, 'wx', previous.mode!)
        fs.writeFileSync(descriptor, previous.content!)
        fs.fsyncSync(descriptor)
        fs.closeSync(descriptor)
        descriptor = null
        if (!snapshotMatches(current)) {
          throw new Error(`hook configuration changed concurrently during rollback: ${previous.settingsPath}`)
        }
        fs.renameSync(temporary, previous.settingsPath)
        fs.chmodSync(previous.settingsPath, previous.mode!)
      } finally {
        if (descriptor !== null) fs.closeSync(descriptor)
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary)
      }
    } else {
      fs.unlinkSync(previous.settingsPath)
    }
    if (!snapshotMatches(previous)) {
      throw new Error(`hook configuration rollback did not verify: ${previous.settingsPath}`)
    }
  })
}

export function installHooks(scope: HookScope, value?: string | HookInstallOptions): void {
  const options = optionsFrom(value)
  const providers = providersFor(options.provider ?? 'claude')
  const snapshots = providers.map((provider) => ({
    provider,
    snapshot: snapshotHookSettings(scope, provider, options),
  }))
  try {
    for (const { provider, snapshot } of snapshots) {
      writeVerified(
        snapshot.settingsPath,
        settingsWithProviderHooks(snapshot, provider),
        snapshot,
      )
    }
  } catch (error) {
    const rollbackErrors: unknown[] = []
    for (const { provider, snapshot } of [...snapshots].reverse()) {
      try {
        if (snapshotMatches(snapshot)) continue
        restoreHookSettingsAfterFailedInstall(snapshot, provider)
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError)
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError([error, ...rollbackErrors], 'hook installation failed and rollback was incomplete')
    }
    throw error
  }
  for (const { provider, snapshot } of snapshots) {
    console.log(`orchestra ${provider} hooks installed in ${snapshot.settingsPath}`)
  }
}

export function uninstallHooks(scope: HookScope, value?: string | HookInstallOptions): void {
  const options = optionsFrom(value)
  for (const provider of providersFor(options.provider ?? 'claude')) {
    const settingsPath = options.settingsPaths?.[provider] ?? hookSettingsPath(scope, provider, options.roots)
    const snapshot = snapshotPath(settingsPath)
    if (!snapshot.exists) continue
    const settings = JSON.parse(snapshot.content!)
    for (const event of Object.keys(settings.hooks ?? {})) {
      settings.hooks[event] = settings.hooks[event]
        .filter((entry: any) => !hasMarker(entry, provider))
      if (settings.hooks[event].length === 0) delete settings.hooks[event]
    }
    writeVerified(settingsPath, settings, snapshot)
    console.log(`orchestra ${provider} hooks removed from ${settingsPath}`)
  }
}
