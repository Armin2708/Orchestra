import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { release as osRelease } from 'node:os'
import { dirname, join } from 'node:path'
import compatibilityContract from '../environment-compatibility.json' with { type: 'json' }

export type CompatibilityStatus = 'validated' | 'experimental' | 'unsupported'
export type DoctorProvider = 'claude' | 'codex' | 'both'

type VersionRange = {
  min_inclusive: string
  max_exclusive: string
}

type VersionPolicy = {
  validated_versions: readonly string[]
  experimental_range?: VersionRange | null
}

type PlatformPolicy = {
  status: CompatibilityStatus
  scope: string
}

export type CompatibilityCheck = {
  id:
    | 'platform'
    | 'node'
    | 'npm'
    | 'toolchain'
    | 'codex_cli'
    | 'claude_sdk'
    | 'claude_native_package'
    | 'claude_bundled_cli'
    | 'claude_ambient_cli'
  label: string
  required: boolean
  status: CompatibilityStatus
  actual: string | null
  expected: string
  detail: string
}

export type EnvironmentProbe = {
  platform: NodeJS.Platform | string
  arch: string
  platformRelease: string
  platformVariant: string
  libc: string | null
  evidenceProfile: string | null
  nodeVersion: string | null
  npmVersion: string | null
  codexVersion: string | null
  claudeSdkVersion: string | null
  claudeNativePackageVersion: string | null
  claudeBundledCliVersion: string | null
  claudeAmbientCliVersion: string | null
}

export type EnvironmentProbeDeps = {
  probeVersion?: (command: string) => string | null
  readClaudeSdkDescriptor?: (
    platform: string,
    arch: string,
    libc: string | null,
    readVersion: (command: string) => string | null,
  ) => {
    version: string | null
    nativePackageVersion: string | null
    nativeCliVersion: string | null
  }
}

export type EnvironmentDoctorReport = {
  schema_version: 1
  contract_schema_version: number
  checked_at: string
  provider: DoctorProvider
  fail_closed: true
  ready: boolean
  status: CompatibilityStatus
  checks: CompatibilityCheck[]
}

export const ENVIRONMENT_COMPATIBILITY_CONTRACT = compatibilityContract

type Semver = readonly [major: number, minor: number, patch: number]

type ValidatedToolchain = {
  id: string
  platform: string
  arch: string
  platform_release: string | null
  platform_variant: string
  libc: string | null
  evidence_profile: string | null
  node: string
  npm: string
}

const parseSemver = (value: string | null | undefined): { value: string; tuple: Semver } | null => {
  const match = value?.match(/(?:^|[^0-9])v?(\d+)\.(\d+)\.(\d+)(?=$|\s|\))/)
  if (!match) return null
  const tuple = [Number(match[1]), Number(match[2]), Number(match[3])] as const
  if (tuple.some((part) => !Number.isSafeInteger(part))) return null
  return { value: tuple.join('.'), tuple }
}

const compareSemver = (left: Semver, right: Semver): number => {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index]
  }
  return 0
}

const insideRange = (version: Semver, range?: VersionRange | null): boolean => {
  if (!range) return false
  const min = parseSemver(range.min_inclusive)
  const max = parseSemver(range.max_exclusive)
  return Boolean(min && max
    && compareSemver(version, min.tuple) >= 0
    && compareSemver(version, max.tuple) < 0)
}

const expectedVersions = (policy: VersionPolicy): string => {
  const exact = policy.validated_versions.join(', ')
  if (!policy.experimental_range) return `exactly ${exact}`
  return `validated: ${exact}; experimental only: >=${policy.experimental_range.min_inclusive} <${policy.experimental_range.max_exclusive}`
}

