import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  ENVIRONMENT_COMPATIBILITY_CONTRACT,
  assertManagedEnvironmentCompatibility,
  classifyCodexCliVersion,
  collectEnvironmentProbe,
  evaluateEnvironmentCompatibility,
  readClaudeSdkDescriptor,
  runtimePlatformVariant,
  type EnvironmentProbe,
} from '../src/environment-compatibility.js'

const validatedProbe = (overrides: Partial<EnvironmentProbe> = {}): EnvironmentProbe => ({
  platform: 'linux',
  arch: 'x64',
  platformRelease: 'github-actions-runner',
  platformVariant: 'ubuntu-24.04',
  libc: 'glibc',
  evidenceProfile: null,
  nodeVersion: 'v22.20.0',
  npmVersion: '10.9.3',
  codexVersion: 'codex-cli 0.146.0',
  claudeSdkVersion: '0.3.212',
  claudeNativePackageVersion: '0.3.212',
  claudeBundledCliVersion: '2.1.212',
  claudeAmbientCliVersion: null,
  ...overrides,
})

describe('environment compatibility contract', () => {
  it('keeps the provider protocol and bundled Claude versions machine readable', () => {
    const protocol = JSON.parse(readFileSync(
      new URL('../scripts/codex-protocol-contract.json', import.meta.url),
      'utf8',
    )) as { cli_version: string; file_count: number; sha256: string }
    expect(ENVIRONMENT_COMPATIBILITY_CONTRACT).toMatchObject({
      schema_version: 1,
      fail_closed: true,
      providers: {
        codex: {
          managed: {
            validated_versions: ['0.146.0'],
            protocol: {
              upstream_maturity: 'experimental',
              transport: 'stdio JSONL',
              file_count: 701,
              sha256: '62ba8908d54dd936875013976300421b2b47055c450adb36c84ab68eebb3a1e9',
            },
          },
        },
        claude: {
          managed: {
            validated_sdk_versions: ['0.3.212'],
            validated_native_package_versions: ['0.3.212'],
            bundled_cli_by_sdk: { '0.3.212': '2.1.212' },
            external_cli_required: false,
          },
        },
      },
    })
    expect(ENVIRONMENT_COMPATIBILITY_CONTRACT.providers.codex.managed).toMatchObject({
      validated_versions: [protocol.cli_version],
      protocol: {
        file_count: protocol.file_count,
        sha256: protocol.sha256,
      },
    })
  })

  it('accepts the exact observed Ubuntu toolchain without requiring an ambient Claude executable', () => {
    const report = evaluateEnvironmentCompatibility(
      validatedProbe(),
      'both',
      new Date('2026-07-25T12:00:00.000Z'),
    )

    expect(report).toMatchObject({
      checked_at: '2026-07-25T12:00:00.000Z',
      ready: true,
      status: 'validated',
      fail_closed: true,
    })
    expect(report.checks.find((check) => check.id === 'claude_ambient_cli')).toMatchObject({
      required: false,
      status: 'unsupported',
      actual: null,
    })
  })

  it('accepts the exact observed Darwin arm64 toolchain', () => {
    const report = evaluateEnvironmentCompatibility(validatedProbe({
      platform: 'darwin',
      arch: 'arm64',
      platformRelease: '25.5.0',
      platformVariant: 'darwin-25.5.0',
      libc: null,
      evidenceProfile: null,
      nodeVersion: '22.20.0',
      npmVersion: 'npm 10.9.3',
    }), 'claude')

    expect(report.ready).toBe(true)
    expect(report.status).toBe('validated')
  })

  it.each([
    ['too old', 'codex-cli 0.143.0'],
    ['too new', 'codex-cli 0.147.0'],
    ['missing', null],
    ['unparseable', 'codex-cli development'],
    ['a prerelease build', 'codex-cli 0.146.0-dev'],
  ])('fails closed when Codex is %s', (_case, version) => {
    const report = evaluateEnvironmentCompatibility(
      validatedProbe({ codexVersion: version }),
      'codex',
    )

    expect(report.ready).toBe(false)
    expect(report.status).toBe('unsupported')
    expect(report.checks.find((check) => check.id === 'codex_cli')).toMatchObject({
      required: true,
      status: 'unsupported',
    })
  })

  it('does not treat a nearby Codex version as compatible with the pinned app-server protocol', () => {
    expect(classifyCodexCliVersion('codex-cli 0.145.0')).toMatchObject({
      status: 'unsupported',
      actual: '0.145.0',
      expected: 'exactly 0.146.0',
    })
  })

  it.each([
    ['SDK package', { claudeSdkVersion: null }],
    ['native CLI package', { claudeNativePackageVersion: null }],
    ['native CLI executable', { claudeBundledCliVersion: null }],
  ])('fails closed when the managed Claude %s is missing', (_case, overrides) => {
    const report = evaluateEnvironmentCompatibility(validatedProbe(overrides), 'claude')

    expect(report.ready).toBe(false)
    expect(report.status).toBe('unsupported')
  })

  it.each([
    ['SDK package too old', { claudeSdkVersion: '0.3.211' }, 'claude_sdk'],
    ['SDK package too new', { claudeSdkVersion: '0.3.213' }, 'claude_sdk'],
    ['native package too old', { claudeNativePackageVersion: '0.3.211' }, 'claude_native_package'],
    ['native package too new', { claudeNativePackageVersion: '0.3.213' }, 'claude_native_package'],
    ['bundled CLI too old', { claudeBundledCliVersion: '2.1.211' }, 'claude_bundled_cli'],
    ['bundled CLI too new', { claudeBundledCliVersion: '2.1.213' }, 'claude_bundled_cli'],
  ])('fails closed when the managed Claude %s', (_case, overrides, checkId) => {
    const report = evaluateEnvironmentCompatibility(validatedProbe(overrides), 'claude')

    expect(report.ready).toBe(false)
    expect(report.status).toBe('unsupported')
    expect(report.checks.find((check) => check.id === checkId)).toMatchObject({
      required: true,
      status: 'unsupported',
    })
  })

  it('labels unobserved in-range tooling experimental and does not call it ready', () => {
    const report = evaluateEnvironmentCompatibility(validatedProbe({
      nodeVersion: '22.21.0',
      npmVersion: '10.9.4',
    }), 'claude')

    expect(report.ready).toBe(false)
    expect(report.status).toBe('experimental')
    expect(report.checks.filter((check) => check.status === 'experimental').map((check) => check.id))
      .toEqual(['node', 'npm', 'toolchain'])
  })

  it('validates the one exact release tuple across its observed Darwin evidence', () => {
    const report = evaluateEnvironmentCompatibility(validatedProbe({
      platform: 'darwin',
      arch: 'arm64',
      platformRelease: '25.5.0',
      platformVariant: 'darwin-25.5.0',
      libc: null,
      evidenceProfile: null,
      nodeVersion: '22.20.0',
      npmVersion: '10.9.3',
    }), 'both')

    expect(report.checks.find((check) => check.id === 'platform')?.status).toBe('validated')
    expect(report.checks.find((check) => check.id === 'node')?.status).toBe('validated')
    expect(report.checks.find((check) => check.id === 'npm')?.status).toBe('validated')
    expect(report.checks.find((check) => check.id === 'toolchain')).toMatchObject({
      status: 'validated',
    })
    expect(report.ready).toBe(true)
    expect(report.status).toBe('validated')
  })

  it('keeps other Linux variants and musl experimental outside the observed Ubuntu tuple', () => {
    const report = evaluateEnvironmentCompatibility(validatedProbe({
      libc: 'musl',
      platformVariant: 'alpine-3.20',
      evidenceProfile: null,
    }), 'claude')

    expect(report.checks.find((check) => check.id === 'platform')).toMatchObject({
      status: 'experimental',
      actual: 'alpine-3.20/x64/musl',
    })
    expect(report.checks.find((check) => check.id === 'toolchain')?.status).toBe('experimental')
    expect(report.ready).toBe(false)
  })

  it('keeps WSL Ubuntu experimental instead of inheriting native Ubuntu evidence', () => {
    const variant = runtimePlatformVariant(
      'linux',
      '5.15.153.1-microsoft-standard-WSL2',
      {},
      () => 'ID=ubuntu\nVERSION_ID="24.04"\n',
    )
    const report = evaluateEnvironmentCompatibility(validatedProbe({
      platformRelease: '5.15.153.1-microsoft-standard-WSL2',
      platformVariant: variant,
    }), 'both')

    expect(variant).toBe('ubuntu-24.04-wsl')
    expect(report.checks.find((check) => check.id === 'platform')).toMatchObject({
      status: 'experimental',
      actual: 'ubuntu-24.04-wsl/x64/glibc',
    })
    expect(report.checks.find((check) => check.id === 'toolchain')?.status).toBe('experimental')
    expect(report.ready).toBe(false)
  })

  it('proves omitted optional dependencies cannot pass from base SDK metadata alone', () => {
    const collected = collectEnvironmentProbe(process.env, 'claude', {
      probeVersion: (command) => command === 'npm'
        ? '10.9.3'
        : null,
      readClaudeSdkDescriptor: () => ({
        version: '0.3.212',
        nativePackageVersion: null,
        nativeCliVersion: null,
      }),
    })
    const report = evaluateEnvironmentCompatibility(collected, 'claude')

    expect(report.checks.find((check) => check.id === 'claude_sdk')?.status).toBe('validated')
    expect(report.checks.find((check) => check.id === 'claude_native_package')?.status).toBe('unsupported')
    expect(report.checks.find((check) => check.id === 'claude_bundled_cli')?.status).toBe('unsupported')
    expect(report.ready).toBe(false)
    expect(() => assertManagedEnvironmentCompatibility(report))
      .toThrow(/Managed runtime compatibility check failed/)
  })

  it('preserves the installed SDK version when native package resolution fails', () => {
    const descriptor = readClaudeSdkDescriptor(
      'linux',
      'x64',
      'glibc',
      () => null,
      {
        resolvePackageJson: (specifier) => {
          if (specifier === '@anthropic-ai/claude-agent-sdk') return '/sdk/index.js'
          throw new Error(`Missing optional package: ${specifier}`)
        },
        readTextFile: (path) => {
          expect(path).toBe('/sdk/package.json')
          return JSON.stringify({
            name: '@anthropic-ai/claude-agent-sdk',
            version: '0.3.212',
          })
        },
      },
    )

    expect(descriptor).toEqual({
      version: '0.3.212',
      nativePackageVersion: null,
      nativeCliVersion: null,
    })
  })

  it.each([
    ['Node.js too old', { nodeVersion: '22.11.0' }, 'node'],
    ['Node.js too new', { nodeVersion: '23.0.0' }, 'node'],
    ['Node.js missing', { nodeVersion: null }, 'node'],
    ['npm too old', { npmVersion: '10.8.9' }, 'npm'],
    ['npm too new', { npmVersion: '11.0.0' }, 'npm'],
    ['npm missing', { npmVersion: null }, 'npm'],
  ])('fails closed when %s', (_case, overrides, checkId) => {
    const report = evaluateEnvironmentCompatibility(validatedProbe(overrides), 'claude')

    expect(report.ready).toBe(false)
    expect(report.status).toBe('unsupported')
    expect(report.checks.find((check) => check.id === checkId)).toMatchObject({
      status: 'unsupported',
    })
  })

  it('keeps Windows unsupported until its product-level acceptance gates exist', () => {
    const report = evaluateEnvironmentCompatibility(validatedProbe({
      platform: 'win32',
      arch: 'x64',
      platformRelease: 'windows-test',
      platformVariant: 'win32-windows-test',
      libc: null,
      evidenceProfile: null,
    }), 'both')

    expect(report.ready).toBe(false)
    expect(report.status).toBe('unsupported')
    expect(report.checks[0]).toMatchObject({
      id: 'platform',
      status: 'unsupported',
    })
  })
})
