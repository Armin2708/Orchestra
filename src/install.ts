import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

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
  SessionEnd: { hooks: [{ type: 'command', command: command('session-end', 'codex') }] },
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

type HookSettingsSnapshot = Readonly<{
  settingsPath: string
  exists: boolean
  content: string | null
  mode: number | null
}>

type ResolvedHookTarget = Readonly<{
  provider: HookProvider
  settingsPath: string
  physicalRoot: string
  parentPath: string
}>

type HookWriterLock = Readonly<{
  target: ResolvedHookTarget
  lockPath: string
  descriptor: number
  token: string
}>

export type HookInstallTransaction = {
  readonly id: string
  readonly scope: HookScope
  readonly targets: readonly ResolvedHookTarget[]
  readonly snapshots: ReadonlyMap<string, HookSettingsSnapshot>
  readonly ownedCurrent: Map<string, HookSettingsSnapshot>
  readonly locks: readonly HookWriterLock[]
  active: boolean
}

const fsyncDirectory = (directory: string): void => {
  if (process.platform === 'win32') return
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY)
  try { fs.fsyncSync(descriptor) } finally { fs.closeSync(descriptor) }
}

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
  return { settingsPath, exists: true, content, mode: after.mode & 0o777 }
}

const snapshotsMatch = (left: HookSettingsSnapshot, right: HookSettingsSnapshot): boolean =>
  left.settingsPath === right.settingsPath
  && left.exists === right.exists
  && left.content === right.content
  && left.mode === right.mode

const snapshotMatches = (expected: HookSettingsSnapshot): boolean =>
  snapshotsMatch(snapshotPath(expected.settingsPath), expected)

const ensurePhysicalBase = (input: string, allowCreate: boolean): string => {
  if (!path.isAbsolute(input)) throw new Error(`hook containment root must be absolute: ${input}`)
  try {
    const physical = fs.realpathSync(input)
    if (!fs.statSync(physical).isDirectory()) throw new Error('not a directory')
    return physical
  } catch (error: any) {
    if (!allowCreate || (error?.code !== 'ENOENT' && error?.message !== 'not a directory')) {
      throw new Error(`hook containment root must be an existing directory: ${input}`)
    }
  }
  const missing: string[] = []
  let existing = path.resolve(input)
  while (true) {
    try {
      fs.lstatSync(existing)
      break
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error
      const parent = path.dirname(existing)
      if (parent === existing) throw new Error(`cannot resolve hook containment root: ${input}`)
      missing.unshift(path.basename(existing))
      existing = parent
    }
  }
  let physical = fs.realpathSync(existing)
  if (!fs.statSync(physical).isDirectory()) {
    throw new Error(`hook containment ancestor is not a directory: ${existing}`)
  }
  for (const component of missing) {
    const next = path.join(physical, component)
    fs.mkdirSync(next, { mode: 0o700 })
    fsyncDirectory(physical)
    const stat = fs.lstatSync(next)
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`hook containment component is not a physical directory: ${next}`)
    }
    physical = next
  }
  return physical
}

const ensurePhysicalParent = (physicalRoot: string, relativeParent: string): string => {
  let current = physicalRoot
  if (!relativeParent || relativeParent === '.') return current
  for (const component of relativeParent.split(path.sep)) {
    if (!component || component === '.' || component === '..') {
      throw new Error('hook path contains an invalid parent component')
    }
    const next = path.join(current, component)
    let stat: fs.Stats
    try {
      stat = fs.lstatSync(next)
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error
      fs.mkdirSync(next, { mode: 0o700 })
      fsyncDirectory(current)
      stat = fs.lstatSync(next)
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`hook parent component must be a physical directory: ${next}`)
    }
    const physical = fs.realpathSync(next)
    if (physical !== next) {
      throw new Error(`hook parent component escaped physical containment: ${next}`)
    }
    current = next
  }
  return current
}

