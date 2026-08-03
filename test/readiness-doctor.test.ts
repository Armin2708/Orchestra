import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  evaluateEnvironmentCompatibility,
  type DoctorProvider,
  type EnvironmentDoctorReport,
  type EnvironmentProbe,
} from '../src/environment-compatibility.js'
import {
  runBoundedDoctorCommand,
  runOperatorReadinessDoctor,
  type DoctorCommandOutcome,
  type OperatorDoctorDeps,
  type OperatorDoctorReport,
} from '../src/readiness-doctor.js'

const validatedProbe = (overrides: Partial<EnvironmentProbe> = {}): EnvironmentProbe => ({
  platform: 'linux',
  arch: 'x64',
  platformRelease: 'github-actions-runner',
  platformVariant: 'ubuntu-24.04',
  libc: 'glibc',
  evidenceProfile: null,
  nodeVersion: '22.20.0',
  npmVersion: '10.9.3',
  codexVersion: 'codex-cli 0.146.0',
  claudeSdkVersion: '0.3.212',
  claudeNativePackageVersion: '0.3.212',
  claudeBundledCliVersion: '2.1.212',
  claudeAmbientCliVersion: null,
  ...overrides,
})

const compatibility = (
  provider: DoctorProvider = 'both',
  overrides: Partial<EnvironmentProbe> = {},
): EnvironmentDoctorReport =>
  evaluateEnvironmentCompatibility(
    validatedProbe(overrides),
    provider,
    new Date('2026-07-25T20:00:00.000Z'),
  )

const outcome = (
  overrides: Partial<DoctorCommandOutcome> = {},
): DoctorCommandOutcome => ({
  exitCode: 0,
  stdout: '',
  failure: null,
  ...overrides,
})

const setup = (options: {
  provider?: DoctorProvider
  probe?: Partial<EnvironmentProbe>
  git?: DoctorCommandOutcome
  codex?: DoctorCommandOutcome
  claude?: DoctorCommandOutcome
  env?: NodeJS.ProcessEnv
  claudeCommand?: string | null
} = {}): {
  report: OperatorDoctorReport
  calls: { command: string; args: readonly string[] }[]
} => {
  const provider = options.provider ?? 'both'
  const calls: { command: string; args: readonly string[] }[] = []
  const deps: OperatorDoctorDeps = {
    runCompatibilityDoctor: (scope) => compatibility(scope, options.probe),
    resolveClaudeBundledCommand: () =>
      options.claudeCommand === undefined ? '/private/sdk/bin/claude' : options.claudeCommand,
    runCommand: (command, args) => {
      calls.push({ command, args })
      if (command === 'git') {
        return options.git ?? outcome({ stdout: 'git version 2.50.1 (Apple Git-155)' })
      }
      if (args[0] === 'login') {
        return options.codex ?? outcome({ stdout: 'Logged in using ChatGPT' })
      }
      return options.claude ?? outcome({
        stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }),
      })
    },
  }
  return {
    report: runOperatorReadinessDoctor(provider, options.env ?? {}, deps),
    calls,
  }
}

const check = (
  report: OperatorDoctorReport,
  id: OperatorDoctorReport['checks'][number]['id'],
) => report.checks.find((entry) => entry.id === id)

