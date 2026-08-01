import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  accessSync,
  constants,
  realpathSync,
  statSync,
} from 'node:fs'
import {
  delimiter,
  isAbsolute,
  join,
} from 'node:path'
import { redactSensitiveText } from '../../agent-os/structured-redaction.js'
import {
  PROVIDER_CAPABILITY_IDS,
  defineProviderExecutableDiscoveryV1,
  defineProviderManifestV1,
  selectProviderExecutionV1,
} from '../../provider-contract.js'
import type {
  ProviderCapabilityId,
  ProviderExecutableDiscoveryV1,
  ProviderExecutionScope,
  ProviderExecutionSelectionRequestV1,
  ProviderExecutionSelectionV1,
  ProviderLaunchBlockerCode,
  ProviderManifestV1,
  ProviderReadinessV1,
} from '../../provider-contract.js'
import { fingerprintExecutableFileV1 } from './executable-fingerprint.js'

const VERSION_PATTERN = /\bv?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/g
const VERSION_OUTPUT_LIMIT = 512

export type TerminalProviderDiscoveryDependenciesV1 = {
  resolveExecutable?(
    command: string,
    environment: NodeJS.ProcessEnv,
  ): string | null
  readExecutable?(resolvedPath: string): Uint8Array
  fingerprintExecutable?(resolvedPath: string): string
  readVersion?(
    resolvedPath: string,
    environment: NodeJS.ProcessEnv,
  ): string | null
}

export type TerminalProviderDiscoveryOptionsV1 =
  TerminalProviderDiscoveryDependenciesV1 & {
    manifest: ProviderManifestV1
    command?: string
    environment?: NodeJS.ProcessEnv
    platform?: string
  }

export type TerminalProviderCandidateCapabilityEvidenceV1 = {
  capability: ProviderCapabilityId
  state: 'supported' | 'unsupported' | 'policy_blocked' | 'unknown'
  reason_code: string | null
}

export type TerminalProviderCandidateEvidenceV1 = {
  contract_version: 1
  provider_id: string
  adapter_id: string
  release_state: ProviderManifestV1['release_state']
  execution_scope: ProviderExecutionScope
  selection: ProviderExecutionSelectionV1
  mode_support: {
    state: 'supported' | 'unsupported' | 'policy_blocked' | 'unknown'
    reason_code: string | null
  }
  executable: ProviderExecutableDiscoveryV1
  auth_status: ProviderReadinessV1['auth_status']
  automation_policy: ProviderReadinessV1['automation_policy']
  overage_status: ProviderReadinessV1['overage_status']
  overage_consent: ProviderReadinessV1['overage_consent']
  metering_status: ProviderReadinessV1['metering_status']
  cost_cap_status: ProviderReadinessV1['cost_cap_status']
  capabilities: readonly TerminalProviderCandidateCapabilityEvidenceV1[]
  blockers: readonly ProviderLaunchBlockerCode[]
  launch_ready: boolean
}

export type DefineTerminalProviderCandidateEvidenceOptionsV1 = {
  manifest: ProviderManifestV1
  discovery: ProviderExecutableDiscoveryV1
  execution_scope: ProviderExecutionScope
  selection_request?: ProviderExecutionSelectionRequestV1
  required_capabilities?: readonly ProviderCapabilityId[]
}

const sha256 = (value: string | Uint8Array): string =>
  `sha256:${createHash('sha256').update(value).digest('hex')}`

const executableCandidates = (
  command: string,
  environment: NodeJS.ProcessEnv,
): readonly string[] => {
  if (isAbsolute(command) || command.includes('/') || command.includes('\\')) {
    return [command]
  }
  const extensions = process.platform === 'win32'
    ? (environment.PATHEXT ?? '.EXE;.CMD;.BAT;.COM')
        .split(';')
        .filter(Boolean)
    : ['']
  return (environment.PATH ?? '')
    .split(delimiter)
    .filter(Boolean)
    .flatMap((directory) => extensions.map((extension) =>
      join(directory, `${command}${extension}`)))
}

