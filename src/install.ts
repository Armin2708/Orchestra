import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

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

function writeVerified(settingsPath: string, value: any): void {
  const serialized = JSON.stringify(value, null, 2) + '\n'
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
  fs.writeFileSync(settingsPath, serialized)
  // Configuration may be watched by another process. Never report success if our
  // just-written content was immediately replaced or only partially persisted.
  if (fs.readFileSync(settingsPath, 'utf8') !== serialized)
    throw new Error(`hook configuration changed while writing ${settingsPath}`)
}

export function installHooks(scope: HookScope, value?: string | HookInstallOptions): void {
  const options = optionsFrom(value)
  for (const provider of providersFor(options.provider ?? 'claude')) {
    const settingsPath = options.settingsPaths?.[provider] ?? hookSettingsPath(scope, provider, options.roots)
    const settings = fs.existsSync(settingsPath) ? JSON.parse(fs.readFileSync(settingsPath, 'utf8')) : {}
    settings.hooks ??= {}
    for (const [event, entry] of Object.entries(hooksFor(provider))) {
      settings.hooks[event] ??= []
      if (!settings.hooks[event].some((candidate: any) => hasMarker(candidate, provider)))
        settings.hooks[event].push(entry)
    }
    writeVerified(settingsPath, settings)
    console.log(`orchestra ${provider} hooks installed in ${settingsPath}`)
  }
}

export function uninstallHooks(scope: HookScope, value?: string | HookInstallOptions): void {
  const options = optionsFrom(value)
  for (const provider of providersFor(options.provider ?? 'claude')) {
    const settingsPath = options.settingsPaths?.[provider] ?? hookSettingsPath(scope, provider, options.roots)
    if (!fs.existsSync(settingsPath)) continue
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
    for (const event of Object.keys(settings.hooks ?? {})) {
      settings.hooks[event] = settings.hooks[event]
        .filter((entry: any) => !hasMarker(entry, provider))
      if (settings.hooks[event].length === 0) delete settings.hooks[event]
    }
    writeVerified(settingsPath, settings)
    console.log(`orchestra ${provider} hooks removed from ${settingsPath}`)
  }
}
