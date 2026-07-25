import { Command, InvalidArgumentError } from 'commander'
import {
  ENVIRONMENT_COMPATIBILITY_CONTRACT,
  runEnvironmentDoctor,
  type DoctorProvider,
  type EnvironmentDoctorReport,
} from './environment-compatibility.js'

export type DoctorCliDeps = {
  runDoctor?: (provider: DoctorProvider) => EnvironmentDoctorReport
  output?: (line: string) => void
  setExitCode?: (code: number) => void
}

const doctorProvider = (value: string): DoctorProvider => {
  if (value === 'claude' || value === 'codex' || value === 'both') return value
  throw new InvalidArgumentError('expected claude|codex|both')
}

export const formatDoctorReport = (report: EnvironmentDoctorReport): string => {
  const lines = [
    `Orchestra environment: ${report.ready ? 'READY' : 'NOT READY'} (${report.status})`,
    `Provider scope: ${report.provider}`,
  ]
  for (const check of report.checks) {
    const requirement = check.required ? 'required' : 'optional'
    lines.push(
      `[${check.status}] ${check.label} (${requirement})`
      + ` — ${check.actual ?? 'not found'} — ${check.detail}`,
    )
  }
  if (!report.ready) {
    const failures = report.checks.filter((check) =>
      check.required && check.status !== 'validated')
    lines.push(failures.every((check) => check.id === 'codex_cli')
      ? 'Managed Codex launches remain disabled until the Codex CLI check is validated.'
      : 'Daemon startup remains blocked until every core environment check is validated.')
  }
  return lines.join('\n')
}

export const registerDoctorCommand = (
  program: Command,
  deps: DoctorCliDeps = {},
): void => {
  const output = deps.output ?? console.log
  const setExitCode = deps.setExitCode ?? ((code: number) => { process.exitCode = code })
  program.command('doctor')
    .description('verify the supported runtime, platform, and provider versions without using credentials')
    .option('--provider <provider>', 'providers to verify (claude|codex|both)', doctorProvider, 'both')
    .option('--json', 'print the preflight report as JSON')
    .option('--contract', 'print the machine-readable compatibility contract without probing')
    .action((options: { provider: DoctorProvider; json?: boolean; contract?: boolean }) => {
      if (options.contract) {
        output(JSON.stringify(ENVIRONMENT_COMPATIBILITY_CONTRACT, null, 2))
        return
      }
      const report = (deps.runDoctor ?? runEnvironmentDoctor)(options.provider)
      output(options.json ? JSON.stringify(report, null, 2) : formatDoctorReport(report))
      if (!report.ready) setExitCode(1)
    })
}