const resolveExecutable = (
  command: string,
  environment: NodeJS.ProcessEnv,
): string | null => {
  for (const candidate of executableCandidates(command, environment)) {
    try {
      accessSync(candidate, constants.X_OK)
      const resolvedPath = realpathSync(candidate)
      if (!statSync(resolvedPath).isFile()) continue
      return resolvedPath
    } catch {
      // Continue through the explicit PATH candidates.
    }
  }
  return null
}

const minimalVersionEnvironment = (
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv => {
  const output: NodeJS.ProcessEnv = {}
  for (const name of [
    'PATH',
    'PATHEXT',
    'SystemRoot',
    'SYSTEMROOT',
    'WINDIR',
    'LANG',
    'LC_ALL',
  ]) {
    const value = environment[name]
    if (typeof value === 'string') output[name] = value
  }
  return output
}

const readVersion = (
  resolvedPath: string,
  environment: NodeJS.ProcessEnv,
): string | null => {
  try {
    const output = execFileSync(resolvedPath, ['--version'], {
      encoding: 'utf8',
      env: minimalVersionEnvironment(environment),
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3_000,
      windowsHide: true,
      maxBuffer: VERSION_OUTPUT_LIMIT,
    }).trim()
    return output || null
  } catch {
    return null
  }
}

const exactVersion = (value: string | null): string | null => {
  if (value === null || value.length > VERSION_OUTPUT_LIMIT) return null
  const matches = new Set<string>()
  for (const match of value.matchAll(VERSION_PATTERN)) {
    const version = match[1]
    if (version) matches.add(version)
  }
  return matches.size === 1 ? [...matches][0] ?? null : null
}

const safeResolvedPath = (value: string): string | null => {
  const redacted = redactSensitiveText(value)
  return redacted.changed || redacted.value !== value ? null : value
}

const discoveryFallbackFingerprint = (
  manifest: ProviderManifestV1,
  source: ProviderExecutableDiscoveryV1['source'],
  status: ProviderExecutableDiscoveryV1['status'],
  version: string | null,
  platform: string,
  resolvedPath: string | null,
): string => sha256([
  'terminal-provider-executable-v1',
  manifest.provider_id,
  manifest.adapter_id,
  source,
  status,
  version ?? 'unknown',
  platform,
  resolvedPath ?? 'redacted-or-missing',
].join('\u0000'))

export function discoverTerminalProviderExecutableV1(
  options: TerminalProviderDiscoveryOptionsV1,
): Readonly<ProviderExecutableDiscoveryV1> {
  const manifest = defineProviderManifestV1(options.manifest)
  const environment = options.environment ?? process.env
  const requestedCommand = options.command?.trim()
    || manifest.executable.command
  const source: ProviderExecutableDiscoveryV1['source'] =
    requestedCommand === manifest.executable.command
      ? 'path'
      : 'environment_override'
  const platform = options.platform ?? `${process.platform}-${process.arch}`
  const executableResolver = options.resolveExecutable ?? resolveExecutable
  const executableFingerprinter = options.fingerprintExecutable
    ?? (options.readExecutable
      ? (resolvedPath: string) => sha256(options.readExecutable!(resolvedPath))
      : fingerprintExecutableFileV1)
  const versionReader = options.readVersion ?? readVersion

  let resolutionFailed = false
  let candidatePath: string | null = null
  try {
    candidatePath = executableResolver(
      requestedCommand,
      minimalVersionEnvironment(environment),
    )
  } catch {
    resolutionFailed = true
  }

  let resolvedPath: string | null = null
  if (candidatePath !== null) {
    try {
      const canonicalPath = realpathSync(candidatePath)
      accessSync(canonicalPath, constants.X_OK)
      if (!statSync(canonicalPath).isFile()) throw new Error('not a file')
      resolvedPath = canonicalPath
    } catch {
      resolutionFailed = true
    }
  }

  const safePath = resolvedPath === null ? null : safeResolvedPath(resolvedPath)
  let rawVersion: string | null = null
  if (resolvedPath !== null) {
    try {
      rawVersion = versionReader(
        resolvedPath,
        minimalVersionEnvironment(environment),
      )
    } catch {
      rawVersion = null
    }
  }
  const version = exactVersion(rawVersion)
  let status: ProviderExecutableDiscoveryV1['status'] = resolvedPath === null
    ? resolutionFailed
      ? 'unknown'
      : 'missing'
    : 'unknown'
  let executableFingerprint = discoveryFallbackFingerprint(
    manifest,
    source,
    status,
    version,
    platform,
    safePath,
  )

  let executableReadable = false
  if (resolvedPath !== null) {
    try {
      executableFingerprint = executableFingerprinter(resolvedPath)
      executableReadable = true
    } catch {
      executableReadable = false
    }
  }

  if (resolvedPath !== null) {
    const overrideApproved = source === 'path'
      || manifest.executable.command_override_env !== undefined
    if (safePath === null || !executableReadable || !overrideApproved) {
      status = 'untrusted'
    } else if (version === null) {
      status = 'unknown'
    } else if (!manifest.executable.validated_versions.includes(version)
      || !manifest.executable.supported_platforms.includes(platform)) {
      status = 'incompatible'
    } else {
      status = 'validated'
    }
  }

  if (!executableReadable) {
    executableFingerprint = discoveryFallbackFingerprint(
      manifest,
      source,
      status,
      version,
      platform,
      safePath,
    )
  }

  return defineProviderExecutableDiscoveryV1({
    contract_version: 1,
    provider_id: manifest.provider_id,
    adapter_id: manifest.adapter_id,
    status,
    source,
    version,
    platform,
    resolved_path: safePath,
    executable_fingerprint: executableFingerprint,
  })
}

const executableBlocker = (
  status: ProviderExecutableDiscoveryV1['status'],
): ProviderLaunchBlockerCode | null => status === 'missing'
  ? 'missing_executable'
  : status === 'incompatible'
    ? 'incompatible_version'
    : status === 'untrusted'
      ? 'untrusted_executable'
      : status === 'unknown'
        ? 'executable_unknown'
        : null

const authenticationBlocker = (
  status: ProviderReadinessV1['auth_status'],
): ProviderLaunchBlockerCode | null => status === 'unknown'
  ? 'authentication_unknown'
  : status === 'credential_conflict'
    ? 'credential_conflict'
    : status === 'ready'
      ? null
      : 'authentication_required'

export function defineTerminalProviderCandidateEvidenceV1(
  options: DefineTerminalProviderCandidateEvidenceOptionsV1,
): Readonly<TerminalProviderCandidateEvidenceV1> {
  if (!['interactive', 'managed_foreground', 'managed_background']
    .includes(options.execution_scope)) {
    throw new Error('terminal provider candidate execution scope is invalid')
  }
  if (options.required_capabilities !== undefined
    && (!Array.isArray(options.required_capabilities)
      || options.required_capabilities.some((capability) =>
        !(PROVIDER_CAPABILITY_IDS as readonly string[]).includes(capability)))) {
    throw new Error('terminal provider candidate capability is invalid')
  }
  const manifest = defineProviderManifestV1(options.manifest)
  const discovery = defineProviderExecutableDiscoveryV1(options.discovery)
  if (discovery.provider_id !== manifest.provider_id
    || discovery.adapter_id !== manifest.adapter_id) {
    throw new Error('terminal provider candidate discovery does not match manifest')
  }
  if (discovery.status === 'validated') {
    const sourceMatches = manifest.executable.source === 'sdk_bundled'
      ? discovery.source === 'sdk_bundled'
      : discovery.source === 'path'
        || (discovery.source === 'environment_override'
          && manifest.executable.command_override_env !== undefined)
    if (!sourceMatches
      || discovery.version === null
      || !manifest.executable.validated_versions.includes(discovery.version)
      || discovery.platform === null
      || !manifest.executable.supported_platforms.includes(discovery.platform)) {
      throw new Error('terminal provider candidate discovery is inconsistent')
    }
  }
  const selection = selectProviderExecutionV1(
    manifest,
    options.selection_request,
  )
  const mode = manifest.modes.find((candidate) =>
    candidate.id === selection.mode_id)
  if (!mode) throw new Error('terminal provider candidate mode is unavailable')
  const automationPolicy = mode.automation_policy
  const overageStatus: ProviderReadinessV1['overage_status'] =
    mode.overage.behavior === 'none' ? 'not_applicable' : 'unknown'
  const overageConsent: ProviderReadinessV1['overage_consent'] =
    mode.overage.behavior === 'none' ? 'not_required' : 'missing'
  const meteringUnknown = selection.billing_mode === 'usage_priced_api'
    || mode.overage.behavior !== 'none'
  const meteringStatus: ProviderReadinessV1['metering_status'] =
    meteringUnknown ? 'unknown' : 'not_required'
  const costCapStatus: ProviderReadinessV1['cost_cap_status'] =
    meteringUnknown ? 'unknown' : 'not_required'

  const blockers = new Set<ProviderLaunchBlockerCode>()
  if (manifest.release_state === 'unsupported') {
    blockers.add('unsupported_provider')
  }
  if (manifest.environment.audit_state !== 'complete') {
    blockers.add('environment_audit_incomplete')
  }
  if (mode.support.state === 'policy_blocked') {
    blockers.add('provider_policy_blocked')
  } else if (mode.support.state !== 'supported') {
    blockers.add('unsupported_mode')
  }
  if (automationPolicy === 'blocked'
    || automationPolicy === 'unknown') {
    blockers.add('provider_policy_blocked')
  } else if (automationPolicy === 'interactive_only'
    && options.execution_scope !== 'interactive') {
    blockers.add('interactive_only')
  }

  const discoveryBlocker = executableBlocker(discovery.status)
  if (discoveryBlocker) blockers.add(discoveryBlocker)
  const authBlocker = authenticationBlocker('unknown')
  if (authBlocker) blockers.add(authBlocker)

  if (overageStatus === 'unknown') blockers.add('overage_unknown')
  const meteringRequired = selection.billing_mode === 'usage_priced_api'
  if (meteringRequired) {
    blockers.add('durable_cost_authority_unavailable')
    blockers.add('metering_unavailable')
    blockers.add('cost_cap_unenforced')
  } else if (meteringUnknown) {
    blockers.add('metering_unavailable')
    blockers.add('cost_cap_unenforced')
  }

  const requiredCapabilities = new Set<ProviderCapabilityId>(
    options.required_capabilities ?? [],
  )
  if (options.execution_scope !== 'interactive') {
    requiredCapabilities.add('structured_events')
  }
  if ([...requiredCapabilities].some((capability) =>
    mode.capabilities[capability].state !== 'supported')) {
    blockers.add('capability_unsupported')
  }

  const capabilities = Object.freeze(PROVIDER_CAPABILITY_IDS.map((capability) => {
    const support = mode.capabilities[capability]
    return Object.freeze({
      capability,
      state: support.state,
      reason_code: support.state === 'supported' ? null : support.reason_code,
    })
  }))
  const sortedBlockers = Object.freeze([...blockers].sort())
  return Object.freeze({
    contract_version: 1 as const,
    provider_id: manifest.provider_id,
    adapter_id: manifest.adapter_id,
    release_state: manifest.release_state,
    execution_scope: options.execution_scope,
    selection,
    mode_support: Object.freeze({
      state: mode.support.state,
      reason_code: mode.support.state === 'supported'
        ? null
        : mode.support.reason_code,
    }),
    executable: discovery,
    auth_status: 'unknown',
    automation_policy: automationPolicy,
    overage_status: overageStatus,
    overage_consent: overageConsent,
    metering_status: meteringStatus,
    cost_cap_status: costCapStatus,
    capabilities,
    blockers: sortedBlockers,
    launch_ready: sortedBlockers.length === 0,
  })
}