export const classifyVersion = (
  raw: string | null | undefined,
  policy: VersionPolicy,
  label: string,
): Pick<CompatibilityCheck, 'status' | 'actual' | 'expected' | 'detail'> => {
  const parsed = parseSemver(raw)
  const expected = expectedVersions(policy)
  if (!parsed) {
    return {
      status: 'unsupported',
      actual: null,
      expected,
      detail: `${label} is missing or did not return a semantic version.`,
    }
  }
  if (policy.validated_versions.includes(parsed.value)) {
    return {
      status: 'validated',
      actual: parsed.value,
      expected,
      detail: `${label} ${parsed.value} matches observed release evidence.`,
    }
  }
  if (insideRange(parsed.tuple, policy.experimental_range)) {
    return {
      status: 'experimental',
      actual: parsed.value,
      expected,
      detail: `${label} ${parsed.value} is inside the evaluation range but has no observed release gate.`,
    }
  }
  return {
    status: 'unsupported',
    actual: parsed.value,
    expected,
    detail: `${label} ${parsed.value} is outside the validated compatibility contract.`,
  }
}

export const classifyCodexCliVersion = (
  raw: string | null | undefined,
): Pick<CompatibilityCheck, 'status' | 'actual' | 'expected' | 'detail'> =>
  classifyVersion(raw, ENVIRONMENT_COMPATIBILITY_CONTRACT.providers.codex.managed, 'Codex CLI')

const validatedToolchains = (): readonly ValidatedToolchain[] =>
  ENVIRONMENT_COMPATIBILITY_CONTRACT.validated_toolchains

const matchesPlatformEvidence = (
  probe: EnvironmentProbe,
  toolchain: ValidatedToolchain,
): boolean =>
  toolchain.platform === probe.platform
  && toolchain.arch === probe.arch
  && toolchain.platform_variant === probe.platformVariant
  && toolchain.libc === probe.libc
  && (toolchain.platform_release === null || toolchain.platform_release === probe.platformRelease)
  && (toolchain.evidence_profile === null || toolchain.evidence_profile === probe.evidenceProfile)

const platformCheck = (probe: EnvironmentProbe): CompatibilityCheck => {
  const platforms = ENVIRONMENT_COMPATIBILITY_CONTRACT.platforms as Record<string, Record<string, PlatformPolicy>>
  const family = platforms[probe.platform] ?? platforms.default
  const platformKey = probe.platform === 'linux' && probe.libc
    ? `${probe.arch}-${probe.libc}`
    : probe.arch
  const policy = family[platformKey] ?? family[probe.arch] ?? family.default
  const evidence = validatedToolchains().find((toolchain) =>
    matchesPlatformEvidence(probe, toolchain))
  const actual = [probe.platformVariant, probe.arch, probe.libc].filter(Boolean).join('/')
  return {
    id: 'platform',
    label: 'Platform',
    required: true,
    status: evidence ? 'validated' : policy.status,
    actual,
    expected: 'an exact platform evidence profile in environment-compatibility.json',
    detail: evidence
      ? `Matched observed platform evidence ${evidence.id}.`
      : policy.scope,
  }
}

const versionCheck = (
  id: CompatibilityCheck['id'],
  label: string,
  raw: string | null,
  policy: VersionPolicy,
  required = true,
): CompatibilityCheck => ({
  id,
  label,
  required,
  ...classifyVersion(raw, policy, label),
})

const ambientClaudeCheck = (raw: string | null): CompatibilityCheck => {
  const parsed = parseSemver(raw)
  const observed = ENVIRONMENT_COMPATIBILITY_CONTRACT.providers.claude.ambient.observed_versions
  return {
    id: 'claude_ambient_cli',
    label: 'Ambient Claude CLI',
    required: false,
    status: parsed ? 'experimental' : 'unsupported',
    actual: parsed?.value ?? null,
    expected: `optional; observed only: ${observed.join(', ')}`,
    detail: parsed
      ? `Claude CLI ${parsed.value} was found, but ambient CLI compatibility has no credentialed release gate.`
      : 'Optional ambient Claude CLI was not found; managed Claude uses the SDK-bundled executable.',
  }
}