describe('operator readiness doctor', () => {
  it('requires Git and both selected provider logins without changing compatibility evidence', () => {
    const { report, calls } = setup()

    expect(report).toMatchObject({
      schema_version: 2,
      compatibility_schema_version: 1,
      mode: 'readiness',
      ready: true,
      status: 'validated',
      compatibility_ready: true,
      compatibility_status: 'validated',
    })
    expect(check(report, 'git')).toMatchObject({
      status: 'validated',
      actual: '2.50.1',
      expected: '>=2.30.0 <3.0.0',
    })
    expect(check(report, 'codex_login')).toMatchObject({
      status: 'validated',
      actual: 'authenticated',
    })
    expect(check(report, 'claude_login')).toMatchObject({
      status: 'validated',
      actual: 'authenticated',
    })
    expect(calls).toEqual([
      { command: 'git', args: ['--version'] },
      { command: 'codex', args: ['login', 'status'] },
      { command: '/private/sdk/bin/claude', args: ['auth', 'status', '--json'] },
    ])
  })

  it.each([
    ['codex', ['git', 'codex_login'], 'claude_login'],
    ['claude', ['git', 'claude_login'], 'codex_login'],
  ] as const)('scopes login probes to the selected %s provider', (provider, present, absent) => {
    const { report, calls } = setup({ provider })

    expect(present.every((id) => check(report, id))).toBe(true)
    expect(check(report, absent)).toBeUndefined()
    expect(calls.some((entry) => entry.args[0] === (provider === 'codex' ? 'login' : 'auth'))).toBe(true)
    expect(calls.some((entry) => entry.args[0] === (provider === 'codex' ? 'auth' : 'login'))).toBe(false)
  })

  it.each([
    ['missing', outcome({ exitCode: null, failure: 'missing' }), null],
    ['timed out', outcome({ exitCode: null, failure: 'timeout' }), null],
    ['overflowed', outcome({ exitCode: null, failure: 'overflow' }), null],
    ['nonzero with plausible output', outcome({
      exitCode: 2,
      stdout: 'git version 2.50.1',
    }), null],
    ['unparseable', outcome({ stdout: 'git development build' }), null],
    ['too old', outcome({ stdout: 'git version 2.29.9' }), '2.29.9'],
    ['too new', outcome({ stdout: 'git version 3.0.0' }), '3.0.0'],
  ] as const)('fails closed when Git is %s', (_case, git, actual) => {
    const { report } = setup({ git })
    const gitResult = check(report, 'git')

    expect(report.ready).toBe(false)
    expect(gitResult).toMatchObject({
      required: true,
      status: 'unsupported',
      actual,
      remediation: {
        summary: expect.stringContaining('Git'),
        commands: expect.arrayContaining(['git --version']),
      },
    })
  })

  it('reports logged-out Codex without retaining its command output', () => {
    const secret = 'account@example.com credential-secret-sentinel'
    const { report } = setup({
      provider: 'codex',
      codex: outcome({ exitCode: 1, stdout: secret }),
    })

    expect(check(report, 'codex_login')).toMatchObject({
      status: 'unsupported',
      actual: 'unauthenticated',
      remediation: {
        commands: ['codex login', 'codex login status', 'orchestra restart'],
      },
    })
    expect(JSON.stringify(report)).not.toContain(secret)
  })

  it.each([
    ['missing', outcome({ exitCode: null, failure: 'missing' })],
    ['timeout', outcome({ exitCode: null, failure: 'timeout' })],
    ['overflow', outcome({ exitCode: null, failure: 'overflow' })],
    ['unexpected exit', outcome({ exitCode: 2 })],
  ] as const)('keeps an indeterminate Codex login fail-closed when the command is %s', (_case, codex) => {
    const { report } = setup({ provider: 'codex', codex })

    expect(report.ready).toBe(false)
    expect(check(report, 'codex_login')).toMatchObject({
      status: 'unsupported',
      actual: 'unknown',
    })
  })

  it('parses only Claude loggedIn and never projects raw account or token fields', () => {
    const secret = 'sk-ant-secret-sentinel'
    const rawPath = '/Users/sensitive-user/.claude/private'
    const { report } = setup({
      provider: 'claude',
      claude: outcome({
        stdout: JSON.stringify({
          loggedIn: true,
          email: 'private@example.com',
          token: secret,
          configPath: rawPath,
        }),
      }),
      claudeCommand: `${rawPath}/claude`,
    })
    const serialized = JSON.stringify(report)

    expect(check(report, 'claude_login')).toMatchObject({
      status: 'validated',
      actual: 'authenticated',
    })
    expect(serialized).not.toContain(secret)
    expect(serialized).not.toContain('private@example.com')
    expect(serialized).not.toContain(rawPath)
    expect(serialized).not.toContain('sensitive-user')
    expect(check(report, 'claude_login')).toMatchObject({
      executable: {
        source: 'sdk_bundled',
        display: '<sdk-bundled>/claude',
      },
    })
  })

  it.each([
    ['logged out', outcome({ stdout: JSON.stringify({ loggedIn: false }) }), 'unauthenticated'],
    ['wrong type', outcome({ stdout: JSON.stringify({ loggedIn: 'true' }) }), 'unknown'],
    ['invalid JSON', outcome({ stdout: 'not-json' }), 'unknown'],
    ['unexpected exit', outcome({ exitCode: 2, stdout: JSON.stringify({ loggedIn: true }) }), 'unknown'],
    ['timeout', outcome({ exitCode: null, failure: 'timeout' }), 'unknown'],
  ] as const)('fails closed when Claude login is %s', (_case, claude, actual) => {
    const { report } = setup({ provider: 'claude', claude })

    expect(report.ready).toBe(false)
    expect(check(report, 'claude_login')).toMatchObject({
      status: 'unsupported',
      actual,
      remediation: {
        commands: [
          'npm install --global @anthropic-ai/claude-code@2.1.212',
          'claude auth login',
          'claude auth status --text',
          'orchestra restart',
        ],
      },
    })
  })

  it('gives a runnable Claude login fix when no ambient Claude exists on PATH', () => {
    const { report } = setup({
      provider: 'claude',
      env: { PATH: '' },
      claude: outcome({ stdout: JSON.stringify({ loggedIn: false }) }),
    })

    expect(check(report, 'claude_ambient_cli')).toMatchObject({
      required: false,
      status: 'unsupported',
      executable: { path_fingerprint: null },
    })
    expect(check(report, 'claude_login')).toMatchObject({
      status: 'unsupported',
      actual: 'unauthenticated',
      remediation: {
        commands: [
          'npm install --global @anthropic-ai/claude-code@2.1.212',
          'claude auth login',
          'claude auth status --text',
          'orchestra restart',
        ],
      },
    })
  })

  it('does not invoke auth subcommands until the corresponding CLI is compatible', () => {
    const runCommand = vi.fn((command: string) =>
      command === 'git'
        ? outcome({ stdout: 'git version 2.50.1' })
        : outcome({ stdout: 'must-not-run' }))
    const report = runOperatorReadinessDoctor('both', {}, {
      runCompatibilityDoctor: (provider) => compatibility(provider, {
        codexVersion: 'codex-cli 0.145.0',
        claudeBundledCliVersion: '2.1.213',
      }),
      resolveClaudeBundledCommand: () => '/private/sdk/bin/claude',
      runCommand,
    })

    expect(runCommand).toHaveBeenCalledTimes(1)
    expect(runCommand).toHaveBeenCalledWith('git', ['--version'], {})
    expect(check(report, 'codex_login')).toMatchObject({
      actual: 'not checked',
      status: 'unsupported',
    })
    expect(check(report, 'claude_login')).toMatchObject({
      actual: 'not checked',
      status: 'unsupported',
    })
  })

  it('fails closed if the validated Claude executable can no longer be resolved', () => {
    const { report, calls } = setup({
      provider: 'claude',
      claudeCommand: null,
    })

    expect(report.ready).toBe(false)
    expect(check(report, 'claude_login')).toMatchObject({
      actual: 'not checked',
      status: 'unsupported',
      executable: {
        source: 'sdk_bundled',
        display: '<sdk-bundled>/claude',
        path_fingerprint: null,
      },
    })
    expect(calls).toEqual([{ command: 'git', args: ['--version'] }])
  })

  it('identifies PATH, environment override, process, and SDK sources without raw paths', () => {
    const rawCodexPath = '/Users/private-user/.secret-tools/codex'
    const rawClaudePath = '/private/accounts/private-user/claude'
    const { report } = setup({
      env: { ORCHESTRA_CODEX_COMMAND: rawCodexPath },
      claudeCommand: rawClaudePath,
    })
    const serialized = JSON.stringify(report)

    expect(check(report, 'node')).toMatchObject({
      executable: { source: 'process', display: '<process>/node' },
    })
    expect(check(report, 'npm')).toMatchObject({
      executable: { source: 'path', display: '<$PATH>/npm' },
    })
    expect(check(report, 'codex_cli')).toMatchObject({
      executable: { source: 'environment_override', display: '<environment-override>/codex' },
    })
    expect(check(report, 'claude_bundled_cli')).toMatchObject({
      executable: { source: 'sdk_bundled', display: '<sdk-bundled>/claude' },
    })
    expect(serialized).not.toContain(rawCodexPath)
    expect(serialized).not.toContain(rawClaudePath)
    expect(serialized).not.toContain('private-user')
  })

  it.each([
    '/private/bin/codex;credential-secret',
    '/private/bin/sk-ant-secret-sentinel',
    '/private/bin/private-account-token-123',
  ])('never derives a visible executable label from hostile override %s', (hostile) => {
    const { report } = setup({
      provider: 'codex',
      env: { ORCHESTRA_CODEX_COMMAND: hostile },
    })
    const serialized = JSON.stringify(report)

    expect(check(report, 'codex_login')).toMatchObject({
      executable: {
        display: '<environment-override>/codex',
      },
    })
    expect(serialized).not.toContain(hostile)
    expect(serialized).not.toContain(hostile.split('/').at(-1))
  })

  it('binds override remediation to ORCHESTRA_CODEX_COMMAND without reflecting its value', () => {
    const rawOverride = '/private/accounts/secret-owner/codex-private'
    const { report } = setup({
      provider: 'codex',
      env: {
        ORCHESTRA_CODEX_COMMAND: rawOverride,
        PATH: '',
      },
      codex: outcome({ exitCode: 1, stdout: 'private account output' }),
    })
    const serialized = JSON.stringify(report)

    expect(check(report, 'codex_login')).toMatchObject({
      status: 'unsupported',
      remediation: {
        commands: [
          '"$ORCHESTRA_CODEX_COMMAND" login',
          '"$ORCHESTRA_CODEX_COMMAND" login status',
          'orchestra restart',
        ],
      },
    })
    expect(serialized).not.toContain(rawOverride)
    expect(serialized).not.toContain('secret-owner')
    expect(serialized).not.toContain('private account output')
  })

  it('attaches structured remediation to every required failing compatibility check', () => {
    const { report } = setup({
      provider: 'both',
      probe: {
        platform: 'win32',
        arch: 'x64',
        platformRelease: 'windows-test',
        platformVariant: 'win32-windows-test',
        libc: null,
        nodeVersion: '23.0.0',
        npmVersion: '11.0.0',
        codexVersion: null,
        claudeSdkVersion: null,
        claudeNativePackageVersion: null,
        claudeBundledCliVersion: null,
      },
      git: outcome({ exitCode: null, failure: 'missing' }),
      claudeCommand: null,
    })

    const failures = report.checks.filter((entry) =>
      entry.required && entry.status !== 'validated')
    expect(failures.length).toBeGreaterThan(0)
    for (const failure of failures) {
      expect(failure).toHaveProperty('remediation.summary')
      expect(failure).toHaveProperty('remediation.commands')
      expect(failure).toHaveProperty('remediation.docs')
    }
  })

  it('never tells an installed operator to run npm ci in an arbitrary working directory', () => {
    const { report } = setup({
      provider: 'claude',
      probe: {
        claudeSdkVersion: null,
        claudeNativePackageVersion: null,
        claudeBundledCliVersion: null,
      },
      claudeCommand: null,
    })
    const commands = report.checks.flatMap((entry) =>
      entry.remediation?.commands ?? [])

    expect(commands).not.toContain('npm ci')
    expect(JSON.stringify(report)).not.toMatch(/"commands":\[[^\]]*"npm ci"/)
    expect(check(report, 'claude_login')).toMatchObject({
      status: 'unsupported',
      actual: 'not checked',
      remediation: {
        summary: expect.stringContaining('Reinstall Orchestra'),
        commands: [],
      },
    })
  })
})

