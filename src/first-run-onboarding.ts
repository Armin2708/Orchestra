import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import {
  installHooks,
  runHookInstallTransaction,
  type HookScope,
  type HookProvider,
} from './install.js'
import {
  DECLARED_PROVIDER_COMPATIBILITY_CONTRACT_V1,
} from './declared-provider-compatibility.js'
import { FIRST_RELEASE_PROVIDER_MANIFESTS_V1 } from './provider-manifests.js'

export const FIRST_RUN_CONFIG_SCHEMA_VERSION = 1 as const
export const FIRST_RUN_PROVIDER_IDS = ['claude', 'codex', 'qwen', 'kimi'] as const

export type FirstRunProviderId = typeof FIRST_RUN_PROVIDER_IDS[number]
export type FirstRunExecutionMode = 'native_subscription' | 'provider_api'
export type FirstRunHookChoice = 'off' | HookScope
export type FirstRunTelemetryChoice = 'off' | 'redacted'

export type FirstRunAnswers = {
  project_root: string
  provider_id: FirstRunProviderId
  execution_mode?: FirstRunExecutionMode
  hook_scope?: FirstRunHookChoice
  telemetry?: FirstRunTelemetryChoice
  acknowledge_usage_priced_api?: boolean
}

export type FirstRunBlocker = {
  code:
    | 'project_not_absolute'
    | 'project_not_found'
    | 'provider_not_release_supported'
    | 'provider_acceptance_not_ready'
    | 'provider_mode_not_supported'
    | 'provider_api_not_implemented'
    | 'provider_api_consent_required'
    | 'hooks_not_supported'
  detail: string
}

export type FirstRunPlan = {
  schema_version: typeof FIRST_RUN_CONFIG_SCHEMA_VERSION
  project_root: string
  provider: {
    id: FirstRunProviderId
    display_name: string
    release_state: 'validated' | 'candidate' | 'unsupported'
    mode: FirstRunExecutionMode
    runtime_mode: 'native_cli' | 'provider_api'
    billing_mode: 'personal_subscription' | 'usage_priced_api'
    support_state: 'supported' | 'unknown' | 'unsupported' | 'policy_blocked'
    support_reason: string | null
    declared_acceptance: {
      real_matrix_state: 'missing' | 'passed'
      support_claim: 'blocked' | 'ready'
      blocker_codes: readonly string[]
    }
  }
  hooks: {
    scope: FirstRunHookChoice
    capability_state: 'supported' | 'unknown' | 'unsupported' | 'policy_blocked'
  }
  defaults: {
    bind_host: '127.0.0.1'
    remote_access: 'off'
    terminal_remote_write: 'off'
    telemetry: FirstRunTelemetryChoice
    usage_priced_api_fallback: 'off'
    destructive_cleanup: 'manual_only'
    workspace_mode: 'isolated_worktree'
  }
  advanced_controls: readonly {
    id: string
    state: 'available' | 'unavailable' | 'manual'
    detail: string
  }[]
  blockers: FirstRunBlocker[]
  ready_for_managed_launch: boolean
}

export type FirstRunConfigV1 = {
  schema_version: typeof FIRST_RUN_CONFIG_SCHEMA_VERSION
  project_root: string
  provider_id: FirstRunProviderId
  execution_mode: FirstRunExecutionMode
  hook_scope: FirstRunHookChoice
  telemetry: FirstRunTelemetryChoice
  safe_defaults: FirstRunPlan['defaults']
  configured_at: string
}

export type FirstRunPlanDeps = {
  directoryExists?: (directory: string) => boolean
}

const CONFIG_KEYS = [
  'schema_version',
  'project_root',
  'provider_id',
  'execution_mode',
  'hook_scope',
  'telemetry',
  'safe_defaults',
  'configured_at',
] as const

const SAFE_DEFAULT_KEYS = [
  'bind_host',
  'remote_access',
  'terminal_remote_write',
  'telemetry',
  'usage_priced_api_fallback',
  'destructive_cleanup',
  'workspace_mode',
] as const

const SENSITIVE_FIELD = /(?:^|[_-])(?:api[_-]?key|authorization|bearer|credential|password|private[_-]?key|secret|token)(?:$|[_-])/i

const plainRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype)

