import { spawn } from 'node:child_process'
import { InvalidArgumentError } from 'commander'
import { baseUrl, ensureDaemon } from './daemon.js'
import { formatDoctorReport } from './doctor-cli.js'
import { type DoctorProvider } from './environment-compatibility.js'
import { installHooks, type HookScope, type InstallProvider } from './install.js'
import {
  runOperatorReadinessDoctor,
  type OperatorDoctorReport,
} from './readiness-doctor.js'

export type InitCliDeps = {
  runDoctor?: (provider: DoctorProvider) => OperatorDoctorReport
  formatReport?: (report: OperatorDoctorReport) => string
  startDaemon?: () => Promise<boolean>
  installProviderHooks?: (scope: HookScope, options: { provider: InstallProvider }) => void
  openBrowser?: (url: string) => void
  boardUrl?: () => string
  output?: (line: string) => void
}

// best-effort, never throws: init must succeed on headless boxes too
export const defaultOpenBrowser = (url: string): void => {
  const command = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'cmd' : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
  try {
    spawn(command, args, { stdio: 'ignore', detached: true }).unref()
  } catch { /* headless or no handler — the printed URL is the fallback */ }
}

export const initProviderOption = (value: string): DoctorProvider => {
  if (value === 'claude' || value === 'codex' || value === 'both') return value
  throw new InvalidArgumentError('expected claude|codex|both')
}

export const buildInitAction = (deps: InitCliDeps = {}) => {
  const runDoctor = deps.runDoctor
    ?? ((provider: DoctorProvider) => runOperatorReadinessDoctor(provider))
  const formatReport = deps.formatReport ?? formatDoctorReport
  const startDaemon = deps.startDaemon ?? ensureDaemon
  const installProviderHooks = deps.installProviderHooks ?? installHooks
  const openBrowser = deps.openBrowser ?? defaultOpenBrowser
  const boardUrl = deps.boardUrl ?? baseUrl
  const output = deps.output ?? console.log

  return async (options: {
    provider: DoctorProvider
    project?: boolean
    open: boolean
  }): Promise<void> => {
    const report = runDoctor(options.provider)
    output(formatReport(report))
    if (!report.ready) {
      output('Environment is not fully ready — continuing anyway; fix the items above, then re-run `orchestra doctor`.')
    }
    if (!await startDaemon()) {
      throw new Error('daemon failed to start — run `orchestra serve` in the foreground and read the error')
    }
    const url = boardUrl()
    installProviderHooks(options.project ? 'project' : 'global', { provider: options.provider })
    if (options.open) openBrowser(url)
    output([
      `Orchestra is running on ${url}`,
      `Hooks installed (${options.provider}); new agent sessions in hooked projects join the board automatically.`,
      'Next: open the board and hire your first agent (+ Hire), or run `orchestra remote` for phone access.',
    ].join('\n'))
  }
}