describe('bounded doctor command runner', () => {
  it('passes arguments literally with shell disabled', () => {
    const root = mkdtempSync(join(tmpdir(), 'orchestra-doctor-argv-'))
    const touched = join(root, 'must-not-exist')
    const literal = `$(touch ${touched})`
    try {
      const result = runBoundedDoctorCommand(
        process.execPath,
        ['-e', 'process.stdout.write(process.argv[1])', literal],
        {},
      )

      expect(result).toEqual({
        exitCode: 0,
        stdout: literal,
        failure: null,
      })
      expect(existsSync(touched)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('bounds captured output and reports overflow without returning raw bulk output', () => {
    const result = runBoundedDoctorCommand(
      process.execPath,
      ['-e', 'process.stdout.write("x".repeat(20000))'],
      {},
    )

    expect(result.failure).toBe('overflow')
    expect(result.stdout.length).toBeLessThanOrEqual(4_096)
  })

  it('classifies a missing executable without reflecting its path', () => {
    const missing = '/private/credential-owner/no-such-doctor-command'
    const result = runBoundedDoctorCommand(missing, ['--version'], {})

    expect(result).toMatchObject({
      exitCode: null,
      stdout: '',
      failure: 'missing',
    })
    expect(JSON.stringify(result)).not.toContain(missing)
  })
})