const exactKeys = (
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void => {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} has unknown or missing fields`)
  }
}

const rejectSensitiveFields = (value: unknown, location = 'configuration'): void => {
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectSensitiveFields(item, `${location}[${index}]`))
    return
  }
  if (!plainRecord(value)) return
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_FIELD.test(key)) {
      throw new Error(`${location}.${key} is a forbidden sensitive field`)
    }
    rejectSensitiveFields(child, `${location}.${key}`)
  }
}

const safeDefaults = (
  telemetry: FirstRunTelemetryChoice,
): FirstRunPlan['defaults'] => ({
  bind_host: '127.0.0.1',
  remote_access: 'off',
  terminal_remote_write: 'off',
  telemetry,
  usage_priced_api_fallback: 'off',
  destructive_cleanup: 'manual_only',
  workspace_mode: 'isolated_worktree',
})

const providerManifest = (providerId: FirstRunProviderId) => {
  const manifest = FIRST_RELEASE_PROVIDER_MANIFESTS_V1.find(
    (candidate) => candidate.provider_id === providerId,
  )
  if (!manifest) throw new Error(`provider manifest is missing: ${providerId}`)
  return manifest
}

const providerDeclaration = (providerId: FirstRunProviderId) => {
  const declaration = DECLARED_PROVIDER_COMPATIBILITY_CONTRACT_V1.providers.find(
    (candidate) => candidate.provider_id === providerId,
  )
  if (!declaration) throw new Error(`provider declaration is missing: ${providerId}`)
  return declaration
}

export const buildFirstRunPlan = (
  answers: FirstRunAnswers,
  deps: FirstRunPlanDeps = {},
): FirstRunPlan => {
  const mode = answers.execution_mode ?? 'native_subscription'
  const hooks = answers.hook_scope ?? 'off'
  const telemetry = answers.telemetry ?? 'off'
  const manifest = providerManifest(answers.provider_id)
  const declaration = providerDeclaration(answers.provider_id)
  const manifestModeId = mode === 'native_subscription'
    ? 'native_subscription'
    : 'native_api_key'
  const selectedMode = manifest.modes.find((candidate) => candidate.id === manifestModeId)
  if (!selectedMode) throw new Error(`provider mode is missing: ${manifestModeId}`)
  const blockers: FirstRunBlocker[] = []
  const directoryExists = deps.directoryExists
    ?? ((directory: string) => {
      try { return fs.statSync(directory).isDirectory() } catch { return false }
    })

  if (!path.isAbsolute(answers.project_root)) {
    blockers.push({
      code: 'project_not_absolute',
      detail: 'Project selection must resolve to an absolute directory.',
    })
  } else if (!directoryExists(answers.project_root)) {
    blockers.push({
      code: 'project_not_found',
      detail: 'The selected project directory does not exist.',
    })
  }

  if (manifest.release_state !== 'validated') {
    blockers.push({
      code: 'provider_not_release_supported',
      detail: `${manifest.display_name} is ${manifest.release_state}; exact release acceptance evidence is still required.`,
    })
  }
  if (declaration.acceptance.real_matrix_state !== 'passed'
    || declaration.acceptance.support_claim !== 'ready'
    || declaration.acceptance.blocker_codes.length !== 0) {
    blockers.push({
      code: 'provider_acceptance_not_ready',
      detail: `${manifest.display_name} remains blocked by declared_provider_matrix: ${
        declaration.acceptance.blocker_codes.join(', ') || 'retained acceptance is unavailable'
      }.`,
    })
  }
  if (selectedMode.support.state !== 'supported') {
    blockers.push({
      code: 'provider_mode_not_supported',
      detail: `${manifest.display_name} ${mode} is ${selectedMode.support.state}: ${selectedMode.support.reason_code}.`,
    })
  }
  if (mode === 'provider_api') {
    if (!answers.acknowledge_usage_priced_api) {
      blockers.push({
        code: 'provider_api_consent_required',
        detail: 'Usage-priced provider API mode requires explicit billing consent.',
      })
    }
    if (selectedMode.runtime_mode !== 'provider_api') {
      blockers.push({
        code: 'provider_api_not_implemented',
        detail: 'The current provider contract has no direct provider-API runtime; this selection is recorded but cannot launch.',
      })
    }
  }

  const hookCapability = selectedMode.capabilities.hooks.state
  if (hooks !== 'off'
    && (hookCapability !== 'supported'
      || (answers.provider_id !== 'claude' && answers.provider_id !== 'codex'))) {
    blockers.push({
      code: 'hooks_not_supported',
      detail: `${manifest.display_name} does not support managed Orchestra hooks in this mode.`,
    })
  }

  const defaults = safeDefaults(telemetry)

  return {
    schema_version: FIRST_RUN_CONFIG_SCHEMA_VERSION,
    project_root: answers.project_root,
    provider: {
      id: answers.provider_id,
      display_name: manifest.display_name,
      release_state: manifest.release_state,
      mode,
      runtime_mode: selectedMode.runtime_mode,
      billing_mode: selectedMode.billing_mode,
      support_state: selectedMode.support.state,
      support_reason: 'reason_code' in selectedMode.support
        ? selectedMode.support.reason_code
        : null,
      declared_acceptance: {
        real_matrix_state: declaration.acceptance.real_matrix_state,
        support_claim: declaration.acceptance.support_claim,
        blocker_codes: declaration.acceptance.blocker_codes,
      },
    },
    hooks: { scope: hooks, capability_state: hookCapability },
    defaults,
    advanced_controls: [
      {
        id: 'provider_api',
        state: 'unavailable',
        detail: 'Requires Lane B direct provider-API runtime integration and explicit usage-priced billing consent.',
      },
      {
        id: 'remote_access',
        state: 'unavailable',
        detail: 'Requires Lane C DeviceSession pairing, scopes, expiry, revocation, and step-up controls.',
      },
      {
        id: 'external_telemetry',
        state: 'available',
        detail: 'Off by default; opt-in events use the strict redacted envelope only.',
      },
      {
        id: 'backup_restore',
        state: 'manual',
        detail: 'Quiesce hooks and the daemon, then use the documented offline-consistent procedure.',
      },
    ],
    blockers,
    ready_for_managed_launch: blockers.length === 0,
  }
}

export const assertFirstRunConfigCompatible = (
  value: unknown,
): FirstRunConfigV1 => {
  if (!plainRecord(value)) {
    throw new Error('first-run configuration must be an object')
  }
  rejectSensitiveFields(value)
  exactKeys(value, CONFIG_KEYS, 'first-run configuration')
  const config = value as unknown as FirstRunConfigV1
  if (config.schema_version !== FIRST_RUN_CONFIG_SCHEMA_VERSION) {
    throw new Error(`unsupported first-run configuration schema: ${String(config.schema_version)}`)
  }
  if (typeof config.project_root !== 'string' || !path.isAbsolute(config.project_root)) {
    throw new Error('first-run project_root must be absolute')
  }
  if (!FIRST_RUN_PROVIDER_IDS.includes(config.provider_id as FirstRunProviderId)) {
    throw new Error('first-run provider_id is unsupported')
  }
  if (!['native_subscription', 'provider_api'].includes(String(config.execution_mode))) {
    throw new Error('first-run execution_mode is unsupported')
  }
  if (!['off', 'project', 'global'].includes(String(config.hook_scope))) {
    throw new Error('first-run hook_scope is unsupported')
  }
  if (!['off', 'redacted'].includes(String(config.telemetry))) {
    throw new Error('first-run telemetry choice is unsupported')
  }
  if (!plainRecord(config.safe_defaults)) {
    throw new Error('first-run safe_defaults must be an object')
  }
  exactKeys(
    config.safe_defaults as unknown as Record<string, unknown>,
    SAFE_DEFAULT_KEYS,
    'first-run safe_defaults',
  )
  const expectedDefaults = safeDefaults(config.telemetry)
  for (const key of SAFE_DEFAULT_KEYS) {
    if (config.safe_defaults[key] !== expectedDefaults[key]) {
      throw new Error(`first-run safe default drift: ${key}`)
    }
  }
  if (typeof config.configured_at !== 'string'
    || !Number.isFinite(Date.parse(config.configured_at))
    || new Date(Date.parse(config.configured_at)).toISOString() !== config.configured_at) {
    throw new Error('first-run configured_at must be an ISO timestamp')
  }
  return config
}

export const firstRunConfigPath = (
  env: NodeJS.ProcessEnv = process.env,
): string => {
  const hasConfiguredHome = Object.prototype.hasOwnProperty.call(env, 'ORCHESTRA_HOME')
  const configuredHome = hasConfiguredHome ? env.ORCHESTRA_HOME?.trim() : undefined
  if (hasConfiguredHome && (!configuredHome || !path.isAbsolute(configuredHome))) {
    throw new Error('ORCHESTRA_HOME must be a non-empty absolute path')
  }
  const defaultHome = os.homedir()
  if (!configuredHome && (!defaultHome || !path.isAbsolute(defaultHome))) {
    throw new Error('HOME must resolve to an absolute path for default ORCHESTRA_HOME')
  }
  const stateRoot = configuredHome ?? path.join(defaultHome, '.orchestra')
  return path.join(stateRoot, 'onboarding.json')
}

const writeVerifiedText = (
  file: string,
  serialized: string,
  mode: number,
): void => {
  const directory = path.dirname(file)
  const temporary = path.join(
    directory,
    `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`,
  )
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  let descriptor: number | null = null
  try {
    descriptor = fs.openSync(
      temporary,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
        | (fs.constants.O_NOFOLLOW ?? 0),
      mode,
    )
    fs.writeFileSync(descriptor, serialized)
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = null
    fs.renameSync(temporary, file)
    fs.chmodSync(file, mode)
    if (process.platform !== 'win32') {
      const directoryDescriptor = fs.openSync(directory, fs.constants.O_RDONLY)
      try { fs.fsyncSync(directoryDescriptor) } finally { fs.closeSync(directoryDescriptor) }
    }
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor)
    if (fs.existsSync(temporary)) {
      fs.unlinkSync(temporary)
      if (process.platform !== 'win32') {
        const directoryDescriptor = fs.openSync(directory, fs.constants.O_RDONLY)
        try { fs.fsyncSync(directoryDescriptor) } finally { fs.closeSync(directoryDescriptor) }
      }
    }
  }
  if (fs.readFileSync(file, 'utf8') !== serialized) {
    throw new Error(`configuration changed while writing ${file}`)
  }
}

export const writeFirstRunConfig = (
  file: string,
  config: FirstRunConfigV1,
): void => {
  assertFirstRunConfigCompatible(config)
  const serialized = `${JSON.stringify(config, null, 2)}\n`
  writeVerifiedText(file, serialized, 0o600)
}

export type ApplyFirstRunPlanDeps = {
  now?: () => string
  configPath?: string
  installProviderHooks?: typeof installHooks
}

export const applyFirstRunPlan = (
  plan: FirstRunPlan,
  deps: ApplyFirstRunPlanDeps = {},
): FirstRunConfigV1 => {
  if (!plainRecord(plan)
    || !plainRecord(plan.provider)
    || !plainRecord(plan.hooks)
    || !plainRecord(plan.defaults)
    || typeof plan.project_root !== 'string'
    || !FIRST_RUN_PROVIDER_IDS.includes(plan.provider.id as FirstRunProviderId)
    || !['native_subscription', 'provider_api'].includes(String(plan.provider.mode))
    || !['off', 'project', 'global'].includes(String(plan.hooks.scope))
    || !['off', 'redacted'].includes(String(plan.defaults.telemetry))) {
    throw new Error('first-run plan identifiers are invalid; no files were changed')
  }
  const canonicalPlan = buildFirstRunPlan({
    project_root: plan.project_root,
    provider_id: plan.provider.id as FirstRunProviderId,
    execution_mode: plan.provider.mode as FirstRunExecutionMode,
    hook_scope: plan.hooks.scope as FirstRunHookChoice,
    telemetry: plan.defaults.telemetry as FirstRunTelemetryChoice,
    // API consent is not a safe persisted identifier. API-mode plans therefore
    // remain blocked until an independently authenticated consent receipt exists.
    acknowledge_usage_priced_api: false,
  })
  if (!isDeepStrictEqual(plan, canonicalPlan)) {
    throw new Error('first-run plan is stale or forged relative to the current provider manifest')
  }
  plan = canonicalPlan
  if (plan.blockers.length > 0 || !plan.ready_for_managed_launch) {
    throw new Error('first-run plan is blocked; no configuration or hooks were changed')
  }
  if (plan.schema_version !== FIRST_RUN_CONFIG_SCHEMA_VERSION
    || !path.isAbsolute(plan.project_root)
    || (() => {
      try { return !fs.statSync(plan.project_root).isDirectory() } catch { return true }
    })()) {
    throw new Error('first-run project and schema must be valid before apply')
  }
  if (plan.provider.release_state !== 'validated'
    || plan.provider.support_state !== 'supported') {
    throw new Error('first-run provider is not release-validated and supported')
  }
  if (plan.hooks.scope !== 'off'
    && plan.hooks.capability_state !== 'supported') {
    throw new Error('first-run hook capability is not supported')
  }
  if (plan.provider.mode === 'native_subscription'
    && (plan.provider.runtime_mode !== 'native_cli'
      || plan.provider.billing_mode !== 'personal_subscription')) {
    throw new Error('first-run native subscription selection is inconsistent')
  }
  if (plan.provider.mode === 'provider_api'
    && (plan.provider.runtime_mode !== 'provider_api'
      || plan.provider.billing_mode !== 'usage_priced_api')) {
    throw new Error('first-run provider API selection is inconsistent')
  }
  const config: FirstRunConfigV1 = {
    schema_version: FIRST_RUN_CONFIG_SCHEMA_VERSION,
    project_root: plan.project_root,
    provider_id: plan.provider.id,
    execution_mode: plan.provider.mode,
    hook_scope: plan.hooks.scope,
    telemetry: plan.defaults.telemetry,
    safe_defaults: plan.defaults,
    configured_at: (deps.now ?? (() => new Date().toISOString()))(),
  }
  assertFirstRunConfigCompatible(config)
  const hookProvider: HookProvider | null = plan.hooks.scope === 'off'
    ? null
    : plan.provider.id === 'claude' || plan.provider.id === 'codex'
      ? plan.provider.id
      : (() => { throw new Error('provider hooks are unavailable') })()
  const configFile = deps.configPath ?? firstRunConfigPath()
  if (!path.isAbsolute(configFile)) {
    throw new Error('first-run configuration path must be absolute')
  }
  const previous = fs.existsSync(configFile)
    ? { content: fs.readFileSync(configFile, 'utf8'), mode: fs.statSync(configFile).mode & 0o777 }
    : null
  if (previous) {
    let parsed: unknown
    try { parsed = JSON.parse(previous.content) } catch {
      throw new Error('existing first-run configuration is invalid; refusing to overwrite it')
    }
    assertFirstRunConfigCompatible(parsed)
  }
  const serialized = `${JSON.stringify(config, null, 2)}\n`
  const currentConfig = (): string | null => {
    try { return fs.readFileSync(configFile, 'utf8') } catch { return null }
  }
  try {
    if (plan.hooks.scope !== 'off' && hookProvider) {
      const hookOptions = {
        provider: hookProvider,
        roots: { cwd: plan.project_root },
      } as const
      runHookInstallTransaction(plan.hooks.scope, hookOptions, (transaction) => {
        writeFirstRunConfig(configFile, config)
        ;(deps.installProviderHooks ?? installHooks)(
          plan.hooks.scope as HookScope,
          hookOptions,
          transaction,
        )
        if (currentConfig() !== serialized) {
          throw new Error(`first-run configuration changed during hook setup: ${configFile}`)
        }
      })
    } else {
      writeFirstRunConfig(configFile, config)
      if (currentConfig() !== serialized) {
        throw new Error(`first-run configuration changed during apply: ${configFile}`)
      }
    }
  } catch (error) {
    const rollbackErrors: unknown[] = []
    const current = currentConfig()
    const unchanged = previous ? current === previous.content : current === null
    if (current !== serialized && !unchanged) {
      rollbackErrors.push(new Error(
        `configuration changed concurrently; refusing rollback for ${configFile}`,
      ))
    } else if (current === serialized) {
      try {
        if (previous) {
          assertFirstRunConfigCompatible(JSON.parse(previous.content))
          writeVerifiedText(configFile, previous.content, previous.mode)
        } else {
          fs.unlinkSync(configFile)
          if (process.platform !== 'win32') {
            const directoryDescriptor = fs.openSync(path.dirname(configFile), fs.constants.O_RDONLY)
            try { fs.fsyncSync(directoryDescriptor) } finally { fs.closeSync(directoryDescriptor) }
          }
          if (fs.existsSync(configFile)) {
            throw new Error('new config rollback did not verify')
          }
        }
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError)
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        'hook setup failed and rollback was incomplete; concurrent files were not overwritten',
      )
    }
    throw error
  }
  return config
}
