import { readFileSync } from 'node:fs'
import { Command } from 'commander'
import { describe, expect, it, vi } from 'vitest'
import { registerDoctorCommand } from '../src/doctor-cli.js'
import {
  evaluateEnvironmentCompatibility,
  type DoctorProvider,
  type EnvironmentDoctorReport,
  type EnvironmentProbe,
} from '../src/environment-compatibility.js'
import {
  runOperatorReadinessDoctor,
  type DoctorCommandOutcome,
  type OperatorDoctorReport,
} from '../src/readiness-doctor.js'

const probe: EnvironmentProbe = {
  platform: 'linux',
  arch: 'x64',
  platformRelease: 'github-actions-runner',
  platformVariant: 'ubuntu-24.04',
  libc: 'glibc',
  evidenceProfile: null,
  nodeVersion: '22.20.0',
  npmVersion: '10.9.3',
  codexVersion: 'codex-cli 0.144.6',
  claudeSdkVersion: '0.3.212',
  claudeNativePackageVersion: '0.3.212',
  claudeBundledCliVersion: '2.1.212',
  claudeAmbientCliVersion: null,
}

const compatibility = (provider: DoctorProvider): EnvironmentDoctorReport =>
  evaluateEnvironmentCompatibility(
    probe,
    provider,
    new Date('2026-07-25T20:00:00.000Z'),
  )

const commandResult = (
  command: string,
  args: readonly string[],
): DoctorCommandOutcome => {
  if (command === 'git') {
    return { exitCode: 0, stdout: 'git version 2.50.1', failure: null }
  }
  if (args[0] === 'login') {
    return { exitCode: 1, stdout: 'private-account-must-not-escape', failure: null }
  }
  return {
    exitCode: 0,
    stdout: JSON.stringify({ loggedIn: true }),
    failure: null,
  }
}

const readiness = (): OperatorDoctorReport =>
  runOperatorReadinessDoctor('both', {}, {
    runCompatibilityDoctor: (provider) => compatibility(provider),
    resolveClaudeBundledCommand: () => '/private/sdk/bin/claude',
    runCommand: commandResult,
  })

const setup = () => {
  const output: string[] = []
  const runDoctor = vi.fn(() => readiness())
  const runCompatibilityDoctor = vi.fn((provider: DoctorProvider) =>
    compatibility(provider))
  const setExitCode = vi.fn()
  const program = new Command().name('orchestra').exitOverride()
  program.configureOutput({ writeErr: () => {}, writeOut: () => {} })
  registerDoctorCommand(program, {
    runDoctor,
    runCompatibilityDoctor,
    output: (line) => output.push(line),
    setExitCode,
  })
  const run = (...args: string[]) =>
    program.parseAsync(['node', 'orchestra', ...args])
  return {
    output,
    run,
    runDoctor,
    runCompatibilityDoctor,
    setExitCode,
  }
}

describe('operator readiness doctor CLI', () => {
  it('runs full readiness by default and prints source, expected result, and fixes', async () => {
    const {
      output,
      run,
      runDoctor,
      runCompatibilityDoctor,
      setExitCode,
    } = setup()

    await run('doctor', '--provider', 'both')

    expect(runDoctor).toHaveBeenCalledWith('both')
    expect(runCompatibilityDoctor).not.toHaveBeenCalled()
    expect(output[0]).toContain('Mode: operator readiness')
    expect(output[0]).toContain('Source: <$PATH>/git')
    expect(output[0]).toContain('Expected: authenticated')
    expect(output[0]).toContain('Fix: Sign in to Codex')
    expect(output[0]).toContain('$ codex login')
    expect(output[0]).not.toContain('private-account-must-not-escape')
    expect(setExitCode).toHaveBeenCalledWith(1)
  })

  it('runs the credential-free compatibility report only when explicitly requested', async () => {
    const {
      output,
      run,
      runDoctor,
      runCompatibilityDoctor,
      setExitCode,
    } = setup()

    await run(
      'doctor',
      '--provider',
      'both',
      '--json',
      '--compatibility-only',
    )

    expect(runDoctor).not.toHaveBeenCalled()
    expect(runCompatibilityDoctor).toHaveBeenCalledWith('both')
    expect(JSON.parse(output[0])).toMatchObject({
      schema_version: 1,
      provider: 'both',
      ready: true,
    })
    expect(setExitCode).not.toHaveBeenCalled()
  })

  it('keeps contract inspection zero-probe even with readiness flags present', async () => {
    const {
      output,
      run,
      runDoctor,
      runCompatibilityDoctor,
      setExitCode,
    } = setup()

    await run('doctor', '--contract', '--compatibility-only')

    const contract = JSON.parse(output[0])
    expect(contract).toMatchObject({
      tools: {
        git: {
          min_inclusive: '2.30.0',
          max_exclusive: '3.0.0',
        },
      },
    })
    expect(runDoctor).not.toHaveBeenCalled()
    expect(runCompatibilityDoctor).not.toHaveBeenCalled()
    expect(setExitCode).not.toHaveBeenCalled()
  })
})

describe('readiness doctor documentation and hosted gate', () => {
  it('keeps hosted CI credential-free and documents full operator readiness', () => {
    const workflow = readFileSync(
      new URL('../.github/workflows/ci.yml', import.meta.url),
      'utf8',
    )
    const readme = readFileSync(
      new URL('../README.md', import.meta.url),
      'utf8',
    )
    const supported = readFileSync(
      new URL('../docs/supported-environments.md', import.meta.url),
      'utf8',
    )

    expect(workflow).toContain(
      'doctor --provider both --json --compatibility-only',
    )
    expect(readme).toContain('full operator readiness')
    expect(readme).toContain('--compatibility-only')
    expect(supported).toContain('provider login state')
    expect(supported).toContain('--compatibility-only')
  })
})