const resolvedHookTarget = (
  scope: HookScope,
  provider: HookProvider,
  options: HookInstallOptions,
): ResolvedHookTarget => {
  const home = options.roots?.home ?? os.homedir()
  const project = options.roots?.cwd ?? process.cwd()
  const configuredCodexHome = options.roots?.codexHome
    ?? (options.roots?.home === undefined ? process.env.CODEX_HOME : undefined)
  const codexHome = configuredCodexHome ?? path.join(home, '.codex')
  const baseInput = scope === 'project'
    ? project
    : provider === 'claude'
      ? home
      : codexHome
  const physicalRoot = scope === 'global' && provider === 'codex' && !configuredCodexHome
    ? ensurePhysicalParent(ensurePhysicalBase(home, false), '.codex')
    : ensurePhysicalBase(baseInput, scope === 'global' && provider === 'codex')
  const candidate = options.settingsPaths?.[provider]
    ?? hookSettingsPath(scope, provider, options.roots)
  if (!path.isAbsolute(candidate)) throw new Error(`hook settings path must be absolute: ${candidate}`)
  const relative = path.relative(path.resolve(baseInput), path.resolve(candidate))
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`hook settings path escapes its physical containment root: ${candidate}`)
  }
  const parentPath = ensurePhysicalParent(physicalRoot, path.dirname(relative))
  const settingsPath = path.join(parentPath, path.basename(relative))
  const physicalRelative = path.relative(physicalRoot, settingsPath)
  if (!physicalRelative || physicalRelative.startsWith('..') || path.isAbsolute(physicalRelative)) {
    throw new Error(`hook settings path escaped its physical containment root: ${candidate}`)
  }
  return { provider, settingsPath, physicalRoot, parentPath }
}

const targetsFor = (scope: HookScope, options: HookInstallOptions): ResolvedHookTarget[] => {
  const targets = providersFor(options.provider ?? 'claude')
    .map((provider) => resolvedHookTarget(scope, provider, options))
    .sort((left, right) => left.settingsPath < right.settingsPath
      ? -1
      : left.settingsPath > right.settingsPath ? 1 : 0)
  if (new Set(targets.map((target) => target.settingsPath)).size !== targets.length) {
    throw new Error('hook providers cannot share one settings target')
  }
  return targets
}

const exclusiveFlags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
  | (fs.constants.O_NOFOLLOW ?? 0)

const acquireWriterLock = (target: ResolvedHookTarget): HookWriterLock => {
  const lockPath = `${target.settingsPath}.orchestra.lock`
  let descriptor: number
  try {
    descriptor = fs.openSync(lockPath, exclusiveFlags, 0o600)
  } catch (error: any) {
    if (error?.code === 'EEXIST') {
      throw new Error(`hook configuration is locked by another writer: ${target.settingsPath}`)
    }
    throw error
  }
  const token = `${process.pid}:${randomUUID()}\n`
  try {
    fs.writeFileSync(descriptor, token)
    fs.fsyncSync(descriptor)
    if ((fs.fstatSync(descriptor).mode & 0o777) !== 0o600) {
      throw new Error(`hook writer lock mode did not verify as 600: ${target.settingsPath}`)
    }
    fsyncDirectory(target.parentPath)
    return { target, lockPath, descriptor, token }
  } catch (error) {
    fs.closeSync(descriptor)
    try { fs.unlinkSync(lockPath); fsyncDirectory(target.parentPath) } catch {}
    throw error
  }
}

const releaseWriterLock = (lock: HookWriterLock): void => {
  fs.closeSync(lock.descriptor)
  const current = fs.readFileSync(lock.lockPath, 'utf8')
  if (current !== lock.token) {
    throw new Error(`hook writer lock changed concurrently; refusing removal: ${lock.target.settingsPath}`)
  }
  fs.unlinkSync(lock.lockPath)
  fsyncDirectory(lock.target.parentPath)
}

const writeExactSnapshot = (
  expected: HookSettingsSnapshot,
  content: string,
  mode: number,
): HookSettingsSnapshot => {
  const directory = path.dirname(expected.settingsPath)
  const temporary = path.join(
    directory,
    `.${path.basename(expected.settingsPath)}.${process.pid}.${randomUUID()}.tmp`,
  )
  let descriptor: number | null = null
  try {
    descriptor = fs.openSync(temporary, exclusiveFlags, mode)
    fs.writeFileSync(descriptor, content)
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = null
    if (!snapshotMatches(expected)) {
      throw new Error(`hook configuration changed concurrently; refusing to overwrite ${expected.settingsPath}`)
    }
    fs.renameSync(temporary, expected.settingsPath)
    fs.chmodSync(expected.settingsPath, mode)
    fsyncDirectory(directory)
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor)
    if (fs.existsSync(temporary)) {
      fs.unlinkSync(temporary)
      fsyncDirectory(directory)
    }
  }
  const verified = snapshotPath(expected.settingsPath)
  if (verified.content !== content || verified.mode !== mode) {
    throw new Error(`hook configuration changed while writing ${expected.settingsPath}`)
  }
  return verified
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

