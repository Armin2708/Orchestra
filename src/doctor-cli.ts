import { Command, InvalidArgumentError } from 'commander'
import {
  ENVIRONMENT_COMPATIBILITY_CONTRACT,
  runEnvironmentDoctor,
  type DoctorProvider,
  type EnvironmentDoctorReport,
} from './environment-compatibility.js'
import {
  runOperatorReadinessDoctor,
  type OperatorDoctorCheck,
  type OperatorDoctorReport,
} from './readiness-doctor.js'

export type DoctorCliDeps = {
  runDoctor?: (
    provider: DoctorProvider,
  ) => EnvironmentDoctorReport | OperatorDoctorReport
  runCompatibilityDoctor?: (provider: DoctorProvider) => EnvironmentDoctorReport
  output?: (line: string) => void
  setExitCode?: (code: number) => void
}

const doctorProvider = (value: string): DoctorProvider => {
  if (value === 'claude' || value === 'codex' || value === 'both') return value
  throw new InvalidArgumentError('expected claude|codex|both')
}

type DoctorCliReport = EnvironmentDoctorReport | OperatorDoctorReport
type DoctorCliCheck = EnvironmentDoctorReport['checks'][number] | OperatorDoctorCheck

const isReadinessReport = (
  report: DoctorCliReport,
): report is OperatorDoctorReport =>
  'mode' in report && report.mode === 'readiness'

const checkRemediation = (
  check: DoctorCliCheck,
): OperatorDoctorCheck['remediation'] =>
  'remediation' in check ? check.remediation : undefined

const checkExecutable = (
  check: DoctorCliCheck,
): OperatorDoctorCheck['executable'] =>
  'executable' in check ? check.executable : undefined

export const formatDoctorReport = (report: DoctorCliReport): string => {
  const lines = [
    `Orchestra environment: ${report.ready ? 'READY' : 'NOT READY'} (${report.status})`,
    `Provider scope: ${report.provider}`,
    `Mode: ${isReadinessReport(report) ? 'operator readiness' : 'compatibility only'}`,
  ]
  for (const check of report.checks) {
    const requirement = check.required ? 'required' : 'optional'
    lines.push(
      `[${check.status}] ${check.label} (${requirement})`
      + ` — ${check.actual ?? 'not found'} — ${check.detail}`,
    )
    const executable = checkExecutable(check)
    if (executable) {
      lines.push(
        `  Source: ${executable.display}`
        + `${executable.path_fingerprint ? ` (${executable.path_fingerprint})` : ''}`,
      )
    }
    lines.push(`  Expected: ${check.expected}`)
    const fix = checkRemediation(check)
    if (fix) {
      lines.push(`  Fix: ${fix.summary}`)
      for (const command of fix.commands) lines.push(`    $ ${command}`)
      lines.push(`    Docs: ${fix.docs}`)
    }
  }
  if (!report.ready) {
    if (isReadinessReport(report)) {
      lines.push('Operator readiness remains blocked until every required compatibility, tool, and login check passes.')
    } else {
      const failures = report.checks.filter((check) =>
        check.required && check.status !== 'validated')
      lines.push(failures.every((check) => check.id === 'codex_cli')
        ? 'Managed Codex launches remain disabled until the Codex CLI check is validated.'
        : 'Daemon startup remains blocked until every core environment check is validated.')
    }
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
    .description('verify runtime, Git, provider versions, and selected-provider login readiness')
    .option('--provider <provider>', 'providers to verify (claude|codex|both)', doctorProvider, 'both')
    .option('--json', 'print the preflight report as JSON')
    .option('--contract', 'print the machine-readable compatibility contract without probing')
    .option('--compatibility-only', 'skip provider login state and run the credential-free compatibility gate')
    .action((options: {
      provider: DoctorProvider
      json?: boolean
      contract?: boolean
      compatibilityOnly?: boolean
    }) => {
      if (options.contract) {
        output(JSON.stringify(ENVIRONMENT_COMPATIBILITY_CONTRACT, null, 2))
        return
      }
      const report = options.compatibilityOnly
        ? (deps.runCompatibilityDoctor ?? runEnvironmentDoctor)(options.provider)
        : (deps.runDoctor ?? runOperatorReadinessDoctor)(options.provider)
      output(options.json ? JSON.stringify(report, null, 2) : formatDoctorReport(report))
      if (!report.ready) setExitCode(1)
    })
}