const claudeBundledPolicy = (): VersionPolicy => ({
  validated_versions: Object.values(
    ENVIRONMENT_COMPATIBILITY_CONTRACT.providers.claude.managed.bundled_cli_by_sdk,
  ),
})

const toolchainCheck = (
  probe: EnvironmentProbe,
  componentChecks: readonly CompatibilityCheck[],
): CompatibilityCheck => {
  const node = parseSemver(probe.nodeVersion)?.value ?? null
  const npm = parseSemver(probe.npmVersion)?.value ?? null
  const evidence = validatedToolchains().find((toolchain) =>
    matchesPlatformEvidence(probe, toolchain)
    && toolchain.node === node
    && toolchain.npm === npm)
  const hasUnsupportedComponent = componentChecks.some((check) => check.status === 'unsupported')
  return {
    id: 'toolchain',
    label: 'Observed toolchain tuple',
    required: true,
    status: evidence
      ? 'validated'
      : hasUnsupportedComponent ? 'unsupported' : 'experimental',
    actual: `${probe.platformVariant}/${probe.arch}`
      + `${probe.libc ? `/${probe.libc}` : ''}`
      + ` · Node ${node ?? 'missing'} · npm ${npm ?? 'missing'}`,
    expected: validatedToolchains().map((toolchain) => toolchain.id).join(', '),
    detail: evidence
      ? `Matched observed end-to-end evidence ${evidence.id}.`
      : hasUnsupportedComponent
        ? 'At least one required platform or runtime component is unsupported.'
        : 'These individually known components were not observed together; the combination remains experimental.',
  }
}

export const evaluateEnvironmentCompatibility = (
  probe: EnvironmentProbe,
  provider: DoctorProvider = 'both',
  checkedAt = new Date(),
): EnvironmentDoctorReport => {
  const checks: CompatibilityCheck[] = [
    platformCheck(probe),
    versionCheck('node', 'Node.js', probe.nodeVersion, ENVIRONMENT_COMPATIBILITY_CONTRACT.runtime.node),
    versionCheck('npm', 'npm', probe.npmVersion, ENVIRONMENT_COMPATIBILITY_CONTRACT.runtime.npm),
  ]
  checks.push(toolchainCheck(probe, checks))

  if (provider === 'codex' || provider === 'both') {
    checks.push(versionCheck(
      'codex_cli',
      'Codex CLI',
      probe.codexVersion,
      ENVIRONMENT_COMPATIBILITY_CONTRACT.providers.codex.managed,
    ))
  }

  checks.push(
    versionCheck(
      'claude_sdk',
      'Claude Agent SDK',
      probe.claudeSdkVersion,
      {
        validated_versions:
          ENVIRONMENT_COMPATIBILITY_CONTRACT.providers.claude.managed.validated_sdk_versions,
      },
    ),
    versionCheck(
      'claude_native_package',
      'Claude native CLI package',
      probe.claudeNativePackageVersion,
      {
        validated_versions:
          ENVIRONMENT_COMPATIBILITY_CONTRACT.providers.claude.managed.validated_native_package_versions,
      },
    ),
    versionCheck(
      'claude_bundled_cli',
      'SDK-bundled Claude CLI',
      probe.claudeBundledCliVersion,
      claudeBundledPolicy(),
    ),
  )

  if (provider === 'claude' || provider === 'both') {
    checks.push(
      ambientClaudeCheck(probe.claudeAmbientCliVersion),
    )
  }

  const required = checks.filter((check) => check.required)
  const ready = required.every((check) => check.status === 'validated')
  const status: CompatibilityStatus = ready
    ? 'validated'
    : required.some((check) => check.status === 'unsupported')
      ? 'unsupported'
      : 'experimental'
  return {
    schema_version: 1,
    contract_schema_version: ENVIRONMENT_COMPATIBILITY_CONTRACT.schema_version,
    checked_at: checkedAt.toISOString(),
    provider,
    fail_closed: true,
    ready,
    status,
    checks,
  }
}

