import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  installHooks,
  type HookScope,
} from './install.js'
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

const providerManifest = (providerId: FirstRunProviderId) => {
  const manifest = FIRST_RELEASE_PROVIDER_MANIFESTS_V1.find(
    (candidate) => candidate.provider_id === providerId,
  )
  if (!manifest) throw new Error(`provider manifest is missing: ${providerId}`)
  return manifest
}

export const buildFirstRunPlan = (
  answers: FirstRunAnswers,
  deps: FirstRunPlanDeps = {},
): FirstRunPlan => {
  const mode = answers.execution_mode ?? 'native_subscription'
  const hooks = answers.hook_scope ?? 'off'
  const telemetry = answers.telemetry ?? 'off'
  const manifest = providerManifest(answers.provider_id)
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
    && (hookCapability === 'unsupported'
      || (answers.provider_id !== 'claude' && answers.provider_id !== 'codex'))) {
    blockers.push({
      code: 'hooks_not_supported',
      detail: `${manifest.display_name} does not support managed Orchestra hooks in this mode.`,
    })
  }

  const defaults: FirstRunPlan['defaults'] = {
    bind_host: '127.0.0.1',
    remote_access: 'off',
    terminal_remote_write: 'off',
    telemetry,
    usage_priced_api_fallback: 'off',
    destructive_cleanup: 'manual_only',
    workspace_mode: 'isolated_worktree',
  }

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
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('first-run configuration must be an object')
  }
  const config = value as Partial<FirstRunConfigV1>
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
  if (typeof config.configured_at !== 'string'
    || !Number.isFinite(Date.parse(config.configured_at))) {
    throw new Error('first-run configured_at must be an ISO timestamp')
  }
  return config as FirstRunConfigV1
}

export const firstRunConfigPath = (
  env: NodeJS.ProcessEnv = process.env,
): string => path.join(
  env.ORCHESTRA_HOME?.trim() || path.join(os.homedir(), '.orchestra'),
  'onboarding.json',
)

export const writeFirstRunConfig = (
  file: string,
  config: FirstRunConfigV1,
): void => {
  assertFirstRunConfigCompatible(config)
  const directory = path.dirname(file)
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.tmp`)
  const serialized = `${JSON.stringify(config, null, 2)}\n`
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  fs.writeFileSync(temporary, serialized, { mode: 0o600, flag: 'wx' })
  fs.renameSync(temporary, file)
  fs.chmodSync(file, 0o600)
  if (fs.readFileSync(file, 'utf8') !== serialized) {
    throw new Error(`first-run configuration changed while writing ${file}`)
  }
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
  if (plan.blockers.some((blocker) =>
    blocker.code === 'project_not_absolute'
    || blocker.code === 'project_not_found'
    || blocker.code === 'hooks_not_supported'
    || blocker.code === 'provider_api_consent_required')) {
    throw new Error('first-run plan has configuration blockers')
  }
  if (plan.hooks.scope !== 'off') {
    ;(deps.installProviderHooks ?? installHooks)(plan.hooks.scope, {
      provider: plan.provider.id === 'claude' || plan.provider.id === 'codex'
        ? plan.provider.id
        : (() => { throw new Error('provider hooks are unavailable') })(),
      roots: { cwd: plan.project_root },
    })
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
  writeFirstRunConfig(deps.configPath ?? firstRunConfigPath(), config)
  return config
}
