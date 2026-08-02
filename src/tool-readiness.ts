import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import {
  hookSettingsPath,
  type HookProvider,
  type HookScope,
} from './install.js'
import type { ToolIntegrationCheck } from './tool-capabilities.js'

const REQUIRED_HOOK_EVENTS: Readonly<Record<HookProvider, readonly string[]>> = Object.freeze({
  claude: Object.freeze([
    'SessionStart',
    'PostToolUse',
    'UserPromptSubmit',
    'Stop',
    'SessionEnd',
  ]),
  codex: Object.freeze([
    'SessionStart',
    'PostToolUse',
    'UserPromptSubmit',
    'Stop',
    'PermissionRequest',
    'SubagentStart',
    'SubagentStop',
  ]),
})

export type ProviderIntegrationInspectionOptions = {
  provider: HookProvider
  scope: HookScope
  roots?: { home?: string; cwd?: string; codexHome?: string }
  settingsPath?: string
  pluginRoot?: string
}

const pathFingerprint = (value: string): string =>
  `sha256:${createHash('sha256').update(path.resolve(value)).digest('hex').slice(0, 16)}`

const readJson = (file: string): Record<string, unknown> | null => {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

const commands = (value: unknown, output: string[] = []): string[] => {
  if (Array.isArray(value)) {
    for (const entry of value) commands(entry, output)
  } else if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (typeof record.command === 'string') output.push(record.command)
    for (const [key, entry] of Object.entries(record)) {
      if (key !== 'command') commands(entry, output)
    }
  }
  return output
}

const exactHookCommand = (
  command: string,
  provider: HookProvider,
  event: string,
): boolean => {
  const normalized = command.trim().replaceAll(/\s+/g, ' ')
  const providerToken = `--provider ${provider}`
  const eventToken = `hook ${event.replaceAll(/([A-Z])/g, '-$1').toLowerCase().replace(/^-/, '')}`
  return normalized.includes(eventToken)
    && normalized.includes(providerToken)
    && (normalized.startsWith('orchestra ')
      || normalized.includes(' orchestra-board@'))
}

const hookCheck = (
  options: ProviderIntegrationInspectionOptions,
): ToolIntegrationCheck => {
  const settings = options.settingsPath
    ?? hookSettingsPath(options.scope, options.provider, options.roots)
  const document = readJson(settings)
  if (!document) {
    return {
      id: `${options.provider}-${options.scope}-hooks`,
      name: `${options.provider} ${options.scope} hooks`,
      kind: 'native',
      provider_id: options.provider,
      status: 'unsupported',
      source: options.scope === 'project' ? 'project' : 'user',
      detail: `hook configuration is missing or invalid (${pathFingerprint(settings)})`,
      capabilities: ['hooks'],
    }
  }
  const hooks = document.hooks
  const hookRecord = hooks && typeof hooks === 'object' && !Array.isArray(hooks)
    ? hooks as Record<string, unknown>
    : {}
  const missing = REQUIRED_HOOK_EVENTS[options.provider].filter((event) =>
    !commands(hookRecord[event]).some((command) =>
      exactHookCommand(command, options.provider, event)))
  return {
    id: `${options.provider}-${options.scope}-hooks`,
    name: `${options.provider} ${options.scope} hooks`,
    kind: 'native',
    provider_id: options.provider,
    status: missing.length === 0 ? 'validated' : 'unsupported',
    source: options.scope === 'project' ? 'project' : 'user',
    detail: missing.length === 0
      ? `all declared hook events are installed (${pathFingerprint(settings)})`
      : `missing declared hook events: ${missing.join(', ')} (${pathFingerprint(settings)})`,
    capabilities: ['hooks'],
  }
}

const pluginCheck = (
  options: ProviderIntegrationInspectionOptions,
): ToolIntegrationCheck => {
  const root = options.pluginRoot ?? process.cwd()
  const directory = options.provider === 'claude' ? '.claude-plugin' : '.codex-plugin'
  const manifestPath = path.join(root, directory, 'plugin.json')
  const document = readJson(manifestPath)
  const name = document?.name
  const version = document?.version
  const codexHooks = options.provider === 'codex' ? document?.hooks : undefined
  const valid = name === 'orchestra'
    && typeof version === 'string'
    && /^\d+\.\d+\.\d+$/.test(version)
    && (options.provider === 'claude'
      || codexHooks === './hooks/codex-hooks.json')
    && existsSync(manifestPath)
  return {
    id: `${options.provider}-plugin`,
    name: `${options.provider} Orchestra plugin`,
    kind: 'plugin',
    provider_id: options.provider,
    status: valid ? 'validated' : 'unsupported',
    version: typeof version === 'string' ? version : null,
    source: 'bundled',
    detail: valid
      ? `plugin manifest matches the declared provider contract (${pathFingerprint(manifestPath)})`
      : `plugin manifest is missing or incompatible (${pathFingerprint(manifestPath)})`,
    capabilities: ['hooks'],
  }
}

/** Read-only doctor extension for actual hook and plugin state; it never executes hooks. */
export function inspectProviderToolIntegrations(
  options: ProviderIntegrationInspectionOptions,
): ToolIntegrationCheck[] {
  return [hookCheck(options), pluginCheck(options)]
}

export function inspectDeclaredProviderToolIntegrations(
  options: Omit<ProviderIntegrationInspectionOptions, 'provider'>,
): ToolIntegrationCheck[] {
  return (['claude', 'codex'] as const).flatMap((provider) =>
    inspectProviderToolIntegrations({ ...options, provider }))
}