const probeVersion = (command: string): string | null => {
  try {
    const output = execFileSync(command, ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3_000,
      windowsHide: true,
    }).trim()
    return output ? output.slice(0, 200) : null
  } catch {
    return null
  }
}

const nativeClaudePackageName = (
  platform: string,
  arch: string,
  libc: string | null,
): string | null => {
  if (arch !== 'arm64' && arch !== 'x64') return null
  if (platform === 'darwin') return `@anthropic-ai/claude-agent-sdk-darwin-${arch}`
  if (platform === 'win32') return `@anthropic-ai/claude-agent-sdk-win32-${arch}`
  if (platform === 'linux') {
    if (libc !== 'glibc' && libc !== 'musl') return null
    return `@anthropic-ai/claude-agent-sdk-linux-${arch}${libc === 'musl' ? '-musl' : ''}`
  }
  return null
}

type ClaudeSdkDescriptorDeps = {
  resolvePackageJson?: (specifier: string) => string
  readTextFile?: (path: string) => string
}

export const readClaudeSdkDescriptor = (
  platform: string,
  arch: string,
  libc: string | null,
  readVersion: (command: string) => string | null,
  deps: ClaudeSdkDescriptorDeps = {},
): {
  version: string | null
  nativePackageVersion: string | null
  nativeCliVersion: string | null
} => {
  const require = createRequire(import.meta.url)
  const resolvePackageJson = deps.resolvePackageJson ?? ((specifier: string) => require.resolve(specifier))
  const readTextFile = deps.readTextFile ?? ((path: string) => readFileSync(path, 'utf8'))
  let sdkVersion: string | null = null
  try {
    const entry = resolvePackageJson('@anthropic-ai/claude-agent-sdk')
    const pkg = JSON.parse(readTextFile(join(dirname(entry), 'package.json'))) as {
      name?: unknown
      version?: unknown
    }
    if (pkg.name !== '@anthropic-ai/claude-agent-sdk') {
      return { version: null, nativePackageVersion: null, nativeCliVersion: null }
    }
    sdkVersion = typeof pkg.version === 'string' ? pkg.version : null
  } catch {
    return { version: null, nativePackageVersion: null, nativeCliVersion: null }
  }

  const nativePackage = nativeClaudePackageName(platform, arch, libc)
  if (!nativePackage) {
    return {
      version: sdkVersion,
      nativePackageVersion: null,
      nativeCliVersion: null,
    }
  }

  try {
    const nativePackageJson = resolvePackageJson(`${nativePackage}/package.json`)
    const native = JSON.parse(readTextFile(nativePackageJson)) as {
      name?: unknown
      version?: unknown
    }
    if (native.name !== nativePackage) {
      return {
        version: sdkVersion,
        nativePackageVersion: null,
        nativeCliVersion: null,
      }
    }
    const binary = join(dirname(nativePackageJson), platform === 'win32' ? 'claude.exe' : 'claude')
    return {
      version: sdkVersion,
      nativePackageVersion: typeof native.version === 'string' ? native.version : null,
      nativeCliVersion: readVersion(binary),
    }
  } catch {
    return { version: sdkVersion, nativePackageVersion: null, nativeCliVersion: null }
  }
}

const runtimeLibc = (platform: string): string | null => {
  if (platform !== 'linux') return null
  try {
    const report = process.report?.getReport() as {
      header?: Record<string, unknown>
      sharedObjects?: unknown
    } | undefined
    const header = report?.header
    if (typeof header?.glibcVersionRuntime === 'string') return 'glibc'
    const sharedObjects = report?.sharedObjects
    if (Array.isArray(sharedObjects) && sharedObjects.some((entry) =>
      typeof entry === 'string' && entry.toLowerCase().includes('musl'))) return 'musl'
  } catch {}
  return null
}