const assertTransactionTargets = (
  transaction: HookInstallTransaction,
  scope: HookScope,
  options: HookInstallOptions,
): void => {
  if (!transaction.active || transaction.scope !== scope) {
    throw new Error('hook transaction is inactive or belongs to another scope')
  }
  const requested = targetsFor(scope, options)
  if (requested.length !== transaction.targets.length
    || requested.some((target, index) =>
      target.provider !== transaction.targets[index].provider
      || target.settingsPath !== transaction.targets[index].settingsPath)) {
    throw new Error('hook transaction targets do not match the requested provider paths')
  }
}

const writeTransactionValue = (
  transaction: HookInstallTransaction,
  target: ResolvedHookTarget,
  value: unknown,
): void => {
  const expected = transaction.ownedCurrent.get(target.settingsPath)
  if (!expected) throw new Error('hook transaction does not own the target snapshot')
  const serialized = `${JSON.stringify(value, null, 2)}\n`
  const written = writeExactSnapshot(expected, serialized, expected.mode ?? 0o600)
  transaction.ownedCurrent.set(target.settingsPath, written)
}

const rollbackTransaction = (transaction: HookInstallTransaction): unknown[] => {
  const errors: unknown[] = []
  for (const target of [...transaction.targets].reverse()) {
    const previous = transaction.snapshots.get(target.settingsPath)!
    const owned = transaction.ownedCurrent.get(target.settingsPath)!
    try {
      const current = snapshotPath(target.settingsPath)
      if (snapshotsMatch(current, previous)) continue
      if (!snapshotsMatch(current, owned)) {
        throw new Error(`hook configuration changed concurrently; refusing rollback for ${target.settingsPath}`)
      }
      if (previous.exists) {
        transaction.ownedCurrent.set(
          target.settingsPath,
          writeExactSnapshot(current, previous.content!, previous.mode!),
        )
      } else {
        fs.unlinkSync(target.settingsPath)
        fsyncDirectory(target.parentPath)
        const absent = snapshotPath(target.settingsPath)
        if (absent.exists) throw new Error(`hook rollback did not remove ${target.settingsPath}`)
        transaction.ownedCurrent.set(target.settingsPath, absent)
      }
    } catch (error) {
      errors.push(error)
    }
  }
  return errors
}

const releaseTransaction = (transaction: HookInstallTransaction): unknown[] => {
  const errors: unknown[] = []
  for (const lock of [...transaction.locks].reverse()) {
    try { releaseWriterLock(lock) } catch (error) { errors.push(error) }
  }
  transaction.active = false
  return errors
}

export function runHookInstallTransaction<T>(
  scope: HookScope,
  value: string | HookInstallOptions | undefined,
  action: (transaction: HookInstallTransaction, options: HookInstallOptions) => T,
): T {
  const options = optionsFrom(value)
  const targets = targetsFor(scope, options)
  const locks: HookWriterLock[] = []
  try {
    for (const target of targets) locks.push(acquireWriterLock(target))
  } catch (error) {
    const releaseErrors: unknown[] = []
    for (const lock of [...locks].reverse()) {
      try { releaseWriterLock(lock) } catch (releaseError) { releaseErrors.push(releaseError) }
    }
    if (releaseErrors.length) {
      throw new AggregateError([error, ...releaseErrors], 'hook lock acquisition failed and cleanup was incomplete')
    }
    throw error
  }
  let snapshots: Map<string, HookSettingsSnapshot>
  try {
    snapshots = new Map(targets.map((target) => [
      target.settingsPath,
      snapshotPath(target.settingsPath),
    ]))
  } catch (error) {
    const releaseErrors: unknown[] = []
    for (const lock of [...locks].reverse()) {
      try { releaseWriterLock(lock) } catch (releaseError) { releaseErrors.push(releaseError) }
    }
    if (releaseErrors.length) {
      throw new AggregateError(
        [error, ...releaseErrors],
        'hook snapshot failed and lock cleanup was incomplete',
      )
    }
    throw error
  }
  const transaction: HookInstallTransaction = {
    id: randomUUID(), scope, targets, snapshots,
    ownedCurrent: new Map(snapshots), locks, active: true,
  }
  try {
    const result = action(transaction, options)
    const releaseErrors = releaseTransaction(transaction)
    if (releaseErrors.length) {
      throw new AggregateError(releaseErrors, 'hook transaction committed but lock release was incomplete')
    }
    return result
  } catch (error) {
    const rollbackErrors = transaction.active ? rollbackTransaction(transaction) : []
    const releaseErrors = transaction.active ? releaseTransaction(transaction) : []
    if (rollbackErrors.length || releaseErrors.length) {
      throw new AggregateError(
        [error, ...rollbackErrors, ...releaseErrors],
        'hook transaction failed and cleanup was incomplete',
      )
    }
    throw error
  }
}

