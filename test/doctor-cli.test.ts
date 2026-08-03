import { Command } from 'commander'
import { describe, expect, it, vi } from 'vitest'
import { registerDoctorCommand } from '../src/doctor-cli.js'
import {
  evaluateEnvironmentCompatibility,
  type EnvironmentDoctorReport,
  type EnvironmentProbe,
} from '../src/environment-compatibility.js'

const probe = (overrides: Partial<EnvironmentProbe> = {}): EnvironmentProbe => ({
  platform: 'linux',
  arch: 'x64',
  platformRelease: 'github-actions-runner',
  platformVariant: 'ubuntu-24.04',
  libc: 'glibc',
  evidenceProfile: null,
  nodeVersion: '22.20.0',
  npmVersion: '10.9.3',
  codexVersion: '0.146.0',
  claudeSdkVersion: '0.3.212',
  claudeNativePackageVersion: '0.3.212',
  claudeBundledCliVersion: '2.1.212',
  claudeAmbientCliVersion: null,
  ...overrides,
})

const setup = (report: EnvironmentDoctorReport) => {
  const output: string[] = []
  const setExitCode = vi.fn()
  const runDoctor = vi.fn(() => report)
  const program = new Command().name('orchestra').exitOverride()
  program.configureOutput({ writeErr: () => {}, writeOut: () => {} })
  registerDoctorCommand(program, {
    runDoctor,
    output: (line) => output.push(line),
    setExitCode,
  })
  const run = (...args: string[]) => program.parseAsync(['node', 'orchestra', ...args])
  return { output, run, runDoctor, setExitCode }
}

describe('doctor CLI', () => {
  it('prints a successful credential-free preflight as machine-readable JSON', async () => {
    const report = evaluateEnvironmentCompatibility(probe(), 'both')
    const { output, run, runDoctor, setExitCode } = setup(report)

    await run('doctor', '--provider', 'both', '--json')

    expect(runDoctor).toHaveBeenCalledWith('both')
    expect(JSON.parse(output[0])).toMatchObject({
      provider: 'both',
      ready: true,
      status: 'validated',
    })
    expect(setExitCode).not.toHaveBeenCalled()
  })

  it('returns a failing preflight when a required provider is unsupported', async () => {
    const report = evaluateEnvironmentCompatibility(probe({ codexVersion: null }), 'codex')
    const { output, run, setExitCode } = setup(report)

    await run('doctor', '--provider', 'codex')

    expect(output[0]).toContain('Orchestra environment: NOT READY (unsupported)')
    expect(output[0]).toContain('[unsupported] Codex CLI (required)')
    expect(output[0]).toContain('Managed Codex launches remain disabled')
    expect(setExitCode).toHaveBeenCalledWith(1)
  })

  it('prints the canonical contract without running provider commands', async () => {
    const report = evaluateEnvironmentCompatibility(probe(), 'both')
    const { output, run, runDoctor, setExitCode } = setup(report)

    await run('doctor', '--contract')

    expect(JSON.parse(output[0])).toMatchObject({
      schema_version: 1,
      fail_closed: true,
      providers: {
        codex: { managed: { validated_versions: ['0.146.0'] } },
      },
    })
    expect(runDoctor).not.toHaveBeenCalled()
    expect(setExitCode).not.toHaveBeenCalled()
  })
})