const runtimeEvidenceProfile = (
  env: NodeJS.ProcessEnv,
  platform: string,
): string | null =>
  platform === 'linux'
  && env.GITHUB_ACTIONS === 'true'
  && env.RUNNER_OS === 'Linux'
  && env.ORCHESTRA_COMPATIBILITY_EVIDENCE_PROFILE === 'github-actions-ubuntu-24.04'
    ? 'github-actions-ubuntu-24.04'
    : null

export const runtimePlatformVariant = (
  platform: string,
  release: string,
  env: NodeJS.ProcessEnv = process.env,
  readOsRelease: () => string = () => readFileSync('/etc/os-release', 'utf8'),
): string => {
  if (platform !== 'linux') return `${platform}-${release}`
  const isWsl = release.toLowerCase().includes('microsoft')
    || Boolean(env.WSL_INTEROP || env.WSL_DISTRO_NAME)
  try {
    const values = Object.fromEntries(
      readOsRelease()
        .split('\n')
        .map((line) => line.match(/^([A-Z_]+)=(.*)$/))
        .filter((match): match is RegExpMatchArray => Boolean(match))
        .map((match) => [
          match[1],
          match[2].replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1'),
        ]),
    )
    const suffix = isWsl ? '-wsl' : ''
    if (values.ID && values.VERSION_ID) return `${values.ID}-${values.VERSION_ID}${suffix}`
    if (values.ID) return `${values.ID}${suffix}`
  } catch {}
  return `${platform}-${release}${isWsl ? '-wsl' : ''}`
}

export const collectEnvironmentProbe = (
  env: NodeJS.ProcessEnv = process.env,
  provider: DoctorProvider = 'both',
  deps: EnvironmentProbeDeps = {},
): EnvironmentProbe => {
  const wantsCodex = provider === 'codex' || provider === 'both'
  const wantsAmbientClaude = provider === 'claude' || provider === 'both'
  const readVersion = deps.probeVersion ?? probeVersion
  const readClaude = deps.readClaudeSdkDescriptor ?? readClaudeSdkDescriptor
  const platform = process.platform
  const arch = process.arch
  const platformRelease = osRelease()
  const libc = runtimeLibc(platform)
  const claude = readClaude(platform, arch, libc, readVersion)
  return {
    platform,
    arch,
    platformRelease,
    platformVariant: runtimePlatformVariant(platform, platformRelease, env),
    libc,
    evidenceProfile: runtimeEvidenceProfile(env, platform),
    nodeVersion: process.versions.node,
    npmVersion: readVersion('npm'),
    codexVersion: wantsCodex
      ? readVersion(env.ORCHESTRA_CODEX_COMMAND?.trim() || 'codex')
      : null,
    claudeSdkVersion: claude.version,
    claudeNativePackageVersion: claude.nativePackageVersion,
    claudeBundledCliVersion: claude.nativeCliVersion,
    claudeAmbientCliVersion: wantsAmbientClaude ? readVersion('claude') : null,
  }
}

export const runEnvironmentDoctor = (
  provider: DoctorProvider = 'both',
  env: NodeJS.ProcessEnv = process.env,
): EnvironmentDoctorReport =>
  evaluateEnvironmentCompatibility(collectEnvironmentProbe(env, provider), provider)

export const assertManagedEnvironmentCompatibility = (
  report: EnvironmentDoctorReport,
): void => {
  if (report.ready) return
  const failures = report.checks
    .filter((check) => check.required && check.status !== 'validated')
    .map((check) => `${check.label}: ${check.status} (${check.actual ?? 'not found'})`)
    .join('; ')
  throw new Error(
    `Managed runtime compatibility check failed: ${failures}. Run orchestra doctor --provider ${report.provider}.`,
  )
}