export function installHooks(
  scope: HookScope,
  value?: string | HookInstallOptions,
  transaction?: HookInstallTransaction,
): void {
  const options = optionsFrom(value)
  if (!transaction) {
    runHookInstallTransaction(scope, options, (owned) => installHooks(scope, options, owned))
    for (const target of targetsFor(scope, options)) {
      console.log(`orchestra ${target.provider} hooks installed in ${target.settingsPath}`)
    }
    return
  }
  assertTransactionTargets(transaction, scope, options)
  for (const target of transaction.targets) {
    const current = transaction.ownedCurrent.get(target.settingsPath)!
    writeTransactionValue(transaction, target, settingsWithProviderHooks(current, target.provider))
  }
}

// The workflow pack ships at the package root, next to dist/. Bundled (dist/cli.js) and
// source (src/install.ts) execution both sit one level under it, so ../workflows resolves
// in either case; ../../workflows covers a nested build layout. Probing beats hardcoding
// because the same file is imported from both places.
function workflowPackDir(): string {
  const candidates = ['../workflows', '../../workflows']
    .map((rel) => fileURLToPath(new URL(rel, import.meta.url)))
  const found = candidates.find((dir) => fs.existsSync(dir))
  if (!found) throw new Error(`orchestra workflow pack not found (looked in: ${candidates.join(', ')})`)
  return found
}

/**
 * Copy the shipped workflow command pack into `<target>/.claude/commands/`.
 * Global scope resolves the user's own home at runtime; project scope uses the cwd
 * unless a target root is passed. Returns the paths actually written — files whose
 * content already matches are left alone, and nothing is ever deleted.
 */
export function installWorkflows(scope: HookScope, targetRoot?: string): string[] {
  const root = targetRoot ?? (scope === 'global' ? os.homedir() : process.cwd())
  const packDir = workflowPackDir()
  const commandsDir = path.join(root, '.claude', 'commands')
  fs.mkdirSync(commandsDir, { recursive: true })
  const written: string[] = []
  for (const name of fs.readdirSync(packDir).filter((f) => f.endsWith('.md')).sort()) {
    const source = fs.readFileSync(path.join(packDir, name), 'utf8')
    const destination = path.join(commandsDir, name)
    const current = fs.existsSync(destination) ? fs.readFileSync(destination, 'utf8') : null
    if (current === source) continue
    fs.writeFileSync(destination, source)
    written.push(destination)
  }
  return written
}

export function uninstallHooks(scope: HookScope, value?: string | HookInstallOptions): void {
  const options = optionsFrom(value)
  runHookInstallTransaction(scope, options, (transaction) => {
    for (const target of transaction.targets) {
      const current = transaction.ownedCurrent.get(target.settingsPath)!
      if (!current.exists) continue
      const settings = JSON.parse(current.content!)
      for (const event of Object.keys(settings.hooks ?? {})) {
        if (!Array.isArray(settings.hooks[event])) {
          throw new Error(`hook configuration event must be an array: ${event}`)
        }
        settings.hooks[event] = settings.hooks[event]
          .filter((entry: any) => !hasMarker(entry, target.provider))
        if (settings.hooks[event].length === 0) delete settings.hooks[event]
      }
      writeTransactionValue(transaction, target, settings)
    }
  })
  for (const target of targetsFor(scope, options)) {
    console.log(`orchestra ${target.provider} hooks removed from ${target.settingsPath}`)
  }
}
